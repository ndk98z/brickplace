// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.
//
// Diff ticks to FanoutDO shards (ADR 0028). Every op still goes to CanvasDO at once; what the
// canvas sends out is batched: at most every PUSH_MS, the cells changed since the last tick are
// cut into one tick, and every FanoutDO shard that follows the canvas gets one push with every
// cell changed after the last seq it acknowledged, at its end value. A change with no pump in
// the PUSH_MS before it is cut at once; the rest wait for the next tick, up to PUSH_MS. End
// values make a push idempotent: a shard already past part of it (its own op's reply, a
// snapshot) loses nothing.
//
// A shard is never waited on by the op queue: pushes run beside it, at most one in flight per
// shard and MAX_IN_FLIGHT in all, each given up after PUSH_TIMEOUT_MS. A slow or failing
// shard keeps its cursor and backs off; the others move on. When it answers again it gets
// everything since its cursor in one push, read from a bounded ring of recent ticks (their
// cell indices; values come from the grid, which is at the ring's end whenever a push is
// built), or, once the ring no longer reaches its cursor, a push without records that tells it
// to resync from a snapshot. Few of those go out at once, so a huge tick does not make every
// shard copy the whole grid together.

import type { CellDiff, State } from '@brickplace/core';

/**
 * The least time between two ticks (ms): the slowest a change waits before it leaves the
 * canvas. The first change after a quiet spell does not wait.
 */
export const PUSH_MS = 250;
/**
 * The interval new canvases start with. Tests of other scripts that host CanvasDO set it to
 * Infinity and push with CanvasDO.pushTicks(), so frame order does not depend on timers.
 */
export const pushTiming = { ms: PUSH_MS, followsPerSecond: 16 };
/** Cells one tick may name; past it the tick only says "resync" (expiry after a quiet spell). */
export const MAX_TICK_CELLS = 1 << 18;
/** Cell indices kept in the ring (4 bytes each, so at most 8 MiB). */
export const RING_CELLS = 1 << 21;
/** Ticks kept in the ring: ten minutes of them, so ticks without cells cannot pile up. */
export const RING_TICKS = 2400;
/** Shards that may follow one canvas. */
export const MAX_SHARDS = 256;
/** Pushes awaiting an answer at once, over all shards. */
export const MAX_IN_FLIGHT = 32;
/**
 * Pushes without records (the shard copies the whole grid) awaiting an answer at once: a
 * shard answers only once its snapshot is in, so this bounds the copies made together.
 */
export const MAX_RESYNCS_IN_FLIGHT = 4;
/**
 * Record bytes built in one pump. Shards still due once it is reached wait for the next pump
 * (unless nothing was built yet: one push always goes out).
 */
export const MAX_PUMP_BYTES = 16 * 1024 * 1024;
/** A push not answered within this long counts as failed (ms). */
export const PUSH_TIMEOUT_MS = 10_000;
/** Longest wait before a failing shard is pushed to again (ms). */
export const MAX_SHARD_BACKOFF = 30_000;
/** A shard that failed every push for this long is only tried every SHARD_SLOW_RETRY_MS. */
export const SHARD_GIVE_UP_MS = 24 * 60 * 60 * 1000;
export const SHARD_SLOW_RETRY_MS = 60 * 60 * 1000;
/** Record bytes of all pushes awaiting an answer, at most (the first one always goes). */
export const MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;

/** Bytes per record: [index u32][cell u8][shield u8], the Diffs frame's own layout. */
export const RECORD_BYTES = 6;

/** What a shard receives every tick. */
export interface TickPush<R = unknown> {
  /** The shard's cursor: `records` hold every cell changed after this seq. */
  readonly from: number;
  /**
   * True when `from` is a seq the shard acknowledged (or at or below one, rounded down to the
   * start of a tick). False after the canvas restarted, before the shard answered once: `from`
   * is then only where the ring starts, and says nothing of what its sockets have.
   */
  readonly known: boolean;
  /** The canvas's seq the records end at. */
  readonly to: number;
  /**
   * The changed cells at their values at `to`, as [index u32][cell u8][shield u8] records in
   * index order; null when the canvas cannot say (the ring no longer reaches `from`, or a tick
   * named too many cells): the shard resyncs from a snapshot.
   */
  readonly records: Uint8Array | null;
  /** The canvas rules at `to` (open area, locks). */
  readonly rules: R;
}

/** A shard's answer to a push. */
export interface TickReply {
  /** The seq the shard's sockets have now: its new cursor. */
  readonly seq: number;
  /** Its open sockets; 0 tells the canvas to stop pushing to it until it follows again. */
  readonly sockets: number;
}

interface Tick {
  readonly from: number;
  readonly to: number;
  /** Changed cell indices, ascending; null when there were more than maxTickCells. */
  readonly cells: Uint32Array | null;
}

interface Shard {
  /**
   * A seq the shard's sockets are known to have: raised only by the shard's own answers to
   * pushes; set by follow() to the seq the canvas could bring its sockets from (never to the
   * snapshot's, whose reply may be lost). Null when unknown (after a restart, or after a
   * follow the canvas could not answer with changes).
   */
  acked: number | null;
  /**
   * Where a push to a shard whose cursor is unknown starts (`known: false`): the seq of its
   * last snapshot. Its mirror is at or past it if that reply arrived; if not, the shard has no
   * mirror and follows again rather than take `from` for what its sockets have.
   */
  floor: number | null;
  /** Record bytes of the push in flight. */
  bytes: number;
  /** The rules revision it last received. */
  rulesRev: number;
  inFlight: boolean;
  /** The push in flight carries no records (the shard resyncs). */
  resyncing: boolean;
  failures: number;
  retryAt: number;
  failingSince: number | null;
  /** Bumped by follow(): an answer to a push sent before it is not taken as the cursor. */
  generation: number;
  /** The cursor as stored in fanout_shards. */
  saved: number | null;
}

export interface PusherDeps<R> {
  /** Sends one push to a shard by name. */
  readonly send: (shard: string, push: TickPush<R>) => Promise<TickReply>;
  /** The live grid; only read synchronously, right after a cut. */
  readonly grid: () => State;
  readonly rules: () => R;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Called for each failed push (sampled logging is the caller's). */
  readonly failed?: (shard: string, failures: number, error: unknown) => void;
}

/**
 * One row per shard: its name and its cursor as last saved (saveCursors, every maintenance
 * pass), so a restarted canvas still knows a lower bound of what each shard's sockets have.
 */
export function createShardTable(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS fanout_shards (name TEXT PRIMARY KEY, acked INTEGER)');
}

/**
 * Cuts ticks and pushes them to the shards that follow this canvas. The shard names and their
 * `acked` cursors are stored (one row per shard, saved at follow and by saveCursors), so a
 * restarted canvas keeps pushing to them from what their sockets are known to have; a cursor it
 * lost, or one older than its ring, makes it send the whole ring once (idempotent), marked
 * `known: false`, or tell the shard to resync.
 */
export class TickPusher<R = unknown> {
  /** Interval between ticks (ms); tests set Infinity and call pump() themselves. */
  pushMs = pushTiming.ms;
  /** Limits, as fields so tests can reach them without huge maps. */
  maxTickCells = MAX_TICK_CELLS;
  ringCells = RING_CELLS;
  ringTicks = RING_TICKS;
  maxInFlight = MAX_IN_FLIGHT;
  maxResyncs = MAX_RESYNCS_IN_FLIGHT;
  maxPumpBytes = MAX_PUMP_BYTES;
  pushTimeoutMs = PUSH_TIMEOUT_MS;
  maxInFlightBytes = MAX_IN_FLIGHT_BYTES;
  /**
   * follow() calls answered per second, at most: each copies the whole grid. Tests hosting
   * many shards on one canvas raise it (pushTiming).
   */
  maxFollowsPerSecond = pushTiming.followsPerSecond;
  /** Record bytes the last pump built (for tests and measurements). */
  lastPumpBytes = 0;
  private inFlightBytes = 0;
  /** When the follow() calls of the last second came (ms). */
  private follows: number[] = [];
  private changed = new Set<number>();
  private overflow = false;
  /** The latest seq noted. */
  private seq: number;
  /** The seq the newest tick ends at. */
  private cutTo: number;
  /** The seq the ring starts after: a cursor below it cannot be served from the ring. */
  private ringFrom: number;
  private readonly ring: Tick[] = [];
  private ringCellCount = 0;
  private rulesRev = 0;
  private readonly shards = new Map<string, Shard>();
  private inFlight = 0;
  private resyncs = 0;
  /** Where the next pump starts among the shards, so a full pump cannot starve the same ones. */
  private nextStart = 0;
  private timer: unknown = null;
  private timerAt = Number.POSITIVE_INFINITY;
  /** When the last pump ran (ms): the next may run pushMs after it, not sooner. */
  private lastPumpAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly sql: SqlStorage,
    seq: number,
    private readonly deps: PusherDeps<R>,
  ) {
    this.seq = seq;
    this.cutTo = seq;
    this.ringFrom = seq;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const rows = sql.exec<{ name: string; acked: number | null }>(
      'SELECT name, acked FROM fanout_shards',
    );
    for (const { name, acked } of rows) {
      // A saved cursor is a lower bound of what the shard's sockets have. Below `seq` (where
      // the ring starts: the log rows after the checkpoint) the ring cannot serve it, so it
      // counts as unknown: shards with a mirror take the whole ring (`known: false`), and an
      // evicted one cannot be repaired.
      const usable = typeof acked === 'number' && acked >= seq ? acked : null;
      const shard = newShard(usable);
      shard.saved = usable;
      this.shards.set(name, shard);
    }
  }

  /**
   * Stores the cursors that moved since the last call (maintenance, in a write transaction):
   * a few rows every pass while the map changes.
   */
  saveCursors(): void {
    for (const [name, shard] of this.shards) {
      if (shard.acked === null || shard.acked === shard.saved) continue;
      this.sql.exec('UPDATE fanout_shards SET acked = ? WHERE name = ?', shard.acked, name);
      shard.saved = shard.acked;
    }
  }

  /** Schedules the first pump, e.g. for the shards a restarted canvas found stored. */
  start(): void {
    this.schedule();
  }

  /** Names of the shards following this canvas. */
  get following(): readonly string[] {
    return [...this.shards.keys()];
  }

  /**
   * Whether `shard` follows, and the seq its sockets are known to have; cheap, for a shard's
   * watchdog (it never moves anything).
   */
  cursorOf(shard: string): {
    readonly following: boolean;
    readonly acked: number | null;
    /** Its last push failed: the canvas retries on its own, backing off up to 30 s. */
    readonly backingOff: boolean;
  } {
    const entry = this.shards.get(shard);
    return {
      following: entry !== undefined,
      acked: entry?.acked ?? null,
      backingOff: (entry?.failures ?? 0) > 0,
    };
  }

  /** Whether another shard could follow (fewer than MAX_SHARDS do). */
  hasRoom(): boolean {
    return this.shards.size < MAX_SHARDS;
  }

  /** Pushes awaiting an answer, and those of them that carry no records. */
  get pending(): { readonly inFlight: number; readonly resyncs: number } {
    return { inFlight: this.inFlight, resyncs: this.resyncs };
  }

  /** Cells changed by log row `seq` (end values are read from the grid at the next cut). */
  note(diffs: readonly CellDiff[], seq: number): void {
    if (!this.overflow) {
      for (const { index } of diffs) this.changed.add(index);
      if (this.changed.size > this.maxTickCells) {
        this.overflow = true;
        this.changed.clear();
      }
    }
    this.advance(seq);
  }

  /** The log moved to `seq` without changing a cell (a growth row). */
  advance(seq: number): void {
    if (seq > this.seq) this.seq = seq;
    this.schedule();
  }

  /** The rules changed without a seq (a lock): every shard gets them with the next push. */
  rulesChanged(): void {
    this.rulesRev++;
    this.schedule();
  }

  /**
   * Registers `shard` (or renews it) at the canvas's current seq, after cutting a tick so the
   * ring ends there. Returns the records a shard whose sockets have `since` (its last tick, or
   * the canvas's own cursor for it) needs to reach the current seq; null when unknown. Null
   * too, with `following: false`, when MAX_SHARDS already follow.
   */
  follow(
    shard: string,
    since: number | null,
    /** The shard's open sockets; unknown (an older shard) counts as some. */
    sockets: number | null = null,
  ): { readonly following: boolean; readonly changes: Uint8Array | null } {
    // Each answer carries a copy of the whole grid: a burst of shards following at once (a
    // realtime deploy) is spread by refusing past the rate; the shard retries (a join gets a
    // 503 and its client backs off; a push is retried with the shard's backoff).
    const now = this.now();
    this.follows = this.follows.filter((at) => now - at < 1000);
    if (this.follows.length >= this.maxFollowsPerSecond) {
      throw new Error('canvas busy: too many shards following at once; retry');
    }
    this.follows.push(now);
    this.cut();
    let entry = this.shards.get(shard);
    const base = since ?? entry?.acked ?? null;
    const changes = base === null ? null : this.recordsSince(base);
    if (!entry) {
      if (this.shards.size >= MAX_SHARDS) return { following: false, changes };
      entry = newShard(null);
      this.shards.set(shard, entry);
      this.sql.exec('INSERT OR REPLACE INTO fanout_shards (name, acked) VALUES (?, NULL)', shard);
      entry.saved = null;
    }
    entry.generation++;
    // The reply may never reach the shard: until it answers a push, its open sockets are known
    // to have only `base`, and only when the canvas could say what changed since. A shard with
    // no open socket loses nothing with a lost reply (it has no mirror then, and every socket
    // that joins later starts from a snapshot), so its cursor is the snapshot's.
    entry.acked = sockets === 0 ? this.cutTo : changes === null ? null : base;
    entry.floor = this.cutTo;
    // Stored at once, so a restart soon after still knows it (maintenance saves the rest).
    if (entry.acked !== null && entry.acked !== entry.saved) {
      this.sql.exec('UPDATE fanout_shards SET acked = ? WHERE name = ?', entry.acked, shard);
      entry.saved = entry.acked;
    }
    entry.rulesRev = this.rulesRev;
    entry.failures = 0;
    entry.retryAt = 0;
    entry.failingSince = null;
    return { following: true, changes };
  }

  /**
   * Cuts a tick and sends one push to every shard behind it that is not waiting on a push or
   * backing off, within the in-flight, resync and byte limits; the rest wait for the next pump.
   * Shards at nearby cursors share one set of records: a cursor is rounded down to the start
   * of its tick. Synchronous up to the sends: every push is built from the grid at `cutTo`.
   */
  pump(): void {
    this.clearScheduled();
    this.cut();
    const now = this.now();
    this.lastPumpAt = now;
    const built = new Map<number, Uint8Array | null>();
    const rules = this.deps.rules();
    const names = [...this.shards.keys()];
    const start = names.length === 0 ? 0 : this.nextStart % names.length;
    this.nextStart = start + 1;
    /** Starts whose records did not fit this pump's byte budget: later shards skip at once. */
    const skipped = new Set<number>();
    let bytes = 0;
    for (let i = 0; i < names.length; i++) {
      if (this.inFlight >= this.maxInFlight) break;
      const name = names[(start + i) % names.length]!;
      const shard = this.shards.get(name)!;
      if (!this.due(shard, now)) continue;
      // An unknown cursor gets the ring from the shard's last snapshot (or the ring's start),
      // marked so the shard never takes `from` for what its sockets have. A known one below
      // the ring gets no records: the shard resyncs.
      const known = shard.acked !== null;
      const from = this.tickStart(shard.acked ?? shard.floor ?? this.ringFrom);
      if (skipped.has(from)) continue;
      let records = built.get(from);
      if (records === undefined) {
        // Bounded before merging: the sum of the ticks' cells is at least the union's.
        const bound = this.cellsBound(from);
        // The first push of a pump always goes, however big: nothing else would move it.
        if (bytes > 0 && bytes + bound * RECORD_BYTES > this.maxPumpBytes) {
          skipped.add(from);
          continue;
        }
        const cells = this.cellsSince(from);
        records = cells === null ? null : encodeRecords(this.deps.grid(), cells);
        bytes += records?.byteLength ?? 0;
        built.set(from, records);
      }
      // A push without records, or to an unknown cursor (the shard may have to resync), makes
      // a shard copy the whole grid: few at once.
      const resync = records === null || !known;
      if (resync && this.resyncs >= this.maxResyncs) continue;
      const size = records?.byteLength ?? 0;
      if (this.inFlight > 0 && this.inFlightBytes + size > this.maxInFlightBytes) continue;
      this.send(name, shard, { from, known, to: this.cutTo, records, rules }, now);
    }
    this.lastPumpBytes = bytes;
    this.schedule();
  }

  /** True when the shard should get a push now. */
  private due(shard: Shard, now: number): boolean {
    if (shard.inFlight || now < shard.retryAt) return false;
    return this.behind(shard);
  }

  private behind(shard: Shard): boolean {
    return shard.acked === null || shard.acked < this.cutTo || shard.rulesRev < this.rulesRev;
  }

  private send(name: string, shard: Shard, push: TickPush<R>, now: number): void {
    shard.inFlight = true;
    shard.resyncing = push.records === null || !push.known;
    shard.bytes = push.records?.byteLength ?? 0;
    this.inFlight++;
    this.inFlightBytes += shard.bytes;
    if (shard.resyncing) this.resyncs++;
    const { generation } = shard;
    const rulesRev = this.rulesRev;
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      this.clearTimer(timeout);
      shard.inFlight = false;
      this.inFlight--;
      this.inFlightBytes -= shard.bytes;
      shard.bytes = 0;
      if (shard.resyncing) this.resyncs--;
      shard.resyncing = false;
      return this.shards.get(name) === shard;
    };
    const fail = (error: unknown) => {
      if (!settle()) return;
      const at = this.now();
      shard.failures++;
      shard.failingSince ??= now;
      // Never forgotten while it may have sockets (only its own "no sockets" answer does
      // that): a shard that came back must get the canvas's changes. After a day of
      // failures it is only tried hourly.
      const longDown = at - shard.failingSince >= SHARD_GIVE_UP_MS;
      shard.retryAt =
        at +
        (longDown
          ? SHARD_SLOW_RETRY_MS
          : Math.min(MAX_SHARD_BACKOFF, PUSH_MS * 2 ** shard.failures));
      this.deps.failed?.(name, shard.failures, error);
      this.schedule();
    };
    const timeout = this.setTimer(
      () => fail(new Error(`push not answered within ${this.pushTimeoutMs} ms`)),
      this.pushTimeoutMs,
    );
    let sending: Promise<TickReply>;
    try {
      sending = this.deps.send(name, push);
    } catch (error) {
      sending = Promise.reject(error);
    }
    sending.then((reply) => {
      if (!settle()) return;
      shard.failures = 0;
      shard.retryAt = 0;
      shard.failingSince = null;
      // An answer to a push sent before the shard followed again says nothing of its sockets.
      if (shard.generation !== generation) return;
      if (reply.sockets === 0) {
        this.forget(name);
        return;
      }
      if (Number.isSafeInteger(reply.seq)) shard.acked = reply.seq;
      shard.rulesRev = rulesRev;
      this.schedule();
    }, fail);
  }

  private forget(name: string): void {
    this.shards.delete(name);
    this.sql.exec('DELETE FROM fanout_shards WHERE name = ?', name);
  }

  /** Turns the cells noted since the last tick into one tick, if anything moved. */
  private cut(): void {
    if (this.seq === this.cutTo && this.changed.size === 0 && !this.overflow) return;
    let cells: Uint32Array | null = null;
    if (!this.overflow) {
      cells = Uint32Array.from(this.changed);
      cells.sort();
    }
    this.ring.push({ from: this.cutTo, to: this.seq, cells });
    this.ringCellCount += cells?.length ?? 0;
    this.cutTo = this.seq;
    this.changed.clear();
    this.overflow = false;
    // The newest tick always stays: pushes to shards at the previous cursor are built from it.
    while (
      this.ring.length > 1 &&
      (this.ringCellCount > this.ringCells || this.ring.length > this.ringTicks)
    ) {
      const dropped = this.ring.shift()!;
      this.ringCellCount -= dropped.cells?.length ?? 0;
      this.ringFrom = dropped.to;
    }
  }

  /**
   * The start of the ring tick that holds `seq` (ticks cover from + 1 .. to), so that shards
   * at different seqs of one tick share their records; `seq` itself outside the ring.
   */
  private tickStart(seq: number): number {
    if (seq >= this.cutTo || seq < this.ringFrom) return seq;
    let lo = 0;
    let hi = this.ring.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid]!.to <= seq) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(seq, this.ring[lo]!.from);
  }

  /**
   * The ring's newest ticks, at most `maxCells` cells in all: each with the seq it ends at and
   * every cell it touched (a cell changed and changed back included), and the seq the first
   * starts after. The last ends at `cutTo`, which follow() just cut to. A shard seeds its own
   * list with them, tick by tick (ADR 0040), so a page that reconnects after the shard
   * restarted gets only what changed since its own seq. Null when the newest tick alone is too
   * big or named too many cells.
   */
  recent(maxCells: number): {
    readonly from: number;
    readonly ticks: readonly { readonly to: number; readonly cells: Uint32Array }[];
  } | null {
    let from = this.cutTo;
    let count = 0;
    let first = this.ring.length;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const tick = this.ring[i]!;
      if (tick.cells === null || count + tick.cells.length > maxCells) break;
      count += tick.cells.length;
      from = tick.from;
      first = i;
    }
    if (first === this.ring.length && this.ring.length > 0) return null;
    const ticks = this.ring.slice(first).map((t) => ({ to: t.to, cells: t.cells! }));
    return { from, ticks };
  }

  /** An upper bound of cellsSince(since).length, without merging: the ticks' own lengths. */
  private cellsBound(since: number): number {
    if (since >= this.cutTo || since < this.ringFrom) return 0;
    let n = 0;
    for (const t of this.ring) if (t.to > since) n += t.cells?.length ?? 0;
    return n;
  }

  /**
   * The cells changed after `since` up to `cutTo`, ascending; null when the ring does not
   * reach `since` or a tick in between named too many cells.
   */
  private cellsSince(since: number): Uint32Array | null {
    if (since >= this.cutTo) return new Uint32Array(0);
    if (since < this.ringFrom) return null;
    const ticks = this.ring.filter((t) => t.to > since);
    if (ticks.some((t) => t.cells === null)) return null;
    return mergeAll(ticks.map((t) => t.cells!));
  }

  /** As cellsSince, as records valued from the grid (which is at `cutTo`: right after a cut). */
  private recordsSince(since: number): Uint8Array | null {
    const cells = this.cellsSince(since);
    return cells === null ? null : encodeRecords(this.deps.grid(), cells);
  }

  /**
   * Sets the timer for the next pump, when a shard is behind or cells wait for a tick: pushMs
   * after the last pump, or now (on the next turn, so changes made in the same turn share the
   * tick) when that has passed. Pumps stay at most one per pushMs, the peak as before; a burst
   * after a quiet spell costs one more tick than waiting would have (ADR 0028).
   */
  private schedule(): void {
    if (!Number.isFinite(this.pushMs)) return;
    const now = this.now();
    const earliest = Math.max(now, this.lastPumpAt + this.pushMs);
    let at = Number.POSITIVE_INFINITY;
    const pending = this.seq > this.cutTo || this.changed.size > 0 || this.overflow;
    if (pending && this.shards.size > 0) at = earliest;
    for (const shard of this.shards.values()) {
      if (!shard.inFlight && this.behind(shard)) {
        at = Math.min(at, Math.max(earliest, shard.retryAt));
      }
    }
    if (!Number.isFinite(at) || at >= this.timerAt) return;
    this.clearScheduled();
    this.timerAt = at;
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.timerAt = Number.POSITIVE_INFINITY;
        this.pump();
      },
      Math.max(0, at - now),
    );
  }

  private clearScheduled(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
  }
}

function newShard(acked: number | null): Shard {
  return {
    acked,
    floor: null,
    bytes: 0,
    rulesRev: 0,
    inFlight: false,
    resyncing: false,
    failures: 0,
    retryAt: 0,
    failingSince: null,
    generation: 0,
    saved: null,
  };
}

/** The union of ascending index lists, ascending and without repeats; pairwise merges. */
export function mergeAll(lists: readonly Uint32Array[]): Uint32Array {
  if (lists.length === 0) return new Uint32Array(0);
  let level = [...lists];
  while (level.length > 1) {
    const next: Uint32Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? mergeTwo(level[i]!, level[i + 1]!) : level[i]!);
    }
    level = next;
  }
  return level[0]!;
}

function mergeTwo(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length || j < b.length) {
    const x = i < a.length ? a[i]! : Number.POSITIVE_INFINITY;
    const y = j < b.length ? b[j]! : Number.POSITIVE_INFINITY;
    const v = Math.min(x, y);
    if (x === v) i++;
    if (y === v) j++;
    out[n++] = v;
  }
  return out.subarray(0, n);
}

/** Records for these cells (ascending indices) at their values in `grid`. */
export function encodeRecords(grid: State, cells: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(cells.length * RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < cells.length; i++) {
    const index = cells[i]!;
    const at = i * RECORD_BYTES;
    view.setUint32(at, index, true);
    bytes[at + 4] = grid.cells[index]!;
    bytes[at + 5] = grid.shields[index]!;
  }
  return bytes;
}
