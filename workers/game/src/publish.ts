import { type CellDiff, type Rect, type State, TILE_SIZE } from '@brickplace/core';
import {
  CDN_FORMAT,
  cdnKeys,
  encodeOverview,
  encodeSegment,
  encodeTile,
  type Manifest,
  type ManifestStats,
  type OverviewRef,
  overviewFactor,
} from '@brickplace/protocol/cdn';
import { gzip } from './checkpoints.ts';

// What spectators read from the public TILES bucket through the CDN (ADR 0009, 0014): a diff
// segment and a manifest every SEGMENT_MS while the map changes (nothing while idle), tiles
// when dirty and their last version is at least TILE_MIN_AGE old,
// and the manifest that ties them together. Anonymous: only cells, shields and seqs.
// Objects the manifest stops listing are deleted by the canvas after GARBAGE_GRACE; nothing
// it lists ever expires, so the bucket needs no lifecycle rule.
// Kept out of the Worker entry (index.ts), which may export only handlers and DO classes.

/**
 * How often a diff segment goes out while the map changes (ms). Spectators see the map this
 * much later at most, plus the manifest's cache lifetime and their own polling: about 2-4 s.
 */
export const SEGMENT_MS = 2_000;
/** A tile gets a new version at most this often (ms). */
export const TILE_MIN_AGE = 45_000;
/**
 * How long an object the manifest no longer lists (or that never got listed) stays readable
 * (ms): far longer than a manifest is cached plus a spectator's fetches after reading it.
 */
export const GARBAGE_GRACE = 60 * 60 * 1000;
/**
 * More changed cells than this since the last segment (an outage, or a canvas older than
 * segments) are not written as a segment: every tile is republished instead. A segment of
 * this size is about 600 KB raw, and every spectator would fetch it; the cap also bounds the
 * memory one segment takes. A full resync costs about 8 MiB raw (64 tiles), far less gzipped.
 */
export const MAX_SEGMENT_DIFFS = 100_000;
/** Segments always listed, so a spectator who was away up to a minute catches up without tiles. */
export const RECENT_SEGMENTS = Math.ceil(60_000 / SEGMENT_MS);
/** Keys deleted per R2 call (the API's limit). */
const DELETE_BATCH = 1000;
const IMMUTABLE = 'public, max-age=31536000, immutable';
/**
 * The manifest changes with every segment. One second of edge cache keeps spectators near
 * live while the CDN still absorbs most reads (each edge asks R2 at most once a second).
 */
const MANIFEST_CACHE = 'public, max-age=1';
/**
 * A manifest goes out for changed stats alone (ADR 0033) at most this often (ms): the edge
 * cache /api/stats had, so pages see counts no later than they did, and an idle map with
 * players on it costs one R2 write per interval at most. A manifest written for any other
 * reason carries the current stats anyway.
 */
export const STATS_MS = 15_000;
/**
 * While anyone plays, a manifest goes out at least this often (ms) even with nothing changed:
 * its stats' `at` moves on, so readers can tell counts that stopped coming (a canvas rolled
 * back to a build without stats, a long R2 outage) from counts that held still. With nobody
 * playing there is no such write: only a report, a config or the map can change the stats,
 * and each of those wakes the canvas.
 */
export const STATS_REFRESH_MS = 60_000;
const BINARY = 'application/octet-stream';

/** A manifest's stats before the write stamps them with its time. */
export type StatsBody = Omit<ManifestStats, 'at'>;

type TileRow = { tile: number; version: number; written_at: number; dirty_from: number | null };

/**
 * cdn_tiles: the published version of each tile, when it was written (wall clock, ms), and
 * `dirty_from`, the first seq of the listed segments the tile needs (null when its version is
 * current). cdn_segments: the segments written, pruned once no tile needs them.
 * cdn_garbage: keys to delete once `since` is GARBAGE_GRACE old. An object is entered here
 * before it is uploaded and taken out when it is recorded, so a crash in between cannot leave
 * an object nobody will delete. cdn_superseded: tile versions replaced by a newer recorded
 * one but possibly still named by the manifest in R2; they become garbage only once a
 * manifest without them is out.
 * meta `cdn_manifest_owed`: set with every change the manifest must show, cleared once a
 * manifest is out, so a restart still writes it. meta `cdn_resync_to`: a resync is under way;
 * no manifest goes out until every tile has a version at or past it.
 */
export function createCdnTables(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS cdn_tiles (tile INTEGER PRIMARY KEY, version INTEGER NOT NULL, ' +
      'written_at INTEGER NOT NULL, dirty_from INTEGER)',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS cdn_segments (to_seq INTEGER PRIMARY KEY, from_seq INTEGER NOT NULL)',
  );
  sql.exec('CREATE TABLE IF NOT EXISTS cdn_garbage (key TEXT PRIMARY KEY, since INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS cdn_superseded (key TEXT PRIMARY KEY)');
}

function readMeta(sql: SqlStorage, key: string): string | null {
  const row = sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
  return row ? row.value : null;
}

function writeMeta(sql: SqlStorage, key: string, value: string | null): void {
  if (value === null) {
    sql.exec('DELETE FROM meta WHERE key = ?', key);
    return;
  }
  sql.exec(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export type Write = (body: () => void) => void;

/**
 * A set of cell indices: a flag per cell plus a list of the set ones, so adding is O(1),
 * taking all is O(set size), and memory is bounded by the map (5 bytes a cell at most), never
 * by how many changes arrive.
 */
class CellSet {
  private readonly flags: Uint8Array;
  private list = new Int32Array(1024);
  size = 0;

  constructor(private readonly area: number) {
    this.flags = new Uint8Array(area);
  }

  add(index: number): void {
    if (this.flags[index] !== 0) return;
    this.flags[index] = 1;
    if (this.size === this.list.length) {
      const grown = new Int32Array(Math.min(this.area, this.list.length * 2));
      grown.set(this.list);
      this.list = grown;
    }
    this.list[this.size++] = index;
  }

  /** Empties the set and returns its indices, ascending. */
  take(): Int32Array {
    const taken = this.list.slice(0, this.size).sort();
    for (const index of taken) this.flags[index] = 0;
    this.size = 0;
    if (this.list.length > 1024) this.list = new Int32Array(1024);
    return taken;
  }

  clear(): void {
    this.take();
  }
}

/** The changes since the last segment, taken at seq `to`: diffs, or a resync when too many. */
export interface TakenSegment {
  readonly from: number;
  readonly to: number;
  readonly indices: Int32Array;
  readonly diffs: readonly CellDiff[] | null;
}

export class CdnPublisher {
  /** Cells changed since the last segment. */
  private readonly pending: CellSet;
  /** Tiles changed since their published version, with the seq of their latest change. */
  private readonly changed = new Map<number, number>();
  /** Mirrors meta `cdn_manifest_owed`. */
  private manifestOwed: boolean;
  /** Mirrors meta `cdn_resync_to`: every tile must reach this version before a manifest. */
  private resyncTo: number | null;
  /** Every change up to this seq is in a written segment or a republished tile. */
  segmentedTo: number;
  /** Tests lower it to reach the resync path without 100k ops. */
  maxDiffs = MAX_SEGMENT_DIFFS;
  /** Area locks in force (ADR 0024), listed in the manifest; the canvas keeps them current. */
  locks: readonly Rect[] = [];
  /** Tests lower it so segments retire within a short history. */
  recentSegments = RECENT_SEGMENTS;
  /** Tile edge: TILE_SIZE, or the whole map when it is smaller (test and small seasons). */
  private readonly edge: number;
  /**
   * The published overview (meta `cdn_overview`): the whole map downscaled, for pages zoomed
   * far out and the minimap (ADR 0009), so they need no tile. Null before the first one.
   */
  private overview: (OverviewRef & { readonly writtenAt: number }) | null;
  /** The latest seq whose changes an overview must show (cells changed, or a resync). */
  private overviewWanted: number;
  /** The canvas's latest stats (ADR 0033), as offerStats gave them; null before the first. */
  private stats: StatsBody | null = null;
  /** The stats in the last manifest written, as JSON without `at`; null when it had none. */
  private writtenStats: string | null = null;
  /** When a manifest last went out (ms); stats-only changes wait STATS_MS after it. */
  private statsWrittenAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
    private readonly size: number,
  ) {
    this.edge = Math.min(TILE_SIZE, size);
    if (size % this.edge !== 0) throw new RangeError('the map must be a whole number of tiles');
    this.pending = new CellSet(size * size);
    this.segmentedTo = Number(readMeta(sql, 'cdn_segmented_to') ?? 0);
    this.manifestOwed = readMeta(sql, 'cdn_manifest_owed') !== null;
    const resync = readMeta(sql, 'cdn_resync_to');
    this.resyncTo = resync === null ? null : Number(resync);
    const dirty = sql.exec<TileRow>('SELECT * FROM cdn_tiles WHERE dirty_from IS NOT NULL');
    for (const tile of dirty) this.changed.set(tile.tile, tile.dirty_from!);
    const overview = readMeta(sql, 'cdn_overview');
    this.overview = overview === null ? null : JSON.parse(overview);
    // What the published tiles and segments show; the start's replay notes anything newer.
    this.overviewWanted = this.segmentedTo;
  }

  /** A newer overview is owed than the published one (the map changed since it was cut). */
  get overviewWaiting(): boolean {
    return this.overviewWanted > (this.overview?.version ?? 0);
  }

  private get tileCount(): number {
    return (this.size / this.edge) ** 2;
  }

  private tileOf(index: number): number {
    const x = index % this.size;
    const y = (index - x) / this.size;
    return Math.floor(y / this.edge) * (this.size / this.edge) + Math.floor(x / this.edge);
  }

  /** Something only the manifest shows changed (the area locks): one goes out next tick. */
  oweManifest(write: Write): void {
    write(() => writeMeta(this.sql, 'cdn_manifest_owed', '1'));
    this.manifestOwed = true;
  }

  /**
   * Takes the canvas's current stats (ADR 0033). When they differ from the last manifest's,
   * a manifest is owed once STATS_MS has passed since that one; until then statsDueAt says
   * when. Unchanged stats with someone playing are written again STATS_REFRESH_MS after the
   * last manifest. Kept in memory only, unlike `cdn_manifest_owed`: a restarted canvas
   * offers them again on its first tick.
   */
  offerStats(stats: StatsBody, now: number): void {
    this.stats = stats;
    if (this.statsDueAt !== null && now >= this.statsDueAt) this.manifestOwed = true;
  }

  /** When the stats owe a manifest of their own (ms); null: never, as they stand. */
  get statsDueAt(): number | null {
    if (this.stats === null) return null;
    if (JSON.stringify(this.stats) !== this.writtenStats) return this.statsWrittenAt + STATS_MS;
    return this.stats.playing > 0 ? this.statsWrittenAt + STATS_REFRESH_MS : null;
  }

  /** Records the cells an accepted log row changed. */
  note(diffs: readonly CellDiff[], seq: number): void {
    for (const { index } of diffs) {
      this.pending.add(index);
      this.changed.set(this.tileOf(index), seq);
    }
    if (diffs.length > 0) this.overviewWanted = Math.max(this.overviewWanted, seq);
  }

  /** True while something is waiting to be published. */
  get busy(): boolean {
    return this.segmentWaiting || this.tilesWaiting;
  }

  /** Changes or a manifest wait for the next segment tick. */
  get segmentWaiting(): boolean {
    return this.pending.size > 0 || this.manifestOwed;
  }

  /** Tiles, or the overview, wait for a new version (on the maintenance cadence). */
  get tilesWaiting(): boolean {
    return this.changed.size > 0 || this.overviewWaiting;
  }

  /** A resync is under way: tiles must go out before any manifest, whatever the cadence. */
  get resyncPending(): boolean {
    return this.resyncTo !== null;
  }

  /**
   * Covers every change up to `seq` by republishing every tile instead of by segments: for
   * changes that cannot be rebuilt (a checkpoint covers rows no segment has), or too many to
   * segment. Every tile gets a version at or past `seq` on the next publishTiles, which the
   * caller runs at once; no manifest goes out until all of them are recorded, since one in
   * between would name the new seq with old tiles and no segment for the skipped seqs.
   * Stored, so a restart before then still republishes them.
   */
  skipTo(seq: number, write: Write): void {
    write(() => {
      writeMeta(this.sql, 'cdn_resync_to', String(seq));
      this.setSegmentedTo(seq);
      for (let tile = 0; tile < this.tileCount; tile++) {
        this.sql.exec(
          'INSERT INTO cdn_tiles (tile, version, written_at, dirty_from) VALUES (?, 0, 0, ?) ' +
            'ON CONFLICT (tile) DO UPDATE SET written_at = 0, dirty_from = excluded.dirty_from',
          tile,
          seq,
        );
      }
    });
    this.segmentedTo = seq;
    this.resyncTo = seq;
    this.overviewWanted = Math.max(this.overviewWanted, seq);
    this.pending.clear();
    for (let tile = 0; tile < this.tileCount; tile++) this.changed.set(tile, seq);
  }

  /**
   * Synchronous: every cell changed since the last segment, valued as it is now, which the
   * caller guarantees is the grid at `seq`. Null when there is nothing new. Diffs are null
   * when there are more than `maxDiffs`: writeSegment then resyncs instead.
   */
  takeSegment(grid: State, seq: number): TakenSegment | null {
    if (seq <= this.segmentedTo) return null;
    const indices = this.pending.take();
    const diffs =
      indices.length > this.maxDiffs
        ? null
        : Array.from(indices, (index) => ({
            index,
            cell: grid.cells[index]!,
            shield: grid.shields[index]!,
          }));
    return { from: this.segmentedTo, to: seq, indices, diffs };
  }

  /**
   * Writes the segment, then records it. On failure its cells go back into the pending set,
   * so the next segment covers them.
   */
  async writeSegment(taken: TakenSegment, now: number, write: Write): Promise<void> {
    const { from, to, indices, diffs } = taken;
    const key = cdnKeys.segment(this.prefix, from, to);
    try {
      if (!diffs) {
        this.skipTo(to, write);
        return;
      }
      write(() => this.markGarbage([key], now));
      await this.bucket.put(key, await gzip(encodeSegment({ from, to, diffs })), {
        httpMetadata: { contentType: BINARY, cacheControl: IMMUTABLE },
      });
    } catch (error) {
      for (const index of indices) this.pending.add(index);
      throw error;
    }
    const tiles = new Set(diffs.map((d) => this.tileOf(d.index)));
    write(() => {
      this.sql.exec('DELETE FROM cdn_garbage WHERE key = ?', key);
      writeMeta(this.sql, 'cdn_manifest_owed', '1');
      this.setSegmentedTo(to);
      this.sql.exec(
        'INSERT OR REPLACE INTO cdn_segments (to_seq, from_seq) VALUES (?, ?)',
        to,
        from,
      );
      for (const tile of tiles) {
        // A tile already published past these changes needs no segment for them.
        if (!this.changed.has(tile)) continue;
        this.sql.exec(
          'INSERT INTO cdn_tiles (tile, version, written_at, dirty_from) VALUES (?, 0, 0, ?) ' +
            'ON CONFLICT (tile) DO UPDATE SET dirty_from = COALESCE(dirty_from, excluded.dirty_from)',
          tile,
          from + 1,
        );
      }
    });
    this.segmentedTo = to;
    this.manifestOwed = true;
  }

  /**
   * Writes a new version of every changed tile whose last version is at least TILE_MIN_AGE
   * old. Each tile is cut synchronously at the seq `seqNow()` gives at that moment, which is
   * also its version, so a version always names one exact grid. The version it replaces is
   * superseded: it becomes garbage once a manifest that no longer names it is out.
   */
  async publishTiles(grid: State, seqNow: () => number, now: number, write: Write): Promise<void> {
    const perRow = this.size / this.edge;
    for (const tile of [...this.changed.keys()]) {
      const row = this.sql
        .exec<TileRow>('SELECT * FROM cdn_tiles WHERE tile = ?', tile)
        .toArray()[0];
      if (row && now - row.written_at < TILE_MIN_AGE) continue;
      const seq = seqNow();
      const tx = tile % perRow;
      const ty = (tile - tx) / perRow;
      const key = cdnKeys.tile(this.prefix, tx, ty, seq);
      // The same version is already out (a resync with nothing new): same key, same bytes.
      const fresh = row?.version !== seq;
      if (fresh) {
        const bytes = encodeTile(
          { cells: grid.cells, shields: grid.shields, size: this.size },
          tx,
          ty,
          this.edge,
          seq,
        );
        write(() => this.markGarbage([key], now));
        await this.bucket.put(key, await gzip(bytes), {
          httpMetadata: { contentType: BINARY, cacheControl: IMMUTABLE },
        });
      }
      write(() => {
        this.sql.exec('DELETE FROM cdn_garbage WHERE key = ?', key);
        writeMeta(this.sql, 'cdn_manifest_owed', '1');
        if (fresh && row && row.version > 0) {
          this.sql.exec(
            'INSERT OR IGNORE INTO cdn_superseded (key) VALUES (?)',
            cdnKeys.tile(this.prefix, tx, ty, row.version),
          );
        }
        this.sql.exec(
          'INSERT INTO cdn_tiles (tile, version, written_at, dirty_from) VALUES (?, ?, ?, NULL) ' +
            'ON CONFLICT (tile) DO UPDATE SET version = excluded.version, ' +
            'written_at = excluded.written_at, dirty_from = NULL',
          tile,
          seq,
          now,
        );
      });
      // Changed again while the tile was on its way: it stays dirty for a later version.
      if ((this.changed.get(tile) ?? 0) <= seq) this.changed.delete(tile);
      this.manifestOwed = true;
    }
  }

  /**
   * Writes a new overview when the map changed since the last one and that one is at least
   * TILE_MIN_AGE old, cut synchronously at the seq `seqNow()` gives (its version), like a tile.
   * The one it replaces is superseded: garbage once a manifest without it is out. About 10-20 ms
   * of CPU at 2048² (every cell read once), at most once per TILE_MIN_AGE while the map changes.
   */
  async publishOverview(grid: State, seqNow: () => number, now: number, write: Write) {
    const previous = this.overview;
    if (!this.overviewWaiting) return;
    if (previous && now - previous.writtenAt < TILE_MIN_AGE) return;
    const seq = seqNow();
    const factor = overviewFactor(this.size);
    const key = cdnKeys.overview(this.prefix, seq);
    const fresh = previous?.version !== seq;
    if (fresh) {
      const bytes = encodeOverview({ cells: grid.cells, size: this.size }, factor, seq);
      write(() => this.markGarbage([key], now));
      await this.bucket.put(key, await gzip(bytes), {
        httpMetadata: { contentType: BINARY, cacheControl: IMMUTABLE },
      });
    }
    const overview = { factor, version: seq, writtenAt: now };
    write(() => {
      this.sql.exec('DELETE FROM cdn_garbage WHERE key = ?', key);
      writeMeta(this.sql, 'cdn_manifest_owed', '1');
      writeMeta(this.sql, 'cdn_overview', JSON.stringify(overview));
      if (fresh && previous) {
        this.sql.exec(
          'INSERT OR IGNORE INTO cdn_superseded (key) VALUES (?)',
          cdnKeys.overview(this.prefix, previous.version),
        );
      }
    });
    this.overview = overview;
    this.manifestOwed = true;
  }

  /**
   * Writes the manifest when one is owed, then turns what it no longer names into garbage:
   * segments no tile needs any more, and tile versions superseded before it was built. Held
   * back while a resync has tiles left to republish.
   */
  async writeManifest(grid: State, now: number, write: Write): Promise<void> {
    if (!this.manifestOwed) return;
    const sql = this.sql;
    if (this.resyncTo !== null) {
      const behind = sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM cdn_tiles WHERE version < ?', this.resyncTo)
        .one().n;
      if (behind > 0) return;
      write(() => writeMeta(sql, 'cdn_resync_to', null));
      this.resyncTo = null;
    }
    const superseded = sql
      .exec<{ key: string }>('SELECT key FROM cdn_superseded')
      .toArray()
      .map((r) => r.key);
    const tiles = new Array<number>(this.tileCount).fill(0);
    for (const row of sql.exec<TileRow>('SELECT * FROM cdn_tiles')) tiles[row.tile] = row.version;
    const dirty = sql
      .exec<{ m: number | null }>('SELECT MIN(dirty_from) AS m FROM cdn_tiles')
      .one().m;
    const recent = sql
      .exec<{ to_seq: number }>(
        'SELECT to_seq FROM cdn_segments ORDER BY to_seq DESC LIMIT 1 OFFSET ?',
        this.recentSegments - 1,
      )
      .toArray()[0];
    const floor = Math.min(dirty ?? Number.MAX_SAFE_INTEGER, recent?.to_seq ?? 0);
    const segments = sql
      .exec<{ from_seq: number; to_seq: number }>(
        'SELECT from_seq, to_seq FROM cdn_segments WHERE to_seq >= ? ORDER BY to_seq',
        floor,
      )
      .toArray()
      .map((s) => [s.from_seq, s.to_seq] as const);
    const { stats } = this;
    const manifest: Manifest = {
      format: CDN_FORMAT,
      seq: this.segmentedTo,
      size: this.size,
      tileSize: this.edge,
      open: grid.config.open,
      maxShield: grid.config.maxShield,
      tiles,
      segments,
      ...(this.locks.length > 0 ? { locks: this.locks } : {}),
      ...(this.overview
        ? { overview: { factor: this.overview.factor, version: this.overview.version } }
        : {}),
      ...(stats ? { stats: { ...stats, at: now } } : {}),
    };
    // Ticks never overlap, so no map change is recorded during the upload. A shard's report
    // (cursor(), outside the ticks) may offer new stats meanwhile; `writtenStats` keeps the
    // ones this manifest carries, so those still owe the next one.
    await this.bucket.put(cdnKeys.manifest(this.prefix), JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json', cacheControl: MANIFEST_CACHE },
    });
    write(() => {
      writeMeta(sql, 'cdn_manifest_owed', null);
      this.markGarbage(superseded, now);
      for (const key of superseded) sql.exec('DELETE FROM cdn_superseded WHERE key = ?', key);
      const retired = sql
        .exec<{ from_seq: number; to_seq: number }>(
          'SELECT from_seq, to_seq FROM cdn_segments WHERE to_seq < ?',
          floor,
        )
        .toArray();
      this.markGarbage(
        retired.map((s) => cdnKeys.segment(this.prefix, s.from_seq, s.to_seq)),
        now,
      );
      sql.exec('DELETE FROM cdn_segments WHERE to_seq < ?', floor);
    });
    this.manifestOwed = false;
    this.writtenStats = stats ? JSON.stringify(stats) : null;
    this.statsWrittenAt = now;
  }

  /** Deletes garbage at least GARBAGE_GRACE old. */
  async collect(now: number, write: Write): Promise<void> {
    for (;;) {
      const keys = this.sql
        .exec<{ key: string }>(
          'SELECT key FROM cdn_garbage WHERE since <= ? ORDER BY since LIMIT ?',
          now - GARBAGE_GRACE,
          DELETE_BATCH,
        )
        .toArray()
        .map((r) => r.key);
      if (keys.length === 0) return;
      await this.bucket.delete(keys);
      write(() => {
        for (const key of keys) this.sql.exec('DELETE FROM cdn_garbage WHERE key = ?', key);
      });
    }
  }

  /** When the oldest garbage becomes due (in `now` units), or null when there is none. */
  get garbageDueAt(): number | null {
    const row = this.sql
      .exec<{ m: number | null }>('SELECT MIN(since) AS m FROM cdn_garbage')
      .one();
    return row.m === null ? null : row.m + GARBAGE_GRACE;
  }

  private markGarbage(keys: readonly string[], now: number): void {
    for (const key of keys) {
      this.sql.exec(
        'INSERT INTO cdn_garbage (key, since) VALUES (?, ?) ' +
          'ON CONFLICT (key) DO UPDATE SET since = excluded.since',
        key,
        now,
      );
    }
  }

  private setSegmentedTo(seq: number): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('cdn_segmented_to', ?) " +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      String(seq),
    );
  }
}
