import { TILE_SIZE } from '@brickplace/core';
import {
  decodeClientMessage,
  encodeServerMessage,
  MAX_DIFFS_PER_FRAME,
} from '@brickplace/protocol';
import {
  CDN_FORMAT,
  encodeSegment,
  encodeTile,
  type Manifest,
  type Segment,
} from '@brickplace/protocol/cdn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ClientConfig, tilesUrlFrom } from '../src/config.ts';
import {
  BOOTSTRAP_MS,
  CHALLENGE_CLOSE,
  FULL_RETRY_MS,
  GAVE_UP_PLACE_CLOSE,
  Game,
  MAP_FULL_CLOSE,
  PLAYING_ELSEWHERE_CLOSE,
  VIEW_EVERY_MS,
} from '../src/game/game.ts';
import { PLAY_MIN_ZOOM, SOCKET_IDLE_MS, wantsSocket } from '../src/game/mode.ts';
import type { Role } from '../src/net/account.ts';
import { SPREAD_MS } from '../src/net/cdn.ts';
import type { SocketLike } from '../src/net/connection.ts';

// Watching through the CDN, opening a socket to play, and the handover both ways (ADR 0018).

const SIZE = 512;
const BASE = 'https://tiles.test/c/canvas';
const OPEN = { x: 0, y: 0, w: SIZE, h: SIZE };
const index = (x: number, y: number) => y * SIZE + x;

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  private handlers: Record<string, ((event: { data: unknown; code?: number }) => void)[]> = {};

  addEventListener(
    type: string,
    listener: (event: { data: unknown; code?: number }) => void,
  ): void {
    const list = this.handlers[type] ?? [];
    list.push(listener);
    this.handlers[type] = list;
  }
  sent: ArrayBuffer[] = [];
  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.readyState = 3;
    for (const h of this.handlers.close ?? []) h({ data: undefined, code });
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  receive(frame: Uint8Array): void {
    this.emit('message', frame.slice().buffer);
  }
  private emit(type: string, data?: unknown): void {
    for (const h of this.handlers[type] ?? []) h({ data });
  }
}

/** The CDN as the page sees it: a manifest, segments and (when republished) tiles. */
class Cdn {
  manifest: Manifest = this.at(0, []);
  readonly objects = new Map<string, Uint8Array>();
  reads = 0;
  objectReads: string[] = [];

  at(seq: number, segments: [number, number][], tiles = [0, 0, 0, 0]): Manifest {
    return {
      format: CDN_FORMAT,
      seq,
      size: SIZE,
      tileSize: TILE_SIZE,
      open: OPEN,
      maxShield: 5,
      tiles,
      segments,
    };
  }
  publish(segment: Segment, all: [number, number][]): void {
    this.objects.set(`${BASE}/diffs/${segment.from}-${segment.to}.bin.gz`, encodeSegment(segment));
    this.manifest = this.at(segment.to, all);
  }
  /** A resync: every tile republished at `seq` from `cells`, no segment listed. */
  resync(seq: number, cells: [number, number, number][]): void {
    const grid = {
      size: SIZE,
      cells: new Uint8Array(SIZE * SIZE),
      shields: new Uint8Array(SIZE * SIZE),
    };
    for (const [x, y, cell] of cells) grid.cells[index(x, y)] = cell;
    for (let tile = 0; tile < 4; tile++) {
      const tx = tile % 2;
      const ty = (tile - tx) / 2;
      this.objects.set(
        `${BASE}/tiles/${tx}-${ty}/${seq}.bin.gz`,
        encodeTile(grid, tx, ty, TILE_SIZE, seq),
      );
    }
    this.manifest = this.at(seq, [], [seq, seq, seq, seq]);
  }
}

const config = (tilesUrl: string | null): ClientConfig => ({
  socketUrl: 'ws://test/ws',
  mapSize: SIZE,
  open: OPEN,
  maxShield: 5,
  kofiUrl: null,
  sponsors: [],
  sponsorInfoUrl: null,
  tilesUrl,
});

interface Internals {
  setCamera(camera: { cx: number; cy: number; zoom: number }): void;
  sent: Map<number, unknown>;
  onAck(opId: number, ok: boolean, reason: string | null): void;
}

function page(role: Role, cdn = new Cdn(), tilesUrl: string | null = BASE) {
  const sockets: FakeSocket[] = [];
  /** The `since` each socket was opened with (ADR 0040), null for none. */
  const sinces: (number | null)[] = [];
  const game = new Game(config(tilesUrl), role, () => 0, {
    createSocket: (url) => {
      const since = new URL(url).searchParams.get('since');
      sinces.push(since === null ? null : Number(since));
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    cdn: {
      fetchText: async () => {
        cdn.reads++;
        return JSON.stringify(cdn.manifest);
      },
      fetchGzip: async (url) => {
        cdn.objectReads.push(url);
        const bytes = cdn.objects.get(url);
        if (!bytes) throw new Error(`404 ${url}`);
        return bytes;
      },
      // Spread steps run on the faked clock, like the timers.
      now: () => Date.now(),
    },
  });
  // The Stage 0 canvas, as main.tsx says before any season.
  game.mapCanvas = 'canvas';
  const internals = game as unknown as Internals;
  const zoom = (z: number) => internals.setCamera({ cx: SIZE / 2, cy: SIZE / 2, zoom: z });
  return { game, internals, sockets, sinces, cdn, zoom, store: game.store };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** What FanoutDO sends a new socket: the grid as diff frames at its seq, then the rules. */
function sendGrid(socket: FakeSocket, seq: number, cells: [number, number, number][]) {
  socket.receive(
    encodeServerMessage({
      type: 'diffs',
      seq,
      diffs: cells.map(([x, y, cell]) => ({ index: index(x, y), cell, shield: 0 })),
    }),
  );
}

/** First row of the cells a full grid frame fills (clear of the cells the tests use). */
const FULL_ROW = 200;

/** A grid frame holding as many diffs as a frame can: more frames of its seq may follow. */
function sendFullFrame(socket: FakeSocket, seq: number) {
  const diffs = Array.from({ length: MAX_DIFFS_PER_FRAME }, (_, i) => ({
    index: FULL_ROW * SIZE + i,
    cell: 2,
    shield: 0,
  }));
  socket.receive(encodeServerMessage({ type: 'diffs', seq, diffs }));
}

function sendConfig(socket: FakeSocket) {
  socket.receive(encodeServerMessage({ type: 'config', mapSize: SIZE, open: OPEN, maxShield: 5 }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('wantsSocket', () => {
  const at = (role: Role, zoom: number, hidden = false, cdn = true) =>
    wantsSocket({ role, cdn, zoom, hidden });

  it('opens one only to play: signed in (or a dev guest), zoomed in, visible', () => {
    expect(at('player', PLAY_MIN_ZOOM)).toBe(true);
    expect(at('guest', 4)).toBe(true);
    expect(at('player', PLAY_MIN_ZOOM / 2)).toBe(false);
    expect(at('player', 4, true)).toBe(false);
    expect(at('watcher', 64)).toBe(false);
  });

  it('keeps every page on a socket when no CDN is configured', () => {
    expect(at('watcher', 0.25, true, false)).toBe(true);
  });
});

describe('tilesUrlFrom', () => {
  it('takes https URLs and paths on the page’s own site', () => {
    expect(tilesUrlFrom('https://tiles.example/c/canvas/', 'http://localhost:8787/')).toBe(
      'https://tiles.example/c/canvas',
    );
    expect(tilesUrlFrom('/api/dev/tiles/c/canvas', 'http://localhost:8787/?watch')).toBe(
      'http://localhost:8787/api/dev/tiles/c/canvas',
    );
    expect(tilesUrlFrom('http://tiles.example/c/canvas', 'https://brickplace.example/')).toBe(null);
    expect(tilesUrlFrom('javascript:alert(1)', 'https://brickplace.example/')).toBe(null);
    expect(tilesUrlFrom(null, 'https://brickplace.example/')).toBe(null);
  });
});

describe('a watcher', () => {
  it('reads the map from the CDN and never opens a socket', async () => {
    const cdn = new Cdn();
    cdn.publish({ from: 0, to: 3, diffs: [{ index: index(1, 1), cell: 7, shield: 0 }] }, [[0, 3]]);
    const { game, sockets, store, zoom } = page('watcher', cdn);
    game.start();
    await flush();
    expect(store.cell(1, 1)).toBe(7);
    expect(game.ui.get().connection).toEqual({ state: 'cdn', ok: true });
    zoom(64);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(0);
    // It kept polling: one read every two seconds.
    expect(cdn.reads).toBeGreaterThanOrEqual(5);
  });

  it('watches through a socket when the CDN cannot be read at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sockets: FakeSocket[] = [];
    const game = new Game(config(BASE), 'watcher', () => 0, {
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      cdn: {
        fetchText: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    game.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(game.playing).toBe(true);
    vi.restoreAllMocks();
  });

  it('keeps a socket when no CDN is configured, as before', () => {
    const { game, sockets } = page('watcher', new Cdn(), null);
    game.start();
    expect(sockets).toHaveLength(1);
  });
});

describe('a player', () => {
  /** A player whose socket has delivered its grid at seq 10 (the CDN is at 3). */
  async function playing() {
    const cdn = new Cdn();
    cdn.publish(
      {
        from: 0,
        to: 3,
        diffs: [
          { index: index(1, 1), cell: 7, shield: 0 },
          { index: index(5, 5), cell: 1, shield: 0 },
        ],
      },
      [[0, 3]],
    );
    const p = page('player', cdn);
    p.game.start();
    await flush();
    const socket = p.sockets[0]!;
    socket.open();
    sendGrid(socket, 10, [
      [1, 1, 8],
      [2, 2, 3],
    ]);
    sendConfig(socket);
    return { ...p, socket };
  }

  it('watches when another page of the account plays, until shown again or asked (ADR 0026)', async () => {
    const { game, sockets, store } = await playing();
    expect(store.cell(1, 1)).toBe(8);
    expect(game.waitingToPlay).toBe(false);
    sockets[0]!.close(PLAYING_ELSEWHERE_CLOSE);
    // Said to the season watch, so it does not reload this page (season-watch.ts `holding`).
    expect(game.waitingToPlay).toBe(true);
    // No reconnect: the page watches through the CDN and says why.
    const notice = game.ui.get().notices.at(-1)!.notice;
    expect(notice.title).toBe('Playing on another page');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);
    expect(game.playing).toBe(false);
    expect(game.ui.get().connection).toEqual({ state: 'cdn', ok: true });
    // A move is not sent: the page says so again, with the same button.
    const gate = game as unknown as { notPlaying(): boolean };
    expect(gate.notPlaying()).toBe(true);
    expect(game.ui.get().notices.at(-1)!.notice.title).toBe('Playing on another page');
    // "Play here" takes over: a socket opens again.
    notice.action!.run();
    expect(sockets).toHaveLength(2);
    expect(game.playing).toBe(true);
    // Replaced again, then shown after being hidden: it says so, but takes over only when asked.
    sockets[1]!.open();
    sockets[1]!.close(PLAYING_ELSEWHERE_CLOSE);
    expect(game.playing).toBe(false);
    game.setHidden(true);
    await vi.advanceTimersByTimeAsync(30_000);
    game.setHidden(false);
    expect(sockets).toHaveLength(2);
    expect(game.playing).toBe(false);
    const shown = game.ui.get().notices.at(-1)!.notice;
    expect(shown.title).toBe('Playing on another page');
    shown.action!.run();
    expect(sockets).toHaveLength(3);
    expect(game.playing).toBe(true);
  });

  it('tells the server its view on open and as the camera moves, at most twice a second', async () => {
    const { game, sockets, internals } = await playing();
    const views = () =>
      sockets[0]!.sent
        .map((frame) => decodeClientMessage(new Uint8Array(frame)))
        .filter((m) => 'view' in m);
    // The viewport is 1×1 px until the page lays out: the cells around the camera's centre.
    expect(views()).toEqual([{ view: { x: 255, y: 255, w: 2, h: 2 } }]);
    game.ui.update({ viewport: { width: 400, height: 200 } });
    internals.setCamera({ cx: 300, cy: 200, zoom: 4 });
    internals.setCamera({ cx: 310, cy: 200, zoom: 4 });
    expect(views()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(VIEW_EVERY_MS);
    expect(views().at(-1)).toEqual({ view: { x: 260, y: 175, w: 100, h: 50 } });
    // Unchanged: nothing more.
    internals.setCamera({ cx: 310, cy: 200, zoom: 4 });
    await vi.advanceTimersByTimeAsync(VIEW_EVERY_MS);
    expect(views()).toHaveLength(2);
  });

  it('holds its move through a Turnstile challenge, then resends it (ADR 0026)', async () => {
    const { game, sockets, internals } = await playing();
    const connection = (game as unknown as { connection: { send(op: unknown): number | null } })
      .connection;
    const opId = connection.send({ kind: 'hammer', x: 1, y: 1 })!;
    internals.sent.set(opId, { itemId: 1, kind: 'hammer', discard: false });
    sockets[0]!.close(CHALLENGE_CLOSE);
    expect(game.ui.get().challenge).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    // No reconnect while the check is open, and the move is still waiting.
    expect(sockets).toHaveLength(1);
    expect(internals.sent.has(opId)).toBe(true);
    game.challengePassed();
    expect(game.ui.get().challenge).toBe(false);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    const resent = sockets[1]!.sent
      .map((frame) => decodeClientMessage(new Uint8Array(frame)))
      .find((m) => 'op' in m);
    expect(resent).toEqual({ opId, op: { kind: 'hammer', x: 1, y: 1 } });
    // A second challenge is a new round: the dialog (keyed by it in App) starts afresh, with
    // no token left from the first.
    expect(game.ui.get().challengeRound).toBe(1);
    sockets[1]!.close(CHALLENGE_CLOSE);
    expect(game.ui.get()).toMatchObject({ challenge: true, challengeRound: 2 });
  });

  it('opens a socket when zoomed in; its grid replaces the CDN map in one step', async () => {
    const cdn = new Cdn();
    cdn.publish(
      {
        from: 0,
        to: 3,
        diffs: [
          { index: index(1, 1), cell: 7, shield: 0 },
          { index: index(5, 5), cell: 1, shield: 0 },
        ],
      },
      [[0, 3]],
    );
    const { game, sockets, store, zoom } = page('player', cdn);
    // Watching zoomed out first: the map comes from the CDN.
    zoom(1);
    game.start();
    await flush();
    expect(sockets).toHaveLength(0);
    expect(store.cell(1, 1)).toBe(7);
    zoom(4);
    expect(sockets).toHaveLength(1);
    expect(game.ui.get().connection).toEqual({ state: 'connecting' });
    await flush();
    // Until the socket's grid is complete, the CDN map stays on screen.
    expect(store.cell(1, 1)).toBe(7);
    const socket = sockets[0]!;
    socket.open();
    // A grid of two frames: the first full, the second not. Even a long wait between them
    // (a slow link) leaves the CDN map on screen.
    sendFullFrame(socket, 10);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.cell(1, 1)).toBe(7);
    expect(store.cell(0, FULL_ROW)).toBe(0);
    let draws = 0;
    store.subscribe(() => draws++);
    sendGrid(socket, 10, [
      [1, 1, 8],
      [2, 2, 3],
    ]);
    expect(draws).toBe(1);
    expect(store.cell(1, 1)).toBe(8);
    expect(store.cell(2, 2)).toBe(3);
    expect(store.cell(0, FULL_ROW)).toBe(2);
    // The config frame that follows changes nothing on the map.
    sendConfig(socket);
    expect(draws).toBe(1);
    // The grid replaces the CDN map: a cell it does not have is empty.
    expect(store.cell(5, 5)).toBe(0);
    // Live frames apply directly, and the CDN rests.
    socket.receive(
      encodeServerMessage({
        type: 'diffs',
        seq: 11,
        diffs: [{ index: index(3, 3), cell: 4, shield: 0 }],
      }),
    );
    expect(store.cell(3, 3)).toBe(4);
    const reads = cdn.reads;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cdn.reads).toBe(reads);
  });

  it('loads the map from the CDN first on a page load that plays, then resumes from it (ADR 0040)', async () => {
    const cdn = new Cdn();
    cdn.publish({ from: 0, to: 3, diffs: [{ index: index(1, 1), cell: 7, shield: 0 }] }, [[0, 3]]);
    const { game, sockets, sinces, store } = page('player', cdn);
    game.start();
    await flush();
    // Every tile from the CDN (empty at version 0, then the segment): the socket says so.
    expect(cdn.reads).toBe(1);
    expect(sinces).toEqual([3]);
    const socket = sockets[0]!;
    socket.open();
    // Changes since 3, not the whole map: the CDN's cell stays.
    socket.receive(encodeServerMessage({ type: 'resume', from: 3 }));
    sendGrid(socket, 10, [[2, 2, 5]]);
    sendConfig(socket);
    expect([store.cell(1, 1), store.cell(2, 2)]).toEqual([7, 5]);
    // The feed rests while the socket keeps the map.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cdn.reads).toBe(1);
  });

  it('opens its socket without a since when the CDN does not bring the map in time', async () => {
    const cdn = new Cdn();
    const { game, sockets, sinces } = page('player', cdn);
    // A tile the CDN lists but cannot serve.
    cdn.manifest = cdn.at(5, [], [5, 0, 0, 0]);
    game.start();
    await flush();
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(BOOTSTRAP_MS);
    expect(sinces).toEqual([null]);
  });

  it('resumes after a drop from the seq its socket left the map at', async () => {
    const { game, socket, sockets, sinces, store } = await playing();
    socket.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sinces).toEqual([3, 10]);
    const next = sockets[1]!;
    next.open();
    next.receive(encodeServerMessage({ type: 'resume', from: 10 }));
    sendGrid(next, 12, [[6, 6, 2]]);
    sendConfig(next);
    expect([store.cell(1, 1), store.cell(2, 2), store.cell(6, 6)]).toEqual([8, 3, 2]);
    expect(game.playing).toBe(true);
  });

  it('asks for the whole map again after a Resume frame it cannot apply', async () => {
    const { socket, sockets, sinces } = await playing();
    socket.close();
    await vi.advanceTimersByTimeAsync(5_000);
    const next = sockets[1]!;
    next.open();
    // Past the seq the page sent: changes after it would leave a gap. The socket closes, and
    // the next one, on the usual backoff, asks for the whole map.
    next.receive(encodeServerMessage({ type: 'resume', from: 11 }));
    expect(next.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(3);
    expect(sinces.at(-1)).toBeNull();
  });

  it('never resumes a map whose canvas it does not know (a season changed under it)', async () => {
    const { game, socket, sockets, sinces } = await playing();
    game.mapCanvas = null;
    socket.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(2);
    expect(sinces.at(-1)).toBeNull();
  });

  it('opens no socket when the page stops playing while it loads the map from the CDN', async () => {
    const cdn = new Cdn();
    // A tile the CDN lists but cannot serve: the page waits for it.
    cdn.manifest = cdn.at(5, [], [5, 0, 0, 0]);
    const { game, sockets } = page('player', cdn);
    game.start();
    await flush();
    game.setRole('watcher');
    await vi.advanceTimersByTimeAsync(2 * BOOTSTRAP_MS);
    expect(sockets).toHaveLength(0);
  });

  it('resumes without a CDN too, from the seq its last socket left the map at', async () => {
    const { game, sockets, sinces, store } = page('player', new Cdn(), null);
    game.start();
    // Nothing held yet: the whole map.
    expect(sinces).toEqual([null]);
    sockets[0]!.open();
    sendGrid(sockets[0]!, 10, [[1, 1, 8]]);
    sendConfig(sockets[0]!);
    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sinces).toEqual([null, 10]);
    sockets[1]!.open();
    sockets[1]!.receive(encodeServerMessage({ type: 'resume', from: 10 }));
    sendGrid(sockets[1]!, 11, [[2, 2, 3]]);
    sendConfig(sockets[1]!);
    expect([store.cell(1, 1), store.cell(2, 2)]).toEqual([8, 3]);
  });

  it('ends a grid that fills its last frame at the first live frame', async () => {
    const { game, sockets, store } = page('player');
    game.start();
    await flush();
    const socket = sockets[0]!;
    socket.open();
    sendFullFrame(socket, 10);
    expect(store.cell(0, FULL_ROW)).toBe(0);
    sendGrid(socket, 11, [[3, 1, 8]]);
    expect([store.cell(0, FULL_ROW), store.cell(3, 1)]).toEqual([2, 8]);
  });

  it('gives the socket back after a minute zoomed out, once no op waits for its answer', async () => {
    const { game, internals, socket, zoom, cdn, store } = await playing();
    zoom(PLAY_MIN_ZOOM / 2);
    internals.sent.set(5, { itemId: 1, kind: 'hammer', discard: false });
    await vi.advanceTimersByTimeAsync(SOCKET_IDLE_MS + 5_000);
    expect(socket.readyState).toBe(1);
    expect(game.playing).toBe(true);
    internals.onAck(5, true, null);
    expect(socket.readyState).toBe(3);
    expect(game.playing).toBe(false);
    expect(game.ui.get().connection).toEqual({ state: 'cdn', ok: true });
    // Back on the CDN, from the socket's seq: the manifest at 3 is behind it, so the map
    // stays as the socket left it.
    await flush();
    expect(store.cell(1, 1)).toBe(8);
    // Then the CDN passes it with a segment; no tile is reloaded.
    cdn.publish({ from: 9, to: 12, diffs: [{ index: index(4, 4), cell: 6, shield: 0 }] }, [
      [0, 3],
      [3, 9],
      [9, 12],
    ]);
    cdn.objectReads = [];
    await vi.advanceTimersByTimeAsync(2_000);
    // The map was already shown: the segment's change is spread over the next poll interval.
    await vi.advanceTimersByTimeAsync(SPREAD_MS);
    expect(store.cell(4, 4)).toBe(6);
    expect(store.cell(1, 1)).toBe(8);
    expect(cdn.objectReads).toEqual([`${BASE}/diffs/9-12.bin.gz`]);
  });

  it('keeps the socket when zoomed back in within the minute', async () => {
    const { game, sockets, socket, zoom } = await playing();
    zoom(1);
    await vi.advanceTimersByTimeAsync(SOCKET_IDLE_MS / 2);
    zoom(4);
    await vi.advanceTimersByTimeAsync(2 * SOCKET_IDLE_MS);
    expect(socket.readyState).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(game.playing).toBe(true);
  });

  it('gives the socket back after a minute hidden, and opens a new one when shown', async () => {
    const { game, sockets, socket } = await playing();
    game.setHidden(true);
    await vi.advanceTimersByTimeAsync(SOCKET_IDLE_MS - 1);
    expect(socket.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.readyState).toBe(3);
    game.setHidden(false);
    expect(sockets).toHaveLength(2);
    expect(game.playing).toBe(true);
  });

  it('asks to zoom in rather than sending a move while watching', async () => {
    const { game, zoom } = await playing();
    zoom(1);
    await vi.advanceTimersByTimeAsync(SOCKET_IDLE_MS);
    expect(game.playing).toBe(false);
    game.ui.update({
      hold: { ...game.ui.get().hold, items: [{ kind: 'hammer', id: 1 }] },
      selected: 1,
    });
    game.useAt({ x: 1, y: 1 });
    expect(game.ui.get().notices.at(-1)?.notice.title).toBe('Zoom in to play');
  });

  it('lets the CDN keep the map current while a dropped socket reconnects', async () => {
    const { socket, cdn, store } = await playing();
    const reads = cdn.reads;
    socket.close();
    await flush();
    expect(cdn.reads).toBe(reads + 1);
    // The map stays as the socket left it while the CDN is behind.
    expect(store.cell(1, 1)).toBe(8);
  });

  it('shows a grid at its last frame, even with no config or hold frame after it', () => {
    const { game, sockets, store } = page('watcher', new Cdn(), null);
    game.start();
    const socket = sockets[0]!;
    socket.open();
    sendGrid(socket, 4, [[1, 1, 8]]);
    expect(store.cell(1, 1)).toBe(8);
  });

  it('carries on from the last complete seq when a socket closes mid-seq', async () => {
    const { socket, cdn, store } = await playing();
    // Seq 11 needs two frames; the socket closes after the first (full) one.
    const first = Array.from({ length: MAX_DIFFS_PER_FRAME }, (_, i) => ({
      index: i,
      cell: 1,
      shield: 0,
    }));
    socket.receive(encodeServerMessage({ type: 'diffs', seq: 11, diffs: first }));
    socket.close();
    // The CDN's segment for 10..11 carries the cell the lost frame had.
    cdn.publish(
      {
        from: 10,
        to: 11,
        diffs: [...first, { index: index(500, 500), cell: 9, shield: 0 }],
      },
      [
        [0, 3],
        [3, 10],
        [10, 11],
      ],
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.cell(500, 500)).toBe(9);
  });

  it('reads the map from the CDN when it stops playing before its socket brought one', async () => {
    const cdn = new Cdn();
    cdn.publish({ from: 0, to: 3, diffs: [{ index: index(1, 1), cell: 7, shield: 0 }] }, [[0, 3]]);
    const { game, sockets, store } = page('player', cdn);
    game.start();
    await flush();
    // The socket never delivers a grid (a slow link, a 503 storm); then the session ends.
    expect(sockets).toHaveLength(1);
    const reads = cdn.reads;
    game.setRole('watcher');
    // Watching again, the feed carries on (ADR 0040: it loaded the map before the socket).
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cdn.reads).toBeGreaterThan(reads);
    expect(store.cell(1, 1)).toBe(7);
  });

  it('reloads the tiles out of view once a player whose socket dropped stops playing', async () => {
    const { game, internals, socket, cdn, store } = await playing();
    // Only tile 0 is in view.
    internals.setCamera({ cx: 100, cy: 100, zoom: 4 });
    // While the socket was away, the CDN resynced: every tile at seq 20, no segment.
    cdn.resync(20, [
      [50, 50, 6],
      [400, 400, 5],
    ]);
    socket.close();
    await flush();
    // Reconnecting, the feed keeps the view current and loads nothing out of view.
    expect(store.cell(50, 50)).toBe(6);
    expect(store.cell(400, 400)).toBe(0);
    game.setRole('watcher');
    await flush();
    expect(store.cell(400, 400)).toBe(5);
  });

  it('turning into a watcher gives the socket back at once', async () => {
    const { game, socket, sockets } = await playing();
    game.setRole('watcher');
    expect(socket.readyState).toBe(3);
    expect(sockets).toHaveLength(1);
    expect(game.playing).toBe(false);
  });
});

describe('the players-at-once cap (ADR 0039)', () => {
  const hold = () =>
    encodeServerMessage({
      type: 'hold',
      capacity: 3,
      cooldown: 60_000,
      nextIn: 1000,
      revision: 1,
      items: [{ kind: 'brick', shape: 1 }],
    });
  const titles = (game: Game) => game.ui.get().notices.map((n) => n.notice.title);

  it('watches when turned away, and tries again after 45 to 90 s', async () => {
    const { game, sockets } = page('player');
    game.start();
    await flush();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    sockets[0]!.close(MAP_FULL_CLOSE);
    expect(game.playing).toBe(false);
    expect(game.ui.get().connection).toEqual({ state: 'cdn', ok: true });
    expect(titles(game)).toContain('The map is full');
    // A move says so again rather than going nowhere.
    expect((game as unknown as { notPlaying(): boolean }).notPlaying()).toBe(true);
    // `random` is 0 here: the shortest wait, FULL_RETRY_MS.
    await vi.advanceTimersByTimeAsync(FULL_RETRY_MS - 1);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    expect(game.playing).toBe(true);
    // Its first hold says the wait is over, once.
    sockets[1]!.open();
    sockets[1]!.receive(hold());
    expect(titles(game).at(-1)).toBe('You are in');
    sockets[1]!.receive(hold());
    expect(titles(game).filter((t) => t === 'You are in')).toHaveLength(1);
  });

  it('waits first when the stats say the map is full, then asks the server on each retry', async () => {
    const { game, sockets } = page('player');
    const said = vi.spyOn(game, 'notify');
    game.mapFull = () => true;
    game.start();
    await flush();
    expect(sockets).toHaveLength(0);
    expect(said.mock.calls.map(([n]) => n.title)).toEqual(['The map is full']);
    // The retry opens a socket although the stats still say full: they count idle players,
    // and only a join makes the server free one's place.
    await vi.advanceTimersByTimeAsync(FULL_RETRY_MS);
    expect(sockets).toHaveLength(1);
    // Turned away again: the wait goes on, without a second notice.
    sockets[0]!.open();
    sockets[0]!.close(MAP_FULL_CLOSE);
    expect(said).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FULL_RETRY_MS);
    expect(sockets).toHaveLength(2);
  });

  it('ends the wait when the page stops wanting to play, and says so again next time', async () => {
    const { game, sockets, zoom } = page('player');
    const said = vi.spyOn(game, 'notify');
    game.mapFull = () => true;
    game.start();
    await flush();
    zoom(PLAY_MIN_ZOOM / 2);
    await vi.advanceTimersByTimeAsync(2 * FULL_RETRY_MS);
    expect(sockets).toHaveLength(0);
    zoom(4);
    expect(sockets).toHaveLength(0);
    expect(said.mock.calls.map(([n]) => n.title)).toEqual(['The map is full', 'The map is full']);
  });

  it('does not retry while hidden, even without a CDN, where hidden pages keep sockets', async () => {
    const { game, sockets } = page('player', new Cdn(), null);
    game.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    sockets[0]!.close(MAP_FULL_CLOSE);
    game.setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * FULL_RETRY_MS);
    expect(sockets).toHaveLength(1);
    game.setHidden(false);
    await vi.advanceTimersByTimeAsync(2 * FULL_RETRY_MS);
    expect(sockets).toHaveLength(2);
  });

  it('gives the place up for good until the player asks to play again', async () => {
    const { game, sockets } = page('player');
    game.start();
    await flush();
    sockets[0]!.open();
    sockets[0]!.close(GAVE_UP_PLACE_CLOSE);
    expect(game.playing).toBe(false);
    expect(game.waitingToPlay).toBe(true);
    const notice = game.ui.get().notices.at(-1)!.notice;
    expect(notice.title).toBe('You gave up your place');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sockets).toHaveLength(1);
    // Shown again after being hidden: it says so, and still waits to be asked.
    game.setHidden(true);
    game.setHidden(false);
    expect(titles(game).at(-1)).toBe('You gave up your place');
    expect(sockets).toHaveLength(1);
    notice.action!.run();
    expect(game.waitingToPlay).toBe(false);
    expect(sockets).toHaveLength(2);
    expect(game.playing).toBe(true);
  });
});
