import { type CellDiff, type Rect, type Rotation, TILE_SIZE } from '@brickplace/core';
import {
  type ConfigMessage,
  type HoldMessage,
  MAX_DIFFS_PER_FRAME,
  type TileMessage,
  viewTiles,
} from '@brickplace/protocol';
import type { ClientConfig } from '../config.ts';
import { type GhostStyle, MapRenderer, useOverview } from '../gl/renderer.ts';
import {
  type Camera,
  cellAt,
  clampZoom,
  classifyWheel,
  fitRect,
  type Point,
  panBy,
  stepZoom,
  type Viewport,
  visibleCells,
  visibleTiles,
  zoomAround,
} from '../map/camera.ts';
import { type Ghost, ghostFor, type Rules, shouldSend, type Tool } from '../map/ghost.ts';
import { MapStore } from '../map/store.ts';
import type { Role } from '../net/account.ts';
import { CdnFeed, type CdnFeedOptions, SPREAD_MS } from '../net/cdn.ts';
import { fetchGzip, fetchText } from '../net/cdn-fetch.ts';
import {
  Connection,
  type ConnectionOptions,
  type ConnectionStatus,
  type HeldMap,
} from '../net/connection.ts';
import { discardNotice, type Notice, noticeFor } from '../net/messages.ts';
import { PALETTE } from '../palette.ts';
import { Observable } from '../ui/observable.ts';
import {
  consume,
  emptyHold,
  fromServer,
  type Hold,
  type Item,
  type ItemKind,
  markPending,
  newSocket,
  refund,
} from './hold.ts';
import { SOCKET_IDLE_MS, wantsSocket } from './mode.ts';
import { Preferences, type PrefKey } from './prefs.ts';
import { type Sound, webAudio } from './sound.ts';

const DRAG_THRESHOLD_PX = 4;
/** How long before a socket's session token runs out the page moves to a fresh socket. */
export const SOCKET_RENEW_LEAD_MS = 2 * 60 * 1000;
/** Up to this much earlier still, at random, so renewed pages spread their reconnects. */
export const SOCKET_RENEW_JITTER_MS = 60 * 1000;
/** Expiries closer than this are the same token seen through two round trips. */
const SAME_TOKEN_SLACK_MS = 60 * 1000;
const NOTICE_MS = 4500;

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}
/** The close code of a socket kicked by moderation or deletion (realtime KICKED, ADR 0023). */
export const KICKED_CLOSE = 4403;
/**
 * The close code of a socket replaced by a newer playing socket of the same account
 * (realtime PLAYING_ELSEWHERE, ADR 0026): another page plays now.
 */
export const PLAYING_ELSEWHERE_CLOSE = 4409;
/**
 * The close code of a socket whose account must pass a Turnstile before it moves again
 * (realtime CHALLENGE_REQUIRED, ADR 0026). The op that met it stays in flight.
 */
export const CHALLENGE_CLOSE = 4428;
/**
 * The close code of a socket turned away because the map holds as many players as it may at
 * once (realtime MAP_FULL, ADR 0039): it got no grid.
 */
export const MAP_FULL_CLOSE = 4503;
/**
 * The close code of a playing socket that gave its place to someone waiting, after 10
 * minutes without a move on a full map (realtime GAVE_UP_PLACE, ADR 0039).
 */
export const GAVE_UP_PLACE_CLOSE = 4408;
/** A page that found the map full tries again after this long, plus up to as much again (ms). */
export const FULL_RETRY_MS = 45_000;
/**
 * Longest a page about to play waits for the CDN to bring it the whole map before opening its
 * socket anyway, without a since (ADR 0040).
 */
export const BOOTSTRAP_MS = 3_000;
/** A view frame goes out at most this often while the camera moves (ms). */
export const VIEW_EVERY_MS = 500;

/** Shown when the account plays on another page; its button takes play back here. */
function elsewhereNotice(playHere: () => void): Notice {
  return {
    title: 'Playing on another page',
    body: 'Your account plays on one page at a time, so this one only watches now.',
    tone: 'info',
    action: { label: 'Play here', run: playHere },
  };
}

/** Shown when the map holds as many players as it may; the page joins once there is room. */
const FULL_NOTICE: Notice = {
  title: 'The map is full',
  body: 'As many people play as the map takes right now. You can watch, and this page joins by itself once a place frees up.',
  tone: 'info',
};

/** Shown when a place frees up for a page that was waiting. */
const JOINED_NOTICE: Notice = {
  title: 'You are in',
  body: 'A place freed up on the map. You can play now.',
  tone: 'info',
};

/** Shown when the page gave its place away; its button asks for one again. */
function gaveUpNotice(playAgain: () => void): Notice {
  return {
    title: 'You gave up your place',
    body: 'The map was full, and after 10 minutes without a move your place went to someone waiting. You are watching now.',
    tone: 'info',
    action: { label: 'Play again', run: playAgain },
  };
}

/** The socket's state while the page plays; `cdn` while it watches through the CDN. */
export type LinkStatus = ConnectionStatus | { readonly state: 'cdn'; readonly ok: boolean };

/** Seams for tests: a fake socket and fake CDN reads. */
export interface GameOptions {
  readonly createSocket?: ConnectionOptions['createSocket'];
  /** Replaces the browser's reads of the bucket (cdn-fetch.ts) and timers. */
  readonly cdn?: Partial<CdnFeedOptions>;
  /** The player's preferences; this browser's by default. */
  readonly prefs?: Preferences;
  /** The click of an accepted move (Web Audio by default). */
  readonly sound?: Sound;
}

export interface UiState {
  readonly connection: LinkStatus;
  /** Plays as an account, as a dev guest, or only watches (signed out). */
  readonly role: Role;
  readonly webgl: boolean;
  readonly hold: Hold;
  /** Id of the selected hold item, or null. */
  readonly selected: number | null;
  readonly rotation: Rotation;
  /** Palette index of the brick colour. */
  readonly color: number;
  /** Cell under the pointer, or null when the pointer is off the map. */
  readonly hover: Point | null;
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly notices: readonly { readonly id: number; readonly notice: Notice }[];
  /**
   * The open area and shield cap the client checks moves against: the server's config frame,
   * or the built-in defaults until it arrives.
   */
  readonly rules: Rules;
  /**
   * The server stopped taking moves: `read_only` (paused, until a move is accepted again) or
   * `ended` (the season is over). From acks; the season's end time also tells (states.ts).
   */
  readonly halt: 'read_only' | 'ended' | null;
  /**
   * The socket's last Stats frame (ADR 0030): players on the canvas and in this player's team
   * (null: no team), and when it came (ms). Null until one arrives.
   */
  readonly live: {
    readonly playing: number;
    readonly team: number | null;
    readonly at: number;
  } | null;
  /**
   * The server wants a fresh Turnstile before this account moves again (ADR 0026): the page
   * shows the check and holds its socket (and the move it sent) until it passes.
   */
  readonly challenge: boolean;
  /** Counts the challenges this page met; the dialog starts afresh for each. */
  readonly challengeRound: number;
}

function toolFor(item: Item, rotation: Rotation, color: number): Tool {
  if (item.kind === 'brick') return { kind: 'brick', shape: item.shape, rotation, color };
  if (item.kind === 'single') return { kind: 'single', color };
  return item;
}

/**
 * Wires the map store, the renderer, the socket and the UI state together, and turns
 * pointer, wheel and key input into camera moves and ops. Renders on demand only.
 */
export class Game {
  readonly store: MapStore;
  readonly ui: Observable<UiState>;
  readonly config: ClientConfig;
  readonly prefs: Preferences;
  readonly sound: Sound;
  /** Past the season's end, waiting for moves in flight (seasonOver): sends nothing new. */
  private ending = false;
  private connection: Connection;
  private attached = false;
  /** Called when the server refuses a playing page as signed out (set by Account). */
  onSessionEnded: (() => void) | null = null;
  /** The canvas's stats from each manifest the CDN feed reads, unchecked (ADR 0033). */
  onCdnStats: ((stats: unknown) => void) | null = null;
  private renderer: MapRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private frameRequested = false;
  private lastFrame = 0;
  private zoomTarget: { zoom: number; anchor: Point } | null = null;
  /**
   * The page opens on the whole open area, and keeps fitting it (resizes, the server's open
   * area arriving) until the player moves the map or a share link names a view.
   */
  private autoFit = true;
  /** When the last wheel event came (event time, ms): a pause before one starts a new scroll. */
  private lastWheel = Number.NEGATIVE_INFINITY;
  /** Ops and discards waiting for an ack, by opId. */
  private readonly sent = new Map<number, { itemId: number; kind: ItemKind; discard: boolean }>();
  private readonly pointers = new Map<number, Point>();
  private gesture: { start: Point; moved: boolean; last: Point } | null = null;
  private pinch: { distance: number; mid: Point } | null = null;
  /** Last mouse position over the map, so the ghost follows the cursor during an eased zoom. */
  private lastPointer: Point | null = null;
  private nextNoticeId = 1;
  private readonly cleanup: (() => void)[] = [];
  /** Reads the map from the CDN while no socket keeps it current; null without a CDN URL. */
  private readonly feed: CdnFeed | null;
  /** The page holds (or is opening) a socket: it plays. */
  private live = false;
  /** The socket's grid is in the store and its frames keep it current; the feed rests. */
  private socketSynced = false;
  /** A new socket's initial grid, collected off screen until it is complete. */
  private incoming: { readonly store: MapStore; seq: number } | null = null;
  /** The seq of the latest socket frame in the store. */
  private socketSeq = 0;
  /** The latest seq whose frames have all arrived; the store holds every change up to it. */
  private completeSeq = 0;
  /**
   * Without a CDN feed: the seq the store holds the whole map at since the last socket went
   * (its complete seq, or older for tiles its view had left), for the next socket to resume
   * from (ADR 0040). Null when unknown.
   */
  private resumeFrom: number | null = null;
  /** The since the current socket was opened with, to check its Resume frame against. */
  private sentSince: number | null = null;
  /** A Resume frame did not fit: the next socket asks for the whole map. */
  private resumeRefused = false;
  /**
   * The page is about to play but holds no whole map: the CDN feed loads every tile first, and
   * the socket opens once it has them, or after BOOTSTRAP_MS (ADR 0040).
   */
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;
  private dropWhenIdle = false;
  private hidden = false;
  /**
   * Another page of the account took over (close PLAYING_ELSEWHERE_CLOSE): this one opens no
   * socket until its player asks to play here ("Play here", shown again whenever the page is
   * shown or a move is tried), so two pages never take the socket back and forth on their own.
   */
  private elsewhere = false;
  /**
   * The map was full (close MAP_FULL_CLOSE, or `mapFull` said so before opening): no socket
   * until fullTimer runs out, FULL_RETRY_MS or up to twice that (ADR 0039).
   */
  private full = false;
  private fullTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * fullTimer ran out: the next socket opens whatever the stats say. They count idle players
   * too, and only a join makes the server free an idle player's place (ADR 0039).
   */
  private knock = false;
  /** Waiting for a place since FULL_NOTICE was shown: the first hold after it says "You are in". */
  private waitingForPlace = false;
  /**
   * Gave its place away (close GAVE_UP_PLACE_CLOSE): no socket until its player taps "Play
   * again", so a page left open does not take a place back from someone playing (ADR 0039).
   */
  private gaveUp = false;
  /**
   * True when the canvas's stats say the map holds as many players as its cap (ADR 0039): the
   * page then watches instead of opening a socket the server would turn away. Set by the page.
   */
  mapFull: (() => boolean) | null = null;
  /**
   * The canvas whose map the page shows (the season's, ADR 0021), set by the page: a socket
   * resumes only on that canvas, never across a season change (ADR 0040). Null: never resume.
   */
  mapCanvas: string | null = null;
  /** The socket's server takes subscribing views: its config frame said so (ADR 0028). */
  private serverViews = false;
  /** The tiles the socket follows for its last subscribing view; null: every tile. */
  private sentTiles: Rect | null = null;
  /**
   * Tiles the socket stopped sending diffs for, with the seq each was complete at when the
   * view left it: what the CDN feed carries on from if the socket goes.
   */
  private readonly frozen = new Map<number, number>();

  constructor(
    config: ClientConfig,
    role: Role = 'guest',
    /** 0..1; replaced in tests. */
    private readonly random: () => number = Math.random,
    private readonly options: GameOptions = {},
  ) {
    this.config = config;
    this.store = new MapStore(config.mapSize);
    this.feed = config.tilesUrl
      ? new CdnFeed(
          config.tilesUrl,
          this.store,
          {
            rules: ({ open, maxShield, locks }) => this.applyRules(open, maxShield, locks ?? []),
            status: (ok) => {
              if (!this.live) this.ui.update({ connection: { state: 'cdn', ok } });
            },
            // The map the socket waits for may be in now (ADR 0040).
            synced: () => {
              if (this.bootstrapTimer !== null && this.holdSeq() !== null) this.endBootstrap();
            },
            stats: (stats) => this.onCdnStats?.(stats),
            // No usable CDN (no CORS, another map): watch through a socket instead.
            unusable: () => this.updateMode(),
            // Spread changes fade in (no spreading at all with "Reduce motion", see below),
            // except zoomed far out, where cells are smaller than a pixel.
            spread: (cells) => {
              if (!this.renderer) return;
              const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
              if (useOverview(this.ui.get().camera.zoom * dpr)) return;
              this.renderer.fade(cells, performance.now());
              this.requestFrame();
            },
          },
          { fetchText, fetchGzip, spreadMs: SPREAD_MS, ...options.cdn },
        )
      : null;
    this.ui = new Observable<UiState>({
      connection: { state: 'connecting' },
      role,
      webgl: true,
      hold: emptyHold(),
      selected: null,
      rotation: 0,
      color: 14,
      hover: null,
      camera: {
        cx: config.open.x + config.open.w / 2,
        cy: config.open.y + config.open.h / 2,
        zoom: 4,
      },
      viewport: { width: 1, height: 1 },
      notices: [],
      rules: { open: config.open, maxShield: config.maxShield },
      halt: null,
      live: null,
      challenge: false,
      challengeRound: 0,
    });
    this.store.subscribe(() => this.requestFrame());
    this.prefs = options.prefs ?? new Preferences();
    this.prefs.state.subscribe(() => this.requestFrame());
    // "Reduce motion" turns off map animations, spreading CDN changes included.
    const spreading = () => this.feed?.setSpreading(!this.prefs.state.get().reduceMotion);
    spreading();
    this.prefs.state.subscribe(spreading);
    this.sound = options.sound ?? webAudio;
    this.connection = this.connect(role);
  }

  /** A socket for this role: a dev id only for a dev guest, the session cookie otherwise. */
  private connect(role: Role): Connection {
    return new Connection(
      this.config.socketUrl,
      {
        status: (connection) => this.onStatus(connection),
        opening: () => this.onSocketOpening(),
        // Kicked after a ban, a nickname reset or a deletion (ADR 0023): renew now, so the
        // page learns what changed instead of waiting for its next move to be refused.
        closed: (code) => {
          if (code === KICKED_CLOSE && this.ui.get().role === 'player') this.onSessionEnded?.();
          if (code === PLAYING_ELSEWHERE_CLOSE) this.onPlayingElsewhere();
          if (code === CHALLENGE_CLOSE) this.onChallenge();
          if (code === MAP_FULL_CLOSE) this.onMapFull();
          if (code === GAVE_UP_PLACE_CLOSE) this.onGaveUpPlace();
        },
        reset: () => this.onSocketOpen(),
        diffs: (seq, diffs) => this.onDiffs(seq, diffs),
        ack: (opId, ok, reason) => this.onAck(opId, ok, reason),
        hold: (message) => {
          this.finishGrid();
          this.onHold(message);
        },
        config: (message) => {
          this.finishGrid();
          this.onConfig(message);
        },
        tile: (message) => this.onTile(message),
        stats: ({ playing, team }) => this.ui.update({ live: { playing, team, at: Date.now() } }),
        resume: (from) => this.onResume(from),
      },
      {
        devPlayer: role === 'guest',
        since: () => this.sinceForSocket(),
        ...(this.options.createSocket ? { createSocket: this.options.createSocket } : {}),
      },
    );
  }

  /**
   * Reconnects in another role, e.g. after the first nickname is chosen: the gateway reads
   * the session again on the new socket. Ops still in flight are reported `unavailable`.
   * `force` reconnects even in the same role: after a session renewal, a socket opened with
   * the expired token only watches.
   */
  setRole(role: Role, force = false): void {
    this.ending = false;
    if (role === this.ui.get().role) {
      if (force) this.reconnect();
      return;
    }
    // Before stop(): it reports ops in flight `unavailable`, and a renewal (or a drop to the
    // CDN) waiting for them would open a second socket that the one below replaced without
    // stopping.
    this.clearRenewal();
    this.cancelDrop();
    this.cancelBootstrap();
    // A wait for a place belonged to the old role; the new one decides afresh.
    this.stopWaiting();
    this.connection.stop();
    this.ui.update({ role, hold: emptyHold(), selected: null });
    this.connection = this.connect(role);
    this.socketGone();
    if (this.live) {
      // The new role decides afresh whether the page plays.
      this.live = false;
      if (this.feed?.usable) this.ui.update({ connection: { state: 'cdn', ok: true } });
    }
    this.updateMode();
    // Whatever the new role decided, the feed follows: a page that stopped playing reads the
    // whole map from the CDN again (it may have had none yet, or only the tiles in view).
    this.updateFeed();
  }

  /** A new socket in the same role; the hold and selection stay until the server's hold. */
  private reconnect(): void {
    this.clearRenewal();
    this.connection.stop();
    this.connection = this.connect(this.ui.get().role);
    this.socketGone();
    if (this.attached && this.live && this.bootstrapTimer === null) this.connection.start();
  }

  // ---- socket or CDN ----------------------------------------------------------------
  //
  // A page watches through the CDN (ADR 0009, 0018) and opens a socket only to play: a
  // signed-in player (or a dev guest) zoomed in with the page visible. Hidden or zoomed out
  // for SOCKET_IDLE_MS, it gives the socket back once no op waits for its answer. Without a
  // CDN URL every page keeps a socket, as before.
  //
  // The map never flashes empty on a switch. A new socket's initial grid is collected off
  // screen and replaces the store in one step once complete (the config frame follows it),
  // while the CDN feed keeps the map current until then. When the socket goes, the store is
  // the map at the socket's last seq, and the feed carries on from there with the next
  // manifest (or reloads the tiles it cannot bring forward).

  /** Opens or schedules giving back the socket, from the role, zoom and visibility. */
  private updateMode(): void {
    if (!this.attached) return;
    const inputs = {
      role: this.ui.get().role,
      cdn: this.feed?.usable ?? false,
      zoom: this.ui.get().camera.zoom,
      hidden: this.hidden,
    };
    if (wantsSocket(inputs) && !this.elsewhere && !this.gaveUp && !this.full) {
      this.cancelDrop();
      if (!this.live) {
        // The stats say the map is full: watch, rather than open a socket to be turned away.
        // Not on a retry, which asks the server anyway (see `knock`).
        if (!this.knock && this.mapFull?.()) {
          this.waitForPlace();
          return;
        }
        this.knock = false;
        this.live = true;
        this.ui.update({ connection: { state: 'connecting' } });
        // A page that does not hold the whole map loads it from the CDN first, so the socket
        // only brings what changed since (ADR 0040).
        if (this.feed?.usable && this.holdSeq() === null) {
          this.bootstrapTimer = setTimeout(() => this.endBootstrap(), BOOTSTRAP_MS);
        } else {
          this.connection.start();
        }
        this.updateFeed();
      }
      return;
    }
    // A role change (setRole) gives the socket back at once; zoom and visibility after a while.
    if (!this.live || this.dropTimer !== null || this.dropWhenIdle) return;
    this.dropTimer = setTimeout(() => {
      this.dropTimer = null;
      this.dropWhenIdle = true;
      this.dropIfIdle();
    }, SOCKET_IDLE_MS);
  }

  private cancelDrop(): void {
    if (this.dropTimer !== null) clearTimeout(this.dropTimer);
    this.dropTimer = null;
    this.dropWhenIdle = false;
  }

  /**
   * The whole map is in from the CDN, or BOOTSTRAP_MS passed: the socket opens (with a since
   * when the map is whole), and the feed goes back to the tiles in view.
   */
  private endBootstrap(): void {
    if (this.bootstrapTimer === null) return;
    this.cancelBootstrap();
    if (this.attached && this.live) this.connection.start();
    this.updateFeed();
  }

  /** Stops waiting for the CDN's map, without opening the socket. */
  private cancelBootstrap(): void {
    if (this.bootstrapTimer !== null) clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = null;
  }

  /**
   * The lowest seq every tile of the store is surely at, or null when the store does not
   * hold the whole map: what a socket can resume from (ADR 0040).
   */
  private holdSeq(): number | null {
    if (!this.store.holdsAll) return null;
    return this.feed ? this.feed.heldSeq() : this.resumeFrom;
  }

  /**
   * What a new socket says the page holds: the canvas and seq of its whole map, unless a
   * resume just failed or the page does not know whose canvas it shows.
   */
  private sinceForSocket(): HeldMap | null {
    const seq = this.resumeRefused || this.mapCanvas === null ? null : this.holdSeq();
    this.resumeRefused = false;
    this.sentSince = seq;
    return seq === null || this.mapCanvas === null ? null : { canvas: this.mapCanvas, seq };
  }

  /**
   * The server resumes from the page's map (ADR 0040): the frames that follow are changes,
   * so they go into a copy of the store, swapped in once complete like a whole map. A Resume
   * frame the page did not ask for, or for a seq past the one it sent, cannot be applied: the
   * socket is closed, and the next asks for the whole map, moves in flight kept for it.
   */
  private onResume(from: number): void {
    const incoming = this.incoming;
    if (!incoming || incoming.seq >= 0 || this.sentSince === null || from > this.sentSince) {
      this.resumeRefused = true;
      this.incoming = null;
      this.connection.reopen();
      return;
    }
    this.incoming = { store: this.store.copy(), seq: -1 };
  }

  /** Gives the socket back once no op or discard waits for its answer. */
  private dropIfIdle(): void {
    if (!this.dropWhenIdle || this.sent.size > 0) return;
    this.cancelDrop();
    this.cancelBootstrap();
    this.clearRenewal();
    this.live = false;
    this.connection.stop();
    this.socketGone();
    this.updateFeed();
    this.ui.update({ connection: { state: 'cdn', ok: true } });
  }

  /**
   * A newer page of the account plays now (ADR 0026): give the socket back at once, without
   * the reconnect that follows other closes, and watch through the CDN. Ops still in flight
   * are reported `unavailable` (their outcome is unknown; the map shows it).
   */
  private onPlayingElsewhere(): void {
    if (this.elsewhere) return;
    this.elsewhere = true;
    this.watchInstead();
    this.notify(elsewhereNotice(() => this.playHere()));
  }

  /** Gives the socket back at once, without the reconnect other closes get, and watches. */
  private watchInstead(): void {
    this.cancelDrop();
    this.cancelBootstrap();
    this.clearRenewal();
    this.live = false;
    this.connection.stop();
    this.socketGone();
    this.updateFeed();
    this.ui.update({ connection: { state: 'cdn', ok: this.feed?.usable ?? false } });
  }

  /** Turned away by the players-at-once cap (ADR 0039): watch, and try again later. */
  private onMapFull(): void {
    this.watchInstead();
    this.waitForPlace();
  }

  /**
   * Opens no socket for FULL_RETRY_MS to twice that (spread, so pages turned away together do
   * not all come back together), then opens one if the page still wants to play: the server
   * says whether a place is free, an idle player's included. Says so once per wait.
   */
  private waitForPlace(): void {
    if (!this.waitingForPlace) this.notify(FULL_NOTICE);
    this.waitingForPlace = true;
    this.full = true;
    if (this.fullTimer !== null) clearTimeout(this.fullTimer);
    this.fullTimer = setTimeout(
      () => {
        this.fullTimer = null;
        // A hidden page (it may want a socket without a CDN) keeps waiting: its join could take
        // play from a page of the same account that its player is looking at.
        if (this.hidden) {
          this.waitForPlace();
          return;
        }
        this.full = false;
        this.knock = true;
        this.updateMode();
        // Not playing any more (zoomed out): the wait is over; a later one starts anew.
        if (!this.live && !this.full) this.stopWaiting();
      },
      FULL_RETRY_MS * (1 + this.random()),
    );
  }

  /** Ends a wait for a place: no retry pending, and the next wait says so again. */
  private stopWaiting(): void {
    if (this.fullTimer !== null) clearTimeout(this.fullTimer);
    this.fullTimer = null;
    this.full = false;
    this.knock = false;
    this.waitingForPlace = false;
  }

  /** Gave the place to someone waiting (ADR 0039): watch until the player asks again. */
  private onGaveUpPlace(): void {
    if (this.gaveUp) return;
    this.gaveUp = true;
    this.watchInstead();
    this.notify(gaveUpNotice(() => this.playAgain()));
  }

  /** "Play again" after giving up the place: asks for one, the map may still be full. */
  playAgain(): void {
    if (!this.gaveUp) return;
    this.gaveUp = false;
    this.updateMode();
  }

  /**
   * True while the page waits for its player to ask to play again (another page plays, or it
   * gave up its place): a reload would forget it, so the season watch does not reload it.
   */
  get waitingToPlay(): boolean {
    return this.elsewhere || this.gaveUp;
  }

  /**
   * The server wants a fresh Turnstile first (ADR 0026): no reconnect until it passes, the
   * move it left unanswered kept in flight; the CDN keeps the map current meanwhile.
   */
  private onChallenge(): void {
    this.connection.pause();
    this.socketGone();
    // A new round each time, so the dialog starts afresh (no token spent on the last one).
    this.ui.update(({ challengeRound }) => ({
      challenge: true,
      challengeRound: challengeRound + 1,
      connection: { state: 'connecting' },
    }));
  }

  /** The player passed the Turnstile (the server said so): reconnect and resend the move. */
  challengePassed(): void {
    if (!this.ui.get().challenge) return;
    this.ui.update({ challenge: false });
    this.connection.resume();
  }

  /** Takes play back from another page of the account; that one then watches in turn. */
  playHere(): void {
    if (!this.elsewhere) return;
    this.elsewhere = false;
    this.updateMode();
  }

  /** True while the page holds a socket (or is opening one) to play. */
  get playing(): boolean {
    return this.live;
  }

  /**
   * True when the store holds every cell of `area`: a socket's whole grid is in, or the CDN
   * feed holds every tile it touches. A page whose socket is still opening keeps only the
   * tiles in view current, so a share image of a wider area would show holes.
   */
  holdsArea(area: Rect): boolean {
    if (this.socketSynced) return true;
    const feed = this.feed;
    if (!feed || area.w <= 0 || area.h <= 0) return false;
    const perSide = this.store.tilesPerSide;
    const x0 = Math.max(0, Math.floor(area.x / TILE_SIZE));
    const y0 = Math.max(0, Math.floor(area.y / TILE_SIZE));
    const x1 = Math.min(perSide - 1, Math.floor((area.x + area.w - 1) / TILE_SIZE));
    const y1 = Math.min(perSide - 1, Math.floor((area.y + area.h - 1) / TILE_SIZE));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (feed.tileSeq(ty * perSide + tx) < 0) return false;
      }
    }
    return true;
  }

  /** The page was hidden or shown again (visibilitychange). */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    // Shown again while another page plays: say so, and take over only when asked (ADR 0026).
    // Taking over on every show would cost a socket and a whole grid each time the player
    // flips between tabs, and could meet the per-account limit on socket opens.
    if (!hidden && this.elsewhere) this.notify(elsewhereNotice(() => this.playHere()));
    if (!hidden && this.gaveUp) this.notify(gaveUpNotice(() => this.playAgain()));
    this.feed?.setHidden(hidden);
    this.updateMode();
  }

  private onStatus(status: ConnectionStatus): void {
    if (this.live) this.ui.update({ connection: status });
    // The socket closed: until the next one's grid is in, the CDN keeps the map current.
    if (status.state === 'waiting') this.socketGone();
  }

  /** A socket opened: its grid goes off screen until complete; the hold starts over. */
  private onSocketOpen(): void {
    this.incoming = { store: new MapStore(this.store.size), seq: -1 };
    this.updateHold(newSocket);
    // A new socket knows nothing of the view yet, and follows every tile until the page
    // subscribes, once its server says it can (ADR 0028).
    this.forgetView();
    this.sendView();
  }

  // ---- view frames (ADR 0026, 0028) ---------------------------------------------------
  //
  // A playing page tells the server which cells it shows, after each socket opens and, at
  // most every VIEW_EVERY_MS, while the camera moves. The server compares moves with it (a
  // move far outside the view is a bot signal). Once the socket's grid is in and its server
  // takes views, the same frame subscribes: the socket then gets live diffs only for the
  // tiles the view touches plus a margin of one, a tile coming back arrives whole first (a
  // Tile frame), and tiles left behind are marked with the seq they were left at, for the
  // CDN handover.

  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  /** The view the current socket last got, as a key, so an unchanged one is not sent again. */
  private sentView: string | null = null;

  /** Sends the view once VIEW_EVERY_MS has passed since the last one. */
  private scheduleView(): void {
    if (this.viewTimer !== null || !this.live) return;
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      this.sendView();
    }, VIEW_EVERY_MS);
  }

  private sendView(): void {
    if (!this.live || !this.connection.isOpen) return;
    const { camera, viewport } = this.ui.get();
    const view = visibleCells(camera, viewport, this.store.size);
    const subscribe = this.serverViews && this.socketSynced;
    const key = `${view.x},${view.y},${view.w},${view.h}${subscribe ? ',sub' : ''}`;
    if (key === this.sentView) return;
    if (!this.connection.sendView(view, subscribe ? true : undefined)) return;
    this.sentView = key;
    if (subscribe) this.followTiles(view);
  }

  private onDiffs(seq: number, diffs: readonly CellDiff[]): void {
    const incoming = this.incoming;
    if (incoming) {
      // Every frame of the initial grid carries the same seq; a new one means live frames.
      if (incoming.seq < 0 || seq === incoming.seq) {
        incoming.seq = seq;
        incoming.store.applyDiffs(diffs);
        // The grid's frames are all full but the last: a frame that is not full ends it, even
        // when no config or hold frame follows (a canvas without rules, a watcher). A grid
        // that fills its last frame exactly waits for the config, hold or a live frame.
        if (diffs.length < MAX_DIFFS_PER_FRAME) this.finishGrid();
        return;
      }
      this.finishGrid();
    }
    // A seq's diffs may span frames (all full but the last): a frame of a new seq means the
    // previous one is complete, and a frame that is not full completes its own.
    if (seq > this.socketSeq) this.completeSeq = this.socketSeq;
    this.socketSeq = Math.max(this.socketSeq, seq);
    if (diffs.length < MAX_DIFFS_PER_FRAME) this.completeSeq = this.socketSeq;
    this.store.applyDiffs(diffs);
  }

  /** The socket's whole grid is in: it replaces what the page showed, in one step. */
  private finishGrid(): void {
    const incoming = this.incoming;
    if (!incoming) return;
    this.incoming = null;
    // The server always sends at least one grid frame; without one there is nothing to show.
    if (incoming.seq < 0) return;
    this.store.replaceFrom(incoming.store);
    this.renderer?.clearFades();
    this.socketSeq = incoming.seq;
    this.completeSeq = incoming.seq;
    this.socketSynced = true;
    // Every tile is new from the grid.
    this.frozen.clear();
    this.updateFeed();
  }

  /** The socket stopped keeping the store current (closed, replaced or given back). */
  private socketGone(): void {
    this.incoming = null;
    this.forgetView();
    if (!this.socketSynced) return;
    this.socketSynced = false;
    // The store holds every change up to the last seq the socket finished sending (a seq cut
    // off mid-frames is not complete), except in tiles its view left earlier: those are at
    // the seq they were left at. The feed carries on from there; without one, the next socket
    // resumes from the lowest (ADR 0040).
    let lowest = this.completeSeq;
    if (this.frozen.size === 0) {
      this.feed?.adopt(this.completeSeq);
    } else {
      const seqs = new Array<number>(this.store.tileCount).fill(this.completeSeq);
      for (const [tile, seq] of this.frozen) {
        seqs[tile] = Math.min(seq, this.completeSeq);
        lowest = Math.min(lowest, seqs[tile]!);
      }
      this.feed?.adopt(seqs);
    }
    this.resumeFrom = lowest;
    this.frozen.clear();
    this.updateFeed();
  }

  /** Drops the view state of a socket that is gone or new: a new one follows every tile. */
  private forgetView(): void {
    this.serverViews = false;
    this.sentView = null;
    this.sentTiles = null;
    if (this.viewTimer !== null) clearTimeout(this.viewTimer);
    this.viewTimer = null;
  }

  /**
   * After a subscribing view: the server follows the tiles it touches plus a margin. Tiles it
   * no longer follows stop getting diffs: they stay complete up to now.
   */
  private followTiles(view: Rect): void {
    const sent = this.sentTiles;
    const tiles = viewTiles(view, this.store.size);
    const perSide = this.store.tilesPerSide;
    for (let tile = 0; tile < this.store.tileCount; tile++) {
      const tx = tile % perSide;
      const ty = (tile - tx) / perSide;
      const before = sent === null || inRect(sent, tx, ty);
      if (before && !inRect(tiles, tx, ty) && !this.frozen.has(tile)) {
        this.frozen.set(tile, this.completeSeq);
      }
    }
    this.sentTiles = tiles;
  }

  /** A tile newly in view, whole: it replaces the store's copy and follows the diffs again. */
  private onTile(message: TileMessage): void {
    const perSide = this.store.tilesPerSide;
    // The server cuts tiles of min(TILE_SIZE, map edge) cells (protocol VIEW_TILE).
    const edge = Math.min(TILE_SIZE, this.store.size);
    if (message.edge !== edge || message.tx >= perSide || message.ty >= perSide) return;
    const tile = message.ty * perSide + message.tx;
    this.store.setTile(tile, message.cells, message.shields);
    this.frozen.delete(tile);
  }

  /**
   * The CDN feed runs while the page is attached and no socket keeps the store current. A
   * page about to play that does not hold the whole map has it load every tile first (ADR
   * 0040), so its socket brings only what changed since. Once the socket is opening, or
   * reconnecting, the feed only keeps the map it shows current and loads no tile out of view.
   */
  private updateFeed(): void {
    const feed = this.feed;
    if (!feed) return;
    const bootstrapping = this.bootstrapTimer !== null;
    if (this.attached && !this.socketSynced && (!this.live || bootstrapping || feed.holdsMap)) {
      feed.setViewOnly(this.live && !bootstrapping);
      feed.setLoadAll(bootstrapping);
      feed.start();
      this.wantVisibleTiles();
    } else {
      feed.setLoadAll(false);
      feed.stop();
    }
  }

  private wantVisibleTiles(): void {
    if (!this.feed?.isRunning) return;
    const { camera, viewport } = this.ui.get();
    // Zoomed far out the map is drawn from the overview (renderer.ts): no tile is wanted for
    // it, and with the CDN's overview a watcher loads none (ADR 0009).
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const far = useOverview(camera.zoom * dpr);
    this.feed.want(far ? [] : visibleTiles(camera, viewport, this.store.size));
  }

  // ---- session expiry ---------------------------------------------------------------
  //
  // The gateway stops a socket playing when the session token it opened with expires
  // (ADR 0015). Account renews the token through /api/me while the page is open; this moves
  // the page to a socket carrying the renewed token shortly before the old one runs out, at
  // a moment with no op in flight, so normal play never meets a `signed_out` refusal. That
  // refusal (onAck) stays the fallback, e.g. after the computer slept.

  /**
   * When the latest session token the page knows runs out, on this page's clock (ms): the
   * server says how long it has left, never its own time, so a skewed clock does not matter.
   */
  private tokenDeadline: number | null = null;
  /** The deadline of the token the current socket was opened with. */
  private socketUntil: number | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private renewWhenIdle = false;

  /** Account reports how long the session token has left (ms) after every /api/me. */
  sessionRenewed(expiresIn: number | null): void {
    this.tokenDeadline = expiresIn === null ? null : Date.now() + expiresIn;
    this.planRenewal();
  }

  /** The socket's handshake sends the cookie the page has now: its session is fixed here. */
  private onSocketOpening(): void {
    this.socketUntil = this.tokenDeadline;
    this.planRenewal();
  }

  private planRenewal(): void {
    this.clearRenewal();
    // Watching through the CDN holds no socket to renew; the next one opens with the cookie
    // the page has then. (Without a CDN the page always holds one.)
    if (this.feed?.usable && !this.live) return;
    const until = this.socketUntil;
    const latest = this.tokenDeadline;
    // Two answers about the same token differ by their round trips; a renewed token is at
    // least ten minutes later (see the gateway's RENEW_AFTER_MS).
    const renewed = until !== null && latest !== null && latest > until + SAME_TOKEN_SLACK_MS;
    if (this.ui.get().role !== 'player' || !renewed) return;
    // Spread over a minute, so pages renewed together do not all reconnect at once.
    const jitter = this.random() * SOCKET_RENEW_JITTER_MS;
    const delay = Math.max(0, until - SOCKET_RENEW_LEAD_MS - jitter - Date.now());
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = null;
      this.renewWhenIdle = true;
      this.renewIfIdle();
    }, delay);
  }

  private renewIfIdle(): void {
    if (this.renewWhenIdle && this.sent.size === 0) this.reconnect();
  }

  private clearRenewal(): void {
    if (this.renewalTimer !== null) clearTimeout(this.renewalTimer);
    this.renewalTimer = null;
    this.renewWhenIdle = false;
  }

  // ---- lifecycle --------------------------------------------------------------------

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.renderer = MapRenderer.create(canvas, this.store, this.ui.get().rules.open, () =>
      this.requestFrame(),
    );
    this.ui.update({ webgl: this.renderer !== null });

    const resize = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      this.ui.update({ viewport: { width: rect.width, height: rect.height } });
      this.fitOpenArea();
      this.wantVisibleTiles();
      this.scheduleView();
      this.requestFrame();
    });
    resize.observe(canvas);
    this.cleanup.push(() => resize.disconnect());

    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e));
    this.listen(canvas, 'pointermove', (e) => this.onPointerMove(e));
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e));
    this.listen(canvas, 'pointercancel', (e) => this.onPointerUp(e, true));
    this.listen(canvas, 'pointerleave', () => {
      this.lastPointer = null;
      this.setHover(null);
    });
    this.listen(canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.listen(window, 'keydown', (e) => this.onKey(e));
    const onVisibility = () => this.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', onVisibility));
    this.hidden = document.visibilityState === 'hidden';
    this.feed?.setHidden(this.hidden);
    this.start();
    this.requestFrame();
  }

  /**
   * Starts watching and, when the page should play, the socket. Called by attach(); tests
   * call it directly since Node has no canvas.
   */
  start(): void {
    this.attached = true;
    if (this.feed?.usable) this.ui.update({ connection: { state: 'cdn', ok: true } });
    // The mode first: a page about to play needs no CDN map (see updateFeed).
    this.updateMode();
    this.updateFeed();
  }

  detach(): void {
    for (const fn of this.cleanup.splice(0)) fn();
    this.attached = false;
    this.clearRenewal();
    this.cancelDrop();
    this.cancelBootstrap();
    this.stopWaiting();
    this.live = false;
    this.connection.stop();
    this.socketGone();
    this.feed?.stop();
    this.renderer = null;
    this.canvas = null;
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const fn = handler as EventListener;
    target.addEventListener(type, fn, options);
    this.cleanup.push(() => target.removeEventListener(type, fn, options));
  }

  // ---- rendering --------------------------------------------------------------------

  requestFrame(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame((now) => this.frame(now));
  }

  private frame(now: number): void {
    this.frameRequested = false;
    const dt = this.lastFrame === 0 ? 16 : now - this.lastFrame;
    this.lastFrame = now;
    if (this.zoomTarget) {
      const { camera, viewport } = this.ui.get();
      const zoom = stepZoom(camera.zoom, this.zoomTarget.zoom, dt);
      this.setCamera(zoomAround(camera, viewport, this.zoomTarget.anchor, zoom, this.store.size));
      if (zoom === this.zoomTarget.zoom) this.zoomTarget = null;
      if (this.lastPointer) this.setHover(this.lastPointer);
    }
    const { camera, viewport } = this.ui.get();
    this.renderer?.draw({
      camera,
      viewport,
      dpr: window.devicePixelRatio || 1,
      now,
      ghost: this.ghostStyle(),
      holes: this.selectedItem()?.kind === 'single',
      grid: this.prefs.state.get().grid,
    });
    // Keep animating only while a zoom is easing in or cells fade in; otherwise sleep until
    // something changes.
    if (this.zoomTarget || this.renderer?.fading) this.requestFrame();
    else this.lastFrame = 0;
  }

  /** While nothing moved the map yet: show the whole open area. */
  private fitOpenArea(): void {
    const { viewport, rules } = this.ui.get();
    if (!this.autoFit || viewport.width <= 1 || viewport.height <= 1) return;
    this.setCamera(fitRect(rules.open, viewport, this.store.size));
  }

  private setCamera(camera: Camera): void {
    this.ui.update({ camera });
    this.wantVisibleTiles();
    this.updateMode();
    this.scheduleView();
    this.requestFrame();
  }

  /** The preview under the cursor for the selected item, or null. */
  ghost(): Ghost | null {
    const { hover } = this.ui.get();
    const tool = this.selectedTool();
    if (!hover || !tool) return null;
    return ghostFor(tool, hover.x, hover.y, this.store, this.ui.get().rules);
  }

  private ghostStyle(): GhostStyle | null {
    const ghost = this.ghost();
    if (!ghost) return null;
    const { color } = this.ui.get();
    const bad = ghost.problem !== null;
    const outline = bad ? '#E8384F' : '#171B26';
    if (ghost.op.kind === 'brick' || ghost.op.kind === 'single') {
      return { ghost, fill: PALETTE[color]!, fillAlpha: bad ? 0.35 : 0.6, outline };
    }
    const tint = ghost.op.kind === 'shield' ? '#3D7BFF' : '#171B26';
    return { ghost, fill: tint, fillAlpha: 0.18, outline };
  }

  // ---- items ------------------------------------------------------------------------

  private selectedItem(): Item | null {
    const { hold, selected } = this.ui.get();
    return hold.items.find((item) => item.id === selected) ?? null;
  }

  private selectedTool(): Tool | null {
    const item = this.selectedItem();
    if (!item) return null;
    const { rotation, color } = this.ui.get();
    return toolFor(item, rotation, color);
  }

  select(itemId: number | null): void {
    const { selected } = this.ui.get();
    this.ui.update({ selected: itemId === selected ? null : itemId });
    this.requestFrame();
  }

  rotate(step: 1 | -1 = 1): void {
    this.ui.update(({ rotation }) => ({
      rotation: ((((rotation + step) % 4) + 4) % 4) as Rotation,
    }));
    this.requestFrame();
  }

  setColor(color: number): void {
    this.ui.update({ color });
    this.requestFrame();
  }

  /**
   * Asks the server to throw the selected item away. A full hold gets no new items, so this
   * is how a player with three items they cannot use makes room.
   */
  discard(): void {
    const item = this.selectedItem();
    if (!item || this.ui.get().hold.pending.has(item.id)) return;
    if (this.ending || this.ui.get().halt === 'ended') {
      this.notify(discardNotice('ended'));
      return;
    }
    if (this.notPlaying()) return;
    const opId = this.connection.discard(item);
    if (opId === null) {
      this.notify({
        title: 'Not connected',
        body: 'Nothing was discarded. Try again once the map reconnects.',
        tone: 'warn',
      });
      return;
    }
    this.sent.set(opId, { itemId: item.id, kind: item.kind, discard: true });
    this.updateHold((hold) => markPending(hold, item.id));
    this.requestFrame();
  }

  private updateHold(fn: (hold: Hold) => Hold): void {
    this.ui.update(({ hold }) => ({ hold: fn(hold) }));
  }

  /** The server's hold replaces ours; a selected item that is gone is deselected. */
  private onHold(message: HoldMessage): void {
    // Only a playing socket gets a hold: a page that waited for a place has one now.
    if (this.waitingForPlace) {
      this.waitingForPlace = false;
      this.notify(JOINED_NOTICE);
    }
    this.updateHold((hold) => fromServer(hold, message, Date.now()));
    const { hold, selected } = this.ui.get();
    if (selected !== null && !hold.items.some((item) => item.id === selected)) {
      this.ui.update({ selected: null });
    }
    this.requestFrame();
  }

  /** The server's rules replace the defaults (or the previous ones, when the area grew). */
  private onConfig(message: ConfigMessage): void {
    if (message.mapSize !== this.store.size) {
      // This build's map has another size: its cell indices would not line up.
      console.warn(`server map is ${message.mapSize}², this build draws ${this.store.size}²`);
      return;
    }
    this.applyRules(message.open, message.maxShield, message.locks);
    if (message.views && !this.serverViews) {
      this.serverViews = true;
      // Subscribes at once: the grid is in (the config frame follows it).
      this.sendView();
    }
  }

  /**
   * Rules from the socket's config frame or, while watching, from the CDN manifest. Locks
   * (ADR 0024) left out by an older server keep the last ones known.
   */
  private applyRules(open: Rect, maxShield: number, locks?: readonly Rect[]): void {
    const known = locks ?? this.ui.get().rules.locks ?? [];
    this.ui.update({ rules: { open, maxShield, locks: known } });
    this.fitOpenArea();
    this.renderer?.setOpenArea(open);
    this.renderer?.setLocks(known);
    this.requestFrame();
  }

  /** A move while the page watches through the CDN: say how to play instead. */
  private notPlaying(): boolean {
    if (this.elsewhere) {
      this.notify(elsewhereNotice(() => this.playHere()));
      return true;
    }
    if (this.gaveUp) {
      this.notify(gaveUpNotice(() => this.playAgain()));
      return true;
    }
    if (this.full && !this.live) {
      this.notify(FULL_NOTICE);
      return true;
    }
    if (this.live || !this.feed?.usable) return false;
    this.notify({
      title: 'Zoom in to play',
      body: 'Moves need a closer view. Zoom in and the map connects in a moment.',
      tone: 'info',
    });
    return true;
  }

  /** Sets a preference from its switch: a click, so switching sound on opens the audio. */
  setPreference(key: PrefKey, value: boolean): void {
    if (key === 'sound' && value) this.sound.unlock();
    this.prefs.set(key, value);
  }

  /**
   * The season reached its end on this page's clock (SeasonWatch): no new move goes out, to
   * be refused `ended`, while the moves already sent wait for their answers. The next role
   * set lifts it: a watcher's page sends nothing anyway, and a player's means the end moved.
   */
  seasonOver(): void {
    this.ending = true;
  }

  /** Still past the season's end (seasonOver), with no role set since that lifted it. */
  get endingSeason(): boolean {
    return this.ending;
  }

  /** Uses the selected item on a cell: sends the op if the spot looks valid. */
  useAt(cell: Point): void {
    const item = this.selectedItem();
    const tool = this.selectedTool();
    if (!item || !tool || this.ui.get().hold.pending.has(item.id)) return;
    const ghost = ghostFor(tool, cell.x, cell.y, this.store, this.ui.get().rules);
    if (this.ending || this.ui.get().halt === 'ended') {
      this.notify(noticeFor('ended', item.kind, false));
      return;
    }
    if (this.notPlaying()) return;
    if (!shouldSend(ghost)) {
      this.notify(noticeFor(ghost.problem!, item.kind, false));
      return;
    }
    // The view goes first if the camera moved since the last one, so the server never
    // compares the move with a view the page has already left.
    this.sendView();
    const opId = this.connection.send(ghost.op);
    if (opId === null) {
      this.notify({
        title: 'Not connected',
        body: 'Your move was not sent. It will work again once the map reconnects.',
        tone: 'warn',
      });
      return;
    }
    this.sent.set(opId, { itemId: item.id, kind: item.kind, discard: false });
    this.updateHold((hold) => markPending(hold, item.id));
    // Still inside the click or key press: the only moment some browsers let audio start.
    if (this.prefs.state.get().sound) this.sound.unlock();
  }

  private onAck(opId: number, ok: boolean, reason: Parameters<typeof noticeFor>[0] | null): void {
    // A page that should play was refused as signed out: its session token expired (e.g.
    // after a sleep). Let the account renew it; it reconnects the game if still signed in.
    const sessionEnded = reason === 'signed_out' && this.ui.get().role === 'player';
    if (sessionEnded) this.onSessionEnded?.();
    // A pause lasts until a move goes through again; the end of a season does not lift.
    if (reason === 'read_only' || reason === 'ended') {
      if (this.ui.get().halt !== 'ended') this.ui.update({ halt: reason });
    } else if (ok && this.ui.get().halt === 'read_only') {
      this.ui.update({ halt: null });
    }
    const sent = this.sent.get(opId);
    if (!sent) return;
    this.sent.delete(opId);
    if (ok) {
      this.updateHold((hold) => consume(hold, sent.itemId));
      if (sent.discard) this.ui.update({ selected: null });
      else this.selectNextOfKind(sent.itemId, sent.kind);
      if (!sent.discard && this.prefs.state.get().sound) this.sound.play(sent.kind);
    } else {
      this.updateHold((hold) => refund(hold, sent.itemId));
      if (sessionEnded) {
        this.notify({
          title: 'Signing you back in',
          body: 'Your session had expired. The map reconnects in a moment; then try again.',
          tone: 'info',
        });
      } else if (reason) {
        this.notify(sent.discard ? discardNotice(reason) : noticeFor(reason, sent.kind));
      }
    }
    this.requestFrame();
    // A drop to the CDN, or else a socket renewal, waiting for the last answer can go now.
    this.dropIfIdle();
    this.renewIfIdle();
  }

  /** After an item is spent, keep the same tool in hand if the hold has another one. */
  private selectNextOfKind(spentId: number, kind: ItemKind): void {
    const { selected, hold } = this.ui.get();
    if (selected !== spentId) return;
    const next = hold.items.find((item) => item.kind === kind && !hold.pending.has(item.id));
    this.ui.update({ selected: next?.id ?? null });
  }

  notify(notice: Notice): void {
    const id = this.nextNoticeId++;
    this.ui.update(({ notices }) => ({ notices: [...notices.slice(-2), { id, notice }] }));
    // A toast with a button stays long enough to reach it.
    setTimeout(() => this.dismiss(id), notice.action ? NOTICE_MS * 4 : NOTICE_MS);
  }

  dismiss(id: number): void {
    this.ui.update(({ notices }) => ({ notices: notices.filter((n) => n.id !== id) }));
  }

  // ---- camera -----------------------------------------------------------------------

  /** Eased zoom by a factor around a screen point (the viewport centre by default). */
  zoomBy(factor: number, anchor?: Point): void {
    this.autoFit = false;
    const { camera, viewport } = this.ui.get();
    const base = this.zoomTarget?.zoom ?? camera.zoom;
    const at = anchor ?? { x: viewport.width / 2, y: viewport.height / 2 };
    if (this.prefs.state.get().reduceMotion) {
      // No eased zoom for players who asked for less motion.
      this.zoomTarget = null;
      this.setCamera(zoomAround(camera, viewport, at, clampZoom(base * factor), this.store.size));
      return;
    }
    this.zoomTarget = { zoom: clampZoom(base * factor), anchor: at };
    this.requestFrame();
  }

  /** Centres on a cell at a zoom: a share link (`/@x,y,zoomx`). */
  showView(camera: Camera): void {
    this.autoFit = false;
    this.zoomTarget = null;
    const zoom = clampZoom(camera.zoom);
    this.setCamera(panBy({ cx: camera.cx, cy: camera.cy, zoom }, 0, 0, this.store.size));
  }

  centerOn(x: number, y: number): void {
    this.autoFit = false;
    this.zoomTarget = null;
    const { camera } = this.ui.get();
    this.setCamera(panBy({ ...camera, cx: x, cy: y }, 0, 0, this.store.size));
  }

  private localPoint(event: MouseEvent): Point {
    const rect = this.canvas!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private setHover(point: Point | null): void {
    const { camera, viewport, hover } = this.ui.get();
    const cell = point ? cellAt(camera, viewport, point, this.store.size) : null;
    if (cell?.x === hover?.x && cell?.y === hover?.y) return;
    this.ui.update({ hover: cell });
    this.requestFrame();
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) return;
    this.canvas!.setPointerCapture(event.pointerId);
    const point = this.localPoint(event);
    this.pointers.set(event.pointerId, point);
    this.zoomTarget = null;
    this.autoFit = false;
    if (this.pointers.size === 1) {
      this.gesture = { start: point, last: point, moved: event.button === 1 };
    } else if (this.pointers.size === 2) {
      // A second finger turns the gesture into a pinch; it never ends in a placement.
      this.gesture = null;
      this.pinch = this.pinchState();
    }
  }

  private pinchState(): { distance: number; mid: Point } | null {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return null;
    return {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }

  private onPointerMove(event: PointerEvent): void {
    const point = this.localPoint(event);
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, point);
    if (this.pinch) {
      const next = this.pinchState();
      if (!next) return;
      const { camera, viewport } = this.ui.get();
      const panned = panBy(
        camera,
        next.mid.x - this.pinch.mid.x,
        next.mid.y - this.pinch.mid.y,
        this.store.size,
      );
      const zoom = (panned.zoom * next.distance) / this.pinch.distance;
      this.setCamera(zoomAround(panned, viewport, next.mid, zoom, this.store.size));
      this.pinch = next;
      return;
    }
    const gesture = this.gesture;
    if (gesture) {
      const far = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y);
      if (far > DRAG_THRESHOLD_PX) gesture.moved = true;
      if (gesture.moved) {
        const { camera } = this.ui.get();
        this.setCamera(
          panBy(camera, point.x - gesture.last.x, point.y - gesture.last.y, this.store.size),
        );
      }
      gesture.last = point;
    }
    if (event.pointerType === 'mouse') this.lastPointer = point;
    if (event.pointerType === 'mouse' || !gesture?.moved) this.setHover(point);
  }

  private onPointerUp(event: PointerEvent, cancelled = false): void {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.pointers.size < 2) this.pinch = null;
    const gesture = this.gesture;
    this.gesture = null;
    if (cancelled || !gesture || gesture.moved || this.pointers.size > 0) return;
    const { camera, viewport } = this.ui.get();
    const cell = cellAt(camera, viewport, this.localPoint(event), this.store.size);
    if (cell) this.useAt(cell);
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.autoFit = false;
    const intent = classifyWheel(event, event.timeStamp - this.lastWheel);
    this.lastWheel = event.timeStamp;
    const anchor = this.localPoint(event);
    if (intent.kind === 'pan') {
      this.zoomTarget = null;
      this.setCamera(panBy(this.ui.get().camera, intent.dx, intent.dy, this.store.size));
    } else if (intent.smooth) {
      this.zoomBy(intent.factor, anchor);
    } else {
      this.zoomTarget = null;
      const { camera, viewport } = this.ui.get();
      this.setCamera(
        zoomAround(camera, viewport, anchor, camera.zoom * intent.factor, this.store.size),
      );
    }
    this.setHover(anchor);
  }

  private panKey(dx: number, dy: number): void {
    this.autoFit = false;
    this.setCamera(panBy(this.ui.get().camera, dx, dy, this.store.size));
  }

  private onKey(event: KeyboardEvent): void {
    const target = event.target;
    // Keys typed into a field, or pressed inside a dialog over the map, are not map keys.
    if (
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable], [aria-modal="true"]')
    ) {
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const pan = 96;
    switch (event.key) {
      case 'r':
      case 'R':
        this.rotate(event.shiftKey ? -1 : 1);
        break;
      case 'Escape':
        this.select(null);
        break;
      case '+':
      case '=':
        this.zoomBy(2);
        break;
      case '-':
      case '_':
        this.zoomBy(0.5);
        break;
      case 'ArrowLeft':
        this.panKey(pan, 0);
        break;
      case 'ArrowRight':
        this.panKey(-pan, 0);
        break;
      case 'ArrowUp':
        this.panKey(0, pan);
        break;
      case 'ArrowDown':
        this.panKey(0, -pan);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
