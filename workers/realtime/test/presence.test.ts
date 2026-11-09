import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DEFAULT_ITEM_CONFIG, DEFAULT_OPEN_GROWTH } from '@brickplace/core';
import { foldNow } from '@brickplace/game/journal';
import { decodeServerMessage, type StatsMessage } from '@brickplace/protocol';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/index.ts';
import { CANVAS_HEADER, PLAYER_HEADER, TEAM_HEADER, WATCH_HEADER } from '../src/player.ts';
import { WAIT_MS } from './wait.ts';

// Who is playing (ADR 0030): each shard's watchdog call reports its playing sockets per team,
// the canvas sums the shards, and every socket gets a Stats frame with the totals and its own
// team's count. The watchdog runs by hand here (its alarm is off in tests).

const { FANOUT, CANVAS } = env as unknown as Env;

async function connect(canvas: string, fanout: string, player: string | null, team?: number) {
  const headers: Record<string, string> = { Upgrade: 'websocket', [CANVAS_HEADER]: canvas };
  if (player === null) headers[WATCH_HEADER] = '1';
  else headers[PLAYER_HEADER] = player;
  if (team !== undefined) headers[TEAM_HEADER] = String(team);
  const stub = FANOUT.get(FANOUT.idFromName(fanout));
  const response = await stub.fetch('https://fanout/ws', { headers });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.binaryType = 'arraybuffer';
  const stats: StatsMessage[] = [];
  ws.addEventListener('message', (event) => {
    const message = decodeServerMessage(new Uint8Array(event.data as ArrayBuffer));
    if (message.type === 'stats') stats.push(message);
  });
  ws.accept();
  /** The next Stats frame (polled up to WAIT_MS). */
  const nextStats = async () => {
    for (let waited = 0; stats.length === 0; waited += 5) {
      if (waited > WAIT_MS) throw new Error(`no stats within ${WAIT_MS} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return stats.shift()!;
  };
  return { ws, stub, stats, nextStats };
}

describe('presence through the watchdog (ADR 0030)', () => {
  it('sends every socket the canvas-wide count and its own team count', async () => {
    const canvas = 'presence';
    const a1 = await connect(canvas, 'presence:fanout-0', 'pa1', 5);
    const a2 = await connect(canvas, 'presence:fanout-0', 'pa2');
    const watcher = await connect(canvas, 'presence:fanout-0', null);
    // Nothing is known before the first watchdog call: no Stats frame on join, so the first
    // frame is the watchdog's, and it is the only one.
    await a1.stub.watch();
    expect(await a1.nextStats()).toEqual({ type: 'stats', playing: 2, team: 1 });
    expect(a1.stats).toEqual([]);
    expect(await a2.nextStats()).toEqual({ type: 'stats', playing: 2, team: null });
    // A watching socket does not count, and gets no team.
    expect(await watcher.nextStats()).toEqual({ type: 'stats', playing: 2, team: null });

    // Another shard of the same canvas, a teammate on it.
    const b1 = await connect(canvas, 'presence:fanout-1', 'pb1', 5);
    await b1.stub.watch();
    expect(await b1.nextStats()).toEqual({ type: 'stats', playing: 3, team: 2 });
    await a1.stub.watch();
    expect(await a1.nextStats()).toEqual({ type: 'stats', playing: 3, team: 2 });

    // A socket joining gets the last totals at once, counting itself.
    const a3 = await connect(canvas, 'presence:fanout-0', 'pa3', 9);
    expect(await a3.nextStats()).toEqual({ type: 'stats', playing: 3, team: 1 });

    // GET /api/stats asks the canvas through any shard.
    expect(await a1.stub.stats(canvas)).toEqual({
      playing: 3,
      phase: 'settling',
      filled: 0,
      built: 0,
      growsAt: DEFAULT_OPEN_GROWTH.atPercent,
      rates: DEFAULT_ITEM_CONFIG.rates,
    });
    expect(await a1.stub.stats('../not a canvas')).toBeNull();
    for (const page of [a1, a2, a3, b1, watcher]) page.ws.close();
  });

  it('still repairs when the totals are malformed: the counts are only advisory', async () => {
    const canvas = 'presence-bad';
    const shard = `${canvas}:fanout-0`;
    const page = await connect(canvas, shard, 'pbad1', 3);
    const real = CANVAS.get(CANVAS.idFromName(canvas));
    // The canvas lost the shard, and its cursor() answers garbage totals.
    await runInDurableObject(real, (instance: unknown) => {
      (instance as { pusher: { forget(name: string): void } }).pusher.forget(shard);
    });
    await runInDurableObject(page.stub, (instance: unknown) => {
      const target = instance as { env: Env };
      const namespace = target.env.CANVAS;
      const wrapped = {
        idFromName: (n: string) => namespace.idFromName(n),
        get: (id: DurableObjectId) =>
          new Proxy(namespace.get(id), {
            get(stub, property) {
              if (property !== 'cursor') return Reflect.get(stub, property);
              return async (name: string) => ({
                ...(await stub.cursor(name)),
                presence: { playing: 2 ** 40, teams: ['x', [1], [3, -1]] },
              });
            },
          }),
      };
      target.env = { ...target.env, CANVAS: wrapped as unknown as Env['CANVAS'] };
    });
    await page.stub.watch();
    // The watchdog went on to follow again, and no Stats frame went out.
    expect((await real.cursor(shard)).following).toBe(true);
    expect(page.stats).toEqual([]);
    page.ws.close();
  });
});

describe('season numbers through a shard (ADR 0031)', () => {
  it("passes one player's numbers on from the canvas, and nothing for a bad canvas name", async () => {
    const canvas = 'numbers-relay';
    await runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance, state) => {
      foldNow(instance, state.storage);
      state.storage.sql.exec(
        'INSERT INTO player_season (player, bricks, hammers, shields, days, last_day) ' +
          "VALUES ('pn1', 4, 2, 1, 3, 0)",
      );
    });
    const shard = FANOUT.get(FANOUT.idFromName(`${canvas}:fanout-0`));
    expect(await shard.playerSeason(canvas, 'pn1')).toEqual({
      bricks: 4,
      hammers: 2,
      shields: 1,
      days: 3,
    });
    expect(await shard.playerSeason(canvas, 'nobody')).toEqual({
      bricks: 0,
      hammers: 0,
      shields: 0,
      days: 0,
    });
    expect(await shard.playerSeason('../not a canvas', 'pn1')).toBeNull();
  });
});
