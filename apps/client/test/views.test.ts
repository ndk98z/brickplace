import { TILE_SIZE } from '@brickplace/core';
import {
  type ClientMessage,
  type ConfigMessage,
  decodeClientMessage,
  encodeServerMessage,
} from '@brickplace/protocol';
import { CDN_FORMAT } from '@brickplace/protocol/cdn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../src/config.ts';
import { Game, VIEW_EVERY_MS } from '../src/game/game.ts';
import { visibleCells } from '../src/map/camera.ts';
import { CdnFeed } from '../src/net/cdn.ts';
import type { SocketLike } from '../src/net/connection.ts';

// Per-tile subscriptions (ADR 0028): the page tells its socket which cells it shows (the
// server follows their tiles plus a margin), takes a tile coming back into view whole, and
// hands the tiles it left to the CDN at the seq it left them.

/** 4 x 4 tiles. */
const SIZE = 1024;
const OPEN = { x: 0, y: 0, w: SIZE, h: SIZE };
const index = (x: number, y: number) => y * SIZE + x;

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  private handlers: Record<string, ((event: { data: unknown; code?: number }) => void)[]> = {};

  addEventListener(
    type: string,
    listener: (event: { data: unknown; code?: number }) => void,
  ): void {
    this.handlers[type] = [...(this.handlers[type] ?? []), listener];
  }
  send(data: ArrayBuffer): void {
    this.sent.push(decodeClientMessage(new Uint8Array(data)));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  receive(frame: Uint8Array): void {
    this.emit('message', frame.slice().buffer);
  }
  views() {
    return this.sent.filter((m) => 'view' in m);
  }
  /** The views that subscribe (ADR 0028). */
  subscribed() {
    return this.views().filter((m) => 'subscribe' in m && m.subscribe === true);
  }
  private emit(type: string, data?: unknown): void {
    for (const h of this.handlers[type] ?? []) h({ data });
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
  socketGone(): void;
}

/**
 * A page whose socket brought its grid at seq 10 and a config frame. With a tiles URL the page
 * first loads the map from the CDN (ADR 0040): every tile is empty at version 0 here.
 */
async function playing(views: boolean | undefined, tilesUrl: string | null = null) {
  const sockets: FakeSocket[] = [];
  const manifest = {
    format: CDN_FORMAT,
    seq: 0,
    size: SIZE,
    tileSize: TILE_SIZE,
    open: OPEN,
    maxShield: 5,
    tiles: new Array(16).fill(0),
    segments: [],
  };
  const game = new Game(config(tilesUrl), 'guest', () => 0, {
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    cdn: {
      fetchText: async () => JSON.stringify(manifest),
      fetchGzip: async () => {
        throw new Error('no objects here');
      },
    },
  });
  const internals = game as unknown as Internals;
  // Tile (0, 0) in view, before the socket: the view sent later is this one plus a margin.
  internals.setCamera({ cx: 100, cy: 100, zoom: 4 });
  game.start();
  await vi.advanceTimersByTimeAsync(0);
  const socket = sockets[0]!;
  socket.open();
  socket.receive(
    encodeServerMessage({
      type: 'diffs',
      seq: 10,
      diffs: [{ index: index(700, 700), cell: 4, shield: 0 }],
    }),
  );
  const message: ConfigMessage = {
    type: 'config',
    mapSize: SIZE,
    open: OPEN,
    maxShield: 5,
    ...(views === undefined ? {} : { locks: [], views }),
  };
  socket.receive(encodeServerMessage(message));
  return { game, internals, socket, sockets, store: game.store };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('visibleCells', () => {
  it('takes the whole cells in view, clamped to the map', () => {
    const viewport = { width: 400, height: 200 };
    expect(visibleCells({ cx: 600, cy: 600, zoom: 2 }, viewport, SIZE)).toEqual({
      x: 500,
      y: 550,
      w: 200,
      h: 100,
    });
    expect(visibleCells({ cx: 0, cy: 0, zoom: 64 }, viewport, SIZE)).toEqual({
      x: 0,
      y: 0,
      w: 4,
      h: 2,
    });
    // 1600 x 800 cells: clamped across, 112..912 down.
    expect(visibleCells({ cx: 512, cy: 512, zoom: 0.25 }, viewport, SIZE)).toEqual({
      x: 0,
      y: 112,
      w: SIZE,
      h: 800,
    });
  });
});

describe('views', () => {
  it('subscribes once the server says it takes views, then at most twice a second', async () => {
    const { internals, socket } = await playing(true);
    // The 1x1 px test viewport at (100, 100), zoom 4: cells 99..100. The plain view (the bot
    // signal, ADR 0026) went out when the socket opened; the subscribing one once the config
    // frame said `views`.
    const shown = { x: 99, y: 99, w: 2, h: 2 };
    expect(socket.views()).toEqual([{ view: shown }, { view: shown, subscribe: true }]);
    // Panned to tile (3, 3): sent only once half a second has passed since the last view.
    internals.setCamera({ cx: 900, cy: 900, zoom: 4 });
    internals.setCamera({ cx: 950, cy: 950, zoom: 4 });
    expect(socket.subscribed()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(VIEW_EVERY_MS);
    expect(socket.subscribed()[1]).toEqual({
      view: { x: 949, y: 949, w: 2, h: 2 },
      subscribe: true,
    });
    // The same view is not sent again.
    internals.setCamera({ cx: 950, cy: 950, zoom: 4 });
    await vi.advanceTimersByTimeAsync(VIEW_EVERY_MS);
    expect(socket.views()).toHaveLength(3);
  });

  it('sends only plain views to a server that did not say it takes subscriptions', async () => {
    for (const views of [undefined, false]) {
      const { internals, socket } = await playing(views);
      internals.setCamera({ cx: 900, cy: 900, zoom: 4 });
      await vi.advanceTimersByTimeAsync(VIEW_EVERY_MS);
      expect(socket.views().length).toBeGreaterThan(0);
      expect(socket.views().every((m) => !('subscribe' in m))).toBe(true);
    }
  });

  it('replaces a tile coming back into view with the Tile frame', async () => {
    const { socket, store } = await playing(true);
    const cells = new Uint8Array(TILE_SIZE * TILE_SIZE);
    cells[(700 - 512) * TILE_SIZE + (700 - 512)] = 9;
    socket.receive(
      encodeServerMessage({
        type: 'tile',
        seq: 12,
        tx: 2,
        ty: 2,
        edge: TILE_SIZE,
        cells,
        shields: new Uint8Array(TILE_SIZE * TILE_SIZE),
      }),
    );
    expect(store.cell(700, 700)).toBe(9);
    // A tile this map does not have is ignored.
    socket.receive(
      encodeServerMessage({
        type: 'tile',
        seq: 12,
        tx: 9,
        ty: 0,
        edge: TILE_SIZE,
        cells,
        shields: new Uint8Array(TILE_SIZE * TILE_SIZE),
      }),
    );
  });

  it('hands the tiles it left to the CDN at the seq it left them', async () => {
    const adopt = vi.spyOn(CdnFeed.prototype, 'adopt');
    const { internals, socket } = await playing(true, 'https://tiles.test/c/canvas');
    // The first view (tiles 0..1 a side) left the other tiles at seq 10.
    socket.receive(encodeServerMessage({ type: 'diffs', seq: 12, diffs: [] }));
    internals.socketGone();
    const seqs = adopt.mock.calls.at(-1)![0] as number[];
    expect(seqs).toHaveLength(16);
    expect(seqs[0]).toBe(12);
    expect(seqs[1 * 4 + 1]).toBe(12);
    expect(seqs[2]).toBe(10);
    expect(seqs[3 * 4 + 3]).toBe(10);
  });

  it('starts every new socket on every tile, and sends the view again', async () => {
    const { socket, sockets } = await playing(true);
    expect(socket.subscribed()).toHaveLength(1);
    socket.close();
    // The first retry comes within 1 to 5 s (ADR 0040).
    await vi.advanceTimersByTimeAsync(5000);
    const next = sockets[1]!;
    next.open();
    next.receive(encodeServerMessage({ type: 'diffs', seq: 20, diffs: [] }));
    // Only the plain view before the server says it takes views: every tile meanwhile.
    expect(next.subscribed()).toEqual([]);
    next.receive(
      encodeServerMessage({
        type: 'config',
        mapSize: SIZE,
        open: OPEN,
        maxShield: 5,
        locks: [],
        views: true,
      }),
    );
    expect(next.subscribed()).toEqual([{ view: { x: 99, y: 99, w: 2, h: 2 }, subscribe: true }]);
  });
});
