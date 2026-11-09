import { DurableObject } from 'cloudflare:workers';
import {
  type ApplyResult,
  apply,
  applyEntry,
  blockedCells,
  type CellDiff,
  type CoreConfig,
  checkGrowth,
  checkItemConfig,
  createState,
  DEFAULT_ITEM_CONFIG,
  DEFAULT_MAP_SIZE,
  DEFAULT_MAX_SHIELD,
  DEFAULT_OPEN_EDGE,
  DEFAULT_OPEN_GROWTH,
  DEFAULT_SHIELD_LIFETIME,
  encodeCheckpoint,
  gridHash,
  type Item,
  type ItemConfig,
  itemFor,
  type LogEntry,
  nextOpenArea,
  type Op,
  type OpenAreaEntry,
  type OpenGrowth,
  phaseOf,
  type Rect,
  type State,
  TILE_SIZE,
} from '@brickplace/core';
import { alarmDeferral } from './alarms.ts';
import {
  archiveComplete,
  deleteStrippedRaw,
  newPseudonymKey,
  Pseudonyms,
  purgePlayerData,
  renamedLogTail,
  SEAL_SEGMENTS_PER_STEP,
  SealJob,
} from './archive.ts';
import {
  type CheckpointMeta,
  createCheckpointTable,
  loadCheckpoint,
  prepareCheckpoint,
  storeCheckpoint,
} from './checkpoints.ts';
import {
  type CancelResult,
  ConfigSchedule,
  type ConfigScheduleResult,
  type ConfigScope,
  type ConfigState,
  type ConfigVersion,
  createConfigTable,
} from './config.ts';
import {
  COPY_MS,
  type CopyRecord,
  copyCheckpoint,
  deleteCopies,
  newestCopy,
  RECOVERY_CHECKPOINT_MS,
  RECOVERY_COPY_ATTEMPTS,
  RECOVERY_SEGMENTS,
  readCopyRecord,
} from './copies.ts';
import { createDedupeTable } from './dedupe.ts';
import { type DrawWords, drawWords, importDrawKey, newSalt, parseSalt } from './draws.ts';
import { createInventoryTable, type HoldView, InventoryBatch } from './inventory.ts';
import { PlayerState, STATE_FOLD_MS } from './journal.ts';
import { createKeyframeTables, KeyframeWriter } from './keyframes.ts';
import {
  type AreaLock,
  activeLocks,
  isLocked,
  type LockRequest,
  type LockResult,
  type LockState,
  MAX_LOCKS,
  newLock,
  readLocks,
  type UnlockResult,
  writeLocks,
} from './locks.ts';
import { type LogLine, listLogSegments, readLogSegment, shipLog, shippedTo } from './oplog.ts';
import { errorText, loggableError, OpsSampler, opsEvent } from './ops.ts';
import { type CanvasStats, Presence, type PresenceTotals, readReport } from './presence.ts';
import { CdnPublisher, createCdnTables, SEGMENT_MS } from './publish.ts';
import { createShardTable, type TickPush, TickPusher, type TickReply } from './push.ts';
import {
  checkFilter,
  JOB_IDLE_MS,
  MAX_ROLLBACKS,
  ROLLBACK_LIMITS,
  type RollbackFilter,
  RollbackJob,
  type RollbackLimits,
  type RollbackRecord,
  type RollbackResult,
  type RollbackStatus,
  readRollbacks,
  removalOf,
  rollbackMemory,
  writeRollbacks,
} from './rollback.ts';
import {
  changeSchedule,
  ID_RETENTION_MS,
  type Refusal,
  type Removal,
  readRemovals,
  readSeason,
  refusal,
  type ScheduleChange,
  type ScheduleResult,
  type SeasonState,
  validRemovals,
  writeRemovals,
  writeSeason,
} from './season.ts';
import {
  countMoves,
  createSeasonNumbersTable,
  NO_NUMBERS,
  readSeasonNumbers,
  type SeasonNumbers,
} from './season-numbers.ts';
import {
  createTeamTables,
  parseRestoreWho,
  parseWho,
  restoreWhoColumn,
  TeamLedger,
  type TeamStats,
  type Who,
} from './teams.ts';

// The Worker entry: workerd accepts only handlers and Durable Object classes as exports
// here (anything else stops `wrangler dev`), so constants live in sibling modules.
// test/entry-exports.test.ts checks it. Type exports are erased and fine.

export interface Env {
  CANVAS: DurableObjectNamespace<CanvasDO>;
  /**
   * Workers secret: the key of the item-draw PRF (see draws.ts). Never in wrangler.jsonc;
   * local dev reads it from .dev.vars. When it is missing the canvas draws no items.
   */
  ITEM_DRAW_KEY?: string;
  /**
   * Private bucket for op-log segments (ADR 0014), shipped before rows are trimmed. Without it
   * the log is never trimmed. Optional so other scripts' tests can host the class without it.
   */
  OPLOG?: R2Bucket;
  /** Public bucket behind the CDN: tiles, diff segments and the manifest (ADR 0009, 0014). */
  TILES?: R2Bucket;
  /**
   * The standings database (ADR 0020; schema in migrations/): the canvas writes each team's
   * counters there for the ranking, and nothing else. Without it standings stay in the canvas.
   */
  STANDINGS?: D1Database;
  /**
   * Abuse thresholds from the private ops repo: the daily team contribution cap
   * (`team-daily-cells`, ADR 0020). Without it no cell counts toward a team.
   */
  MODERATION?: KVNamespace;
  /**
   * The FanoutDO shards of the realtime script (ADR 0028), which this canvas pushes diff ticks
   * to. Without it no shard can follow: each relays only the replies to its own ops.
   */
  FANOUT?: DurableObjectNamespace<TickTarget>;
}

/**
 * What the canvas calls on a FanoutDO shard, typed here so this script does not depend on the
 * realtime one (which depends on it).
 */
export interface TickTarget extends Rpc.DurableObjectBranded {
  tick(push: TickPush<Rules>): Promise<TickReply>;
}

export type { SeasonArchive } from './archive.ts';
export type {
  CancelResult,
  ConfigScheduleResult,
  ConfigScope,
  ConfigState,
  ConfigVersion,
  ScheduledVersion,
} from './config.ts';
export type { HoldView } from './inventory.ts';
export type { AreaLock, LockRequest, LockResult, UnlockResult } from './locks.ts';
export type { CanvasStats, PresenceReport, PresenceTotals } from './presence.ts';
export type { TickPush, TickReply } from './push.ts';
export type {
  CellChange,
  RollbackFilter,
  RollbackPreview,
  RollbackRecord,
  RollbackResult,
  RollbackStatus,
} from './rollback.ts';
export type {
  Refusal,
  Removal,
  ScheduleChange,
  ScheduleResult,
  SeasonPhase,
  SeasonState,
} from './season.ts';
export type { SeasonNumbers } from './season-numbers.ts';
export type { TeamStats, Who } from './teams.ts';

/** One op as it reaches the canvas: who sent it, under which id, and what it does. */
export interface PlayerOp {
  /** Set by the server (gateway, then FanoutDO); the client never chooses it outside dev. */
  readonly player: string;
  /**
   * The sending page's connection id (ADR 0017), chosen by the client within its own player:
   * two tabs of one account, or a tab before and after a reload, count their opIds apart.
   * '' when absent (FanoutDOs older than the field).
   */
  readonly client?: string;
  /**
   * Chosen by the client; must not repeat for the same (player, client) within
   * DEDUPE_WINDOW ops.
   */
  readonly opId: number;
  readonly op: Op;
  /**
   * The team the player is in, from their session token (ADR 0020), set by the gateway and
   * FanoutDO like `player`. Absent or 0: no team. The op counts for this team, the team at
   * the time it was written, never a later one.
   */
  readonly team?: number;
}

/**
 * A discard (ADR 0012: throwing a held item away), deduplicated like an op by (player, client,
 * opId). It changes only the hold and is never logged.
 */
export interface PlayerDiscard {
  readonly player: string;
  readonly client?: string;
  readonly opId: number;
  readonly discard: Item;
}

/** What a shard relays in one call (ADR 0043): ops and discards, in arrival order. */
export type PlayerMove = PlayerOp | PlayerDiscard;

/**
 * The result of one op. `duplicate` marks a retry of an op this canvas already accepted:
 * it is answered as accepted and applied nothing, since its diffs went out under the seq
 * of the original. An op the player holds no item for is refused with `no_item`. Past the
 * season's end, or while the map is paused, every op is refused with `ended` or `read_only`
 * (ADR 0021) before any hold is looked at. An op touching an area moderators locked is refused
 * with `locked` (ADR 0024), its item untouched. While the canvas is behind, new ops are
 * refused with `busy` without being queued (ADR 0032), their items untouched.
 */
export type OpResult =
  | ApplyResult
  | { readonly ok: true; readonly duplicate: true; readonly diffs: readonly CellDiff[] }
  | { readonly ok: false; readonly reason: Refusal | 'locked' | 'busy' };

export interface BatchResult {
  /** Log sequence number after this batch; clients use it to detect gaps. */
  readonly seq: number;
  readonly results: readonly OpResult[];
  /** The hold of every player with a valid op in the batch, after the batch. */
  readonly holds: ReadonlyMap<string, HoldView>;
  /** The rules after the batch, so FanoutDO notices a grown open area with the next op. */
  readonly rules: Rules;
  /**
   * Set when this batch filled the open area up to the growth threshold: the seq of the
   * growth row logged right after it (always `seq + 1`). That row changes no cell, so a
   * reader that has `seq` also has everything up to `grewAt`.
   */
  readonly grewAt?: number;
}

/** What clients need to know of the canvas rules (sent to them in the config frame). */
export interface Rules {
  readonly mapSize: number;
  /** Area players may act in; it only grows (see CanvasDO.setOpenArea). */
  readonly open: Rect;
  readonly maxShield: number;
  /**
   * The log seq these rules were read at, so a reader can tell older rules from newer ones
   * when replies arrive out of order. Absent from canvases that predate it.
   */
  readonly seq?: number;
  /** Areas moderators locked (ADR 0024), in force when the rules were read. */
  readonly locks?: readonly Rect[];
  /**
   * Grows with every change of the locks, which takes no seq: of two rule sets read at the
   * same seq, the higher revision is the newer.
   */
  readonly locksRev?: number;
}

/** Where the log stands: its last seq and the rules after it. Cheap, unlike snapshot(). */
export interface Status {
  readonly seq: number;
  readonly rules: Rules;
}

export type OpenAreaResult =
  | { readonly ok: true; readonly seq: number; readonly rules: Rules }
  | { readonly ok: false; readonly reason: 'invalid' };

export type DiscardResult =
  | { readonly ok: true; readonly duplicate?: true }
  | { readonly ok: false; readonly reason: 'invalid' | 'no_item' | Refusal | 'busy' };

/** Where the season stands (ADR 0021), for admins (lane I) and tests. */
export interface SeasonView extends SeasonState {
  readonly seq: number;
  /** Archive-only removals (setRemovals). */
  readonly removals: readonly Removal[];
  /** Rollbacks applied (ADR 0024); the seal removes their ops too. */
  readonly rollbacks: readonly RollbackRecord[];
}

export type RemovalsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid' | 'sealed' | 'stale' };

export interface DiscardReply {
  readonly result: DiscardResult;
  /** The player's hold afterwards; null when the identity was invalid. */
  readonly hold: HoldView | null;
}

/** The whole grid and the log seq it reflects. */
export interface Snapshot {
  readonly seq: number;
  readonly cells: Uint8Array;
  readonly shields: Uint8Array;
  readonly rules: Rules;
}

/** A snapshot for a shard that follows the canvas (ADR 0028). */
export interface FollowReply extends Snapshot {
  /** False when the shard was not registered (no FANOUT binding, or too many shards). */
  readonly following: boolean;
  /**
   * Every cell changed between the seq the shard's sockets have (as it said, or as the canvas
   * last heard from it) and `seq`, as tick records at their values in this snapshot; null
   * when neither knows that seq or the tick ring no longer reaches it.
   */
  readonly changes: Uint8Array | null;
  /**
   * When the shard asked (ADR 0040): the newest ticks the canvas still has, from `from` up to
   * `seq`, each with the seq it ends at and every cell it touched (ascending), so the shard
   * can resume reconnecting pages. Absent when not asked, not following, or the newest tick
   * alone was too big.
   */
  readonly recent?: {
    readonly from: number;
    readonly ticks: readonly { readonly to: number; readonly cells: Uint32Array }[];
  };
}

/** Most cells a follow() reply lists as recent changes (1 MiB of indices). */
const MAX_RECENT_CELLS = 1 << 18;

/** Longest FanoutDO name the canvas registers. */
const MAX_SHARD_NAME = 128;

/** The config stored with the canvas: the core's rules plus what the canvas hands out. */
interface CanvasConfig extends CoreConfig {
  readonly items?: ItemConfig;
  /** 16 random bytes (hex) mixed into every draw, so canvases never share draw words. */
  readonly drawSalt?: string;
  /** When the open area grows by itself (core's nextOpenArea, ADR 0013), checked per batch. */
  readonly growth?: OpenGrowth;
}

const MAX_PLAYER_LENGTH = 128;
/** The gateway accepts connection ids of up to 64 characters (ADR 0017). */
const MAX_CLIENT_LENGTH = 64;
const DUPLICATE: OpResult = { ok: true, duplicate: true, diffs: [] };
/** An accepted discard: no cell changed. */
const DISCARDED: OpResult = { ok: true, diffs: [] };
const INVALID: OpResult = { ok: false, reason: 'invalid' };
const NO_ITEM: OpResult = { ok: false, reason: 'no_item' };
const LOCKED: OpResult = { ok: false, reason: 'locked' };
/** Draw words computed ahead and not used yet; a bound, not a tuning knob. */
const MAX_CACHED_WORDS = 10_000;

/**
 * Maintenance (checkpoint check, log shipping and trimming, tiles, garbage) runs at most this
 * often (ms). Diff segments have their own, faster cadence: SEGMENT_MS.
 */
const MAINTAIN_MS = 10_000;
/** Shortest wait before an alarm (ms), so a burst of due work cannot spin. */
const MIN_WAIT = 1_000;
/**
 * Longest wait before an alarm (ms): a season's end or seal can be days or months away, and
 * a far-off alarm is set again from a nearer one rather than trusted that far ahead.
 */
const MAX_WAIT = 24 * 60 * 60 * 1000;
/**
 * How late an alarm may be before it is taken as lost and set again (ms). Staging's canvas
 * lost every tick for a day that way: its handler threw through all its retries while the
 * account's write quota was spent, and getAlarm() kept returning that time (in the past, never
 * to fire) across restarts, which arm() took for an alarm already due (ADR 0044).
 */
const LOST_ALARM_MS = 60_000;
/** A checkpoint is taken at most this often, and only after accepted ops (ms). */
const CHECKPOINT_MS = 60_000;
/** Longest wait between attempts to ship a log segment that keeps failing (ms). */
const MAX_SHIP_BACKOFF = 60 * 60 * 1000;
/** Longest wait between attempts at the public bucket while it keeps failing (ms). */
const MAX_CDN_BACKOFF = 5 * 60 * 1000;
/**
 * Consecutive failed seal attempts after which each further one also logs `archive_seal_stuck`
 * (docs/ops/alerts.md): with the backoff doubling from MAINTAIN_MS, the fifth comes about
 * 2.5 minutes after the first, so a passing R2 hiccup stays below it.
 */
const SEAL_STUCK_AFTER = 5;
/**
 * Calls waiting in the canvas's queue (ops, discards, holds, admin calls) from which
 * `canvas_queue_deep` is logged: each takes about a millisecond, so this many waiting means
 * the canvas is falling behind.
 */
const QUEUE_DEEP = 64;
/**
 * Calls waiting from which new ops and discards are refused `busy` at once, without queueing
 * (ADR 0032): about a quarter second of work. Holds, ticks, admin calls and shard pushes are
 * never shed. A capacity setting, like QUEUE_DEEP, not an abuse threshold.
 */
const QUEUE_SHED = 256;
const BUSY: OpResult = { ok: false, reason: 'busy' };
/** A tick that takes longer than this (wall clock, ms) logs `canvas_tick_slow`. */
const TICK_SLOW_MS = SEGMENT_MS;

/** One op_log row as stored; replay and shipping treat every column generically. */
type LogRow = { seq: number; ops: string; at: number; who?: string | null } & Record<
  string,
  SqlStorageValue
>;

/**
 * Stage 0 source of truth: the whole grid and every player's hold in one DO.
 * Accepted ops are appended to SQLite (one row per batch) before the reply leaves the
 * object. Recovery restores the latest checkpoint and replays the log rows after it; rows a
 * checkpoint covers are trimmed once R2 has them (ADR 0014). Holds, team credit, season
 * numbers and dedupe keys go to one journal row per write, in the same transaction as the ops
 * that changed them, and reach their own tables every few minutes (ADR 0042, journal.ts).
 *
 * Calls that touch holds run one at a time, in arrival order: a draw needs its PRF words
 * from WebCrypto (async) before the synchronous part that reserves, applies and commits.
 */
export class CanvasDO extends DurableObject<Env> {
  // Set during the constructor's blockConcurrencyWhile, before any call can arrive.
  private grid!: State;
  /** Items and growth rule by time: the stored config, then admin versions (ADR 0022). */
  private readonly settings: ConfigSchedule;
  private readonly salt: Uint8Array;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private drawKey: Promise<CryptoKey | null> | null = null;
  /** PRF words by `${drawIndex}:${player}`, computed before the batch that uses them. */
  private readonly words = new Map<string, DrawWords>();
  /** Object key prefix in both buckets: one canvas per prefix. */
  private readonly prefix: string;
  private cdn: CdnPublisher | null = null;
  private checkpointSeq = 0;
  private checkpointAt = 0;
  /** Every op_log row up to here is deleted. */
  private trimmedTo = 0;
  /** Log shipping waits until this time (tick time, ms) after failures, doubling each time. */
  private shipNextAt = 0;
  private shipBackoff = 0;
  /** The latest checkpoint copy in OPLOG (copies.ts), mirrored from meta `checkpoint_copy`. */
  private copy: CopyRecord | null = null;
  /** Copies wait until this time (tick time, ms) after failures, doubling up to hourly. */
  private copyNextAt = 0;
  private copyBackoff = 0;
  /** Work on the public bucket waits until this time (tick time, ms) after failures. */
  private cdnNextAt = 0;
  /**
   * Wall-clock time (ms) before which ops ask for no segment: SEGMENT_MS after the last
   * segment step that had something to write, or the end of the CDN's backoff. An op after it
   * asks for a tick at once.
   */
  private segmentAfter = 0;
  private cdnBackoff = 0;
  /** Tick time of the last maintenance pass (ms). */
  private maintainedAt = Number.NEGATIVE_INFINITY;
  /** When the scheduled alarm fires (wall clock, ms), or null when none is scheduled. */
  private alarmAt: number | null = null;
  private ticking: Promise<unknown> = Promise.resolve();
  /** Last writer per cell and team counters (ADR 0020); set with the grid. */
  private teams!: TeamLedger;
  /** This canvas's name in D1's team standings. */
  private readonly canvasName: string;
  /** Who is playing, as counts from the shards' watchdog calls (ADR 0030); memory only. */
  private readonly presence = new Presence();
  /** The rules the log starts from: what a replay of the whole season begins with. */
  private readonly core: CoreConfig;
  /** The season's schedule and phase (ADR 0021), mirrored from meta `season`. */
  private season: SeasonState;
  private keyframes: KeyframeWriter | null = null;
  /** Keyframes wait until this time (tick time, ms) after a failure. */
  private keyframeNextAt = 0;
  /** The archive being sealed, if a seal is under way in this object's lifetime. */
  private sealJob: SealJob | null = null;
  /**
   * Sealing waits until this time (tick time, ms) after failures, doubling up to hourly. Set
   * from meta `seal_failures` at start, so an eviction between attempts keeps the backoff.
   */
  private sealNextAt = 0;
  /** Calls waiting in or running from `queue`. */
  private queued = 0;
  /**
   * Ops and discards waiting in or running from `queue`, by moveKey, with how many calls carry
   * each: a retry of one of them is queued behind it rather than shed (ADR 0032), so it gets
   * the duplicate it would have got before. Never larger than the queue.
   */
  private readonly queuedMoves = new Map<string, number>();
  /** Overload signals (docs/ops/alerts.md), one per name per minute at most. */
  private readonly ops = new OpsSampler();
  /** A tick longer than this logs `canvas_tick_slow` (a field so tests can lower it). */
  private tickSlowMs = TICK_SLOW_MS;
  /**
   * Failed seal attempts from which each logs `archive_seal_stuck` too (a field so
   * tests can lower it: every attempt replays the whole season).
   */
  private sealStuckAfter = SEAL_STUCK_AFTER;
  /** Raw segments per seal step (a field so tests can reach a multi-step seal cheaply). */
  private sealSegmentsPerStep = SEAL_SEGMENTS_PER_STEP;
  /** Area locks (ADR 0024), mirrored from meta `locks`. */
  private locks: LockState;
  /** The rollback being previewed (ADR 0024); the log is not trimmed while there is one. */
  private rollback: RollbackJob | null = null;
  /** Whose request started the current job. */
  private rollbackBy: 'owner' | 'moderator' = 'owner';
  /** Rollback jobs being started: trimming waits for them too (they read from trimmedTo). */
  private rollbackStarting = 0;
  /** What one rollback may set; tests lower it to reach the refusal without huge maps. */
  rollbackLimits: RollbackLimits = ROLLBACK_LIMITS;
  /** Diff ticks to the FanoutDO shards following this canvas (ADR 0028); set with the grid. */
  private pusher!: TickPusher<Rules>;
  /** Holds, team credit, season numbers and the dedupe window (ADR 0042, journal.ts). */
  private readonly state: PlayerState;
  /** Tick time of the last fold of the journal into the player tables (ms). */
  private foldedAt = Number.NEGATIVE_INFINITY;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // `at` is the batch's logical time (ms) that apply() replays with (shield decay, ADR 0007).
    sql.exec(
      'CREATE TABLE IF NOT EXISTS op_log (seq INTEGER PRIMARY KEY, ops TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0)',
    );
    // Logs written before `at` existed gain it; their rows replay at time 0.
    const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('op_log')");
    if (!columns.toArray().some((c) => c.name === 'at')) {
      sql.exec('ALTER TABLE op_log ADD COLUMN at INTEGER NOT NULL DEFAULT 0');
    }
    createDedupeTable(ctx.storage);
    createInventoryTable(sql);
    createSeasonNumbersTable(sql);
    createCheckpointTable(sql);
    createCdnTables(sql);
    createTeamTables(sql);
    createShardTable(sql);
    this.state = new PlayerState(sql);
    this.canvasName = ctx.id.name ?? ctx.id.toString();
    createKeyframeTables(sql);
    this.season = readSeason(sql);
    this.locks = readLocks(sql);
    // Fixed at first construction: objects already in R2 stay under it even if the name the
    // object is reached by ever changes.
    const prefix = sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'r2_prefix'")
      .toArray()[0];
    this.prefix = prefix?.value ?? `c/${encodeURIComponent(ctx.id.name ?? ctx.id.toString())}`;
    if (!prefix) sql.exec("INSERT INTO meta (key, value) VALUES ('r2_prefix', ?)", this.prefix);
    // The config the log was written under is stored with it, so changing a default in code
    // never silently rewrites history on the next replay. Changing it is an admin action.
    const stored = sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'")
      .toArray();
    let config: CanvasConfig;
    if (stored[0]) {
      config = JSON.parse(stored[0].value) as CanvasConfig;
      // Configs stored before shield decay or items pin today's defaults now, so a later
      // change of a default cannot change how their logs replay or what their holds get.
      // A missing draw salt is made once here and kept from then on.
      if (
        config.shieldLifetime === undefined ||
        config.items === undefined ||
        config.drawSalt === undefined ||
        config.growth === undefined
      ) {
        config = {
          ...config,
          shieldLifetime: config.shieldLifetime ?? DEFAULT_SHIELD_LIFETIME,
          items: config.items ?? DEFAULT_ITEM_CONFIG,
          drawSalt: config.drawSalt ?? newSalt(),
          growth: config.growth ?? DEFAULT_OPEN_GROWTH,
        };
        sql.exec("UPDATE meta SET value = ? WHERE key = 'config'", JSON.stringify(config));
      }
    } else {
      config = initialConfig();
      sql.exec("INSERT INTO meta (key, value) VALUES ('config', ?)", JSON.stringify(config));
    }
    const { items, drawSalt, growth, ...core } = config;
    this.core = core;
    const baseItems = items ?? DEFAULT_ITEM_CONFIG;
    checkItemConfig(baseItems);
    const baseGrowth = growth ?? DEFAULT_OPEN_GROWTH;
    checkGrowth(baseGrowth);
    createConfigTable(sql);
    this.settings = new ConfigSchedule(sql, { items: baseItems, growth: baseGrowth }, (body) =>
      this.write(body),
    );
    this.salt = parseSalt(drawSalt ?? '');
    if (!env.ITEM_DRAW_KEY) {
      // One event per start; draws then fail closed (see prepareDraws). The deploy workflow
      // checks the secret too (tools/ci/check-secrets.ts).
      opsEvent('error', 'item_draw_key_missing', { canvas: this.canvasName });
    }
    this.copy = readCopyRecord(sql);
    const failures = readSealFailures(sql, Date.now());
    if (failures) this.sealNextAt = failures.lastAt + sealBackoff(failures.count);
    // Restores the latest checkpoint, then replays the rows after it. Without a checkpoint
    // (a new canvas, or a log from before checkpoints) that is the whole log. A damaged
    // checkpoint, or none under a trimmed log, is rebuilt from R2: the newest checkpoint copy
    // that reads back, the log segments after it, then SQLite (restoreBase).
    ctx.blockConcurrencyWhile(async () => {
      const save = (body: () => void) => ctx.storage.transactionSync(body);
      const base = await restoreBase(sql, env.OPLOG, this.prefix, core);
      const grid = base.state;
      let seq = base.seq;
      this.checkpointSeq = seq;
      this.checkpointAt = base.meta?.writtenAt ?? 0;
      // A map that is not a whole number of tiles (never one of ADR 0004's sizes) is played
      // but not published, rather than leaving the canvas unable to start.
      const { size } = grid.config;
      const tiled = size % Math.min(TILE_SIZE, size) === 0;
      if (env.TILES && !tiled) console.error(`CanvasDO: a ${size}² map cannot be cut into tiles`);
      const cdn = env.TILES && tiled ? new CdnPublisher(sql, env.TILES, this.prefix, size) : null;
      if (cdn && cdn.segmentedTo < seq) cdn.skipTo(seq, save);
      // Checkpointed at the grid's seq (or copied with it), then fed the same rows as the grid.
      const teams =
        base.team === undefined
          ? await TeamLedger.restore(sql, size, seq)
          : TeamLedger.fromBody(sql, size, base.team);
      teams.useCredits(this.state.store('team_credit'));
      if (base.repaired && base.meta === null) {
        // Never read again: the replay below ends in a new checkpoint (or none counts). The team
        // checkpoint stored with it goes too: the ledger starts from the base's, and one left
        // at the old seq would greet the next start as a grid and team checkpoint out of step.
        save(() => {
          sql.exec("DELETE FROM meta WHERE key = 'checkpoint'");
          sql.exec('DELETE FROM checkpoint_parts');
          sql.exec("DELETE FROM meta WHERE key = 'team_checkpoint'");
          sql.exec('DELETE FROM team_checkpoint_parts');
        });
      }
      /** Set for the SQLite tail only: its changes seed the tick ring (ADR 0028). */
      let pusher: TickPusher<Rules> | null = null;
      const replay = (row: LogLine) => {
        if (row.seq !== seq + 1) throw new Error(`op log has a gap: ${seq} then ${row.seq}`);
        const diffs = replayRow(grid, row, teams, (at) => this.unreadableWho(at));
        if (cdn && row.seq > cdn.segmentedTo) cdn.note(diffs, row.seq);
        pusher?.note(diffs, row.seq);
        seq = row.seq;
      };
      // Rows trimmed from SQLite after the base: only a recovery has any (restoreBase throws
      // when there is no OPLOG to read them from). A checkpoint every RECOVERY_SEGMENTS
      // segments (or RECOVERY_CHECKPOINT_MS) keeps the progress: if the start runs out of time,
      // the next one takes it as its base (restoreBase) and goes on from there.
      if (base.r2To > seq && env.OPLOG) {
        let segments = 0;
        let since = Date.now();
        for (const segment of await listLogSegments(env.OPLOG, this.prefix, seq, base.r2To)) {
          for (const row of await readLogSegment(env.OPLOG, segment)) {
            if (row.seq > seq && row.seq <= base.r2To) replay(row);
          }
          segments++;
          if (
            seq < base.r2To &&
            (segments % RECOVERY_SEGMENTS === 0 || Date.now() - since >= RECOVERY_CHECKPOINT_MS)
          ) {
            // Flushed to disk before the replay goes on: a start cut short by its time limit
            // resets the object, and only a write that reached storage is progress kept.
            await step('checkpoint during recovery', async () => {
              await this.storeRecovered(grid, seq, teams, Date.now());
              await ctx.storage.sync();
            });
            since = Date.now();
          }
        }
      }
      // Shards that missed the last ticks before a restart get these rows' cells from the ring
      // instead of a snapshot each. Values are read from the grid, so it reads `this.grid`.
      pusher = new TickPusher<Rules>(sql, seq, {
        send: (shard, push) => {
          const { FANOUT } = this.env;
          if (!FANOUT) return Promise.reject(new Error('no FANOUT binding'));
          return FANOUT.get(FANOUT.idFromName(shard)).tick(push);
        },
        grid: () => this.grid,
        rules: () => this.rules(),
        failed: (shard, failures, error) => {
          this.ops.emit('warn', 'canvas_push_failed', {
            canvas: this.canvasName,
            // A FanoutDO name (`{canvas}:fanout-{n}`), never a player's.
            shard,
            failures,
            error: errorText(error),
          });
        },
      });
      for (const row of sql.exec<LogRow>('SELECT * FROM op_log WHERE seq > ? ORDER BY seq', seq)) {
        replay(row);
      }
      this.pusher = pusher;
      if (teams.unsaved) save(() => teams.save());
      if (base.repaired) {
        // A good checkpoint at once, so the next start does not recover again. Failing that,
        // none is counted (seq 0): the next maintenance pass takes one, and nothing is trimmed
        // or shipped past what a stored checkpoint covers until then.
        const now = Date.now();
        const stored = await step('checkpoint after recovery', () =>
          this.storeRecovered(grid, seq, teams, now),
        );
        this.checkpointSeq = stored ? seq : 0;
        this.checkpointAt = stored ? now : 0;
        console.error(
          `CanvasDO: rebuilt the map to seq ${seq} without its stored checkpoint; ` +
            (stored ? 'a new one is stored' : 'storing a new one failed'),
        );
      }
      this.grid = grid;
      this.seq = seq;
      this.cdn = cdn;
      if (cdn) cdn.locks = this.lockAreas();
      this.teams = teams;
      // Started, not awaited: the first ops after a restart usually find the cap read.
      this.refreshCap();
      this.keyframes =
        env.TILES && tiled ? new KeyframeWriter(sql, env.TILES, this.prefix, size) : null;
      const first = sql.exec<{ m: number | null }>('SELECT MIN(seq) AS m FROM op_log').one().m;
      this.trimmedTo = (first ?? seq + 1) - 1;
      const stored = await ctx.storage.getAlarm();
      this.alarmAt = stored === null ? null : stored - alarmDeferral.ms;
      // A season left closing with all its work done (the write that ended it failed and the
      // object restarted) would have nothing due and no alarm: settle it now. Closing work
      // still pending schedules itself below.
      this.settleClosing(Date.now());
      this.schedule(Date.now());
      // Shards that followed before a restart get their first push (cursors start unknown).
      pusher.start();
    });
  }

  /**
   * Applies ops in order, all at logical time `at` (now by default). Each op first reserves a
   * held item of its kind (and, for a brick, its shape); without one it is refused with
   * `no_item`. The item is committed if the core accepts the op and refunded if not.
   * Rejected ops change nothing and are not logged. An op whose (player, opId) was already
   * accepted is a retry: it is answered as a duplicate and never applied or paid for twice.
   */
  async applyBatch(ops: readonly PlayerOp[], at: number = Date.now()): Promise<BatchResult> {
    return this.applyMoves(ops, at);
  }

  /**
   * As applyBatch, for ops and discards together (ADR 0043): a shard relays both in one call.
   * A discard takes the item from the hold (refused `no_item` without one) and is never
   * logged; an accepted one answers `ok` with no diffs. Shards from before this method keep
   * calling applyBatch and discard.
   */
  async applyMoves(moves: readonly PlayerMove[], at: number = Date.now()): Promise<BatchResult> {
    const keys = moves.filter(validMove).map((m) => moveKey(m.player, m.client ?? '', m.opId));
    if (this.shedding(keys)) {
      // Answered now, not queued (ADR 0032). Past the end or paused, that refusal still wins,
      // and a retry of an accepted move is still a duplicate.
      const refused = this.refusedBatch(moves, at);
      if (refused) return refused;
      const results = moves.map((m) => {
        if (!validMove(m)) return INVALID;
        return this.wasAccepted(m.player, m.client ?? '', m.opId) ? DUPLICATE : BUSY;
      });
      return { seq: this.seq, results, holds: new Map(), rules: this.rules() };
    }
    return this.serialMoves(keys, async () => {
      // Past the end or paused: nothing is drawn, reserved or logged (ADR 0021).
      const before = this.refusedBatch(moves, at);
      if (before) return before;
      const players = moves.filter(validMove).map((m) => m.player);
      const drawing = await this.prepareDraws(players, at);
      // Never awaited: a slow KV must not hold up the map (ADR 0020). This batch uses the cap
      // already read, or counts nothing toward teams until one arrives.
      this.refreshCap();
      // Again after the await: maintenance does not wait for this queue, so the season may
      // have started closing (its last seq fixed) meanwhile. Nothing may be logged after it.
      const after = this.refusedBatch(moves, at);
      if (after) return after;
      // Synchronous from here on: nothing else runs between reserving and committing.
      return this.applyNow(moves, at, drawing);
    });
  }

  /**
   * Every op refused with the season's refusal at `at`, or null when ops may go to the rules.
   * A retry of an op accepted before the end is still answered as a duplicate (it was applied),
   * not refused, so the client does not think its move was lost.
   */
  private refusedBatch(moves: readonly PlayerMove[], at: number): BatchResult | null {
    const refused = refusal(this.season, at);
    if (!refused) return null;
    const result: OpResult = { ok: false, reason: refused };
    const results = moves.map((m) =>
      validMove(m) && this.wasAccepted(m.player, m.client ?? '', m.opId) ? DUPLICATE : result,
    );
    return { seq: this.seq, results, holds: new Map(), rules: this.rules() };
  }

  /**
   * The holds of these players at `at` (now by default), with every item that has arrived.
   * None once the season is over: an ended canvas hands out nothing and, once sealed, must not
   * store player ids again (a FanoutDO then stops asking).
   */
  async holds(players: readonly string[], at: number = Date.now()): Promise<Map<string, HoldView>> {
    return this.serial(async () => {
      if (refusal(this.season, at) === 'ended') return new Map<string, HoldView>();
      const valid = players.filter((p) => validIdentity(p, 0));
      const drawing = await this.prepareDraws(valid, at);
      // The season may have closed (or been sealed, its player rows purged) during the await.
      if (refusal(this.season, at) === 'ended') return new Map<string, HoldView>();
      const inventory = this.inventory(at);
      const holds = new Map<string, HoldView>();
      for (const player of valid) holds.set(player, inventory.view(player, at, drawing));
      if (inventory.dirty) this.write(() => inventory.flush());
      return holds;
    });
  }

  /**
   * Throws one held item away to make room (ADR 0012: a full hold stops filling). Deduplicated
   * like an op, by (player, client, opId), in the same transaction as the hold change.
   * `client` comes last so FanoutDOs that predate it keep calling with three arguments.
   */
  async discard(
    player: string,
    opId: number,
    item: Item,
    at: number = Date.now(),
    client = '',
  ): Promise<DiscardReply> {
    const { results, holds } = await this.applyMoves([{ player, client, opId, discard: item }], at);
    const result = results[0]!;
    const hold = holds.get(player) ?? null;
    if (result.ok) {
      return { result: 'duplicate' in result ? { ok: true, duplicate: true } : { ok: true }, hold };
    }
    // A discard is never locked and never refused by the rules: only the discard reasons.
    const reason = result.reason as Extract<DiscardResult, { ok: false }>['reason'];
    return { result: { ok: false, reason }, hold };
  }

  /**
   * The current grid, for FanoutDO's mirror until map tiles exist. About 8 MiB at 2048²,
   * well under the 32 MiB RPC limit; copied so the reply cannot see later ops.
   */
  async snapshot(): Promise<Snapshot> {
    return {
      seq: this.seq,
      cells: this.grid.cells.slice(),
      shields: this.grid.shields.slice(),
      rules: this.rules(),
    };
  }

  /**
   * A snapshot for FanoutDO shard `shard`, which from now on gets a diff tick at most every
   * PUSH_MS while the map changes (ADR 0028). `since` is the seq its open sockets have, when it
   * knows (a tick woke it without its mirror); `changes` then brings them to the snapshot.
   * Called by a shard that has no mirror: on its first socket, or after an eviction.
   */
  async follow(
    shard: string,
    since: number | null = null,
    sockets: number | null = null,
    /** The most recent changed cells the shard wants listed (ADR 0040); absent: none. */
    history: number | null = null,
  ): Promise<FollowReply> {
    const registered = this.mayFollow(shard) && (since === null || Number.isSafeInteger(since));
    const open = Number.isSafeInteger(sockets) && (sockets as number) >= 0 ? sockets : null;
    // Synchronous: the snapshot, the changes, the recent cells and the shard's cursor all
    // stand at this.seq (follow() cuts the ring there).
    const { following, changes } = registered
      ? this.pusher.follow(shard, since, open)
      : { following: false, changes: null };
    const wanted =
      following && Number.isSafeInteger(history) && (history as number) > 0
        ? Math.min(history as number, MAX_RECENT_CELLS)
        : 0;
    const recent = wanted > 0 ? this.pusher.recent(wanted) : null;
    return {
      seq: this.seq,
      cells: this.grid.cells.slice(),
      shields: this.grid.shields.slice(),
      rules: this.rules(),
      following,
      changes,
      ...(recent ? { recent } : {}),
    };
  }

  /** Cuts a tick and pushes it now, without waiting for the timer. For tests. */
  async pushTicks(): Promise<void> {
    this.pusher.pump();
  }

  /**
   * The log's seq, whether `shard` follows this canvas, and the seq its sockets are known to
   * have (ADR 0028): a shard's watchdog asks this, cheaply, to tell a quiet map from a canvas
   * that stopped pushing to it.
   */
  async cursor(
    shard: string,
    /**
     * The shard's sockets as counts (ADR 0030): how many play, and per team. Absent from
     * shards that predate it; a malformed one is ignored.
     */
    report?: unknown,
    now: number = Date.now(),
  ): Promise<{
    readonly seq: number;
    readonly following: boolean;
    readonly acked: number | null;
    readonly backingOff: boolean;
    /**
     * Whether follow() would register the shard: false without the FANOUT binding, for a
     * name that cannot be pushed to, or when every shard slot is taken. Such a shard gets
     * no pushes, so following again would only copy the grid for nothing.
     */
    readonly registrable: boolean;
    /** With a report: everyone playing on the canvas, and the totals of the shard's teams. */
    readonly presence?: PresenceTotals;
  }> {
    const cursor = this.pusher.cursorOf(String(shard));
    const registrable = cursor.following || (this.mayFollow(shard) && this.pusher.hasRoom());
    const counts = readReport(report);
    // Reports are kept by shard name: only names a shard could have.
    const named = typeof shard === 'string' && shard.length > 0 && shard.length <= MAX_SHARD_NAME;
    if (!counts || !named) return { seq: this.seq, ...cursor, registrable };
    this.presence.report(String(shard), counts, now);
    // A changed count reaches the manifest (ADR 0033), even while the map is idle.
    const { cdn } = this;
    if (cdn) {
      cdn.offerStats(this.currentStats(now), now);
      const due = cdn.statsDueAt;
      if (due !== null) this.arm(Math.max(SEGMENT_MS, due - now, this.cdnNextAt - now));
    }
    const presence = this.presence.totals(
      counts.teams.map(([team]) => team),
      now,
    );
    return { seq: this.seq, ...cursor, registrable, presence };
  }

  /**
   * What the game screen shows about the canvas as a whole (ADR 0030), for GET /api/stats:
   * everyone playing (as the shards last reported), the phase and how much of the open area
   * no brick can reach (ADR 0010), and the drop rates of each phase in force now. Counts only.
   */
  async stats(now: number = Date.now()): Promise<CanvasStats> {
    return this.currentStats(now);
  }

  /** stats(), for the manifest too (ADR 0033). Counters only: no scan of the grid. */
  private currentStats(now: number): CanvasStats {
    const { size, open } = this.grid.config;
    const area = open.w * open.h;
    const percent = (cells: number) => (area > 0 ? Math.floor((cells * 100) / area) : 0);
    const { rates } = this.settings.items(now);
    return {
      playing: this.presence.playing(now),
      phase: phaseOf(this.grid),
      filled: percent(blockedCells(this.grid)),
      // What nextOpenArea reads, and its threshold (ADR 0033 amended, 0013).
      built: percent(this.grid.counters.filled),
      growsAt: open.w >= size && open.h >= size ? null : this.settings.growth(now).atPercent,
      rates: { settling: rates.settling, contested: rates.contested, saturated: rates.saturated },
    };
  }

  /**
   * One player's moves on this canvas (ADR 0031), for that player's own profile only: the
   * gateway asks it for the signed-in account. Zeros for nobody known, or once sealed.
   */
  async playerSeason(player: string): Promise<SeasonNumbers> {
    if (!validIdentity(player, 0)) return NO_NUMBERS;
    return readSeasonNumbers(this.state.store('player_season'), player);
  }

  /** Whether a shard of this name can be pushed to (ADR 0028). */
  private mayFollow(shard: unknown): shard is string {
    return (
      this.env.FANOUT !== undefined &&
      typeof shard === 'string' &&
      shard.length > 0 &&
      shard.length <= MAX_SHARD_NAME &&
      // Pushes address shards by name: a shard known only by its id cannot follow.
      !shard.startsWith('id:')
    );
  }

  /** The log's last seq and the current rules, without copying the grid. */
  async status(): Promise<Status> {
    return { seq: this.seq, rules: this.rules() };
  }

  /** Every team's stats on this canvas, live (D1 gets them at most once a minute). */
  async teamStandings(): Promise<Map<number, TeamStats>> {
    return this.teams.all();
  }

  /**
   * Who last wrote a live cell and the team it counted for; null when nobody is known.
   * Internal (ADR 0008): for moderation, never shown to players.
   */
  async lastWriter(x: number, y: number): Promise<Who | null> {
    const { size } = this.grid.config;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size)
      return null;
    return this.teams.writerAt(y * size + x);
  }

  /**
   * Admin config versions (ADR 0022, called by the admin Worker): stores a version of the
   * item config or the growth rule that takes effect at its `effectiveAt` (now, if that has
   * passed). Idempotent for a retried call. Written to SQLite before the reply.
   */
  async scheduleConfig(
    version: ConfigVersion,
    now: number = Date.now(),
  ): Promise<ConfigScheduleResult> {
    return this.serial(async () => {
      const result = this.settings.schedule(version, now);
      // Its rates reach the manifest when it takes effect (ADR 0033).
      if (result.ok && result.version.scope === 'items' && this.cdn) {
        this.arm(Math.max(SEGMENT_MS, result.version.effectiveAt - now));
      }
      return result;
    });
  }

  /** Cancels an admin config version that has not taken effect yet. */
  async cancelConfig(
    scope: ConfigScope,
    version: number,
    now: number = Date.now(),
  ): Promise<CancelResult> {
    return this.serial(async () => this.settings.cancel(scope, version, now));
  }

  /** The item config and growth rule in force at `at`, and every admin version stored. */
  async configState(at: number = Date.now()): Promise<ConfigState> {
    return this.serial(async () => this.settings.state(at));
  }

  /**
   * Grows the open area (ADR 0004: it only grows). The canvas does it by itself at the fill
   * threshold (in applyNow); this call is for admins. The change is written to the op log as
   * its own row, at its place among the ops, so a replay grows the area at the same point
   * (ADR 0013). It changes no cell, but it takes a seq: FanoutDO sees the jump at the next
   * op and resyncs, and the rules come with that op's reply. A rectangle that does not
   * contain the current area, or leaves the map, is refused and changes nothing; the current
   * area again is accepted without a new row.
   */
  async setOpenArea(open: Rect, at: number = Date.now()): Promise<OpenAreaResult> {
    return this.serial(async () =>
      // A season past its end logs nothing more: its last seq is, or is about to be, final.
      refusal(this.season, at) !== 'ended'
        ? this.growOpenArea(open, at)
        : { ok: false, reason: 'invalid' },
    );
  }

  /** The season's schedule, phase and removals (ADR 0021). */
  async seasonStatus(): Promise<SeasonView> {
    const sql = this.ctx.storage.sql;
    return {
      ...this.season,
      seq: this.seq,
      removals: readRemovals(sql),
      rollbacks: readRollbacks(sql),
    };
  }

  /**
   * The dry run of a rollback (ADR 0024): starts a job for `filter` (replacing another one),
   * or moves the current one on, and answers `running` until it has caught up with the log,
   * then what the rollback would do to the map right now. Changes nothing on the map. Admins
   * call it again while it runs; a job nobody asks about for JOB_IDLE_MS is dropped.
   */
  async rollbackPreview(
    filter: RollbackFilter,
    now: number = Date.now(),
    /** Who asks (the admin Worker passes the role): a moderator never replaces an owner's job. */
    by: 'owner' | 'moderator' = 'owner',
  ): Promise<RollbackStatus> {
    const checked = checkFilter(filter, this.grid.config.size);
    if (!checked) return { state: 'failed', job: null, error: 'invalid' };
    if (refusal(this.season, now) === 'ended')
      return { state: 'failed', job: null, error: 'ended' };
    let job = this.rollback;
    if (!job?.matches(checked)) {
      if (job && this.rollbackBy === 'owner' && by !== 'owner') {
        return { state: 'failed', job: null, error: 'busy' };
      }
      // Two more replays beside the live map: refused before anything is allocated when
      // that would pass the budget (live shield layers make every state bigger).
      if (rollbackMemory(this.grid) > this.rollbackLimits.memory) {
        return { state: 'failed', job: null, error: 'too_large' };
      }
      if (readRollbacks(this.ctx.storage.sql).length >= MAX_ROLLBACKS) {
        return { state: 'failed', job: null, error: 'full' };
      }
      const id = crypto.randomUUID();
      // No trimming from here: the job reads SQLite rows after the trimmedTo it starts from.
      this.rollbackStarting++;
      try {
        job = await RollbackJob.start(
          id,
          checked,
          this.jobContext(),
          this.seq,
          this.trimmedTo,
          now,
        );
      } finally {
        this.rollbackStarting--;
      }
      // Another call may have started one meanwhile: the latest request wins.
      this.rollback = job;
      this.rollbackBy = by;
    }
    job.lastUsed = now;
    if (job.error) return { state: 'failed', job: job.id, error: job.error };
    const caught = await job.advance(this.seq);
    if (this.rollback !== job) return { state: 'failed', job: job.id, error: 'replaced' };
    if (job.error) return { state: 'failed', job: job.id, error: job.error };
    if (!caught) return { state: 'running', job: job.id, done: job.done, of: this.seq };
    // Synchronous from here: the rows logged during the awaits, then the comparison.
    try {
      job.catchUp(this.seq);
      return {
        state: 'ready',
        preview: job.build(this.grid, this.seq, this.rollbackLimits).preview,
      };
    } catch (error) {
      return { state: 'failed', job: job.id, error: (error as Error).message };
    }
  }

  /**
   * Applies the rollback previewed as `job`: catches up with what was logged since, builds the
   * restore against the live map at this moment (the preview, if nothing came in between) and
   * logs it in its own row with the writers of its cells, the record that makes it a removal
   * for the seal, in one transaction. Refused past the season's end; allowed while read-only.
   * Not queued behind ops: everything from the last replay to the write is synchronous, so no
   * op can come in between, and ops never wait for a rollback. With `filter`, the job must be
   * for that filter (the admin Worker checks roles on the filter it sends).
   */
  async rollbackApply(
    job: string,
    now: number = Date.now(),
    filter?: RollbackFilter,
  ): Promise<RollbackResult> {
    const current = this.rollback;
    if (!current || current.id !== job) return { ok: false, reason: 'no_job' };
    if (filter !== undefined) {
      const checked = checkFilter(filter, this.grid.config.size);
      if (!checked || !current.matches(checked)) return { ok: false, reason: 'no_job' };
    }
    if (refusal(this.season, now) === 'ended') return { ok: false, reason: 'ended' };
    // Only a job whose preview was ready: the rest of the log is in SQLite.
    if (!current.ready) return { ok: false, reason: 'not_ready' };
    // Synchronous from here to the write.
    let built: ReturnType<RollbackJob['build']>;
    try {
      current.catchUp(this.seq);
      built = current.build(this.grid, this.seq, this.rollbackLimits);
    } catch (error) {
      return { ok: false, reason: 'failed', detail: (error as Error).message };
    }
    const { entry, who, preview } = built;
    // Too many cells or too big a row (SQLite takes 2 MB): nothing is changed.
    if (preview.tooLarge) return { ok: false, reason: 'too_large' };
    // The seal's removals stay bounded (season.ts MAX_REMOVALS); a rollback that records
    // nothing does not count.
    if (preview.window && readRollbacks(this.ctx.storage.sql).length >= MAX_ROLLBACKS) {
      return { ok: false, reason: 'full' };
    }
    const result = entry.cells.length > 0 ? applyEntry(this.grid, entry) : null;
    if (result && !result.ok) {
      // Built from a replay of this very map, so the core must take it: a bug, said loudly.
      console.error('CanvasDO: the core refused a rollback built from its own log');
      return { ok: false, reason: 'failed', detail: 'the core refused the restore' };
    }
    if (result) this.teams.restore(entry, who);
    const seq = result ? this.seq + 1 : this.seq;
    const window = preview.window;
    const { area, player } = current.filter;
    const record: RollbackRecord = {
      seq,
      from: window?.from ?? seq,
      to: window?.to ?? seq,
      ...(area ? { area } : {}),
      ...(player !== undefined ? { player } : {}),
      cells: entry.cells.length,
      appliedAt: now,
    };
    const sql = this.ctx.storage.sql;
    this.write(() => {
      if (result) {
        sql.exec(
          'INSERT INTO op_log (seq, ops, at, who) VALUES (?, ?, ?, ?)',
          seq,
          JSON.stringify([entry]),
          Number.isSafeInteger(now) ? now : 0,
          restoreWhoColumn(who),
        );
        this.teams.save();
      }
      // A rollback whose window holds no op leaves nothing for the seal to remove.
      if (window) writeRollbacks(sql, [...readRollbacks(sql), record]);
    });
    this.seq = seq;
    this.rollback = null;
    if (result) {
      this.cdn?.note(result.diffs, seq);
      // Open sockets get the restored cells with the next tick (ADR 0028).
      this.pusher.note(result.diffs, seq);
      // Spectators get a segment.
      this.armSegment();
    }
    return { ok: true, preview, record };
  }

  /** Drops the rollback being previewed, if any; trimming resumes. */
  async rollbackCancel(): Promise<{ readonly ok: true; readonly dropped: boolean }> {
    const dropped = this.rollback !== null;
    this.rollback = null;
    return { ok: true, dropped };
  }

  /** The area locks (ADR 0024), expired ones included until maintenance drops them. */
  async areaLocks(): Promise<{ readonly rev: number; readonly locks: readonly AreaLock[] }> {
    return { rev: this.locks.rev, locks: this.locks.locks };
  }

  /**
   * Locks an area (ADR 0024): ops touching it are refused with `locked` until `until` (the
   * canvas's logical clock) or an unlock. Not logged: refused ops never reach the log.
   */
  async lockArea(request: LockRequest, now: number = Date.now()): Promise<LockResult> {
    return this.serial(async () => {
      const lock = newLock(this.locks, request, this.grid.config.size, now);
      if (!lock) return { ok: false, reason: 'invalid' };
      const live = activeLocks(this.locks.locks, now);
      if (live.length >= MAX_LOCKS) return { ok: false, reason: 'full' };
      this.setLocks({ rev: this.locks.rev + 1, nextId: lock.id + 1, locks: [...live, lock] });
      return { ok: true, lock, locks: this.locks.locks };
    });
  }

  /** Lifts a lock. */
  async unlockArea(id: number): Promise<UnlockResult> {
    return this.serial(async () => {
      if (!this.locks.locks.some((l) => l.id === id)) return { ok: false, reason: 'not_found' };
      const locks = this.locks.locks.filter((l) => l.id !== id);
      this.setLocks({ ...this.locks, rev: this.locks.rev + 1, locks });
      return { ok: true, locks };
    });
  }

  /** Stores new locks; spectators get them in the next manifest. */
  private setLocks(state: LockState): void {
    this.write(() => writeLocks(this.ctx.storage.sql, state));
    this.locks = state;
    const { cdn } = this;
    if (cdn) {
      cdn.locks = this.lockAreas();
      cdn.oweManifest((body) => this.write(body));
    }
    // A lock takes no seq: the shards get the new rules with the next push (ADR 0028).
    this.pusher.rulesChanged();
    // A segment tick for the manifest, and an alarm at the next lock's end.
    this.schedule(Date.now());
  }

  private jobContext() {
    return {
      sql: this.ctx.storage.sql,
      oplog: this.env.OPLOG ?? null,
      prefix: this.prefix,
      core: this.core,
      ledger: this.teams,
      unreadableWho: (seq: number) => this.unreadableWho(seq),
    };
  }

  /**
   * Sets the season's end or pauses the map: the call lane I's admin area (and its emergency
   * read-only switch) makes. The end is a single timestamp on the canvas's logical clock (ops
   * at or after it are refused with `ended`); it can move while the season is open, never once
   * it is closing. A paused map refuses ops and discards with `read_only` until resumed.
   * Neither is logged: refused ops never reach the log, so a replay never needs them.
   */
  async setSchedule(change: ScheduleChange): Promise<ScheduleResult> {
    return this.serial(async () => {
      // An end at or before the last logged op would put accepted ops after the end.
      const result = changeSchedule(this.season, change, this.grid.clock);
      if (!result.ok) return result;
      this.write(() => writeSeason(this.ctx.storage.sql, result.season));
      this.season = result.season;
      // The end needs an alarm: closing starts from maintenance.
      this.schedule(Date.now());
      return result;
    });
  }

  /**
   * Replaces the moderation removals applied to the sealed archive and the rewritten
   * keyframes (ADR 0021). Accepted until sealing starts (its key is stored before the first
   * archive object is written): a later change would make the next attempt write other
   * objects than the ones already there, which it may never overwrite. With `expected`, only
   * while the list is still exactly that (`stale` otherwise): the admin area adds or drops one
   * removal from the list it read, and two admins at once must not lose each other's change.
   */
  async setRemovals(
    removals: readonly Removal[],
    expected?: readonly Removal[],
  ): Promise<RemovalsResult> {
    return this.serial(async () => {
      if (!validRemovals(removals)) return { ok: false, reason: 'invalid' };
      if (this.season.phase === 'sealed' || this.sealJob || this.sealStarted()) {
        return { ok: false, reason: 'sealed' };
      }
      if (
        expected !== undefined &&
        JSON.stringify(expected) !== JSON.stringify(readRemovals(this.ctx.storage.sql))
      ) {
        return { ok: false, reason: 'stale' };
      }
      this.write(() => writeRemovals(this.ctx.storage.sql, removals));
      return { ok: true };
    });
  }

  /**
   * Seals the archive as soon as the season has ended instead of waiting out ID_RETENTION_MS:
   * for an admin who knows no moderation is pending. Refused while the season is open.
   */
  async requestSeal(): Promise<ScheduleResult> {
    return this.serial(async () => {
      if (this.season.phase === 'open') return { ok: false, reason: 'invalid' };
      if (!this.season.sealRequested) {
        const season = { ...this.season, sealRequested: true };
        this.write(() => writeSeason(this.ctx.storage.sql, season));
        this.season = season;
      }
      this.schedule(Date.now());
      return { ok: true, season: this.season };
    });
  }

  /** setOpenArea's synchronous part, also used by the automatic growth. */
  private growOpenArea(open: Rect, at: number): OpenAreaResult {
    const { x, y, w, h } = open ?? {};
    const entry: OpenAreaEntry = { kind: 'open', x, y, w, h };
    const current = this.grid.config.open;
    if (x === current.x && y === current.y && w === current.w && h === current.h) {
      return { ok: true, seq: this.seq, rules: this.rules() };
    }
    // A refused change leaves the grid untouched, so there is nothing to undo.
    const result = applyEntry(this.grid, entry, at);
    if (!result.ok) return { ok: false, reason: 'invalid' };
    this.write(() => {
      this.ctx.storage.sql.exec(
        'INSERT INTO op_log (seq, ops, at) VALUES (?, ?, ?)',
        this.seq + 1,
        JSON.stringify([entry]),
        Number.isSafeInteger(at) ? at : 0,
      );
    });
    this.seq += 1;
    this.pusher.advance(this.seq);
    // No cell changed, but spectators' manifest must show the new area (an empty segment
    // covers the seq) and the next checkpoint must include it.
    this.armSegment();
    return { ok: true, seq: this.seq, rules: this.rules() };
  }

  private rules(): Rules {
    const { size, open, maxShield } = this.grid.config;
    return {
      mapSize: size,
      open,
      maxShield,
      seq: this.seq,
      locks: this.lockAreas(),
      locksRev: this.locks.rev,
    };
  }

  /**
   * The areas of the stored locks, for display. Expired ones are listed until maintenance drops
   * them (an alarm is set at each end) with a new revision, so two rule sets of the same seq and
   * revision always list the same locks. Ops are refused on their own logical time.
   */
  private lockAreas(): Rect[] {
    return this.locks.locks.map((l) => l.area);
  }

  private applyNow(moves: readonly PlayerMove[], at: number, drawing: boolean): BatchResult {
    const sql = this.ctx.storage.sql;
    const inventory = this.inventory(at);
    const acceptedNow = new Set<string>();
    const holds = new Map<string, HoldView>();
    /** Who each applied op counted for, in log order (the row's `who` column, ADR 0020). */
    const whos: Who[] = [];
    const results = moves.map((move): OpResult => {
      if (!validMove(move)) return INVALID;
      const { player, opId } = move;
      const client = move.client ?? '';
      // JSON keeps the three parts apart whatever characters they hold.
      const key = JSON.stringify([player, client, opId]);
      if (acceptedNow.has(key) || this.wasAccepted(player, client, opId)) return DUPLICATE;
      if ('discard' in move) {
        // Only the hold changes (ADR 0012); nothing reaches the grid or the log.
        const reservation = inventory.reserve(player, move.discard, at);
        if (!reservation) return NO_ITEM;
        inventory.commit(reservation);
        acceptedNow.add(key);
        return DISCARDED;
      }
      const { op } = move;
      // Before the hold is touched: a locked area costs no item (ADR 0024).
      if (isLocked(this.locks.locks, op, at)) return LOCKED;
      const reservation = inventory.reserve(player, itemFor(op), at);
      if (!reservation) return NO_ITEM;
      const result = apply(this.grid, op, at);
      if (result.ok) {
        inventory.commit(reservation);
        acceptedNow.add(key);
        whos.push(this.teams.accept(player, move.team, op, result.diffs, at));
      } else {
        inventory.refund(reservation);
      }
      return result;
    });
    for (const move of moves) {
      const { player } = move;
      if (validMove(move)) holds.set(player, inventory.view(player, at, drawing));
    }
    /** Moves accepted now, ops and discards: remembered, so a retry is a duplicate. */
    const accepted = moves.filter((_, i) => {
      const result = results[i]!;
      return result.ok && !('duplicate' in result);
    });
    /** The ops among them: the log row, the ledger and the season numbers are theirs. */
    const applied = accepted.filter((move): move is PlayerOp => !('discard' in move));
    // Filled up to the threshold: the area grows right after the batch (ADR 0013), as its
    // own log row. nextOpenArea only names an area that contains this one and lies inside
    // the map, so applyEntry accepts it.
    const next = applied.length > 0 ? nextOpenArea(this.grid, this.settings.growth(at)) : null;
    const growth: OpenAreaEntry | null = next ? { kind: 'open', ...next } : null;
    if (growth) applyEntry(this.grid, growth, at);
    if (accepted.length > 0 || inventory.dirty) {
      // One transaction: the ops, their dedupe keys, the items they used and the growth they
      // set off become durable together, or none of them does.
      this.write(() => {
        if (applied.length > 0) {
          sql.exec(
            'INSERT INTO op_log (seq, ops, at, who) VALUES (?, ?, ?, ?)',
            this.seq + 1,
            JSON.stringify(applied.map(({ op }) => op)),
            at,
            JSON.stringify(whos),
          );
          this.teams.save();
          countMoves(this.state.store('player_season'), applied, at);
        }
        this.remember(accepted);
        if (growth) {
          sql.exec(
            'INSERT INTO op_log (seq, ops, at) VALUES (?, ?, ?)',
            this.seq + 2,
            JSON.stringify([growth]),
            at,
          );
        }
        inventory.flush();
      });
      if (applied.length > 0) {
        this.seq += 1;
        for (const result of results) {
          if (!result.ok || 'duplicate' in result) continue;
          this.cdn?.note(result.diffs, this.seq);
          this.pusher.note(result.diffs, this.seq);
        }
        // Spectators get the change in the next segment.
        this.armSegment();
      }
    }
    if (growth) {
      // The batch keeps its seq for its diffs; the growth row takes the next one.
      const batchSeq = this.seq;
      this.seq += 1;
      this.pusher.advance(this.seq);
      return { seq: batchSeq, grewAt: this.seq, results, holds, rules: this.rules() };
    }
    return { seq: this.seq, results, holds, rules: this.rules() };
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    await this.tick();
  }

  /**
   * Run by the alarm while there is work, on two cadences. Every SEGMENT_MS while the map
   * changes: the diff segment and the manifest, so spectators stay a few seconds behind. Every
   * MAINTAIN_MS at most: a checkpoint once CHECKPOINT_MS of activity has passed, log shipping
   * up to the checkpoint and only then trimming, tiles, garbage. Each step that fails is logged
   * and retried later; none can lose an accepted op.
   * Public for tests, which pass `now`; ticks never overlap.
   */
  async tick(now: number = Date.now()): Promise<void> {
    const run = this.ticking.then(() => this.runTick(now));
    this.ticking = run.catch(() => undefined);
    return run;
  }

  /** Starts a read of the daily team cap when it is due; never waits for it. */
  private refreshCap(): void {
    this.teams.refreshCap(this.env.MODERATION, Date.now()).catch((error: unknown) => {
      console.error('CanvasDO: team cap refresh failed', error);
    });
  }

  private async runTick(now: number): Promise<void> {
    const save = (body: () => void) => this.ctx.storage.transactionSync(body);
    const { cdn } = this;
    this.refreshCap();
    // Wall clock, not `now` (tests pass logical times): how long this tick held the object.
    const started = Date.now();
    let maintained = false;
    try {
      // The stats the next manifest carries, and whether they owe one on their own (ADR 0033).
      cdn?.offerStats(this.currentStats(now), now);
      if (cdn && now >= this.cdnNextAt) {
        // Before the uploads: an op accepted while they run asks for the next segment
        // SEGMENT_MS after this one, not for another at once (a failure sets its backoff).
        // A tick with nothing to write (maintenance, stale presence) holds nothing back.
        if (this.seq > cdn.segmentedTo || cdn.segmentWaiting || cdn.resyncPending) {
          this.segmentAfter = Math.max(this.segmentAfter, started + SEGMENT_MS);
        }
        this.cdnResult(
          now,
          await step('diff segment', async () => {
            // Synchronous take: the segment holds the grid's values at this seq.
            const segment = cdn.takeSegment(this.grid, this.seq);
            if (segment) await cdn.writeSegment(segment, now, save);
            // A resync (from this segment or a restart) republishes every tile before the
            // next manifest, whatever the cadence: no manifest may name the new seq first.
            if (cdn.resyncPending) await cdn.publishTiles(this.grid, () => this.seq, now, save);
            await cdn.writeManifest(this.grid, now, save);
          }),
        );
      }
      if (now - this.maintainedAt >= MAINTAIN_MS) {
        this.maintainedAt = now;
        maintained = true;
        await this.maintain(now, save);
      }
      // After any tick, not only maintenance: the CDN may catch up in a segment tick.
      this.settleClosing(now);
    } finally {
      this.schedule(now);
      const ms = Date.now() - started;
      // Longer than a segment interval: segments (and spectators) fall behind.
      if (ms > this.tickSlowMs) {
        this.ops.emit('warn', 'canvas_tick_slow', { canvas: this.canvasName, ms, maintained });
      }
    }
  }

  private async maintain(now: number, save: (body: () => void) => void): Promise<void> {
    const sql = this.ctx.storage.sql;
    const { cdn } = this;
    // The shards' cursors, so a restart still knows what their sockets have (ADR 0028): a
    // shard evicted meanwhile is then repaired instead of having its sockets closed.
    save(() => this.pusher.saveCursors());
    // Past the end, the season starts closing: its last seq is fixed and every later op is
    // refused (ADR 0021). Checked here, on wall-clock time, so a canvas nobody plays still
    // closes; ops are refused on their own logical time even before this runs.
    const { endsAt } = this.season;
    if (this.season.phase === 'open' && endsAt !== null && now >= endsAt) {
      this.setSeason({ ...this.season, phase: 'closing', finalSeq: this.seq });
    }
    // A rollback cannot be applied once the season closes, nor after nobody asked for a while.
    if (
      this.rollback &&
      (this.season.phase !== 'open' || now - this.rollback.lastUsed >= JOB_IDLE_MS)
    ) {
      this.rollback = null;
    }
    this.expireLocks(now);
    const closing = this.season.phase === 'closing';
    // The player rows changed since the last fold reach their tables, each written once
    // (ADR 0042); a closing season's at once, before the seal empties them.
    if (this.state.unfoldedRows && (closing || now - this.foldedAt >= STATE_FOLD_MS)) {
      // A write, so a failed fold restarts the object rather than leave memory ahead.
      this.write(() => this.state.fold());
      this.foldedAt = now;
    }
    const seq = this.seq;
    // Taken whatever happened to the segments: the public CDN must never hold up the log. A
    // restart that finds the checkpoint past the last segment republishes every tile. A closing
    // season takes its final checkpoint at once.
    if (seq > this.checkpointSeq && (closing || now - this.checkpointAt >= CHECKPOINT_MS)) {
      const encoded = encodeCheckpoint(this.grid);
      const hash = gridHash(this.grid);
      const { clock } = this.grid;
      await step('checkpoint', async () => {
        // Before the first await, so still the same synchronous step and the same seq: the
        // team ledger becomes current with the grid.
        const teams = this.teams.encode();
        const prepared = await prepareCheckpoint(hash, encoded, seq, now, clock);
        const commitTeams = await this.teams.stage(seq, teams, save);
        await storeCheckpoint(sql, prepared, save, undefined, commitTeams);
        this.checkpointSeq = seq;
        this.checkpointAt = now;
      });
    }
    const { OPLOG } = this.env;
    let shipped = 0;
    if (OPLOG) {
      shipped = shippedTo(sql);
      if (shipped < this.checkpointSeq && now >= this.shipNextAt) {
        const ok = await step('log shipping', async () => {
          shipped = await shipLog(sql, OPLOG, this.prefix, this.checkpointSeq, save);
        });
        // A segment that keeps failing (R2 down, or an object that does not match the log)
        // is retried less and less often, up to hourly, instead of every pass forever.
        this.shipBackoff = ok
          ? 0
          : Math.min(MAX_SHIP_BACKOFF, Math.max(MAINTAIN_MS, this.shipBackoff * 2));
        this.shipNextAt = ok ? 0 : now + this.shipBackoff;
      }
      await this.maintainCopies(OPLOG, now, save);
    }
    // Only rows that are both in the checkpoint and in R2 may go, and none while a rollback is
    // being computed: it reads the rows after its start from SQLite (ADR 0024).
    const trimTo = Math.min(this.checkpointSeq, shipped);
    if (trimTo > this.trimmedTo && !this.rollback && this.rollbackStarting === 0) {
      save(() => sql.exec('DELETE FROM op_log WHERE seq <= ?', trimTo));
      this.trimmedTo = trimTo;
    }
    const { STANDINGS } = this.env;
    const standingsAt = this.teams.publishDueAt();
    if (STANDINGS && standingsAt !== null && now >= standingsAt) {
      await step('team standings', () => this.teams.publish(STANDINGS, this.canvasName, now));
    }
    if (cdn && now >= this.cdnNextAt) {
      this.cdnResult(
        now,
        await step('tiles', async () => {
          await cdn.publishTiles(this.grid, () => this.seq, now, save);
          await cdn.publishOverview(this.grid, () => this.seq, now, save);
          await cdn.writeManifest(this.grid, now, save);
          await cdn.collect(now, save);
        }),
      );
    }
    await this.maintainKeyframes(now, save);
    await this.maintainSeason(now, save);
  }

  /**
   * Stores a checkpoint of a map rebuilt at start-up (restoreBase), the team ledger staged with
   * it so both become current together, its new writers saved first. Throws on failure.
   */
  private async storeRecovered(
    grid: State,
    seq: number,
    teams: TeamLedger,
    now: number,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    const save = (body: () => void) => this.ctx.storage.transactionSync(body);
    if (teams.unsaved) save(() => teams.save());
    const encoded = encodeCheckpoint(grid);
    const hash = gridHash(grid);
    const body = teams.encode();
    const prepared = await prepareCheckpoint(hash, encoded, seq, now, grid.clock);
    const commitTeams = await teams.stage(seq, body, save);
    await storeCheckpoint(sql, prepared, save, undefined, commitTeams);
  }

  /**
   * Copies the stored checkpoint to OPLOG when it is newer than the last copy and that copy is
   * COPY_MS old, or at once while the season closes (its final checkpoint). None once the
   * season has ended: nothing changes any more, and the seal deletes them all (copies.ts).
   */
  private async maintainCopies(
    oplog: R2Bucket,
    now: number,
    save: (body: () => void) => void,
  ): Promise<void> {
    const due = this.copyDueAt();
    if (due === null || now < due) return;
    const ok = await step('checkpoint copy', async () => {
      this.copy = await copyCheckpoint(this.ctx.storage.sql, oplog, this.prefix, now, save);
    });
    this.copyBackoff = ok
      ? 0
      : Math.min(MAX_SHIP_BACKOFF, Math.max(MAINTAIN_MS, this.copyBackoff * 2));
    this.copyNextAt = ok ? 0 : now + this.copyBackoff;
  }

  /** When the next checkpoint copy is due (tick time, ms), or null when none is. */
  private copyDueAt(): number | null {
    const { phase } = this.season;
    if (!this.env.OPLOG || (phase !== 'open' && phase !== 'closing')) return null;
    if (this.checkpointSeq <= (this.copy?.seq ?? 0)) return null;
    const at = phase === 'closing' || !this.copy ? 0 : this.copy.writtenAt + COPY_MS;
    return Math.max(at, this.copyNextAt);
  }

  /** Cuts a keyframe when one is due (KEYFRAME_MS), and the final one once the season closes. */
  private async maintainKeyframes(now: number, save: (body: () => void) => void): Promise<void> {
    const { keyframes } = this;
    if (!keyframes || now < this.keyframeNextAt) return;
    const closing = this.season.phase === 'closing';
    const due = keyframes.dueAt(this.seq);
    const final = closing && !keyframes.final;
    if (!final && (due === null || now < due) && !keyframes.indexOwed) return;
    const ok = await step('keyframe', async () => {
      if (final || (due !== null && now >= due)) {
        await keyframes.cut(this.grid, this.seq, now, save, final);
      } else {
        await keyframes.writeIndex(save);
      }
    });
    this.keyframeNextAt = ok ? 0 : now + MAX_CDN_BACKOFF;
  }

  /**
   * Moves a closed season on (ADR 0021). Closing ends once the final checkpoint, the log in
   * OPLOG, the CDN and the final keyframe all reach the last seq. The archive is sealed
   * ID_RETENTION_MS after the end (or when an admin asks), a few segments per pass; then the
   * tables holding player ids are emptied.
   */
  private async maintainSeason(now: number, save: (body: () => void) => void): Promise<void> {
    const sql = this.ctx.storage.sql;
    const { season, keyframes } = this;
    if (season.phase !== 'ended' || !this.sealDue(now) || now < this.sealNextAt) return;
    const { OPLOG } = this.env;
    let key = sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seal_key'")
      .toArray()[0]?.value;
    if (!key) {
      key = newPseudonymKey();
      const value = key;
      save(() => sql.exec("INSERT INTO meta (key, value) VALUES ('seal_key', ?)", value));
    }
    // A holder, not a `let`: assigned inside the step's callback.
    const sealed = { archive: false };
    if (OPLOG) {
      const pseudonymKey = key;
      const failure: { error?: unknown } = {};
      const ok = await step(
        'archive seal',
        async () => {
          // A seal that wrote season.json but stopped before purging (a restart, a failed
          // delete) only has the raw segments it replaced left to delete.
          if (!this.sealJob && (await archiveComplete(OPLOG, this.prefix))) {
            await deleteStrippedRaw(OPLOG, this.prefix);
            await deleteCopies(OPLOG, this.prefix);
            sealed.archive = true;
            return;
          }
          // Archive-only removals made while the season was open may name seqs past its end:
          // one that starts after the last seq covers nothing and is dropped, the others end at
          // it at most, so season.json never names a seq that did not exist (ADR 0022).
          const last = season.finalSeq ?? this.seq;
          const archiveOnly = readRemovals(sql)
            .filter((r) => r.from <= last)
            .map((r) => (r.to > last ? { ...r, to: last } : r));
          this.sealJob ??= new SealJob({
            oplog: OPLOG,
            tiles: this.env.TILES ?? null,
            keyframes,
            sql,
            prefix: this.prefix,
            core: this.core,
            endsAt: season.endsAt,
            finalSeq: season.finalSeq ?? this.seq,
            finalHash: gridHash(this.grid),
            // Every rollback's ops (ADR 0024; logged, so within the log), then the archive-only
            // removals that cover any seq.
            removals: [
              ...readRollbacks(sql).map((r) => removalOf(r, this.grid.config.size)),
              ...archiveOnly,
            ],
            rollbacksOnly: archiveOnly.length === 0,
            pseudonymKey,
            save,
            segmentsPerStep: this.sealSegmentsPerStep,
            unreadableWho: (seq) => this.unreadableWho(seq),
          });
          if (await this.sealJob.step()) {
            await this.sealJob.finish(now);
            // Checkpoint copies go with the season's ids: their writer ids resolve to players
            // through `writers` until the purge below, and a sealed canvas, which takes no op,
            // keeps its own final checkpoint.
            await deleteCopies(OPLOG, this.prefix);
            sealed.archive = true;
          }
        },
        failure,
      );
      // A failed step starts over later, less and less often (an object that does not match
      // waits for a person); what it already wrote is found and kept. Every failure is an
      // alert-worthy event: until the seal goes through, player ids outlive ADR 0008's 90 days.
      // A good step that has not finished keeps the count: a seal that fails on a late step
      // must still climb to `archive_seal_stuck`. Only the completed seal clears it (below).
      if (ok) {
        this.sealNextAt = 0;
      } else {
        this.sealJob = null;
        this.sealNextAt = this.sealFailed(now, failure.error);
      }
      if (!sealed.archive) return;
    } else {
      opsEvent('error', 'archive_seal_no_bucket', { canvas: this.canvasName });
    }
    // A step like the seal's: a purge that throws (a damaged row) is a seal failure, counted,
    // alerted and retried, never an uncounted error or one whose text quotes the row's ids.
    const purgeFailure: { error?: unknown } = {};
    const purged = await step(
      'archive purge',
      () => this.purgeSealed(key, now, save),
      purgeFailure,
    );
    if (!purged) {
      this.sealJob = null;
      this.sealNextAt = this.sealFailed(now, purgeFailure.error);
      return;
    }
    opsEvent('info', 'archive_sealed', { canvas: this.canvasName, sealedAt: now });
  }

  /**
   * Empties the tables holding player ids once the archive is sealed (or, without OPLOG, at
   * once) and marks the canvas sealed, in one transaction at the end.
   */
  private async purgeSealed(
    key: string,
    now: number,
    save: (body: () => void) => void,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    const { OPLOG } = this.env;
    // Rows already in R2 and the checkpoint (closing waited for both) go: one left in SQLite
    // would only keep what the archive replaced. Without OPLOG the rows are the only log; their
    // `who` gets the archive's pseudonyms instead.
    const upTo = OPLOG
      ? Math.min(this.season.finalSeq ?? this.seq, this.checkpointSeq, shippedTo(sql))
      : 0;
    const names = new Pseudonyms(key);
    const tail = (await renamedLogTail(sql, names)).filter((r) => r.seq > upTo);
    // Rollbacks and removals by player name them too (ADR 0024): they get the archive's
    // pseudonyms.
    const rename = <T extends { readonly player?: string }>(list: readonly T[]) =>
      Promise.all(
        list.map(async (r) =>
          r.player === undefined ? r : { ...r, player: await names.of(r.player) },
        ),
      );
    const rollbacks = await rename(readRollbacks(sql));
    const removals = await rename(readRemovals(sql));
    // The pseudonym key goes with the player ids: afterwards no one can link a pseudonym to them.
    save(() => {
      if (upTo > 0) sql.exec('DELETE FROM op_log WHERE seq <= ?', upTo);
      purgePlayerData(sql, tail);
      // The journal went with the player tables (ADR 0042); memory forgets it below, once
      // this transaction went through.
      this.state.resetStorage();
      if (rollbacks.length > 0) writeRollbacks(sql, rollbacks);
      if (removals.length > 0) writeRemovals(sql, removals);
      // Lock notes are a moderator's free text, which may name a player; a sealed canvas takes
      // no op, so its locks have nothing left to do.
      sql.exec("DELETE FROM meta WHERE key = 'locks'");
      // Deleted from OPLOG above.
      sql.exec("DELETE FROM meta WHERE key = 'checkpoint_copy'");
      sql.exec("DELETE FROM meta WHERE key = 'seal_key'");
      sql.exec("DELETE FROM meta WHERE key = 'seal_failures'");
      writeSeason(sql, { ...this.season, phase: 'sealed', sealedAt: now });
      // The timelapse learns it from the keyframe index, which the next pass rewrites.
      this.keyframes?.markSealed();
    });
    this.season = { ...this.season, phase: 'sealed', sealedAt: now };
    this.state.forget();
    this.locks = readLocks(sql);
    this.copy = null;
    this.sealJob = null;
  }

  /**
   * Records a failed seal attempt (meta `seal_failures`, so the count and the backoff survive an
   * eviction between attempts) and logs `archive_seal_failed`, plus `archive_seal_stuck` from
   * the SEAL_STUCK_AFTER-th failure on. Neither carries a player id: the canvas, the attempt
   * count, the times and the error (object keys at most; a SyntaxError by name only). Returns
   * when to try again.
   */
  private sealFailed(now: number, error: unknown): number {
    const sql = this.ctx.storage.sql;
    const before = readSealFailures(sql, now);
    const failures: SealFailures = {
      count: (before?.count ?? 0) + 1,
      firstAt: before?.firstAt ?? now,
      lastAt: now,
    };
    this.write(() =>
      sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('seal_failures', ?)",
        JSON.stringify(failures),
      ),
    );
    const retryAt = now + sealBackoff(failures.count);
    const fields = {
      canvas: this.canvasName,
      attempt: failures.count,
      failingForMs: now - failures.firstAt,
      // How long player ids have outlived the retention period (0 for a seal an admin asked
      // for early, before that period ended).
      overdueMs: Math.max(0, now - this.retentionEndsAt(now)),
      retryInMs: retryAt - now,
      error: errorText(error),
    };
    opsEvent('error', 'archive_seal_failed', fields);
    if (failures.count >= this.sealStuckAfter) opsEvent('error', 'archive_seal_stuck', fields);
    return retryAt;
  }

  /** When ADR 0008's retention of player ids ends for this season (tick time, ms). */
  private retentionEndsAt(now: number): number {
    const { endsAt, endedAt } = this.season;
    return (endsAt ?? endedAt ?? now) + ID_RETENTION_MS;
  }

  /**
   * Ends closing once the final checkpoint, the log in OPLOG, the CDN and the final keyframe
   * all reach the last seq. Run after every tick, so whichever cadence finishes last ends it.
   */
  private settleClosing(now: number): void {
    const { season, cdn, keyframes } = this;
    if (season.phase !== 'closing') return;
    const finalSeq = season.finalSeq ?? this.seq;
    const done =
      this.checkpointSeq >= finalSeq &&
      (!this.env.OPLOG || shippedTo(this.ctx.storage.sql) >= finalSeq) &&
      // The final checkpoint's copy: no copy is taken once the season has ended.
      (!this.env.OPLOG || (this.copy?.seq ?? 0) >= finalSeq) &&
      (!cdn || (!cdn.busy && !cdn.resyncPending && cdn.segmentedTo >= finalSeq)) &&
      (!keyframes || (keyframes.final && !keyframes.indexOwed));
    if (done) this.setSeason({ ...season, phase: 'ended', endedAt: now });
  }

  /** Sealing has written (or is about to write) archive objects: meta holds its key. */
  private sealStarted(): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM meta WHERE key = 'seal_key'").toArray().length > 0
    );
  }

  private sealDue(now: number): boolean {
    const { endsAt, endedAt, sealRequested } = this.season;
    return sealRequested || now >= (endsAt ?? endedAt ?? now) + ID_RETENTION_MS;
  }

  private setSeason(season: SeasonState): void {
    this.write(() => writeSeason(this.ctx.storage.sql, season));
    this.season = season;
  }

  /**
   * Drops the locks whose end has passed (`now`, tick time) so the rules and the manifest stop
   * listing them. Ops are refused on their own logical time either way.
   */
  private expireLocks(now: number): void {
    const live = activeLocks(this.locks.locks, now);
    if (live.length === this.locks.locks.length) return;
    this.setLocks({ ...this.locks, rev: this.locks.rev + 1, locks: live });
  }

  /**
   * Backs the public bucket's work off after a failure, doubling from SEGMENT_MS up to
   * MAX_CDN_BACKOFF, so an outage does not keep an alarm firing every SEGMENT_MS forever.
   */
  private cdnResult(now: number, ok: boolean): void {
    this.cdnBackoff = ok ? 0 : Math.min(MAX_CDN_BACKOFF, Math.max(SEGMENT_MS, this.cdnBackoff * 2));
    this.cdnNextAt = ok ? 0 : now + this.cdnBackoff;
    // The same wait on the wall clock, for armSegment: ops do not call ticks into a backoff.
    if (!ok) this.segmentAfter = Math.max(this.segmentAfter, Date.now() + this.cdnBackoff);
  }

  /**
   * Asks for the tick that cuts the next diff segment (ADR 0014): at once after a quiet spell,
   * else once SEGMENT_MS has passed since the last one, so segments stay at most one per
   * SEGMENT_MS. Without a public bucket only the checkpoint waits: the next maintenance pass.
   */
  private armSegment(): void {
    if (this.cdn) this.arm(Math.max(0, this.segmentAfter - Date.now()));
    else this.arm(MAINTAIN_MS);
  }

  /**
   * Schedules the next tick for the earliest pending work: SEGMENT_MS while changes wait for a
   * segment; the next maintenance pass for a checkpoint, tiles, log shipping (in backoff) or
   * garbage, each when it falls due; nothing when idle.
   */
  private schedule(now: number): void {
    const { cdn } = this;
    const waits: number[] = [];
    if (cdn && (this.seq > cdn.segmentedTo || cdn.segmentWaiting || cdn.resyncPending)) {
      waits.push(Math.max(SEGMENT_MS, this.cdnNextAt - now));
    }
    if (cdn) {
      // Stats the manifest lacks, once they may go out on their own; and the next shard
      // report to go stale, so the count falls back once a shard stops reporting (ADR 0033).
      const stats = cdn.statsDueAt;
      if (stats !== null) waits.push(Math.max(SEGMENT_MS, stats - now, this.cdnNextAt - now));
      const stale = this.presence.staleAt();
      if (stale !== null) waits.push(stale - now);
      // And the next item config, whose rates it shows.
      const rates = this.settings.nextItemsAt(now);
      if (rates !== null) waits.push(rates - now);
    }
    const due: number[] = [];
    if (this.seq > this.checkpointSeq) due.push(this.checkpointAt + CHECKPOINT_MS);
    if (this.state.unfoldedRows) due.push(this.foldedAt + STATE_FOLD_MS);
    if (cdn?.tilesWaiting) due.push(Math.max(now, this.cdnNextAt));
    if (this.env.OPLOG && this.trimmedTo < this.checkpointSeq) due.push(this.shipNextAt);
    // The last checkpoint of a burst of activity is copied within COPY_MS, idle or not.
    const copy = this.copyDueAt();
    if (copy !== null) due.push(copy);
    const garbage = cdn?.garbageDueAt ?? null;
    if (garbage !== null) due.push(garbage);
    const standings = this.env.STANDINGS ? this.teams.publishDueAt() : null;
    if (standings !== null) due.push(standings);
    const keyframe = this.keyframes?.dueAt(this.seq) ?? null;
    if (keyframe !== null) due.push(Math.max(keyframe, this.keyframeNextAt));
    if (this.keyframes?.indexOwed) due.push(this.keyframeNextAt);
    if (this.season.phase === 'closing' && this.keyframes && !this.keyframes.final) {
      due.push(Math.max(now, this.keyframeNextAt));
    }
    const season = this.seasonDueAt(now);
    if (season !== null) due.push(season);
    // A lock's end, so its expiry reaches the manifest and the next rules.
    for (const { until } of this.locks.locks) if (until !== null) due.push(until);
    // A rollback job nobody asks about is dropped (and trimming resumes) at its deadline.
    if (this.rollback) due.push(this.rollback.lastUsed + JOB_IDLE_MS);
    if (due.length > 0) {
      waits.push(Math.max(Math.min(...due), this.maintainedAt + MAINTAIN_MS) - now);
    }
    if (waits.length > 0) this.arm(Math.min(MAX_WAIT, Math.max(MIN_WAIT, Math.min(...waits))));
  }

  /** When the season next needs maintenance (tick time, ms), or null when it never will. */
  private seasonDueAt(now: number): number | null {
    const { phase, endsAt, endedAt, sealRequested } = this.season;
    if (phase === 'open') return endsAt;
    // Closing waits on work that schedules itself (checkpoint, shipping, CDN, the final
    // keyframe), each with its own backoff; settleClosing runs after each of those ticks.
    if (phase === 'closing') return null;
    if (phase === 'ended') {
      const due = sealRequested ? now : (endsAt ?? endedAt ?? now) + ID_RETENTION_MS;
      return Math.max(due, this.sealNextAt);
    }
    return null;
  }

  /**
   * Schedules a tick `delay` ms from now, unless one is already due by then. One overdue by
   * LOST_ALARM_MS (restored at start-up from a getAlarm() that outlived its retries) does not
   * count.
   */
  private arm(delay: number): void {
    const now = Date.now();
    const at = now + delay;
    const { alarmAt } = this;
    if (alarmAt !== null && alarmAt <= at && now - alarmAt < LOST_ALARM_MS) return;
    this.alarmAt = at;
    this.ctx.storage.setAlarm(at + alarmDeferral.ms).catch((error: unknown) => {
      this.alarmAt = null;
      console.error('CanvasDO: could not schedule maintenance', error);
    });
  }

  /**
   * Runs one write transaction. If it fails, memory may already hold changes the storage does
   * not: restart from storage so the two can never disagree.
   */
  private write(body: () => void): void {
    try {
      this.ctx.storage.transactionSync(() => {
        body();
        // What the write changed of the player state, as one journal row (ADR 0042).
        this.state.commit();
      });
    } catch (error) {
      this.ctx.abort('canvas write failed');
      throw error;
    }
  }

  /** Remembers accepted moves for retries, in the journal row of the write under way. */
  private remember(keys: readonly { player: string; client?: string; opId: number }[]): void {
    for (const { player, client, opId } of keys) {
      this.state.accept(moveKey(player, client ?? '', opId));
    }
  }

  /** The holds of one call at `at`, under the item config in force then. */
  private inventory(at: number): InventoryBatch {
    const items = this.settings.items(at);
    const words = (player: string, index: number) => {
      const key = `${index}:${player}`;
      const found = this.words.get(key);
      this.words.delete(key);
      return found;
    };
    const history = (version: number) => this.settings.itemsHistory(version, at);
    return new InventoryBatch(this.state.store('inventory'), items, this.grid, words, history);
  }

  /**
   * Computes the PRF words of every draw these players are due at `at`. Returns false, and
   * draws nothing, when the ITEM_DRAW_KEY secret is missing: never a guessable fallback.
   */
  private async prepareDraws(players: readonly string[], at: number): Promise<boolean> {
    this.drawKey ??= importDrawKey(this.env.ITEM_DRAW_KEY);
    const key = await this.drawKey;
    // Said once per start by `item_draw_key_missing` (constructor).
    if (!key) return false;
    if (this.words.size > MAX_CACHED_WORDS) this.words.clear();
    const holds = this.state.store('inventory');
    const jobs: Promise<void>[] = [];
    for (const player of new Set(players)) {
      const history = (version: number) => this.settings.itemsHistory(version, at);
      const items = this.settings.items(at);
      for (const index of InventoryBatch.needed(holds, items, player, at, history)) {
        const id = `${index}:${player}`;
        if (this.words.has(id)) continue;
        jobs.push(
          drawWords(key, this.salt, player, index).then((words) => {
            this.words.set(id, words);
          }),
        );
      }
    }
    await Promise.all(jobs);
    return true;
  }

  /**
   * Whether new ops and discards with these moveKeys are refused `busy` (ADR 0032): QUEUE_SHED
   * calls already wait, and none of them is a retry of a move still in the queue (answered
   * `busy`, it could still be applied by the call before it). Logs `canvas_shedding`, sampled
   * like `canvas_queue_deep`.
   */
  private shedding(keys: readonly string[]): boolean {
    if (this.queued < QUEUE_SHED) return false;
    if (keys.some((key) => this.queuedMoves.has(key))) return false;
    this.ops.emit('warn', 'canvas_shedding', { canvas: this.canvasName, depth: this.queued });
    return true;
  }

  /** As serial, for ops and discards: their moveKeys count as queued until the task ends. */
  private serialMoves<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
    for (const key of keys) this.queuedMoves.set(key, (this.queuedMoves.get(key) ?? 0) + 1);
    return this.serial(task).finally(() => {
      for (const key of keys) {
        const left = (this.queuedMoves.get(key) ?? 1) - 1;
        if (left > 0) this.queuedMoves.set(key, left);
        else this.queuedMoves.delete(key);
      }
    });
  }

  /** Runs tasks one at a time, in call order; a failed task does not stop the next. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    this.queued++;
    if (this.queued >= QUEUE_DEEP) {
      this.ops.emit('warn', 'canvas_queue_deep', { canvas: this.canvasName, depth: this.queued });
    }
    const run = this.queue.then(task).finally(() => {
      this.queued--;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * A log row whose `who` cannot be read (teams.ts parseWho): its ops count for nobody in the
   * ledger, a rollback by player cannot match them, and the seal names nobody for them. Sampled;
   * the seq only, never the value (it holds player ids).
   */
  private unreadableWho(seq: number): void {
    this.ops.emit('error', 'who_unreadable', { canvas: this.canvasName, seq });
  }

  private wasAccepted(player: string, client: string, opId: number): boolean {
    return this.state.accepted(moveKey(player, client, opId), player, client, opId);
  }
}

/**
 * Applies one op_log row to the grid and returns the cells it changed. The one place that
 * knows how a row replays: restore uses it, and log shipping copies rows without reading them.
 */
function replayRow(
  grid: State,
  row: LogLine,
  teams: TeamLedger,
  unreadableWho?: (seq: number) => void,
): CellDiff[] {
  const diffs: CellDiff[] = [];
  // A row holds the accepted ops of one batch, or one open-area change (setOpenArea).
  const entries = JSON.parse(row.ops) as LogEntry[];
  // A restore row's `who` has its own shape (parseRestoreWho below).
  const whos =
    entries[0]?.kind === 'restore'
      ? []
      : parseWho(row.who, entries.length, () => unreadableWho?.(row.seq));
  for (const [i, entry] of entries.entries()) {
    const result = applyEntry(grid, entry, row.at);
    if (!result.ok) continue;
    diffs.push(...result.diffs);
    // A restore row (ADR 0024) carries its cells' writers in a `who` of its own.
    if (entry.kind === 'restore')
      teams.restore(entry, parseRestoreWho(row.who, entry.cells.length));
    else teams.record(entry, result.diffs, whos[i]!);
  }
  return diffs;
}

/** Where a start replays the log from: a grid state at a seq, and how to reach the log tail. */
interface Base {
  readonly state: State;
  readonly seq: number;
  /** The stored checkpoint the state comes from, if it does. */
  readonly meta: CheckpointMeta | null;
  /**
   * The team checkpoint body to start the ledger from (null: an empty ledger); absent: the one
   * stored with the grid checkpoint at `seq`.
   */
  readonly team?: Uint8Array | null;
  /** Rows after `seq` up to here are no longer in SQLite: they are read from R2's segments. */
  readonly r2To: number;
  /** The stored checkpoint was not usable: a new one must be stored once the log is replayed. */
  readonly repaired: boolean;
}

/**
 * The start's base. Normally the stored checkpoint (or an empty map at seq 0 for a new canvas).
 * When it is damaged, or missing while SQLite no longer has the log from seq 1 (rows trimmed
 * once they were in a checkpoint and R2), the newest checkpoint copy in R2 that reads back and
 * that the surviving log reaches (copies.ts), else an empty map at seq 0; the log between it
 * and SQLite then comes from R2's segments. Throws when that log is needed and there is no
 * OPLOG bucket: starting from a state the log does not continue must never happen quietly.
 */
async function restoreBase(
  sql: SqlStorage,
  oplog: R2Bucket | undefined,
  prefix: string,
  core: CoreConfig,
): Promise<Base> {
  let restored: Awaited<ReturnType<typeof loadCheckpoint>> = null;
  let damage: unknown = null;
  try {
    restored = await loadCheckpoint(sql);
  } catch (error) {
    damage = error;
  }
  const seq = restored?.meta.seq ?? 0;
  const { first, last } = sql
    .exec<{ first: number | null; last: number | null }>(
      'SELECT MIN(seq) AS first, MAX(seq) AS last FROM op_log',
    )
    .one();
  const shipped = shippedTo(sql);
  // The rows SQLite no longer has: everything before its first row, or, with none, everything
  // shipped (rows leave SQLite only once they are in R2).
  const r2To = first !== null ? first - 1 : shipped;
  const state = restored?.state ?? createState(core);
  const meta = restored?.meta ?? null;
  if (!damage && r2To <= seq) return { state, seq, meta, r2To: seq, repaired: false };
  console.error(
    damage
      ? 'CanvasDO: the stored checkpoint is damaged; rebuilding the map without it'
      : `CanvasDO: no checkpoint covers seqs up to ${r2To}, gone from SQLite; recovering from R2`,
    damage ?? '',
  );
  // The whole log is still in SQLite: replay it from seq 0.
  if (r2To <= seq) return { state, seq, meta, team: null, r2To: seq, repaired: true };
  if (!oplog) {
    throw new Error(
      `op log rows ${seq + 1}..${r2To} are only in R2, which this canvas has not got`,
    );
  }
  // Never a copy past what the log reaches: ops after it would be logged at seqs it covers.
  const reach = Math.max(last ?? 0, shipped);
  // A few downloads at most: the start has 30 s, and the R2 log replay keeps its own progress.
  const copy = await newestCopy(
    oplog,
    prefix,
    core.size,
    (c) => c.seq > seq && c.seq <= reach,
    undefined,
    RECOVERY_COPY_ATTEMPTS,
  );
  if (copy) {
    console.error(`CanvasDO: starting from the checkpoint copy at seq ${copy.seq}`);
    if (!copy.team) {
      // Cells written before the copy count for no team until rewritten (no player ids here).
      console.error('CanvasDO: team ledger starts empty', {
        event: 'ledger_empty',
        seq: copy.seq,
        reason: 'copy_without_team_part',
      });
    }
    const r2Last = Math.max(r2To, copy.seq);
    return {
      state: copy.state,
      seq: copy.seq,
      meta: null,
      team: copy.team,
      r2To: r2Last,
      repaired: true,
    };
  }
  console.error(`CanvasDO: no usable checkpoint copy; replaying the R2 log from seq ${seq}`);
  return { state, seq, meta, ...(restored ? {} : { team: null }), r2To, repaired: true };
}

/**
 * Runs one maintenance step; logs and reports a failure instead of throwing. A caller that
 * needs the error passes a holder for it.
 */
async function step(
  name: string,
  body: () => Promise<void>,
  failure?: { error?: unknown },
): Promise<boolean> {
  try {
    await body();
    return true;
  } catch (error) {
    console.error(`CanvasDO: ${name} failed; retrying on the next tick`, loggableError(error));
    if (failure) failure.error = error;
    return false;
  }
}

/**
 * Failed seal attempts since the seal began (meta `seal_failures`): good steps in between do
 * not reset it; only the completed seal clears it.
 */
interface SealFailures {
  readonly count: number;
  /** Tick times (ms) of the first and the latest failure. */
  readonly firstAt: number;
  readonly lastAt: number;
}

/**
 * The stored count, or null when none is stored. A damaged value counts as one failure at
 * `fallbackAt` (tick time): it must never stop the canvas from starting, nor stop the count.
 */
function readSealFailures(sql: SqlStorage, fallbackAt: number): SealFailures | null {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seal_failures'")
    .toArray()[0];
  if (!row) return null;
  const damaged: SealFailures = { count: 1, firstAt: fallbackAt, lastAt: fallbackAt };
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    return damaged;
  }
  const { count, firstAt, lastAt } = (value ?? {}) as Partial<Record<keyof SealFailures, unknown>>;
  const time = (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t);
  if (!Number.isSafeInteger(count) || (count as number) < 1 || !time(firstAt) || !time(lastAt)) {
    return damaged;
  }
  return { count: count as number, firstAt, lastAt };
}

/** The wait after `count` failed seal attempts: MAINTAIN_MS, doubling up to hourly. */
function sealBackoff(count: number): number {
  return Math.min(MAX_SHIP_BACKOFF, MAINTAIN_MS * 2 ** Math.min(Math.max(count - 1, 0), 20));
}

function validMove({ player, client, opId }: PlayerMove): boolean {
  return validIdentity(player, opId) && validClient(client ?? '');
}

/** One move's dedupe key (player, client, opId), as accepted_ops holds it, for queuedMoves. */
function moveKey(player: string, client: string, opId: number): string {
  return JSON.stringify([player, client, opId]);
}

function validClient(client: string): boolean {
  return typeof client === 'string' && client.length <= MAX_CLIENT_LENGTH;
}

function validIdentity(player: string, opId: number): boolean {
  return (
    typeof player === 'string' &&
    player.length > 0 &&
    player.length <= MAX_PLAYER_LENGTH &&
    Number.isInteger(opId) &&
    opId >= 0 &&
    opId <= 0xffffffff
  );
}

function initialConfig(): CanvasConfig {
  // ADR 0027: the open area starts as a square in the middle of the map.
  const offset = (DEFAULT_MAP_SIZE - DEFAULT_OPEN_EDGE) / 2;
  return {
    size: DEFAULT_MAP_SIZE,
    open: { x: offset, y: offset, w: DEFAULT_OPEN_EDGE, h: DEFAULT_OPEN_EDGE },
    maxShield: DEFAULT_MAX_SHIELD,
    shieldLifetime: DEFAULT_SHIELD_LIFETIME,
    items: DEFAULT_ITEM_CONFIG,
    drawSalt: newSalt(),
    growth: DEFAULT_OPEN_GROWTH,
  };
}

export default {
  // Internal script: reached only through Durable Object bindings.
  fetch: () => new Response('not found', { status: 404 }),
} satisfies ExportedHandler<Env>;
