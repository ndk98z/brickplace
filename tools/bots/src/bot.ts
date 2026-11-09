import { cellsOf, type Item, type Op, type Rect } from '@brickplace/core';
import {
  type AckReason,
  decodeServerMessage,
  encodeClientDiscard,
  encodeClientOp,
  encodeClientView,
  type HoldMessage,
  Opcode,
  type ServerMessage,
} from '@brickplace/protocol';
import { cdnStats } from './cdn.ts';
import { contains } from './mirror.ts';
import type { Player, World } from './player.ts';
import {
  backoffMs,
  CLOSE,
  type Connect,
  connectionId,
  OVERLOADED_STEP,
  type Socket,
  STABLE_MS,
  secureRandom,
} from './socket.ts';

/** How a bot proves who it is: staging's bot key (ADR 0034), or a dev id (`ENVIRONMENT=dev`). */
export type Identity = { readonly key: string } | { readonly dev: true };

/** One socket that got its map and rules: how long it took and what it cost. */
export interface Join {
  /** `first`: the bot's first map, timed from its first try; `again`: timed from the drop. */
  readonly kind: 'first' | 'again';
  /** The server resumed from the seq the bot sent (ADR 0040), rather than send the whole map. */
  readonly resumed: boolean;
  readonly ms: number;
  /** Bytes of the frames before the config frame: the map, or the changes since `since`. */
  readonly bytes: number;
}

/** Counts the driver prints, shared by every bot of a run. */
export class Stats {
  readonly sent: Record<string, number> = {};
  readonly accepted: Record<string, number> = {};
  readonly refused: Record<string, number> = {};
  readonly closes: Record<string, number> = {};
  readonly joins: Join[] = [];
  discarded = 0;
  connects = 0;
  /** Ops with no ack in time, sent again once. */
  timeouts = 0;
  /** Maps loaded from the CDN before first sockets (cdn.ts). */
  readonly cdn = cdnStats();

  static bump(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
  }
}

/** Why a bot stopped for good. */
export type GoneReason = 'challenged' | 'elsewhere' | 'watching';

/** What a bot tells the driver about itself. */
export interface BotEvents {
  /** The bot cannot play on and has stopped: its number is out, or the run is misconfigured. */
  gone(bot: Bot, why: GoneReason): void;
}

/** Wait before a move after an item arrives (ms): people take a few seconds to a minute. */
function humanDelay(random: () => number): number {
  return 3000 + Math.round(37_000 * random() ** 2);
}

/** No ack after this long: the op is sent again once with the same opId (ms). */
const ACK_TIMEOUT_MS = 20_000;
/** After `limited`, hammers and shields wait this long (ms). */
const LIMITED_PAUSE_MS = 10 * 60_000;
/** After `read_only` or `ended`, the bot looks again this much later (ms). */
const PAUSED_MS = 60_000;
/**
 * A playing socket gets its hold within this long of the config frame. Without one the gateway
 * took the socket as a watcher: a wrong or missing bot key, a dev id outside dev, or a kick.
 */
const HOLD_WAIT_MS = 60_000;
/** Fresh sockets tried after one with no hold, before the bot takes itself for a watcher. */
const HOLDLESS_TRIES = 2;
/** After `signed_out`, FanoutDO closes the socket (4401); if it has not by then, the bot does. */
const EXPIRED_CLOSE_MS = 5000;
/** Refusals in a row wait 2 s, 4 s, 8 s... up to this long before the next look (ms). */
const MAX_REFUSAL_WAIT_MS = 60_000;

interface InFlight {
  readonly opId: number;
  readonly frame: Uint8Array;
  readonly label: string;
  tries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * One bot: a socket that plays as one player, with the hold the server sends it. It waits a
 * human while after each item, asks its Player for a move on the shared map, sends one op at a
 * time and reads the ack, reports the cells it works on as a View frame first and never acts
 * outside them (ADR 0026), and throws the oldest item away when the hold is full and nothing
 * was useful. The server draws the items and judges every op; the bot only aims.
 */
export class Bot {
  private socket: Socket | null = null;
  private stopped = true;
  private attempt = 0;
  private hold: HoldMessage | null = null;
  private inFlight: InFlight | null = null;
  private thinkTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkDue = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private nextOpId: number;
  /** Random, never from the run's seed: a rerun must not repeat (player, client, opId). */
  private readonly client: string;
  /** The view last sent on this socket; null until one is sent. */
  private sentView: Rect | null = null;
  private configured = false;
  private subscribe = false;
  /** The session behind this socket ran out (`signed_out` on a socket that had a hold). */
  private expired = false;
  private limitedUntil = 0;
  private pausedUntil = 0;
  /** No move before this time (ms): a human while after the last item or move. */
  private readyAt = 0;
  /** Refusals since the last accepted move. */
  private refusals = 0;
  /** Sockets in a row that got no hold. */
  private holdlessSockets = 0;
  /**
   * The seq of the last map frames a socket of this bot delivered once its map was in: what a
   * page that kept its map current would hold. Sent as `since` on the next socket (ADR 0040).
   */
  private heldSeq: number | null = null;
  /** Calls to start(): a map load that finishes after a later start opens nothing. */
  private starts = 0;
  /** The seq of the current socket's map frames before its config frame (the grid or resume). */
  private gridSeq = -1;
  /** When the map being waited for was lost (or first asked for), and of which kind. */
  private joinStart = 0;
  private joinKind: Join['kind'] = 'first';
  /** The current socket's bytes before its config frame, and whether it began with Resume. */
  private joinBytes = 0;
  private resumed = false;

  constructor(
    readonly number: number,
    readonly player: Player,
    private readonly url: string,
    private readonly identity: Identity,
    private readonly world: () => World,
    private readonly stats: Stats,
    private readonly connect: Connect,
    private readonly random: () => number,
    private readonly events: BotEvents,
    /**
     * The season's canvas, as /api/me names it: with it, a socket after the first asks to resume
     * from the seq the last one reached. Null: every socket gets the whole map, as pages before
     * ADR 0040.
     */
    private readonly canvas: string | null = null,
    /**
     * Loads the map from the CDN as a page about to play does, and gives the seq the first
     * socket resumes from (null: it gets the whole map). Null: no CDN, as pages before ADR 0009.
     */
    private readonly firstSeq: (() => Promise<number | null>) | null = null,
  ) {
    this.client = connectionId(secureRandom);
    this.nextOpId = 1 + Math.floor(secureRandom() * 0x7fffffff);
  }

  /** The id the server knows this bot by. */
  get name(): string {
    return 'key' in this.identity ? `bot-${this.number}` : `dev-${devId(this.number)}`;
  }

  start(): void {
    this.stopped = false;
    this.joinStart = Date.now();
    this.joinKind = 'first';
    // A page that holds no map yet loads it from the CDN first, then resumes from its seq; the
    // join time counts the load.
    const start = ++this.starts;
    if (this.firstSeq && this.canvas !== null && this.heldSeq === null) {
      void this.firstSeq().then((seq) => {
        // Stopped, or stopped and started again meanwhile: that start opens its own socket.
        if (this.stopped || start !== this.starts) return;
        this.heldSeq = seq;
        this.open();
      });
      return;
    }
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.inFlight?.timer) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.socket?.close(1000, 'done');
    this.socket = null;
  }

  private open(): void {
    const url = new URL(this.url);
    const headers: Record<string, string> = {};
    if ('key' in this.identity) {
      url.searchParams.set('bot', String(this.number));
      headers.Authorization = `Bearer ${this.identity.key}`;
    } else {
      url.searchParams.set('player', devId(this.number));
    }
    url.searchParams.set('client', this.client);
    if (this.canvas !== null && this.heldSeq !== null) {
      url.searchParams.set('since', String(this.heldSeq));
      url.searchParams.set('canvas', this.canvas);
    }
    this.hold = null;
    this.sentView = null;
    this.configured = false;
    this.expired = false;
    this.gridSeq = -1;
    this.joinBytes = 0;
    this.resumed = false;
    const socket = this.connect(url.toString(), headers, {
      open: () => {
        if (this.socket !== socket) return;
        this.stats.connects++;
        // A server that accepts and then closes at once (1012, a full join gate) must not get
        // every bot back each second: the backoff starts over only after a stable while.
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          this.attempt = 0;
        }, STABLE_MS);
      },
      message: (data) => {
        if (this.socket === socket) this.onFrame(data);
      },
      close: (code) => {
        if (this.socket === socket) this.onClose(code);
      },
    });
    this.socket = socket;
  }

  private onClose(code: number): void {
    this.socket = null;
    this.clearTimers();
    if (this.inFlight?.timer) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    Stats.bump(this.stats.closes, String(code));
    if (this.stopped) return;
    // The map is lost now; a socket that never got one leaves the wait running from before.
    if (this.configured) {
      this.joinStart = Date.now();
      this.joinKind = 'again';
    }
    if (code === CLOSE.challenge || code === CLOSE.playingElsewhere) {
      this.stopped = true;
      this.events.gone(this, code === CLOSE.challenge ? 'challenged' : 'elsewhere');
      return;
    }
    // The hour is up (4401, after a `signed_out` ack): back at once, which checks the key
    // again. A fresh grid (1012), a kick, a deploy or a refused join: the client's backoff.
    const now = code === CLOSE.expired || this.expired;
    if (code === CLOSE.tryAgainLater) this.attempt = Math.max(this.attempt, OVERLOADED_STEP);
    const delay = now ? 0 : backoffMs(this.attempt++, this.random);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private onFrame(data: Uint8Array): void {
    const opcode = data[1];
    if (!this.configured && opcode !== Opcode.Config) this.joinBytes += data.length;
    // Map frames are the Eye's job: skip them without decoding (the initial grid is large),
    // reading only their seq.
    if (opcode === Opcode.Diffs || opcode === Opcode.Tile) {
      if (data.length >= 6) {
        const seq = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2, true);
        if (this.configured) this.heldSeq = seq;
        else this.gridSeq = seq;
      }
      return;
    }
    let message: ServerMessage;
    try {
      message = decodeServerMessage(data);
    } catch {
      return;
    }
    switch (message.type) {
      case 'resume':
        if (!this.configured) this.resumed = true;
        return;
      case 'config':
        // The config frame follows the map (or the changes since `since`): this socket's map
        // is in.
        if (!this.configured) this.joined();
        this.configured = true;
        this.subscribe = message.views === true;
        // FanoutDO sends a playing socket its hold after the config; a watcher never gets one.
        if (!this.hold && !this.holdTimer) {
          this.holdTimer = setTimeout(() => this.watching(), HOLD_WAIT_MS);
        }
        this.schedule(500 + Math.round(1500 * this.random()));
        return;
      case 'hold':
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = null;
        this.holdlessSockets = 0;
        this.onHold(message);
        return;
      case 'ack':
        this.onAck(message.opId, message.ok ? null : message.reason);
        return;
      default:
    }
  }

  private joined(): void {
    this.stats.joins.push({
      kind: this.joinKind,
      resumed: this.resumed,
      ms: Date.now() - this.joinStart,
      bytes: this.joinBytes,
    });
    if (this.gridSeq >= 0) this.heldSeq = this.gridSeq;
  }

  /** No hold came: the gateway does not let this bot play, so it stops rather than watch. */
  private watching(): void {
    this.holdTimer = null;
    if (this.stopped || this.hold) return;
    // A first hold can come late (the canvas replaying its log after a game deploy): try a
    // couple of fresh sockets before taking it as a watcher's.
    if (this.holdlessSockets++ < HOLDLESS_TRIES) {
      this.socket?.close(1000, 'no hold yet');
      this.onClose(1000);
      return;
    }
    this.stop();
    this.events.gone(this, 'watching');
  }

  private onHold(hold: HoldMessage): void {
    const old = this.hold;
    if (old && hold.revision < old.revision) return;
    this.hold = hold;
    // A new item: no move before a human while has passed.
    if (!old || hold.items.length > old.items.length) this.rest();
  }

  /** No move before a human while from now: after an item arrives, and after each move. */
  private rest(): void {
    const delay = humanDelay(this.random);
    this.readyAt = Math.max(this.readyAt, Date.now() + delay);
    this.schedule(delay);
  }

  private onAck(opId: number, reason: AckReason | null): void {
    const inFlight = this.inFlight;
    if (!inFlight || inFlight.opId !== opId) return;
    if (inFlight.timer) clearTimeout(inFlight.timer);
    this.inFlight = null;
    if (reason === null) {
      Stats.bump(this.stats.accepted, inFlight.label);
      this.refusals = 0;
      this.rest();
      return;
    }
    if (reason === 'unavailable' && inFlight.tries < 2) {
      // Not confirmed either way: the same opId again is safe (ADR 0017), after a pause.
      this.inFlight = inFlight;
      inFlight.timer = setTimeout(
        () => this.resend(inFlight),
        1000 + Math.round(2000 * this.random()),
      );
      return;
    }
    Stats.bump(this.stats.refused, `${inFlight.label}:${reason}`);
    const now = Date.now();
    switch (reason) {
      case 'signed_out':
        // Only a playing socket (it had a hold) sends ops: its session ran out. FanoutDO closes
        // it with 4401 next; the bot reconnects at once when it does, or after a few seconds
        // itself.
        this.expired = true;
        this.thinkTimer = setTimeout(() => {
          this.thinkTimer = null;
          if (!this.expired || !this.socket) return;
          this.socket.close(1000, 'session expired');
          this.onClose(CLOSE.expired);
        }, EXPIRED_CLOSE_MS);
        return;
      case 'limited':
        this.limitedUntil = now + LIMITED_PAUSE_MS;
        this.schedule(2000);
        return;
      case 'read_only':
      case 'ended':
        this.pausedUntil = now + PAUSED_MS;
        this.schedule(PAUSED_MS);
        return;
      default: {
        // A rule refusal (the copy of the map was a little behind) or `unavailable` twice:
        // look again later, and later still while refusals keep coming.
        const wait = Math.min(MAX_REFUSAL_WAIT_MS, 2000 * 2 ** this.refusals++);
        this.schedule(wait + Math.round(wait * this.random()));
      }
    }
  }

  /** Plans the next look at the hold `ms` from now, unless one is planned sooner. */
  private schedule(ms: number): void {
    if (this.stopped) return;
    const due = Date.now() + ms;
    if (this.thinkTimer && this.thinkDue <= due) return;
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.thinkDue = due;
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null;
      this.think();
    }, ms);
  }

  /** Looks at the hold and plays one item, throws one away, or waits. */
  private think(): void {
    const wait = this.step();
    if (wait !== null) this.schedule(wait);
  }

  /** One look at the hold: sends at most one frame. Returns when to look again (ms), or null. */
  private step(): number | null {
    const hold = this.hold;
    const socket = this.socket;
    if (!socket || !this.configured || !hold || this.inFlight || this.stopped || this.expired) {
      return null;
    }
    const now = Date.now();
    if (now < this.pausedUntil) return this.pausedUntil - now;
    const world = this.world();
    if (!world.mirror.ready) return 2000;
    // A page reports what it shows before the player clicks in it.
    if (!this.viewSent(world)) {
      const view = this.player.view(world);
      socket.send(encodeClientView({ view, subscribe: this.subscribe ? true : undefined }));
      this.sentView = view;
      return Math.max(1000 + Math.round(2000 * this.random()), this.readyAt - now);
    }
    if (now < this.readyAt) return this.readyAt - now;
    for (const item of hold.items) {
      if ((item.kind === 'hammer' || item.kind === 'shield') && now < this.limitedUntil) continue;
      const op = this.player.move(item, world);
      // A move may send the player elsewhere (a new home, another artwork): report that view
      // first, at the next look, so no op lands outside the view the server knows.
      if (!this.viewSent(world)) return 500;
      if (op && this.inView(op)) {
        this.send(op);
        return null;
      }
    }
    if (hold.items.length > 0 && hold.items.length >= hold.capacity) {
      this.discard(hold.items[0]!);
      return null;
    }
    // Nothing useful yet (or nothing held): the map changes, look again in a while. A new item
    // plans its own look sooner.
    return 20_000 + Math.round(20_000 * this.random());
  }

  /** True when the view last sent is the player's view now. */
  private viewSent(world: World): boolean {
    const sent = this.sentView;
    const view = this.player.view(world);
    return (
      sent !== null &&
      sent.x === view.x &&
      sent.y === view.y &&
      sent.w === view.w &&
      sent.h === view.h
    );
  }

  /** Every cell the op touches lies in the view last sent. */
  private inView(op: Op): boolean {
    const view = this.sentView;
    if (!view) return false;
    const cells = op.kind === 'brick' ? cellsOf(op.shape, op.rotation) : [[0, 0] as const];
    return cells.every(([dx, dy]) => contains(view, op.x + dx, op.y + dy));
  }

  private send(op: Op): void {
    const opId = this.takeOpId();
    this.track(opId, encodeClientOp({ opId, op }), op.kind);
  }

  private discard(item: Item): void {
    const opId = this.takeOpId();
    this.stats.discarded++;
    this.track(opId, encodeClientDiscard({ opId, discard: item }), 'discard');
  }

  private track(opId: number, frame: Uint8Array, label: string): void {
    Stats.bump(this.stats.sent, label);
    const inFlight: InFlight = { opId, frame, label, tries: 0, timer: null };
    this.inFlight = inFlight;
    this.resend(inFlight);
  }

  private resend(inFlight: InFlight): void {
    if (this.inFlight !== inFlight || !this.socket) return;
    inFlight.tries++;
    this.socket.send(inFlight.frame);
    if (inFlight.timer) clearTimeout(inFlight.timer);
    inFlight.timer = setTimeout(() => {
      if (this.inFlight !== inFlight) return;
      this.stats.timeouts++;
      if (inFlight.tries < 2) {
        this.resend(inFlight);
        return;
      }
      this.inFlight = null;
      this.schedule(5000);
    }, ACK_TIMEOUT_MS);
  }

  private takeOpId(): number {
    const opId = this.nextOpId;
    this.nextOpId = (this.nextOpId + 1) >>> 0 || 1;
    return opId;
  }

  private clearTimers(): void {
    for (const timer of [this.thinkTimer, this.reconnectTimer, this.stableTimer, this.holdTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.thinkTimer = null;
    this.reconnectTimer = null;
    this.stableTimer = null;
    this.holdTimer = null;
  }
}

/** A bot's dev id (`?player=`): 8 characters at least, as the gateway requires. */
export function devId(number: number): string {
  return `bot-${String(number).padStart(5, '0')}`;
}
