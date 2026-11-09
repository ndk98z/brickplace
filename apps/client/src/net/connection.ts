import type { CellDiff, Item, Op, Rect } from '@brickplace/core';
import {
  type AckReason,
  type ConfigMessage,
  decodeServerMessage,
  encodeClientDiscard,
  encodeClientOp,
  encodeClientView,
  type HoldMessage,
  ProtocolError,
  type StatsMessage,
  type TileMessage,
} from '@brickplace/protocol';

export type ConnectionStatus =
  | { readonly state: 'connecting' }
  | { readonly state: 'open' }
  | { readonly state: 'waiting'; readonly retryAt: number };

export interface ConnectionEvents {
  status(status: ConnectionStatus): void;
  /**
   * A socket opened. The server sends the full map on connect as ordinary diff frames, so
   * whatever the client held before is stale: drop it before those frames arrive.
   */
  reset(): void;
  /**
   * A socket is about to be created: the handshake carries the cookies the page has now,
   * so this is when the socket's session is fixed.
   */
  opening?(): void;
  /**
   * A socket closed with this code (0 when the browser gave none); a reconnect follows unless
   * the handler stops the connection.
   */
  closed?(code: number): void;
  diffs(seq: number, diffs: readonly CellDiff[]): void;
  /**
   * One per sent op: the server's verdict, or `unavailable` once the op has gone
   * unanswered (or unconfirmed) after its resend.
   */
  ack(opId: number, ok: boolean, reason: AckReason | null): void;
  /** The player's hold, sent by the server on connect and after every change. */
  hold(hold: HoldMessage): void;
  /** The canvas rules (open area, maxShield), sent after the map on connect and on changes. */
  config(config: ConfigMessage): void;
  /** One tile's whole content at a seq, for a tile newly in the socket's view (ADR 0028). */
  tile?(tile: TileMessage): void;
  /** Who is playing: the canvas and this socket's team (ADR 0030). */
  stats?(stats: StatsMessage): void;
  /**
   * The server resumes from the page's map (ADR 0040): the diffs that follow, at one seq, are
   * the cells changed after `from`, not the whole map. Sent first, only to a socket opened
   * with a since.
   */
  resume?(from: number): void;
}

/** The subset of WebSocket the connection uses, so tests can drive a fake one. */
export interface SocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: (event: { readonly code?: number }) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export interface ConnectionOptions {
  readonly createSocket?: (url: string) => SocketLike;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
  /** 0..1, spreads reconnects so a restart does not bring every client back at once. */
  readonly random?: () => number;
  /** Delay before reconnect attempt n (ms); the last entry repeats. */
  readonly backoffMs?: readonly number[];
  /** How long a socket must stay open before the backoff starts over (ms). */
  readonly stableMs?: number;
  /**
   * Play under a dev id (`?player=`, local dev only, signed out). Off by default: a signed-in
   * page plays as its account through the session cookie, a signed-out one watches.
   */
  readonly devPlayer?: boolean;
  /** Fixed ids for tests; fresh random ones by default. */
  readonly playerId?: string;
  readonly clientId?: string;
  /**
   * Asked as each socket is created: the seq up to which the page holds the whole map of
   * `canvas`, sent as `?since=` and `?canvas=` so the server can resume from it (ADR 0040);
   * null sends neither.
   */
  readonly since?: () => HeldMap | null;
}

/** The map a page holds: whose canvas, and the seq every tile is surely at (ADR 0040). */
export interface HeldMap {
  readonly canvas: string;
  readonly seq: number;
}

/**
 * The socket URL with this page's connection id (`?client=`, part of the server's op dedupe
 * key, ADR 0017), in local dev only the dev identity (`?player=`), and the map the page holds
 * (`?since=` and `?canvas=`, ADR 0040). The gateway accepts [A-Za-z0-9-]{8,64} for both ids
 * and reads `player` only when ENVIRONMENT=dev; FanoutDO reads `since` and `canvas`.
 */
export function socketUrlFor(
  base: string,
  ids: { client: string; player?: string | null; held?: HeldMap | null },
): string {
  const url = new URL(base);
  url.searchParams.set('client', ids.client);
  if (ids.player) url.searchParams.set('player', ids.player);
  const held = ids.held;
  if (held && Number.isSafeInteger(held.seq) && held.seq >= 0 && held.canvas) {
    url.searchParams.set('since', String(held.seq));
    url.searchParams.set('canvas', held.canvas);
  }
  return url.toString();
}

const OPEN = 1;
const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 15000];
/**
 * The first retry after a socket that stayed up waits its backoff times 1 to this (1-5 s by
 * default), so a server restart does not bring every page back within the same second (ADR
 * 0040). Later retries wait their step times 0.5 to 1.5, so pages that failed together do not
 * retry together.
 */
const FIRST_RETRY_SPREAD = 5;
/**
 * Close code 1013, Try Again Later: Cloudflare closes sockets with it when a Durable Object is
 * overloaded. The next retry jumps to at least this backoff step (4-12 s by default).
 */
const TRY_AGAIN_LATER = 1013;
const OVERLOADED_STEP = 3;
const DEFAULT_STABLE_MS = 5000;
/** Times an op may be sent before the client gives up and reports `unavailable`. */
const MAX_SENDS = 2;

interface InFlight {
  readonly frame: ArrayBuffer;
  sends: number;
  /** The view frame last sent when the op was, so a resend goes out with the view it had. */
  readonly view: ArrayBuffer | null;
}

/**
 * One game socket: decodes server frames, encodes ops, matches acks to op ids and
 * reconnects with jittered backoff. It holds no game state; MapStore applies the diffs.
 *
 * The server deduplicates ops by (player, connection id, opId), so an op whose outcome is
 * unknown (its socket closed first, or the server answered `unavailable`) is resent once with
 * the same opId rather than reported lost: a fresh click would carry a new opId and could
 * apply twice. Op ids come from one counter per Connection and never restart.
 *
 * The connection id (and the dev player id) is created with that counter and lives exactly
 * as long: a new id with an old counter (or the reverse) could collide. A new Connection,
 * e.g. after a page load, gets new ids, so two tabs or a reload of one account never share
 * a key. They are not kept in storage, since a duplicated tab would then share them.
 */
export class Connection {
  /** The dev identity, or null when the page plays through its session or watches. */
  readonly playerId: string | null;
  readonly clientId: string;
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private stableTimer: unknown = null;
  private attempt = 0;
  private stopped = true;
  /** See pause(). */
  private paused = false;
  /** The last view frame sent (sendView), kept with each op sent after it. */
  private lastView: ArrayBuffer | null = null;
  private nextOpId = 1;
  private readonly inFlight = new Map<number, InFlight>();
  private readonly createSocket: (url: string) => SocketLike;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly backoffMs: readonly number[];
  private readonly stableMs: number;
  private readonly baseUrl: string;
  private readonly since: () => HeldMap | null;

  constructor(
    baseUrl: string,
    private readonly events: ConnectionEvents,
    options: ConnectionOptions = {},
  ) {
    this.playerId = options.devPlayer ? (options.playerId ?? crypto.randomUUID()) : null;
    this.clientId = options.clientId ?? crypto.randomUUID();
    this.baseUrl = baseUrl;
    this.since = options.since ?? (() => null);
    this.createSocket = options.createSocket ?? ((u) => new WebSocket(u));
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF;
    this.stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.paused = false;
    this.cancelTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'client stopped');
    const ids = [...this.inFlight.keys()];
    this.inFlight.clear();
    for (const opId of ids) this.events.ack(opId, false, 'unavailable');
  }

  /**
   * Tells the server which cells the page shows (ADR 0026). Not acked and never resent: the
   * page sends it again whenever the view changes and after each reconnect. With `subscribe`
   * (ADR 0028, only to a server whose config frame said `views`) the socket then gets live
   * diffs for the view's tiles only. False when the socket is not open.
   */
  sendView(view: Rect, subscribe?: boolean): boolean {
    if (!this.socket || !this.isOpen) return false;
    // Kept plain for the ops sent after it: resent on a new socket, it must not subscribe
    // that socket behind the page's back (the page subscribes each new socket itself).
    this.lastView = encodeClientView({ view }).slice().buffer;
    const frame = subscribe === undefined ? this.lastView : encodeClientView({ view, subscribe });
    this.socket.send(frame instanceof ArrayBuffer ? frame : frame.slice().buffer);
    return true;
  }

  /**
   * Closes the current socket; the next opens on the usual backoff, and ops in flight go out
   * again on it with their opIds, as after any drop. For a socket the page cannot use (a
   * Resume frame it did not ask for, ADR 0040).
   */
  reopen(): void {
    try {
      this.socket?.close(1000, 'reopening');
    } catch {
      // Already closing: its close event reconnects.
    }
  }

  /**
   * Holds off reconnecting after the socket closes, keeping ops in flight, until resume():
   * an account that must pass a Turnstile first (close 4428, ADR 0026). The op the server
   * left unanswered then goes out again, with its opId, on the next socket.
   */
  pause(): void {
    this.paused = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Reconnects now if pause() held a reconnect back. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.stopped && !this.socket && this.timer === null) this.open();
  }

  /** Sends an op and returns its id, or null when the socket is not open. */
  send(op: Op): number | null {
    return this.sendWith((opId) => encodeClientOp({ opId, op }));
  }

  /**
   * Asks the server to throw a held item away. Acked, resent and deduplicated like an op,
   * under the same id counter. Returns its id, or null when the socket is not open.
   */
  discard(item: Item): number | null {
    const discard: Item =
      item.kind === 'brick' ? { kind: 'brick', shape: item.shape } : { kind: item.kind };
    return this.sendWith((opId) => encodeClientDiscard({ opId, discard }));
  }

  private sendWith(encode: (opId: number) => Uint8Array): number | null {
    if (!this.socket || !this.isOpen) return null;
    const opId = this.nextOpId;
    this.nextOpId = this.nextOpId >= 0xffffffff ? 1 : this.nextOpId + 1;
    // slice() copies into a plain ArrayBuffer of exactly the frame's length.
    const entry: InFlight = { frame: encode(opId).slice().buffer, sends: 0, view: this.lastView };
    this.inFlight.set(opId, entry);
    this.transmit(entry);
    return opId;
  }

  /**
   * Resends the ops a closed socket left unanswered on a new one, each after the view it was
   * sent with (ADR 0026): a player who panned while disconnected would otherwise have them
   * judged against the new view. Then the current view again, which the page sent on open.
   */
  private resendInFlight(socket: SocketLike): void {
    const current = this.lastView;
    let onServer = current;
    for (const entry of this.inFlight.values()) {
      if (entry.view && entry.view !== onServer) {
        socket.send(entry.view);
        onServer = entry.view;
      }
      this.transmit(entry);
    }
    if (current && onServer !== current) socket.send(current);
  }

  private transmit(entry: InFlight): void {
    entry.sends += 1;
    this.socket?.send(entry.frame);
  }

  private open(): void {
    this.timer = null;
    this.events.status({ state: 'connecting' });
    this.events.opening?.();
    const url = socketUrlFor(this.baseUrl, {
      client: this.clientId,
      player: this.playerId,
      held: this.since(),
    });
    const socket = this.createSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      // A server that accepts and then closes at once (e.g. 1012) must not get a reconnect
      // every second: the backoff starts over only once a socket has stayed up for a while.
      this.stableTimer = this.setTimer(() => {
        this.stableTimer = null;
        this.attempt = 0;
      }, this.stableMs);
      this.events.reset();
      this.events.status({ state: 'open' });
      this.resendInFlight(socket);
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.receive(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stableTimer !== null) this.clearTimer(this.stableTimer);
      this.stableTimer = null;
      this.giveUpOnResent();
      if (!this.stopped) {
        this.events.closed?.(event?.code ?? 0);
        // The handler may have stopped the connection (a page now playing elsewhere) or
        // paused it (a Turnstile to pass first).
        if (!this.stopped && !this.paused) this.scheduleReconnect(event?.code ?? 0);
      }
    });
  }

  private receive(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;
    let message: ReturnType<typeof decodeServerMessage>;
    try {
      message = decodeServerMessage(new Uint8Array(data));
    } catch (error) {
      // A frame this build cannot read (e.g. a newer protocol) is skipped, not fatal.
      if (error instanceof ProtocolError) {
        console.warn('skipped server frame:', error.message);
        return;
      }
      throw error;
    }
    if (message.type === 'diffs') {
      this.events.diffs(message.seq, message.diffs);
      return;
    }
    if (message.type === 'hold') {
      this.events.hold(message);
      return;
    }
    if (message.type === 'config') {
      this.events.config(message);
      return;
    }
    if (message.type === 'tile') {
      this.events.tile?.(message);
      return;
    }
    if (message.type === 'stats') {
      this.events.stats?.(message);
      return;
    }
    if (message.type === 'resume') {
      this.events.resume?.(message.from);
      return;
    }
    const entry = this.inFlight.get(message.opId);
    if (!entry) return;
    if (!message.ok && message.reason === 'unavailable' && entry.sends < MAX_SENDS) {
      this.transmit(entry);
      return;
    }
    this.inFlight.delete(message.opId);
    this.events.ack(message.opId, message.ok, message.ok ? null : message.reason);
  }

  /**
   * On close, ops sent once stay in flight and go out again on the next socket; ops that
   * were already resent and still have no answer are reported `unavailable`.
   */
  private giveUpOnResent(): void {
    for (const [opId, entry] of [...this.inFlight]) {
      if (entry.sends < MAX_SENDS) continue;
      this.inFlight.delete(opId);
      this.events.ack(opId, false, 'unavailable');
    }
  }

  private scheduleReconnect(code = 0): void {
    if (code === TRY_AGAIN_LATER) this.attempt = Math.max(this.attempt, OVERLOADED_STEP);
    const base = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)]!;
    const factor =
      this.attempt === 0 ? 1 + (FIRST_RETRY_SPREAD - 1) * this.random() : 0.5 + this.random();
    this.attempt += 1;
    const delay = Math.round(base * factor);
    this.events.status({ state: 'waiting', retryAt: this.now() + delay });
    this.timer = this.setTimer(() => this.open(), delay);
  }

  private cancelTimers(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.stableTimer !== null) this.clearTimer(this.stableTimer);
    this.timer = null;
    this.stableTimer = null;
  }
}
