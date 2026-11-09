import { cellsOf, encodeCell, type Item, type Rect } from '@brickplace/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomArt } from '../src/art.ts';
import { Bot, type BotEvents, devId, type Identity, Stats } from '../src/bot.ts';
import { Eye } from '../src/eye.ts';
import { Mirror } from '../src/mirror.ts';
import { Player, type PlayerKind, type World } from '../src/player.ts';
import { Rng } from '../src/rng.ts';
import { backoffMs } from '../src/socket.ts';
import { FakeServer, type FakeSocket } from './fake.ts';

const SIZE = 64;
const OPEN: Rect = { x: 8, y: 8, w: 48, h: 48 };
const URL_ = 'wss://game.test/ws';
const KEY = 'k'.repeat(40);

function readyMirror(): Mirror {
  const mirror = new Mirror(SIZE, OPEN, 3);
  mirror.ready = true;
  return mirror;
}

function setup(
  kind: PlayerKind = 'casual',
  identity: Identity = { key: KEY },
  mirror = readyMirror(),
  canvas: string | null = null,
  firstSeq: (() => Promise<number | null>) | null = null,
) {
  const rng = new Rng(11);
  const server = new FakeServer();
  const arts = [randomArt(rng, { x: 20, y: 20, w: 16, h: 16 })];
  const world = (): World => ({ mirror, arts, rng, now: Date.now() });
  const stats = new Stats();
  const gone: string[] = [];
  const events: BotEvents = { gone: (_, why) => gone.push(why) };
  const bot = new Bot(
    7,
    new Player(kind, 0, world()),
    URL_,
    identity,
    world,
    stats,
    server.connect,
    () => rng.next(),
    events,
    canvas,
    firstSeq,
  );
  return { bot, server, stats, gone, mirror };
}

/** Opens the bot's socket the way FanoutDO answers a join: config, then the hold. */
function join(socket: FakeSocket, items: Item[]) {
  socket.open();
  socket.push({ type: 'config', mapSize: SIZE, open: OPEN, maxShield: 3, locks: [], views: true });
  socket.push(hold(items, 1));
}

function hold(items: Item[], revision: number) {
  return { type: 'hold', capacity: 3, cooldown: 60_000, nextIn: 30_000, revision, items } as const;
}

/** Ops and discards the bot sent on this socket. */
function moves(socket: FakeSocket): { opId: number }[] {
  return socket.sent.filter((m) => 'opId' in m) as { opId: number }[];
}

/** Drives the clock a second at a time until the bot has sent `count` moves (two minutes at most). */
async function untilMoves(socket: FakeSocket, count: number): Promise<number> {
  for (let s = 0; s < 120 && moves(socket).length < count; s++)
    await vi.advanceTimersByTimeAsync(1000);
  expect(moves(socket)).toHaveLength(count);
  return moves(socket)[count - 1]!.opId;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a bot', () => {
  it('joins with the bot key in a header, never in the URL', () => {
    const { bot, server } = setup();
    bot.start();
    const { url, headers } = server.last;
    expect(url.searchParams.get('bot')).toBe('7');
    expect(url.searchParams.get('client')).toMatch(/^[A-Za-z0-9-]{22}$/);
    expect(url.toString()).not.toContain(KEY);
    expect(headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it('plays under a dev id without a key', () => {
    const { bot, server } = setup('casual', { dev: true });
    bot.start();
    expect(server.last.url.searchParams.get('player')).toBe(devId(7));
    expect(devId(7)).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(server.last.headers).toEqual({});
  });

  it('reports its view, waits a human while, then plays an item inside it', async () => {
    const { bot, server, stats } = setup();
    bot.start();
    const socket = server.last;
    join(socket, [{ kind: 'brick', shape: 1 }]);
    // Not at once: a person takes a few seconds at least.
    await vi.advanceTimersByTimeAsync(2900);
    expect(moves(socket)).toEqual([]);
    await untilMoves(socket, 1);
    const [view, op] = socket.sent;
    expect(view).toMatchObject({ subscribe: true });
    expect(op).toMatchObject({ op: { kind: 'brick', shape: 1 } });
    const area = (view as { view: Rect }).view;
    const { x, y } = (op as { op: { x: number; y: number } }).op;
    expect(x >= area.x && y >= area.y && x < area.x + area.w && y < area.y + area.h).toBe(true);
    // One op at a time: nothing more until the ack.
    socket.push(hold([{ kind: 'hammer' }], 2));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.sent).toHaveLength(2);
    socket.push({ type: 'ack', opId: (op as { opId: number }).opId, ok: true });
    expect(stats.accepted).toEqual({ brick: 1 });
    bot.stop();
  });

  it('sends an unconfirmed op again with the same opId, once', async () => {
    const { bot, server, stats } = setup();
    bot.start();
    const socket = server.last;
    join(socket, [{ kind: 'brick', shape: 0 }]);
    const opId = await untilMoves(socket, 1);
    socket.push({ type: 'ack', opId, ok: false, reason: 'unavailable' });
    // After a short pause, not at once.
    expect(moves(socket)).toHaveLength(1);
    await untilMoves(socket, 2);
    expect(moves(socket).map((m) => m.opId)).toEqual([opId, opId]);
    socket.push({ type: 'ack', opId, ok: false, reason: 'unavailable' });
    expect(stats.refused).toEqual({ 'brick:unavailable': 1 });
    // No ack at all: sent again after the timeout, then given up.
    socket.push(hold([{ kind: 'brick', shape: 3 }], 2));
    const next = await untilMoves(socket, 3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(moves(socket).map((m) => m.opId)).toEqual([opId, opId, next, next]);
    expect(stats.timeouts).toBe(1);
    bot.stop();
  });

  it('throws the oldest item away when the hold is full and nothing is useful', async () => {
    // A map with no room: every open cell filled.
    const mirror = readyMirror();
    for (let y = OPEN.y; y < OPEN.y + OPEN.h; y++) {
      for (let x = OPEN.x; x < OPEN.x + OPEN.w; x++)
        mirror.cells[y * SIZE + x] = encodeCell(3, false, false);
    }
    mirror.shields.fill(3);
    const { bot, server, stats } = setup('casual', { key: KEY }, mirror);
    bot.start();
    const socket = server.last;
    join(socket, [{ kind: 'brick', shape: 2 }, { kind: 'single' }, { kind: 'shield' }]);
    await untilMoves(socket, 1);
    expect(moves(socket)[0]).toMatchObject({ discard: { kind: 'brick', shape: 2 } });
    expect(stats.discarded).toBe(1);
    bot.stop();
  });

  it('keeps an item it has no use for while the hold has room', async () => {
    const mirror = readyMirror();
    for (let y = OPEN.y; y < OPEN.y + OPEN.h; y++) {
      for (let x = OPEN.x; x < OPEN.x + OPEN.w; x++)
        mirror.cells[y * SIZE + x] = encodeCell(3, false, false);
    }
    const { bot, server } = setup('casual', { key: KEY }, mirror);
    bot.start();
    join(server.last, [{ kind: 'brick', shape: 2 }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(moves(server.last)).toEqual([]);
    bot.stop();
  });

  it('reconnects at once when its hour is up, with the same connection id', async () => {
    const { bot, server } = setup();
    bot.start();
    const first = server.last;
    join(first, []);
    first.drop(4401, 'session expired');
    await vi.advanceTimersByTimeAsync(0);
    expect(server.sockets).toHaveLength(2);
    expect(server.last.url.searchParams.get('client')).toBe(first.url.searchParams.get('client'));
  });

  it('backs off after a dropped or refused connection, the first retry within 1 to 5 s', async () => {
    const { bot, server } = setup();
    bot.start();
    server.last.drop(1006);
    await vi.advanceTimersByTimeAsync(900);
    expect(server.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4200);
    expect(server.sockets).toHaveLength(2);
    bot.stop();
  });

  it('waits at least 4 s after a 1013, the 8 s step times 0.5 to 1.5, as the browser client', async () => {
    const { bot, server } = setup();
    bot.start();
    server.last.drop(1013);
    await vi.advanceTimersByTimeAsync(3900);
    expect(server.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8200);
    expect(server.sockets).toHaveLength(2);
    bot.stop();
  });

  it('spreads its first retry over 1 to 5 s and later ones by 0.5 to 1.5 times, as the browser client (ADR 0040)', () => {
    expect(backoffMs(0, () => 0)).toBe(1000);
    expect(backoffMs(0, () => 0.999_999)).toBe(5000);
    expect(backoffMs(1, () => 0)).toBe(1000);
    expect(backoffMs(1, () => 0.999_999)).toBe(3000);
    expect(backoffMs(9, () => 0)).toBe(7500);
  });

  it('resumes a later socket from the seq its last one reached, and counts each join', async () => {
    const { bot, server, stats } = setup('casual', { key: KEY }, readyMirror(), 'season-2');
    bot.start();
    const first = server.last;
    // The first socket holds no map: no since.
    expect(first.url.searchParams.has('since')).toBe(false);
    // join() opens the socket; the map frames come before its config frame anyway.
    first.push({ type: 'diffs', seq: 40, diffs: [{ index: 1, cell: 0x80, shield: 0 }] });
    first.push({ type: 'diffs', seq: 40, diffs: [] });
    join(first, []);
    // Live frames after the map move the seq on, Tile frames as well as Diffs.
    first.push({ type: 'diffs', seq: 43, diffs: [{ index: 2, cell: 0x80, shield: 0 }] });
    first.push({
      type: 'tile',
      seq: 45,
      tx: 0,
      ty: 0,
      edge: SIZE,
      cells: new Uint8Array(SIZE * SIZE),
      shields: new Uint8Array(SIZE * SIZE),
    });
    first.drop(1001, 'going away');
    await vi.advanceTimersByTimeAsync(5000);
    const second = server.last;
    expect(second).not.toBe(first);
    expect(second.url.searchParams.get('since')).toBe('45');
    expect(second.url.searchParams.get('canvas')).toBe('season-2');
    // Refused mid-way, before its map was in: the next try still asks from 45.
    second.open();
    second.push({ type: 'resume', from: 44 });
    second.drop(1006);
    await vi.advanceTimersByTimeAsync(10_000);
    const third = server.last;
    expect(third).not.toBe(second);
    expect(third.url.searchParams.get('since')).toBe('45');
    third.push({ type: 'resume', from: 44 });
    third.push({ type: 'diffs', seq: 50, diffs: [{ index: 3, cell: 0x80, shield: 0 }] });
    join(third, []);
    expect(stats.joins.map(({ kind, resumed }) => ({ kind, resumed }))).toEqual([
      { kind: 'first', resumed: false },
      { kind: 'again', resumed: true },
    ]);
    const again = stats.joins[1]!;
    // Timed from the drop, through the refused try; only the last socket's frames count.
    expect(again.ms).toBeGreaterThanOrEqual(5000);
    expect(again.bytes).toBe(2 + 4 + (2 + 4 + 2 + 6));
    third.drop(1001);
    // The third try in a row: 4 to 5.2 s.
    await vi.advanceTimersByTimeAsync(6000);
    expect(server.last).not.toBe(third);
    expect(server.last.url.searchParams.get('since')).toBe('50');
    bot.stop();
  });

  it('resumes its first socket from the map it loaded from the CDN, timed from the start', async () => {
    let loaded: (seq: number | null) => void = () => {};
    const { bot, server, stats } = setup(
      'casual',
      { key: KEY },
      readyMirror(),
      'season-2',
      () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    );
    bot.start();
    // Nothing opens while the map loads.
    expect(server.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1200);
    loaded(77);
    await vi.advanceTimersByTimeAsync(0);
    const first = server.last;
    expect(first.url.searchParams.get('since')).toBe('77');
    expect(first.url.searchParams.get('canvas')).toBe('season-2');
    first.push({ type: 'resume', from: 77 });
    join(first, []);
    expect(stats.joins).toHaveLength(1);
    expect(stats.joins[0]).toMatchObject({ kind: 'first', resumed: true });
    expect(stats.joins[0]!.ms).toBeGreaterThanOrEqual(1200);
    bot.stop();
  });

  it('asks the socket for the whole map when the CDN could not give it, and opens nothing once stopped', async () => {
    const { bot, server } = setup(
      'casual',
      { key: KEY },
      readyMirror(),
      'season-2',
      async () => null,
    );
    bot.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.last.url.searchParams.has('since')).toBe(false);
    bot.stop();
    // Stopped while its map loads: no socket after.
    let loaded: (seq: number | null) => void = () => {};
    const late = setup(
      'casual',
      { key: KEY },
      readyMirror(),
      'season-2',
      () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    );
    late.bot.start();
    late.bot.stop();
    loaded(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.server.sockets).toHaveLength(0);
    // Stopped and started again while the first load waits: one socket, the second start's.
    const loads: ((seq: number | null) => void)[] = [];
    const again = setup(
      'casual',
      { key: KEY },
      readyMirror(),
      'season-2',
      () =>
        new Promise((resolve) => {
          loads.push(resolve);
        }),
    );
    again.bot.start();
    again.bot.stop();
    again.bot.start();
    loads[0]!(5);
    loads[1]!(6);
    await vi.advanceTimersByTimeAsync(0);
    expect(again.server.sockets).toHaveLength(1);
    expect(again.server.last.url.searchParams.get('since')).toBe('6');
    again.bot.stop();
  });

  it('asks for the whole map every time without a canvas', async () => {
    const { bot, server } = setup();
    bot.start();
    const first = server.last;
    first.push({ type: 'diffs', seq: 40, diffs: [] });
    join(first, []);
    first.drop(1001);
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.sockets).toHaveLength(2);
    expect(server.last.url.searchParams.has('since')).toBe(false);
    expect(server.last.url.searchParams.has('canvas')).toBe(false);
    bot.stop();
  });

  it('keeps backing off while the server accepts and closes at once', async () => {
    const { bot, server } = setup();
    bot.start();
    const gaps: number[] = [];
    for (let round = 0; round < 4; round++) {
      server.last.open();
      server.last.drop(1012, 'grid out of date; reconnect');
      const before = server.sockets.length;
      let waited = 0;
      while (server.sockets.length === before) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      gaps.push(waited);
    }
    // 1 to 5 s, then the 2, 4 and 8 s steps times 0.5 to 1.5: each wait within its step's
    // range (100 ms of slack for the polling). The ranges overlap, so waits need not grow.
    const ranges = [
      [1000, 5000],
      [1000, 3000],
      [2000, 6000],
      [4000, 12_000],
    ];
    for (const [i, [low, high]] of ranges.entries()) {
      expect(gaps[i]!).toBeGreaterThanOrEqual(low!);
      expect(gaps[i]!).toBeLessThanOrEqual(high! + 100);
    }
    // A socket that stays up starts the backoff over.
    server.last.open();
    await vi.advanceTimersByTimeAsync(6000);
    server.last.drop(1012);
    const before = server.sockets.length;
    await vi.advanceTimersByTimeAsync(5100);
    expect(server.sockets.length).toBe(before + 1);
    bot.stop();
  });

  it('never acts outside the view it last reported, even when a move sends it elsewhere', async () => {
    for (const kind of ['casual', 'griefer', 'builder', 'repairer'] as const) {
      // A crowded map: casual players move home often, griefers switch artworks.
      const mirror = readyMirror();
      const rng = new Rng(17);
      for (let i = 0; i < SIZE * SIZE; i++) {
        if (rng.chance(0.55)) mirror.cells[i] = encodeCell(rng.int(32), false, false);
      }
      const { bot, server } = setup(kind, { key: KEY }, mirror);
      bot.start();
      const socket = server.last;
      join(socket, [{ kind: 'single' }, { kind: 'hammer' }, { kind: 'brick', shape: 0 }]);
      let revision = 1;
      for (let turn = 0; turn < 40; turn++) {
        const count = moves(socket).length;
        for (let s = 0; s < 120 && moves(socket).length === count; s++) {
          await vi.advanceTimersByTimeAsync(1000);
        }
        const move = moves(socket).at(-1);
        if (!move || moves(socket).length === count) break;
        socket.push({ type: 'ack', opId: move.opId, ok: true });
        const items: Item[] = [{ kind: 'single' }, { kind: 'hammer' }, { kind: 'brick', shape: 2 }];
        socket.push(hold(items.slice(0, 1 + (turn % 3)), ++revision));
      }
      let view: Rect | null = null;
      let checked = 0;
      for (const message of socket.sent) {
        if ('view' in message) view = message.view;
        if (!('op' in message)) continue;
        expect(view, kind).not.toBeNull();
        const { op } = message;
        const cells = op.kind === 'brick' ? cellsOf(op.shape, op.rotation) : [[0, 0] as const];
        for (const [dx, dy] of cells) {
          const [x, y] = [op.x + dx, op.y + dy];
          expect(
            x >= view!.x && y >= view!.y && x < view!.x + view!.w && y < view!.y + view!.h,
            kind,
          ).toBe(true);
        }
        checked++;
      }
      expect(checked, kind).toBeGreaterThan(5);
      bot.stop();
    }
  });

  it('gives up its number when challenged, or when another socket plays as it', async () => {
    for (const [code, why] of [
      [4428, 'challenged'],
      [4409, 'elsewhere'],
    ] as const) {
      const { bot, server, gone } = setup();
      bot.start();
      join(server.last, []);
      server.last.drop(code);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gone).toEqual([why]);
      expect(server.sockets).toHaveLength(1);
    }
  });

  it('comes back at once when its hour is up, as FanoutDO says it: signed_out, then 4401', async () => {
    const { bot, server, gone } = setup();
    bot.start();
    const first = server.last;
    join(first, [{ kind: 'brick', shape: 1 }]);
    const opId = await untilMoves(first, 1);
    first.push({ type: 'ack', opId, ok: false, reason: 'signed_out' });
    first.drop(4401, 'session expired');
    await vi.advanceTimersByTimeAsync(0);
    expect(gone).toEqual([]);
    expect(server.sockets).toHaveLength(2);
    // The new socket plays the item that was refused.
    join(server.last, [{ kind: 'brick', shape: 1 }]);
    await untilMoves(server.last, 1);
    bot.stop();
  });

  it('stops when the server only lets it watch (no hold after the config, three sockets running)', async () => {
    const { bot, server, gone } = setup();
    bot.start();
    const config = {
      type: 'config',
      mapSize: SIZE,
      open: OPEN,
      maxShield: 3,
      views: true,
    } as const;
    for (let socket = 1; socket <= 3; socket++) {
      expect(server.sockets).toHaveLength(socket);
      server.last.open();
      server.last.push(config);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(gone).toEqual([]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(server.sockets[socket - 1]!.closed).not.toBeNull();
      // The next socket comes after the backoff.
      await vi.advanceTimersByTimeAsync(socket < 3 ? 6000 : 0);
    }
    expect(gone).toEqual(['watching']);
    expect(server.sockets).toHaveLength(3);
    expect(server.sockets.flatMap(moves)).toEqual([]);
  });

  it('takes a late first hold as playing (the canvas was replaying its log)', async () => {
    const { bot, server, gone } = setup();
    bot.start();
    server.last.open();
    server.last.push({ type: 'config', mapSize: SIZE, open: OPEN, maxShield: 3, views: true });
    // 60 s for the hold, then the first retry's 1 to 5 s.
    await vi.advanceTimersByTimeAsync(66_000);
    // A second socket; its hold comes.
    expect(server.sockets).toHaveLength(2);
    join(server.last, [{ kind: 'brick', shape: 4 }]);
    await untilMoves(server.last, 1);
    expect(gone).toEqual([]);
    bot.stop();
  });

  it('closes an expired socket itself if FanoutDO does not', async () => {
    const { bot, server } = setup();
    bot.start();
    const first = server.last;
    join(first, [{ kind: 'brick', shape: 1 }]);
    const opId = await untilMoves(first, 1);
    first.push({ type: 'ack', opId, ok: false, reason: 'signed_out' });
    await vi.advanceTimersByTimeAsync(5100);
    expect(first.closed).not.toBeNull();
    expect(server.sockets).toHaveLength(2);
    bot.stop();
  });

  it('starts a new connection id and opIds each run, whatever the seed', () => {
    const a = setup();
    const b = setup();
    a.bot.start();
    b.bot.start();
    expect(a.server.last.url.searchParams.get('client')).not.toBe(
      b.server.last.url.searchParams.get('client'),
    );
  });
});

describe('the eye', () => {
  it('builds the map from the initial grid, then follows live diffs', () => {
    const mirror = new Mirror(SIZE, OPEN, 3);
    const server = new FakeServer();
    const eye = new Eye(URL_, mirror, server.connect, () => 0.5);
    eye.start();
    const socket = server.last;
    expect(socket.url.searchParams.has('bot')).toBe(false);
    expect(socket.headers).toEqual({});
    socket.open();
    socket.push({ type: 'diffs', seq: 5, diffs: [{ index: 100, cell: 0x80, shield: 1 }] });
    expect(mirror.ready).toBe(false);
    socket.push({ type: 'config', mapSize: SIZE, open: OPEN, maxShield: 3 });
    expect(mirror.ready).toBe(true);
    expect(mirror.cells[100]).toBe(0x80);
    expect(mirror.shields[100]).toBe(1);
    socket.push({ type: 'diffs', seq: 6, diffs: [{ index: 101, cell: 0x84, shield: 0 }] });
    expect(mirror.cells[101]).toBe(0x84);
    eye.stop();
  });

  it('starts again from a fresh grid after a reconnect', async () => {
    const mirror = new Mirror(SIZE, OPEN, 3);
    const server = new FakeServer();
    const eye = new Eye(URL_, mirror, server.connect, () => 0);
    eye.start();
    server.last.open();
    server.last.push({ type: 'diffs', seq: 1, diffs: [{ index: 9, cell: 0x80, shield: 0 }] });
    server.last.push({ type: 'config', mapSize: SIZE, open: OPEN, maxShield: 3 });
    server.last.drop(1012);
    await vi.advanceTimersByTimeAsync(1000);
    const again = server.last;
    again.open();
    // The cell was cleared while the eye was away: the new grid no longer lists it.
    again.push({ type: 'diffs', seq: 4, diffs: [{ index: 10, cell: 0x80, shield: 0 }] });
    again.push({ type: 'config', mapSize: SIZE, open: OPEN, maxShield: 3 });
    expect(mirror.cells[9]).toBe(0);
    expect(mirror.cells[10]).toBe(0x80);
    eye.stop();
  });

  it('waits from the 8 s step after a 1013, as the bots and the browser client', async () => {
    const mirror = new Mirror(SIZE, OPEN, 3);
    const server = new FakeServer();
    // The smallest jitter: the 8 s step times 0.5.
    const eye = new Eye(URL_, mirror, server.connect, () => 0);
    eye.start();
    server.last.open();
    server.last.drop(1013);
    await vi.advanceTimersByTimeAsync(3900);
    expect(server.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(server.sockets).toHaveLength(2);
    eye.stop();
  });
});
