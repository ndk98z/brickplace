import { type CellDiff, LINK_DOWN, LINK_RIGHT, type Rect, TILE_SIZE } from '@brickplace/core';
import { ProtocolError } from '@brickplace/protocol';
import {
  decodeOverview,
  decodeSegment,
  decodeTile,
  type Manifest,
  type OverviewRef,
  parseManifest,
  type Segment,
} from '@brickplace/protocol/cdn';
import type { MapStore } from '../map/store.ts';
import { Spread } from './spread.ts';

// Spectating without a socket (ADR 0009, 0018): the map comes from the public CDN bucket
// that CanvasDO publishes (ADR 0014). The manifest names a version per tile and the diff
// segments that bring every tile from its version to the manifest's seq; this keeps the
// MapStore at that seq, a few seconds behind the live map. Changes to tiles already shown
// are drawn spread over the next poll interval rather than at once (spread.ts).

/** How often the manifest is read while the page is visible (ms): one segment interval. */
export const POLL_MS = 2_000;
/**
 * Changes to tiles a page already shows are drawn spread over this long (ms), so they keep
 * coming until the next poll brings more. Pages pass it as `spreadMs`.
 */
export const SPREAD_MS = POLL_MS;
/** A spread step runs at most this often (ms): about 25 a second. */
export const SPREAD_STEP_MS = 40;
/**
 * More cells waiting than this (a burst, a long hidden spell) are drawn at once: spread over
 * a poll interval they would be a blur anyway.
 */
export const MAX_SPREAD = 20_000;
/** Hidden pages poll less and less often, doubling up to this (ms). */
export const HIDDEN_POLL_MAX_MS = 60_000;
/** After failures the poll backs off, doubling up to this (ms). */
export const ERROR_POLL_MAX_MS = 30_000;
/**
 * Failed reads in a row, with no manifest ever read, after which the CDN counts as unusable
 * for this page (no CORS, blocked, a wrong URL): the page then watches through a socket.
 */
export const GIVE_UP_FAILURES = 3;
/** Tiles and segments fetched at once. */
const PARALLEL_FETCHES = 6;

/** The open area, shield cap and area locks (ADR 0024), as the manifest gives them. */
export interface CdnRules {
  readonly open: Rect;
  readonly maxShield: number;
  readonly locks?: readonly Rect[];
}

export interface CdnFeedEvents {
  /** The manifest's rules, whenever they differ from the last ones reported. */
  rules(rules: CdnRules): void;
  /** False after a failed read, true again after the next good one. */
  status?(ok: boolean): void;
  /** A sync with the manifest finished: the store holds what it listed (or as much as loaded). */
  synced?(): void;
  /**
   * The canvas's stats (ADR 0033) from each manifest read that has them, unchecked: public
   * input, which the caller parses. Current as of the read, even when unchanged.
   */
  stats?(stats: unknown): void;
  /**
   * The feed stopped for good: the manifest describes another map than this build draws, or
   * none could ever be read (GIVE_UP_FAILURES).
   */
  unusable?(): void;
  /**
   * Cells a spread step changed, each with the cell byte it had before: the page may fade
   * them from the old look to the new one. Not called for changes drawn at once.
   */
  spread?(cells: readonly ChangedCell[]): void;
}

/** A cell the feed changed: its index in the map and the cell byte it had before. */
export interface ChangedCell {
  readonly index: number;
  readonly before: number;
}

/** Reads one object; `signal` aborts it when the feed stops or adopts a new state. */
export type Fetcher<T> = (url: string, signal: AbortSignal) => Promise<T>;

/** How the feed reads the bucket; the browser's are in cdn-fetch.ts. */
export interface CdnFeedOptions {
  /** Reads an object's text (the manifest). */
  readonly fetchText: Fetcher<string>;
  /** Reads a gzipped object and returns its decompressed bytes (tiles, segments). */
  readonly fetchGzip: Fetcher<Uint8Array>;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Spread changes to tiles already shown over this long (ms); 0, the default, draws at once. */
  readonly spreadMs?: number;
  /** The clock spread steps run on (ms); performance.now() by default. */
  readonly now?: () => number;
  /** 0..1, the order spread changes are drawn in; Math.random by default. */
  readonly random?: () => number;
}

/** What one sync must fetch and apply, worked out from a manifest and what the store holds. */
export interface SyncPlan {
  /** Tiles to (re)load, at the manifest's version; version 0 is an empty tile, not fetched. */
  readonly tiles: readonly { readonly tile: number; readonly version: number }[];
  /** For every tile the store will hold: the seq it is at before the segments are applied. */
  readonly base: ReadonlyMap<number, number>;
  /** The listed segments at least one held tile needs, oldest first. */
  readonly segments: readonly (readonly [number, number])[];
  /**
   * Held tiles that need a reload but are not wanted now: the store stops counting them as
   * held (their cells stay on screen) until a sync that wants them reloads them.
   */
  readonly dropped: readonly number[];
}

/**
 * True when the listed segments carry every change after `from` up to `seq`, with no gap:
 * then a tile held at `from` can be brought forward by segments alone.
 */
export function segmentsCover(
  segments: readonly (readonly [number, number])[],
  from: number,
  seq: number,
): boolean {
  let cursor = from;
  for (const [start, end] of segments) {
    if (end <= cursor) continue;
    if (start > cursor) return false;
    cursor = end;
  }
  return cursor >= seq;
}

/**
 * Plans a sync. `at[t]` is the seq tile t of the store is at, or -1 when the store holds no
 * copy of it; `wanted(t)` says whether a tile may be loaded now.
 *
 * - A tile not held and wanted is loaded at the manifest's version.
 * - A tile held at or past its listed version needs only the listed segments after it: the
 *   manifest lists every segment a tile needs after its version.
 * - A tile held at an older seq than its listed version (say from an older manifest, or a
 *   socket that closed) is brought forward by segments only when they cover every seq after
 *   it; past a gap (segments retired, or seqs skipped by a server resync), it is reloaded
 *   if wanted, and otherwise dropped.
 */
export function planSync(
  manifest: Manifest,
  at: readonly number[],
  wanted: (tile: number) => boolean,
): SyncPlan {
  const tiles: { tile: number; version: number }[] = [];
  const base = new Map<number, number>();
  const dropped: number[] = [];
  manifest.tiles.forEach((version, tile) => {
    const held = at[tile] ?? -1;
    if (held >= 0 && (held >= version || segmentsCover(manifest.segments, held, manifest.seq))) {
      base.set(tile, held);
    } else if (wanted(tile)) {
      tiles.push({ tile, version });
      base.set(tile, version);
    } else if (held >= 0) {
      dropped.push(tile);
    }
  });
  let lowest = Number.POSITIVE_INFINITY;
  for (const seq of base.values()) lowest = Math.min(lowest, seq);
  const segments = manifest.segments.filter(([, to]) => to > lowest);
  return { tiles, base, segments, dropped };
}

/**
 * The segments' diffs that apply, in order: a segment holds the values cells have at its
 * `to`, so it applies to a tile still before that seq and is skipped for a tile already past
 * it (applying it there would step the tile back).
 */
export function diffsToApply(
  segments: readonly Segment[],
  base: ReadonlyMap<number, number>,
  mapSize: number,
): CellDiff[] {
  const perSide = mapSize / TILE_SIZE;
  const out: CellDiff[] = [];
  for (const segment of segments) {
    for (const diff of segment.diffs) {
      const x = diff.index % mapSize;
      const y = (diff.index - x) / mapSize;
      if (y >= mapSize) continue;
      const tile = Math.floor(y / TILE_SIZE) * perSide + Math.floor(x / TILE_SIZE);
      const from = base.get(tile);
      if (from !== undefined && from < segment.to) out.push(diff);
    }
  }
  return out;
}

/** Thrown when a feed's state moved on (stop, adopt) while a sync was under way. */
class Cancelled extends Error {}

/**
 * Runs `tasks` with at most `limit` at once; rejects on the first failure. Starts no new
 * task once `cancelled()` says the results are no longer wanted.
 */
async function inParallel<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
  cancelled: () => boolean,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      if (cancelled()) throw new Cancelled();
      const i = next++;
      results[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (cancelled()) throw new Cancelled();
  return results;
}

/**
 * Keeps a MapStore in step with the CDN: polls the manifest, loads tiles (those in view
 * first, then the rest for the minimap, unless limited to the view), applies diff segments.
 * When the manifest lists an overview of the whole map, the store takes it instead of the
 * rest of the tiles: only those in view are loaded, and the minimap and a page zoomed far out
 * (which wants no tile) draw the others from it.
 * Never clears the store: a tile is replaced only once its new content is in hand, so
 * nothing flashes empty. With `spreadMs`, the segments' changes to tiles already held and in
 * view reach the store a few at a time over that long; the rest land at once.
 */
export class CdnFeed {
  /**
   * The seq each tile of the store is at; -1 while the store holds no copy of it. Changes
   * still spreading count as there: stop() and adopt() roll back what they drop.
   */
  private readonly at: number[];
  private manifest: Manifest | null = null;
  /** Decoded segments by `${from}-${to}`, kept while the manifest lists them. */
  private readonly segments = new Map<string, Segment>();
  private visible = new Set<number>();
  /** Load only the tiles in view (while a socket is about to take over). */
  private viewOnly = false;
  /** Load every tile, overview or not (a socket is about to resume from them, ADR 0040). */
  private loadAll = false;
  private running = false;
  /** Bumped by stop() and adopt(): results of fetches started before are dropped. */
  private generation = 0;
  /** Aborts the fetches of the current generation. */
  private abort = new AbortController();
  /** The generation whose sync is running, or null. */
  private syncing: number | null = null;
  private syncAgain = false;
  private timer: unknown = null;
  private failures = 0;
  private hidden = false;
  private hiddenPolls = 0;
  private lastRules = '';
  /** Set once the feed stopped for good (see CdnFeedEvents.unusable). */
  private unusable = false;
  private readonly fetchText: Fetcher<string>;
  private readonly fetchGzip: Fetcher<Uint8Array>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly spread = new Spread();
  private spreadTimer: unknown = null;
  private readonly spreadMs: number;
  /** False while the page asks for no spreading ("Reduce motion"). */
  private spreading = true;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    /** URL of one canvas's prefix in the bucket, without a trailing slash. */
    private readonly base: string,
    private readonly store: MapStore,
    private readonly events: CdnFeedEvents,
    options: CdnFeedOptions,
  ) {
    this.at = new Array<number>(store.tileCount).fill(-1);
    this.fetchText = options.fetchText;
    this.fetchGzip = options.fetchGzip;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.spreadMs = options.spreadMs ?? 0;
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** False once the feed stopped for good. */
  get usable(): boolean {
    return !this.unusable;
  }

  /** True when the store holds a copy of at least one tile from the feed (or adopted). */
  get holdsMap(): boolean {
    return this.at.some((seq) => seq >= 0);
  }

  /** The seq of the manifest the store follows, or null before the first one. */
  get seq(): number | null {
    return this.manifest?.seq ?? null;
  }

  /** The seq tile `tile` of the store is at, or -1 when it holds no copy. */
  tileSeq(tile: number): number {
    return this.at[tile] ?? -1;
  }

  /**
   * The lowest seq every tile of the store is surely at, changes still spreading not counted:
   * what a socket can resume from (ADR 0040). Null while any tile holds no copy.
   */
  heldSeq(): number | null {
    let lowest = Number.POSITIVE_INFINITY;
    for (let tile = 0; tile < this.at.length; tile++) {
      const at = this.at[tile]!;
      if (at < 0) return null;
      lowest = Math.min(lowest, at, this.spread.baseOf(tile) ?? at);
    }
    return Number.isFinite(lowest) ? lowest : null;
  }

  /** True when the store holds a copy of every tile from the feed (or adopted). */
  get holdsAll(): boolean {
    return this.at.every((seq) => seq >= 0);
  }

  start(): void {
    if (this.running || this.unusable) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    this.newGeneration();
    this.cancelTimer();
  }

  /**
   * The store now holds the whole map as of `seq` (a socket's grid with every frame up to
   * it), or each tile as of its own seq (`seq[tile]`: tiles a socket stopped viewing were
   * left at an older one, ADR 0028): the next manifest brings them forward from there.
   * Fetches under way are dropped; a running feed reads the manifest again at once.
   */
  adopt(seq: number | readonly number[]): void {
    this.newGeneration();
    if (typeof seq === 'number') this.at.fill(seq);
    else for (let tile = 0; tile < this.at.length; tile++) this.at[tile] = seq[tile] ?? -1;
    if (this.running) {
      this.cancelTimer();
      void this.poll();
    }
  }

  /**
   * Limits loading to the tiles in view (a socket is about to bring the whole map) or lifts
   * the limit. Tiles already held keep following the segments either way.
   */
  setViewOnly(viewOnly: boolean): void {
    if (viewOnly === this.viewOnly) return;
    this.viewOnly = viewOnly;
    if (!viewOnly) this.syncSoon();
  }

  /**
   * Loads every tile even when the manifest lists an overview, or stops doing so: a page about
   * to play holds the whole map first, so its socket only brings what changed (ADR 0040).
   */
  setLoadAll(loadAll: boolean): void {
    if (loadAll === this.loadAll) return;
    this.loadAll = loadAll;
    if (loadAll) this.syncSoon();
  }

  /** The tiles in view; any not held yet are loaded at once, before the others. */
  want(tiles: readonly number[]): void {
    this.visible = new Set(tiles);
    if (tiles.some((t) => (this.at[t] ?? -1) < 0)) this.syncSoon();
  }

  /**
   * Turns spreading off (what waits is drawn at once, as is everything after) or back on: off
   * while the player asks for less motion.
   */
  setSpreading(spreading: boolean): void {
    if (spreading === this.spreading) return;
    this.spreading = spreading;
    if (!spreading) {
      this.cancelSpreadTimer();
      this.store.applyDiffs(this.spread.take());
    }
  }

  /**
   * Hidden pages back off and draw changes at once (nobody watches them spread); a page shown
   * again reads the manifest at once.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.hiddenPolls = 0;
    if (hidden) {
      this.cancelSpreadTimer();
      this.store.applyDiffs(this.spread.take());
    } else if (this.running) {
      this.cancelTimer();
      void this.poll();
    }
  }

  /**
   * Drops what was under way. The store may now hold something else (a socket's grid), so
   * changes still spreading are not drawn: their tiles go back to the seq the store is surely
   * at for them.
   */
  private newGeneration(): void {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.syncAgain = false;
    this.cancelSpreadTimer();
    for (const [tile, seq] of this.spread.discard()) {
      this.at[tile] = Math.min(this.at[tile] ?? -1, seq);
    }
  }

  private cancelSpreadTimer(): void {
    if (this.spreadTimer !== null) this.clearTimer(this.spreadTimer);
    this.spreadTimer = null;
  }

  /** Runs the next spread step when it is due, but no sooner than SPREAD_STEP_MS. */
  private scheduleSpread(): void {
    this.cancelSpreadTimer();
    const due = this.spread.nextDue;
    if (due === null) return;
    const delay = Math.max(SPREAD_STEP_MS, due - this.now());
    this.spreadTimer = this.setTimer(() => {
      this.spreadTimer = null;
      this.drawSpread(this.spread.take(this.now()));
      this.scheduleSpread();
    }, delay);
  }

  /**
   * The cells right of and below `index` that its new value or the store's current one links
   * it to: the same brick, placed or knocked out (cells link only right and down).
   */
  private linkedCells(index: number, cell: number): number[] {
    const size = this.store.size;
    const x = index % size;
    const y = (index - x) / size;
    const links = cell | this.store.cell(x, y);
    const out: number[] = [];
    if (links & LINK_RIGHT && x + 1 < size) out.push(index + 1);
    if (links & LINK_DOWN && y + 1 < size) out.push(index + size);
    return out;
  }

  /** Draws spread changes and tells the page which cells they changed, and from what. */
  private drawSpread(diffs: readonly CellDiff[]): void {
    if (diffs.length === 0) return;
    const size = this.store.size;
    const before = diffs.map(({ index }) => {
      const x = index % size;
      return this.store.cell(x, (index - x) / size);
    });
    if (this.store.applyDiffs(diffs) === 0 || !this.events.spread) return;
    const changed: ChangedCell[] = [];
    diffs.forEach(({ index, cell }, i) => {
      if (cell !== before[i]) changed.push({ index, before: before[i]! });
    });
    if (changed.length > 0) this.events.spread(changed);
  }

  /** Syncs with the manifest already read, without reading it again. */
  private syncSoon(): void {
    if (!this.running || !this.manifest) return;
    const generation = this.generation;
    // A failure here is retried by the next poll; one from a stop or adopt is expected.
    this.sync().catch((error) => {
      if (generation === this.generation && !(error instanceof Cancelled)) {
        console.warn('loading tiles from the CDN failed:', error);
      }
    });
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.cancelTimer();
    if (!this.running) return;
    let delay = POLL_MS;
    if (this.hidden) delay = Math.min(HIDDEN_POLL_MAX_MS, POLL_MS * 2 ** this.hiddenPolls++);
    if (this.failures > 0) {
      delay = Math.max(delay, Math.min(ERROR_POLL_MAX_MS, POLL_MS * 2 ** this.failures));
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    const generation = this.generation;
    try {
      const text = await this.fetchText(`${this.base}/manifest.json`, this.abort.signal);
      if (generation !== this.generation) return;
      const manifest = parseManifest(text);
      if (!this.fits(manifest)) return;
      // Another edge may still serve a manifest a second older than one already read.
      if (!this.manifest || manifest.seq >= this.manifest.seq) this.manifest = manifest;
      this.reportRules(this.manifest);
      if (this.manifest.stats !== undefined) this.events.stats?.(this.manifest.stats);
      await this.sync();
      this.failures = 0;
      this.events.status?.(true);
    } catch (error) {
      if (generation !== this.generation || error instanceof Cancelled) return;
      this.failures++;
      this.events.status?.(false);
      console.warn('map update from the CDN failed:', error);
      if (!this.manifest && this.failures >= GIVE_UP_FAILURES) this.giveUp();
    } finally {
      if (generation === this.generation) this.schedule();
    }
  }

  /** Stops for good and says so: the page falls back to watching through a socket. */
  private giveUp(): void {
    this.unusable = true;
    this.stop();
    this.events.status?.(false);
    this.events.unusable?.();
  }

  /** False (and the feed stops for good) when the manifest's geometry is not this build's. */
  private fits(manifest: Manifest): boolean {
    const ok =
      manifest.size === this.store.size &&
      manifest.tileSize === TILE_SIZE &&
      manifest.tiles.length === this.store.tileCount;
    if (!ok) {
      console.warn(
        `the CDN map is ${manifest.size}² in ${manifest.tileSize}² tiles; ` +
          `this build draws ${this.store.size}² in ${TILE_SIZE}² tiles`,
      );
      this.giveUp();
    }
    return ok;
  }

  private reportRules(manifest: Manifest): void {
    const rules: CdnRules = {
      open: manifest.open,
      maxShield: manifest.maxShield,
      locks: manifest.locks ?? [],
    };
    const key = JSON.stringify(rules);
    if (key === this.lastRules) return;
    this.lastRules = key;
    this.events.rules(rules);
  }

  /**
   * Brings the store to the current manifest: tiles in view first, then (unless limited to
   * the view) the rest. One at a time per generation; a request while one runs makes it run
   * again after. A sync of an older generation still unwinding does not hold a new one up.
   */
  private async sync(): Promise<void> {
    const generation = this.generation;
    const signal = this.abort.signal;
    if (this.syncing === generation) {
      this.syncAgain = true;
      return;
    }
    this.syncing = generation;
    try {
      do {
        this.syncAgain = false;
        // With an overview, the rest of the map (the minimap, a page zoomed far out) is drawn
        // from it: only the tiles in view are loaded (ADR 0009).
        // An overview that cannot be read only costs the tiles it would have saved.
        const ref = this.manifest?.overview;
        const overview =
          ref !== undefined &&
          !this.viewOnly &&
          (await this.loadOverview(ref, generation, signal).then(
            () => true,
            (error: unknown) => {
              if (error instanceof Cancelled) throw error;
              console.warn('the map overview from the CDN failed:', error);
              return false;
            },
          ));
        await this.syncOnce((tile) => this.visible.has(tile), generation, signal);
        if (!this.viewOnly && (!overview || this.loadAll)) {
          await this.syncOnce(() => true, generation, signal);
        }
      } while (this.syncAgain && this.running && generation === this.generation);
      // A sync cut short by a stop or adopt did not bring the store anywhere.
      if (generation !== this.generation) throw new Cancelled();
      this.events.synced?.();
    } finally {
      if (this.syncing === generation) this.syncing = null;
    }
  }

  /** One pass, for the generation the sync started in: it ends as soon as that one does. */
  private async syncOnce(
    wanted: (tile: number) => boolean,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const manifest = this.manifest;
    const cancelled = () => generation !== this.generation;
    if (!manifest || !this.running || cancelled()) return;
    const plan = planSync(manifest, this.at, wanted);
    // A dropped tile's cells are out of date: drawn from the overview until reloaded.
    for (const tile of plan.dropped) {
      this.at[tile] = -1;
      this.store.release(tile);
    }
    if (plan.base.size === 0) return;
    const tiles = await inParallel(
      plan.tiles.map(
        ({ tile, version }) =>
          () =>
            this.loadTile(tile, version, signal),
      ),
      PARALLEL_FETCHES,
      cancelled,
    );
    const segments = await inParallel(
      plan.segments.map(
        ([from, to]) =>
          () =>
            this.loadSegment(from, to, signal),
      ),
      PARALLEL_FETCHES,
      cancelled,
    );
    if (cancelled()) return;
    // Synchronous from here: the tiles land in one frame with their segments' changes. The
    // changes to tiles already held and in view are spread instead (nobody watches the others
    // change, and drawing them steadily would keep the page drawing); those waiting for a tile
    // reloaded now are older than it and go.
    const loaded = new Set(tiles.map(({ tile }) => tile));
    this.spread.drop(loaded);
    let changed = false;
    for (const { tile, cells, shields } of tiles) {
      changed = this.store.setTile(tile, cells, shields, false) || changed;
    }
    const size = this.store.size;
    const tileOf = (index: number) => {
      const x = index % size;
      const y = (index - x) / size;
      return Math.floor(y / TILE_SIZE) * this.store.tilesPerSide + Math.floor(x / TILE_SIZE);
    };
    let atOnce: CellDiff[] = [];
    const later: CellDiff[] = [];
    // Held tiles drawn at once: what still waits for them goes first, being older.
    const direct = new Set<number>();
    const spreading = this.spreadMs > 0 && this.spreading && !this.hidden;
    for (const diff of diffsToApply(segments, plan.base, size)) {
      const tile = tileOf(diff.index);
      if (spreading && !loaded.has(tile) && this.visible.has(tile)) {
        later.push(diff);
      } else {
        if (!loaded.has(tile)) direct.add(tile);
        atOnce.push(diff);
      }
    }
    atOnce = this.spread.takeTiles(direct).concat(atOnce);
    if (spreading && this.spread.size + later.length <= MAX_SPREAD) {
      if (later.length > 0) {
        // A held tile's base is the seq it was at: what the store is surely at for it.
        this.spread.add(
          later,
          this.now(),
          this.spreadMs,
          this.random,
          tileOf,
          (tile) => Math.max(0, plan.base.get(tile) ?? 0),
          (index, cell) => this.linkedCells(index, cell),
        );
        this.scheduleSpread();
      }
    } else {
      // Drawn at once, after whatever still waited (older changes to the same tiles).
      this.cancelSpreadTimer();
      atOnce = this.spread.take().concat(later, atOnce);
    }
    const applied = this.store.applyDiffs(atOnce);
    if (changed && applied === 0) this.store.changed();
    for (const [tile, from] of plan.base) this.at[tile] = Math.max(from, manifest.seq);
    const listed = new Set(manifest.segments.map(([from, to]) => `${from}-${to}`));
    for (const key of this.segments.keys()) if (!listed.has(key)) this.segments.delete(key);
  }

  private async loadTile(
    tile: number,
    version: number,
    signal: AbortSignal,
  ): Promise<{ tile: number; cells: Uint8Array; shields: Uint8Array }> {
    const area = TILE_SIZE * TILE_SIZE;
    if (version === 0) {
      return { tile, cells: new Uint8Array(area), shields: new Uint8Array(area) };
    }
    const perSide = this.store.tilesPerSide;
    const tx = tile % perSide;
    const ty = (tile - tx) / perSide;
    const url = `${this.base}/tiles/${tx}-${ty}/${version}.bin.gz`;
    const decoded = decodeTile(await this.fetchGzip(url, signal));
    if (
      decoded.tx !== tx ||
      decoded.ty !== ty ||
      decoded.seq !== version ||
      decoded.edge !== TILE_SIZE
    ) {
      throw new ProtocolError(`tile ${tx}-${ty}/${version} does not match its key`);
    }
    return { tile, cells: decoded.cells, shields: decoded.shields };
  }

  /** Puts the listed overview in the store, unless it already holds that version. */
  private async loadOverview(
    ref: OverviewRef,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.store.overview?.seq === ref.version) return;
    const overview = decodeOverview(
      await this.fetchGzip(`${this.base}/overview/${ref.version}.bin.gz`, signal),
    );
    if (generation !== this.generation) throw new Cancelled();
    if (
      overview.seq !== ref.version ||
      overview.factor !== ref.factor ||
      overview.side * overview.factor !== this.store.size
    ) {
      throw new ProtocolError(`overview ${ref.version} does not match its key`);
    }
    this.store.setOverview(overview);
  }

  private async loadSegment(from: number, to: number, signal: AbortSignal): Promise<Segment> {
    const key = `${from}-${to}`;
    const cached = this.segments.get(key);
    if (cached) return cached;
    const segment = decodeSegment(await this.fetchGzip(`${this.base}/diffs/${key}.bin.gz`, signal));
    if (segment.from !== from || segment.to !== to) {
      throw new ProtocolError(`segment ${key} does not match its key`);
    }
    this.segments.set(key, segment);
    return segment;
  }
}
