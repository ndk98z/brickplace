import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { decodeServerMessage, encodeClientOp, type ServerMessage } from '@brickplace/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import {
  CANVAS_HEADER,
  CAP_HEADER,
  capShareOf,
  GAVE_UP_PLACE,
  MAP_FULL,
  PLAYER_HEADER,
  PLAYING_ELSEWHERE,
  PLAYING_TAG,
  WATCH_HEADER,
} from '../src/player.ts';
import { IDLE_YIELD_MS, Seats } from '../src/seats.ts';
import { WAIT_MS } from './wait.ts';

// The players-at-once cap (ADR 0039): the gateway passes each playing socket its shard's
// share; past it a newcomer is turned away with MAP_FULL and no grid, unless a player has not
// moved for IDLE_YIELD_MS, who then gives up its place (GAVE_UP_PLACE).

const { FANOUT } = env as unknown as Env;
const CANVAS = 'capped';

async function connect(fanout: string, player: string | null, share?: number) {
  const headers: Record<string, string> = { Upgrade: 'websocket', [CANVAS_HEADER]: CANVAS };
  if (player === null) headers[WATCH_HEADER] = '1';
  else headers[PLAYER_HEADER] = player;
  if (share !== undefined) headers[CAP_HEADER] = String(share);
  const stub = FANOUT.get(FANOUT.idFromName(fanout));
  const response = await stub.fetch('https://fanout/ws', { headers });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.binaryType = 'arraybuffer';
  const frames: ServerMessage[] = [];
  ws.addEventListener('message', (event) => {
    frames.push(decodeServerMessage(new Uint8Array(event.data as ArrayBuffer)));
  });
  let code: number | null = null;
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (event) => {
      code = event.code;
      resolve(event.code);
    });
  });
  ws.accept();
  /** Waits (polling up to WAIT_MS) for a frame that `match` accepts. */
  const frame = async (match: (m: ServerMessage) => boolean) => {
    for (let waited = 0; ; waited += 5) {
      const found = frames.find(match);
      if (found) return found;
      if (waited > WAIT_MS) throw new Error(`no such frame within ${WAIT_MS} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  /** The initial grid has arrived: the socket plays (or watches). */
  const joined = () => frame((m) => m.type === 'diffs');
  /** Sends an op (refused for want of an item: a move all the same) and waits for its ack. */
  const move = async (opId: number) => {
    ws.send(
      encodeClientOp({ opId, op: { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 3 } }),
    );
    await frame((m) => m.type === 'ack' && m.opId === opId);
  };
  return { ws, stub, frames, closed, joined, move, code: () => code };
}

/**
 * Makes every player of this shard idle at once (as if IDLE_YIELD_MS were 0), the players
 * already here listed as they would be after a wake-up.
 */
async function idleAtOnce(fanout: string) {
  await runInDurableObject(FANOUT.get(FANOUT.idFromName(fanout)), (instance: unknown) => {
    const fanoutDO = instance as { seats: Seats; playingPlayers(): Iterable<string> };
    fanoutDO.seats = new Seats(0);
    fanoutDO.seats.seed(() => fanoutDO.playingPlayers(), Date.now());
  });
}

const playingCount = (fanout: string) =>
  runInDurableObject(FANOUT.get(FANOUT.idFromName(fanout)), (_, state) => ({
    playing: state.getWebSockets(PLAYING_TAG).length,
    all: state.getWebSockets().length,
  }));

describe('the cap header', () => {
  it('reads a whole number of sockets, at most what one object holds', () => {
    expect(capShareOf('0')).toBe(0);
    expect(capShareOf('5000')).toBe(5000);
    expect(capShareOf('2000000')).toBe(32_768);
    for (const bad of [null, '', '-1', '1.5', '1e3', ' 5', 'abc', '12345678']) {
      expect(capShareOf(bad), String(bad)).toBeNull();
    }
  });
});

describe('Seats', () => {
  const open = (players: string[]) => (p: string) => players.includes(p);

  it('names the player idle longest, only once idle long enough', () => {
    const seats = new Seats(1000);
    seats.moved('a', 0);
    seats.moved('b', 100);
    expect(seats.idlest(999, open(['a', 'b']))).toBeNull();
    expect(seats.idlest(1000, open(['a', 'b']))).toBe('a');
    // A move puts the player last.
    seats.moved('a', 1500);
    expect(seats.idlest(1500, open(['a', 'b']))).toBe('b');
    // Players without an open socket are skipped and dropped.
    expect(seats.idlest(3000, open(['a']))).toBe('a');
    expect(seats.size).toBe(1);
  });

  it('counts the sockets open at wake-up as having just moved, once', () => {
    const seats = new Seats(1000);
    seats.moved('late', 0);
    seats.seed(() => ['early', 'late'], 500);
    // `late` keeps its known move; `early` counts from the seed.
    expect(seats.idlest(1000, open(['early', 'late']))).toBe('late');
    seats.forget('late');
    expect(seats.idlest(1499, open(['early']))).toBeNull();
    expect(seats.idlest(1500, open(['early']))).toBe('early');
    seats.seed(() => ['again'], 2000);
    expect(seats.size).toBe(1);
  });

  it('sweeps players who left once the list doubles', () => {
    const seats = new Seats();
    for (let i = 0; i < 1025; i++) seats.moved(`p${i}`, i);
    seats.bound(open(['p1']), 1024);
    expect(seats.size).toBe(1);
    // The next sweep waits until the list holds more than the floor again.
    seats.moved('x', 0);
    seats.bound(open(['p1']), 1024);
    expect(seats.size).toBe(2);
  });

  it('waits ten minutes by default', () => {
    expect(IDLE_YIELD_MS).toBe(10 * 60 * 1000);
  });
});

describe('FanoutDO under a cap (ADR 0039)', () => {
  it('turns a newcomer away with MAP_FULL and no grid once the share is taken', async () => {
    const shard = `${CANVAS}:fanout-full`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = await connect(shard, 'cap-a', 2);
      await a.joined();
      const b = await connect(shard, 'cap-b', 2);
      await b.joined();
      const c = await connect(shard, 'cap-c', 2);
      expect(await c.closed).toBe(MAP_FULL);
      expect(c.frames).toEqual([]);
      const full = warn.mock.calls.map(([line]) => line).filter((l) => l?.event === 'fanout_full');
      expect(full).toEqual([
        { event: 'fanout_full', canvas: CANVAS, playing: 2, share: 2, suppressed: 0 },
      ]);
      // A watcher is not counted, nor turned away.
      const watcher = await connect(shard, null, 2);
      await watcher.joined();
      // A second page of a player already here takes over its own place.
      const a2 = await connect(shard, 'cap-a', 2);
      await a2.joined();
      expect(await a.closed).toBe(PLAYING_ELSEWHERE);
      expect(await playingCount(shard)).toEqual({ playing: 2, all: 3 });
      // A place that frees up is taken by the next one to ask.
      b.ws.close(1000, 'bye');
      await b.closed;
      for (let waited = 0; (await playingCount(shard)).playing > 1; waited += 10) {
        if (waited > WAIT_MS) throw new Error('the closed socket still counts');
        await new Promise((r) => setTimeout(r, 10));
      }
      const d = await connect(shard, 'cap-d', 2);
      await d.joined();
      a2.ws.close();
      d.ws.close();
      watcher.ws.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('gives the place of the player idle longest to a newcomer on a full shard', async () => {
    const shard = `${CANVAS}:fanout-idle`;
    const a = await connect(shard, 'idle-a', 2);
    await a.joined();
    const b = await connect(shard, 'idle-b', 2);
    await b.joined();
    // Both count as idle now; `a` moves, so `b` has gone longest without a move.
    await idleAtOnce(shard);
    await a.move(1);
    const c = await connect(shard, 'idle-c', 2);
    await c.joined();
    expect(await b.closed).toBe(GAVE_UP_PLACE);
    expect(a.code()).toBeNull();
    expect(await playingCount(shard)).toEqual({ playing: 2, all: 2 });
    a.ws.close();
    c.ws.close();
  });

  it('keeps everyone in place while nobody has been idle long enough', async () => {
    const shard = `${CANVAS}:fanout-busy`;
    const a = await connect(shard, 'busy-a', 1);
    await a.joined();
    const b = await connect(shard, 'busy-b', 1);
    expect(await b.closed).toBe(MAP_FULL);
    expect(a.code()).toBeNull();
    a.ws.close();
  });

  it('caps nothing without the header, and a share of 0 lets nobody new in', async () => {
    const open = `${CANVAS}:fanout-open`;
    const sockets = [];
    for (const player of ['open-a', 'open-b', 'open-c']) {
      const s = await connect(open, player);
      await s.joined();
      sockets.push(s);
    }
    expect((await playingCount(open)).playing).toBe(3);
    for (const s of sockets) s.ws.close();

    const shut = `${CANVAS}:fanout-shut`;
    const nobody = await connect(shut, 'shut-a', 0);
    expect(await nobody.closed).toBe(MAP_FULL);
  });

  it('lets a kicked player watch on a full shard: watchers are not counted', async () => {
    const shard = `${CANVAS}:fanout-kicked`;
    const a = await connect(shard, 'kick-a', 1);
    await a.joined();
    await a.stub.kick('kick-b');
    const b = await connect(shard, 'kick-b', 1);
    await b.joined();
    expect(b.code()).toBeNull();
    expect(await playingCount(shard)).toEqual({ playing: 1, all: 2 });
    a.ws.close();
    b.ws.close();
  });

  it('lets exactly the share in when several join at once', async () => {
    // A fresh shard: every join waits on its first policy read together, so all of them pass
    // the first check and only the one in the serial step can tell them apart.
    const shard = `${CANVAS}:fanout-rush`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rush = await Promise.all(
        ['rush-a', 'rush-b', 'rush-c', 'rush-d'].map((p) => connect(shard, p, 1)),
      );
      const outcome = await Promise.all(
        rush.map((s) => Promise.race([s.closed, s.joined().then(() => 'joined' as const)])),
      );
      expect(outcome.filter((o) => o === 'joined')).toHaveLength(1);
      expect(outcome.filter((o) => o === MAP_FULL)).toHaveLength(3);
      expect((await playingCount(shard)).playing).toBe(1);
      for (const s of rush) s.ws.close();
    } finally {
      warn.mockRestore();
    }
  });
});
