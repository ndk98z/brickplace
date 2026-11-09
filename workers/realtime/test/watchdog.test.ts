import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DEFAULT_MAP_SIZE } from '@brickplace/core';
import { foldNow } from '@brickplace/game/journal';
import { decodeServerMessage, type ServerMessage } from '@brickplace/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { CANVAS_HEADER, PLAYER_HEADER, WATCH_HEADER } from '../src/player.ts';
import { watchdogTiming } from '../src/watchdog.ts';
import { WAIT_MS } from './wait.ts';

// The shards' tick watchdog (ADR 0028): the alarm that runs it while sockets are open, and
// what one run does for fixed answers of the canvas's cursor(). Each test uses a canvas of its
// own; ticks leave a canvas only when a test pushes them (setup.ts). Ops land at cells 600-620,
// inside the default open area (256..767).

const { FANOUT, CANVAS } = env as unknown as Env;
const SIZE = DEFAULT_MAP_SIZE;
const COOLDOWN = 60_000;
const at = (x: number, y: number) => y * SIZE + x;

async function stock(canvas: string, player: string, items: unknown[], since = 2 ** 50) {
  await runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance, state) => {
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify(items),
      since,
    );
  });
}

/** An op straight on the canvas, as another shard's player makes it: no tick follows. */
async function opAround(canvas: string, x: number, y: number): Promise<void> {
  const player = `around-${x}-${y}`;
  await stock(canvas, player, [{ kind: 'brick', shape: 1 }]);
  const op = { kind: 'brick', x, y, shape: 1, rotation: 0, color: 3 } as const;
  const { results } = await CANVAS.get(CANVAS.idFromName(canvas)).applyBatch([
    { player, opId: 1, op },
  ]);
  expect(results[0]).toMatchObject({ ok: true });
}

type Frame = Exclude<ServerMessage, { type: 'config' }>;

async function connect(canvas: string, fanout: string, player: string | null = null) {
  const headers: Record<string, string> = { Upgrade: 'websocket', [CANVAS_HEADER]: canvas };
  if (player === null) headers[WATCH_HEADER] = '1';
  else headers[PLAYER_HEADER] = player;
  const stub = FANOUT.get(FANOUT.idFromName(fanout));
  const response = await stub.fetch('https://fanout/ws', { headers });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.binaryType = 'arraybuffer';
  const inbox: Frame[] = [];
  const state = { closed: null as number | null };
  ws.addEventListener('message', (event) => {
    const message = decodeServerMessage(new Uint8Array(event.data as ArrayBuffer));
    if (message.type !== 'config') inbox.push(message);
  });
  ws.addEventListener('close', (event) => {
    state.closed = event.code;
  });
  ws.accept();
  /** The next frame of this type, skipping others (polled: see `until` in fanout.test.ts). */
  const nextOf = async <T extends Frame['type']>(type: T, ms = WAIT_MS) => {
    for (let tries = 0; ; tries++) {
      const found = inbox.findIndex((m) => m.type === type);
      if (found >= 0) return inbox.splice(found, 1)[0] as Extract<Frame, { type: T }>;
      if (tries * 5 > ms) throw new Error(`no ${type} within ${ms} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  /** Waits a little and says whether no diffs arrived. */
  const quiet = async (ms = 100) => {
    await new Promise((r) => setTimeout(r, ms));
    return !inbox.some((m) => m.type === 'diffs');
  };
  const grid = await nextOf('diffs');
  return { ws, stub, state, grid, inbox, nextOf, quiet };
}

async function alarmOf(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub, (_, state) => state.storage.getAlarm());
}

async function socketsOf(stub: DurableObjectStub): Promise<number> {
  return runInDurableObject(stub, (_, state) => state.getWebSockets().length);
}

async function setFields(stub: DurableObjectStub, fields: Record<string, unknown>) {
  await runInDurableObject(stub, (instance: unknown) => {
    Object.assign(instance as object, fields);
  });
}

async function mirrorOf(stub: DurableObjectStub) {
  return runInDurableObject(stub, (instance: unknown) => {
    const m = (instance as { mirror: { seq: number; following: boolean } | null }).mirror;
    return m ? { seq: m.seq, following: m.following } : null;
  });
}

/** The canvas forgets the shard, as one that lost it would (no more pushes to it). */
async function forget(canvas: string, shard: string): Promise<void> {
  await runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance: unknown) => {
    (instance as { pusher: { forget(name: string): void } }).pusher.forget(shard);
  });
}

/**
 * Makes this shard talk to a game script from before ADR 0028 (no follow(), no cursor()), or
 * with `unregistrable` to a canvas without the FANOUT binding (follow() answers a snapshot
 * with `following: false`, cursor() says `registrable: false`). Until the shard is evicted.
 */
async function preTicks(stub: DurableObjectStub, unregistrable = false): Promise<void> {
  await runInDurableObject(stub, (instance: unknown) => {
    const target = instance as { env: Env };
    const real = target.env.CANVAS;
    const missing = (method: string) =>
      new TypeError(`The RPC receiver does not implement the method "${method}".`);
    const wrapped = {
      idFromName: (n: string) => real.idFromName(n),
      get: (id: DurableObjectId) => {
        const canvas = real.get(id);
        return new Proxy(canvas, {
          get(stub, property) {
            if (property === 'follow') {
              if (!unregistrable) return async () => Promise.reject(missing(property));
              return async () => ({
                ...(await canvas.snapshot()),
                following: false,
                changes: null,
              });
            }
            if (property === 'cursor') {
              if (!unregistrable) return async () => Promise.reject(missing(property));
              return async (shard: string) => ({
                ...(await canvas.cursor(shard)),
                following: false,
                acked: null,
                registrable: false,
              });
            }
            return Reflect.get(stub, property);
          },
        });
      },
    };
    target.env = { ...target.env, CANVAS: wrapped as unknown as Env['CANVAS'] };
  });
}

describe('tick watchdog (ADR 0028)', () => {
  const saved = { ...watchdogTiming };
  beforeEach(() => {
    watchdogTiming.ms = 30_000;
  });
  afterEach(() => {
    Object.assign(watchdogTiming, saved);
  });

  it('arms the alarm within watchdogTiming.ms of a join, again while sockets are open, not after', async () => {
    const watcher = await connect('w-arm', 'w-arm:fanout-0');
    const armed = await alarmOf(watcher.stub);
    expect(armed).not.toBeNull();
    expect(armed!).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(await runDurableObjectAlarm(watcher.stub)).toBe(true);
    const again = await alarmOf(watcher.stub);
    expect(again).not.toBeNull();
    expect(again!).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(again!).toBeGreaterThan(Date.now() + 20_000);
    watcher.ws.close();
    for (let tries = 0; (await socketsOf(watcher.stub)) > 0; tries++) {
      if (tries * 10 > WAIT_MS) throw new Error('socket still open');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await runDurableObjectAlarm(watcher.stub)).toBe(true);
    expect(await alarmOf(watcher.stub)).toBeNull();
  });

  it('follows again from the alarm when the canvas lost the shard, bringing what it missed', async () => {
    const canvas = CANVAS.get(CANVAS.idFromName('w-lost'));
    const watcher = await connect('w-lost', 'w-lost:fanout-0');
    await forget('w-lost', 'w-lost:fanout-0');
    await opAround('w-lost', 600, 600);
    await canvas.pushTicks();
    expect(await watcher.quiet()).toBe(true);
    expect((await canvas.cursor('w-lost:fanout-0')).following).toBe(false);
    expect(await runDurableObjectAlarm(watcher.stub)).toBe(true);
    const repaired = await watcher.nextOf('diffs');
    expect(repaired.seq).toBe(watcher.grid.seq + 1);
    expect(repaired.diffs.map((d) => d.index)).toContain(at(600, 600));
    expect((await canvas.cursor('w-lost:fanout-0')).following).toBe(true);
    // Followed again: the next op comes with a tick.
    await opAround('w-lost', 620, 600);
    await canvas.pushTicks();
    const tick = await watcher.nextOf('diffs');
    expect(tick.seq).toBe(watcher.grid.seq + 2);
    expect(tick.diffs.map((d) => d.index)).toContain(at(620, 600));
    watcher.ws.close();
  });

  it('still delivers due holds from the alarm that runs the watchdog', async () => {
    await CANVAS.get(CANVAS.idFromName('w-hold')).status();
    await stock('w-hold', 'ph', [], Date.now() - COOLDOWN + 300);
    const player = await connect('w-hold', 'w-hold:fanout-0', 'ph');
    const empty = await player.nextOf('hold');
    expect(empty.items).toEqual([]);
    await new Promise((r) => setTimeout(r, 350));
    await runDurableObjectAlarm(player.stub);
    const refilled = await player.nextOf('hold');
    expect(refilled.items).toHaveLength(1);
    // The next item is a minute away; the watchdog's alarm comes first.
    const next = await alarmOf(player.stub);
    expect(next).not.toBeNull();
    expect(next!).toBeLessThanOrEqual(Date.now() + 30_000);
    player.ws.close();
  });

  it('follows again when followed, the canvas ahead and no tick for the stall time', async () => {
    watchdogTiming.stallMs = 1_000;
    const watcher = await connect('w-stall', 'w-stall:fanout-0');
    await opAround('w-stall', 600, 600);
    // A tick came just now: the canvas may still be on its way.
    await setFields(watcher.stub, { lastTickAt: Date.now() });
    await watcher.stub.watch();
    expect(await watcher.quiet()).toBe(true);
    // None for longer than the stall time.
    await setFields(watcher.stub, { lastTickAt: Date.now() - 1_500 });
    await watcher.stub.watch();
    const repaired = await watcher.nextOf('diffs');
    expect(repaired.diffs.map((d) => d.index)).toContain(at(600, 600));
    expect(await mirrorOf(watcher.stub)).toEqual({ seq: repaired.seq, following: true });
    watcher.ws.close();
  });

  it('leaves a canvas backing off its retries until backoffGraceMs before following again', async () => {
    watchdogTiming.stallMs = 1_000;
    const watcher = await connect('w-backoff', 'w-backoff:fanout-0');
    await opAround('w-backoff', 600, 600);
    await runInDurableObject(CANVAS.get(CANVAS.idFromName('w-backoff')), (instance: unknown) => {
      const { pusher } = instance as {
        pusher: { shards: Map<string, { failures: number; retryAt: number }> };
      };
      const entry = pusher.shards.get('w-backoff:fanout-0')!;
      entry.failures = 3;
      entry.retryAt = Date.now() + 4_000;
    });
    // Past the stall time, within the canvas's backoff: its own retry will come.
    await setFields(watcher.stub, { lastTickAt: Date.now() - 5_000 });
    await watcher.stub.watch();
    expect(await watcher.quiet()).toBe(true);
    await setFields(watcher.stub, { lastTickAt: Date.now() - watchdogTiming.backoffGraceMs - 1 });
    await watcher.stub.watch();
    expect((await watcher.nextOf('diffs')).diffs.map((d) => d.index)).toContain(at(600, 600));
    watcher.ws.close();
  });

  it('does nothing against a game script without cursor(): sockets stay open over alarms', async () => {
    watchdogTiming.stallMs = 0;
    const watcher = await connect('w-pre', 'w-pre:fanout-0');
    await preTicks(watcher.stub);
    await opAround('w-pre', 600, 600);
    await watcher.stub.watch();
    // Pre-0028 rules from now on. The mirror counted on pushes until now: it catches up once
    // from a snapshot, closing nothing.
    const caught = await watcher.nextOf('diffs');
    expect(caught.diffs.map((d) => d.index)).toContain(at(600, 600));
    expect(await mirrorOf(watcher.stub)).toEqual({ seq: caught.seq, following: false });
    // Not again: no pushes to wait for, so nothing to follow.
    await opAround('w-pre', 620, 600);
    await watcher.stub.watch();
    expect(await watcher.quiet()).toBe(true);
    // A quiet shard, hibernated: the alarm loads nothing and closes nothing.
    await evictDurableObject(watcher.stub);
    await preTicks(watcher.stub);
    for (let i = 0; i < 3; i++) {
      expect(await runDurableObjectAlarm(watcher.stub)).toBe(true);
      expect(await mirrorOf(watcher.stub)).toBeNull();
      expect(await socketsOf(watcher.stub)).toBe(1);
    }
    expect(await watcher.quiet()).toBe(true);
    expect(watcher.state.closed).toBeNull();
    watcher.ws.close();
  });

  it('keeps sockets open against a canvas that cannot register shards, across evictions', async () => {
    watchdogTiming.stallMs = 0;
    const watcher = await connect('w-nobind', 'w-nobind:fanout-0');
    // A canvas without the FANOUT binding: it pushes nothing and follow() registers nobody.
    await forget('w-nobind', 'w-nobind:fanout-0');
    await preTicks(watcher.stub, true);
    await opAround('w-nobind', 600, 600);
    await watcher.stub.watch();
    const caught = await watcher.nextOf('diffs');
    expect(caught.diffs.map((d) => d.index)).toContain(at(600, 600));
    expect(await mirrorOf(watcher.stub)).toEqual({ seq: caught.seq, following: false });
    // No following again every alarm (each one would copy the grid for nothing).
    const follows = { n: 0 };
    await runInDurableObject(watcher.stub, (instance: unknown) => {
      const i = instance as { resync: (...args: unknown[]) => Promise<void> };
      const real = i.resync.bind(i);
      i.resync = async (...args: unknown[]) => {
        follows.n++;
        return real(...args);
      };
    });
    await watcher.stub.watch();
    await watcher.stub.watch();
    expect(follows.n).toBe(0);
    // Evicted, then woken by alarms: nothing is loaded or closed.
    for (let round = 0; round < 2; round++) {
      await evictDurableObject(watcher.stub);
      await preTicks(watcher.stub, true);
      for (let i = 0; i < 3; i++) {
        expect(await runDurableObjectAlarm(watcher.stub)).toBe(true);
        expect(await mirrorOf(watcher.stub)).toBeNull();
      }
      // Woken by a join: the follow() reply says `following: false` and no reply was lost, so
      // the open sockets stay (the marker rule), and the new one gets the grid.
      const joined = await connect('w-nobind', 'w-nobind:fanout-0');
      expect(joined.grid.diffs.map((d) => d.index)).toContain(at(600, 600));
      expect(await mirrorOf(watcher.stub)).toMatchObject({ following: false });
      joined.ws.close();
    }
    expect(await watcher.quiet()).toBe(true);
    expect(watcher.state.closed).toBeNull();
    watcher.ws.close();
  });

  it('closes the sockets with 1012 when a resync has more changed cells than it sends', async () => {
    const watcher = await connect('w-cap', 'w-cap:fanout-0');
    const other = await connect('w-cap', 'w-cap:fanout-0');
    await setFields(watcher.stub, { resyncCellCap: 2 });
    await forget('w-cap', 'w-cap:fanout-0');
    await opAround('w-cap', 600, 600);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await watcher.stub.watch();
      for (let tries = 0; watcher.state.closed === null || other.state.closed === null; tries++) {
        if (tries * 5 > WAIT_MS) throw new Error('sockets not closed');
        await new Promise((r) => setTimeout(r, 5));
      }
      expect([watcher.state.closed, other.state.closed]).toEqual([1012, 1012]);
      const events = warn.mock.calls.map(([line]) => line);
      expect(events).toContainEqual({
        event: 'fanout_refollow',
        canvas: 'w-cap',
        reason: 'not_followed',
        suppressed: 0,
      });
      expect(events).toContainEqual({
        event: 'fanout_stale_closed',
        canvas: 'w-cap',
        sockets: 2,
        reason: 'too_many_changes',
        suppressed: 0,
      });
    } finally {
      warn.mockRestore();
    }
    // The mirror still moved on: a page that reconnects gets the op in its grid.
    const again = await connect('w-cap', 'w-cap:fanout-0');
    expect(again.grid.diffs.map((d) => d.index)).toContain(at(600, 600));
    again.ws.close();
  });
});

describe('watchdog cadence from the alarm (ADR 0043)', () => {
  const saved = { ...watchdogTiming };
  beforeEach(() => {
    watchdogTiming.ms = 30_000;
  });
  afterEach(() => {
    Object.assign(watchdogTiming, saved);
  });

  /** Counts the shard's cursor() calls to its canvas from now on. */
  async function countCursor(stub: DurableObjectStub): Promise<() => Promise<number>> {
    await runInDurableObject(stub, (instance: unknown) => {
      const target = instance as { env: Env; cursorCalls: number };
      target.cursorCalls = 0;
      const real = target.env.CANVAS;
      const wrapped = {
        idFromName: (n: string) => real.idFromName(n),
        get: (id: DurableObjectId) =>
          new Proxy(real.get(id), {
            get(canvas, property) {
              if (property !== 'cursor') return Reflect.get(canvas, property);
              return (...args: Parameters<typeof canvas.cursor>) => {
                target.cursorCalls++;
                return canvas.cursor(...args);
              };
            },
          }),
      };
      target.env = { ...target.env, CANVAS: wrapped as unknown as Env['CANVAS'] };
    });
    return () =>
      runInDurableObject(
        stub,
        (instance: unknown) => (instance as { cursorCalls: number }).cursorCalls,
      );
  }

  it('runs the watchdog once per watchdogTiming.ms however often the hold alarm fires', async () => {
    const watcher = await connect('w-cadence', 'w-cadence:fanout-0');
    const cursorCalls = await countCursor(watcher.stub);
    // The first alarm after a start runs it (nothing is known yet).
    expect(await runDurableObjectAlarm(watcher.stub)).toBe(true);
    expect(await cursorCalls()).toBe(1);
    await watcher.nextOf('stats');
    // Alarms within the interval (a hold due, say) do not run it again, and send no Stats.
    expect(await runDurableObjectAlarm(watcher.stub)).toBe(true);
    expect(await runDurableObjectAlarm(watcher.stub)).toBe(true);
    expect(await cursorCalls()).toBe(1);
    expect(watcher.inbox.filter((m) => m.type === 'stats')).toEqual([]);
    // The alarm is still armed for the next watchdog run.
    const next = await alarmOf(watcher.stub);
    expect(next).not.toBeNull();
    expect(next!).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(next!).toBeGreaterThan(Date.now() + 20_000);
    // Once the interval has passed, the next alarm runs it.
    await setFields(watcher.stub, { watchedAt: Date.now() - 30_000 });
    expect(await runDurableObjectAlarm(watcher.stub)).toBe(true);
    expect(await cursorCalls()).toBe(2);
    await watcher.nextOf('stats');
    watcher.ws.close();
  });
});
