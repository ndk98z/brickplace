import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { TickPush, TickReply } from '@brickplace/game';
import { foldNow } from '@brickplace/game/journal';
import {
  decodeServerMessage,
  encodeClientView,
  type ServerMessage,
  VIEW_TILE,
  viewTiles,
} from '@brickplace/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/index.ts';
import { flushTiming } from '../src/pacing.ts';
import { CANVAS_HEADER, PLAYER_HEADER, WATCH_HEADER } from '../src/player.ts';
import { watchdogTiming } from '../src/watchdog.ts';

// Convergence under faults (ADR 0028): one canvas, FanoutDO shards, watchers with and without
// tile views, and a seeded random run of ops (through a shard and around it) mixed with faults.
// Then every fault stops, ticks and watchdogs run until the shards are level, and every socket
// still open must show exactly the canvas's grid in the tiles it follows. Three mixes:
//
// - `push`: three shards, push faults only (dropped, answered but lost, duplicated, delayed,
//   answered after the canvas gave up). No socket may close.
// - `full`: three shards, the push faults plus follow() replies lost, shards evicted, the canvas
//   restarted with and without saved cursors, the canvas forgetting a shard and ticks too big
//   to list. A socket may close only with 1012, and only if it was open when its shard was
//   evicted and, before the shard loaded again, the canvas could not say what it missed: what
//   the shard's sockets have (its behind marker, else the canvas's cursor for it) unknown or
//   out of the ring, an overflow tick, a restart without saved cursors, forget(), or a lost
//   follow() reply possible. The close ratio over all seeds must stay under a baseline.
// - `rollback`: one shard (several shards against a game script from before ADR 0028 are not
//   supported, ADR 0028 "Rollback"), ops only through it, the `full` faults plus a game script
//   without follow(), cursor() or ticks for a while. Same close rule as `full`.
//
// Limitations: the test runtime refuses to evict an object while an RPC to it is under way
// (a push answered late, a watch); such an eviction is skipped and counted, not retried, so a
// seed may evict less often than it rolled. An eviction the runtime is still at after 3 s is
// counted too, and its pages may close, since it may land at any later point. Over seeds
// 1-200: 0-2 refused and 2-3 still under way in `full`, 0-3 and 6-9 in `rollback`. A shard's
// pending timers are cleared just before its eviction (evictShard), as an eviction drops them.
//
// Seeds: CONVERGENCE_SEEDS (default 6) from CONVERGENCE_FIRST_SEED (default 1) for each mix,
// plus the kept seeds below for `full`, which failed with one of the fixes taken out: 3 and 18
// (and 5 more of the first 60) when follow() took its reply as delivered (the canvas's cursor
// for the shard set to the snapshot's seq), 5 (and 8 more of the first 20) without the shards'
// tick watchdog.

const { FANOUT, CANVAS } = env as unknown as Env;
const SIZE = 512;
const STEPS = 40;
const testEnv = env as unknown as { CONVERGENCE_SEEDS?: string; CONVERGENCE_FIRST_SEED?: string };
const SEEDS = Number(testEnv.CONVERGENCE_SEEDS) || 6;
const FIRST = Number(testEnv.CONVERGENCE_FIRST_SEED) || 1;
/** Seeds that caught a bug once: always run. */
const KEPT = [3, 5, 18];

/** Where the seed under way is, for a seed that runs out of time. */
const progress = { at: '' };

/** Evictions the test runtime refused (an RPC under way), over every seed run. */
let evictSkips = 0;
/** Evictions still under way after EVICT_WAIT_MS, over every seed run. */
let evictsPending = 0;
const EVICT_WAIT_MS = 3_000;

type Eviction = 'evicted' | 'refused' | 'pending';

/**
 * Evicts an object; one that still has an RPC under way is left as it is (test runtime) and
 * counted (`refused`). `pending`: the runtime is still at it after EVICT_WAIT_MS (counted); the
 * eviction may land at any later point.
 */
async function evict(stub: DurableObjectStub): Promise<Eviction> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), EVICT_WAIT_MS);
  });
  try {
    const done = evictDurableObject(stub).then(() => 'evicted' as const);
    const outcome = await Promise.race([done, waited]);
    if (outcome === 'pending') {
      evictsPending++;
      // Its outcome no longer matters to the run, but must not be an unhandled rejection.
      done.catch(() => {});
    }
    return outcome;
  } catch (error) {
    if (!String(error).includes('active references')) throw error;
    evictSkips++;
    return 'refused';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Evicts a shard. Its pending timers (watchdog, behind check, views) go first, as an eviction
 * drops them: the test runtime can wait forever on an eviction while one of them calls the
 * canvas. If the eviction is refused the timers' work runs at once instead, so nothing is lost.
 */
async function evictShard(stub: DurableObjectStub): Promise<Eviction> {
  type Timers = Record<'verifyTimer' | 'watchTimer' | 'viewTimer', unknown>;
  const pending = await runInDurableObject(stub, (instance: unknown) => {
    const i = instance as Timers;
    const had = { verify: i.verifyTimer !== null, watch: i.watchTimer !== null };
    for (const name of ['verifyTimer', 'watchTimer', 'viewTimer'] as const) {
      if (i[name] !== null) clearTimeout(i[name] as ReturnType<typeof setTimeout>);
      i[name] = null;
    }
    (instance as { viewTimerAt: number }).viewTimerAt = Number.POSITIVE_INFINITY;
    return had;
  });
  progress.at += ', evicting a shard';
  const outcome = await evict(stub);
  if (outcome !== 'refused') return outcome;
  await runInDurableObject(stub, (instance: unknown) => {
    const i = instance as {
      scheduleCheck(ms: number): void;
      scheduleWatch(ms: number): void;
      scheduleViews(at: number): void;
    };
    if (pending.verify) i.scheduleCheck(0);
    if (pending.watch) i.scheduleWatch(0);
    i.scheduleViews(Date.now());
  });
  return outcome;
}

/** mulberry32: small, seeded, good enough to pick faults. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Faults in force, read by the wrappers installed in the canvas and the shards. */
const faults = {
  random: Math.random,
  /** Probability of each push fault. */
  pushFault: 0,
  /** A game script without ticks: pushes fail, follow() and cursor() are missing. */
  rollback: false,
  /** Probability that a follow() commits on the canvas but its reply is lost. */
  followLost: 0,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wraps the canvas's push sender with the faults above (again after each restart). */
async function wrapCanvas(name: string): Promise<void> {
  await runInDurableObject(CANVAS.get(CANVAS.idFromName(name)), (instance: unknown) => {
    const pusher = (
      instance as {
        pusher: {
          deps: { send: (s: string, p: TickPush) => Promise<TickReply> };
          pushMs: number;
          pushTimeoutMs: number;
        };
      }
    ).pusher;
    if ((pusher as unknown as { wrapped?: boolean }).wrapped) return;
    (pusher as unknown as { wrapped?: boolean }).wrapped = true;
    pusher.pushTimeoutMs = 150;
    const real = pusher.deps.send;
    pusher.deps = {
      ...pusher.deps,
      send: async (shard, push) => {
        if (faults.rollback) throw new Error('no ticks in this game script');
        if (faults.random() < faults.pushFault) {
          const kind = Math.floor(faults.random() * 5);
          if (kind === 0) throw new Error('push dropped');
          if (kind === 1) {
            await real(shard, push);
            throw new Error('push answered, answer lost');
          }
          if (kind === 2) {
            await real(shard, push);
            return real(shard, push);
          }
          if (kind === 3) {
            await sleep(Math.floor(faults.random() * 100));
            return real(shard, push);
          }
          // Answered long after the canvas gave up on it (its timeout is 150 ms here). Not
          // never: a promise that never settles keeps the object from being evicted in tests.
          await sleep(400);
          return real(shard, push);
        }
        return real(shard, push);
      },
    };
  });
}

/** Puts the follow()/cursor() faults between a shard and its canvas (again after evictions). */
async function wrapShard(name: string): Promise<void> {
  await runInDurableObject(FANOUT.get(FANOUT.idFromName(name)), (instance: unknown) => {
    const target = instance as { env: Env; wrapped?: boolean };
    if (target.wrapped) return;
    target.wrapped = true;
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
              return async (...args: Parameters<typeof canvas.follow>) => {
                if (faults.rollback) throw missing('follow');
                const reply = await canvas.follow(...args);
                if (faults.random() < faults.followLost) throw new Error('follow reply lost');
                return reply;
              };
            }
            if (property === 'cursor') {
              return async (shard: string) => {
                if (faults.rollback) throw missing('cursor');
                return canvas.cursor(shard);
              };
            }
            return Reflect.get(stub, property);
          },
        });
      },
    };
    target.env = { ...target.env, CANVAS: wrapped as unknown as Env['CANVAS'] };
  });
}

/** A test page: its own copy of the map from the frames it receives. */
interface Page {
  readonly ws: WebSocket;
  readonly shard: string;
  readonly cells: Uint8Array;
  readonly shields: Uint8Array;
  /** The tiles it follows (a subscribing view), or null for every tile. */
  tiles: { x: number; y: number; w: number; h: number } | null;
  closed: number | null;
}

async function openPage(canvas: string, shard: string, player: string | null): Promise<Page> {
  const headers: Record<string, string> = { Upgrade: 'websocket', [CANVAS_HEADER]: canvas };
  if (player === null) headers[WATCH_HEADER] = '1';
  else headers[PLAYER_HEADER] = player;
  let response: Response | undefined;
  for (let tries = 0; tries < 20; tries++) {
    response = await FANOUT.get(FANOUT.idFromName(shard)).fetch('https://fanout/ws', { headers });
    if (response.status === 101) break;
    await sleep(50);
  }
  expect(response?.status).toBe(101);
  const ws = response!.webSocket!;
  ws.binaryType = 'arraybuffer';
  const page: Page = {
    ws,
    shard,
    cells: new Uint8Array(SIZE * SIZE),
    shields: new Uint8Array(SIZE * SIZE),
    tiles: null,
    closed: null,
  };
  ws.addEventListener('message', (event) => {
    let message: ServerMessage;
    try {
      message = decodeServerMessage(new Uint8Array(event.data as ArrayBuffer));
    } catch {
      return;
    }
    if (message.type === 'diffs') {
      for (const d of message.diffs) {
        page.cells[d.index] = d.cell;
        page.shields[d.index] = d.shield;
      }
    } else if (message.type === 'tile') {
      for (let row = 0; row < message.edge; row++) {
        const at = (message.ty * message.edge + row) * SIZE + message.tx * message.edge;
        page.cells.set(message.cells.subarray(row * message.edge, (row + 1) * message.edge), at);
        page.shields.set(
          message.shields.subarray(row * message.edge, (row + 1) * message.edge),
          at,
        );
      }
    }
  });
  ws.addEventListener('close', (event) => {
    page.closed = event.code;
  });
  ws.accept();
  return page;
}

function subscribe(page: Page, random: () => number): void {
  if (page.closed !== null) return;
  const x = Math.floor(random() * SIZE);
  const y = Math.floor(random() * SIZE);
  const view = { x, y, w: Math.min(SIZE - x, 40), h: Math.min(SIZE - y, 30) };
  try {
    page.ws.send(encodeClientView({ view, subscribe: true }));
    page.tiles = viewTiles(view, SIZE);
  } catch {
    // Closed meanwhile.
  }
}

/** A 512² canvas, open everywhere, rebuilt from its stored config. */
async function smallCanvas(name: string): Promise<void> {
  const stub = CANVAS.get(CANVAS.idFromName(name));
  await runInDurableObject(stub, (_, state) => {
    const row = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'")
      .one();
    const config = JSON.parse(row.value);
    state.storage.sql.exec(
      "UPDATE meta SET value = ? WHERE key = 'config'",
      JSON.stringify({ ...config, size: SIZE, open: { x: 0, y: 0, w: SIZE, h: SIZE } }),
    );
  });
  await evictDurableObject(stub);
}

async function stock(canvas: string, player: string, kind: 'brick' | 'hammer' | 'shield') {
  const item = kind === 'brick' ? { kind, shape: 1 } : { kind };
  await runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance, state) => {
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify([item]),
      2 ** 50,
    );
  });
}

/** Shards whose cursor on the canvas is below its seq (and that still have sockets). */
async function lagging(canvas: string, shards: readonly string[]): Promise<string[]> {
  return runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance: unknown) => {
    const i = instance as {
      seq: number;
      pusher: { shards: Map<string, { acked: number | null; inFlight: boolean }> };
    };
    return shards.filter((name) => {
      const s = i.pusher.shards.get(name);
      return !s || s.inFlight || s.acked === null || s.acked < i.seq;
    });
  });
}

/** `paced`: the `full` faults with ADR 0041's flushes on (every other mix sends at once). */
type Mix = 'push' | 'full' | 'rollback' | 'paced';

/** What each mix may roll; a roll outside it does nothing. */
const MIXES: Record<Mix, { readonly shards: number; readonly faults: ReadonlySet<string> }> = {
  push: { shards: 3, faults: new Set(['push']) },
  full: {
    shards: 3,
    faults: new Set(['push', 'followLost', 'evict', 'restart', 'forget', 'bigTicks']),
  },
  rollback: {
    shards: 1,
    faults: new Set(['push', 'followLost', 'evict', 'restart', 'forget', 'bigTicks', 'rollback']),
  },
  paced: {
    shards: 3,
    faults: new Set(['push', 'followLost', 'evict', 'restart', 'forget', 'bigTicks']),
  },
};
/** The flush interval of the `paced` mix (ms): short, so a seed's steps land between flushes. */
const PACED_FLUSH_MS = 20;

async function runSeed(
  seed: number,
  mix: Mix,
): Promise<{ open: number; closed: number; total: number }> {
  const random = rng(seed);
  faults.random = random;
  faults.pushFault = 0;
  faults.rollback = false;
  faults.followLost = 0;
  const allowed = MIXES[mix].faults;
  const SHARDS = MIXES[mix].shards;
  const canvasName = mix === 'full' ? `conv-${seed}` : `conv-${mix}-${seed}`;
  const shards = Array.from({ length: SHARDS }, (_, i) => `${canvasName}:fanout-${i}`);
  await smallCanvas(canvasName);
  await wrapCanvas(canvasName);
  const canvas = CANVAS.get(CANVAS.idFromName(canvasName));
  for (const shard of shards) await wrapShard(shard);
  const pages: Page[] = [];
  for (const shard of shards) {
    pages.push(await openPage(canvasName, shard, null));
    const viewing = await openPage(canvasName, shard, null);
    subscribe(viewing, random);
    pages.push(viewing);
  }
  const player = await openPage(canvasName, shards[0]!, `pl-${seed}`);
  pages.push(player);
  /** Pages that were open when an event left no record of what they missed: may close. */
  const mayClose = new Set<Page>();
  const openOn = (shard: string | null) =>
    pages.filter((p) => p.closed === null && (shard === null || p.shard === shard));
  /**
   * Shards evicted and not loaded again, with the pages open at the eviction. Those pages may
   * close only if, before the shard loads again, the canvas cannot say what they missed: its
   * cursor for the shard unknown or behind its ring (a restart, forget(), a tick too big to
   * list), or a follow() reply may be lost.
   */
  const unloaded = new Map<string, Page[]>();
  let tickCap = 1 << 18;
  const markLost = (shard: string) => {
    for (const page of unloaded.get(shard) ?? []) mayClose.add(page);
    unloaded.delete(shard);
  };
  /**
   * Whether follow() would now answer the shard `changes: null`: what its sockets have (its
   * stored behind marker, else the canvas's cursor for it) is unknown or out of the ring.
   */
  const cursorLost = async (shard: string) => {
    const sent = await runInDurableObject(FANOUT.get(FANOUT.idFromName(shard)), (_, state) =>
      state.storage.kv.get<number>('sentSeq'),
    );
    return runInDurableObject(canvas, (instance: unknown) => {
      const { pusher, seq } = instance as {
        seq: number;
        pusher: {
          shards: Map<string, { acked: number | null }>;
          cellsSince(since: number): unknown;
          overflow: boolean;
        };
      };
      // A game script without follow(): a woken shard takes a snapshot and closes its sockets
      // by the marker rule.
      if (faults.rollback) return sent !== undefined && seq > sent;
      const base = sent ?? pusher.shards.get(shard)?.acked ?? null;
      // An overflow not cut yet makes the next tick one too big to list.
      return base === null || pusher.overflow || pusher.cellsSince(base) === null;
    });
  };
  /** Marks or drops each unloaded shard, as of now. */
  const settle = async () => {
    for (const shard of [...unloaded.keys()]) {
      if (faults.followLost > 0 || tickCap < 1 << 18 || (await cursorLost(shard))) {
        markLost(shard);
        continue;
      }
      const loaded = await runInDurableObject(
        FANOUT.get(FANOUT.idFromName(shard)),
        (instance: unknown) => (instance as { mirror: unknown }).mirror !== null,
      );
      if (loaded) unloaded.delete(shard);
    }
  };
  let opId = 0;
  for (let step = 0; step < STEPS; step++) {
    const roll = random();
    progress.at = `step ${step}, roll ${roll.toFixed(3)}`;
    await settle();
    if (roll < 0.35) {
      // An op around the shards (another shard's player), or through shard 0.
      const kind = (['brick', 'brick', 'hammer', 'shield'] as const)[Math.floor(random() * 4)]!;
      const x = Math.floor(random() * (SIZE - 2));
      const y = Math.floor(random() * (SIZE - 2));
      const op =
        kind === 'brick'
          ? ({ kind, x, y, shape: 1, rotation: 0, color: 1 + Math.floor(random() * 20) } as const)
          : ({ kind, x, y } as const);
      // With one shard, every op goes through it (as every player's would).
      if (random() < 0.5 && SHARDS > 1) {
        const who = `op-${seed}-${step}`;
        await stock(canvasName, who, kind);
        await canvas.applyBatch([{ player: who, opId: 1, op }]);
      } else {
        await stock(canvasName, `pl-${seed}`, kind);
        const { encodeClientOp } = await import('@brickplace/protocol');
        try {
          player.ws.send(encodeClientOp({ opId: ++opId, op }));
        } catch {
          // Closed.
        }
      }
    } else if (roll < 0.55) {
      await canvas.pushTicks();
    } else if (roll < 0.62) {
      if (allowed.has('push')) faults.pushFault = random() < 0.5 ? 0 : 0.5;
    } else if (roll < 0.66) {
      if (allowed.has('followLost')) faults.followLost = random() < 0.5 ? 0 : 0.6;
    } else if (roll < 0.72) {
      const shard = shards[Math.floor(random() * SHARDS)]!;
      if (allowed.has('evict')) {
        const open = openOn(shard);
        // As the eviction lands: a push under way may wake the shard before the next look.
        const lost = await cursorLost(shard);
        const outcome = await evictShard(FANOUT.get(FANOUT.idFromName(shard)));
        if (outcome === 'evicted') unloaded.set(shard, [...(unloaded.get(shard) ?? []), ...open]);
        if (outcome === 'evicted' && lost) markLost(shard);
        // An eviction that may land at any later point: no telling what the canvas will know.
        if (outcome === 'pending') for (const page of open) mayClose.add(page);
        await wrapShard(shard);
      }
    } else if (roll < 0.76) {
      // A canvas restart, with or without the cursors saved first.
      const saved = random() < 0.5;
      if (allowed.has('restart')) {
        if (saved) {
          await runInDurableObject(canvas, (instance: unknown) => {
            const i = instance as {
              ctx: DurableObjectState;
              pusher: { saveCursors(): void };
            };
            i.ctx.storage.transactionSync(() => i.pusher.saveCursors());
          });
        }
        if ((await evict(canvas)) !== 'refused' && !saved) {
          for (const shard of [...unloaded.keys()]) markLost(shard);
        }
        await wrapCanvas(canvasName);
      }
    } else if (roll < 0.79) {
      const shard = shards[Math.floor(random() * SHARDS)]!;
      if (allowed.has('forget')) {
        markLost(shard);
        await runInDurableObject(canvas, (instance: unknown) => {
          (instance as { pusher: { forget(n: string): void } }).pusher.forget(shard);
        });
      }
    } else if (roll < 0.83) {
      const cells = random() < 0.5 ? 2 : 1 << 18;
      if (allowed.has('bigTicks')) {
        tickCap = cells;
        await runInDurableObject(canvas, (instance: unknown) => {
          (instance as { pusher: { maxTickCells: number } }).pusher.maxTickCells = cells;
        });
      }
    } else if (roll < 0.87) {
      if (allowed.has('rollback')) faults.rollback = !faults.rollback;
    } else if (roll < 0.93) {
      const shard = shards[Math.floor(random() * SHARDS)]!;
      await FANOUT.get(FANOUT.idFromName(shard))
        .watch()
        .catch(() => {});
    } else if (roll < 0.97) {
      const page = pages[Math.floor(random() * pages.length)]!;
      subscribe(page, random);
    } else {
      const shard = shards[Math.floor(random() * SHARDS)]!;
      pages.push(await openPage(canvasName, shard, null));
    }
    await settle();
    await sleep(Math.floor(random() * 20));
  }

  // Quiescence: no more faults; ticks and watchdogs until every shard is level.
  progress.at = 'quiescence';
  await settle();
  faults.pushFault = 0;
  faults.followLost = 0;
  faults.rollback = false;
  await runInDurableObject(canvas, (instance: unknown) => {
    const pusher = (
      instance as {
        pusher: {
          maxTickCells: number;
          shards: Map<string, { failures: number; retryAt: number }>;
        };
      }
    ).pusher;
    pusher.maxTickCells = 1 << 18;
    // The canvas's backoff (up to 30 s) runs out: it pushes again, as it would in time.
    for (const entry of pusher.shards.values()) entry.retryAt = 0;
  });
  // A page that joins now must end up with the same grid too (and keeps the check from being
  // empty when every earlier socket was closed).
  tickCap = 1 << 18;
  await settle();
  for (const shard of shards) pages.push(await openPage(canvasName, shard, null));
  // Every shard has a socket again, so every one has loaded.
  unloaded.clear();
  for (let round = 0; round < 60; round++) {
    await canvas.pushTicks();
    await sleep(60);
    for (const shard of shards) {
      await FANOUT.get(FANOUT.idFromName(shard))
        .watch()
        .catch(() => {});
    }
    const behind = await lagging(canvasName, shards);
    const live = new Set(pages.filter((p) => p.closed === null).map((p) => p.shard));
    if (behind.every((s) => !live.has(s)) && round > 2) break;
  }
  await sleep(100);

  progress.at = 'checking the pages';
  const grid = await canvas.snapshot();
  let open = 0;
  let closed = 0;
  for (const page of pages) {
    if (page.closed !== null) {
      expect(page.closed, `seed ${seed}: a socket closed with another code`).toBe(1012);
      expect(
        mayClose.has(page),
        `seed ${seed} (${mix}): page ${pages.indexOf(page)} on ${page.shard} closed, but its ` +
          'shard was not evicted while it was open, or the canvas could still say what it missed',
      ).toBe(true);
      closed++;
      continue;
    }
    open++;
    const perSide = SIZE / VIEW_TILE;
    for (let index = 0; index < SIZE * SIZE; index++) {
      const x = index % SIZE;
      const y = (index - x) / SIZE;
      const tx = Math.floor(x / VIEW_TILE);
      const ty = Math.floor(y / VIEW_TILE);
      const t = page.tiles;
      if (t && (tx < t.x || ty < t.y || tx >= t.x + t.w || ty >= t.y + t.h)) continue;
      if (page.cells[index] !== grid.cells[index] || page.shields[index] !== grid.shields[index]) {
        const shard = await runInDurableObject(
          FANOUT.get(FANOUT.idFromName(page.shard)),
          (instance: unknown) => {
            const m = (
              instance as { mirror: { seq: number; following: boolean; cells: Uint8Array } | null }
            ).mirror;
            return m ? { seq: m.seq, following: m.following, cell: m.cells[index] } : null;
          },
        );
        const cursor = await canvas.cursor(page.shard);
        expect.fail(
          `seed ${seed}: page ${pages.indexOf(page)} of ${pages.length}, mirror ${JSON.stringify(shard)}, cursor ${JSON.stringify(cursor)}: ` +
            `seed ${seed}: a socket on ${page.shard} (tiles ${JSON.stringify(t)}, ${perSide}² ` +
            `tiles) shows cell ${index} as ${page.cells[index]}/${page.shields[index]}, ` +
            `the canvas has ${grid.cells[index]}/${grid.shields[index]} at seq ${grid.seq}`,
        );
      }
    }
  }
  for (const page of pages) {
    try {
      page.ws.close(1000);
    } catch {
      // Already closed.
    }
  }
  return { open, closed, total: pages.length };
}

/**
 * Most sockets closed over all seeds of a mix, as a share of those opened. More closes than
 * this is a regression even when each close was allowed. Measured over seeds 1-200: push 0 of
 * 2,265, full 272 of 2,229 (12.2%), rollback 277 of 1,040 (26.6%; one shard, so an eviction
 * hits every page). `many`: 50 seeds or more. `ci`: the default run (seeds 1-6, plus the kept
 * ones for `full`), which closed full 13 of 81 (16.0%) and rollback 19 of 37 (51.4%) in every
 * run so far. `few`: any other run of under 50 seeds, whose share one unlucky seed moves a
 * lot: the worst window of 7 (full) or 6 (rollback) consecutive seeds in 1-200 closed 28.8%
 * and 56.2%.
 */
const CLOSE_RATIO_MAX: Record<Mix, { many: number; ci: number; few: number }> = {
  push: { many: 0, ci: 0, few: 0 },
  full: { many: 0.15, ci: 0.2, few: 0.32 },
  rollback: { many: 0.31, ci: 0.6, few: 0.65 },
  // Not measured over 200 seeds yet: `full`'s bound for short runs.
  paced: { many: 0.15, ci: 0.32, few: 0.32 },
};

describe('convergence under faults (ADR 0028)', () => {
  const stall = watchdogTiming.stallMs;
  beforeAll(() => {
    // Short enough to run within a seed; the alarm-driven period stays off (watch() is called).
    watchdogTiming.stallMs = 200;
  });
  afterAll(() => {
    watchdogTiming.stallMs = stall;
  });

  const range = Array.from({ length: SEEDS }, (_, i) => FIRST + i);
  for (const mix of ['push', 'full', 'rollback', 'paced'] as const) {
    describe(mix, () => {
      const totals = { open: 0, closed: 0, total: 0, seeds: 0 };
      const before = { skips: 0, pending: 0 };
      beforeAll(() => {
        before.skips = evictSkips;
        before.pending = evictsPending;
        if (mix === 'paced') flushTiming.ms = PACED_FLUSH_MS;
      });
      afterAll(() => {
        flushTiming.ms = 0;
      });
      const seeds = new Set(range);
      // The kept seeds, unless a run asked for a range of its own.
      if (mix === 'full' && !testEnv.CONVERGENCE_FIRST_SEED) for (const s of KEPT) seeds.add(s);
      for (const seed of [...seeds].sort((a, b) => a - b)) {
        it(`seed ${seed}: every open socket shows the canvas's grid, or closed as allowed`, async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`seed ${seed} (${mix}) stuck at ${progress.at}`)),
              55_000,
            );
          });
          const result = await Promise.race([runSeed(seed, mix), late]).finally(() =>
            clearTimeout(timer),
          );
          console.log(`convergence ${mix} seed ${seed}: ${result.closed}/${result.total} closed`);
          totals.open += result.open;
          totals.closed += result.closed;
          totals.total += result.total;
          totals.seeds++;
          expect(result.open).toBeGreaterThan(0);
          if (mix === 'push') expect(result.closed, `seed ${seed}: closed sockets`).toBe(0);
        }, 60_000);
      }
      it('closes few sockets over all seeds', () => {
        const ratio = totals.total === 0 ? 0 : totals.closed / totals.total;
        console.log(
          `convergence ${mix}: ${totals.seeds} seeds, ${totals.closed}/${totals.total} sockets ` +
            `closed (${(ratio * 100).toFixed(1)}%), evictions: ${evictSkips - before.skips} ` +
            `refused, ${evictsPending - before.pending} still under way after ${EVICT_WAIT_MS} ms`,
        );
        const bound = CLOSE_RATIO_MAX[mix];
        const defaultRun = !testEnv.CONVERGENCE_SEEDS && !testEnv.CONVERGENCE_FIRST_SEED;
        const max = totals.seeds >= 50 ? bound.many : defaultRun ? bound.ci : bound.few;
        expect(ratio).toBeLessThanOrEqual(max);
      });
    });
  }
});
