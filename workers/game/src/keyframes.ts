import { type Rect, TILE_SIZE } from '@brickplace/core';
import {
  CDN_FORMAT,
  cdnKeys,
  encodeOverview,
  encodeTile,
  type Keyframes,
  overviewFactor,
} from '@brickplace/protocol/cdn';
import { gzip, sha256Hex } from './checkpoints.ts';

// Keyframes for the season timelapse (ADR 0021): every KEYFRAME_MS while the map changes, each
// tile that changed since the last frame is written to the public TILES bucket, and the index
// (cdnKeys.keyframes) lists every frame with the version of each tile. A tile that did not
// change keeps the version of the frame that last wrote it, so a frame costs one Class A write
// per changed tile plus the index: at most 65 an hour at 2048², about 11k a season.
// Nothing here is ever superseded while the season runs, so the canvas's garbage collection
// never touches it; the bucket needs no lifecycle rule on `keyframes/` either.
// Kept out of the Worker entry (index.ts), which may export only handlers and DO classes.

/** A frame is cut at most once per this interval (wall clock, ms), and only after changes. */
export const KEYFRAME_MS = 60 * 60 * 1000;
/**
 * The index changes once per frame; a minute of edge cache is plenty. Kept short even once
 * final: a moderation rewrite retires the old tiles an hour (GARBAGE_GRACE) after it.
 */
const INDEX_CACHE = 'public, max-age=60';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const BINARY = 'application/octet-stream';
/** Header bytes of the tile format (protocol/cdn); the hash covers only cells and shields. */
const TILE_HEADER = 16;

type Write = (body: () => void) => void;

/** A tile's last written keyframe version and the hash of its content then. */
export interface TileMark {
  readonly version: number;
  readonly hash: string;
}

/** What a frame is cut from: the grid's cells and shields, and its open area. */
export interface FrameSource {
  readonly cells: Uint8Array;
  readonly shields: Uint8Array;
  readonly config: { readonly size: number; readonly open: Rect };
}

/**
 * keyframes: one row per frame (its seq, when it was cut, the open area and each tile's
 * version as JSON). keyframe_tiles: each tile's latest version and content hash, so a frame
 * writes only tiles that changed. meta `keyframes_revision` (tile keys of a moderation
 * rewrite), `keyframes_final` (the season's last frame is in), `keyframes_sealed` (the archive
 * is sealed: no rewrite can follow) and `keyframes_owed` (the index in R2 lags the table).
 */
export function createKeyframeTables(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS keyframes (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, ' +
      'open TEXT NOT NULL, tiles TEXT NOT NULL)',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS keyframe_tiles (tile INTEGER PRIMARY KEY, version INTEGER NOT NULL, ' +
      'hash TEXT NOT NULL)',
  );
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

/** Every tile of the grid, encoded synchronously: the frame is the grid at this moment. */
export function cutTiles(grid: FrameSource, seq: number): Uint8Array[] {
  const { size } = grid.config;
  const edge = Math.min(TILE_SIZE, size);
  const perRow = size / edge;
  const source = { cells: grid.cells, shields: grid.shields, size };
  return Array.from({ length: perRow * perRow }, (_, tile) => {
    const tx = tile % perRow;
    const ty = (tile - tx) / perRow;
    return encodeTile(source, tx, ty, edge, seq);
  });
}

/**
 * Writes the tiles whose content differs from `marks` (a tile without a mark counts as empty)
 * under `revision` at version `seq`, and returns each tile's version for the frame and the new
 * marks. Each key is entered as garbage before its upload (`markGarbage`) and handed back in
 * `written`, so the caller clears it in the transaction that records the frame: a crash in
 * between leaves nothing that nobody deletes.
 */
export async function writeChangedTiles(
  bucket: R2Bucket,
  prefix: string,
  revision: number,
  seq: number,
  encoded: readonly Uint8Array[],
  marks: ReadonlyMap<number, TileMark>,
  markGarbage: (key: string) => void,
): Promise<{ tiles: number[]; marks: Map<number, TileMark>; written: string[] }> {
  const perRow = Math.sqrt(encoded.length);
  const tiles: number[] = [];
  const next = new Map(marks);
  const written: string[] = [];
  const empty = encoded[0] ? await sha256Hex(new Uint8Array(encoded[0].length - TILE_HEADER)) : '';
  for (const [tile, bytes] of encoded.entries()) {
    const hash = await sha256Hex(bytes.subarray(TILE_HEADER));
    const mark = marks.get(tile);
    if ((mark?.hash ?? empty) === hash) {
      tiles.push(mark?.version ?? 0);
      continue;
    }
    const tx = tile % perRow;
    const ty = (tile - tx) / perRow;
    const key = cdnKeys.keyframeTile(prefix, revision, tx, ty, seq);
    markGarbage(key);
    await bucket.put(key, await gzip(bytes), {
      httpMetadata: { contentType: BINARY, cacheControl: IMMUTABLE },
    });
    written.push(key);
    next.set(tile, { version: seq, hash });
    tiles.push(seq);
  }
  return { tiles, marks: next, written };
}

/**
 * The overview of a frame (the whole map downscaled, protocol/cdn encodeOverview), for a
 * timelapse shown small: one object a frame instead of every changed tile. Synchronous, like
 * cutTiles: call it in the same step, so both show the grid at `seq`.
 */
export function cutOverview(grid: FrameSource, seq: number): Uint8Array {
  const { size } = grid.config;
  return encodeOverview({ cells: grid.cells, size }, overviewFactor(size), seq);
}

/**
 * Writes a frame's overview (cutOverview) under `revision`. Returns its key, entered as
 * garbage first like the tiles (`markGarbage`).
 */
export async function writeFrameOverview(
  bucket: R2Bucket,
  prefix: string,
  revision: number,
  seq: number,
  bytes: Uint8Array,
  markGarbage: (key: string) => void,
): Promise<string> {
  const key = cdnKeys.keyframeOverview(prefix, revision, seq);
  markGarbage(key);
  await bucket.put(key, await gzip(bytes), {
    httpMetadata: { contentType: BINARY, cacheControl: IMMUTABLE },
  });
  return key;
}

export function markGarbage(sql: SqlStorage, key: string, now: number): void {
  sql.exec(
    'INSERT INTO cdn_garbage (key, since) VALUES (?, ?) ' +
      'ON CONFLICT (key) DO UPDATE SET since = excluded.since',
    key,
    now,
  );
}

export function clearGarbage(sql: SqlStorage, keys: readonly string[]): void {
  for (const key of keys) sql.exec('DELETE FROM cdn_garbage WHERE key = ?', key);
}

type FrameRow = { seq: number; at: number; open: string; tiles: string };

export class KeyframeWriter {
  /** Seq and time of the last frame; null before the first. */
  lastSeq: number | null;
  private lastAt: number | null;

  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
    private readonly size: number,
  ) {
    const last = sql
      .exec<FrameRow>('SELECT * FROM keyframes ORDER BY seq DESC LIMIT 1')
      .toArray()[0];
    this.lastSeq = last ? last.seq : null;
    this.lastAt = last ? last.at : null;
  }

  get revision(): number {
    return Number(readMeta(this.sql, 'keyframes_revision') ?? 0);
  }

  get final(): boolean {
    return readMeta(this.sql, 'keyframes_final') !== null;
  }

  get sealed(): boolean {
    return readMeta(this.sql, 'keyframes_sealed') !== null;
  }

  /**
   * The season's archive is sealed (ADR 0021): the index says so from its next write, which
   * this makes owed. Called inside the transaction that marks the canvas sealed.
   */
  markSealed(): void {
    writeMeta(this.sql, 'keyframes_sealed', '1');
    writeMeta(this.sql, 'keyframes_owed', '1');
  }

  get indexOwed(): boolean {
    return readMeta(this.sql, 'keyframes_owed') !== null;
  }

  /**
   * When the next frame falls due (ms, wall clock) for a log at `seq`, or null when nothing
   * changed since the last one. Frames fall on whole intervals: the first change in an hour
   * is cut at the start of the next one (the first frame of a canvas at once).
   */
  dueAt(seq: number): number | null {
    if (this.final || seq <= (this.lastSeq ?? 0)) return null;
    if (this.lastAt === null) return 0;
    return (Math.floor(this.lastAt / KEYFRAME_MS) + 1) * KEYFRAME_MS;
  }

  marks(): Map<number, TileMark> {
    const marks = new Map<number, TileMark>();
    for (const row of this.sql.exec<{ tile: number; version: number; hash: string }>(
      'SELECT * FROM keyframe_tiles',
    )) {
      marks.set(row.tile, { version: row.version, hash: row.hash });
    }
    return marks;
  }

  /**
   * Cuts a frame of `grid` at `seq` (the caller's grid is at that seq right now) and writes the
   * index. `final` marks the season's last frame: the index will not change after it. A frame
   * at a seq that already has one only marks it final.
   */
  async cut(grid: FrameSource, seq: number, now: number, save: Write, final = false) {
    const sql = this.sql;
    // Nothing new to show (or an empty season): only the final mark changes.
    if (seq === 0 || (this.lastSeq !== null && seq <= this.lastSeq)) {
      if (final && !this.final) {
        save(() => {
          writeMeta(sql, 'keyframes_final', '1');
          writeMeta(sql, 'keyframes_owed', '1');
        });
      }
      await this.writeIndex(save);
      return;
    }
    // Synchronous: every tile, and the overview, taken from the grid as it is at `seq`.
    const encoded = cutTiles(grid, seq);
    const overview = cutOverview(grid, seq);
    const open = JSON.stringify(grid.config.open);
    const garbage = (key: string) => save(() => markGarbage(sql, key, now));
    const { tiles, marks, written } = await writeChangedTiles(
      this.bucket,
      this.prefix,
      this.revision,
      seq,
      encoded,
      this.marks(),
      garbage,
    );
    written.push(
      await writeFrameOverview(this.bucket, this.prefix, this.revision, seq, overview, garbage),
    );
    save(() => {
      clearGarbage(sql, written);
      // Frames from this one on have an overview (earlier ones, cut before overviews, do not).
      if (readMeta(sql, 'keyframes_overview_from') === null) {
        writeMeta(sql, 'keyframes_overview_from', String(seq));
      }
      sql.exec(
        'INSERT INTO keyframes (seq, at, open, tiles) VALUES (?, ?, ?, ?)',
        seq,
        now,
        open,
        JSON.stringify(tiles),
      );
      for (const [tile, mark] of marks) {
        sql.exec(
          'INSERT INTO keyframe_tiles (tile, version, hash) VALUES (?, ?, ?) ' +
            'ON CONFLICT (tile) DO UPDATE SET version = excluded.version, hash = excluded.hash',
          tile,
          mark.version,
          mark.hash,
        );
      }
      if (final) writeMeta(sql, 'keyframes_final', '1');
      writeMeta(sql, 'keyframes_owed', '1');
    });
    this.lastSeq = seq;
    this.lastAt = now;
    await this.writeIndex(save);
  }

  /** Puts the index when it lags the table. */
  async writeIndex(save: Write): Promise<void> {
    if (!this.indexOwed) return;
    const index = this.index();
    await this.bucket.put(cdnKeys.keyframes(this.prefix), JSON.stringify(index), {
      httpMetadata: { contentType: 'application/json', cacheControl: INDEX_CACHE },
    });
    save(() => writeMeta(this.sql, 'keyframes_owed', null));
  }

  /** Frames as listed in the index, oldest first. */
  frames(): { seq: number; at: number; open: Rect; tiles: number[] }[] {
    return this.sql
      .exec<FrameRow>('SELECT * FROM keyframes ORDER BY seq')
      .toArray()
      .map((row) => ({
        seq: row.seq,
        at: row.at,
        open: JSON.parse(row.open) as Rect,
        tiles: JSON.parse(row.tiles) as number[],
      }));
  }

  /** The first frame seq with an overview; null when none has one. */
  get overviewFrom(): number | null {
    const from = readMeta(this.sql, 'keyframes_overview_from');
    return from === null ? null : Number(from);
  }

  index(): Keyframes {
    const from = this.overviewFrom;
    return {
      format: CDN_FORMAT,
      size: this.size,
      tileSize: Math.min(TILE_SIZE, this.size),
      revision: this.revision,
      final: this.final,
      ...(this.sealed ? { sealed: true } : {}),
      frames: this.frames(),
      ...(from !== null ? { overviews: { factor: overviewFactor(this.size), from } } : {}),
    };
  }

  /**
   * Records frames rewritten under a new revision (a moderation removal, ADR 0021): their
   * tiles and the marks, in one transaction; every tile of the old revision becomes garbage
   * once the new index is out (the caller runs writeIndex next).
   */
  adoptRewrite(
    revision: number,
    frames: ReadonlyMap<number, number[]>,
    marks: ReadonlyMap<number, TileMark>,
    written: readonly string[],
    now: number,
    save: Write,
    /** Frame seqs whose overview the rewrite wrote too. */
    overviews: ReadonlySet<number> = new Set(),
  ): void {
    const sql = this.sql;
    const old = this.revision;
    const perRow = Math.sqrt(this.frames()[0]?.tiles.length ?? 0);
    const oldKeys: string[] = [];
    const oldFrom = this.overviewFrom;
    for (const frame of this.frames()) {
      frame.tiles.forEach((version, tile) => {
        if (version !== frame.seq) return;
        const tx = tile % perRow;
        oldKeys.push(cdnKeys.keyframeTile(this.prefix, old, tx, (tile - tx) / perRow, version));
      });
      if (oldFrom !== null && frame.seq >= oldFrom) {
        oldKeys.push(cdnKeys.keyframeOverview(this.prefix, old, frame.seq));
      }
    }
    // The rewritten frames' overviews: the index lists them from the first frame after which
    // every frame has one (all of them, when the rewrite cut every frame).
    let from: number | null = null;
    for (const frame of this.frames().reverse()) {
      if (!overviews.has(frame.seq)) break;
      from = frame.seq;
    }
    save(() => {
      writeMeta(sql, 'keyframes_overview_from', from === null ? null : String(from));
      clearGarbage(sql, written);
      for (const [seq, tiles] of frames) {
        sql.exec('UPDATE keyframes SET tiles = ? WHERE seq = ?', JSON.stringify(tiles), seq);
      }
      sql.exec('DELETE FROM keyframe_tiles');
      for (const [tile, mark] of marks) {
        sql.exec(
          'INSERT INTO keyframe_tiles (tile, version, hash) VALUES (?, ?, ?)',
          tile,
          mark.version,
          mark.hash,
        );
      }
      // Served until a grace period after the new index is out (cdn_garbage, publish.ts).
      for (const key of oldKeys) markGarbage(sql, key, now);
      writeMeta(sql, 'keyframes_revision', String(revision));
      writeMeta(sql, 'keyframes_owed', '1');
    });
  }
}
