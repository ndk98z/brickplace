import {
  applyEntry,
  type CellDiff,
  type CoreConfig,
  cellsOf,
  createState,
  decodeCheckpoint,
  isFilled,
  type LogEntry,
  passTime,
  type Rect,
  type RestoreEntry,
  restoreEntry,
  type State,
  TILE_SIZE,
} from '@brickplace/core';
import { loadCheckpoint, readCheckpointMeta } from './checkpoints.ts';
import { newestCopy } from './copies.ts';
import { type LogLine, type LogSegment, listLogSegments, readLogSegment } from './oplog.ts';
import { type Removal, removed } from './season.ts';
import { parseWho, type RestoreWho, restoreWhoColumn, TeamLedger, type Who } from './teams.ts';

// Moderation rollbacks (ADR 0024). A job replays the log twice from a base: the baseline
// leaves out the ops of every rollback applied so far (that is what the live map is, and the
// job checks it), the target also leaves out the ops the new filter matches. Restore rows are
// skipped in both (the left-out ops stand for them), growth rows applied, and every row of
// player ops moves the clock, kept or not. The cells where the target differs from the live
// map become one `restore` entry. History comes from the grid checkpoint when the window starts
// after it, otherwise from the newest hourly R2 copy of a checkpoint that the window starts after
// (copies.ts), otherwise from seq 0; then through the R2 op-log segments, then SQLite (which the
// canvas does not trim while a job exists). Kept out of the Worker entry (index.ts).

/** Most cells one rollback may set (a 256² tile). */
export const MAX_RESTORE_CELLS = 65_536;
/**
 * Most bytes its row may hold (the entry and its `who`): SQLite takes 2 MB a row, and a cell
 * with five shield layers is about 84 bytes of JSON, so the cell count alone is not enough.
 */
export const MAX_RESTORE_BYTES = 1_500_000;

/**
 * Most memory (bytes, an estimate) the live map, its ledger and a rollback job may hold
 * together; a job that would pass it is not started. A Durable Object has 128 MB, and the
 * canvas holds more than these (SQLite pages, caches, the request in flight).
 */
export const MAX_ROLLBACK_MEMORY = 100 * 2 ** 20;
/** Bytes one live shield layer costs in a state: its slot in the cell's list and its queue entry. */
const LAYER_BYTES = 100;
/** Most rollbacks a canvas keeps for its seal, like season.ts's MAX_REMOVALS. */
export const MAX_ROLLBACKS = 1000;

export interface RollbackLimits {
  readonly cells: number;
  readonly bytes: number;
  readonly memory: number;
}

export const ROLLBACK_LIMITS: RollbackLimits = {
  cells: MAX_RESTORE_CELLS,
  bytes: MAX_RESTORE_BYTES,
  memory: MAX_ROLLBACK_MEMORY,
};

/**
 * What the live map and ledger plus a job would hold (bytes), estimated from the live map: three
 * states (live, baseline, target) of cells, shields and cover (3 bytes a cell) and their live
 * shield layers, and two writer ids a cell (the live ledger and the job's). The job's states
 * hold about the layers the live map holds.
 */
export function rollbackMemory(live: State): number {
  const area = live.cells.length;
  let layers = 0;
  for (const times of live.shieldExpiry.values()) layers += times.length;
  return 3 * (3 * area + LAYER_BYTES * layers) + 8 * area;
}
/** R2 segments one preview call reads (about a minute of a busy log each). */
export const SEGMENTS_PER_CALL = 25;
/**
 * SQLite rows one preview call replays, synchronously (twice, one per replay): ops wait that
 * long, a fraction of a second, once per call.
 */
export const ROWS_PER_CALL = 20_000;
/** A job nobody asked about for this long is dropped, and trimming resumes (ms). */
export const JOB_IDLE_MS = 15 * 60 * 1000;
/** Cells shown in a preview's sample. */
const SAMPLE = 20;
/** Longest player id a filter names (as CanvasDO's MAX_PLAYER_LENGTH). */
const MAX_PLAYER = 128;

/** What a moderator rolls back: any of a player, an area (anchor cells) and a time range. */
export interface RollbackFilter {
  /** Account id; absent: anyone. */
  readonly player?: string;
  /** Ops whose anchor cell lies here; absent: the whole map. */
  readonly area?: Rect;
  /** Logical time (ms): the window starts at the first row of player ops at or after it. */
  readonly from?: number;
  /** Logical time (ms): the window ends before the first row after it (at most the last row). */
  readonly to?: number;
}

/** A rollback applied on this canvas (meta `rollbacks`), and the removal the seal makes of it. */
export interface RollbackRecord {
  /** The seq of its restore row, or the last seq when it changed no cell. */
  readonly seq: number;
  /** The seq window its filter covered. */
  readonly from: number;
  readonly to: number;
  readonly area?: Rect;
  readonly player?: string;
  /** Cells its restore set. */
  readonly cells: number;
  /** Wall clock when it was applied (ms). */
  readonly appliedAt: number;
}

export interface CellChange {
  readonly x: number;
  readonly y: number;
  /** Cell bytes (core cell.ts) before and after, and the shield layers after. */
  readonly before: number;
  readonly after: number;
  readonly shields: number;
}

/** What a rollback would do to the live map at `seq` (the dry run), or did. */
export interface RollbackPreview {
  readonly job: string;
  readonly filter: RollbackFilter;
  /** The seqs the filter covers; null when no row falls in its time range. */
  readonly window: { readonly from: number; readonly to: number } | null;
  /** Player ops of the window the filter leaves out, by kind. */
  readonly removedOps: number;
  readonly removedByKind: Readonly<Record<string, number>>;
  /**
   * Player ops of the window whose row names no player for them (a `who` that cannot be read,
   * or a row logged before `who` existed): a filter by player cannot match them, and their
   * cells go back to nobody. Above 0, a rollback by player may leave some of its ops in place.
   */
  readonly unattributedOps: number;
  /** The live seq it was computed at. */
  readonly seq: number;
  /**
   * The seq the replay started from: the grid checkpoint's, an R2 copy's, or 0 (the season's
   * start).
   */
  readonly base: number;
  readonly cells: number;
  /** Cells that become filled, empty, or change colour or links. */
  readonly filled: number;
  readonly emptied: number;
  readonly recolored: number;
  /** Cells whose shield layers change. */
  readonly shields: number;
  readonly bounds: Rect | null;
  /** 256² tiles touched. */
  readonly tiles: number;
  readonly sample: readonly CellChange[];
  /**
   * Cells listed only to give them back to the target's writer: the map already shows them
   * right (a hole refilled the same way by an op the rollback drops). Counted in `cells`.
   */
  readonly writersOnly: number;
  /**
   * Over MAX_RESTORE_CELLS cells or MAX_RESTORE_BYTES of row: cannot be applied; narrow the
   * filter. The counts then describe only the first cells found.
   */
  readonly tooLarge: boolean;
}

export type RollbackStatus =
  | {
      readonly state: 'running';
      readonly job: string;
      /** Log seqs replayed so far, of `of`. */
      readonly done: number;
      readonly of: number;
    }
  | { readonly state: 'ready'; readonly preview: RollbackPreview }
  | { readonly state: 'failed'; readonly job: string | null; readonly error: string };

export type RollbackResult =
  | {
      readonly ok: true;
      readonly preview: RollbackPreview;
      readonly record: RollbackRecord;
    }
  | {
      readonly ok: false;
      readonly reason: 'no_job' | 'not_ready' | 'too_large' | 'ended' | 'failed' | 'full';
      readonly detail?: string;
    };

/** One op_log row as stored (or as an R2 segment line). */
type Row = LogLine;

/** What the job needs from the canvas, passed in so it holds no reference to the object. */
export interface JobContext {
  readonly sql: SqlStorage;
  readonly oplog: R2Bucket | null;
  /** Object key prefix (`c/{canvas}`). */
  readonly prefix: string;
  /** The rules the log starts from. */
  readonly core: CoreConfig;
  readonly ledger: TeamLedger;
  /** Told the seq of a row of player ops whose `who` cannot be read (its ops name nobody). */
  readonly unreadableWho?: (seq: number) => void;
}

/** The filter as given, or null when malformed (unknown fields are dropped). */
export function checkFilter(filter: unknown, size: number): RollbackFilter | null {
  if (typeof filter !== 'object' || filter === null) return null;
  const { player, area, from, to } = filter as Record<string, unknown>;
  const out: { player?: string; area?: Rect; from?: number; to?: number } = {};
  if (player !== undefined) {
    if (typeof player !== 'string' || player.length === 0 || player.length > MAX_PLAYER) {
      return null;
    }
    out.player = player;
  }
  if (area !== undefined) {
    if (typeof area !== 'object' || area === null) return null;
    const { x, y, w, h } = area as Record<string, unknown>;
    if (![x, y, w, h].every((v) => Number.isInteger(v) && (v as number) >= 0)) return null;
    const rect = { x, y, w, h } as Rect;
    if (rect.w < 1 || rect.h < 1 || rect.x + rect.w > size || rect.y + rect.h > size) return null;
    out.area = rect;
  }
  for (const [key, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
    out[key] = value as number;
  }
  if (out.from !== undefined && out.to !== undefined && out.to < out.from) return null;
  if (out.player === undefined && out.area === undefined && out.from === undefined) return null;
  return out;
}

export function readRollbacks(sql: SqlStorage): RollbackRecord[] {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'rollbacks'")
    .toArray()[0];
  return row ? (JSON.parse(row.value) as RollbackRecord[]) : [];
}

export function writeRollbacks(sql: SqlStorage, records: readonly RollbackRecord[]): void {
  sql.exec(
    "INSERT INTO meta (key, value) VALUES ('rollbacks', ?) " +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    JSON.stringify(records),
  );
}

/** The removal the seal makes of a rollback (ADR 0021, 0024): no area means the whole map. */
export function removalOf(record: RollbackRecord, size: number): Removal {
  return {
    from: record.from,
    to: record.to,
    area: record.area ?? { x: 0, y: 0, w: size, h: size },
    ...(record.player !== undefined ? { player: record.player } : {}),
  };
}

/**
 * One rollback being computed. Memory: two grids and a writer id per cell (about 40 MiB at
 * 2048²), dropped with the job.
 */
export class RollbackJob {
  /** The live seq when the job started: the window never reaches past it. */
  readonly limit: number;
  /** The seq the replay starts from: the grid checkpoint's, an R2 copy's, or 0. */
  readonly base: number;
  lastUsed: number;
  private failed: string | null = null;
  private seq: number;
  /** The ops of earlier rollbacks, left out of both replays. */
  private readonly priors: readonly Removal[];
  private windowFrom: number | null = null;
  private windowTo: number | null = null;
  private windowClosed = false;
  private removedOps = 0;
  private readonly removedByKind: Record<string, number> = {};
  private unattributedOps = 0;
  /** Target writer id per cell (ids of the live ledger's `writers`). */
  private readonly writers: Uint32Array;
  private readonly ids = new Map<string, number>();
  /** The advance under way. */
  private busy: Promise<unknown> = Promise.resolve();
  /** A preview has been built (apply requires one). */
  private built = false;
  /** Cells the last build lists only to give them their writer back. */
  private writersOnly = 0;
  /** R2 segments still to read, for seqs up to `fromR2`. */
  private segments: LogSegment[] | null;
  private constructor(
    readonly id: string,
    readonly filter: RollbackFilter,
    private readonly context: JobContext,
    private readonly baseline: State,
    private readonly target: State,
    base: { seq: number; writers: Uint32Array | null },
    /** Rows up to here are only in R2 (trimmed from SQLite before the job started). */
    private readonly fromR2: number,
    limit: number,
    now: number,
  ) {
    this.seq = base.seq;
    this.base = base.seq;
    this.limit = limit;
    this.lastUsed = now;
    this.writers = base.writers ?? new Uint32Array(baseline.cells.length);
    const size = context.core.size;
    this.priors = readRollbacks(context.sql).map((r) => removalOf(r, size));
    this.segments = base.seq < fromR2 ? null : [];
  }

  /**
   * Starts a job at the live seq `limit`, with SQLite trimmed up to `trimmedTo`. From the grid
   * checkpoint when the window starts after it (and no rollback logged after it reaches back
   * before it); otherwise from the newest R2 copy of a checkpoint that meets the same two
   * conditions (with its team checkpoint, for the writers); otherwise from an empty map at seq
   * 0. A copy's state is the live map at its seq exactly as the stored checkpoint was, so the
   * baseline still has to rebuild the live map before anything is applied.
   */
  static async start(
    id: string,
    filter: RollbackFilter,
    context: JobContext,
    limit: number,
    trimmedTo: number,
    now: number,
  ): Promise<RollbackJob> {
    const { sql, core, oplog, prefix } = context;
    const from = filter.from;
    if (from !== undefined) {
      const rollbacks = readRollbacks(sql);
      // A rollback logged after `seq` whose window starts at or before it changed what the
      // replay without its ops gives at `seq`: the live map there is no baseline.
      const reachesBack = (seq: number) => rollbacks.some((r) => r.seq > seq && r.from <= seq);
      const job = (baseline: State, target: State, seq: number, writers: Uint32Array) =>
        new RollbackJob(
          id,
          filter,
          context,
          baseline,
          target,
          { seq, writers },
          trimmedTo,
          limit,
          now,
        );
      const meta = readCheckpointMeta(sql);
      if (meta && !reachesBack(meta.seq) && !(meta.clock !== undefined && meta.clock >= from)) {
        const writers = await TeamLedger.checkpointCells(sql, core.size, meta.seq);
        if (writers) {
          const first = await loadCheckpoint(sql);
          if (first && first.meta.seq === meta.seq && first.state.clock < from) {
            const second = await loadCheckpoint(sql);
            if (second && second.meta.seq === meta.seq) {
              return job(first.state, second.state, meta.seq, writers);
            }
          }
        }
      }
      if (oplog) {
        // Only copies that are older than the window by their listed clock are read at all; one
        // without a readable team part (no writers) gives way to an older one.
        // A holder, not a `let`: assigned inside the callback.
        const found: { writers: Uint32Array | null } = { writers: null };
        const copy = await newestCopy(
          oplog,
          prefix,
          core.size,
          (c) => c.clock !== undefined && c.clock < from && c.seq <= limit && !reachesBack(c.seq),
          (loaded) => {
            found.writers = loaded.team ? TeamLedger.cellsOf(loaded.team, core.size) : null;
            return found.writers !== null;
          },
        ).catch((error: unknown) => {
          console.error('CanvasDO: checkpoint copies unreadable for a rollback', error);
          return null;
        });
        if (copy && found.writers) {
          return job(copy.state, decodeCheckpoint(copy.encoded), copy.seq, found.writers);
        }
      }
    }
    return new RollbackJob(
      id,
      filter,
      context,
      createState(core),
      createState(core),
      { seq: 0, writers: null },
      trimmedTo,
      limit,
      now,
    );
  }

  /** Same filter, as given to start. */
  matches(filter: RollbackFilter): boolean {
    return JSON.stringify(filter) === JSON.stringify(this.filter);
  }

  get error(): string | null {
    return this.failed;
  }

  /**
   * Replays up to SEGMENTS_PER_CALL R2 segments and ROWS_PER_CALL SQLite rows towards `upTo`
   * (the live seq). True once it has reached it. A failure is kept: the job answers with it.
   * Calls run one at a time (two admins polling the same job).
   */
  advance(upTo: number): Promise<boolean> {
    const run = this.busy.then(() => this.step(upTo));
    this.busy = run.catch(() => undefined);
    return run;
  }

  /** A preview was built and the log left to read is all in SQLite: it may be applied. */
  get ready(): boolean {
    return this.failed === null && this.built && this.seq >= this.fromR2;
  }

  private async step(upTo: number): Promise<boolean> {
    if (this.failed) return false;
    try {
      if (this.seq < this.fromR2) await this.readR2();
      if (this.seq < this.fromR2) return false;
      this.catchUp(upTo, ROWS_PER_CALL);
      return this.seq >= upTo;
    } catch (error) {
      this.failed = error instanceof Error ? error.message : String(error);
      console.error('CanvasDO: rollback replay failed', error);
      return false;
    }
  }

  /** Log seqs replayed so far. */
  get done(): number {
    return this.seq;
  }

  /**
   * Replays SQLite rows up to `upTo`, synchronously, at most `budget` of them. The final step
   * before a preview or an apply runs with no budget, between two live ops.
   */
  catchUp(upTo: number, budget = Number.POSITIVE_INFINITY): void {
    const { sql } = this.context;
    while (this.seq < upTo && budget > 0) {
      const take = Math.min(budget, 5_000, upTo - this.seq);
      const rows = sql
        .exec<Row & Record<string, SqlStorageValue>>(
          'SELECT seq, ops, at, who FROM op_log WHERE seq > ? AND seq <= ? ORDER BY seq',
          this.seq,
          this.seq + take,
        )
        .toArray();
      if (rows.length === 0) throw new Error(`op log rows after ${this.seq} are gone`);
      for (const row of rows) this.replay(row);
      budget -= rows.length;
    }
  }

  /**
   * The restore that turns `live` into the target now, with the writers of its cells and what
   * it does; throws when the baseline does not rebuild the live map (nothing may be applied
   * then). Call right after catchUp(live seq), in the same synchronous step.
   */
  build(
    live: State,
    seq: number,
    limits: RollbackLimits = ROLLBACK_LIMITS,
  ): { entry: RestoreEntry; who: RestoreWho; preview: RollbackPreview } {
    // Stops at the first difference: the baseline must be the live map.
    if (restoreEntry(live, this.baseline, 0).cells.length > 0) {
      throw new Error('the log does not rebuild the live map; nothing was changed');
    }
    this.writersOnly = 0;
    // Never more than one cell past the limit in memory, however much differs.
    const differ = restoreEntry(live, this.target, limits.cells);
    const entry =
      differ.cells.length > limits.cells ? differ : this.withWriters(live, differ, limits.cells);
    const { size } = live.config;
    const pairs: Who[] = [];
    /** 1-based pair per writer id (0: nobody): one ledger lookup per writer, not per cell. */
    const byId = new Map<number, number>();
    const of = entry.cells.map(([i, cell]) => {
      if (!isFilled(cell)) return 0;
      const id = this.writers[i]!;
      let n = byId.get(id);
      if (n === undefined) {
        const who = this.context.ledger.whoOf(id);
        n = who ? pairs.push(who) : 0;
        byId.set(id, n);
      }
      return n;
    });
    let filled = 0;
    let emptied = 0;
    let recolored = 0;
    let shields = 0;
    let x0 = size;
    let y0 = size;
    let x1 = -1;
    let y1 = -1;
    const tiles = new Set<number>();
    const sample: CellChange[] = [];
    for (const [i, cell, ...layers] of entry.cells) {
      const before = live.cells[i]!;
      if (!isFilled(before) && isFilled(cell)) filled++;
      else if (isFilled(before) && !isFilled(cell)) emptied++;
      else if (before !== cell) recolored++;
      const had = live.shieldExpiry.get(i) ?? [];
      if (had.length !== layers.length || had.some((t, k) => t !== layers[k])) shields++;
      const x = i % size;
      const y = (i - x) / size;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      tiles.add(
        Math.floor(y / TILE_SIZE) * Math.ceil(size / TILE_SIZE) + Math.floor(x / TILE_SIZE),
      );
      if (sample.length < SAMPLE) {
        sample.push({ x, y, before, after: cell, shields: layers.length });
      }
    }
    const tooMany = entry.cells.length > limits.cells;
    // The row must fit SQLite's 2 MB with room to spare: layer times make cells far bigger.
    const bytes = tooMany
      ? Number.POSITIVE_INFINITY
      : JSON.stringify([entry]).length + restoreWhoColumn({ pairs, of }).length;
    const preview: RollbackPreview = {
      job: this.id,
      filter: this.filter,
      window:
        this.windowFrom !== null && this.windowTo !== null
          ? { from: this.windowFrom, to: this.windowTo }
          : null,
      removedOps: this.removedOps,
      removedByKind: { ...this.removedByKind },
      unattributedOps: this.unattributedOps,
      seq,
      base: this.base,
      cells: entry.cells.length,
      filled,
      emptied,
      recolored,
      shields,
      bounds: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
      tiles: tiles.size,
      sample,
      writersOnly: this.writersOnly,
      tooLarge: tooMany || bytes > limits.bytes,
    };
    this.built = true;
    return { entry, who: { pairs, of }, preview };
  }

  /**
   * The entry plus every filled cell the map already has right but whose writer differs from
   * the target's (a cell refilled the same way by an op the rollback drops), listed with its
   * live value so the ledger gives it to the right writer. At most `limit + 1` cells.
   */
  private withWriters(live: State, entry: RestoreEntry, limit: number): RestoreEntry {
    const { ledger } = this.context;
    const listed = new Set(entry.cells.map(([i]) => i));
    const extra: RestoreEntry['cells'][number][] = [];
    for (let i = 0; i < live.cells.length; i++) {
      if (!isFilled(live.cells[i]!) || listed.has(i)) continue;
      if (ledger.writerIdAt(i) === this.writers[i]) continue;
      extra.push([i, live.cells[i]!, ...(live.shieldExpiry.get(i) ?? [])]);
      if (entry.cells.length + extra.length > limit) break;
    }
    this.writersOnly = extra.length;
    if (extra.length === 0) return entry;
    const cells = [...entry.cells, ...extra].sort((a, b) => a[0] - b[0]);
    return { kind: 'restore', cells };
  }

  /** Lists the R2 segments once, then replays up to SEGMENTS_PER_CALL of them. */
  private async readR2(): Promise<void> {
    const { oplog, prefix } = this.context;
    if (!oplog) throw new Error('the log before SQLite is in R2, which this canvas has not got');
    if (this.segments === null) {
      this.segments = await listLogSegments(oplog, prefix, this.seq, this.fromR2);
    }
    for (let n = 0; n < SEGMENTS_PER_CALL && this.seq < this.fromR2; n++) {
      const segment = this.segments.shift();
      if (!segment) throw new Error(`the R2 log ends before seq ${this.fromR2}`);
      if (segment.to <= this.seq) continue;
      if (segment.from > this.seq + 1)
        throw new Error(`the R2 log has a gap before ${segment.key}`);
      for (const row of await readLogSegment(oplog, segment)) {
        if (row.seq > this.seq && row.seq <= this.fromR2) this.replay(row);
      }
    }
  }

  /** Replays one log row into the baseline and the target. */
  private replay(row: Row): void {
    if (row.seq !== this.seq + 1) throw new Error(`op log gap: ${this.seq} then ${row.seq}`);
    this.seq = row.seq;
    const entries = JSON.parse(row.ops) as LogEntry[];
    const first = entries[0];
    // A restore is what its rollback's left-out ops did: both replays leave those out instead.
    if (!first || first.kind === 'restore') return;
    if (first.kind === 'open') {
      for (const entry of entries) {
        applyEntry(this.baseline, entry);
        applyEntry(this.target, entry);
      }
      return;
    }
    // Every row of player ops moved the live clock when it was accepted.
    passTime(this.baseline, row.at);
    passTime(this.target, row.at);
    const inWindow = this.window(row);
    const whos = parseWho(row.who, entries.length, () => this.context.unreadableWho?.(row.seq));
    entries.forEach((entry, i) => {
      const who = whos[i] ?? null;
      const player = who ? who[0] : null;
      if (removed(this.priors, row.seq, entry, player)) return;
      if (inWindow && player === null) this.unattributedOps++;
      applyEntry(this.baseline, entry, row.at);
      if (inWindow && this.leftOut(entry, player)) {
        this.removedOps++;
        this.removedByKind[entry.kind] = (this.removedByKind[entry.kind] ?? 0) + 1;
        return;
      }
      const result = applyEntry(this.target, entry, row.at);
      if (result.ok) this.write(entry, result.diffs, who);
    });
  }

  /** Whether a row of player ops falls in the window, which it opens or closes. */
  private window(row: Row): boolean {
    if (this.windowClosed) return false;
    const { from, to } = this.filter;
    if (this.windowFrom === null) {
      if (row.seq > this.limit || (from !== undefined && row.at < from)) return false;
      this.windowFrom = row.seq;
    }
    if (row.seq > this.limit || (to !== undefined && row.at > to)) {
      this.windowClosed = true;
      return false;
    }
    this.windowTo = row.seq;
    return true;
  }

  private leftOut(entry: LogEntry, player: string | null): boolean {
    if (entry.kind === 'open' || entry.kind === 'restore') return false;
    const { player: who, area } = this.filter;
    if (who !== undefined && who !== player) return false;
    if (area === undefined) return true;
    return (
      entry.x >= area.x &&
      entry.y >= area.y &&
      entry.x < area.x + area.w &&
      entry.y < area.y + area.h
    );
  }

  /** The target's writer per cell, as the ledger keeps it for the live map. */
  private write(entry: LogEntry, diffs: readonly CellDiff[], who: Who | null): void {
    const { size } = this.context.core;
    if (entry.kind === 'brick' || entry.kind === 'single') {
      const id = this.idOf(who);
      const cells =
        entry.kind === 'single' ? [[0, 0] as const] : cellsOf(entry.shape, entry.rotation);
      for (const [dx, dy] of cells) this.writers[(entry.y + dy) * size + entry.x + dx] = id;
    } else if (entry.kind === 'hammer') {
      const index = entry.y * size + entry.x;
      let last: CellDiff | undefined;
      for (const d of diffs) if (d.index === index) last = d;
      if (last && !isFilled(last.cell)) this.writers[index] = 0;
    }
  }

  private idOf(who: Who | null): number {
    if (!who) return 0;
    const key = JSON.stringify(who);
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.context.ledger.idOf(who);
      if (this.ids.size > 100_000) this.ids.clear();
      this.ids.set(key, id);
    }
    return id;
  }
}
