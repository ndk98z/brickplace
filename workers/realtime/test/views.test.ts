import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DEFAULT_MAP_SIZE } from '@brickplace/core';
import { foldNow } from '@brickplace/game/journal';
import {
  decodeServerMessage,
  encodeClientOp,
  encodeClientView,
  MAX_DIFFS_PER_FRAME,
  type ServerMessage,
} from '@brickplace/protocol';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/index.ts';
import { CANVAS_HEADER, PLAYER_HEADER, WATCH_HEADER } from '../src/player.ts';
import {
  addedTiles,
  maskOf,
  RECORD_BYTES,
  TickFrames,
  tileFrame,
  tileGrid,
  toRecords,
} from '../src/views.ts';
import { WAIT_MS } from './wait.ts';

// Diff ticks across shards and per-socket tile views (ADR 0028). Each test uses a canvas of its
// own, and ticks leave a canvas only when a test pushes them (setup.ts). Canvases have the
// default map: 1024², 4×4 tiles of 256, the open area cells 256..767 (tiles 1 and 2 a side).

const { FANOUT, CANVAS } = env as unknown as Env;
const SIZE = DEFAULT_MAP_SIZE;
const at = (x: number, y: number) => y * SIZE + x;
const brickAt = (x: number, y: number) =>
  ({ kind: 'brick', x, y, shape: 1, rotation: 0, color: 3 }) as const;

async function stock(canvas: string, player: string, bricks = 4) {
  const items = JSON.stringify(Array.from({ length: bricks }, () => ({ kind: 'brick', shape: 1 })));
  await runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance, state) => {
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      items,
      2 ** 50,
    );
  });
}

type Frame = Exclude<ServerMessage, { type: 'hold' } | { type: 'config' }>;

/** A socket on shard `fanout` of `canvas`: a player, or a watcher when `player` is null. */
async function connect(canvas: string, fanout: string, player: string | null) {
  const headers: Record<string, string> = { Upgrade: 'websocket', [CANVAS_HEADER]: canvas };
  if (player === null) headers[WATCH_HEADER] = '1';
  else headers[PLAYER_HEADER] = player;
  const stub = FANOUT.get(FANOUT.idFromName(fanout));
  const response = await stub.fetch('https://fanout/ws', { headers });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.binaryType = 'arraybuffer';
  const inbox: Frame[] = [];
  ws.addEventListener('message', (event) => {
    const message = decodeServerMessage(new Uint8Array(event.data as ArrayBuffer));
    if (message.type === 'hold' || message.type === 'config') return;
    inbox.push(message);
  });
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (event) => resolve(event.code));
  });
  ws.accept();
  /** The next frame (polled: see the note on `until` in fanout.test.ts). */
  const next = async (what = 'frame'): Promise<Frame> => {
    for (let tries = 0; inbox.length === 0; tries++) {
      if (tries * 5 > WAIT_MS) throw new Error(`no ${what} within ${WAIT_MS} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return inbox.shift()!;
  };
  const nextOf = async <T extends Frame['type']>(type: T) => {
    const message = await next(type);
    if (message.type !== type) throw new Error(`expected ${type}, got ${message.type}`);
    return message as Extract<Frame, { type: T }>;
  };
  /** Waits a little and says whether anything arrived. */
  const quiet = async (ms = 100) => {
    await new Promise((r) => setTimeout(r, ms));
    return inbox.length === 0;
  };
  const grid = await nextOf('diffs');
  return {
    ws,
    stub,
    closed,
    grid,
    inbox,
    next,
    nextOf,
    quiet,
    op: (opId: number, x: number, y: number) =>
      ws.send(encodeClientOp({ opId, op: brickAt(x, y) })),
    /** A subscribing view of these cells (ADR 0028). */
    view: (x: number, y: number, w: number, h: number) =>
      ws.send(encodeClientView({ view: { x, y, w, h }, subscribe: true })),
    /** A view without the flag, as the bot signal's clients send it (ADR 0026). */
    plainView: (x: number, y: number, w: number, h: number) =>
      ws.send(encodeClientView({ view: { x, y, w, h } })),
  };
}

/** Pushes the canvas's tick and waits until `fanout` took it. */
async function pushed(canvas: string, fanout: string): Promise<void> {
  const stub = CANVAS.get(CANVAS.idFromName(canvas));
  await stub.pushTicks();
  const { seq } = await stub.status();
  for (let tries = 0; ; tries++) {
    const acked = await runInDurableObject(stub, (instance: unknown) => {
      const { pusher } = instance as {
        pusher: { shards: Map<string, { acked: number | null; inFlight: boolean }> };
      };
      const shard = pusher.shards.get(fanout);
      return shard && !shard.inFlight ? shard.acked : null;
    });
    if ((acked ?? -1) >= seq) return;
    if (tries * 10 > WAIT_MS) throw new Error(`${fanout} did not take the tick to ${seq}`);
    await new Promise((r) => setTimeout(r, 10));
    // A shard that followed again while answering has its cursor raised by its next answer.
    if (tries % 10 === 9) await stub.pushTicks();
  }
}

async function following(canvas: string): Promise<string[]> {
  return runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance: unknown) => [
    ...(instance as { pusher: { following: readonly string[] } }).pusher.following,
  ]);
}

describe('diff ticks between shards', () => {
  it("brings every shard the others' ops in one tick, and never twice", async () => {
    await stock('c-ticks', 'pa');
    const a = await connect('c-ticks', 'c-ticks:fanout-0', 'pa');
    const b = await connect('c-ticks', 'c-ticks:fanout-1', null);
    expect(await following('c-ticks')).toEqual(['c-ticks:fanout-0', 'c-ticks:fanout-1']);
    a.op(1, 600, 600);
    expect(await a.nextOf('ack')).toEqual({ type: 'ack', opId: 1, ok: true });
    // The op's own shard sends it at once, from the reply.
    const own = await a.nextOf('diffs');
    expect(own.seq).toBe(a.grid.seq + 1);
    expect(own.diffs).toHaveLength(4);
    // The other shard only hears of it with the tick.
    expect(await b.quiet()).toBe(true);
    a.op(2, 610, 600);
    await a.nextOf('ack');
    await a.nextOf('diffs');
    await pushed('c-ticks', 'c-ticks:fanout-1');
    await pushed('c-ticks', 'c-ticks:fanout-0');
    const tick = await b.nextOf('diffs');
    expect(tick.seq).toBe(b.grid.seq + 2);
    expect(tick.diffs).toHaveLength(8);
    expect(tick.diffs).toContainEqual({ index: at(600, 600), cell: own.diffs[0]!.cell, shield: 0 });
    // Shard a already had both: the tick sends its sockets nothing.
    expect(await a.quiet()).toBe(true);
    a.ws.close();
    b.ws.close();
  });

  it('stops pushing to a shard with no sockets left, until one joins again', async () => {
    await stock('c-empty', 'pe');
    const a = await connect('c-empty', 'c-empty:fanout-0', 'pe');
    const b = await connect('c-empty', 'c-empty:fanout-1', null);
    b.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    a.op(1, 600, 610);
    await a.nextOf('ack');
    await CANVAS.get(CANVAS.idFromName('c-empty')).pushTicks();
    for (let tries = 0; (await following('c-empty')).length > 1; tries++) {
      if (tries * 10 > WAIT_MS) throw new Error('shard 1 still followed');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await following('c-empty')).toEqual(['c-empty:fanout-0']);
    // A new socket on it follows again, from a fresh grid that has the op.
    const c = await connect('c-empty', 'c-empty:fanout-1', null);
    expect(c.grid.diffs.map((d) => d.index)).toContain(at(600, 610));
    expect(await following('c-empty')).toContain('c-empty:fanout-1');
    a.ws.close();
    c.ws.close();
  });

  it('brings a shard woken by a tick up to date from its cursor', async () => {
    await stock('c-wake', 'pw');
    const a = await connect('c-wake', 'c-wake:fanout-0', 'pw');
    const b = await connect('c-wake', 'c-wake:fanout-1', null);
    await evictDurableObject(b.stub);
    a.op(1, 600, 620);
    await a.nextOf('ack');
    await pushed('c-wake', 'c-wake:fanout-1');
    const tick = await b.nextOf('diffs');
    expect(tick.seq).toBe(b.grid.seq + 1);
    expect(tick.diffs.map((d) => d.index)).toContain(at(600, 620));
    a.ws.close();
    b.ws.close();
  });
});

/** Sets fields of the canvas's TickPusher (limits tests lower). */
async function tunePusher(canvas: string, fields: Record<string, unknown>): Promise<void> {
  await runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance: unknown) => {
    Object.assign((instance as { pusher: object }).pusher, fields);
  });
}

describe('when the canvas cannot say what a shard missed', () => {
  it('closes the sockets of an evicted shard woken by a tick too big to list', async () => {
    await stock('c-big', 'pb');
    const a = await connect('c-big', 'c-big:fanout-0', 'pb');
    const b = await connect('c-big', 'c-big:fanout-1', null);
    // A tick of more cells than the canvas lists (as the expiry of many shields can be).
    await tunePusher('c-big', { maxTickCells: 2 });
    await evictDurableObject(b.stub);
    a.op(1, 600, 640);
    await a.nextOf('ack');
    await CANVAS.get(CANVAS.idFromName('c-big')).pushTicks();
    expect(await b.closed).toBe(1012);
    a.ws.close();
  });

  it('resyncs a shard that still has its mirror from such a tick, sockets kept', async () => {
    await stock('c-big2', 'pb2');
    const a = await connect('c-big2', 'c-big2:fanout-0', 'pb2');
    const b = await connect('c-big2', 'c-big2:fanout-1', null);
    await tunePusher('c-big2', { maxTickCells: 2 });
    a.op(1, 600, 650);
    await a.nextOf('ack');
    await pushed('c-big2', 'c-big2:fanout-1');
    const resync = await b.nextOf('diffs');
    expect(resync.seq).toBe(b.grid.seq + 1);
    expect(resync.diffs).toHaveLength(4);
    a.ws.close();
    b.ws.close();
  });

  it('repairs an evicted shard after a canvas restart from the cursor it saved', async () => {
    await stock('c-restart', 'pr');
    const a = await connect('c-restart', 'c-restart:fanout-0', 'pr');
    const b = await connect('c-restart', 'c-restart:fanout-1', null);
    const canvas = CANVAS.get(CANVAS.idFromName('c-restart'));
    await evictDurableObject(canvas);
    await evictDurableObject(b.stub);
    a.op(1, 600, 660);
    await a.nextOf('ack');
    await pushed('c-restart', 'c-restart:fanout-1');
    const repair = await b.nextOf('diffs');
    expect(repair.diffs.map((d) => d.index)).toContain(at(600, 660));
    a.ws.close();
    b.ws.close();
  });

  it('closes the sockets of an evicted shard whose cursor a restarted canvas lost', async () => {
    await stock('c-lost', 'pl');
    const a = await connect('c-lost', 'c-lost:fanout-0', 'pl');
    const b = await connect('c-lost', 'c-lost:fanout-1', null);
    const canvas = CANVAS.get(CANVAS.idFromName('c-lost'));
    // No saved cursor (as for one older than the canvas's checkpoint).
    await runInDurableObject(canvas, (_, state) => {
      state.storage.sql.exec('UPDATE fanout_shards SET acked = NULL');
    });
    await evictDurableObject(canvas);
    await evictDurableObject(b.stub);
    a.op(1, 600, 670);
    await a.nextOf('ack');
    // The push says its `from` (where the ring starts) is not b's cursor; b must not take it
    // as one, and the canvas cannot say what b's sockets have.
    await canvas.pushTicks();
    expect(await b.closed).toBe(1012);
    a.ws.close();
  });
});

describe('tile views', () => {
  // Tile (1, 1) holds cells 256..511, tile (2, 2) 512..767 and tile (3, 3) 768..1023. A view
  // of cells inside tile (3, 3) follows tiles 2..3 a side (one tile of margin, clamped).
  it('sends a socket only the tiles it views, and a newly viewed tile whole first', async () => {
    await stock('c-views', 'pv', 4);
    const player = await connect('c-views', 'c-views:fanout-0', 'pv');
    const watcher = await connect('c-views', 'c-views:fanout-0', null);
    watcher.view(800, 800, 100, 60);
    player.op(1, 300, 300);
    await player.nextOf('ack');
    await player.nextOf('diffs');
    // Outside the watcher's view: nothing.
    expect(await watcher.quiet()).toBe(true);
    player.op(2, 600, 630);
    await player.nextOf('ack');
    await player.nextOf('diffs');
    const seen = await watcher.nextOf('diffs');
    expect(seen.diffs.map((d) => d.index).sort()).toEqual(
      [at(600, 630), at(601, 630), at(600, 631), at(601, 631)].sort(),
    );
    // Widened (after the 250 ms interval) to tile (1, 1): its content first, at the seq the
    // diffs continue from, with the op it missed.
    await new Promise((r) => setTimeout(r, 260));
    watcher.view(300, 300, 600, 600);
    // Every tile now: only the 12 new ones, in tile order (2..3 a side were there already).
    const tiles = [];
    for (let i = 0; i < 12; i++) tiles.push(await watcher.nextOf('tile'));
    expect(tiles.map((t) => `${t.tx},${t.ty}`)).not.toContain('2,2');
    expect(tiles.map((t) => `${t.tx},${t.ty}`)).not.toContain('3,3');
    expect(new Set(tiles.map((t) => t.seq))).toEqual(new Set([seen.seq]));
    const tile = tiles.find((t) => t.tx === 1 && t.ty === 1)!;
    expect(tile.cells[(300 - 256) * 256 + (300 - 256)]).not.toBe(0);
    expect(await watcher.quiet()).toBe(true);
    player.op(3, 310, 300);
    await player.nextOf('ack');
    expect((await watcher.nextOf('diffs')).diffs).toHaveLength(4);
    player.ws.close();
    watcher.ws.close();
  });

  it('applies a view sent too soon once the interval ends, the latest one winning', async () => {
    const watcher = await connect('c-rate', 'c-rate:fanout-0', null);
    // Tiles 0..1 a side; then, too soon, two more views: only the last is applied.
    watcher.view(0, 0, 10, 10);
    watcher.view(600, 0, 10, 10);
    watcher.view(0, 600, 10, 10);
    const started = Date.now();
    const tile = await watcher.nextOf('tile');
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    // The last view follows tiles 0..1 by 1..3: rows 2 and 3 are new.
    const tiles = [tile];
    for (let i = 0; i < 3; i++) tiles.push(await watcher.nextOf('tile'));
    expect(tiles.map((t) => `${t.tx},${t.ty}`)).toEqual(['0,2', '1,2', '0,3', '1,3']);
    // Empty tiles are a few bytes, sparse.
    expect(tile.cells.every((c) => c === 0)).toBe(true);
    expect(await watcher.quiet(300)).toBe(true);
    watcher.ws.close();
  });

  it('holds Tile frames to the socket’s byte budget, sending the rest as it refills', async () => {
    const watcher = await connect('c-budget', 'c-budget:fanout-0', null);
    // An empty tile frame is 17 bytes: a burst of 20 lets two out, then one per 850 ms.
    await runInDurableObject(watcher.stub, (instance: unknown) => {
      Object.assign(instance as object, { tileBurst: 20, tileBytesPerMs: 0.02 });
    });
    watcher.view(0, 0, 10, 10);
    await new Promise((r) => setTimeout(r, 260));
    const started = Date.now();
    watcher.view(0, 600, 10, 10);
    const arrived: number[] = [];
    for (let i = 0; i < 3; i++) {
      await watcher.nextOf('tile');
      arrived.push(Date.now() - started);
    }
    expect(arrived[1]!).toBeLessThan(300);
    expect(arrived[2]!).toBeGreaterThanOrEqual(600);
    watcher.ws.close();
  });

  it('still sends the Tile frames a socket was owed when its shard was evicted', async () => {
    await stock('c-owed', 'po2', 2);
    const player = await connect('c-owed', 'c-owed:fanout-0', 'po2');
    const watcher = await connect('c-owed', 'c-owed:fanout-0', null);
    await runInDurableObject(watcher.stub, (instance: unknown) => {
      Object.assign(instance as object, { tileBurst: 20, tileBytesPerMs: 0.000_001 });
    });
    // The first view only narrows (the socket had every tile); the second adds tiles, of
    // which two go out at once and the rest wait for a refill that never comes here.
    watcher.view(0, 0, 10, 10);
    await new Promise((r) => setTimeout(r, 260));
    watcher.view(0, 600, 10, 10);
    const early = [await watcher.nextOf('tile'), await watcher.nextOf('tile')];
    const owed = await runInDurableObject(watcher.stub, (_, state) =>
      state
        .getWebSockets()
        .flatMap((ws) => (ws.deserializeAttachment() as { owed?: number[] }).owed ?? []),
    );
    expect(owed.length).toBeGreaterThan(0);
    expect(await watcher.quiet()).toBe(true);
    // The refill timer would hold up the eviction in the test runtime; an eviction loses it.
    await runInDurableObject(watcher.stub, (instance: unknown) => {
      const i = instance as { viewTimer: ReturnType<typeof setTimeout> | null };
      if (i.viewTimer !== null) clearTimeout(i.viewTimer);
      i.viewTimer = null;
    });
    await evictDurableObject(watcher.stub);
    // A join wakes the shard: restoring its mirror sends the owed tiles at once, without
    // waiting for a change to reach the socket.
    const other = await connect('c-owed', 'c-owed:fanout-0', null);
    other.ws.close();
    const late: (typeof early)[number][] = [];
    for (let i = 0; i < owed.length; i++) late.push(await watcher.nextOf('tile'));
    const names = (tiles: typeof late) => tiles.map((t) => `${t.tx},${t.ty}`);
    expect(new Set([...names(early), ...names(late)]).size).toBe(early.length + late.length);
    player.ws.close();
    watcher.ws.close();
  });

  it('applies only the latest of a burst of views sent before the first is applied', async () => {
    const watcher = await connect('c-burst', 'c-burst:fanout-0', null);
    type Views = {
      viewMinMs: number;
      subscriptions: Map<WebSocket, { pending: unknown }>;
      scheduleViews(at: number): void;
    };
    const fanout = (run: (instance: Views, state: DurableObjectState) => unknown) =>
      runInDurableObject(watcher.stub, (instance: unknown, state) => run(instance as Views, state));
    // The real interval is 250 ms...
    const real = (await fanout((instance) => instance.viewMinMs)) as number;
    expect(real).toBe(250);
    // ...widened for the burst, which no machine outlasts then: on a loaded 2-CPU runner the
    // 21 frames took longer than 250 ms to arrive, and a view from the middle was applied.
    await fanout((instance) => {
      instance.viewMinMs = 60_000;
    });
    // Views swinging between two far corners: each one applied would bring tiles back.
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) watcher.view(0, 600, 10, 10);
      else watcher.view(900, 900, 10, 10);
    }
    watcher.view(0, 0, 10, 10);
    const tilesFollowed = async () =>
      (await fanout((_, state) =>
        state.getWebSockets().map((ws) => ws.deserializeAttachment() as { tiles?: number[] }),
      )) as { tiles?: number[] }[];
    const latestWaits = async () =>
      (await fanout((instance, state) =>
        state
          .getWebSockets()
          .map((ws) => JSON.stringify(instance.subscriptions.get(ws)?.pending ?? null)),
      )) as string[];
    const latest = JSON.stringify({ x: 0, y: 0, w: 10, h: 10 });
    // Polled up to a generous deadline, not slept on (AGENTS.md): every frame of the burst has
    // arrived once the latest view waits for the interval (or, if the first view was still
    // queued when it came, was applied in its place).
    const followsLatest = async () =>
      (await tilesFollowed()).map((a) => a.tiles?.join(',')).join() === '0,0,2,2';
    // One deadline for both waits, inside the 15 s test timeout, so a slow path ends on an
    // assertion that says where it stopped.
    const deadline = Date.now() + 10_000;
    const arrived = async () => (await latestWaits()).join() === latest || (await followsLatest());
    while (!(await arrived()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await arrived()).toBe(true);
    // Back to the real interval, long passed since the first view: the latest one is applied.
    await fanout((instance) => {
      instance.viewMinMs = real;
      instance.scheduleViews(Date.now());
    });
    while (!(await followsLatest()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await tilesFollowed()).map((a) => a.tiles?.join(','))).toEqual(['0,0,2,2']);
    // At most two views applied (the first, then the latest once the interval ended): only
    // row 0's two tiles can have come back, never one Tile frame per view of the burst.
    expect(watcher.inbox.every((m) => m.type === 'tile' && m.ty === 0)).toBe(true);
    expect(watcher.inbox.length).toBeLessThanOrEqual(2);
    watcher.ws.close();
  });

  it('keeps a socket’s view across an eviction', async () => {
    await stock('c-keep', 'pk', 2);
    const player = await connect('c-keep', 'c-keep:fanout-0', 'pk');
    const watcher = await connect('c-keep', 'c-keep:fanout-0', null);
    // Tiles 2..3 a side: tile (1, 1) is out of it.
    watcher.view(800, 800, 10, 10);
    await new Promise((r) => setTimeout(r, 50));
    await evictDurableObject(watcher.stub);
    player.op(1, 300, 310);
    await player.nextOf('ack');
    await player.nextOf('diffs');
    expect(await watcher.quiet()).toBe(true);
    player.op(2, 610, 640);
    await player.nextOf('ack');
    expect((await watcher.nextOf('diffs')).diffs).toHaveLength(4);
    player.ws.close();
    watcher.ws.close();
  });

  it('lets watchers send views, and old clients that send none get every tile', async () => {
    await stock('c-old', 'po', 2);
    const player = await connect('c-old', 'c-old:fanout-0', 'po');
    const old = await connect('c-old', 'c-old:fanout-0', null);
    const plain = await connect('c-old', 'c-old:fanout-0', null);
    player.view(0, 0, 10, 10);
    // A view without the subscribe flag (the bot signal's) narrows nothing; it is kept.
    plain.plainView(0, 0, 10, 10);
    await new Promise((r) => setTimeout(r, 50));
    // Tile (2, 2): out of the player's tiles 0..1 a side.
    player.op(1, 600, 620);
    // The player still gets its ack, not the diffs of a tile it does not view.
    expect(await player.nextOf('ack')).toMatchObject({ ok: true });
    expect(await player.quiet()).toBe(true);
    expect((await old.nextOf('diffs')).diffs).toHaveLength(4);
    expect((await plain.nextOf('diffs')).diffs).toHaveLength(4);
    const kept = await runInDurableObject(plain.stub, (_, state) =>
      state.getWebSockets().map((ws) => ws.deserializeAttachment() as { view?: number[] }),
    );
    expect(kept.some((a) => a.view?.join(',') === '0,0,10,10')).toBe(true);
    player.ws.close();
    old.ws.close();
    plain.ws.close();
  });
});

describe('view frames (pure)', () => {
  // The largest map a later season may grow to (ADR 0027): 8×8 tiles, more room than the
  // default's 4×4 to tell tiles apart.
  const SIZE = 2048;
  const at = (x: number, y: number) => y * SIZE + x;
  const grid = tileGrid(SIZE);

  it('clamps a view to the map and lists the tiles it adds', () => {
    expect(grid).toEqual({ size: 2048, perSide: 8, count: 64 });
    const mask = maskOf({ x: 6, y: 6, w: 10, h: 10 }, grid);
    expect(addedTiles(maskOf({ x: 0, y: 0, w: 0, h: 0 }, grid), mask, grid)).toEqual([
      54, 55, 62, 63,
    ]);
    // From "every tile", narrowing adds nothing.
    expect(addedTiles(null, mask, grid)).toEqual([]);
  });

  it('splits a socket’s share of a big tick at MAX_DIFFS_PER_FRAME, all full but the last', () => {
    // Every cell of tile 0 and one of tile 63.
    const diffs = [];
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) diffs.push({ index: at(x, y), cell: 1, shield: 0 });
    }
    diffs.push({ index: at(2047, 2047), cell: 2, shield: 1 });
    const frames = new TickFrames(9, toRecords(diffs), grid);
    const tile0 = frames.framesFor(maskOf({ x: 0, y: 0, w: 1, h: 1 }, grid));
    const sizes = tile0.map(
      (f) => (decodeServerMessage(f) as { diffs: readonly unknown[] }).diffs.length,
    );
    expect(sizes).toEqual([MAX_DIFFS_PER_FRAME, 65_536 - MAX_DIFFS_PER_FRAME]);
    const corner = frames.framesFor(maskOf({ x: 7, y: 7, w: 1, h: 1 }, grid));
    expect(corner.map((f) => decodeServerMessage(f))).toEqual([
      { type: 'diffs', seq: 9, diffs: [{ index: at(2047, 2047), cell: 2, shield: 1 }] },
    ]);
    // Sockets that see the same tiles share frames; a socket that sees none gets nothing.
    expect(frames.framesFor(maskOf({ x: 7, y: 7, w: 1, h: 1 }, grid))).toBe(corner);
    expect(frames.framesFor(maskOf({ x: 3, y: 3, w: 1, h: 1 }, grid))).toEqual([]);
    expect(frames.framesFor(null)).toHaveLength(2);
    expect(frames.builds).toBe(3);
    expect(toRecords(diffs).byteLength).toBe(diffs.length * RECORD_BYTES);
  });

  it('builds frames per socket once shared frames would pass their memory limit', () => {
    const diffs = [];
    for (let i = 0; i < 300; i++) diffs.push({ index: at(i, 0), cell: 1, shield: 0 });
    for (let i = 0; i < 300; i++) diffs.push({ index: at(i, 300), cell: 2, shield: 0 });
    // Room for one tile's frames only.
    const frames = new TickFrames(5, toRecords(diffs), grid, 8 + 256 * RECORD_BYTES);
    const tile0 = maskOf({ x: 0, y: 0, w: 1, h: 1 }, grid);
    const both = maskOf({ x: 0, y: 0, w: 2, h: 2 }, grid);
    const first = frames.framesFor(tile0);
    expect(frames.framesFor(tile0)).toBe(first);
    // Past the limit: right frames, built again for each socket rather than kept.
    const a = frames.framesFor(both);
    const b = frames.framesFor(both);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    const decoded = a.map(
      (f) => decodeServerMessage(f) as Extract<ServerMessage, { type: 'diffs' }>,
    );
    expect(
      decoded
        .flatMap((m) => m.diffs)
        .map((d) => d.index)
        .sort((x, y) => x - y),
    ).toEqual(diffs.map((d) => d.index).sort((x, y) => x - y));
    expect(frames.builds).toBe(3);
  });

  it('cuts a tile frame out of the whole grid', () => {
    const cells = new Uint8Array(SIZE * SIZE);
    const shields = new Uint8Array(SIZE * SIZE);
    cells[at(256 * 3 + 5, 256 * 2 + 7)] = 9;
    shields[at(256 * 3 + 5, 256 * 2 + 7)] = 2;
    const message = decodeServerMessage(tileFrame({ seq: 4, cells, shields }, grid, 2 * 8 + 3));
    expect(message).toMatchObject({ type: 'tile', seq: 4, tx: 3, ty: 2, edge: 256 });
    const tile = message as Extract<ServerMessage, { type: 'tile' }>;
    expect(tile.cells[7 * 256 + 5]).toBe(9);
    expect(tile.shields[7 * 256 + 5]).toBe(2);
    expect(tile.cells.reduce((n, c) => n + (c ? 1 : 0), 0)).toBe(1);
  });
});
