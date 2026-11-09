import { DurableObject } from 'cloudflare:workers';
import type {
  CanvasDO,
  FollowReply,
  HoldView,
  OpResult,
  PlayerDiscard,
  PlayerMove,
  PlayerOp,
  PresenceReport,
  Rules,
  SeasonNumbers,
  Snapshot,
  TickPush,
  TickReply,
} from '@brickplace/game';
import {
  type ClientDiscard,
  type ClientMessage,
  type ClientOp,
  type ClientView,
  decodeClientMessage,
  encodeServerMessage,
  MAX_DIFFS_PER_FRAME,
  ProtocolError,
  type ServerMessage,
  VIEW_TILE,
  viewTiles,
} from '@brickplace/protocol';
import {
  type AbusePolicy,
  allowance,
  type Limit,
  MAX_IN_FLIGHT,
  POLICY_KEY,
  parsePolicy,
  Signals,
  type Suspect,
  Windows,
} from './abuse.ts';
import { ChangeLog, RESUME_CELLS } from './changes.ts';
import {
  cellFrames,
  configFrame,
  holdFrame,
  indexFrames,
  olderRules,
  sameRules,
} from './frames.ts';

import { SendGate } from './gate.ts';
import { OpsSampler, opsEvent, SOCKET_COUNT_MS, SOCKETS_WARN } from './ops.ts';
import { flushTiming, MAX_PENDING_CELLS, relayLimits } from './pacing.ts';
import {
  ADDRESS_HEADER,
  CANVAS_HEADER,
  CANVAS_NAME,
  CAP_HEADER,
  CHALLENGE_REQUIRED,
  CLIENT_HEADER,
  capShareOf,
  GAVE_UP_PLACE,
  KICKED,
  MAP_FULL,
  NETWORK_HEADER,
  PLAYER_HEADER,
  PLAYING_ELSEWHERE,
  PLAYING_TAG,
  SESSION_TOKEN_TTL_MS,
  STAGE0_CANVAS,
  TEAM_HEADER,
  TRUST_HEADER,
  UNTIL_HEADER,
  WATCH_HEADER,
} from './player.ts';
import { Seats } from './seats.ts';
import {
  addedTiles,
  maskOf,
  RECORD_BYTES,
  TickFrames,
  type TileGrid,
  type TileMask,
  tileFrame,
  tileGrid,
  toRecords,
} from './views.ts';
import { watchdogTiming } from './watchdog.ts';

// The Worker entry: workerd accepts only handlers and Durable Object classes as exports
// here (anything else stops `wrangler dev`), so helpers and constants live in sibling
// modules. test/entry-exports.test.ts checks it. Type exports are erased and fine.

export type { Suspect } from './abuse.ts';

export interface Env {
  FANOUT: DurableObjectNamespace<FanoutDO>;
  CANVAS: DurableObjectNamespace<CanvasDO>;
  /**
   * Abuse thresholds from the private ops repo: the abuse policy (`abuse-policy`, ADR 0026).
   * Without it (or the key) every policy limit is off and `abuse_policy_missing` is logged.
   * Optional so other scripts' tests can host the class without it.
   */
  MODERATION?: KVNamespace;
}

/** How long FanoutDO keeps the abuse policy before reading KV again (ms). */
const POLICY_TTL_MS = 5 * 60 * 1000;
/** A KV read of the policy that has not answered by then counts as failed (ms). */
const POLICY_READ_TIMEOUT_MS = 2_000;
/**
 * Accounts and addresses whose windows and signals are kept in memory, per map (ADR 0026): a
 * bound on memory, oldest first out, not a tuning knob. Measured in V8 with account-id keys:
 * about 150 bytes per window and up to about 650 per suspicion entry (a full timing streak),
 * so the five window maps and the signals stay under 30 MB even when all are full, beside a
 * mirror of a few MiB in the object's 128 MB.
 */
const MAX_TRACKED = 20_000;
/**
 * A view frame goes onto the socket's attachment at most this often (ms): a fifth of the
 * page's own pace (VIEW_EVERY_MS, 500 ms). A protocol-rate bound, not an abuse threshold.
 */
const VIEW_WRITE_MS = 100;

/** Close code for a socket whose session token expired; the client renews and reconnects. */
const SESSION_EXPIRED = 4401;

/** Storage key of the "sockets may be behind" marker; see FanoutDO.markBehind. */
const SENT_SEQ = 'sentSeq';

/**
 * Storage key prefix of a kicked player (`kick:<player id>` → until when sockets with older
 * tokens only watch); see FanoutDO.kick.
 */
const KICK_PREFIX = 'kick:';

/**
 * Storage key prefix of an account that must pass a fresh Turnstile before it moves again
 * (`challenge:<player id>` → when it was required; ADR 0026). Cleared by clearChallenge.
 */
const CHALLENGE_PREFIX = 'challenge:';
/**
 * A challenge nobody answered is dropped after this long (ms): housekeeping for accounts that
 * never came back, not a threshold. A returning bot meets its signals again.
 */
const CHALLENGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Most players suspects() lists. */
const MAX_SUSPECTS = 100;

/**
 * A canvas's stats as FanoutDO.stats() passes them on (ADR 0030; the game's CanvasStats,
 * with rate tuples as they come over RPC).
 */
export interface StatsReply {
  readonly playing: number;
  readonly phase: string;
  readonly filled: number;
  /** Absent while the game script predates them (ADR 0033 amended). */
  readonly built?: number;
  readonly growsAt?: number | null;
  readonly rates: Readonly<Record<string, readonly number[]>>;
}

/** Largest count a Stats frame carries (0xffffffff means "no team"). */
const MAX_STATS_COUNT = 0xfffffffe;

/** Stored on each socket, so it survives hibernation. */
interface Attachment {
  /** Absent on a socket that only watches (see WATCH_HEADER): it gets no hold. */
  readonly player?: string;
  /** The page's connection id, part of the op dedupe key; '' or absent on older sockets. */
  readonly client?: string;
  /**
   * When the session token the socket opened with expires (ms). After it the socket stops
   * playing: "sign out everywhere" reaches it within one token lifetime (ADR 0015), a ban,
   * a nickname reset or a deletion at once through a kick (ADR 0023).
   * Absent for dev guests and sockets from before the field.
   */
  readonly until?: number;
  /**
   * The player's team when the socket opened (ADR 0020); absent: none. A team change takes a
   * new token, and the page opens a new socket with it.
   */
  readonly team?: number;
  /**
   * The account's trust score from its session token (ADR 0026); absent: the token carried
   * none (the policy's `unscored` applies).
   */
  readonly trust?: number;
  /**
   * The cells the page last said it shows (x, y, w, h; ADR 0026), for the view signal. Absent
   * until the page sends one.
   */
  readonly view?: readonly [number, number, number, number];
  /**
   * When the latest item the player got arrived (canvas clock): the `nextAt` a newer hold
   * replaced once it had passed. For the timing signal (ADR 0026).
   */
  readonly arrived?: number;
  /** When the socket's player gets the next item (canvas clock), from the last hold sent. */
  readonly nextAt?: number | null;
  /** Revision of the last hold sent, so a slower, older reply is not sent after it. */
  readonly revision?: number;
  /**
   * The tiles (x, y, w, h in tiles) the socket's last subscribing view follows (ADR 0028):
   * it gets diffs for those only. Absent: every tile (clients that never subscribe, and every
   * socket until its first subscribing view). A plain view changes `view`, never this.
   */
  readonly tiles?: readonly [number, number, number, number];
  /**
   * Tiles newly followed whose Tile frame has not gone out yet (the byte budget held it):
   * sent once the object is back after an eviction too. Absent: none.
   */
  readonly owed?: readonly number[];
}

/**
 * Views a socket may have applied per this many ms; a faster one waits for the end of the
 * interval (the client sends at most two a second).
 */
const VIEW_MIN_MS = 250;
/**
 * Tile frames a socket may receive (bytes): a burst of TILE_BURST, then TILE_BYTES_PER_MS.
 * A dense tile is 128 KiB, so a burst is 32 of them, and a socket swinging its view back and
 * forth cannot make this object send more than about 1 MiB/s of tiles to it.
 */
const TILE_BURST = 4 * 1024 * 1024;
const TILE_BYTES_PER_MS = 1024;
/** Changed cells a resync sends as records at most (the canvas's tick cap, 1.5 MiB). */
const RESYNC_CELL_CAP = 1 << 18;

/** What FanoutDO keeps in memory per socket for its view; rebuilt from the attachment. */
interface ViewState {
  /** The tiles the socket gets diffs for; null: every tile. */
  mask: TileMask | null;
  /** When its last view was applied (ms). */
  appliedAt: number;
  /** A view (cells) that came too soon after the last one: applied when the interval ends. */
  pending: Rect | null;
  /** Tiles newly in view whose Tile frame waits for the byte budget. */
  owed: number[];
  /** Tile bytes the socket may receive now, and when that was last worked out. */
  tokens: number;
  refilledAt: number;
}

/** How long the alarm waits before asking the canvas again after a failed call. */
const ALARM_RETRY = 5000;

/**
 * Earliest an alarm is set after now. If the canvas's clock runs a little behind this one,
 * a due item may not have arrived yet when the alarm asks; the next try waits this long. It
 * also bounds how often the alarm fires while many players wait for items: each firing is a
 * holds() call to the canvas. An item within a second of its time is the design's target
 * (ADR 0043); the page counts down on its own.
 */
const MIN_ALARM_DELAY = 1000;
/**
 * Latest an alarm is set after now (the runtime refuses far-future alarms). A later item is
 * looked for again then; with a cooldown of minutes this never applies.
 */
const MAX_ALARM_DELAY = 24 * 60 * 60 * 1000;
/**
 * How late a stored alarm may be before it is taken as lost and set again (ms). One whose
 * handler threw through all its retries keeps reading back from getAlarm(), in the past, and
 * never fires: staging's shard ran no hold alarm or watchdog for a day that way (ADR 0044).
 */
const LOST_ALARM_MS = 60_000;

/** True for a usable time in ms (a finite number), false for null, NaN and the like. */
function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** When to wake for an item due at `nextAt`, kept within the delays above. */
function alarmTime(nextAt: number, now: number): number {
  return Math.min(Math.max(nextAt, now + MIN_ALARM_DELAY), now + MAX_ALARM_DELAY);
}

/**
 * Initial grids sent at once, and the drain rate assumed for each (bytes per ms, about
 * 8 MiB/s): a 6 MiB grid holds its place for about 0.75 s, a small one not at all, so late
 * in a season about ten sockets join per second. At most MAX_WAITING_GRIDS wait (about
 * 30 s of joins at that rate), and none longer than JOIN_WAIT_MS; the others get a 503 and
 * retry after their backoff.
 */
const GRID_SENDS = 8;
const GRID_BYTES_PER_MS = 8 * 1024;
const MAX_WAITING_GRIDS = 300;
const JOIN_WAIT_MS = 30_000;

/**
 * How long after a failed canvas call FanoutDO asks the canvas whether a reply was lost
 * (see checkBehind), so a lost reply is repaired without waiting for the next op. Also how
 * old the last failure must be before the behind marker may be cleared (settleBehind): a
 * call that failed on this side is taken to have committed, or never to, by then.
 */
const VERIFY_DELAY = 1000;

/**
 * FanoutDO's copy of the grid: as of the last frame it sent to its sockets, plus the cells
 * waiting for the next flush (ADR 0041), which new sockets get with their grid.
 */
interface Mirror {
  seq: number;
  readonly cells: Uint8Array;
  readonly shields: Uint8Array;
  /** The grid encoded for new sockets: built on first use, dropped on every change. */
  frames: Uint8Array[] | null;
  /** Tile frames for sockets whose view takes in a tile, by tile; dropped on every change. */
  tileFrames: Map<number, Uint8Array> | null;
  /** The rules last sent to the sockets; null from a canvas that predates them. */
  rules: Rules | null;
  /**
   * The canvas pushes this object a diff tick at most every 250 ms (ADR 0028): a seq missing
   * from a reply arrives with the next tick, so it needs no resync.
   */
  following: boolean;
  readonly tiles: TileGrid;
  /** The cells it changed lately, for pages that resume (ADR 0040). */
  readonly changes: ChangeLog;
  /** Resume frames by the step they start after, for the seq they were built at. */
  resumes: { readonly seq: number; readonly frames: Map<number, Uint8Array[] | null> } | null;
}

type CellDiff = Extract<OpResult, { ok: true }>['diffs'][number];

/** An op or a discard waiting for its batched call to the canvas (ADR 0041, 0043). */
interface Relay {
  readonly ws: WebSocket;
  readonly player: string;
  readonly move: PlayerMove;
  /** Gives back the hammer or shield use reserved for it (ADR 0026); nothing for a discard. */
  readonly giveBack: () => void;
  /** Called once its outcome went out, with the player's new hold if there is one. */
  readonly done: (hold: HoldView | undefined) => void;
  /** Its ack went out (or its socket was gone) and its use was settled. */
  answered: boolean;
}

/**
 * What one relay call answers: the canvas's reply, or one put together from applyBatch and
 * discard() calls against a game script without applyMoves (callCanvas), which then has no
 * seq or rules when the moves were discards only.
 */
interface RelayReply {
  readonly seq?: number;
  readonly results: readonly OpResult[];
  readonly holds?: ReadonlyMap<string, HoldView>;
  readonly rules?: Rules;
  readonly grewAt?: number;
}

function isDiscard(move: PlayerMove): move is PlayerDiscard {
  return 'discard' in move;
}

function isOp(move: PlayerMove): move is PlayerOp {
  return !('discard' in move);
}
/** A rectangle of cells, as View frames carry it. */
type Rect = Extract<ClientMessage, { view: unknown }>['view'];

/**
 * Holds player WebSockets (hibernation API) and relays ops to the canvas.
 *
 * A new socket first receives the whole grid as diff frames tagged with the mirror's seq,
 * then the rules (config frame: open area, maxShield), then the live frames after them.
 * Initial grids go out a few at a time (SendGate), so a reconnect storm cannot make the
 * runtime buffer one grid per socket at once. The grid comes from a mirror kept here, not from CanvasDO,
 * so reconnect storms do not land on the one hot object. Every change to the mirror and
 * every broadcast runs through one serial queue, and a socket joins inside that queue in the
 * same synchronous step as its snapshot is sent: no frame can fall between the two (gap) or
 * arrive twice (duplicate), and frames leave in seq order. A missing seq is repaired by a
 * resync; if this object is evicted before it can repair, the sockets left behind are closed
 * with 1012 on the next load so they reconnect (see markBehind).
 *
 * Each socket also gets its player's hold: after the grid on connect, after every op or
 * discard of that player (on all of the player's sockets), and when the next item is due.
 * CanvasDO hands items out lazily, so an alarm set for the earliest due time asks it then.
 *
 * A canvas has one or more of these shards (ADR 0028; the gateway picks one per player). Each
 * follows the canvas: it loads its mirror with CanvasDO.follow, and the canvas then pushes it
 * every other shard's changes as diff ticks (`tick`), at most every 250 ms. Its own ops go to
 * the canvas in batches, one call in flight (ADR 0041); their replies go into the mirror when
 * they continue its seq, anything else waits for the tick. Either way the sockets get the
 * changed cells at most once per flush (250 ms; at once after a quiet spell), at their end
 * values, so a cell sent twice is harmless; an op's own socket gets its cells with the ack.
 *
 * Each socket may narrow its live diffs to the tiles it shows (a View frame); until it does it
 * gets every tile. A tile newly in view first gets a Tile frame with its content at the
 * mirror's seq. Rules, holds and acks go to every socket as before.
 *
 * Stage 0 simplifications, tracked in PROGRESS.md:
 *  - the whole grid on connect, until map tiles exist;
 *  - holds and cooldowns live in CanvasDO (SessionDO comes later).
 */
export class FanoutDO extends DurableObject<Env> {
  private mirror: Mirror | null = null;
  /** Per-socket subscription state (ADR 0028), rebuilt from attachments after an eviction. */
  private subscriptions = new WeakMap<WebSocket, ViewState>();
  /**
   * Views waiting in the queue to be applied, by socket: a burst before the first one is
   * applied replaces the waiting view instead of queueing one task per frame.
   */
  private queuedViews = new WeakMap<WebSocket, { rect: Rect }>();
  /** The canvas has no follow() (a game script from before ADR 0028): snapshots only. */
  private followMissing = false;
  /** When a tick (or a fresh grid) last reached this shard, for the watchdog (ms). */
  private lastTickAt = 0;
  /** When the alarm last ran the watchdog (ms, ADR 0043); the first alarm after a start runs it. */
  private watchedAt = Number.NEGATIVE_INFINITY;
  /** Each open socket's player and next-item time (ADR 0043), see dueTimes(); null until built. */
  private dueAt: Map<WebSocket, { player: string; at: number }> | null = null;
  /**
   * The canvas-wide counts from the watchdog's last cursor() call (ADR 0030): everyone
   * playing and this shard's teams' totals. Memory only: after an eviction the next watchdog
   * call brings them again.
   */
  private presence: { readonly playing: number; readonly teams: Map<number, number> } | null = null;
  /** Most changed cells a resync sends; past it the sockets reconnect (a field for tests). */
  private resyncCellCap = RESYNC_CELL_CAP;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tile frame budget per socket (fields so tests can lower them). */
  private tileBurst = TILE_BURST;
  private tileBytesPerMs = TILE_BYTES_PER_MS;
  /** Tile frame budget of the whole object: a 64 MiB burst, then 16 MiB/s. */
  private objectTileBurst = 64 * 1024 * 1024;
  private objectTileBytesPerMs = 16 * 1024;
  private objectTileTokens = 64 * 1024 * 1024;
  private objectTileRefilledAt = Date.now();
  /** Applies pending views and owed tiles; null when nothing waits. */
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private viewTimerAt = Number.POSITIVE_INFINITY;
  private loading: Promise<Mirror> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Cells in the mirror not yet sent to the sockets, for the next flush (ADR 0041). */
  private pendingCells: Set<number> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  /** The mirror's seq as of the last cells sent to the sockets. */
  private sentSeq = 0;
  /** Ops and discards waiting for the canvas call in flight, and whether one is (ADR 0041). */
  private relayWaiting: Relay[] = [];
  private relaying = false;
  /**
   * False once the canvas answered that it has no applyMoves (a game script from before ADR
   * 0043): discards then go in calls of their own. Memory only: after an eviction the next
   * discard tries again, so a game deploy is picked up within one eviction.
   */
  private movesSupported: boolean | null = null;
  /** Calls to markBehind so far; resync compares it across its snapshot await. */
  private failures = 0;
  /** When the last of them happened (ms); see settleBehind. */
  private lastFailure = 0;
  /** Sockets that joined and wait for their first hold, by player. */
  private joining: Map<string, WebSocket[]> | null = null;
  /** True while first holds are being fetched; later joins wait for the next call. */
  private fetchingFirstHolds = false;
  /** Delay before the alarm asks again after a failed call (a field so tests can shorten it). */
  private alarmRetry = ALARM_RETRY;
  /**
   * In-memory copy of the stored "behind" marker (SENT_SEQ): undefined until read, null when
   * none is stored. Read from storage once per object lifetime, so the normal path (not
   * marked) costs no storage access; written whenever it changes.
   */
  private behind: number | null | undefined;
  /** A pending checkBehind, so a burst of failures schedules one check. */
  private verifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fields so tests can change them. */
  private verifyDelay = VERIFY_DELAY;
  private viewWriteMs = VIEW_WRITE_MS;
  private gridGate = new SendGate(GRID_SENDS, MAX_WAITING_GRIDS, GRID_BYTES_PER_MS, JOIN_WAIT_MS);
  /** Overload signals (docs/ops/alerts.md), one per name per minute at most. */
  private readonly ops = new OpsSampler();
  /** When the sockets were last counted for `fanout_sockets_high` (ms). */
  private socketsCountedAt = Number.NEGATIVE_INFINITY;
  /** Sockets from which `fanout_sockets_high` is logged (a field so tests can lower it). */
  private socketsWarnAt = SOCKETS_WARN;
  /** The abuse policy (ADR 0026); null: none readable, every policy limit off. */
  private policy: AbusePolicy | null = null;
  /** When the policy was last read (ms), and whether any read has finished yet. */
  private policyAt = Number.NEGATIVE_INFINITY;
  private policyLoaded = false;
  private policyRead: Promise<void> | null = null;
  /** `abuse_policy_missing` at most once an hour per object. */
  private readonly policyMissing = new OpsSampler(60 * 60 * 1000);
  /** Socket opens per account and per address, and ops per account (memory only). */
  private readonly opensByAccount = new Windows(MAX_TRACKED);
  private readonly opensByAddress = new Windows(MAX_TRACKED);
  private readonly opensByNetwork = new Windows(MAX_TRACKED);
  private readonly opsByAccount = new Windows(MAX_TRACKED);
  /** Hammers and shields used per account, for the trust allowance (memory only). */
  private readonly usesByAccount = new Windows(MAX_TRACKED);
  /** Suspicion from bot signals, per account (memory only). */
  private readonly signals = new Signals(MAX_TRACKED);
  /** The latest view of each playing socket, and when it last went on the attachment. */
  private readonly views = new WeakMap<
    WebSocket,
    { readonly view: readonly [number, number, number, number]; readonly writtenAt: number }
  >();
  /** Accounts that must pass a Turnstile, mirrored from storage on first use. */
  private challenges: Map<string, number> | null = null;
  /** Ops and discards waiting for the canvas, by account. */
  private readonly inFlight = new Map<string, number>();
  /** When each player last moved, for the place an idle player gives up (ADR 0039). */
  private seats = new Seats();
  /** Refusals and signals since the last `fanout_abuse` event, and when it went out. */
  private abuseCounts: Record<string, number> = {};
  private abuseLoggedAt = Number.NEGATIVE_INFINITY;
  /** Joins since the last `fanout_joins` event, and when it went out. */
  private joinCounts = { resumed: 0, grids: 0 };
  private joinsLoggedAt = Number.NEGATIVE_INFINITY;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const canvas = request.headers.get(CANVAS_HEADER) ?? STAGE0_CANVAS;
    if (!CANVAS_NAME.test(canvas)) return new Response('bad canvas name', { status: 400 });
    // One canvas per FanoutDO, pinned by its first socket: a gateway bug must not mix seasons.
    const pinned = this.ctx.storage.kv.get<string>('canvas');
    if (pinned === undefined) this.ctx.storage.kv.put('canvas', canvas);
    else if (pinned !== canvas) return new Response('another canvas', { status: 409 });
    const player = request.headers.get(PLAYER_HEADER);
    const watching = request.headers.get(WATCH_HEADER) === '1';
    if (!player && !watching) return new Response('missing player identity', { status: 400 });
    const connection = request.headers.get(CLIENT_HEADER) ?? '';
    const until = Number(request.headers.get(UNTIL_HEADER) ?? Number.NaN);
    const team = Number(request.headers.get(TEAM_HEADER) ?? Number.NaN);
    const trust = Number(request.headers.get(TRUST_HEADER) ?? Number.NaN);
    // The seq up to which the page holds the whole map (ADR 0040): it may resume from there,
    // when the map is this canvas's (a page left open across a season change holds another).
    const query = new URL(request.url).searchParams;
    const since = query.get('canvas') === canvas ? sinceOf(query.get('since')) : null;
    const playing: Attachment | null = player
      ? {
          player,
          client: connection,
          ...(isTime(until) ? { until } : {}),
          ...(Number.isSafeInteger(team) && team > 0 ? { team } : {}),
          ...(Number.isInteger(trust) && trust >= 0 && trust <= 100 ? { trust } : {}),
        }
      : null;
    // Socket opens per account and per address (ADR 0026), before any grid is queued: a page
    // reconnecting in a loop, or a script opening sockets, costs a 429 and nothing more. The
    // page's backoff retries.
    const policy = await this.currentPolicy();
    const refusedBy = this.refuseOpen(
      policy,
      player,
      request.headers.get(ADDRESS_HEADER),
      request.headers.get(NETWORK_HEADER),
    );
    if (refusedBy) {
      this.countAbuse(`opensRefusedBy${refusedBy}`, canvas);
      return new Response('too many sockets opened; retry shortly', {
        status: 429,
        headers: { 'Retry-After': '10' },
      });
    }
    // The players-at-once cap (ADR 0039): turned away before any grid is queued. Checked again
    // as the socket joins, where an idle player's place may be freed for it. A kicked player
    // joins as a watcher, which the cap does not count.
    const share = playing ? capShareOf(request.headers.get(CAP_HEADER)) : null;
    if (
      share !== null &&
      !this.kickedOut(playing!.player!, playing!.until) &&
      !this.seatFor(playing!.player!, share, false)
    ) {
      return this.turnAway(canvas, share);
    }
    /** Set in the serial step when the shard turned out full there. */
    let full = false;
    /** Decided as the socket joins, so a kick while it waits in the gate still applies. */
    let joined: Attachment = { client: connection };
    // In a reconnect storm the initial grids queue here, a few at a time (see SendGate); the
    // socket is accepted only when its turn comes, so it never waits half-joined.
    const slot = await this.gridGate.enter();
    if (!slot) {
      const { active, waiting } = this.gridGate.load;
      this.ops.emit('warn', 'fanout_join_refused', { canvas, active, waiting });
      return new Response('too many sockets joining; retry shortly', {
        status: 503,
        headers: { 'Retry-After': '5' },
      });
    }
    let sent = 0;
    let client: WebSocket;
    let server: WebSocket;
    try {
      [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      await this.serial(async () => {
        const mirror = await this.loadMirror();
        // Synchronous from here on: no broadcast can run between the snapshot and joining,
        // and no kick between its check and joining. A socket opened with a token issued
        // before a kick of its player only watches (ADR 0023).
        if (playing && !this.kickedOut(playing.player!, playing.until)) joined = playing;
        // Exact here: nothing else joins between this check and the accept below.
        if (joined.player && share !== null && !this.seatFor(joined.player, share, true)) {
          full = true;
          return;
        }
        // One playing socket per account (ADR 0026): the newest plays, an older one closes.
        if (joined.player) this.closeOlder(joined.player);
        // Tagged with the player, so a hold change and a kick reach all of its sockets, and
        // as playing, so the cap can count them.
        this.ctx.acceptWebSocket(server, joined.player ? [joined.player, PLAYING_TAG] : []);
        if (joined.player) this.joinedSeat(joined.player);
        server.serializeAttachment(joined);
        // The cells changed since the page's seq when the list reaches it, else the whole map.
        const resume = since === null ? null : resumeFrames(mirror, since);
        this.countJoin(canvas, resume !== null);
        for (const frame of resume ?? gridFrames(mirror)) {
          sendFrame(server, frame);
          sent += frame.byteLength;
        }
        const config = rulesFrame(mirror.rules);
        if (config) sendFrame(server, config);
        // The counts as last known; the next watchdog call counts this socket too.
        const stats = this.statsFrame(joined);
        if (stats) sendFrame(server, stats);
      });
    } catch (error) {
      console.error('initial grid failed', error);
      this.canvasCallFailed('snapshot', error);
      return new Response('canvas unavailable', { status: 503 });
    } finally {
      slot.leave(sent);
    }
    if (full) return this.turnAway(canvas, share!);
    this.countSockets(canvas);
    // A join after a quiet spell: make sure the canvas still pushes to this shard, so the new
    // socket's grid does not stay behind (ADR 0028).
    if (Date.now() - this.lastTickAt >= watchdogTiming.stallMs) {
      this.scheduleWatch(watchdogTiming.stallMs);
    }
    // The tick watchdog's alarm (ADR 0028), while sockets are open; never in the socket's way.
    if (Number.isFinite(watchdogTiming.ms)) {
      await this.ensureAlarm(Date.now() + watchdogTiming.ms).catch((error: unknown) => {
        console.error('watchdog alarm not set', error);
      });
    }
    // The hold follows without holding up the 101: in a reconnect storm (every game deploy)
    // the canvas may still be replaying its log. A watcher has no hold.
    if (joined.player) this.queueFirstHold(joined.player, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Closes every open socket of `player` at once (ADR 0023), after a ban, a nickname reset or
   * the account's deletion. A token is checked in D1 only when it is renewed (ADR 0015), so
   * the page could reconnect and play on with the token it holds: until every token issued
   * before now has expired, a socket of this player opened with one only watches. Its next op
   * is refused `signed_out` and the page renews, which shows it the change. Called through
   * the binding by the admin Worker and the gateway; written before it returns. `forget`
   * (account deletion) also drops what this object keeps of the account: a pending
   * challenge and its bot signals (ADR 0026). Older callers pass one argument.
   */
  async kick(player: string, forget = false): Promise<{ readonly closed: number }> {
    const now = Date.now();
    const kv = this.ctx.storage.kv;
    // Entries past their time cover no token any more: dropped here, a few per kick at most.
    // Collected first, then deleted: no row changes under the open iterator.
    const expired = [...kv.list<number>({ prefix: KICK_PREFIX })].filter(
      ([, before]) => before <= now,
    );
    for (const [key] of expired) kv.delete(key);
    kv.put(KICK_PREFIX + player, now + SESSION_TOKEN_TTL_MS);
    // A deleted account's pending Turnstile goes with it (ADR 0026): no id is kept for an
    // account that is gone. Other kicks keep it: "sign out everywhere" must not be a way out
    // of a challenge.
    if (forget) {
      this.loadChallenges().delete(player);
      kv.delete(CHALLENGE_PREFIX + player);
      this.signals.forget(player);
    }
    let closed = 0;
    for (const ws of this.ctx.getWebSockets(player)) {
      try {
        ws.close(KICKED, 'account changed; reconnect');
        closed++;
      } catch {
        // Already closing.
      }
    }
    return { closed };
  }

  /**
   * Brings the open sockets up to the canvas now (ADR 0024): after a rollback or a lock change,
   * which reach sockets only with the next op reply, and a paused or quiet map has none. Sends
   * what changed (a resync when the canvas logged a row, such as a restore) and the rules
   * (locks). Called through the binding by the admin Worker; nothing to do without sockets.
   */
  async refresh(): Promise<{ readonly seq: number | null }> {
    if (this.ctx.getWebSockets().length === 0) return { seq: null };
    return this.serial(async () => {
      const mirror = await this.loadMirror();
      const status = await this.canvas().status();
      if (status.seq > mirror.seq) await this.resync(mirror);
      this.adoptRules(status.rules);
      return { seq: this.mirror?.seq ?? null };
    });
  }

  /**
   * The abuse policy (ADR 0026), read from KV at most every POLICY_TTL_MS in the background.
   * Only the first read of this object's life is awaited (bounded by POLICY_READ_TIMEOUT_MS),
   * so a socket or op right after a restart is not judged without it; later ones use the
   * policy at hand while a fresh read is under way.
   */
  private async currentPolicy(): Promise<AbusePolicy | null> {
    if (Date.now() - this.policyAt >= POLICY_TTL_MS && !this.policyRead) {
      this.policyRead = this.readPolicy().finally(() => {
        this.policyRead = null;
      });
    }
    if (!this.policyLoaded && this.policyRead) await this.policyRead;
    return this.policy;
  }

  /**
   * One read of the policy. Unreadable (KV down, no answer in time): the policy at hand stays,
   * and the next read comes after POLICY_TTL_MS. Missing or malformed: no policy, every limit
   * off, and `abuse_policy_missing` at error level (at most hourly) so the owner hears of it.
   */
  private async readPolicy(): Promise<void> {
    const kv = this.env.MODERATION;
    let text: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${POLICY_READ_TIMEOUT_MS} ms`)),
          POLICY_READ_TIMEOUT_MS,
        );
      });
      if (kv) text = await Promise.race([kv.get(POLICY_KEY), timeout]);
    } catch (error) {
      console.error('abuse policy unreadable; keeping the one at hand', error);
      this.policyAt = Date.now();
      this.policyLoaded = true;
      return;
    } finally {
      clearTimeout(timer);
    }
    this.policy = parsePolicy(text);
    this.policyAt = Date.now();
    this.policyLoaded = true;
    if (!this.policy) {
      this.policyMissing.emit('error', 'abuse_policy_missing', {
        canvas: this.canvasName(),
        reason: text === null ? 'missing' : 'malformed',
      });
    }
  }

  /**
   * Counts a socket open against the policy's limits (ADR 0026): per account for a playing
   * socket, per address and per IPv6 network for any. Returns what refused it, or null when
   * it may open.
   */
  private refuseOpen(
    policy: AbusePolicy | null,
    player: string | null,
    address: string | null,
    network: string | null,
  ): 'Account' | 'Address' | 'Network' | null {
    const now = Date.now();
    const opens = policy?.opens;
    if (player && opens?.account && !this.opensByAccount.take(player, opens.account, now)) {
      return 'Account';
    }
    if (address && opens?.address && !this.opensByAddress.take(address, opens.address, now)) {
      return 'Address';
    }
    if (network && opens?.network && !this.opensByNetwork.take(network, opens.network, now)) {
      return 'Network';
    }
    return null;
  }

  /**
   * Counts a refusal or a signal for the `fanout_abuse` event: one per minute at most, with
   * the counts since the last one, never a player id or an address. Sent with the first count
   * after the minute, so a quiet object sends nothing.
   */
  private countAbuse(name: string, canvas = this.canvasName()): void {
    this.abuseCounts[name] = (this.abuseCounts[name] ?? 0) + 1;
    const now = Date.now();
    if (now - this.abuseLoggedAt < 60_000) return;
    opsEvent('info', 'fanout_abuse', { canvas, ...this.abuseCounts });
    this.abuseCounts = {};
    this.abuseLoggedAt = now;
  }

  /**
   * Counts a join by what it got (ADR 0040): the changes since the page's seq, or the whole
   * map. A `fanout_joins` event carries the counts since the last one, at most once a minute,
   * with the first join after it.
   */
  private countJoin(canvas: string, resumed: boolean): void {
    if (resumed) this.joinCounts.resumed++;
    else this.joinCounts.grids++;
    const now = Date.now();
    if (now - this.joinsLoggedAt < 60_000) return;
    opsEvent('info', 'fanout_joins', { canvas, ...this.joinCounts });
    this.joinCounts = { resumed: 0, grids: 0 };
    this.joinsLoggedAt = now;
  }

  /** The canvas this object serves, for events. */
  private canvasName(): string {
    return this.ctx.storage.kv.get<string>('canvas') ?? STAGE0_CANVAS;
  }

  /**
   * Closes the player's playing sockets on this object with PLAYING_ELSEWHERE, as a newer one
   * joins (ADR 0026). Two tabs or devices of one account would otherwise each play, which
   * multiplies what one account can do between moderation looks (ops in flight, signals
   * split over sockets). The newest wins; the client reconnects after this code only when its
   * player taps "Play here", so two pages never take turns on their own. A socket that joined
   * as a watcher (kicked) has
   * no player tag and is left alone.
   */
  private closeOlder(player: string): void {
    for (const ws of this.ctx.getWebSockets(player)) {
      try {
        ws.close(PLAYING_ELSEWHERE, 'playing on another page');
      } catch {
        // Already closing.
      }
    }
  }

  /**
   * Whether `player` may play here under the shard's `share` of the players-at-once cap (ADR
   * 0039): yes for an account already playing here (its new socket replaces the old one) or
   * while the shard holds fewer playing sockets; on a full shard, only if a player has not
   * moved for IDLE_YIELD_MS. With `take`, that player's socket is closed with GAVE_UP_PLACE
   * and the place is the newcomer's. Counting reads the tag list of the playing sockets, no
   * attachments; a closing socket may still count for a moment, which only errs on the full
   * side.
   */
  private seatFor(player: string, share: number, take: boolean): boolean {
    if (this.hasSocket(player)) return true;
    if (this.ctx.getWebSockets(PLAYING_TAG).length < share) return true;
    const now = Date.now();
    this.seats.seed(() => this.playingPlayers(), now);
    const idle = this.seats.idlest(now, (p) => this.hasSocket(p));
    if (idle === null) return false;
    if (!take) return true;
    this.seats.forget(idle);
    for (const ws of this.ctx.getWebSockets(idle)) {
      try {
        ws.close(GAVE_UP_PLACE, 'gave up its place after a while without a move');
      } catch {
        // Already closing.
      }
    }
    return true;
  }

  /** A playing socket of `player` joined: it counts as having just moved. */
  private joinedSeat(player: string): void {
    this.seats.moved(player, Date.now());
    this.seats.bound((p) => this.hasSocket(p));
  }

  private hasSocket(player: string): boolean {
    return this.ctx.getWebSockets(player).length > 0;
  }

  /** The players of the open playing sockets, from their tags. */
  private *playingPlayers(): Iterable<string> {
    for (const ws of this.ctx.getWebSockets(PLAYING_TAG)) {
      const player = this.ctx.getTags(ws).find((tag) => tag !== PLAYING_TAG);
      if (player) yield player;
    }
  }

  /**
   * A socket turned away by the cap (ADR 0039): accepted only to be closed with MAP_FULL, which
   * a page can read (a refused upgrade reaches it as 1006). No grid, no hold. A sampled
   * `fanout_full` says how often; counts only.
   */
  private turnAway(canvas: string, share: number): Response {
    const playing = this.ctx.getWebSockets(PLAYING_TAG).length;
    this.ops.emit('warn', 'fanout_full', { canvas, playing, share });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    server.close(MAP_FULL, 'the map is full; try again later');
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The account passed a fresh Turnstile (ADR 0026; the gateway checked it): it may move again,
   * and its suspicion score starts over, its signal counts kept for moderators. Called through
   * the binding by the gateway; written before it returns. Only a pending challenge is lifted:
   * without one nothing changes (`cleared: false`), so solving a Turnstile at will cannot wipe
   * an account's suspicion or take it off the moderators' list.
   */
  async clearChallenge(player: string): Promise<{ readonly cleared: boolean }> {
    const kv = this.ctx.storage.kv;
    const stored = kv.get<number>(CHALLENGE_PREFIX + player) !== undefined;
    const cleared = this.loadChallenges().delete(player) || stored;
    if (!cleared) return { cleared };
    if (stored) kv.delete(CHALLENGE_PREFIX + player);
    this.signals.passed(player, Date.now());
    this.countAbuse('cleared');
    return { cleared };
  }

  /**
   * Accounts whose bot signals reached the policy's `flagAt`, most suspicious first, and those
   * that must pass a Turnstile (ADR 0026), for moderators (the admin area). Memory only for
   * the signals: an eviction forgets them. Nothing here acts on anyone.
   */
  async suspects(): Promise<{ readonly players: readonly Suspect[] }> {
    const now = Date.now();
    const signals = (await this.currentPolicy())?.signals ?? null;
    this.pruneChallenges(now);
    const challenges = this.loadChallenges();
    const listed = signals ? this.signals.flagged(signals, now, MAX_SUSPECTS) : [];
    const players: Suspect[] = listed.map((s) => {
      const at = challenges.get(s.player);
      return at === undefined ? s : { ...s, challengedAt: at };
    });
    for (const [player, at] of challenges) {
      if (players.length >= MAX_SUSPECTS) break;
      if (players.some((s) => s.player === player)) continue;
      players.push({ ...this.signals.suspect(player, signals, now), challengedAt: at });
    }
    return { players };
  }

  /**
   * The accounts that must pass a Turnstile, read from storage once per object lifetime, the
   * ones nobody answered for CHALLENGE_KEEP_MS dropped as they are read.
   */
  private loadChallenges(): Map<string, number> {
    if (this.challenges) return this.challenges;
    this.challenges = new Map(
      [...this.ctx.storage.kv.list<number>({ prefix: CHALLENGE_PREFIX })].map(([key, at]) => [
        key.slice(CHALLENGE_PREFIX.length),
        at,
      ]),
    );
    this.pruneChallenges(Date.now());
    return this.challenges;
  }

  /** Drops challenges nobody answered for CHALLENGE_KEEP_MS, in memory and in storage. */
  private pruneChallenges(now: number): void {
    const challenges = this.loadChallenges();
    for (const [player, at] of [...challenges]) {
      if (now - at <= CHALLENGE_KEEP_MS) continue;
      challenges.delete(player);
      this.ctx.storage.kv.delete(CHALLENGE_PREFIX + player);
    }
  }

  /** True while `player` must pass a Turnstile before moving. */
  private challenged(player: string, now: number): boolean {
    const at = this.loadChallenges().get(player);
    return at !== undefined && now - at <= CHALLENGE_KEEP_MS;
  }

  /**
   * Requires a fresh Turnstile of `player` (durable, so an eviction keeps it), and drops
   * challenges nobody answered for CHALLENGE_KEEP_MS.
   */
  private requireChallenge(player: string, now: number): void {
    this.pruneChallenges(now);
    this.loadChallenges().set(player, now);
    this.ctx.storage.kv.put(CHALLENGE_PREFIX + player, now);
  }

  /**
   * True when `player` was kicked after the token behind this socket was issued: it expires
   * (`until`) before the kick time plus a token's lifetime. A socket with no expiry (a dev
   * guest) counts as old. One synchronous read of the player's own entry.
   */
  private kickedOut(player: string, until: number | undefined): boolean {
    const before = this.ctx.storage.kv.get<number>(KICK_PREFIX + player);
    if (before === undefined || before <= Date.now()) return false;
    return until === undefined || until < before;
  }

  /**
   * Sends a new socket its first hold. Sockets joining in the same tick, or while a call for
   * earlier ones is under way, share one call to the canvas, so a reconnect storm does not
   * queue one call per socket there.
   */
  private queueFirstHold(player: string, ws: WebSocket): void {
    this.joining ??= new Map();
    const sockets = this.joining.get(player);
    if (sockets) sockets.push(ws);
    else this.joining.set(player, [ws]);
    if (!this.fetchingFirstHolds) this.fetchFirstHolds();
  }

  /** Runs first-hold calls until no socket waits; sockets joining meanwhile go in the next. */
  private fetchFirstHolds(): void {
    this.fetchingFirstHolds = true;
    setTimeout(async () => {
      try {
        while (this.joining) await this.sendFirstHolds();
      } catch (error) {
        console.error('first holds failed', error);
      } finally {
        this.fetchingFirstHolds = false;
        // Sockets that joined during a call that threw must not wait for the next join. The
        // sockets of the call that threw get their hold with their next op or discard.
        if (this.joining) this.fetchFirstHolds();
      }
    }, 0);
  }

  private async sendFirstHolds(): Promise<void> {
    const joining = this.joining;
    this.joining = null;
    if (!joining) return;
    let holds: ReadonlyMap<string, HoldView>;
    try {
      holds = await this.canvas().holds([...joining.keys()]);
    } catch (error) {
      // Due now: the alarm asks again shortly instead of leaving the hold empty until the
      // player reconnects.
      console.error('initial hold failed', error);
      const now = Date.now();
      for (const [player, sockets] of joining) {
        for (const ws of sockets) this.remember(ws, player, now);
      }
      await this.ensureAlarm(now);
      return;
    }
    let earliest: number | null = null;
    const due = (at: number | null) => {
      if (isTime(at)) earliest = Math.min(earliest ?? at, at);
    };
    for (const [player, sockets] of joining) {
      // One player's hold that cannot be sent must not cost the others theirs.
      let hold: HoldView | undefined;
      try {
        hold = holds.get(player);
        if (!hold) continue;
        // Only to the new sockets: the player's other sockets already have this hold.
        // Without a frame (unencodable) the socket still records the hold's next-item time.
        const frame = encodeHold(hold);
        for (const ws of sockets) this.sendHold(ws, player, hold, frame);
      } catch (error) {
        // A broken reply for this player: due now, so the alarm asks again for them.
        console.error('first hold failed for one player', error);
        const now = Date.now();
        for (const ws of sockets) this.remember(ws, player, now);
        due(now);
        continue;
      }
      due(hold.nextAt);
    }
    await this.ensureAlarm(earliest);
  }

  /**
   * Sends the hold of every socket whose next item is due, then waits for the next one. While
   * sockets are open it also runs the tick watchdog (ADR 0028) at least every WATCHDOG_MS: an
   * alarm, unlike a timer, lets a quiet shard hibernate in between.
   */
  override async alarm(): Promise<void> {
    // The watchdog's turn comes every watchdogTiming.ms (ADR 0043), not with every alarm:
    // while players wait for items the hold alarm fires as often as every MIN_ALARM_DELAY,
    // and a watchdog run is a canvas call plus a Stats frame to every socket. Noted before
    // the holds, which set the next alarm from it.
    const watching = Date.now() >= this.watchDue();
    if (watching) this.watchedAt = Date.now();
    await this.deliverDueHolds();
    // After the holds: it may wait on the canvas, and the next alarm is already set.
    if (!watching) return;
    try {
      await this.watch();
    } catch (error) {
      console.error('tick watchdog failed', error);
    }
  }

  /** When the alarm next runs the watchdog (ms); never, while tests turn it off. */
  private watchDue(): number {
    if (!Number.isFinite(watchdogTiming.ms)) return Number.POSITIVE_INFINITY;
    return this.watchedAt + watchdogTiming.ms;
  }

  /**
   * When each open socket's player gets the next item (ADR 0043): kept by remember(), built
   * from the attachments once after a start. A closed socket's entry goes with the next alarm
   * (nothing else sees a close); the hold alarm reads this instead of every attachment.
   */
  private dueTimes(): Map<WebSocket, { player: string; at: number }> {
    if (this.dueAt) return this.dueAt;
    const times = new Map<WebSocket, { player: string; at: number }>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      // A value that is not a time must not turn the minimum into NaN for everyone.
      if (attachment?.player && isTime(attachment.nextAt)) {
        times.set(ws, { player: attachment.player, at: attachment.nextAt });
      }
    }
    this.dueAt = times;
    return times;
  }

  private async deliverDueHolds(): Promise<void> {
    const now = Date.now();
    const times = this.dueTimes();
    const due = new Set<string>();
    for (const [ws, entry] of times) {
      if (ws.readyState !== WebSocket.OPEN) times.delete(ws);
      else if (entry.at <= now) due.add(entry.player);
    }
    if (due.size > 0) {
      let holds: ReadonlyMap<string, HoldView>;
      try {
        holds = await this.canvas().holds([...due]);
      } catch (error) {
        // E.g. CanvasDO restarting for a deploy: try again soon, on our own schedule.
        console.error('hold alarm failed', error);
        await this.ctx.storage.setAlarm(Date.now() + this.alarmRetry);
        return;
      }
      for (const player of due) {
        const hold = holds.get(player);
        if (hold) this.deliverHold(player, hold);
        // The canvas refused the identity: stop asking for it.
        else for (const ws of this.ctx.getWebSockets(player)) this.remember(ws, player, null);
      }
    }
    let next = Number.POSITIVE_INFINITY;
    for (const { at } of times.values()) next = Math.min(next, at);
    if (this.ctx.getWebSockets().length > 0) next = Math.min(next, this.watchDue());
    if (Number.isFinite(next)) {
      await this.ctx.storage.setAlarm(alarmTime(next, Date.now()));
    }
  }

  /**
   * Sends a hold to the player's sockets (and `origin`, which may predate player tags) and
   * remembers on each when the next item is due. Synchronous, so it keeps frame order; the
   * caller then calls ensureAlarm.
   */
  private deliverHold(player: string, hold: HoldView, origin?: WebSocket): void {
    // Null when unencodable: nothing is sent, but each socket still records the hold's
    // next-item time, so the alarm follows the canvas instead of asking again every second.
    const frame = encodeHold(hold);
    const sockets = new Set(this.ctx.getWebSockets(player));
    if (origin) sockets.add(origin);
    for (const ws of sockets) this.sendHold(ws, player, hold, frame);
  }

  /**
   * Sends a hold frame (none when `frame` is null) and records the hold on the socket, unless
   * a newer hold already went out on it (replies can race): an older one would show stale
   * items and could leave the alarm without the newer next-item time.
   */
  private sendHold(ws: WebSocket, player: string, hold: HoldView, frame: Uint8Array | null): void {
    const sent = (ws.deserializeAttachment() as Attachment | null)?.revision ?? -1;
    if (sent > hold.revision) return;
    if (frame) sendFrame(ws, frame);
    this.remember(ws, player, hold.nextAt, hold.revision);
  }

  /**
   * Records on the socket when its player's next item is due and which hold revision it has;
   * the revision is kept when none is given, and so is everything else on the socket. The
   * alarm's in-memory copy of the time (dueTimes) follows.
   */
  private remember(ws: WebSocket, player: string, nextAt: number | null, revision?: number): void {
    try {
      const old = ws.deserializeAttachment() as Attachment | null;
      const kept = revision ?? old?.revision;
      // Only a real time is stored: anything else would stop the alarm for every socket.
      const at = isTime(nextAt) ? nextAt : null;
      // A next-item time that has passed and is now replaced: that item arrived then (the
      // timing signal, ADR 0026).
      const before = old?.nextAt;
      const arrived =
        isTime(before) && before <= Date.now() && before !== at ? before : old?.arrived;
      const attachment: Attachment = {
        ...old,
        player,
        nextAt: at,
        ...(kept === undefined ? {} : { revision: kept }),
        ...(arrived === undefined ? {} : { arrived }),
      };
      ws.serializeAttachment(attachment);
      const times = this.dueAt;
      if (times) {
        if (at === null) times.delete(ws);
        else times.set(ws, { player, at });
      }
    } catch {
      // Closed meanwhile: nothing to remember.
    }
  }

  /**
   * Makes sure the alarm fires by `nextAt` (a canvas time), so the item is sent then. A
   * failure is only logged: the next op or connect sets the alarm again. A stored alarm more
   * than LOST_ALARM_MS overdue is replaced by one MIN_ALARM_DELAY out.
   */
  private async ensureAlarm(nextAt: number | null): Promise<void> {
    if (!isTime(nextAt)) return;
    try {
      const now = Date.now();
      const at = alarmTime(nextAt, now);
      const current = await this.ctx.storage.getAlarm();
      // A lost alarm stood for other sockets' due holds and the watchdog, not only this
      // caller's: fire soon, and the handler sets the real next time.
      const lost = current !== null && now - current >= LOST_ALARM_MS;
      if (current === null || at < current || lost) {
        await this.ctx.storage.setAlarm(lost ? alarmTime(now, now) : at);
      }
    } catch (error) {
      console.error('setting the hold alarm failed', error);
    }
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === 'string') {
      ws.close(1003, 'binary frames only');
      return;
    }
    let decoded: ClientMessage;
    try {
      decoded = decodeClientMessage(new Uint8Array(message));
    } catch (error) {
      if (error instanceof ProtocolError) {
        ws.close(1002, error.message);
        return;
      }
      throw error;
    }
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) {
      ws.close(1008, 'no player identity');
      return;
    }
    // A view is not acked: kept for the view signal of a playing socket (ADR 0026; a
    // watcher's is dropped), and, when it subscribes, narrowing what the socket receives to
    // its tiles (ADR 0028; watchers too).
    if ('view' in decoded) {
      if (attachment.player) this.keepView(ws, attachment, decoded.view);
      if (decoded.subscribe) this.requestView(ws, decoded.view);
      return;
    }
    const { player, client = '', until } = attachment;
    const { opId } = decoded;
    if (!player) {
      // Watching only: refused before anything reaches the canvas. Not `unavailable`, so the
      // client does not resend.
      send(ws, { type: 'ack', opId, ok: false, reason: 'signed_out' });
      return;
    }
    if (until !== undefined && Date.now() >= until) {
      // The session behind this socket expired: refuse, and close so the page renews its
      // session (which checks bans and sign-outs in D1) and reconnects.
      send(ws, { type: 'ack', opId, ok: false, reason: 'signed_out' });
      ws.close(SESSION_EXPIRED, 'session expired');
      return;
    }
    // An account that must pass a Turnstile (ADR 0026): no ack, so the page keeps the op in
    // flight and resends it once the player has passed, on the next socket.
    if (this.challenged(player, Date.now())) {
      ws.close(CHALLENGE_REQUIRED, 'confirm you are human');
      return;
    }
    // A move, accepted or not, keeps the player's place on a full shard (ADR 0039).
    this.seats.moved(player, Date.now());
    // Limits before anything reaches the canvas (ADR 0026). Refused with `unavailable`, which
    // the page resends once and then reports: a person never meets these limits (the hold
    // gives a few items per cooldown), a script sending ops in a loop does.
    const waiting = this.inFlight.get(player) ?? 0;
    if (waiting >= MAX_IN_FLIGHT) {
      this.countAbuse('inFlightRefused');
      send(ws, { type: 'ack', opId, ok: false, reason: 'unavailable' });
      return;
    }
    this.inFlight.set(player, waiting + 1);
    try {
      const policy = await this.currentPolicy();
      const rate = policy?.ops?.account;
      if (rate && !this.opsByAccount.take(player, rate, Date.now())) {
        this.countAbuse('opsRefused');
        send(ws, { type: 'ack', opId, ok: false, reason: 'unavailable' });
        return;
      }
      if ('discard' in decoded) await this.discard(ws, player, client, opId, decoded.discard);
      else await this.relayOp(ws, player, attachment, decoded.op, opId, policy);
    } finally {
      const left = (this.inFlight.get(player) ?? 1) - 1;
      if (left > 0) this.inFlight.set(player, left);
      else this.inFlight.delete(player);
    }
  }

  /**
   * Keeps the latest view of a playing socket (ADR 0026). Always in memory, which the signal
   * reads first; on the attachment (so it survives hibernation) at most every VIEW_WRITE_MS,
   * so a page flooding view frames costs this busy object a map write each, not a storage
   * write. The page sends one at most every 500 ms, plus one right before a move.
   */
  private keepView(
    ws: WebSocket,
    attachment: Attachment,
    { x, y, w, h }: ClientView['view'],
  ): void {
    const now = Date.now();
    const view = [x, y, w, h] as const;
    const last = this.views.get(ws);
    if (last && now - last.writtenAt < this.viewWriteMs) {
      this.views.set(ws, { view, writtenAt: last.writtenAt });
      return;
    }
    this.views.set(ws, { view, writtenAt: now });
    ws.serializeAttachment({ ...attachment, view } satisfies Attachment);
  }

  /**
   * Sends one op to the canvas and its outcome to the sockets. First (ADR 0026) its bot
   * signals are recorded: an op that brings the account's suspicion to the policy's
   * `challengeAt` closes the socket for a Turnstile instead, unacked. A hammer or shield past
   * the account's trust allowance (lowered by suspicion) is refused `limited`, its item kept.
   */
  private async relayOp(
    ws: WebSocket,
    player: string,
    attachment: Attachment,
    op: ClientOp['op'],
    opId: number,
    policy: AbusePolicy | null,
  ): Promise<void> {
    const { client = '', team } = attachment;
    const signals = policy?.signals;
    let suspicion = 0;
    if (signals) {
      const now = Date.now();
      // An item whose time has come but whose hold has not been sent yet arrived all the same.
      const { nextAt, arrived } = attachment;
      const fresh = isTime(nextAt) && nextAt <= now ? nextAt : (arrived ?? null);
      const view = this.views.get(ws)?.view ?? attachment.view ?? null;
      const seen = this.signals.op(player, op, view, fresh, signals, now);
      for (const kind of seen.fired) this.countAbuse(kind);
      suspicion = seen.score;
      if (signals.challengeAt > 0 && suspicion >= signals.challengeAt) {
        this.requireChallenge(player, now);
        this.countAbuse('challenged');
        ws.close(CHALLENGE_REQUIRED, 'confirm you are human');
        return;
      }
    }
    // A hammer or shield takes its use before the canvas call (ADR 0026), so ops racing each
    // other cannot all pass the allowance, and gives it back unless the canvas applied it.
    // Every use counts, limited or not, so an account whose score drops (suspicion) meets the
    // uses it already made in the window.
    const trust = policy?.trust;
    // The window the use went into: a refund goes back to it, never to a later one.
    let reserved: number | null = null;
    if ((op.kind === 'hammer' || op.kind === 'shield') && trust && policy) {
      const limit: Limit = allowance(policy, attachment.trust, suspicion) ?? {
        limit: Number.MAX_SAFE_INTEGER,
        windowMs: trust.windowMs,
      };
      reserved = this.usesByAccount.reserve(player, limit, Date.now());
      if (reserved === null) {
        this.countAbuse('trustLimited');
        send(ws, { type: 'ack', opId, ok: false, reason: 'limited' });
        return;
      }
    }
    const giveBack = () => {
      if (reserved !== null) this.usesByAccount.refund(player, reserved);
    };
    const move: PlayerOp = { player, client, opId, op, ...(team ? { team } : {}) };
    const hold = await this.enqueue({ ws, player, move, giveBack });
    if (hold) await this.ensureAlarm(hold.nextAt);
  }

  /**
   * Queues a move for the next call to the canvas (ADR 0041) and resolves, once its outcome
   * went out, with the player's hold when the call brought one. Past the moves already
   * waiting, the move is refused `busy` at once rather than acked late, as the canvas itself
   * does past its queue (ADR 0032).
   */
  private enqueue(relay: Omit<Relay, 'done' | 'answered'>): Promise<HoldView | undefined> {
    if (this.relayWaiting.length >= relayLimits.waiting) {
      relay.giveBack();
      this.ops.emit('warn', 'fanout_relay_waiting', {
        canvas: this.canvasName(),
        waiting: this.relayWaiting.length,
      });
      send(relay.ws, { type: 'ack', opId: relay.move.opId, ok: false, reason: 'busy' });
      return Promise.resolve(undefined);
    }
    return new Promise((done) => {
      this.relayWaiting.push({ ...relay, done, answered: false });
      if (!this.relaying) void this.pumpRelays();
    });
  }

  /**
   * Sends the waiting ops to the canvas (ADR 0041): one call in flight, and the ops that
   * arrive meanwhile go together in the next one, in arrival order. An op that finds no call
   * in flight goes at once.
   */
  private async pumpRelays(): Promise<void> {
    this.relaying = true;
    try {
      while (this.relayWaiting.length > 0) {
        const relays = this.relayWaiting.splice(0, relayLimits.batch);
        try {
          await this.relayBatch(relays);
        } catch (error) {
          // Not expected (relayBatch answers its own failures); no op may wait for good.
          console.error('relay failed', error);
          for (const relay of relays) {
            if (!relay.answered) this.relayUnavailable(relay);
            relay.done(undefined);
          }
        }
      }
    } finally {
      this.relaying = false;
    }
  }

  /**
   * An op whose call failed or timed out: it may or may not have been applied, and the client
   * may retry it with the same opId, which CanvasDO answers as a duplicate if it was. Its use
   * is given back: a retry that applies takes one again (an op that did apply then goes
   * uncounted, the rarer and cheaper miss).
   */
  private relayUnavailable(relay: Relay): void {
    relay.answered = true;
    relay.giveBack();
    send(relay.ws, { type: 'ack', opId: relay.move.opId, ok: false, reason: 'unavailable' });
    relay.done(undefined);
  }

  /**
   * One call to the canvas for `moves` (ADR 0043): applyBatch when they are all ops, else
   * applyMoves. A game script without applyMoves (an older deploy, a rollback) gets the ops
   * in one applyBatch call and each discard a discard() call of its own, the results in the
   * moves' order, and is remembered for this object's lifetime.
   */
  private async callCanvas(moves: readonly PlayerMove[]): Promise<RelayReply> {
    const canvas = this.canvas();
    const ops = moves.filter(isOp);
    if (ops.length === moves.length) return canvas.applyBatch(ops);
    if (this.movesSupported !== false) {
      try {
        return await canvas.applyMoves(moves);
      } catch (error) {
        if (!missingMethod(error)) throw error;
        this.movesSupported = false;
      }
    }
    const batch = ops.length > 0 ? await canvas.applyBatch(ops) : null;
    const fromBatch = batch?.results ?? [];
    const results: OpResult[] = [];
    const holds = new Map<string, HoldView>(batch?.holds ?? []);
    let next = 0;
    for (const move of moves) {
      if (!isDiscard(move)) {
        results.push(fromBatch[next++]!);
        continue;
      }
      const { player, opId, discard, client = '' } = move;
      const { result, hold } = await canvas.discard(player, opId, discard, undefined, client);
      if (!result.ok) results.push({ ok: false, reason: result.reason });
      else
        results.push(
          result.duplicate ? { ok: true, duplicate: true, diffs: [] } : { ok: true, diffs: [] },
        );
      if (hold) holds.set(player, hold);
    }
    return batch ? { ...batch, results, holds } : { results, holds };
  }

  /** One call to the canvas for `relays`, and its outcome to their sockets. */
  private async relayBatch(relays: readonly Relay[]): Promise<void> {
    let live = relays;
    let batch: RelayReply;
    try {
      // Load the mirror first (after hibernation it is gone): loaded after the ops, it would
      // already contain their diffs and they would never reach the open sockets.
      await this.loadMirror();
      // The load may have closed sockets because their grid fell behind (see restoreMirror);
      // their clients resend the ops after reconnecting.
      live = relays.filter((relay) => {
        if (relay.ws.readyState === WebSocket.OPEN) return true;
        relay.answered = true;
        relay.giveBack();
        relay.done(undefined);
        return false;
      });
      if (live.length === 0) return;
      batch = await withTimeout(
        this.callCanvas(live.map((relay) => relay.move)),
        relayLimits.timeoutMs,
      );
    } catch (error) {
      // CanvasDO restarts on every game deploy and in-flight calls fail; a stuck one times out.
      const call = live.some((relay) => isDiscard(relay.move)) ? 'applyMoves' : 'applyBatch';
      console.error(`${call} failed`, error);
      this.canvasCallFailed(call, error);
      this.markBehind();
      for (const relay of live) this.relayUnavailable(relay);
      return;
    }
    const diffs: CellDiff[] = [];
    let accepted = false;
    let fresh = false;
    live.forEach((relay, i) => {
      const result = batch.results[i]!;
      const { opId } = relay.move;
      relay.answered = true;
      // A refused op or a retry of an applied one spent nothing now.
      if (!result.ok || 'duplicate' in result) relay.giveBack();
      send(
        relay.ws,
        result.ok
          ? { type: 'ack', opId, ok: true }
          : { type: 'ack', opId, ok: false, reason: result.reason },
      );
      if (!result.ok) return;
      // A discard changes no cell: its hold goes out below, nothing to publish.
      if (isDiscard(relay.move)) return;
      accepted = true;
      if ('duplicate' in result) return;
      fresh = true;
      for (const diff of result.diffs) diffs.push(diff);
    });
    // Each player's hold once, to all of the player's sockets.
    const held = new Set<string>();
    for (const relay of live) {
      const hold = batch.holds?.get(relay.player);
      if (!hold || held.has(relay.player)) continue;
      held.add(relay.player);
      this.deliverHold(relay.player, hold, relay.ws);
    }
    const finished = () => {
      for (const relay of live) relay.done(batch.holds?.get(relay.player));
    };
    if (!accepted && !batch.rules) {
      finished();
      return;
    }
    // Queued now, so batches reach the mirror in the order their calls returned; not waited
    // for, so the next call goes out while this one's diffs wait their turn (a resync, say).
    this.serial(async () => {
      // New rules (a grown open area) reach every socket with the next op after them.
      this.adoptRules(batch.rules);
      // An accepted op came from a canvas reply, which carries the seq.
      if (!accepted || batch.seq === undefined) return;
      await this.publish(batch.seq, diffs, fresh, batch.grewAt);
      this.sendOwnCells(live, batch);
    })
      .catch((error: unknown) => {
        // The mirror is unchanged: the next accepted op sees the gap and resyncs, or, if
        // this object is evicted first, restoreMirror finds the marker.
        console.error('publish failed', error);
        this.markBehind();
      })
      .finally(finished);
  }

  /**
   * While the batch's cells wait for a flush, each op's own socket gets its op's cells now,
   * so a player sees their move with its ack (ADR 0041). They carry the mirror's values and
   * the seq of the last flush, not the batch's: the socket may still lack other cells of the
   * seqs in between, and a later seq would tell it (and a resume, ADR 0040) that it has them.
   * The flush sends the same cells again. Runs in the queue, right after publish.
   */
  private sendOwnCells(relays: readonly Relay[], batch: RelayReply): void {
    const mirror = this.mirror;
    if (!mirror || this.pendingCells === null) return;
    // Applied by this publish, not skipped as already sent or left to a resync.
    if (mirror.seq !== batch.seq && mirror.seq !== batch.grewAt) return;
    const grid = { seq: this.sentSeq, cells: mirror.cells, shields: mirror.shields };
    relays.forEach((relay, i) => {
      const result = batch.results[i]!;
      if (!result.ok || 'duplicate' in result || result.diffs.length === 0) return;
      const cells = Uint32Array.from(new Set(result.diffs.map((d) => d.index))).sort();
      // A large one (an expiry of many shields) waits for the flush.
      if (cells.length >= MAX_DIFFS_PER_FRAME) return;
      for (const frame of indexFrames(grid, cells)) sendFrame(relay.ws, frame);
    });
  }

  /**
   * A discard changes only the hold. It rides the relay queue with the ops (ADR 0043): acked
   * from the call's result, its hold sent with the call's others. No use is reserved for it
   * (ADR 0026 limits hammers and shields placed, not thrown away).
   */
  private async discard(
    ws: WebSocket,
    player: string,
    client: string,
    opId: number,
    item: ClientDiscard['discard'],
  ): Promise<void> {
    const move: PlayerDiscard = { player, client, opId, discard: item };
    const hold = await this.enqueue({ ws, player, move, giveBack: () => {} });
    if (hold) await this.ensureAlarm(hold.nextAt);
  }

  /**
   * Records, durably, that the canvas may hold ops the open sockets have not received, and
   * the last seq they did receive. The mirror is memory only: if this object is evicted
   * while behind, a mirror rebuilt from a fresh snapshot would count those cells as sent.
   * While marked, every broadcast moves the stored seq too, so it is never older than what
   * the sockets have (an older one would close them for nothing after an eviction). A call
   * that failed may still commit on the canvas for a while, whatever this side saw, so only
   * settleBehind clears it, and only once the last failure is VERIFY_DELAY old.
   */
  private markBehind(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (!this.mirror) return;
    // What the sockets have: cells waiting for a flush are not theirs yet (ADR 0041).
    if (this.readBehind() === null) this.storeBehind(this.sentSeq);
    this.scheduleCheck(this.verifyDelay);
  }

  /** The marker, read from storage at most once per object lifetime. */
  private readBehind(): number | null {
    // Not ??=: null (nothing stored) is a cached answer too.
    if (this.behind === undefined) this.behind = this.ctx.storage.kv.get<number>(SENT_SEQ) ?? null;
    return this.behind;
  }

  private storeBehind(seq: number | null): void {
    if (seq === this.readBehind()) return;
    if (seq === null) {
      this.ctx.storage.kv.delete(SENT_SEQ);
      // Settled: a pending check has nothing left to do and would only keep this object up.
      if (this.verifyTimer !== null) clearTimeout(this.verifyTimer);
      this.verifyTimer = null;
    } else {
      this.ctx.storage.kv.put(SENT_SEQ, seq);
    }
    this.behind = seq;
  }

  /** Schedules checkBehind; an infinite delay (tests only) schedules nothing. */
  private scheduleCheck(delay: number): void {
    if (this.verifyTimer !== null || !Number.isFinite(delay)) return;
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = null;
      this.checkBehind().catch((error) => {
        console.error('behind check failed', error);
      });
    }, delay);
  }

  /**
   * The sockets now have everything the canvas had up to `seq` (a resync, or a check that
   * found the canvas level). Clears the marker if no failure came since `failuresBefore`
   * and the last one is at least VERIFY_DELAY old, by when a failed call is taken to have
   * committed or never to; otherwise keeps it, at `seq`, and checks again once it is.
   * Runs in the queue.
   */
  private settleBehind(seq: number, failuresBefore: number): void {
    const age = Date.now() - this.lastFailure;
    if (this.failures === failuresBefore && age >= this.verifyDelay) {
      this.storeBehind(null);
      return;
    }
    this.storeBehind(seq);
    this.scheduleCheck(Math.max(0, this.verifyDelay - age));
  }

  /**
   * Repairs a lost reply without waiting for the next op to show a gap, and settles the
   * marker: asks the canvas for its seq (no grid copy), resyncs if it is ahead of the
   * mirror, and otherwise settles at the mirror's seq. The question goes out of the queue,
   * so a canvas still replaying its log holds up neither joins nor ops; only the comparison
   * runs in it.
   */
  private async checkBehind(): Promise<void> {
    if (this.readBehind() === null) return;
    const failuresBefore = this.failures;
    let seq: number;
    try {
      seq = (await this.canvas().status()).seq;
    } catch (error) {
      // The canvas is still restarting: ask again later, still marked.
      console.error('canvas status failed', error);
      this.scheduleCheck(this.alarmRetry);
      return;
    }
    try {
      await this.serial(async () => {
        const mirror = this.mirror;
        if (!mirror || this.readBehind() === null) return;
        if (seq <= mirror.seq) this.settleBehind(this.sentSeq, failuresBefore);
        // Following: the canvas's next tick brings what is missing (ADR 0028); check again
        // once it had time to, rather than copy the whole grid. No tick for the stall time
        // while the canvas is ahead: it stopped pushing to this shard, which follows again.
        else if (mirror.following && Date.now() - this.lastTickAt < watchdogTiming.stallMs) {
          this.scheduleCheck(this.verifyDelay);
        } else await this.resync(mirror, mirror.following);
      });
    } catch (error) {
      // The resync's snapshot failed: the sockets may still miss an op, so ask again later
      // rather than wait for the next op to show the gap.
      console.error('behind resync failed', error);
      this.scheduleCheck(this.alarmRetry);
    }
  }

  /**
   * Builds the mirror after a restart or eviction. The canvas says what the open sockets
   * missed when it knows (`changes`: since the seq a tick named, or since the last tick this
   * shard acknowledged): they get it at once. When it cannot say, and the sockets were marked
   * behind with the canvas moved on since, there is no record of what they miss: close them
   * so they reconnect and start from a fresh grid.
   */
  private restoreMirror(reply: FollowReply | Snapshot): Mirror {
    const following = 'following' in reply && reply.following === true;
    const changes = following ? (reply as FollowReply).changes : null;
    const sent = this.readBehind();
    // Following, the canvas pushes every change to this shard; when it cannot say what the
    // open sockets missed (it restarted and lost this shard's cursor, its tick ring no longer
    // reaches it, or a tick named too many cells), they may miss anything. Not followed (a
    // canvas without the FANOUT binding or with too many shards, or a game script from before
    // follow()): the rules from before ADR 0028, the marker alone. Every op then goes through
    // one shard (FANOUT_SHARDS must be 1 there), so only a reply lost while this object was
    // gone can have left the sockets behind; closing them on every wake would make quiet
    // shards reconnect again and again.
    const stale = following ? changes === null : sent !== null && reply.seq > sent;
    this.lastTickAt = Date.now();
    if (stale) this.closeStale(following ? 'unknown_cursor' : 'marker');
    if (sent !== null) this.storeBehind(null);
    const mirror = toMirror(reply);
    // The rules may have changed while this object was gone, and nothing records which ones
    // the open sockets have: send them again (a few bytes each).
    const config = rulesFrame(mirror.rules);
    if (config) this.broadcast([config]);
    if (changes !== null && changes.byteLength > 0) {
      this.broadcastRecords(mirror, reply.seq, changes);
    }
    this.sentSeq = reply.seq;
    // Tile frames owed from before the eviction go out now, not with the next change.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      let owed = false;
      try {
        owed = ((ws.deserializeAttachment() as Attachment | null)?.owed?.length ?? 0) > 0;
      } catch {
        owed = false;
      }
      if (owed) this.viewOf(ws, mirror);
    }
    return mirror;
  }

  /**
   * Sends new rules to every socket. Replies can arrive out of order (and a rejected op's
   * reply carries rules too), so rules read at an older canvas seq than the ones already
   * sent are ignored: they could shrink the area back. Runs in the queue.
   */
  private adoptRules(rules: Rules | null | undefined): void {
    const mirror = this.mirror;
    if (!mirror || !rules) return;
    if (mirror.rules && olderRules(rules, mirror.rules)) return;
    const changed = !sameRules(mirror.rules, rules);
    mirror.rules = rules;
    if (!changed) return;
    const frame = rulesFrame(rules);
    if (frame) this.broadcast([frame]);
  }

  /**
   * After a join, now and then (SOCKET_COUNT_MS): a sampled `fanout_sockets_high` once this
   * object holds SOCKETS_WARN sockets or more. Counting builds an array of every socket, so it
   * is not done on every join.
   */
  private countSockets(canvas: string): void {
    const now = Date.now();
    if (now - this.socketsCountedAt < SOCKET_COUNT_MS) return;
    this.socketsCountedAt = now;
    const sockets = this.ctx.getWebSockets().length;
    const warnAt = this.socketsWarnAt;
    if (sockets >= warnAt)
      this.ops.emit('warn', 'fanout_sockets_high', { canvas, sockets, warnAt });
  }

  /**
   * A sampled `fanout_canvas_call_failed`: calls to CanvasDO fail during every game deploy (it
   * restarts), so one now and then is expected; a steady stream, or `overloaded`, means the
   * canvas cannot keep up. No player id: only the call and the error's kind.
   */
  private canvasCallFailed(call: string, error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    this.ops.emit('warn', 'fanout_canvas_call_failed', {
      canvas: this.ctx.storage.kv.get<string>('canvas') ?? STAGE0_CANVAS,
      call,
      overloaded: /overloaded/i.test(text),
    });
  }

  /**
   * The CanvasDO this object relays to: the canvas pinned by its first socket (ADR 0021), or
   * the Stage 0 one for an object from before seasons.
   */
  private canvas(): DurableObjectStub<CanvasDO> {
    const name = this.ctx.storage.kv.get<string>('canvas') ?? STAGE0_CANVAS;
    return this.env.CANVAS.get(this.env.CANVAS.idFromName(name));
  }

  /** Runs tasks one at a time, in call order; a failed task does not stop the next. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The mirror, loaded through CanvasDO.follow when there is none: the canvas then pushes this
   * shard its ticks. `since` is the seq the open sockets have, when a tick says so.
   */
  private loadMirror(since: number | null = null): Promise<Mirror> {
    if (this.mirror) return Promise.resolve(this.mirror);
    this.loading ??= this.followCanvas(since)
      .then((reply) => {
        this.mirror ??= this.restoreMirror(reply);
        return this.mirror;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /**
   * CanvasDO.follow, from the lowest seq the open sockets are known to have: `since` (a tick's
   * known cursor) or the behind marker, whichever is older. A game script that predates
   * follow (a rollback of the game deploy) gets snapshot() instead, and this shard then
   * repairs gaps by resyncs as before.
   */
  private async followCanvas(since: number | null): Promise<FollowReply | Snapshot> {
    const sent = this.readBehind();
    const from = sent === null ? since : since === null ? sent : Math.min(since, sent);
    if (!this.followMissing) {
      try {
        // The open sockets tell the canvas whether a lost reply could cost anything.
        const sockets = this.ctx.getWebSockets().length;
        // With its recent changes, to seed the list resuming pages are served from (ADR
        // 0040); a canvas that predates them ignores the argument.
        return await this.canvas().follow(this.shardName(), from, sockets, RESUME_CELLS);
      } catch (error) {
        if (!missingMethod(error)) throw error;
        console.error('canvas has no follow(); taking a snapshot instead', error);
        this.followMissing = true;
      }
    }
    return this.canvas().snapshot();
  }

  /**
   * How the canvas reaches this shard: its name. One known only by its id (never the case
   * for shards the gateway names) is refused by the canvas and does not follow.
   */
  private shardName(): string {
    return this.ctx.id.name ?? `id:${this.ctx.id.toString()}`;
  }

  /**
   * A diff tick from the canvas (ADR 0028): every cell changed after `push.from` (this shard's
   * cursor on the canvas), at its value at `push.to`. Cells the mirror already has (from a
   * reply, or a snapshot) are not sent again. Runs in the queue, so it keeps frame order with
   * joins and replies. Answers with the seq the sockets now have; with no socket left it drops
   * the mirror and says so, and the canvas stops pushing until a socket joins again.
   */
  async tick(push: TickPush<Rules>): Promise<TickReply> {
    return this.serial(async () => {
      const sockets = this.ctx.getWebSockets().length;
      if (sockets === 0) {
        this.mirror = null;
        return { seq: push.to, sockets: 0 };
      }
      // The canvas pushes to this shard: what the watchdog waits for.
      this.lastTickAt = Date.now();
      // Evicted since the last tick: the canvas brings the sockets from `from` to its seq, when
      // `from` is a cursor this shard acknowledged. Otherwise (the canvas restarted) it says
      // what it still knows, or nothing, and the sockets are closed.
      const mirror = await this.loadMirror(push.known === false ? null : push.from);
      this.adoptRules(push.rules);
      if (push.to > mirror.seq) {
        if (push.records === null || push.from > mirror.seq) {
          // The canvas cannot say what changed since this shard's seq.
          await this.resync(mirror);
        } else {
          this.applyRecords(mirror, push.to, push.records);
        }
      }
      // The cursor the canvas keeps for this shard: what its sockets have, so cells still
      // waiting for a flush come again with the next push (the mirror skips them then).
      return { seq: this.mirror ? this.sentSeq : push.to, sockets };
    });
  }

  /**
   * Takes records into the mirror at `seq` and sends the sockets the cells that changed.
   * While marked behind, the stored seq follows what the sockets have.
   */
  private applyRecords(mirror: Mirror, seq: number, records: Uint8Array): void {
    const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
    const fresh = new Uint8Array(records.byteLength);
    // Every cell the records name, unchanged ones included (ADR 0040): a cell changed and
    // changed back within the step must still reach a page that saw it in between.
    const touched = new Uint32Array(records.byteLength / RECORD_BYTES);
    let named = 0;
    let kept = 0;
    for (let at = 0; at + RECORD_BYTES <= records.byteLength; at += RECORD_BYTES) {
      const index = view.getUint32(at, true);
      const cell = records[at + 4]!;
      const shield = records[at + 5]!;
      if (index >= mirror.cells.length) continue;
      touched[named++] = index;
      if (mirror.cells[index] === cell && mirror.shields[index] === shield) continue;
      mirror.cells[index] = cell;
      mirror.shields[index] = shield;
      fresh.set(records.subarray(at, at + RECORD_BYTES), kept);
      kept += RECORD_BYTES;
    }
    mirror.changes.record(seq, touched.subarray(0, named));
    // The cached grid frames name the seq: new sockets must start from the current one.
    if (seq !== mirror.seq) mirror.frames = null;
    mirror.seq = seq;
    if (kept > 0) {
      mirror.frames = null;
      mirror.tileFrames = null;
      // Sent with the next flush, at the values the mirror has then (end values: a cell
      // changed again before it is sent once).
      this.pendingCells ??= new Set();
      const pending = this.pendingCells;
      const sent = new DataView(fresh.buffer, 0, kept);
      for (let at = 0; at < kept; at += RECORD_BYTES) pending.add(sent.getUint32(at, true));
      if (pending.size >= MAX_PENDING_CELLS) this.flushCells();
    }
    // Nothing waits for a flush: the sockets have everything up to here.
    if (this.pendingCells === null) {
      this.sentSeq = mirror.seq;
      if (this.readBehind() !== null) this.storeBehind(mirror.seq);
      return;
    }
    this.scheduleFlush();
  }

  /**
   * Sends the cells changed since the last flush (ADR 0041), at their values in the mirror
   * and at its seq, to every socket that views them. At most every flushTiming.ms: a change
   * after a quiet spell goes out at once, the rest wait for the next flush. Runs in the queue.
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    const wait = this.lastFlushAt + flushTiming.ms - Date.now();
    if (wait <= 0) {
      this.flushCells();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.serial(async () => this.flushCells()).catch((error: unknown) => {
        console.error('flush failed', error);
      });
    }, wait);
  }

  /** Sends the pending cells now (see scheduleFlush). Runs in the queue. */
  private flushCells(): void {
    const mirror = this.mirror;
    const pending = this.pendingCells;
    this.pendingCells = null;
    this.lastFlushAt = Date.now();
    if (!mirror || !pending || pending.size === 0) return;
    const indices = Uint32Array.from(pending).sort();
    const records = new Uint8Array(indices.length * RECORD_BYTES);
    const out = new DataView(records.buffer);
    indices.forEach((index, i) => {
      out.setUint32(i * RECORD_BYTES, index, true);
      records[i * RECORD_BYTES + 4] = mirror.cells[index]!;
      records[i * RECORD_BYTES + 5] = mirror.shields[index]!;
    });
    this.broadcastRecords(mirror, mirror.seq, records);
    this.sentSeq = mirror.seq;
    if (this.readBehind() !== null) this.storeBehind(mirror.seq);
  }

  /**
   * Takes a batch's accepted diffs into the mirror, in seq order, for the next flush.
   * `fresh` says whether any op of the batch was applied by this call (not only retries of
   * applied ones). `grewAt` is the seq of the open-area growth the batch set off (seq + 1):
   * that log row changes no cell, so once the batch's diffs are out the sockets are complete
   * up to it, and the mirror moves past it rather than seeing a gap there (or, while marked,
   * leaving a stored seq that would close sockets for nothing after an eviction). Runs inside
   * the serial queue.
   */
  private async publish(
    seq: number,
    diffs: readonly CellDiff[],
    fresh: boolean,
    grewAt?: number,
  ): Promise<void> {
    const mirror = await this.loadMirror();
    // Already in the mirror, and already sent, through a resync or a tick.
    if (seq <= mirror.seq) return;
    if (seq === mirror.seq + 1 && fresh) {
      // Can exceed one frame: the first op after a quiet spell also carries an expiry diff
      // for every shielded cell whose layers ran out. The frames split under one seq.
      this.applyRecords(mirror, seq, toRecords(diffs));
      if (grewAt === seq + 1) {
        mirror.seq = grewAt;
        mirror.frames = null;
        // With a flush still to come, it moves the marker once the cells are out.
        if (this.pendingCells === null) {
          this.sentSeq = grewAt;
          if (this.readBehind() !== null) this.storeBehind(mirror.seq);
        }
      }
      return;
    }
    // A seq is missing: another shard's op, a lost reply (CanvasDO committed, then restarted
    // before answering; the retry's duplicate answer shows it) or replies out of order. A
    // following shard gets it with the next tick, which the watchdog makes sure of; otherwise
    // only a resync can tell.
    if (mirror.following) this.scheduleWatch(watchdogTiming.stallMs);
    else await this.resync(mirror);
  }

  /**
   * Brings the mirror up to the canvas and sends every cell that changed in one go. With
   * `refollow` the new grid comes from follow() (the watchdog: the canvas stopped pushing),
   * which registers this shard again, or from a snapshot when the game script has no follow().
   * Either way the open sockets get every cell that differs from the old mirror.
   */
  private async resync(old: Mirror, refollow = false): Promise<void> {
    const failuresBefore = this.failures;
    const fresh = refollow ? await this.followCanvas(old.seq) : await this.canvas().snapshot();
    const following = refollow ? 'following' in fresh && fresh.following === true : old.following;
    this.lastTickAt = Date.now();
    if (fresh.seq <= old.seq) {
      old.following = following;
      return;
    }
    // Cells the old mirror took but has not sent yet go first: the differences below are
    // counted from the old mirror, so they would not name them.
    this.flushCells();
    const records = changedRecords(old, fresh, this.resyncCellCap);
    // The change list carries on (ADR 0040) with the cells this resync sends, or afresh from
    // the new seq when there are too many to list. A resync knows only the cells that differ
    // at its end, not those changed and changed back: a page inside it cannot resume from it.
    const mirror: Mirror = {
      ...toMirror(fresh),
      rules: old.rules,
      following,
      changes: old.changes,
    };
    if (records === null) mirror.changes.reset(fresh.seq);
    else mirror.changes.record(fresh.seq, recordIndices(records), false);
    this.mirror = mirror;
    // Too many cells to send (at most RESYNC_CELL_CAP records are built, 1.5 MiB): the open
    // sockets reconnect and get the grid instead.
    if (records === null) this.closeStale('too_many_changes');
    else this.broadcastRecords(mirror, fresh.seq, records);
    this.sentSeq = fresh.seq;
    this.adoptRules(fresh.rules);
    // The open sockets now hold everything up to the snapshot's seq. A failure while the
    // snapshot was on its way, or one too recent to rule out a late commit, keeps them
    // marked, at the seq just sent.
    this.settleBehind(fresh.seq, failuresBefore);
  }

  /** Runs the watchdog once, `delay` ms from now (a gap in the replies while following). */
  private scheduleWatch(delay: number): void {
    if (this.watchTimer !== null || !Number.isFinite(delay)) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.watch().catch((error: unknown) => {
        console.error('tick watchdog failed', error);
      });
    }, delay);
  }

  /**
   * The tick watchdog (ADR 0028). A following shard relies on the canvas's pushes; if they
   * stop while the map changes (a canvas that lost this shard, pushes that keep failing),
   * nothing else brings its sockets the other shards' changes. Asks the canvas, cheaply,
   * whether it still follows this shard and how far its log is; follows again when it does
   * not, or when it is ahead and no tick came for the stall time (the backoff grace while the
   * canvas retries on its own). Without a mirror (evicted or hibernated) it loads one only when
   * the canvas does not follow this shard, which then repairs or closes the open sockets. A
   * game script without cursor() (rolled back): nothing. Run by the alarm while sockets are
   * open, and soon after a gap in the replies.
   */
  async watch(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    let cursor: {
      seq: number;
      following: boolean;
      backingOff?: boolean;
      registrable?: boolean;
      // Tuples arrive as plain arrays over RPC; takePresence() checks each pair.
      presence?: { readonly playing: number; readonly teams: readonly (readonly number[])[] };
    } | null;
    try {
      // The call carries this shard's counts (ADR 0030); a canvas that predates them ignores
      // the argument and answers without totals.
      cursor = await this.canvas().cursor(this.shardName(), this.presenceReport());
    } catch (error) {
      if (!missingMethod(error)) throw error;
      cursor = null;
    }
    if (cursor?.presence) {
      // Advisory: a bad answer must never keep the watchdog from its repairs below.
      try {
        this.takePresence(cursor.presence);
      } catch (error) {
        console.error('presence totals not taken', error);
      }
    }
    await this.serial(async () => {
      const mirror = this.mirror;
      // A canvas with cursor() has follow() again (deployed again after a rollback).
      if (cursor !== null) this.followMissing = false;
      if (cursor === null || (cursor.registrable === false && !cursor.following)) {
        // A game script from before ADR 0028 (rolled back), or a canvas that cannot push to
        // this shard (no FANOUT binding, every slot taken): the rules from before ADR 0028
        // apply. Nothing is reloaded or closed, and following again would bring no pushes;
        // a gap in the replies resyncs, as it did then. (Several shards against such a
        // canvas are not supported: FANOUT_SHARDS goes back to 1 first.) A mirror that still
        // counted on pushes catches up once from a snapshot, for a gap it may have let pass.
        if (mirror?.following) {
          mirror.following = false;
          await this.resync(mirror);
        }
        return;
      }
      if (!mirror) {
        if (!cursor.following) {
          this.refollowed('not_followed');
          await this.loadMirror();
        }
        return;
      }
      const quietFor = Date.now() - this.lastTickAt;
      const stalled = quietFor >= watchdogTiming.stallMs;
      if (!cursor.following) {
        if (mirror.following || stalled) {
          this.refollowed('not_followed');
          await this.resync(mirror, true);
        }
        return;
      }
      mirror.following = true;
      // The canvas follows this shard and is ahead. If its pushes to this shard are failing,
      // it retries on its own (backing off up to 30 s): follow again only past that.
      const waited = cursor.backingOff ? watchdogTiming.backoffGraceMs : watchdogTiming.stallMs;
      if (cursor.seq > mirror.seq && stalled && quietFor >= waited) {
        this.refollowed('stalled');
        await this.resync(mirror, true);
      }
    });
  }

  /**
   * This shard's sockets as counts for the canvas (ADR 0030): the playing ones (a socket per
   * account, ADR 0026), and those per team. Watching sockets do not count.
   */
  private presenceReport(): PresenceReport {
    let players = 0;
    const teams = new Map<number, number>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment?.player) continue;
      players++;
      const team = attachment.team;
      if (team) teams.set(team, (teams.get(team) ?? 0) + 1);
    }
    return { players, teams: [...teams] };
  }

  /** Keeps the canvas's totals and sends every socket its Stats frame. */
  private takePresence(totals: {
    readonly playing: number;
    readonly teams: readonly (readonly number[])[];
  }): void {
    const count = (n: unknown): n is number =>
      Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_STATS_COUNT;
    if (!count(totals.playing) || !Array.isArray(totals.teams)) return;
    const teams = new Map<number, number>();
    for (const pair of totals.teams as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [team, n] = pair as [unknown, unknown];
      if (Number.isInteger(team) && count(n)) teams.set(team as number, n);
    }
    this.presence = { playing: totals.playing, teams };
    for (const ws of this.ctx.getWebSockets()) {
      const frame = this.statsFrame(ws.deserializeAttachment() as Attachment | null);
      if (frame) sendFrame(ws, frame);
    }
  }

  /**
   * A socket's Stats frame from the last totals: everyone playing, and its own team's total
   * (counting itself, should the canvas not have it yet). Null before any totals arrived.
   */
  private statsFrame(attachment: Attachment | null): Uint8Array | null {
    const presence = this.presence;
    if (!presence) return null;
    const team = attachment?.player ? attachment.team : undefined;
    return encodeServerMessage({
      type: 'stats',
      playing: Math.max(presence.playing, attachment?.player ? 1 : 0),
      team: team ? Math.max(presence.teams.get(team) ?? 0, 1) : null,
    });
  }

  /**
   * The canvas's stats for GET /api/stats (ADR 0030), asked through this shard: the gateway
   * binds FanoutDO, not CanvasDO. Null when the canvas predates stats().
   */
  async stats(canvas: string): Promise<StatsReply | null> {
    if (typeof canvas !== 'string' || !CANVAS_NAME.test(canvas)) return null;
    try {
      const { playing, phase, filled, built, growsAt, rates } = await this.env.CANVAS.get(
        this.env.CANVAS.idFromName(canvas),
      ).stats();
      // An older game script sends neither; JSON then leaves them out.
      return { playing, phase, filled, built, growsAt, rates };
    } catch (error) {
      if (missingMethod(error)) return null;
      throw error;
    }
  }

  /**
   * One player's season numbers (ADR 0031), asked through this shard for the gateway, which
   * names the signed-in account. Null when the canvas predates playerSeason().
   */
  async playerSeason(canvas: string, player: string): Promise<SeasonNumbers | null> {
    if (typeof canvas !== 'string' || !CANVAS_NAME.test(canvas)) return null;
    try {
      const { bricks, hammers, shields, days } = await this.env.CANVAS.get(
        this.env.CANVAS.idFromName(canvas),
      ).playerSeason(player);
      return { bricks, hammers, shields, days };
    } catch (error) {
      if (missingMethod(error)) return null;
      throw error;
    }
  }

  /** A sampled `fanout_refollow` (docs/ops/alerts.md). */
  private refollowed(reason: 'not_followed' | 'stalled'): void {
    this.ops.emit('warn', 'fanout_refollow', { canvas: this.canvasName(), reason });
  }

  /** Closes every open socket with 1012 and logs a sampled `fanout_stale_closed`. */
  private closeStale(reason: 'unknown_cursor' | 'marker' | 'too_many_changes'): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    this.ops.emit('warn', 'fanout_stale_closed', {
      canvas: this.canvasName(),
      sockets: sockets.length,
      reason,
    });
    for (const ws of sockets) {
      try {
        ws.close(1012, 'grid out of date; reconnect');
      } catch {
        // Already closing.
      }
    }
  }

  /** Frames for every socket. */
  private broadcast(frames: readonly Uint8Array[]): void {
    for (const peer of this.ctx.getWebSockets()) {
      for (const frame of frames) sendFrame(peer, frame);
    }
  }

  /**
   * Changed cells (records, at `seq`) to every socket, each getting only the tiles it views.
   * Sockets that view the same changed tiles share frames.
   */
  private broadcastRecords(mirror: Mirror, seq: number, records: Uint8Array): void {
    if (records.byteLength === 0) return;
    const frames = new TickFrames(seq, records, mirror.tiles);
    for (const peer of this.ctx.getWebSockets()) {
      for (const frame of frames.framesFor(this.viewOf(peer, mirror).mask)) sendFrame(peer, frame);
    }
  }

  // ---- views (ADR 0028) ---------------------------------------------------------------

  /** The socket's view state, from memory or, after an eviction, from its attachment. */
  private viewOf(ws: WebSocket, mirror: Mirror): ViewState {
    let state = this.subscriptions.get(ws);
    if (state) return state;
    let attachment: Attachment | null = null;
    try {
      attachment = ws.deserializeAttachment() as Attachment | null;
    } catch {
      attachment = null;
    }
    const tiles = attachment?.tiles;
    state = {
      mask: tiles
        ? maskOf({ x: tiles[0], y: tiles[1], w: tiles[2], h: tiles[3] }, mirror.tiles)
        : null,
      appliedAt: Number.NEGATIVE_INFINITY,
      pending: null,
      owed: [...(attachment?.owed ?? [])],
      tokens: this.tileBurst,
      refilledAt: Date.now(),
    };
    this.subscriptions.set(ws, state);
    // Tile frames still owed from before an eviction go out as the budget allows.
    if (state.owed.length > 0) this.scheduleViews(Date.now());
    return state;
  }

  /** Stores the socket's owed tiles on its attachment when they changed. */
  private keepOwed(ws: WebSocket, state: ViewState): void {
    try {
      const old = ws.deserializeAttachment() as Attachment | null;
      const before = old?.owed ?? [];
      if (before.length === state.owed.length && before.every((t, i) => t === state.owed[i])) {
        return;
      }
      const attachment: Attachment = { ...old };
      if (state.owed.length > 0) (attachment as { owed?: number[] }).owed = [...state.owed];
      else delete (attachment as { owed?: number[] }).owed;
      ws.serializeAttachment(attachment);
    } catch (error) {
      this.attachmentFailed(ws, 'owed', error);
    }
  }

  /**
   * An attachment that could not be written: nothing to do for a socket already closing; for
   * an open one, a sampled `fanout_attachment_failed` (what it holds is lost on an eviction).
   */
  private attachmentFailed(ws: WebSocket, field: 'owed' | 'tiles', error: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    this.ops.emit('warn', 'fanout_attachment_failed', {
      canvas: this.canvasName(),
      field,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * A subscribing View frame (cells): applied at once, or, within VIEW_MIN_MS of the last one,
   * when that interval ends (the latest view wins). Views reach the mirror's seq through the
   * queue; while one waits there, a newer one replaces it rather than queueing another.
   */
  private requestView(ws: WebSocket, rect: Rect): void {
    const queued = this.queuedViews.get(ws);
    if (queued) {
      queued.rect = rect;
      return;
    }
    const now = Date.now();
    const state = this.subscriptions.get(ws);
    if (state && now - state.appliedAt < VIEW_MIN_MS) {
      state.pending = rect;
      this.scheduleViews(state.appliedAt + VIEW_MIN_MS);
      return;
    }
    const entry = { rect };
    this.queuedViews.set(ws, entry);
    this.serial(async () => {
      this.queuedViews.delete(ws);
      const mirror = await this.loadMirror();
      this.applyView(ws, mirror, entry.rect);
    }).catch((error: unknown) => {
      console.error('view failed', error);
    });
  }

  /**
   * Narrows (or widens) the socket's diffs to the tiles of the cells `rect` shows (viewTiles:
   * the tiles touched plus a margin), stores the view on the socket, and sends a Tile frame
   * for each tile newly followed, as the byte budget allows. Runs in the queue.
   */
  private applyView(ws: WebSocket, mirror: Mirror, rect: Rect): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const state = this.viewOf(ws, mirror);
    const followed = viewTiles(rect, mirror.tiles.size);
    const mask = maskOf(followed, mirror.tiles);
    const added = addedTiles(state.mask, mask, mirror.tiles);
    state.mask = mask;
    state.appliedAt = Date.now();
    state.pending = null;
    state.owed = [...state.owed.filter((t) => maskHas(mask, t)), ...added];
    try {
      const old = ws.deserializeAttachment() as Attachment | null;
      // Only the subscription: the view itself is the bot signal's (keepView), kept for
      // playing sockets only and written at its own pace.
      const attachment: Attachment = {
        ...old,
        tiles: [followed.x, followed.y, followed.w, followed.h],
      };
      ws.serializeAttachment(attachment);
    } catch (error) {
      this.attachmentFailed(ws, 'tiles', error);
    }
    this.sendOwed(ws, state, mirror);
  }

  /** Sends owed Tile frames while the socket's byte budget lasts; the rest wait for it. */
  private sendOwed(ws: WebSocket, state: ViewState, mirror: Mirror): void {
    const now = Date.now();
    state.tokens = Math.min(
      this.tileBurst,
      state.tokens + Math.max(0, now - state.refilledAt) * this.tileBytesPerMs,
    );
    state.refilledAt = now;
    // The object's own budget too: many sockets swinging their views at once cannot make it
    // send more than OBJECT_TILE_BYTES_PER_MS of tiles in all.
    this.objectTileTokens = Math.min(
      this.objectTileBurst,
      this.objectTileTokens +
        Math.max(0, now - this.objectTileRefilledAt) * this.objectTileBytesPerMs,
    );
    this.objectTileRefilledAt = now;
    while (state.owed.length > 0 && state.tokens > 0 && this.objectTileTokens > 0) {
      const tile = state.owed.shift()!;
      mirror.tileFrames ??= new Map();
      let frame = mirror.tileFrames.get(tile);
      if (!frame) {
        frame = tileFrame(mirror, mirror.tiles, tile);
        mirror.tileFrames.set(tile, frame);
      }
      sendFrame(ws, frame);
      state.tokens -= frame.byteLength;
      this.objectTileTokens -= frame.byteLength;
    }
    this.keepOwed(ws, state);
    if (state.owed.length > 0) {
      const wait = Math.max(
        Math.ceil(-state.tokens / this.tileBytesPerMs),
        Math.ceil(-this.objectTileTokens / this.objectTileBytesPerMs),
      );
      this.scheduleViews(now + Math.max(0, wait) + 1);
    }
  }

  private scheduleViews(at: number): void {
    if (at >= this.viewTimerAt) return;
    if (this.viewTimer !== null) clearTimeout(this.viewTimer);
    this.viewTimerAt = at;
    this.viewTimer = setTimeout(
      () => {
        this.viewTimer = null;
        this.viewTimerAt = Number.POSITIVE_INFINITY;
        this.serial(async () => this.runViews()).catch((error: unknown) => {
          console.error('views failed', error);
        });
      },
      Math.max(0, at - Date.now()),
    );
  }

  /** Applies the views that waited and sends the tiles owed. Runs in the queue. */
  private async runViews(): Promise<void> {
    const mirror = await this.loadMirror();
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.subscriptions.get(ws);
      if (!state) continue;
      if (state.pending) {
        if (now - state.appliedAt >= VIEW_MIN_MS) this.applyView(ws, mirror, state.pending);
        else this.scheduleViews(state.appliedAt + VIEW_MIN_MS);
      } else if (state.owed.length > 0) {
        this.sendOwed(ws, state, mirror);
      }
    }
  }
}

/**
 * True for the error of an RPC to a method the other script's class does not have (a game
 * script from before the method). Only the runtime's own text: a TypeError thrown inside the
 * canvas must surface as the failure it is, not pass for an older script.
 */
function missingMethod(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /does not implement the method/.test(text);
}

function maskHas(mask: TileMask, tile: number): boolean {
  return ((mask[tile >> 3] ?? 0) & (1 << (tile & 7))) !== 0;
}

/** The cell indices of records ([index u32][cell u8][shield u8] each). */
function recordIndices(records: Uint8Array): Uint32Array {
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  const out = new Uint32Array(Math.floor(records.byteLength / RECORD_BYTES));
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * RECORD_BYTES, true);
  return out;
}

/** Records of every cell that differs between two grids of the same size, at `fresh`'s values. */
function changedRecords(
  old: Pick<Mirror, 'cells' | 'shields'>,
  fresh: Pick<Snapshot, 'cells' | 'shields'>,
  cap: number,
): Uint8Array | null {
  const { cells, shields } = fresh;
  let count = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== old.cells[i] || shields[i] !== old.shields[i]) count++;
  }
  // Past the cap the records (and every socket's frames of them) would cost more than the
  // sockets reconnecting for a fresh grid.
  if (count > cap) return null;
  const records = new Uint8Array(count * RECORD_BYTES);
  const view = new DataView(records.buffer);
  let at = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === old.cells[i] && shields[i] === old.shields[i]) continue;
    view.setUint32(at, i, true);
    records[at + 4] = cells[i]!;
    records[at + 5] = shields[i]!;
    at += RECORD_BYTES;
  }
  return records;
}

/**
 * The frame for a hold, or null (logged) when this build cannot encode it, e.g. an item kind
 * a newer game script hands out. The map and the acks keep working without it.
 */
function encodeHold(hold: HoldView): Uint8Array | null {
  try {
    return holdFrame(hold, Date.now());
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    console.error('unencodable hold', error);
    return null;
  }
}

function toMirror(reply: FollowReply | Snapshot): Mirror {
  const { seq, cells, shields, rules } = reply;
  return {
    seq,
    cells,
    shields,
    frames: null,
    tileFrames: null,
    rules: rules ?? null,
    following: 'following' in reply && reply.following === true,
    tiles: tileGrid(Math.round(Math.sqrt(cells.length))),
    changes: seededChanges(reply),
    resumes: null,
  };
}

/**
 * A new mirror's change list: from the canvas's recent cells when follow() sent them (ADR
 * 0040), checked; otherwise empty, starting at the snapshot.
 */
function seededChanges(reply: FollowReply | Snapshot): ChangeLog {
  const recent = 'recent' in reply ? reply.recent : undefined;
  if (!recent || !Number.isSafeInteger(recent.from) || !Array.isArray(recent.ticks)) {
    return new ChangeLog(reply.seq);
  }
  // Tick by tick, as the canvas cut them, so a page resumes from its own tick, not the first.
  // A list that does not run in order up to the snapshot is not used.
  let at = recent.from;
  let cells = 0;
  for (const tick of recent.ticks) {
    if (!Number.isSafeInteger(tick?.to) || tick.to <= at || !(tick.cells instanceof Uint32Array)) {
      return new ChangeLog(reply.seq);
    }
    at = tick.to;
    cells += tick.cells.length;
  }
  if (at !== reply.seq || cells > RESUME_CELLS) return new ChangeLog(reply.seq);
  const log = new ChangeLog(recent.from);
  for (const tick of recent.ticks) log.record(tick.to, tick.cells);
  return log;
}

/**
 * True when clients may send views (ADR 0028): the map is cut into whole tiles, as every map
 * of ADR 0004 is.
 */
function viewsUsable(mapSize: number): boolean {
  return mapSize > 0 && (mapSize % VIEW_TILE === 0 || mapSize < VIEW_TILE);
}

/** The config frame for these rules, or null (logged) when there are none or they cannot be encoded. */
function rulesFrame(rules: Rules | null): Uint8Array | null {
  if (rules === null) return null;
  try {
    return configFrame(rules, viewsUsable(rules.mapSize));
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    console.error('unencodable rules', error);
    return null;
  }
}

/** A `since` query value: a seq as decimal digits, or null for anything else. */
function sinceOf(value: string | null): number | null {
  return value !== null && /^\d{1,10}$/.test(value) ? Number(value) : null;
}

/** Most sets of resume frames a mirror keeps for one seq (each at most 768 KiB). */
const MAX_RESUME_SETS = 4;

/**
 * What a page holding the whole map up to `since` gets instead of the grid (ADR 0040): a
 * Resume frame, then the cells changed after the step that holds `since`, at the mirror's
 * values. Null when the page claims more than the mirror has, or the list does not reach it
 * (or too much changed): the page then gets the whole map. Pages resuming from one step share
 * the frames until the mirror moves.
 */
function resumeFrames(mirror: Mirror, since: number): Uint8Array[] | null {
  if (since > mirror.seq) return null;
  // Where it resumes from costs no cell read; the frames are built once per step and seq.
  const point = mirror.changes.locate(since);
  if (point === null) return null;
  if (mirror.resumes?.seq !== mirror.seq) mirror.resumes = { seq: mirror.seq, frames: new Map() };
  const sets = mirror.resumes.frames;
  if (sets.has(point.from)) return sets.get(point.from)!;
  const cells = mirror.changes.cells(point);
  const frames =
    cells === null
      ? null
      : [encodeServerMessage({ type: 'resume', from: point.from }), ...indexFrames(mirror, cells)];
  // Too many cells is remembered too, so pages at that step do not each count them again.
  if (sets.size >= MAX_RESUME_SETS) sets.delete(sets.keys().next().value!);
  sets.set(point.from, frames);
  return frames;
}

/** The non-empty cells of the mirror; a client starts from an empty grid. */
function gridFrames(mirror: Mirror): Uint8Array[] {
  const { cells, shields } = mirror;
  mirror.frames ??= cellFrames(mirror, (i) => cells[i] !== 0 || shields[i] !== 0);
  return mirror.frames;
}

/** `call`, or a rejection once it took `ms` (the call itself runs on; Infinity: no limit). */
function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms)) return call;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([call, late]).finally(() => clearTimeout(timer));
}

/** A socket can close between getWebSockets() and send(); one dead peer must not stop the rest. */
function sendFrame(ws: WebSocket, frame: Uint8Array): void {
  try {
    ws.send(frame);
  } catch {
    // Closed or closing: the runtime removes it from getWebSockets() shortly.
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  let frame: Uint8Array;
  try {
    frame = encodeServerMessage(message);
  } catch (error) {
    // A reject reason this build cannot encode (a newer game script): `unavailable` makes the
    // client resend, and a refused op was not remembered, so the retry is judged afresh.
    if (!(error instanceof ProtocolError) || message.type !== 'ack') throw error;
    console.error('unencodable ack', error);
    frame = encodeServerMessage({
      type: 'ack',
      opId: message.opId,
      ok: false,
      reason: 'unavailable',
    });
  }
  sendFrame(ws, frame);
}

export default {
  fetch: () => new Response('not found', { status: 404 }),
} satisfies ExportedHandler<Env>;
