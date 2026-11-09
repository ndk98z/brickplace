import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { BatchResult, HoldView, Snapshot } from '@brickplace/game';
import { foldNow } from '@brickplace/game/journal';
import {
  type ClientDiscard,
  type ClientOp,
  decodeServerMessage,
  encodeClientDiscard,
  encodeClientOp,
  encodeClientView,
  MAX_DIFFS_PER_FRAME,
  ProtocolError,
  type ServerMessage,
} from '@brickplace/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  type AbusePolicy,
  MAX_IN_FLIGHT,
  POLICY_KEY,
  type SignalPolicy,
  type Suspect,
} from '../src/abuse.ts';
import { cellFrames, diffFrames, olderRules, sameRules } from '../src/frames.ts';
import { SendGate } from '../src/gate.ts';
import type { Env } from '../src/index.ts';
import {
  ADDRESS_HEADER,
  CHALLENGE_REQUIRED,
  CLIENT_HEADER,
  KICKED,
  NETWORK_HEADER,
  PLAYER_HEADER,
  PLAYING_ELSEWHERE,
  SESSION_TOKEN_TTL_MS,
  TEAM_HEADER,
  TRUST_HEADER,
  UNTIL_HEADER,
  WATCH_HEADER,
} from '../src/player.ts';
import { WAIT_MS } from './wait.ts';

const { FANOUT, CANVAS } = env as unknown as Env;
type Diffs = Extract<ServerMessage, { type: 'diffs' }>;
type Hold = Extract<ServerMessage, { type: 'hold' }>;
type Config = Extract<ServerMessage, { type: 'config' }>;
type Item = Hold['items'][number];
const O: Item = { kind: 'brick', shape: 1 };
const HAMMER: Item = { kind: 'hammer' };
const SHIELD: Item = { kind: 'shield' };
const COOLDOWN = 60_000;

/**
 * Puts exactly these items in a player's hold on the shared canvas (or the named one). By
 * default the cooldown starts far ahead, so no other item arrives during the test.
 */
async function stock(player: string, items: readonly Item[], since = 2 ** 50, canvas = 'canvas') {
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

const brickAt = (x: number, y: number) =>
  ({ kind: 'brick', x, y, shape: 1, rotation: 0, color: 3 }) as const;

/**
 * A test client: collects every frame and hands them out in order. Hold and config messages
 * go to their own queues (`nextHold`, `nextConfig`), so the ack and diff order the tests
 * check stays as it was.
 */
async function connect(
  fanout: string,
  player: string | null = 'p1',
  client?: string,
  sessionUntil?: number,
  team?: string,
  /** More headers from the gateway, e.g. ADDRESS_HEADER or TRUST_HEADER. */
  extra: Record<string, string> = {},
) {
  const stub = FANOUT.get(FANOUT.idFromName(fanout));
  const identity: Record<string, string> =
    player === null ? { [WATCH_HEADER]: '1' } : { [PLAYER_HEADER]: player };
  if (client !== undefined) identity[CLIENT_HEADER] = client;
  if (sessionUntil !== undefined) identity[UNTIL_HEADER] = String(sessionUntil);
  if (team !== undefined) identity[TEAM_HEADER] = team;
  const response = await stub.fetch('https://fanout/ws', {
    headers: { Upgrade: 'websocket', ...identity, ...extra },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const inbox: ServerMessage[] = [];
  const waiting: ((m: ServerMessage) => void)[] = [];
  const holds: Hold[] = [];
  const holdWaiting: ((m: Hold) => void)[] = [];
  const configs: Config[] = [];
  // As in browsers, binary messages arrive as Blobs unless asked otherwise.
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', (event) => {
    const message = decodeServerMessage(new Uint8Array(event.data as ArrayBuffer));
    if (message.type === 'hold') {
      const holdWaiter = holdWaiting.shift();
      if (holdWaiter) holdWaiter(message);
      else holds.push(message);
      return;
    }
    if (message.type === 'config') {
      configs.push(message);
      return;
    }
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (event) => resolve(event.code));
  });
  ws.accept();
  const next = (ms = WAIT_MS): Promise<ServerMessage> => {
    const ready = inbox.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no frame within ${ms} ms`)), ms);
      waiting.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  const nextDiffs = async (): Promise<Diffs> => {
    const message = await next();
    if (message.type !== 'diffs') throw new Error(`expected diffs, got ${message.type}`);
    return message;
  };
  /** The initial grid: diff frames sharing one seq, until the first live frame. */
  const grid = async (): Promise<Diffs> => nextDiffs();
  const nextHold = (ms = WAIT_MS): Promise<Hold> => {
    const ready = holds.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no hold within ${ms} ms`)), ms);
      holdWaiting.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  /** The next config frame (polled: see `until`). */
  const nextConfig = async (): Promise<Config> => {
    await until('config frame', () => configs.length > 0);
    return configs.shift()!;
  };
  const sendOp = (op: ClientOp) => ws.send(encodeClientOp(op));
  const sendDiscard = (discard: ClientDiscard) => ws.send(encodeClientDiscard(discard));
  return {
    ws,
    stub,
    next,
    nextDiffs,
    nextHold,
    nextConfig,
    configs,
    grid,
    sendOp,
    sendDiscard,
    closed,
  };
}

type CanvasStub = ReturnType<Env['CANVAS']['get']>;
type Faults = {
  /** opIds whose call fails: `lost` commits on the canvas first, `refused` never reaches it. */
  readonly ops?: Readonly<Record<number, 'lost' | 'refused'>>;
  /** Wraps snapshot(), e.g. to hold it back while other calls run. */
  readonly snapshot?: (real: CanvasStub) => Promise<Snapshot>;
  /** Rewrites what applyBatch returns, e.g. to add the expiry diffs of a quiet spell. */
  readonly batch?: (real: BatchResult) => BatchResult;
  /** Called for each holds() call (after holdsDelay); returning true makes that call fail. */
  readonly holds?: () => boolean;
  /** Delays each holds() call (ms), so sockets can join while it is under way. */
  readonly holdsDelay?: number;
  /** Awaited before each holds() call: a test-released gate, for joins while one is under way. */
  readonly holdsGate?: () => Promise<void>;
  /** Rewrites what holds() returns. */
  readonly holdsResult?: (real: ReadonlyMap<string, HoldView>) => ReadonlyMap<string, HoldView>;
  /**
   * Called before each status() call; it may wait (to hold the call back) and returning
   * true makes that call fail.
   */
  readonly status?: () => boolean | Promise<boolean>;
  /** Talks to the canvas of this name instead of the shared one. */
  readonly canvas?: string;
  /** A game script from before follow() (a rolled-back game deploy). */
  readonly noFollow?: boolean;
  /** Runs before each follow() (the mirror loading), e.g. to close a socket meanwhile. */
  readonly beforeFollow?: () => void;
};

/**
 * A gate for `holdsGate`: every call waits until `release()`, later ones pass at once.
 * `entered` counts the calls that reached it, so a test can wait for one to be under way.
 */
function holdsGate() {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = {
    entered: 0,
    release,
    wait: () => {
      gate.entered++;
      return open;
    },
  };
  return gate;
}

/** Puts faults between this FanoutDO and the canvas, until the FanoutDO is evicted. */
async function injectFaults(fanout: DurableObjectStub, faults: Faults) {
  await runInDurableObject(fanout, (instance: unknown) => {
    const target = instance as { env: Env };
    const real = target.env.CANVAS;
    const faulty = {
      idFromName: (name: string) => real.idFromName(faults.canvas ?? name),
      get: (id: DurableObjectId) => {
        const canvas = real.get(id);
        return {
          snapshot: () => (faults.snapshot ? faults.snapshot(canvas) : canvas.snapshot()),
          follow: async (shard: string, since: number | null, sockets: number | null) => {
            if (faults.noFollow) {
              throw new TypeError('The RPC receiver does not implement the method "follow".');
            }
            faults.beforeFollow?.();
            return canvas.follow(shard, since, sockets);
          },
          cursor: (shard: string) => {
            if (faults.noFollow) {
              throw new TypeError('The RPC receiver does not implement the method "cursor".');
            }
            return canvas.cursor(shard);
          },
          status: async () => {
            if (await faults.status?.()) throw new Error('canvas restarting');
            return canvas.status();
          },
          holds: async (players: string[]) => {
            if (faults.holdsGate) await faults.holdsGate();
            if (faults.holdsDelay) await new Promise((r) => setTimeout(r, faults.holdsDelay));
            if (faults.holds?.()) throw new Error('canvas restarting');
            const result = await canvas.holds(players);
            return faults.holdsResult ? faults.holdsResult(result) : result;
          },
          discard: (...args: Parameters<CanvasStub['discard']>) => canvas.discard(...args),
          applyBatch: async (ops: Parameters<CanvasStub['applyBatch']>[0]) => {
            const fault = faults.ops?.[ops[0]!.opId];
            if (fault === 'refused') throw new Error('canvas unreachable');
            const result = await canvas.applyBatch(ops);
            if (fault === 'lost') throw new Error('reply lost');
            return faults.batch ? faults.batch(result) : result;
          },
          // A batch with a discard (ADR 0043), under the same faults by its first move's opId.
          applyMoves: async (moves: Parameters<CanvasStub['applyMoves']>[0]) => {
            const fault = faults.ops?.[moves[0]!.opId];
            if (fault === 'refused') throw new Error('canvas unreachable');
            const result = await canvas.applyMoves(moves);
            if (fault === 'lost') throw new Error('reply lost');
            return faults.batch ? faults.batch(result) : result;
          },
        };
      },
    };
    target.env = { ...target.env, CANVAS: faulty as unknown as Env['CANVAS'] };
  });
}

/** The same holds with an item kind this build does not know, as from a newer game script. */
function withBogus(real: ReadonlyMap<string, HoldView>): ReadonlyMap<string, HoldView> {
  const bogus = [{ kind: 'bogus' }] as unknown as HoldView['items'];
  return new Map([...real].map(([player, hold]) => [player, { ...hold, items: bogus }]));
}

/** The attachment of the player's first socket on this FanoutDO. */
async function attachmentOf(fanout: DurableObjectStub, player: string) {
  return runInDurableObject(fanout, (instance: unknown) => {
    const { ctx } = instance as { ctx: DurableObjectState };
    return ctx.getWebSockets(player)[0]!.deserializeAttachment() as {
      nextAt?: number | null;
      revision?: number;
    };
  });
}

/**
 * Ends a player's cooldown without waiting for it on the wall clock (on a loaded runner the
 * page did not even join before an item due in 300 ms): checks first that the player's
 * sockets wait for the item stocked to come `scheduled` and that the alarm is set for it,
 * then makes the item due `lateMs` ago, on the canvas and on the sockets, and runs the alarm
 * that delivers it. Returns the time the item became due.
 */
async function cooldownEnds(
  fanout: string,
  player: string,
  scheduled: number,
  lateMs = 10_000,
): Promise<number> {
  const stub = FANOUT.get(FANOUT.idFromName(fanout));
  const due = Date.now() - lateMs;
  await runInDurableObject(stub, async (instance: unknown) => {
    const { ctx } = instance as { ctx: DurableObjectState };
    const alarm = await ctx.storage.getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(scheduled);
    for (const ws of ctx.getWebSockets(player)) {
      const attachment = ws.deserializeAttachment() as { nextAt?: number | null };
      expect(attachment.nextAt).toBe(scheduled);
    }
  });
  await stock(player, [], due - COOLDOWN);
  // Through remember(), as a hold's delivery would: the alarm reads its copy of the times.
  await runInDurableObject(stub, (instance: unknown) => {
    const target = instance as {
      ctx: DurableObjectState;
      remember(ws: WebSocket, player: string, nextAt: number | null): void;
    };
    for (const ws of target.ctx.getWebSockets(player)) target.remember(ws, player, due);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  return due;
}

/**
 * Waits until `ready()` holds. Polled rather than awaited on a shared promise: code resumed
 * by a promise that a Durable Object resolved runs in that object's context, where the test
 * can no longer use its own sockets.
 */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let tries = 0; !ready(); tries++) {
    if (tries * 5 > WAIT_MS) throw new Error(`${what}: not within ${WAIT_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The stored "behind" marker and its in-memory copy on this FanoutDO. */
async function behindOf(fanout: DurableObjectStub) {
  return runInDurableObject(fanout, (instance: unknown) => {
    const { ctx, behind } = instance as { ctx: DurableObjectState; behind?: number | null };
    return { stored: ctx.storage.kv.get<number>('sentSeq') ?? null, memory: behind ?? null };
  });
}

type Checks = {
  verifyTimer: ReturnType<typeof setTimeout> | null;
  lastFailure: number;
  checkBehind(): Promise<void>;
};

/**
 * Runs the behind check as its timer would (the pending timer dropped first), so a test with
 * a long `verifyDelay` decides when checks happen instead of racing that delay on the wall
 * clock of a loaded runner.
 */
async function runCheck(fanout: DurableObjectStub): Promise<void> {
  await runInDurableObject(fanout, async (instance: unknown) => {
    const target = instance as Checks;
    if (target.verifyTimer !== null) clearTimeout(target.verifyTimer);
    target.verifyTimer = null;
    await target.checkBehind();
  });
}

/** Moves the last failure `ms` into the past, as if that much time had gone by since. */
async function ageFailure(fanout: DurableObjectStub, ms: number): Promise<void> {
  await runInDurableObject(fanout, (instance: unknown) => {
    (instance as Checks).lastFailure -= ms;
  });
}

/** The pending behind check's timer, or null when none is scheduled. */
async function pendingCheck(fanout: DurableObjectStub): Promise<Checks['verifyTimer']> {
  return runInDurableObject(fanout, (instance: unknown) => (instance as Checks).verifyTimer);
}

/** Waits until this FanoutDO's behind marker is cleared, in storage and in memory. */
async function markerCleared(fanout: DurableObjectStub): Promise<void> {
  for (let tries = 0; ; tries++) {
    const { stored, memory } = await behindOf(fanout);
    if (stored === null && memory === null) return;
    if (tries * 20 > WAIT_MS) throw new Error(`marker still set: ${stored}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The canvas's cursor for a shard: the last seq it acknowledged a tick at (ADR 0028). */
async function cursorOf(fanout: string, canvas = 'canvas'): Promise<number | null> {
  return runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance: unknown) => {
    const { pusher } = instance as {
      pusher: { shards: Map<string, { acked: number | null; inFlight: boolean }> };
    };
    const shard = pusher.shards.get(fanout);
    return shard && !shard.inFlight ? shard.acked : null;
  });
}

/**
 * Pushes the canvas's tick now (timers are off here, see setup.ts) and waits until `fanout`
 * has acknowledged everything the canvas has.
 */
async function pushed(fanout: string, canvas = 'canvas'): Promise<void> {
  const stub = CANVAS.get(CANVAS.idFromName(canvas));
  await stub.pushTicks();
  const { seq } = await stub.status();
  for (let tries = 0; ; tries++) {
    if (((await cursorOf(fanout, canvas)) ?? -1) >= seq) return;
    if (tries * 10 > WAIT_MS) throw new Error(`${fanout} did not take the tick to ${seq}`);
    await new Promise((r) => setTimeout(r, 10));
    // A shard that followed again while answering has its cursor raised by its next answer.
    if (tries % 10 === 9) await stub.pushTicks();
  }
}

/**
 * Makes a FanoutDO behave as one the canvas pushes no ticks to (a canvas without the FANOUT
 * binding, or with too many shards): a gap is repaired by a resync, and after an eviction the
 * canvas cannot say what its sockets missed.
 */
async function unfollow(fanout: string, canvas = 'canvas'): Promise<void> {
  await runInDurableObject(FANOUT.get(FANOUT.idFromName(fanout)), (instance: unknown) => {
    (instance as { mirror: { following: boolean } }).mirror.following = false;
  });
  await runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance: unknown) => {
    (instance as { pusher: { forget(name: string): void } }).pusher.forget(fanout);
  });
}

/**
 * Makes the canvas forget its recent ticks (as when its ring no longer reaches back far
 * enough): it can no longer say what changed before its current seq.
 */
async function dropRing(canvas = 'canvas'): Promise<void> {
  const stub = CANVAS.get(CANVAS.idFromName(canvas));
  await stub.pushTicks();
  await runInDurableObject(stub, (instance: unknown) => {
    const pusher = (
      instance as {
        pusher: { ring: unknown[]; ringFrom: number; cutTo: number; ringCellCount: number };
      }
    ).pusher;
    pusher.ring.length = 0;
    pusher.ringCellCount = 0;
    pusher.ringFrom = pusher.cutTo;
  });
}

/** Sets FanoutDO fields tests may change (verifyDelay, gridGate). */
async function tune(fanout: DurableObjectStub, fields: Record<string, unknown>) {
  await runInDurableObject(fanout, (instance: unknown) => {
    Object.assign(instance as object, fields);
  });
}

/** The cells a brick at (x, y) covers in shape 1, rotation 0, read back from the canvas. */
async function placedCells(x: number, y: number): Promise<number[]> {
  const snapshot = await CANVAS.get(CANVAS.idFromName('canvas')).snapshot();
  const size = Math.sqrt(snapshot.cells.length);
  const near: number[] = [];
  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 4; dx++) {
      const index = (y + dy) * size + x + dx;
      if (snapshot.cells[index] !== 0) near.push(index);
    }
  }
  return near;
}

describe('FanoutDO', () => {
  it('only accepts WebSocket upgrades', async () => {
    const stub = FANOUT.get(FANOUT.idFromName('fanout-0'));
    const response = await stub.fetch('https://fanout/ws');
    expect(response.status).toBe(426);
  });

  it('refuses sockets without a player identity', async () => {
    const stub = FANOUT.get(FANOUT.idFromName('fanout-0'));
    const response = await stub.fetch('https://fanout/ws', { headers: { Upgrade: 'websocket' } });
    expect(response.status).toBe(400);
  });

  it('lets a watcher see the map but refuses its ops and discards', async () => {
    await stock('pw', [O]);
    const player = await connect('watch', 'pw');
    await player.grid();
    const watcher = await connect('watch', null);
    await watcher.grid();
    // The rules come to watchers too: they draw the open area like everyone else.
    const rules = await watcher.nextConfig();
    expect(rules.mapSize).toBe(1024);
    expect(rules.open.w).toBeGreaterThan(0);
    watcher.sendOp({ opId: 1, op: brickAt(610, 640) });
    expect(await watcher.next()).toEqual({
      type: 'ack',
      opId: 1,
      ok: false,
      reason: 'signed_out',
    });
    watcher.sendDiscard({ opId: 2, discard: O });
    expect(await watcher.next()).toEqual({
      type: 'ack',
      opId: 2,
      ok: false,
      reason: 'signed_out',
    });
    // ...and still receives what players do.
    player.sendOp({ opId: 1, op: brickAt(610, 640) });
    expect(await player.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await watcher.nextDiffs()).diffs).toHaveLength(4);
    await expect(watcher.nextHold(300)).rejects.toThrow('no hold');
    player.ws.close();
    watcher.ws.close();
  });

  it('stops a socket playing once its session token expired, and closes it', async () => {
    await stock('pe', [O, O]);
    const live = await connect('session-expiry', 'pe', 'page-live', Date.now() + 60_000);
    await live.grid();
    live.sendOp({ opId: 1, op: brickAt(640, 700) });
    expect(await live.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    await live.nextHold();
    await live.nextHold();
    // The expiry survives hold updates rewriting the attachment.
    const fanout = FANOUT.get(FANOUT.idFromName('session-expiry'));
    const kept = await runInDurableObject(fanout, (_, state) =>
      state
        .getWebSockets('pe')
        .map((ws) => (ws.deserializeAttachment() as { until?: number }).until),
    );
    expect(kept).toHaveLength(1);
    expect(kept.every((until) => typeof until === 'number')).toBe(true);
    const expired = await connect('session-expiry', 'pe', 'page-old', Date.now() - 1);
    await expired.grid();
    await live.nextDiffs();
    expired.sendOp({ opId: 1, op: brickAt(650, 700) });
    let message = await expired.next();
    while (message.type === 'diffs') message = await expired.next();
    expect(message).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'signed_out' });
    expect(await expired.closed).toBe(4401);
    // Nothing was spent: the second brick is still held.
    const hold = await CANVAS.get(CANVAS.idFromName('canvas')).holds(['pe']);
    expect(hold.get('pe')!.items).toEqual([O]);
    // A discard after the expiry is refused the same way and throws nothing away.
    const expiredToo = await connect('session-expiry', 'pe', 'page-old-2', Date.now() - 1);
    await expiredToo.grid();
    expiredToo.sendDiscard({ opId: 1, discard: O });
    let discarded = await expiredToo.next();
    while (discarded.type === 'diffs') discarded = await expiredToo.next();
    expect(discarded).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'signed_out' });
    expect(await expiredToo.closed).toBe(4401);
    const after = await CANVAS.get(CANVAS.idFromName('canvas')).holds(['pe']);
    expect(after.get('pe')!.items).toEqual([O]);
  });

  it('kicks a player at once: older tokens only watch, newer ones play (ADR 0023)', async () => {
    await stock('pk', [O, O]);
    await stock('pk-other', [O]);
    // A token issued half an hour ago.
    const older = Date.now() + 30 * 60_000;
    const page = await connect('kick', 'pk', 'page-a', older);
    await page.grid();
    const bystander = await connect('kick', 'pk-other', 'page-o', older);
    await bystander.grid();
    const fanout = FANOUT.get(FANOUT.idFromName('kick'));
    expect(await fanout.kick('pk')).toEqual({ closed: 1 });
    expect(await page.closed).toBe(KICKED);
    const ackOf = async (socket: Awaited<ReturnType<typeof connect>>) => {
      let message = await socket.next();
      while (message.type === 'diffs') message = await socket.next();
      return message;
    };
    // The page reconnects with the token it holds, even after an eviction: it only watches.
    await evictDurableObject(fanout);
    const again = await connect('kick', 'pk', 'page-a', older);
    await again.grid();
    again.sendOp({ opId: 1, op: brickAt(640, 760) });
    expect(await ackOf(again)).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'signed_out' });
    await expect(again.nextHold(300)).rejects.toThrow('no hold');
    // A token issued after the kick (renewed after the D1 check) plays again.
    const renewed = await connect('kick', 'pk', 'page-b', Date.now() + SESSION_TOKEN_TTL_MS + 1);
    await renewed.grid();
    renewed.sendOp({ opId: 1, op: brickAt(650, 760) });
    expect(await ackOf(renewed)).toEqual({ type: 'ack', opId: 1, ok: true });
    // Nobody else was touched.
    bystander.sendOp({ opId: 1, op: brickAt(660, 760) });
    expect(await ackOf(bystander)).toEqual({ type: 'ack', opId: 1, ok: true });
    // A second kick prunes nothing still due and closes the new socket too.
    expect(await fanout.kick('pk')).toEqual({ closed: 1 });
    expect(await renewed.closed).toBe(KICKED);
    const kicked = await runInDurableObject(fanout, (_, state) => [
      ...state.storage.kv.list<number>({ prefix: 'kick:' }),
    ]);
    expect(kicked.map(([key]) => key)).toEqual(['kick:pk']);
    expect(kicked[0]![1]).toBeGreaterThan(Date.now() + SESSION_TOKEN_TTL_MS - 60_000);
    // An entry past its time no longer limits anyone, and the next kick drops it.
    await runInDurableObject(fanout, (_, state) => {
      state.storage.kv.put('kick:pk', Date.now() - 1);
    });
    const later = await connect('kick', 'pk', 'page-c', older);
    await later.grid();
    later.sendOp({ opId: 1, op: brickAt(670, 760) });
    expect(await ackOf(later)).toEqual({ type: 'ack', opId: 1, ok: true });
    await fanout.kick('pk-other');
    const left = await runInDurableObject(fanout, (_, state) =>
      [...state.storage.kv.list<number>({ prefix: 'kick:' })].map(([key]) => key),
    );
    expect(left).toEqual(['kick:pk-other']);
    expect(await bystander.closed).toBe(KICKED);
    later.ws.close();
    again.ws.close();
  });

  it('keeps the opIds of two pages of one player apart, and retries within a page', async () => {
    await stock('pt', [O, O, O]);
    const tabA = await connect('tabs', 'pt', 'page-a');
    await tabA.grid();
    tabA.sendOp({ opId: 1, op: brickAt(620, 660) });
    expect(await tabA.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    // Page B takes over (one playing socket per account) and counts its opIds from 1 too.
    const tabB = await connect('tabs', 'pt', 'page-b');
    await tabB.grid();
    expect(await tabA.closed).toBe(PLAYING_ELSEWHERE);
    tabB.sendOp({ opId: 1, op: brickAt(630, 660) });
    expect(await tabB.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    // Page A comes back and resends op 1: the canvas knows it, and nothing more is spent.
    const again = await connect('tabs', 'pt', 'page-a');
    await again.grid();
    expect(await tabB.closed).toBe(PLAYING_ELSEWHERE);
    again.sendOp({ opId: 1, op: brickAt(620, 660) });
    expect(await again.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    const hold = await CANVAS.get(CANVAS.idFromName('canvas')).holds(['pt']);
    expect(hold.get('pt')!.items).toEqual([O]);
    again.ws.close();
  });

  it('keeps one playing socket per account: the newest plays, the older one closes', async () => {
    await stock('p-one', [O, O]);
    await stock('p-two', [O]);
    const first = await connect('one-socket', 'p-one', 'page-a');
    await first.grid();
    const other = await connect('one-socket', 'p-two', 'page-o');
    await other.grid();
    const watcher = await connect('one-socket', null, 'page-w');
    await watcher.grid();
    const second = await connect('one-socket', 'p-one', 'page-b');
    await second.grid();
    expect(await first.closed).toBe(PLAYING_ELSEWHERE);
    const fanout = FANOUT.get(FANOUT.idFromName('one-socket'));
    const open = await runInDurableObject(fanout, (_, state) => ({
      mine: state.getWebSockets('p-one').length,
      all: state.getWebSockets().length,
    }));
    // The newer socket only; other players and watchers are untouched.
    expect(open).toEqual({ mine: 1, all: 3 });
    second.sendOp({ opId: 1, op: brickAt(280, 480) });
    expect(await second.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    other.sendOp({ opId: 1, op: brickAt(290, 480) });
    let ack = await other.next();
    while (ack.type === 'diffs') ack = await other.next();
    expect(ack).toEqual({ type: 'ack', opId: 1, ok: true });
    // A page of the account that only watches (a token from before a kick) closes nobody.
    await fanout.kick('p-two');
    expect(await other.closed).toBe(KICKED);
    const stale = await connect('one-socket', 'p-two', 'page-s', Date.now() + 60_000);
    await stale.grid();
    const again = await connect('one-socket', 'p-two', 'page-t', Date.now() + 2 * 3_600_000);
    await again.grid();
    const tags = await runInDurableObject(
      fanout,
      (_, state) => state.getWebSockets('p-two').length,
    );
    expect(tags).toBe(1);
    stale.ws.close();
    again.ws.close();
    second.ws.close();
    watcher.ws.close();
  });

  it('passes the team from the gateway with every op, and drops a malformed one', async () => {
    await stock('p-team', [O, SHIELD, SHIELD]);
    /** The next ack, past the diff frames of this socket's own ops. */
    const ack = async (socket: Awaited<ReturnType<typeof connect>>) => {
      for (;;) {
        const message = await socket.next();
        if (message.type === 'ack') return message;
      }
    };
    const member = await connect('teams', 'p-team', 'page-t', undefined, '42');
    await member.grid();
    member.sendOp({ opId: 1, op: brickAt(670, 400) });
    expect(await ack(member)).toEqual({ type: 'ack', opId: 1, ok: true });
    // A shield counts for the team whatever the daily cap (none is set here).
    member.sendOp({ opId: 2, op: { kind: 'shield', x: 670, y: 400 } });
    expect(await ack(member)).toEqual({ type: 'ack', opId: 2, ok: true });
    const canvas = CANVAS.get(CANVAS.idFromName('canvas'));
    expect((await canvas.teamStandings()).get(42)).toMatchObject({ shields: 1 });
    expect(await canvas.lastWriter(670, 400)).toEqual(['p-team', 0]);
    member.ws.close();
    const odd = await connect('teams', 'p-team', 'page-u', undefined, 'forty');
    await odd.grid();
    odd.sendOp({ opId: 1, op: { kind: 'shield', x: 671, y: 400 } });
    expect(await ack(odd)).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await canvas.teamStandings()).get(42)).toMatchObject({ shields: 1 });
    odd.ws.close();
  });

  it('sends the current grid first, then the live diffs after it', async () => {
    await stock('pa', [O]);
    await stock('pb', [O]);
    const a = await connect('live', 'pa');
    const start = await a.grid();
    a.sendOp({ opId: 1, op: brickAt(600, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    const placed = await a.nextDiffs();
    expect(placed.seq).toBe(start.seq + 1);
    expect(placed.diffs).toHaveLength(4);

    // A later socket starts from a grid that already holds the brick, at the same seq.
    const b = await connect('live', 'pb');
    const grid = await b.grid();
    expect(grid.seq).toBe(placed.seq);
    for (const d of placed.diffs) expect(grid.diffs).toContainEqual(d);

    // Then both get the next op, and nothing in between.
    b.sendOp({ opId: 1, op: brickAt(610, 600) });
    expect(await b.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await b.nextDiffs()).seq).toBe(placed.seq + 1);
    expect((await a.nextDiffs()).seq).toBe(placed.seq + 1);
  });

  it('answers a retried op as accepted without applying or sending it again', async () => {
    await stock('pr', [O, HAMMER, HAMMER]);
    const a = await connect('retry', 'pr');
    await a.grid();
    const hammer = { kind: 'hammer', x: 620, y: 600 } as const;
    a.sendOp({ opId: 1, op: brickAt(620, 600) });
    await a.next();
    await a.nextDiffs();
    a.sendOp({ opId: 2, op: hammer });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    await a.nextDiffs();
    a.sendOp({ opId: 2, op: hammer });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    // A fresh hammer on the now empty cell is rejected, and no diffs came in between.
    a.sendOp({ opId: 3, op: hammer });
    expect(await a.next()).toEqual({ type: 'ack', opId: 3, ok: false, reason: 'empty' });
  });

  it('repairs a missing seq with the next tick, without a snapshot', async () => {
    await stock('pg', [O]);
    await stock('px', [O]);
    const a = await connect('gap', 'pg');
    const start = await a.grid();
    let snapshots = 0;
    await injectFaults(a.stub, {
      snapshot: (real) => {
        snapshots++;
        return real.snapshot();
      },
    });
    // An op the canvas committed but whose reply never reached this FanoutDO (or another
    // shard's op).
    const canvas = CANVAS.get(CANVAS.idFromName('canvas'));
    const lost = await canvas.applyBatch([{ player: 'px', opId: 1, op: brickAt(630, 600) }]);
    const lostDiffs = lost.results[0]!.ok ? lost.results[0]!.diffs : [];
    expect(lost.seq).toBe(start.seq + 1);

    a.sendOp({ opId: 1, op: brickAt(640, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    // The reply does not continue the mirror's seq: it waits for the tick, which carries both.
    await pushed('gap');
    const repair = await a.nextDiffs();
    expect(snapshots).toBe(0);
    expect(repair.seq).toBe(start.seq + 2);
    expect(repair.diffs).toHaveLength(8);
    for (const d of lostDiffs) expect(repair.diffs).toContainEqual(d);
  });

  it('falls back to snapshots on a game script without follow(), and still repairs gaps', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await stock('pnf', [O]);
    await stock('pnx', [O]);
    const stub = FANOUT.get(FANOUT.idFromName('no-follow'));
    // Faults before the first socket: the mirror loads through the old canvas.
    await injectFaults(stub, { noFollow: true });
    const a = await connect('no-follow', 'pnf');
    const start = await a.grid();
    const following = await runInDurableObject(
      stub,
      (instance: unknown) => (instance as { mirror: { following: boolean } }).mirror.following,
    );
    expect(following).toBe(false);
    // Not following: a gap in the replies is repaired by a resync, as before ticks.
    await CANVAS.get(CANVAS.idFromName('canvas')).applyBatch([
      { player: 'pnx', opId: 1, op: brickAt(650, 620) },
    ]);
    a.sendOp({ opId: 1, op: brickAt(660, 620) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    const repair = await a.nextDiffs();
    expect(repair.seq).toBe(start.seq + 2);
    expect(repair.diffs).toHaveLength(8);
    a.ws.close();
    vi.restoreAllMocks();
  });

  it('keeps serving open sockets after an eviction', async () => {
    await stock('pe', [O]);
    const a = await connect('evict', 'pe');
    const start = await a.grid();
    await evictDurableObject(a.stub);
    a.sendOp({ opId: 1, op: brickAt(660, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    const placed = await a.nextDiffs();
    expect(placed.seq).toBe(start.seq + 1);
    expect(placed.diffs).toHaveLength(4);
  });

  it('brings sockets left behind up to date when evicted after a lost reply', async () => {
    await stock('pl2', [O, O]);
    const a = await connect('evict-lost-following', 'pl2');
    const start = await a.grid();
    await injectFaults(a.stub, { ops: { 1: 'lost' } });
    await tune(a.stub, { verifyDelay: Number.POSITIVE_INFINITY });
    a.sendOp({ opId: 1, op: brickAt(670, 620) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    const lost = await placedCells(670, 620);
    expect(lost).toHaveLength(4);

    // Evicted before any tick: the canvas knows the last seq this shard's sockets took (its
    // cursor) and hands the reloaded shard what changed since, so nobody has to reconnect.
    await evictDurableObject(a.stub);
    a.sendOp({ opId: 2, op: brickAt(680, 620) });
    const repair = await a.nextDiffs();
    expect(repair.seq).toBe(start.seq + 1);
    expect(repair.diffs.map((d) => d.index).sort()).toEqual([...lost].sort());
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    expect((await a.nextDiffs()).seq).toBe(start.seq + 2);
    a.ws.close();
  });

  it('closes sockets left behind when evicted after a lost reply the canvas cannot repair', async () => {
    await stock('pl', [O, O]);
    const a = await connect('evict-lost', 'pl');
    await a.grid();
    await unfollow('evict-lost');
    await injectFaults(a.stub, { ops: { 1: 'lost' } });
    // No canvas check before the eviction (it would repair the lost reply first).
    await tune(a.stub, { verifyDelay: Number.POSITIVE_INFINITY });
    a.sendOp({ opId: 1, op: brickAt(670, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    const lost = await placedCells(670, 600);
    expect(lost).toHaveLength(4);

    // Evicted before any resync, and the canvas's ticks no longer reach back to what `a` has:
    // neither the rebuilt mirror nor the canvas can tell what `a` misses.
    await dropRing();
    await evictDurableObject(a.stub);
    a.sendOp({ opId: 2, op: brickAt(680, 600) });
    expect(await a.closed).toBe(1012);
    // The op that arrived on the closed socket was not applied; the client resends it.
    expect(await placedCells(680, 600)).toEqual([]);

    // Reconnecting gives a grid with the cells the old socket missed.
    const b = await connect('evict-lost', 'pl');
    const grid = await b.grid();
    const indices = grid.diffs.map((d) => d.index);
    for (const index of lost) expect(indices).toContain(index);
  });

  // A false 1012 closes every socket at once and starts a reconnect storm: these two cases
  // must stay open after an eviction.
  it('keeps sockets open after eviction when the failed op never committed', async () => {
    await stock('pf', [O, O]);
    const a = await connect('evict-refused', 'pf');
    const start = await a.grid();
    await injectFaults(a.stub, { ops: { 1: 'refused' } });
    // Evicted before any canvas check: only the stored marker decides.
    await tune(a.stub, { verifyDelay: Number.POSITIVE_INFINITY });
    a.sendOp({ opId: 1, op: brickAt(690, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    a.sendOp({ opId: 2, op: brickAt(690, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    expect((await a.nextDiffs()).seq).toBe(start.seq + 1);
    // The canvas's cursor for this shard catches up with its next tick.
    await pushed('evict-refused');

    await evictDurableObject(a.stub);
    a.sendOp({ opId: 3, op: brickAt(700, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 3, ok: true });
    expect((await a.nextDiffs()).seq).toBe(start.seq + 2);
  });

  it('keeps sockets open after eviction once a tick repaired a lost reply', async () => {
    await stock('pq', [O, O, O]);
    const a = await connect('evict-repaired', 'pq');
    const start = await a.grid();
    await injectFaults(a.stub, { ops: { 1: 'lost' } });
    await tune(a.stub, { verifyDelay: Number.POSITIVE_INFINITY });
    a.sendOp({ opId: 1, op: brickAt(710, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    a.sendOp({ opId: 2, op: brickAt(720, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    await pushed('evict-repaired');
    const repair = await a.nextDiffs();
    expect(repair.seq).toBe(start.seq + 2);
    expect(repair.diffs).toHaveLength(8);

    await evictDurableObject(a.stub);
    a.sendOp({ opId: 3, op: brickAt(730, 600) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 3, ok: true });
    expect((await a.nextDiffs()).seq).toBe(start.seq + 3);
  });

  it('stays marked when a reply is lost while a resync is under way', async () => {
    await stock('pz', [O, O, O]);
    await stock('py', [O]);
    const a = await connect('evict-race', 'pz');
    const start = await a.grid();
    await unfollow('evict-race');
    // A commit this FanoutDO never hears of, so the next accepted op shows a gap.
    const canvas = CANVAS.get(CANVAS.idFromName('canvas'));
    const unseen = await canvas.applyBatch([{ player: 'py', opId: 1, op: brickAt(320, 260) }]);
    expect(unseen.seq).toBe(start.seq + 1);
    const resync = { taken: false, released: false };
    await injectFaults(a.stub, {
      ops: { 3: 'lost' },
      snapshot: async (real) => {
        const snapshot = await real.snapshot();
        resync.taken = true;
        await until('released', () => resync.released);
        return snapshot;
      },
    });
    await tune(a.stub, { verifyDelay: Number.POSITIVE_INFINITY });
    a.sendOp({ opId: 2, op: brickAt(330, 260) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    await until('resync snapshot', () => resync.taken);
    // While the resync's snapshot (at start + 2) is held back, another op commits and its
    // reply is lost.
    a.sendOp({ opId: 3, op: brickAt(340, 260) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 3, ok: false, reason: 'unavailable' });
    resync.released = true;
    expect((await a.nextDiffs()).seq).toBe(start.seq + 2);

    // As above: the canvas cannot say either.
    await dropRing();
    await evictDurableObject(a.stub);
    a.sendOp({ opId: 4, op: brickAt(350, 260) });
    expect(await a.closed).toBe(1012);
  });

  it('keeps the stored marker at what the sockets have while marked', async () => {
    await stock('pm', [O, O, O]);
    const a = await connect('behind-follows', 'pm');
    const start = await a.grid();
    // Not marked: nothing stored, and the answer is cached in memory.
    expect(await behindOf(a.stub)).toEqual({ stored: null, memory: null });
    await injectFaults(a.stub, { ops: { 1: 'refused' } });
    await tune(a.stub, { verifyDelay: Number.POSITIVE_INFINITY });
    a.sendOp({ opId: 1, op: brickAt(690, 700) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    expect(await behindOf(a.stub)).toEqual({ stored: start.seq, memory: start.seq });
    for (const [opId, x] of [
      [2, 700],
      [3, 710],
    ] as const) {
      a.sendOp({ opId, op: brickAt(x, 700) });
      expect(await a.next()).toEqual({ type: 'ack', opId, ok: true });
      await a.nextDiffs();
    }
    // Each broadcast moved the stored seq too: never older than what the sockets have.
    expect(await behindOf(a.stub)).toEqual({ stored: start.seq + 2, memory: start.seq + 2 });
  });

  it('clears the marker from a level check only once the last failure is old enough', async () => {
    await stock('pn1', [O, O, O]);
    const a = await connect('behind-level', 'pn1');
    const start = await a.grid();
    let checks = 0;
    await injectFaults(a.stub, {
      ops: { 1: 'refused', 3: 'refused' },
      status: () => {
        checks++;
        return false;
      },
    });
    // No check runs on its own within the test: it runs them (runCheck), and ages the last
    // failure by hand, so a loaded runner cannot run one early or late.
    await tune(a.stub, { verifyDelay: 60_000 });
    a.sendOp({ opId: 1, op: brickAt(690, 710) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    a.sendOp({ opId: 2, op: brickAt(700, 710) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    await a.nextDiffs();
    // Within the delay a failed call may still commit: marked, at what the sockets have.
    expect(await behindOf(a.stub)).toEqual({ stored: start.seq + 1, memory: start.seq + 1 });
    const first = await pendingCheck(a.stub);
    expect(first).not.toBeNull();
    // The first failure is old enough by now; another one comes before the check it
    // scheduled, which stays the only one.
    await ageFailure(a.stub, 60_000);
    a.sendOp({ opId: 3, op: brickAt(710, 710) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 3, ok: false, reason: 'unavailable' });
    expect(checks).toBe(0);
    expect(await pendingCheck(a.stub)).toBe(first);
    // That check finds the canvas level, but the last failure (op 3's) too recent: still
    // marked, and checked again later.
    await runCheck(a.stub);
    expect(checks).toBe(1);
    expect(await behindOf(a.stub)).toEqual({ stored: start.seq + 1, memory: start.seq + 1 });
    expect(await pendingCheck(a.stub)).not.toBeNull();
    // Once it is old enough, the next check clears the marker and schedules none.
    await ageFailure(a.stub, 60_000);
    await runCheck(a.stub);
    expect(checks).toBe(2);
    expect(await behindOf(a.stub)).toEqual({ stored: null, memory: null });
    expect(await pendingCheck(a.stub)).toBeNull();
  });

  it('keeps the marker through a resync soon after a failure, then clears it', async () => {
    await stock('pk2', [O, O]);
    const a = await connect('behind-young-resync', 'pk2');
    const start = await a.grid();
    await unfollow('behind-young-resync');
    await injectFaults(a.stub, { ops: { 1: 'lost' } });
    // Long enough that the next op and its resync come "soon" on any machine (300 ms and then
    // 3 s raced the wall clock); the test ages the failure by hand below.
    await tune(a.stub, { verifyDelay: 60_000 });
    a.sendOp({ opId: 1, op: brickAt(350, 370) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    // The next op shows the gap at once: the resync repairs it, but the failure is too
    // recent to rule out a late commit, so the marker stays, at the seq just sent.
    a.sendOp({ opId: 2, op: brickAt(360, 370) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    const repair = await a.nextDiffs();
    expect(repair.seq).toBe(start.seq + 2);
    expect(await behindOf(a.stub)).toEqual({ stored: start.seq + 2, memory: start.seq + 2 });
    expect(await pendingCheck(a.stub)).not.toBeNull();
    // The check scheduled for when the failure is old enough then clears it.
    await ageFailure(a.stub, 60_000);
    await runCheck(a.stub);
    expect(await behindOf(a.stub)).toEqual({ stored: null, memory: null });
  });

  it('repairs a lost reply from the canvas check, without waiting for another op', async () => {
    await stock('pc', [O]);
    const a = await connect('behind-check', 'pc');
    const start = await a.grid();
    await unfollow('behind-check');
    await injectFaults(a.stub, { ops: { 1: 'lost' } });
    await tune(a.stub, { verifyDelay: 50 });
    a.sendOp({ opId: 1, op: brickAt(720, 700) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    const repair = await a.nextDiffs();
    expect(repair.seq).toBe(start.seq + 1);
    expect(repair.diffs).toHaveLength(4);
    expect(await behindOf(a.stub)).toEqual({ stored: null, memory: null });
  });

  it('repairs a reply lost just before a scheduled check', async () => {
    await stock('pb', [O, O]);
    const a = await connect('behind-late-fail', 'pb');
    const start = await a.grid();
    await unfollow('behind-late-fail');
    await injectFaults(a.stub, { ops: { 1: 'refused', 2: 'lost' } });
    await tune(a.stub, { verifyDelay: 150 });
    a.sendOp({ opId: 1, op: brickAt(730, 710) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    // The check scheduled by the first failure has not run yet when this reply is lost.
    a.sendOp({ opId: 2, op: brickAt(740, 710) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: false, reason: 'unavailable' });
    const repair = await a.nextDiffs();
    expect(repair.seq).toBe(start.seq + 1);
    expect(repair.diffs).toHaveLength(4);
    // Cleared once the second failure is old enough too (a check follows if it was not).
    await markerCleared(a.stub);
  });

  it('asks the canvas again when the check fails, still marked meanwhile', async () => {
    await stock('pr2', [O]);
    const a = await connect('behind-retry', 'pr2');
    const start = await a.grid();
    await unfollow('behind-retry');
    let checks = 0;
    await injectFaults(a.stub, { ops: { 1: 'lost' }, status: () => ++checks === 1 });
    await tune(a.stub, { verifyDelay: 20, alarmRetry: 100 });
    a.sendOp({ opId: 1, op: brickAt(750, 710) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    await until('first check', () => checks === 1);
    expect((await behindOf(a.stub)).stored).toBe(start.seq);
    const repair = await a.nextDiffs();
    expect(checks).toBe(2);
    expect(repair.seq).toBe(start.seq + 1);
    expect(await behindOf(a.stub)).toEqual({ stored: null, memory: null });
  });

  it('checks again when the resync of a check fails', async () => {
    await stock('pt', [O]);
    const a = await connect('behind-resync-fails', 'pt');
    const start = await a.grid();
    await unfollow('behind-resync-fails');
    let snapshots = 0;
    await injectFaults(a.stub, {
      ops: { 1: 'lost' },
      snapshot: (real) => {
        snapshots++;
        if (snapshots === 1) return Promise.reject(new Error('canvas restarting'));
        return real.snapshot();
      },
    });
    await tune(a.stub, { verifyDelay: 20, alarmRetry: 50 });
    a.sendOp({ opId: 1, op: brickAt(370, 370) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    // The first check's resync fails; the next one repairs the lost reply on its own.
    const repair = await a.nextDiffs();
    expect(snapshots).toBe(2);
    expect(repair.seq).toBe(start.seq + 1);
    const canvasSeq = (await CANVAS.get(CANVAS.idFromName('canvas')).status()).seq;
    const mirrorSeq = await runInDurableObject(
      a.stub,
      (instance: unknown) => (instance as { mirror: { seq: number } }).mirror.seq,
    );
    expect(mirrorSeq).toBe(canvasSeq);
  });

  it('keeps the marker when a failure comes while the check awaits the canvas', async () => {
    await stock('pw2', [O, O]);
    const a = await connect('behind-failure-during-check', 'pw2');
    await a.grid();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    await injectFaults(a.stub, {
      ops: { 1: 'refused', 2: 'refused' },
      // The first check waits until released; the second fails, so it schedules no other.
      status: async () => {
        const n = ++checks;
        if (n === 1) await gate;
        return n === 2;
      },
    });
    await tune(a.stub, { verifyDelay: 100, alarmRetry: 60_000 });
    a.sendOp({ opId: 1, op: brickAt(380, 370) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    await until('first check', () => checks === 1);
    // A failure while the first check awaits the canvas.
    a.sendOp({ opId: 2, op: brickAt(390, 370) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: false, reason: 'unavailable' });
    await new Promise((r) => setTimeout(r, 250));
    await until('second check', () => checks === 2);
    // Both failures are now old enough; only the failure count shows one came meanwhile.
    await new Promise((r) => setTimeout(r, 150));
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect((await behindOf(a.stub)).stored).not.toBeNull();
  });

  it('asks the canvas outside the queue: a slow answer holds up no join', async () => {
    await stock('ps', [O]);
    const fanout = FANOUT.get(FANOUT.idFromName('behind-slow'));
    const a = await connect('behind-slow', 'ps');
    await a.grid();
    // The canvas answers only when the test says so: nothing else can free it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = { asked: false };
    await injectFaults(fanout, {
      ops: { 1: 'refused' },
      status: async () => {
        held.asked = true;
        await gate;
        return false;
      },
    });
    await tune(fanout, { verifyDelay: 10 });
    a.sendOp({ opId: 1, op: brickAt(760, 710) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    await until('canvas asked', () => held.asked);
    // While the canvas has not answered (as when it is replaying its log), a socket joins.
    const b = await connect('behind-slow', 'ps2');
    await b.grid();
    release();
  });

  it('never lets older rules replace newer ones', async () => {
    const a = await connect('rules-order', 'po2');
    await a.grid();
    const first = await a.nextConfig();
    const base = { mapSize: first.mapSize, maxShield: first.maxShield };
    const sent = await runInDurableObject(a.stub, (instance: unknown) => {
      const target = instance as {
        adoptRules(rules: unknown): void;
        mirror: { rules: { seq?: number } | null };
      };
      const seq = target.mirror.rules?.seq ?? 0;
      // A newer growth, then a reply read before it (a rejected op answered late).
      target.adoptRules({ ...base, open: { x: 0, y: 0, w: 1024, h: 1024 }, seq: seq + 5 });
      target.adoptRules({ ...base, open: first.open, seq: seq + 1 });
      return target.mirror.rules;
    });
    expect(sent).toMatchObject({ open: { x: 0, y: 0, w: 1024, h: 1024 } });
    expect((await a.nextConfig()).open).toEqual({ x: 0, y: 0, w: 1024, h: 1024 });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.configs).toEqual([]);
  });

  it('moves past a growth its batch set off, so a marker never lags behind it', async () => {
    // A canvas of its own whose open area grows with the first brick.
    const growing = CANVAS.get(CANVAS.idFromName('growing'));
    const stored = await runInDurableObject(growing, (_, state) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'")
        .one(),
    );
    const config = {
      ...JSON.parse(stored.value),
      size: 64,
      open: { x: 24, y: 24, w: 16, h: 16 },
      growth: { atPercent: 1, step: 8 },
    };
    await runInDurableObject(growing, (_, state) => {
      state.storage.sql.exec(
        "UPDATE meta SET value = ? WHERE key = 'config'",
        JSON.stringify(config),
      );
    });
    await evictDurableObject(growing);
    await stock('pgw', [O, O, O], 2 ** 50, 'growing');
    const fanout = FANOUT.get(FANOUT.idFromName('growth-marked'));
    await injectFaults(fanout, { canvas: 'growing', ops: { 1: 'refused' } });
    await tune(fanout, { verifyDelay: Number.POSITIVE_INFINITY });
    const a = await connect('growth-marked', 'pgw');
    expect((await a.grid()).seq).toBe(0);
    expect((await a.nextConfig()).open).toEqual({ x: 24, y: 24, w: 16, h: 16 });
    let closedWith: number | null = null;
    a.closed.then((code) => {
      closedWith = code;
    });

    // Marked by a failure, then a brick that sets off a growth (seq 1, growth row seq 2).
    a.sendOp({ opId: 1, op: brickAt(24, 24) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    a.sendOp({ opId: 2, op: brickAt(24, 24) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    expect((await a.nextDiffs()).seq).toBe(1);
    expect((await a.nextConfig()).open).toEqual({ x: 16, y: 16, w: 32, h: 32 });
    expect((await growing.status()).seq).toBe(2);
    expect(await behindOf(fanout)).toEqual({ stored: 2, memory: 2 });

    // What an eviction now would do: the rebuilt mirror is at seq 2, as the stored marker.
    const snapshot = await growing.snapshot();
    await runInDurableObject(fanout, (instance: unknown) => {
      (instance as { restoreMirror(snapshot: unknown): unknown }).restoreMirror(snapshot);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(closedWith).toBeNull();

    // And the next op follows on without a gap.
    a.sendOp({ opId: 3, op: brickAt(26, 24) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 3, ok: true });
    const next = await a.nextDiffs();
    expect(next.seq).toBe(3);
    expect(next.diffs).toHaveLength(4);
  });

  it('sends the rules after the grid, and again when the open area grows', async () => {
    await stock('pu1', [O]);
    const canvas = CANVAS.get(CANVAS.idFromName('canvas'));
    const before = (await canvas.status()).rules;
    const a = await connect('rules', 'pu1');
    const b = await connect('rules', 'pu2');
    const start = await a.grid();
    await b.grid();
    const first = await a.nextConfig();
    expect(first).toEqual({
      type: 'config',
      mapSize: before.mapSize,
      open: before.open,
      maxShield: before.maxShield,
      // No area is locked (ADR 0024): an empty list, so clients know there are none.
      locks: [],
      // The map is cut into whole tiles: clients may send views (ADR 0028).
      views: true,
    });
    await b.nextConfig();

    // Grown by an admin call: the next op brings the new rules to every socket, and, since
    // the growth took a seq, its cells come with the next tick.
    const grown = { x: 128, y: 128, w: 768, h: 768 };
    expect(await canvas.setOpenArea(grown)).toMatchObject({ ok: true, seq: start.seq + 1 });
    a.sendOp({ opId: 1, op: brickAt(730, 700) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    await pushed('rules');
    expect((await a.nextDiffs()).seq).toBe(start.seq + 2);
    expect((await a.nextConfig()).open).toEqual(grown);
    expect((await b.nextConfig()).open).toEqual(grown);
    expect(a.configs).toEqual([]);

    // A new socket gets the grown area right after its grid.
    const c = await connect('rules', 'pu3');
    await c.grid();
    expect((await c.nextConfig()).open).toEqual(grown);

    // Sockets left open across an eviction get the rules again.
    await evictDurableObject(a.stub);
    a.sendOp({ opId: 2, op: brickAt(740, 700) });
    expect(await a.next()).toMatchObject({ type: 'ack', opId: 2 });
    expect((await a.nextConfig()).open).toEqual(grown);
  });

  it('refuses ops in a locked area and sends the locks at the same seq (ADR 0024)', async () => {
    await stock('pl1', [O, O, O]);
    const canvas = CANVAS.get(CANVAS.idFromName('canvas'));
    const a = await connect('locks', 'pl1');
    await a.grid();
    expect((await a.nextConfig()).locks).toEqual([]);
    const area = { x: 570, y: 300, w: 8, h: 8 };
    const locked = await canvas.lockArea({ area, note: 'raid' });
    expect(locked).toMatchObject({ ok: true });
    // Refused: nothing is logged, the seq stays, but the reply's rules carry the new lock.
    a.sendOp({ opId: 1, op: brickAt(569, 299) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'locked' });
    expect((await a.nextConfig()).locks).toEqual([area]);
    a.sendOp({ opId: 2, op: brickAt(580, 300) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    expect((await a.nextDiffs()).diffs).toHaveLength(4);
    // Unlocked: the next reply brings the empty list.
    await canvas.unlockArea(locked.ok ? locked.lock.id : 0);
    a.sendOp({ opId: 3, op: brickAt(570, 300) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 3, ok: true });
    expect((await a.nextConfig()).locks).toEqual([]);
  });

  it('passes on busy from a canvas that sheds moves, nothing applied (ADR 0032)', async () => {
    await stock('pb1', [O, O]);
    const canvas = CANVAS.get(CANVAS.idFromName('canvas'));
    const a = await connect('busy', 'pb1');
    await a.grid();
    // The socket's first hold read is done, so nothing else of this test is in the queue.
    await a.nextHold();
    // As if 256 more calls waited in the canvas's queue (real ones are tested in the game).
    // Added and taken back, never set: another call may be in the queue meanwhile.
    const backlog = (change: number) =>
      runInDurableObject(canvas, (instance: unknown) => {
        (instance as { queued: number }).queued += change;
      });
    await backlog(256);
    try {
      a.sendOp({ opId: 1, op: brickAt(590, 330) });
      expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'busy' });
      a.sendDiscard({ opId: 2, discard: O });
      expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: false, reason: 'busy' });
    } finally {
      await backlog(-256);
    }
    // The items stayed in the hold: the same move works once the canvas has caught up.
    a.sendOp({ opId: 1, op: brickAt(590, 330) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await a.nextDiffs()).diffs).toHaveLength(4);
  });

  it('refresh brings sockets a rollback and lock changes without waiting for an op', async () => {
    await stock('pr1', [O]);
    const canvas = CANVAS.get(CANVAS.idFromName('canvas'));
    const fanout = FANOUT.get(FANOUT.idFromName('refresh'));
    expect(await fanout.refresh()).toEqual({ seq: null });
    const a = await connect('refresh', 'pr1');
    await a.grid();
    await a.nextConfig();
    a.sendOp({ opId: 1, op: brickAt(620, 350) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await a.nextDiffs()).diffs).toHaveLength(4);
    // Rolled back on the canvas: no op follows, the refresh sends the emptied cells.
    // The preview replays the shared canvas's whole log: seconds on a loaded CI runner.
    const deadline = Date.now() + 4 * WAIT_MS;
    let status = await canvas.rollbackPreview({ player: 'pr1' });
    while (status.state === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await canvas.rollbackPreview({ player: 'pr1' });
    }
    if (status.state !== 'ready') throw new Error(JSON.stringify(status));
    expect(await canvas.rollbackApply(status.preview.job)).toMatchObject({ ok: true });
    const { seq } = await fanout.refresh();
    const diffs = await a.nextDiffs();
    expect(diffs.seq).toBe(seq);
    expect(diffs.diffs.map((d) => d.cell)).toEqual([0, 0, 0, 0]);
    // A lock, then its end, each sent by a refresh.
    const area = { x: 620, y: 350, w: 2, h: 2 };
    const locked = await canvas.lockArea({ area });
    await fanout.refresh();
    expect((await a.nextConfig()).locks).toEqual([area]);
    await canvas.unlockArea(locked.ok ? locked.lock.id : 0);
    await fanout.refresh();
    expect((await a.nextConfig()).locks).toEqual([]);
  }, 60_000);

  it('lets only a few initial grids out at once and turns joiners away past the queue', async () => {
    const fanout = FANOUT.get(FANOUT.idFromName('grid-gate'));
    // One place, no queue, and timers that never fire: the first grid keeps its place.
    const never = { set: () => null, clear: () => {} };
    await tune(fanout, { gridGate: new SendGate(1, 0, 1, 1000, never) });
    const a = await connect('grid-gate', 'pg1');
    const grid = await a.grid();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = await fanout.fetch('https://fanout/ws', {
      headers: { Upgrade: 'websocket', [PLAYER_HEADER]: 'pg2' },
    });
    expect(refused.status).toBe(503);
    expect(refused.headers.get('Retry-After')).toBe('5');
    // ...and says so in the logs (docs/ops/alerts.md), without the player.
    const events = warn.mock.calls.map(([line]) => line);
    warn.mockRestore();
    expect(events).toEqual([
      { event: 'fanout_join_refused', canvas: 'canvas', active: 1, waiting: 0, suppressed: 0 },
    ]);

    // With a queue, the next joiner waits for the place instead: the drain rate is set so
    // one grid (one frame here) holds it for about 400 ms.
    const bytes = 8 + 6 * grid.diffs.length;
    await tune(fanout, { gridGate: new SendGate(1, 4, bytes / 400, 5000) });
    // Timed from before pg3 joins: its 400 ms hold starts before its 101 comes back, so a
    // slow reply would eat into a wait timed from after it.
    const started = Date.now();
    await connect('grid-gate', 'pg3');
    const c = await connect('grid-gate', 'pg4');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect((await c.grid()).seq).toBe(grid.seq);

    // A joiner whose wait runs out gets a 503 instead of waiting on.
    // pg5's grid holds the place for 10 s (the longest hold), far past pg6's 200 ms wait.
    await tune(fanout, { gridGate: new SendGate(1, 4, bytes / 10_000, 200) });
    await connect('grid-gate', 'pg5');
    const waited = Date.now();
    const gaveUp = await fanout.fetch('https://fanout/ws', {
      headers: { Upgrade: 'websocket', [PLAYER_HEADER]: 'pg6' },
    });
    expect(gaveUp.status).toBe(503);
    expect(Date.now() - waited).toBeGreaterThanOrEqual(150);
  });

  it('logs fanout_canvas_call_failed with the call and no player when the canvas fails an op', async () => {
    await stock('pcf', [O]);
    const a = await connect('call-failed', 'pcf');
    await a.grid();
    await injectFaults(a.stub, { ops: { 1: 'refused' } });
    await tune(a.stub, { verifyDelay: Number.POSITIVE_INFINITY });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      a.sendOp({ opId: 1, op: brickAt(670, 400) });
      expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        {
          event: 'fanout_canvas_call_failed',
          canvas: 'canvas',
          call: 'applyBatch',
          overloaded: false,
          suppressed: 0,
        },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs fanout_sockets_high once its sockets near the per-object limit, counting now and then', async () => {
    const fanout = FANOUT.get(FANOUT.idFromName('socket-count'));
    // The real mark is 80% of 32,768; two sockets stand in for it here.
    await tune(fanout, { socketsWarnAt: 2 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const high = () =>
      warn.mock.calls.map(([line]) => line).filter((l) => l?.event === 'fanout_sockets_high');
    try {
      await connect('socket-count', 'ps1');
      expect(high()).toEqual([]);
      // Counted at most every 10 s: the second join is not counted yet.
      await connect('socket-count', 'ps2');
      expect(high()).toEqual([]);
      await tune(fanout, { socketsCountedAt: Number.NEGATIVE_INFINITY });
      await connect('socket-count', null);
      expect(high()).toEqual([
        { event: 'fanout_sockets_high', canvas: 'canvas', sockets: 3, warnAt: 2, suppressed: 0 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('splits an accepted op with more diffs than one frame holds, under one seq', async () => {
    await stock('pv', [O]);
    await stock('pw', [HAMMER]);
    const a = await connect('expiry', 'pv');
    const start = await a.grid();
    // As when the first op after a quiet spell also carries one expiry diff per shielded
    // cell: the real op's diffs plus 70,000 more (rows 900 on, far from every other test's
    // cells and outside any open area here).
    const extra = Array.from({ length: 70_000 }, (_, i) => ({
      index: 900 * 1024 + i,
      cell: 0x80 | (i % 32),
      shield: 0,
    }));
    await injectFaults(a.stub, {
      batch: (real) => ({
        ...real,
        results: real.results.map((r) => (r.ok ? { ...r, diffs: [...r.diffs, ...extra] } : r)),
      }),
    });
    a.sendOp({ opId: 1, op: brickAt(360, 260) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    const first = await a.nextDiffs();
    const second = await a.nextDiffs();
    expect([first.seq, second.seq]).toEqual([start.seq + 1, start.seq + 1]);
    expect(first.diffs).toHaveLength(MAX_DIFFS_PER_FRAME);
    expect(first.diffs.length + second.diffs.length).toBe(4 + extra.length);

    // The mirror took every diff: a new socket's grid holds the last one, then the live stream.
    const b = await connect('expiry', 'pw');
    b.sendOp({ opId: 1, op: { kind: 'hammer', x: 700, y: 300 } });
    const grid: Diffs[] = [];
    for (let m = await b.next(); m.type === 'diffs'; m = await b.next()) grid.push(m);
    expect(grid.every((f) => f.seq === start.seq + 1)).toBe(true);
    expect(grid.flatMap((f) => f.diffs)).toContainEqual(extra.at(-1));
  });

  it('sends the hold on connect and after each op', async () => {
    await stock('ph', [O, HAMMER], Date.now());
    const a = await connect('holds', 'ph');
    await a.grid();
    const first = await a.nextHold();
    expect(first).toMatchObject({ capacity: 3, cooldown: COOLDOWN, items: [O, HAMMER] });
    expect(first.nextIn).toBeGreaterThan(COOLDOWN - 10_000);
    expect(first.nextIn).toBeLessThanOrEqual(COOLDOWN);

    a.sendOp({ opId: 1, op: brickAt(380, 260) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await a.nextHold()).items).toEqual([HAMMER]);
    await a.nextDiffs();

    // Rejected by the core: the hammer is refunded.
    a.sendOp({ opId: 2, op: { kind: 'hammer', x: 480, y: 560 } });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: false, reason: 'empty' });
    expect((await a.nextHold()).items).toEqual([HAMMER]);
    // No shield held.
    a.sendOp({ opId: 3, op: { kind: 'shield', x: 380, y: 260 } });
    expect(await a.next()).toEqual({ type: 'ack', opId: 3, ok: false, reason: 'no_item' });
    expect((await a.nextHold()).items).toEqual([HAMMER]);
  });

  it('discards a held item through the socket, once per opId', async () => {
    await stock('pd', [SHIELD, SHIELD, HAMMER], 0);
    const a = await connect('discard', 'pd');
    await a.grid();
    expect(await a.nextHold()).toMatchObject({ nextIn: null, items: [SHIELD, SHIELD, HAMMER] });
    a.sendDiscard({ opId: 1, discard: SHIELD });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    const after = await a.nextHold();
    expect(after.items).toEqual([SHIELD, HAMMER]);
    expect(after.nextIn).toBeGreaterThan(COOLDOWN - 10_000);
    a.sendDiscard({ opId: 1, discard: SHIELD });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await a.nextHold()).items).toEqual([SHIELD, HAMMER]);
    a.sendDiscard({ opId: 2, discard: O });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: false, reason: 'no_item' });
  });

  it('retries the first hold from the alarm when the canvas cannot answer', async () => {
    await stock('pk', [SHIELD], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('hold-retry'));
    let calls = 0;
    await injectFaults(fanout, { holds: () => ++calls === 1 });
    const a = await connect('hold-retry', 'pk');
    await a.grid();
    // The first call failed; the alarm asks again about half a second later.
    const hold = await a.nextHold();
    expect(hold.items).toEqual([SHIELD]);
    expect(calls).toBe(2);
  });

  it('lets the alarm retry on its own after the canvas fails again', async () => {
    await stock('pa2', [HAMMER], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('alarm-retry'));
    let calls = 0;
    await injectFaults(fanout, { holds: () => ++calls <= 2 });
    await runInDurableObject(fanout, (instance: unknown) => {
      (instance as { alarmRetry: number }).alarmRetry = 100;
    });
    const a = await connect('alarm-retry', 'pa2');
    await a.grid();
    // 1st call (first hold) and 2nd (the alarm) fail; the alarm's own retry delivers.
    expect((await a.nextHold()).items).toEqual([HAMMER]);
    expect(calls).toBe(3);
  });

  it('never sends a hold older than the one a socket already has', async () => {
    await stock('po', [O], Date.now());
    const a = await connect('hold-order', 'po');
    await a.grid();
    const first = await a.nextHold();
    const base = { capacity: 3, cooldown: COOLDOWN, nextAt: null };
    await runInDurableObject(a.stub, (instance: unknown) => {
      const fanout = instance as {
        deliverHold(player: string, hold: unknown): void;
        queueFirstHold(player: string, ws: WebSocket): void;
        ctx: DurableObjectState;
      };
      const newer = first.revision + 10;
      fanout.deliverHold('po', { ...base, items: [O, HAMMER], revision: newer });
      fanout.deliverHold('po', { ...base, items: [], revision: newer - 1 });
      // A late first-hold reply (the canvas's real, lower revision) is skipped too.
      fanout.queueFirstHold('po', fanout.ctx.getWebSockets('po')[0]!);
    });
    expect((await a.nextHold()).items).toEqual([O, HAMMER]);
    await expect(a.nextHold(500)).rejects.toThrow('no hold');
  });

  it('gathers sockets joining during a first-hold call into the next call', async () => {
    await stock('qa1', [O], Date.now());
    await stock('qa2', [HAMMER], Date.now());
    await stock('qa3', [SHIELD], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('hold-inflight'));
    let calls = 0;
    const gate = holdsGate();
    await injectFaults(fanout, {
      holds: () => {
        calls++;
        return false;
      },
      holdsGate: gate.wait,
    });
    const a = await connect('hold-inflight', 'qa1');
    await until('first call under way', () => gate.entered === 1);
    // Both join while the first call is still under way.
    const b = await connect('hold-inflight', 'qa2');
    const c = await connect('hold-inflight', 'qa3');
    gate.release();
    expect((await a.nextHold()).items).toEqual([O]);
    expect((await b.nextHold()).items).toEqual([HAMMER]);
    expect((await c.nextHold()).items).toEqual([SHIELD]);
    await expect(a.nextHold(500)).rejects.toThrow('no hold');
    expect(calls).toBe(2);
  });

  it('still sends first holds after one that cannot be encoded', async () => {
    await stock('qs1', [O], Date.now());
    await stock('qs2', [HAMMER], Date.now());
    await stock('qs3', [SHIELD], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('hold-bogus'));
    const gate = holdsGate();
    await injectFaults(fanout, {
      holdsGate: gate.wait,
      // qs1 gets an item kind this build does not know (as from a newer game script).
      holdsResult: (real) => {
        const bogus = [{ kind: 'bogus' }] as unknown as HoldView['items'];
        return new Map(
          [...real].map(([player, hold]) => [
            player,
            player === 'qs1' ? { ...hold, items: bogus } : hold,
          ]),
        );
      },
    });
    const a = await connect('hold-bogus', 'qs1');
    await until('bad call under way', () => gate.entered === 1);
    // Joins while the bad call is under way, so it waits for the next one.
    const b = await connect('hold-bogus', 'qs2');
    gate.release();
    expect((await b.nextHold()).items).toEqual([HAMMER]);
    await expect(a.nextHold(300)).rejects.toThrow('no hold');
    // Two players in one call, the bad one first: the other still gets its hold.
    const d = await connect('hold-bogus', 'qs3');
    expect((await d.nextHold()).items).toEqual([SHIELD]);
    await runInDurableObject(fanout, (instance: unknown) => {
      const target = instance as {
        queueFirstHold(player: string, ws: WebSocket): void;
        ctx: DurableObjectState;
      };
      target.queueFirstHold('qs1', target.ctx.getWebSockets('qs1')[0]!);
      target.queueFirstHold('qs3', target.ctx.getWebSockets('qs3')[0]!);
    });
    expect((await d.nextHold()).items).toEqual([SHIELD]);
  });

  it('keeps acks and diffs flowing when an op brings a hold it cannot encode', async () => {
    await stock('rx1', [O, O], Date.now());
    const a = await connect('op-bogus', 'rx1');
    const b = await connect('op-bogus', 'rx2');
    const start = await a.grid();
    await b.grid();
    await a.nextHold();
    await injectFaults(a.stub, {
      batch: (real) => ({ ...real, holds: withBogus(real.holds) }),
    });
    a.sendOp({ opId: 1, op: brickAt(480, 560) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await b.nextDiffs()).seq).toBe(start.seq + 1);
    await a.nextDiffs();
    a.sendOp({ opId: 2, op: brickAt(490, 560) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    expect((await b.nextDiffs()).seq).toBe(start.seq + 2);
    await expect(a.nextHold(300)).rejects.toThrow('no hold');
  });

  it('does not ask the canvas again and again for a due hold it cannot encode', async () => {
    await stock('rl', [O], Date.now());
    const a = await connect('alarm-bogus', 'rl');
    await a.grid();
    await a.nextHold();
    let calls = 0;
    await injectFaults(a.stub, {
      holdsResult: (real) => {
        calls++;
        return withBogus(real);
      },
    });
    // Make the socket's next item due now and wake the alarm.
    await runInDurableObject(a.stub, async (instance: unknown) => {
      const { ctx } = instance as { ctx: DurableObjectState };
      const ws = ctx.getWebSockets('rl')[0]!;
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as object), nextAt: Date.now() });
      await ctx.storage.setAlarm(Date.now());
    });
    await until('the alarm asked', () => calls >= 1);
    // One call; the stored next-item time then follows the canvas (a minute away), so a
    // while later there is still only that one.
    await new Promise((r) => setTimeout(r, 2000));
    expect(calls).toBe(1);
    await expect(a.nextHold(100)).rejects.toThrow('no hold');
  });

  it('keeps sending first holds after a call that throws', async () => {
    await stock('qt1', [O], Date.now());
    await stock('qt2', [HAMMER], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('hold-throws'));
    const gate = holdsGate();
    await injectFaults(fanout, { holdsGate: gate.wait });
    // The first call throws after its holds went out (outside the per-player guard).
    await runInDurableObject(fanout, (instance: unknown) => {
      const target = instance as { ensureAlarm(nextAt: number | null): Promise<void> };
      const real = target.ensureAlarm.bind(target);
      let thrown = false;
      target.ensureAlarm = async (nextAt) => {
        if (thrown) return real(nextAt);
        thrown = true;
        throw new Error('storage hiccup');
      };
    });
    const a = await connect('hold-throws', 'qt1');
    await until('first call under way', () => gate.entered === 1);
    // Joins while that call is under way, so only a restart of the loop serves it.
    const b = await connect('hold-throws', 'qt2');
    gate.release();
    expect((await a.nextHold()).items).toEqual([O]);
    expect((await b.nextHold()).items).toEqual([HAMMER]);
  });

  it("one player's broken reply does not cost later joiners theirs", async () => {
    await stock('qb1', [O], Date.now());
    await stock('qb2', [HAMMER], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('hold-broken'));
    let calls = 0;
    const gate = holdsGate();
    await injectFaults(fanout, {
      holdsGate: gate.wait,
      // The first reply cannot even be read.
      holdsResult: (real) => {
        calls++;
        if (calls > 1) return real;
        return {
          get: () => {
            throw new Error('broken reply');
          },
        } as unknown as typeof real;
      },
    });
    const a = await connect('hold-broken', 'qb1');
    await until('first call under way', () => gate.entered === 1);
    const b = await connect('hold-broken', 'qb2');
    gate.release();
    expect((await b.nextHold()).items).toEqual([HAMMER]);
    // The player with the broken reply is due now, so the alarm asks again for them.
    expect((await a.nextHold()).items).toEqual([O]);
  });

  it('records an unencodable first hold on the socket', async () => {
    await stock('qe', [O], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('hold-unencodable'));
    await injectFaults(fanout, { holdsResult: withBogus });
    const a = await connect('hold-unencodable', 'qe');
    await a.grid();
    // The first-hold call records it once it returns.
    let stored = await attachmentOf(fanout, 'qe');
    for (let tries = 0; typeof stored.nextAt !== 'number' && tries * 20 < WAIT_MS; tries++) {
      await new Promise((r) => setTimeout(r, 20));
      stored = await attachmentOf(fanout, 'qe');
    }
    // Nothing is sent, but the socket knows the canvas's next-item time and revision.
    const real = (await CANVAS.get(CANVAS.idFromName('canvas')).holds(['qe'])).get('qe')!;
    expect(typeof stored.nextAt).toBe('number');
    expect(stored).toMatchObject({ nextAt: real.nextAt, revision: real.revision });
    await expect(a.nextHold(100)).rejects.toThrow('no hold');
  });

  it('never stores a next-item time that is not a number', async () => {
    const a = await connect('hold-nan', 'qn');
    await a.grid();
    await a.nextHold();
    await runInDurableObject(a.stub, (instance: unknown) => {
      (instance as { deliverHold(player: string, hold: unknown): void }).deliverHold('qn', {
        capacity: 3,
        cooldown: COOLDOWN,
        nextAt: Number.NaN,
        revision: 1000,
        items: [],
      });
    });
    expect((await attachmentOf(a.stub, 'qn')).nextAt).toBeNull();
  });

  it('still sets the alarm when one socket holds a next-item time that is not a number', async () => {
    const a = await connect('alarm-nan', 'qm1');
    const b = await connect('alarm-nan', 'qm2');
    await a.grid();
    await b.grid();
    const later = Date.now() + 100_000;
    const alarm = await runInDurableObject(a.stub, async (instance: unknown) => {
      const target = instance as { ctx: DurableObjectState; alarm(): Promise<void> };
      const { ctx } = target;
      const [wa] = ctx.getWebSockets('qm1');
      const [wb] = ctx.getWebSockets('qm2');
      wa!.serializeAttachment({ player: 'qm1', nextAt: Number.NaN });
      wb!.serializeAttachment({ player: 'qm2', nextAt: later });
      await ctx.storage.deleteAlarm();
      await target.alarm();
      return ctx.storage.getAlarm();
    });
    expect(alarm).toBe(later);
  });

  it('fires soon instead of an alarm long overdue, and leaves one just due', async () => {
    // An alarm whose handler threw through all its retries still reads back from getAlarm(),
    // in the past, and never fires (staging, 27-28 October 2026). One a few seconds overdue
    // is about to be delivered. workerd stores a past alarm as now, so the storage here is a
    // stand-in that returns the time it was given. The lost one is replaced by one a second
    // out, not by this caller's far later time: other sockets' due holds wait on it.
    const stub = FANOUT.get(FANOUT.idFromName('lost-alarm'));
    const [lost, due] = await runInDurableObject(stub, async (instance: unknown) => {
      const { ensureAlarm } = instance as { ensureAlarm(nextAt: number | null): Promise<void> };
      const after = async (stored: number) => {
        let set: number | null = stored;
        const storage = {
          getAlarm: async () => set,
          setAlarm: async (at: number) => {
            set = at;
          },
        };
        const before = Date.now();
        await ensureAlarm.call({ ctx: { storage } }, before + 100_000);
        return { stored, before, after: Date.now(), set };
      };
      return [await after(Date.now() - 10 * 60_000), await after(Date.now() - 5_000)];
    });
    expect(lost!.set).toBeGreaterThanOrEqual(lost!.before + 1_000);
    expect(lost!.set).toBeLessThanOrEqual(lost!.after + 1_000);
    expect(due!.set).toBe(due!.stored);
  });

  it('still sets the alarm when one first hold has a next-item time that is not a number', async () => {
    await stock('qf1', [O], Date.now());
    await stock('qf2', [HAMMER], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('first-nan'));
    await injectFaults(fanout, {
      holdsResult: (real) =>
        new Map(
          [...real].map(([player, hold]) => [
            player,
            player === 'qf1' ? { ...hold, nextAt: Number.NaN } : hold,
          ]),
        ),
    });
    await connect('first-nan', 'qf1');
    const b = await connect('first-nan', 'qf2');
    // qf1's hold cannot even be encoded (NaN delay); qf2's arrives.
    await b.nextHold();
    // Both again in one batch, the odd one first, with no alarm set yet.
    await runInDurableObject(fanout, async (instance: unknown) => {
      const target = instance as {
        ctx: DurableObjectState;
        queueFirstHold(player: string, ws: WebSocket): void;
      };
      await target.ctx.storage.deleteAlarm();
      target.queueFirstHold('qf1', target.ctx.getWebSockets('qf1')[0]!);
      target.queueFirstHold('qf2', target.ctx.getWebSockets('qf2')[0]!);
    });
    await b.nextHold();
    // ensureAlarm writes it just after the holds go out.
    const alarm = () =>
      runInDurableObject(fanout, (_: unknown, state: DurableObjectState) =>
        state.storage.getAlarm(),
      );
    let set = await alarm();
    for (let tries = 0; typeof set !== 'number' && tries * 20 < WAIT_MS; tries++) {
      await new Promise((r) => setTimeout(r, 20));
      set = await alarm();
    }
    expect(typeof set).toBe('number');
  });

  it('keeps the revision of a socket whose first hold failed', async () => {
    await stock('qr', [O], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('hold-keep-rev'));
    let calls = 0;
    await injectFaults(fanout, { holds: () => ++calls === 1, holdsDelay: 200 });
    const a = await connect('hold-keep-rev', 'qr');
    await a.grid();
    const base = { capacity: 3, cooldown: COOLDOWN, nextAt: null };
    // A newer hold reaches the socket while its first-hold call is failing.
    await runInDurableObject(fanout, (instance: unknown) => {
      (instance as { deliverHold(player: string, hold: unknown): void }).deliverHold('qr', {
        ...base,
        items: [O, HAMMER],
        revision: 50,
      });
    });
    expect((await a.nextHold()).items).toEqual([O, HAMMER]);
    await until('first hold failed', () => calls >= 1);
    await new Promise((r) => setTimeout(r, 300));
    await runInDurableObject(fanout, (instance: unknown) => {
      (instance as { deliverHold(player: string, hold: unknown): void }).deliverHold('qr', {
        ...base,
        items: [],
        revision: 49,
      });
    });
    await expect(a.nextHold(300)).rejects.toThrow('no hold');
  });

  it('acks a reject reason it cannot encode as unavailable, never as ok', async () => {
    await stock('qu', [O]);
    const a = await connect('ack-fallback', 'qu');
    await a.grid();
    await injectFaults(a.stub, {
      batch: (real) => ({
        ...real,
        results: [{ ok: false, reason: 'from_a_newer_build' as 'invalid' }],
      }),
    });
    a.sendOp({ opId: 1, op: brickAt(400, 260) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
  });

  it('sends first holds to sockets joining together in one canvas call', async () => {
    await stock('pj1', [O], Date.now());
    await stock('pj2', [HAMMER], Date.now());
    const fanout = FANOUT.get(FANOUT.idFromName('hold-batch'));
    let calls = 0;
    await injectFaults(fanout, {
      holds: () => {
        calls++;
        return false;
      },
    });
    // "Together" made exact: the loop is held off until both sockets are queued, as a timer
    // of 0 ms would on a machine fast enough (a loaded CI runner was not).
    type Loop = { fetchingFirstHolds: boolean; fetchFirstHolds(): void };
    await runInDurableObject(fanout, (instance: unknown) => {
      (instance as Loop).fetchingFirstHolds = true;
    });
    const [a, b] = await Promise.all([connect('hold-batch', 'pj1'), connect('hold-batch', 'pj2')]);
    await runInDurableObject(fanout, (instance: unknown) => {
      (instance as Loop).fetchFirstHolds();
    });
    expect((await a.nextHold()).items).toEqual([O]);
    expect((await b.nextHold()).items).toEqual([HAMMER]);
    expect(calls).toBe(1);
  });

  it('pushes the next item when its cooldown ends', async () => {
    // Due in an hour: empty when the page joins, however slow the machine.
    const scheduled = Date.now() + 60 * 60_000;
    await stock('pn', [], scheduled - COOLDOWN);
    const a = await connect('refill', 'pn');
    await a.grid();
    const empty = await a.nextHold();
    expect(empty.items).toEqual([]);
    expect(empty.nextIn).toBeGreaterThan(50 * 60_000);
    // No op, no request: the FanoutDO alarm asks the canvas once the item is due (here 10 s
    // ago, so the one after it is a cooldown from then).
    await cooldownEnds('refill', 'pn', scheduled);
    const refilled = await a.nextHold();
    expect(refilled.items).toHaveLength(1);
    expect(refilled.nextIn).toBeGreaterThan(COOLDOWN - 20_000);
    expect(refilled.nextIn).toBeLessThanOrEqual(COOLDOWN - 10_000);
  });

  it('writes grid frames that the protocol decoder reads back', () => {
    const size = MAX_DIFFS_PER_FRAME * 2 + 3;
    const cells = new Uint8Array(size);
    const shields = new Uint8Array(size);
    for (let i = 0; i < size; i += 2) cells[i] = 0x80 | (i % 32);
    shields[4] = 2;
    const frames = cellFrames({ seq: 7, cells, shields }, (i) => cells[i] !== 0);
    const decoded = frames.map(decodeServerMessage) as Diffs[];
    expect(decoded.map((f) => f.seq)).toEqual([7, 7]);
    const diffs = decoded.flatMap((f) => f.diffs);
    expect(decoded[0]!.diffs).toHaveLength(MAX_DIFFS_PER_FRAME);
    expect(diffs).toHaveLength(Math.ceil(size / 2));
    expect(diffs[2]).toEqual({ index: 4, cell: 0x84, shield: 2 });
    expect(diffs.at(-1)).toEqual({ index: size - 1, cell: cells[size - 1], shield: 0 });
    const empty = cellFrames({ seq: 3, cells, shields }, () => false).map(decodeServerMessage);
    expect(empty).toEqual([{ type: 'diffs', seq: 3, diffs: [] }]);
    expect(() => cellFrames({ seq: 2 ** 32, cells, shields }, () => false)).toThrow(ProtocolError);
  });

  it('splits large diff batches into frames of MAX_DIFFS_PER_FRAME', () => {
    const diffs = Array.from({ length: MAX_DIFFS_PER_FRAME * 2 + 1 }, (_, index) => ({
      index,
      cell: 0x80,
      shield: 0,
    }));
    const frames = diffFrames(9, diffs).map(decodeServerMessage) as Diffs[];
    expect(frames.map((f) => [f.seq, f.diffs.length])).toEqual([
      [9, MAX_DIFFS_PER_FRAME],
      [9, MAX_DIFFS_PER_FRAME],
      [9, 1],
    ]);
    expect(diffFrames(9, [])).toHaveLength(1);
  });
});

describe('rules order (ADR 0024)', () => {
  const open = { x: 256, y: 256, w: 512, h: 512 };
  const rules = (seq: number, locksRev: number, locks = [open]) => ({
    mapSize: 1024,
    open,
    maxShield: 5,
    seq,
    locksRev,
    locks,
  });

  it('takes a newer seq whatever its lock revision, and the newest revision at one seq', () => {
    expect(olderRules(rules(4, 9), rules(5, 0))).toBe(true);
    expect(olderRules(rules(6, 0), rules(5, 9))).toBe(false);
    expect(olderRules(rules(5, 1), rules(5, 2))).toBe(true);
    expect(olderRules(rules(5, 2), rules(5, 2))).toBe(false);
    expect(olderRules(rules(5, 3), rules(5, 2))).toBe(false);
    // Canvases from before locks send neither.
    expect(olderRules({ ...rules(5, 0), locksRev: undefined }, rules(5, 0))).toBe(false);
  });

  it('tells lock lists apart, and a list from no list', () => {
    expect(sameRules(rules(1, 1), rules(2, 2))).toBe(true);
    expect(sameRules(rules(1, 1), rules(1, 1, []))).toBe(false);
    expect(sameRules(rules(1, 1), rules(1, 1, [{ ...open, w: 1 }]))).toBe(false);
    expect(sameRules(rules(1, 1, []), { ...rules(1, 1), locks: undefined })).toBe(false);
  });
});

// Every number in these policies is made up for the tests; the real ones live in KV.
describe('abuse limits (ADR 0026)', () => {
  /** Gives this FanoutDO a policy as if just read from KV. */
  async function withPolicy(fanout: string, policy: AbusePolicy) {
    await tune(FANOUT.get(FANOUT.idFromName(fanout)), {
      policy,
      policyLoaded: true,
      policyAt: Date.now(),
    });
  }

  /** The next ack on a socket, past any diff frames. */
  async function ackOf(socket: Awaited<ReturnType<typeof connect>>) {
    let message = await socket.next();
    while (message.type !== 'ack') message = await socket.next();
    return message;
  }

  /** Opens a socket and returns the HTTP status (101 when it opened). */
  async function open(fanout: string, headers: Record<string, string>) {
    const response = await FANOUT.get(FANOUT.idFromName(fanout)).fetch('https://fanout/ws', {
      headers: { Upgrade: 'websocket', ...headers },
    });
    if (response.webSocket) {
      response.webSocket.accept();
      response.webSocket.close();
    }
    return { status: response.status, retryAfter: response.headers.get('Retry-After') };
  }

  it('refuses socket opens past the account and the address limits with a 429', async () => {
    await withPolicy('opens', {
      opens: {
        account: { limit: 2, windowMs: 60_000 },
        address: { limit: 3, windowMs: 60_000 },
      },
    });
    const as = (player: string | null, address: string) => ({
      ...(player ? { [PLAYER_HEADER]: player } : { [WATCH_HEADER]: '1' }),
      [ADDRESS_HEADER]: address,
    });
    expect((await open('opens', as('po-1', 'a1'))).status).toBe(101);
    expect((await open('opens', as('po-1', 'a2'))).status).toBe(101);
    // The account's third open in the window, from anywhere.
    expect(await open('opens', as('po-1', 'a3'))).toEqual({ status: 429, retryAfter: '10' });
    // a1 has one open; two more from other accounts or watchers, then it is full.
    expect((await open('opens', as('po-2', 'a1'))).status).toBe(101);
    expect((await open('opens', as(null, 'a1'))).status).toBe(101);
    expect((await open('opens', as('po-3', 'a1'))).status).toBe(429);
    expect((await open('opens', as(null, 'a1'))).status).toBe(429);
    // Other addresses and accounts are not touched; no address header, no address limit.
    expect((await open('opens', as('po-3', 'a4'))).status).toBe(101);
    expect((await open('opens', { [PLAYER_HEADER]: 'po-4' })).status).toBe(101);
  });

  it('counts IPv6 opens per /48 too, so a fresh /64 each time does not get around it', async () => {
    await withPolicy('opens-v6', {
      opens: {
        address: { limit: 5, windowMs: 60_000 },
        network: { limit: 2, windowMs: 60_000 },
      },
    });
    const from = (n: number) => ({
      [WATCH_HEADER]: '1',
      [ADDRESS_HEADER]: `2001:db8:1:${n}::/64`,
      [NETWORK_HEADER]: '2001:db8:1::/48',
    });
    expect((await open('opens-v6', from(1))).status).toBe(101);
    expect((await open('opens-v6', from(2))).status).toBe(101);
    expect((await open('opens-v6', from(3))).status).toBe(429);
    expect(
      (
        await open('opens-v6', {
          [WATCH_HEADER]: '1',
          [ADDRESS_HEADER]: '2001:db8:2:1::/64',
          [NETWORK_HEADER]: '2001:db8:2::/48',
        })
      ).status,
    ).toBe(101);
  });

  it('refuses ops past the account rate with unavailable, before the canvas', async () => {
    await stock('p-rate', [O, O, O]);
    await withPolicy('op-rate', { ops: { account: { limit: 2, windowMs: 60_000 } } });
    const a = await connect('op-rate', 'p-rate');
    await a.grid();
    a.sendOp({ opId: 1, op: brickAt(280, 500) });
    expect(await ackOf(a)).toEqual({ type: 'ack', opId: 1, ok: true });
    a.sendDiscard({ opId: 2, discard: O });
    expect(await ackOf(a)).toEqual({ type: 'ack', opId: 2, ok: true });
    a.sendOp({ opId: 3, op: brickAt(290, 500) });
    expect(await ackOf(a)).toEqual({ type: 'ack', opId: 3, ok: false, reason: 'unavailable' });
    // Nothing was spent on the refused op: the third brick is still held.
    const hold = await CANVAS.get(CANVAS.idFromName('canvas')).holds(['p-rate']);
    expect(hold.get('p-rate')!.items).toEqual([O]);
    a.ws.close();
  });

  it('answers unavailable past the ops in flight per account, with or without a policy', async () => {
    await stock('p-flight', [O]);
    const a = await connect('in-flight', 'p-flight');
    await a.grid();
    const fanout = FANOUT.get(FANOUT.idFromName('in-flight'));
    await runInDurableObject(fanout, (instance: unknown) => {
      (instance as { inFlight: Map<string, number> }).inFlight.set('p-flight', MAX_IN_FLIGHT);
    });
    a.sendOp({ opId: 1, op: brickAt(300, 500) });
    expect(await ackOf(a)).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    await runInDurableObject(fanout, (instance: unknown) => {
      (instance as { inFlight: Map<string, number> }).inFlight.delete('p-flight');
    });
    a.sendOp({ opId: 1, op: brickAt(300, 500) });
    expect(await ackOf(a)).toEqual({ type: 'ack', opId: 1, ok: true });
    // Every op that ended took its count with it.
    const left = await runInDurableObject(
      fanout,
      (instance: unknown) => (instance as { inFlight: Map<string, number> }).inFlight.size,
    );
    expect(left).toBe(0);
    a.ws.close();
  });

  it('limits hammers and shields by the trust score, keeping the item (limited)', async () => {
    const trust = { unscored: 50, windowMs: 3_600_000, tiers: [{ below: 30, uses: 1 }] };
    await withPolicy('trust', { trust });
    await stock('p-low', [O, SHIELD, SHIELD]);
    await stock('p-high', [O, SHIELD, SHIELD]);
    await stock('p-none', [O, SHIELD, SHIELD]);
    const as = (score: string | null): Record<string, string> =>
      score === null ? {} : { [TRUST_HEADER]: score };
    for (const [player, score, x] of [
      ['p-low', '10', 340],
      ['p-high', '90', 360],
      ['p-none', null, 380],
    ] as const) {
      const page = await connect(
        'trust',
        player,
        `page-${player}`,
        undefined,
        undefined,
        as(score),
      );
      await page.grid();
      page.sendOp({ opId: 1, op: brickAt(x, 520) });
      expect(await ackOf(page)).toEqual({ type: 'ack', opId: 1, ok: true });
      const [cell] = await placedCells(x, 520);
      const at = { x: cell! % 1024, y: Math.floor(cell! / 1024) };
      // A shield the core refuses (an empty cell) spends nothing and counts nothing.
      page.sendOp({ opId: 2, op: { kind: 'shield', x: x + 10, y: 560 } });
      expect(await ackOf(page)).toMatchObject({ opId: 2, ok: false, reason: 'empty' });
      page.sendOp({ opId: 3, op: { kind: 'shield', ...at } });
      expect(await ackOf(page)).toEqual({ type: 'ack', opId: 3, ok: true });
      page.sendOp({ opId: 4, op: { kind: 'shield', ...at } });
      const fourth = await ackOf(page);
      if (player === 'p-low') {
        expect(fourth).toEqual({ type: 'ack', opId: 4, ok: false, reason: 'limited' });
        const hold = await CANVAS.get(CANVAS.idFromName('canvas')).holds([player]);
        expect(hold.get(player)!.items).toEqual([SHIELD]);
      } else {
        // Trusted, or scored as `unscored` (above every tier): no limit.
        expect(fourth).toEqual({ type: 'ack', opId: 4, ok: true });
      }
      page.ws.close();
    }
    // Each account's accepted shields were counted, limited or not; bricks never are.
    const counted = await runInDurableObject(
      FANOUT.get(FANOUT.idFromName('trust')),
      (instance: unknown) => (instance as { usesByAccount: { size: number } }).usesByAccount.size,
    );
    expect(counted).toBe(3);
  });

  /** Signals that never challenge and flag from 1: each test overrides what it looks at. */
  const SIGNALS: SignalPolicy = {
    halfLifeMs: 3_600_000,
    offView: 1,
    viewMargin: 2,
    noView: 0,
    onCooldown: 1,
    samples: 4,
    withinMs: 1_000,
    spreadMs: 50,
    trustPenalty: 0,
    challengeAt: 0,
    flagAt: 1,
  };

  const sendView = (
    socket: Awaited<ReturnType<typeof connect>>,
    view: { x: number; y: number; w: number; h: number },
  ) => socket.ws.send(encodeClientView({ view }));

  const suspectsOf = async (fanout: string): Promise<{ players: Suspect[] }> => {
    const { players } = await FANOUT.get(FANOUT.idFromName(fanout)).suspects();
    return { players: players.map((s) => ({ ...s })) };
  };

  it('keeps the view on the socket and flags ops outside it, without refusing them', async () => {
    await withPolicy('views', { signals: SIGNALS });
    await stock('p-view', [O, O]);
    const page = await connect('views', 'p-view');
    await page.grid();
    sendView(page, { x: 280, y: 540, w: 60, h: 20 });
    page.sendOp({ opId: 1, op: brickAt(300, 545) });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 1, ok: true });
    const fanout = FANOUT.get(FANOUT.idFromName('views'));
    expect(((await attachmentOf(fanout, 'p-view')) as { view?: unknown }).view).toEqual([
      280, 540, 60, 20,
    ]);
    expect((await suspectsOf('views')).players).toEqual([]);
    // Outside the view and its margin: accepted all the same, and flagged for moderators.
    page.sendOp({ opId: 2, op: brickAt(360, 545) });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 2, ok: true });
    expect((await suspectsOf('views')).players).toEqual([
      { player: 'p-view', score: 1, offView: 1, noView: 0, onCooldown: 0, passed: 0 },
    ]);
    // A watcher's view is dropped quietly.
    const watcher = await connect('views', null);
    await watcher.grid();
    sendView(watcher, { x: 0, y: 0, w: 1, h: 1 });
    watcher.sendOp({ opId: 1, op: brickAt(0, 0) });
    expect(await ackOf(watcher)).toMatchObject({ ok: false, reason: 'signed_out' });
    page.ws.close();
    watcher.ws.close();
  });

  it('requires a Turnstile once suspicion reaches challengeAt, until clearChallenge', async () => {
    await withPolicy('challenge', { signals: { ...SIGNALS, noView: 5, challengeAt: 5 } });
    await stock('p-bot', [O, O]);
    const bot = await connect('challenge', 'p-bot', 'page-bot');
    await bot.grid();
    // No view, ever: the first op reaches the threshold. No ack: the socket closes.
    bot.sendOp({ opId: 1, op: brickAt(380, 560) });
    expect(await bot.closed).toBe(CHALLENGE_REQUIRED);
    await expect(bot.next(300)).rejects.toThrow('no frame');
    const fanout = FANOUT.get(FANOUT.idFromName('challenge'));
    // Durable: after an eviction, the next socket's op closes it too, and nothing is spent.
    await evictDurableObject(fanout);
    await withPolicy('challenge', { signals: { ...SIGNALS, noView: 5, challengeAt: 5 } });
    const again = await connect('challenge', 'p-bot', 'page-bot');
    await again.grid();
    sendView(again, { x: 370, y: 550, w: 40, h: 40 });
    again.sendOp({ opId: 1, op: brickAt(380, 560) });
    expect(await again.closed).toBe(CHALLENGE_REQUIRED);
    const held = await CANVAS.get(CANVAS.idFromName('canvas')).holds(['p-bot']);
    expect(held.get('p-bot')!.items).toEqual([O, O]);
    const listed = (await suspectsOf('challenge')).players;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ player: 'p-bot' });
    expect(listed[0]!.challengedAt).toBeGreaterThan(Date.now() - 60_000);
    // Passed: the page resends the same op on a new socket, and it goes through.
    expect(await fanout.clearChallenge('p-bot')).toEqual({ cleared: true });
    expect(await fanout.clearChallenge('p-bot')).toEqual({ cleared: false });
    const passed = await connect('challenge', 'p-bot', 'page-bot');
    await passed.grid();
    sendView(passed, { x: 370, y: 550, w: 40, h: 40 });
    passed.sendOp({ opId: 1, op: brickAt(380, 560) });
    expect(await ackOf(passed)).toEqual({ type: 'ack', opId: 1, ok: true });
    // Its score starts over; moderators still see that it was challenged and passed (the
    // eviction above forgot the signal that challenged it).
    expect((await suspectsOf('challenge')).players).toEqual([
      { player: 'p-bot', score: 0, offView: 0, noView: 0, onCooldown: 0, passed: 1 },
    ]);
    passed.ws.close();
  });

  it('lowers the trust allowance by suspicion', async () => {
    await withPolicy('suspicion', {
      trust: { unscored: 50, windowMs: 3_600_000, tiers: [{ below: 30, uses: 0 }] },
      signals: { ...SIGNALS, offView: 1, trustPenalty: 10 },
    });
    await stock('p-sus', [O, SHIELD, O]);
    const page = await connect('suspicion', 'p-sus', 'page-sus', undefined, undefined, {
      [TRUST_HEADER]: '35',
    });
    await page.grid();
    sendView(page, { x: 400, y: 560, w: 20, h: 20 });
    page.sendOp({ opId: 1, op: brickAt(400, 560) });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 1, ok: true });
    const [cell] = await placedCells(400, 560);
    const at = { x: cell! % 1024, y: Math.floor(cell! / 1024) };
    // One op outside the view: 35 - 10 is below the tier, which allows no use at all.
    page.sendOp({ opId: 2, op: brickAt(460, 620) });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 2, ok: true });
    page.sendOp({ opId: 3, op: { kind: 'shield', ...at } });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 3, ok: false, reason: 'limited' });
    page.ws.close();
  });

  it('records when the latest item arrived, for the timing signal', async () => {
    // Due in an hour, so the page joins before it however slow the machine.
    const scheduled = Date.now() + 60 * 60_000;
    await stock('p-time', [], scheduled - COOLDOWN);
    const page = await connect('arrivals', 'p-time');
    await page.grid();
    expect((await page.nextHold()).items).toEqual([]);
    // The alarm delivers it 10 s after it became due.
    const due = await cooldownEnds('arrivals', 'p-time', scheduled, 10_000);
    expect((await page.nextHold()).items).toHaveLength(1);
    const fanout = FANOUT.get(FANOUT.idFromName('arrivals'));
    const { arrived } = (await attachmentOf(fanout, 'p-time')) as { arrived?: number };
    // The time the item became due (the stock time plus the cooldown), not when the late
    // alarm happened to deliver it.
    expect(arrived).toBe(due);
    page.ws.close();
  });

  it('lifts nothing without a pending challenge: a Turnstile solved at will wipes no suspicion', async () => {
    await withPolicy('no-challenge', { signals: SIGNALS });
    await stock('p-flag', [O]);
    const page = await connect('no-challenge', 'p-flag');
    await page.grid();
    page.sendOp({ opId: 1, op: brickAt(280, 660) });
    expect(await ackOf(page)).toMatchObject({ opId: 1 });
    const fanout = FANOUT.get(FANOUT.idFromName('no-challenge'));
    // That op had no view (counted, weighing 0 here); the next one lies outside the view.
    sendView(page, { x: 0, y: 0, w: 10, h: 10 });
    page.sendOp({ opId: 2, op: brickAt(290, 660) });
    expect(await ackOf(page)).toMatchObject({ opId: 2 });
    const before = (await suspectsOf('no-challenge')).players;
    expect(before).toEqual([
      { player: 'p-flag', score: 1, offView: 1, noView: 1, onCooldown: 0, passed: 0 },
    ]);
    expect(await fanout.clearChallenge('p-flag')).toEqual({ cleared: false });
    expect((await suspectsOf('no-challenge')).players).toEqual(before);
    page.ws.close();
  });

  it('keeps a burst of views in memory and writes the attachment at most every 100 ms', async () => {
    await withPolicy('view-burst', { signals: SIGNALS });
    await stock('p-burst', [O]);
    const page = await connect('view-burst', 'p-burst');
    await page.grid();
    const fanout = FANOUT.get(FANOUT.idFromName('view-burst'));
    // Writes that put a new view on the attachment (hold updates carry the old one along).
    let writes = 0;
    await runInDurableObject(fanout, (_, state) => {
      const ws = state.getWebSockets('p-burst')[0]!;
      const write = ws.serializeAttachment.bind(ws);
      let last = '';
      ws.serializeAttachment = (value: unknown) => {
        const view = JSON.stringify((value as { view?: unknown }).view ?? null);
        if (view !== 'null' && view !== last) writes++;
        last = view;
        write(value);
      };
    });
    // The real window is 100 ms...
    const real = await runInDurableObject(
      fanout,
      (instance: unknown) => (instance as { viewWriteMs: number }).viewWriteMs,
    );
    expect(real).toBe(100);
    // ...widened for the burst, which no machine outlasts then: 20 frames took over 100 ms
    // on a loaded 2-CPU CI runner.
    await tune(fanout, { viewWriteMs: 60_000 });
    for (let i = 0; i < 20; i++) sendView(page, { x: 180 + i * 10, y: 660, w: 20, h: 20 });
    // The last view reached the signal at once, though the attachment kept the first.
    page.sendOp({ opId: 1, op: brickAt(375, 665) });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 1, ok: true });
    expect(writes).toBe(1);
    expect(((await attachmentOf(fanout, 'p-burst')) as { view?: unknown }).view).toEqual([
      180, 660, 20, 20,
    ]);
    expect((await suspectsOf('view-burst')).players).toEqual([]);
    // Back to the real window: once it has passed, the next view is written.
    await tune(fanout, { viewWriteMs: real });
    await new Promise((resolve) => setTimeout(resolve, real + 20));
    sendView(page, { x: 1, y: 2, w: 3, h: 4 });
    await until('attachment rewritten', () => writes === 2);
    page.ws.close();
  });

  it('reserves a hammer or shield use before the canvas, so racing ops cannot overshoot', async () => {
    const trust = { unscored: 0, windowMs: 3_600_000, tiers: [{ below: 50, uses: 1 }] };
    await withPolicy('race', { trust });
    await stock('p-race', [O, SHIELD, SHIELD]);
    const page = await connect('race', 'p-race');
    await page.grid();
    page.sendOp({ opId: 1, op: brickAt(420, 660) });
    expect(await ackOf(page)).toMatchObject({ opId: 1, ok: true });
    const [cell] = await placedCells(420, 660);
    const at = { x: cell! % 1024, y: Math.floor(cell! / 1024) };
    // Sent together: only one gets through the allowance of 1.
    page.sendOp({ opId: 2, op: { kind: 'shield', ...at } });
    page.sendOp({ opId: 3, op: { kind: 'shield', ...at } });
    const acks = [await ackOf(page), await ackOf(page)].sort((a, b) => a.opId - b.opId);
    expect(acks.filter((a) => a.ok)).toHaveLength(1);
    expect(acks.filter((a) => !a.ok && a.reason === 'limited')).toHaveLength(1);
    page.ws.close();
  });

  it('gives a use back for a retry the canvas answers as a duplicate', async () => {
    const trust = { unscored: 0, windowMs: 3_600_000, tiers: [{ below: 50, uses: 2 }] };
    await withPolicy('dup-use', { trust });
    await stock('p-dup', [O, SHIELD, SHIELD]);
    const page = await connect('dup-use', 'p-dup', 'page-dup');
    await page.grid();
    page.sendOp({ opId: 1, op: brickAt(440, 660) });
    expect(await ackOf(page)).toMatchObject({ opId: 1, ok: true });
    const [cell] = await placedCells(440, 660);
    const at = { x: cell! % 1024, y: Math.floor(cell! / 1024) };
    page.sendOp({ opId: 2, op: { kind: 'shield', ...at } });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 2, ok: true });
    // The same op again (a resend): a duplicate, which spends no use.
    page.sendOp({ opId: 2, op: { kind: 'shield', ...at } });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 2, ok: true });
    page.sendOp({ opId: 3, op: { kind: 'shield', ...at } });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 3, ok: true });
    page.sendOp({ opId: 4, op: { kind: 'shield', ...at } });
    expect(await ackOf(page)).toEqual({ type: 'ack', opId: 4, ok: false, reason: 'limited' });
    page.ws.close();
  });

  it('drops a challenge nobody answered for a week, and prunes it at the next one', async () => {
    await withPolicy('stale', { signals: { ...SIGNALS, noView: 5, challengeAt: 5 } });
    await stock('p-stale', [O]);
    await stock('p-fresh', [O]);
    const fanout = FANOUT.get(FANOUT.idFromName('stale'));
    await runInDurableObject(fanout, (instance: unknown, state) => {
      state.storage.kv.put('challenge:p-stale', Date.now() - 7 * 24 * 3_600_000 - 1000);
      (instance as { challenges: unknown }).challenges = null;
    });
    // Past its week the old challenge no longer holds the player.
    const stale = await connect('stale', 'p-stale');
    await stale.grid();
    sendView(stale, { x: 450, y: 650, w: 30, h: 30 });
    stale.sendOp({ opId: 1, op: brickAt(460, 660) });
    expect(await ackOf(stale)).toEqual({ type: 'ack', opId: 1, ok: true });
    stale.ws.close();
    const keys = () =>
      runInDurableObject(fanout, (_, state) =>
        [...state.storage.kv.list({ prefix: 'challenge:' })].map(([key]) => key),
      );
    // Reading the challenges dropped it from storage as well.
    expect(await keys()).toEqual([]);
    const bot = await connect('stale', 'p-fresh');
    await bot.grid();
    bot.sendOp({ opId: 1, op: brickAt(480, 660) });
    expect(await bot.closed).toBe(CHALLENGE_REQUIRED);
    expect(await keys()).toEqual(['challenge:p-fresh']);
    // One that runs out while the object is up: suspects() drops it, and does not list it.
    await runInDurableObject(fanout, (instance: unknown, state) => {
      const old = Date.now() - 7 * 24 * 3_600_000 - 1000;
      state.storage.kv.put('challenge:p-fresh', old);
      (instance as { challenges: Map<string, number> }).challenges.set('p-fresh', old);
    });
    const listed = (await suspectsOf('stale')).players.filter((s) => s.challengedAt);
    expect(listed).toEqual([]);
    expect(await keys()).toEqual([]);
  });

  it('forgets a pending challenge when the account is deleted, not on other kicks', async () => {
    await withPolicy('kick-challenge', { signals: { ...SIGNALS, noView: 5, challengeAt: 5 } });
    await stock('p-kc', [O]);
    const fanout = FANOUT.get(FANOUT.idFromName('kick-challenge'));
    const bot = await connect('kick-challenge', 'p-kc');
    await bot.grid();
    bot.sendOp({ opId: 1, op: brickAt(540, 660) });
    expect(await bot.closed).toBe(CHALLENGE_REQUIRED);
    const pending = () =>
      runInDurableObject(fanout, (_, state) => state.storage.kv.get<number>('challenge:p-kc'));
    // "Sign out everywhere", a ban or a reset: the challenge stays.
    await fanout.kick('p-kc');
    expect(await pending()).toBeTypeOf('number');
    // The account's deletion: nothing of it is kept.
    await fanout.kick('p-kc', true);
    expect(await pending()).toBeUndefined();
    expect((await suspectsOf('kick-challenge')).players).toEqual([]);
  });

  it('gives a use back when the canvas call fails, or the socket closes before it', async () => {
    const trust = { unscored: 0, windowMs: 3_600_000, tiers: [{ below: 50, uses: 1 }] };
    await stock('p-back', [O, SHIELD, SHIELD]);
    const fanout = FANOUT.get(FANOUT.idFromName('give-back'));
    await withPolicy('give-back', { trust });
    const page = await connect('give-back', 'p-back', 'page-back');
    await page.grid();
    page.sendOp({ opId: 1, op: brickAt(560, 660) });
    expect(await ackOf(page)).toMatchObject({ opId: 1, ok: true });
    const [cell] = await placedCells(560, 660);
    const at = { x: cell! % 1024, y: Math.floor(cell! / 1024) };
    // The call never reaches the canvas: `unavailable`, and the use is given back.
    await injectFaults(fanout, { ops: { 2: 'refused' } });
    page.sendOp({ opId: 2, op: { kind: 'shield', ...at } });
    expect(await ackOf(page)).toMatchObject({ opId: 2, ok: false, reason: 'unavailable' });
    const used = () =>
      runInDurableObject(fanout, (instance: unknown) =>
        (
          instance as { usesByAccount: { used(k: string, r: unknown, n: number): number } }
        ).usesByAccount.used('p-back', { limit: 1, windowMs: 3_600_000 }, Date.now()),
      );
    expect(await used()).toBe(0);
    // The socket closes while the mirror loads (an eviction left none): no call, use given back.
    page.ws.close();
    await evictDurableObject(fanout);
    await withPolicy('give-back', { trust });
    const again = await connect('give-back', 'p-back', 'page-back-2');
    await again.grid();
    await evictDurableObject(fanout);
    await withPolicy('give-back', { trust });
    let server: WebSocket | undefined;
    await runInDurableObject(fanout, (_, state) => {
      server = state.getWebSockets('p-back')[0];
    });
    // The mirror loads through follow() (ADR 0028).
    await injectFaults(fanout, {
      beforeFollow: () => server?.close(1000, 'gone while loading'),
    });
    again.sendOp({ opId: 1, op: { kind: 'shield', ...at } });
    expect(await again.closed).toBe(1000);
    // The use comes back once the snapshot returns, which can be after the page sees the close.
    let left = await used();
    for (let tries = 0; left !== 0 && tries * 20 < WAIT_MS; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      left = await used();
    }
    expect(left).toBe(0);
  });

  it('keeps the policy at hand when KV fails or does not answer', async () => {
    const policy: AbusePolicy = { ops: { account: { limit: 1, windowMs: 60_000 } } };
    const fanout = FANOUT.get(FANOUT.idFromName('kv-down'));
    let mode: 'throw' | 'hang' = 'throw';
    await runInDurableObject(fanout, (instance: unknown) => {
      const target = instance as { env: Env } & Record<string, unknown>;
      target.env = {
        ...target.env,
        MODERATION: {
          get: () =>
            mode === 'throw' ? Promise.reject(new Error('kv down')) : new Promise(() => {}),
        } as unknown as KVNamespace,
      };
      // Read long ago: the next socket or op starts a fresh read.
      Object.assign(target, { policy, policyLoaded: true, policyAt: 0 });
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await stock('p-kv', [O, O, O]);
      const page = await connect('kv-down', 'p-kv');
      await page.grid();
      await until('failed read', () =>
        errors.mock.calls.some(([line]) => String(line).includes('abuse policy unreadable')),
      );
      page.sendOp({ opId: 1, op: brickAt(500, 660) });
      expect(await ackOf(page)).toMatchObject({ opId: 1, ok: true });
      page.sendOp({ opId: 2, op: brickAt(510, 660) });
      expect(await ackOf(page)).toMatchObject({ opId: 2, ok: false, reason: 'unavailable' });
      // A read that hangs is not awaited, and keeps the policy too once it times out.
      mode = 'hang';
      await runInDurableObject(fanout, (instance: unknown) => {
        Object.assign(instance as object, { policyAt: 0 });
      });
      page.sendOp({ opId: 3, op: brickAt(520, 660) });
      expect(await ackOf(page)).toMatchObject({ opId: 3, ok: false, reason: 'unavailable' });
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      const kept = await runInDurableObject(
        fanout,
        (instance: unknown) => (instance as { policy: AbusePolicy | null }).policy,
      );
      expect(kept).toEqual(policy);
      expect(errors).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'abuse_policy_missing' }),
      );
      page.ws.close();
    } finally {
      errors.mockRestore();
    }
  }, 15_000);

  it('reads the policy from KV, and logs abuse_policy_missing without a usable one', async () => {
    const kv = (env as unknown as { MODERATION: KVNamespace }).MODERATION;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infos = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await stock('p-policy', [O, O]);
      const missing = await connect('policy-missing', 'p-policy');
      await missing.grid();
      expect(errors).toHaveBeenCalledWith({
        event: 'abuse_policy_missing',
        canvas: 'canvas',
        reason: 'missing',
        suppressed: 0,
      });
      missing.ws.close();
      await kv.put(POLICY_KEY, '{"ops":{"account":{"limit":"one"}}}');
      const malformed = await connect('policy-malformed', 'p-policy');
      await malformed.grid();
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'abuse_policy_missing', reason: 'malformed' }),
      );
      malformed.ws.close();
      await kv.put(
        POLICY_KEY,
        JSON.stringify({ ops: { account: { limit: 1, windowMs: 60_000 } } }),
      );
      const read = await connect('policy-read', 'p-policy');
      await read.grid();
      read.sendOp({ opId: 1, op: brickAt(310, 500) });
      expect(await ackOf(read)).toEqual({ type: 'ack', opId: 1, ok: true });
      read.sendOp({ opId: 2, op: brickAt(320, 500) });
      expect(await ackOf(read)).toEqual({ type: 'ack', opId: 2, ok: false, reason: 'unavailable' });
      // The refusals are counted in a `fanout_abuse` event, with no player id.
      const event = infos.mock.calls
        .map(([line]) => line as Record<string, unknown>)
        .find((line) => line?.event === 'fanout_abuse');
      expect(event).toMatchObject({ event: 'fanout_abuse', canvas: 'canvas', opsRefused: 1 });
      expect(JSON.stringify(event)).not.toContain('p-policy');
      read.ws.close();
    } finally {
      await kv.delete(POLICY_KEY);
      errors.mockRestore();
      infos.mockRestore();
    }
  });
});

describe('hold alarm from memory (ADR 0043)', () => {
  it('delivers a due hold after an eviction from what the sockets recorded', async () => {
    const scheduled = Date.now() + 100_000;
    await stock('pev', [], scheduled - COOLDOWN);
    const a = await connect('hold-evict', 'pev');
    await a.grid();
    expect((await a.nextHold()).items).toEqual([]);
    expect((await attachmentOf(a.stub, 'pev')).nextAt).toBe(scheduled);
    await evictDurableObject(a.stub);
    // The item came due while the object was gone: the canvas has it, the socket's record
    // (from before the eviction) says when; the new object's first alarm reads that record.
    const due = Date.now() - 10_000;
    await stock('pev', [], due - COOLDOWN);
    await runInDurableObject(a.stub, (instance: unknown) => {
      const { ctx } = instance as { ctx: DurableObjectState };
      for (const ws of ctx.getWebSockets('pev')) {
        ws.serializeAttachment({ ...(ws.deserializeAttachment() as object), nextAt: due });
      }
    });
    expect(await runDurableObjectAlarm(a.stub)).toBe(true);
    // One item, whichever the canvas drew.
    expect((await a.nextHold()).items).toHaveLength(1);
    // The next item is a minute off, and the socket's record says so.
    const next = await attachmentOf(a.stub, 'pev');
    expect(next.nextAt).toBeGreaterThan(Date.now());
  });

  it("keeps the alarm's copy current when a hold arrives after the copy was built", async () => {
    const scheduled = Date.now() + 3_600_000;
    await stock('pmem', [], scheduled - COOLDOWN);
    const a = await connect('hold-mem', 'pmem');
    await a.grid();
    expect((await a.nextHold()).items).toEqual([]);
    // Nothing due: this alarm builds the copy of the sockets' times and waits for the hour.
    expect(await runDurableObjectAlarm(a.stub)).toBe(true);
    // The item comes due and is recorded as an op's reply would record it: the next alarm
    // must see the new time, not the hour-away one it built its copy from.
    await cooldownEnds('hold-mem', 'pmem', scheduled);
    expect((await a.nextHold()).items).toHaveLength(1);
  });

  it('drops closed sockets from its copy at the next alarm', async () => {
    const later = Date.now() + 3_600_000;
    await stock('pc1', [], later - COOLDOWN);
    await stock('pc2', [], later - COOLDOWN);
    const a = await connect('hold-close', 'pc1');
    const b = await connect('hold-close', 'pc2');
    await a.grid();
    await b.grid();
    await a.nextHold();
    await b.nextHold();
    const copySize = () =>
      runInDurableObject(
        a.stub,
        (instance: unknown) =>
          (instance as { dueAt: Map<unknown, unknown> | null }).dueAt?.size ?? null,
      );
    expect(await runDurableObjectAlarm(a.stub)).toBe(true);
    expect(await copySize()).toBe(2);
    b.ws.close();
    for (let tries = 0; ; tries++) {
      const open = await runInDurableObject(
        a.stub,
        (_: unknown, state: DurableObjectState) => state.getWebSockets().length,
      );
      if (open === 1) break;
      if (tries * 10 > WAIT_MS) throw new Error('socket still open');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await runDurableObjectAlarm(a.stub)).toBe(true);
    expect(await copySize()).toBe(1);
  });
});

describe('discards through the relay (ADR 0043)', () => {
  /**
   * A game script from before applyMoves: the runtime's answer, and the other calls counted.
   * With `gate.hold`, the first applyBatch call waits for `gate.released`, so moves sent
   * meanwhile go together in the next call (`gate.entered` says it is under way).
   */
  async function withoutMoves(fanout: DurableObjectStub) {
    const calls = { applyMoves: 0, applyBatch: 0, discard: 0 };
    const gate = { hold: false, entered: 0, released: false };
    await runInDurableObject(fanout, (instance: unknown) => {
      const target = instance as { env: Env; relayCalls: typeof calls };
      target.relayCalls = calls;
      const real = target.env.CANVAS;
      const wrapped = {
        idFromName: (n: string) => real.idFromName(n),
        get: (id: DurableObjectId) =>
          new Proxy(real.get(id), {
            get(canvas, property) {
              if (property === 'applyMoves') {
                return async () => {
                  calls.applyMoves++;
                  throw new TypeError(
                    'The RPC receiver does not implement the method "applyMoves".',
                  );
                };
              }
              if (property === 'applyBatch' || property === 'discard') {
                return async (...args: unknown[]) => {
                  calls[property]++;
                  if (property === 'applyBatch' && gate.hold && ++gate.entered === 1) {
                    await until('released', () => gate.released);
                  }
                  return (canvas[property] as (...a: unknown[]) => unknown)(...args);
                };
              }
              return Reflect.get(canvas, property);
            },
          }),
      };
      target.env = { ...target.env, CANVAS: wrapped as unknown as Env['CANVAS'] };
    });
    const counts = () =>
      runInDurableObject(
        fanout,
        (instance: unknown) => (instance as { relayCalls: typeof calls }).relayCalls,
      );
    return { calls: counts, gate };
  }

  /** The moves waiting in this FanoutDO for the call in flight. */
  async function waiting(fanout: DurableObjectStub): Promise<number> {
    return runInDurableObject(
      fanout,
      (instance: unknown) => (instance as { relayWaiting: unknown[] }).relayWaiting.length,
    );
  }

  it('falls back to one discard() call each against a game script without applyMoves', async () => {
    await stock('p-fallback', [SHIELD, HAMMER], Date.now());
    const a = await connect('discard-fallback', 'p-fallback');
    await a.grid();
    expect((await a.nextHold()).items).toEqual([SHIELD, HAMMER]);
    const { calls } = await withoutMoves(a.stub);
    a.sendDiscard({ opId: 1, discard: SHIELD });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await a.nextHold()).items).toEqual([HAMMER]);
    // Tried once, then remembered: the next discard goes straight to discard().
    expect(await calls()).toEqual({ applyMoves: 1, applyBatch: 0, discard: 1 });
    a.sendDiscard({ opId: 2, discard: HAMMER });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    expect((await a.nextHold()).items).toEqual([]);
    expect(await calls()).toEqual({ applyMoves: 1, applyBatch: 0, discard: 2 });
    expect(
      await runInDurableObject(
        a.stub,
        (instance: unknown) => (instance as { movesSupported: boolean | null }).movesSupported,
      ),
    ).toBe(false);
  });

  /** The cells of a 2×2 brick at (x, y) on the shared canvas's map. */
  async function brickCells(x: number, y: number): Promise<number[]> {
    const { cells } = await CANVAS.get(CANVAS.idFromName('canvas')).snapshot();
    const size = Math.sqrt(cells.length);
    return [y * size + x, y * size + x + 1, (y + 1) * size + x, (y + 1) * size + x + 1];
  }

  it('keeps the ops of a mixed batch in one applyBatch call, each discard in its own, acked in order', async () => {
    await stock('p-mix-a', [O, O, SHIELD], Date.now());
    // b holds nothing: its op is refused, which tells its result from a's discard's.
    await stock('p-mix-b', [], Date.now());
    const a = await connect('discard-fallback-mixed', 'p-mix-a');
    const b = await connect('discard-fallback-mixed', 'p-mix-b');
    await a.grid();
    await b.grid();
    expect((await a.nextHold()).items).toEqual([O, O, SHIELD]);
    expect((await b.nextHold()).items).toEqual([]);
    const { calls, gate } = await withoutMoves(a.stub);
    gate.hold = true;
    // The first op's call is held; a's discard and op and b's op queue behind it and go
    // together: applyMoves is refused, the ops go in one applyBatch call, the discard in
    // discard(), and the results come back in the moves' order.
    a.sendOp({ opId: 1, op: brickAt(650, 330) });
    await until('first call', () => gate.entered === 1);
    a.sendDiscard({ opId: 2, discard: SHIELD });
    a.sendOp({ opId: 3, op: brickAt(670, 330) });
    b.sendOp({ opId: 1, op: brickAt(660, 330) });
    for (let tries = 0; (await waiting(a.stub)) < 3; tries++) {
      if (tries * 5 > WAIT_MS) throw new Error('moves not waiting');
      await new Promise((r) => setTimeout(r, 5));
    }
    gate.released = true;
    // Acks in send order on each socket: with the results out of order, b's refusal and a's
    // discard would swap. a's second brick, from the applyBatch call, reaches b.
    const applied = await brickCells(670, 330);
    const frames: { a: ServerMessage[]; b: ServerMessage[] } = { a: [], b: [] };
    const acks = (list: ServerMessage[]) => list.filter((m) => m.type === 'ack');
    const carries = (list: ServerMessage[], cells: number[]) =>
      list.some((m) => {
        if (m.type !== 'diffs') return false;
        const indices = new Set(m.diffs.map((d) => d.index));
        return cells.every((cell) => indices.has(cell));
      });
    while (acks(frames.a).length < 3) frames.a.push(await a.next());
    while (acks(frames.b).length < 1 || !carries(frames.b, applied)) {
      frames.b.push(await b.next());
    }
    expect(acks(frames.a)).toEqual([
      { type: 'ack', opId: 1, ok: true },
      { type: 'ack', opId: 2, ok: true },
      { type: 'ack', opId: 3, ok: true },
    ]);
    expect(acks(frames.b)).toEqual([{ type: 'ack', opId: 1, ok: false, reason: 'no_item' }]);
    expect(await calls()).toEqual({ applyMoves: 1, applyBatch: 2, discard: 1 });
    // The holds: a's after each of its calls, b's after its call. The second call's hold for
    // a is the discard()'s, which comes after applyBatch's: both the op and the discard gone.
    expect((await a.nextHold()).items).toEqual([O, SHIELD]);
    expect((await a.nextHold()).items).toEqual([]);
    expect((await b.nextHold()).items).toEqual([]);
  });
});
