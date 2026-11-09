import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { foldNow } from '@brickplace/game/journal';
import {
  type ClientDiscard,
  type ClientOp,
  decodeServerMessage,
  encodeClientDiscard,
  encodeClientOp,
  type ServerMessage,
} from '@brickplace/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/index.ts';
import { FLUSH_MS, flushTiming, MAX_RELAY_WAITING, relayLimits } from '../src/pacing.ts';
import { PLAYER_HEADER, WATCH_HEADER } from '../src/player.ts';
import { WAIT_MS } from './wait.ts';

// ADR 0041: map changes reach the sockets at most once per flush, and ops reach the canvas
// in batches, one call in flight per shard. test/setup.ts turns the pacing off for the other
// tests; these turn it on where they need it.

const { FANOUT, CANVAS } = env as unknown as Env;
type Diffs = Extract<ServerMessage, { type: 'diffs' }>;
const O = { kind: 'brick', shape: 1 } as const;

const brickAt = (x: number, y: number) =>
  ({ kind: 'brick', x, y, shape: 1, rotation: 0, color: 3 }) as const;

afterEach(() => {
  flushTiming.ms = 0;
  relayLimits.waiting = MAX_RELAY_WAITING;
  relayLimits.timeoutMs = Number.POSITIVE_INFINITY;
});

/** Puts exactly these items in a player's hold on the shared canvas, with no cooldown due. */
async function stock(player: string, items: readonly (typeof O)[]) {
  await runInDurableObject(CANVAS.get(CANVAS.idFromName('canvas')), (instance, state) => {
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify(items),
      2 ** 50,
    );
  });
}

/** Waits until `ready()` holds, polling (see fanout.test.ts `until`). */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let tries = 0; !ready(); tries++) {
    if (tries * 5 > WAIT_MS) throw new Error(`${what}: not within ${WAIT_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A test client: every frame but holds and config, in order. */
async function connect(fanout: string, player: string | null) {
  const stub = FANOUT.get(FANOUT.idFromName(fanout));
  const identity: Record<string, string> =
    player === null ? { [WATCH_HEADER]: '1' } : { [PLAYER_HEADER]: player };
  const response = await stub.fetch('https://fanout/ws', {
    headers: { Upgrade: 'websocket', ...identity },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const inbox: ServerMessage[] = [];
  const holds = { count: 0 };
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', (event) => {
    const message = decodeServerMessage(new Uint8Array(event.data as ArrayBuffer));
    if (message.type === 'hold') holds.count++;
    else if (message.type !== 'config') inbox.push(message);
  });
  ws.accept();
  const next = async (ms = WAIT_MS): Promise<ServerMessage> => {
    for (let waited = 0; inbox.length === 0; waited += 5) {
      if (waited > ms) throw new Error(`no frame within ${ms} ms`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return inbox.shift()!;
  };
  const nextDiffs = async (): Promise<Diffs> => {
    const message = await next();
    if (message.type !== 'diffs') throw new Error(`expected diffs, got ${message.type}`);
    return message;
  };
  const sendOp = (op: ClientOp) => ws.send(encodeClientOp(op));
  const sendDiscard = (discard: ClientDiscard) => ws.send(encodeClientDiscard(discard));
  return { stub, inbox, holds, next, nextDiffs, sendOp, sendDiscard };
}

/** The cells waiting for a flush on this FanoutDO. */
async function pendingCells(fanout: DurableObjectStub): Promise<number> {
  return runInDurableObject(
    fanout,
    (instance: unknown) =>
      (instance as { pendingCells: Set<number> | null }).pendingCells?.size ?? 0,
  );
}

/** Runs the flush its timer would run (the timer dropped first). */
async function flushNow(fanout: DurableObjectStub): Promise<void> {
  await runInDurableObject(fanout, (instance: unknown) => {
    const target = instance as {
      flushTimer: ReturnType<typeof setTimeout> | null;
      flushCells(): void;
    };
    if (target.flushTimer !== null) clearTimeout(target.flushTimer);
    target.flushTimer = null;
    target.flushCells();
  });
}

/** The cells of a 2×2 brick at (x, y) on the shared canvas's map. */
async function brickCells(x: number, y: number): Promise<number[]> {
  const size = Math.sqrt((await CANVAS.get(CANVAS.idFromName('canvas')).snapshot()).cells.length);
  return [y * size + x, y * size + x + 1, (y + 1) * size + x, (y + 1) * size + x + 1];
}

/**
 * Holds this FanoutDO's first relay call to the canvas (applyBatch, or applyMoves when the
 * batch has a discard) until `released`, and records each call's name and move count; with
 * `failAfterFirst` every later call fails.
 */
async function gateCanvas(fanout: DurableObjectStub, { failAfterFirst = false } = {}) {
  // `landed`: the held call has reached the canvas (polled: see `until`).
  const gate = { released: false, landed: false, sizes: [] as number[], calls: [] as string[] };
  await runInDurableObject(fanout, (instance: unknown) => {
    const target = instance as { env: Env };
    const real = target.env.CANVAS;
    const gated = {
      idFromName: (name: string) => real.idFromName(name),
      get: (id: DurableObjectId) => {
        const canvas = real.get(id);
        return new Proxy(canvas, {
          get(stub, key) {
            if (key !== 'applyBatch' && key !== 'applyMoves') return Reflect.get(stub, key);
            const forward = (moves: Parameters<typeof canvas.applyMoves>[0]) =>
              key === 'applyMoves'
                ? canvas.applyMoves(moves)
                : canvas.applyBatch(moves as Parameters<typeof canvas.applyBatch>[0]);
            return async (moves: Parameters<typeof canvas.applyMoves>[0]) => {
              gate.sizes.push(moves.length);
              gate.calls.push(key);
              if (gate.sizes.length === 1) {
                await until('released', () => gate.released);
                try {
                  return await forward(moves);
                } finally {
                  gate.landed = true;
                }
              }
              if (failAfterFirst) throw new Error('canvas restarting');
              return forward(moves);
            };
          },
        });
      },
    };
    target.env = { ...target.env, CANVAS: gated as unknown as Env['CANVAS'] };
  });
  return gate;
}

/** The ops waiting in this FanoutDO for the call in flight. */
async function waitingOps(fanout: DurableObjectStub): Promise<number> {
  return runInDurableObject(
    fanout,
    (instance: unknown) => (instance as { relayWaiting: unknown[] }).relayWaiting.length,
  );
}

describe('paced map changes (ADR 0041)', () => {
  it('sends a change after a quiet spell at once and the next one with the following flush', async () => {
    // A flush that never comes on its own within the test: it runs it.
    flushTiming.ms = 60 * 60 * 1000;
    expect(FLUSH_MS).toBe(250);
    await stock('pace-a', [O, O]);
    const a = await connect('pace-1', 'pace-a');
    const w = await connect('pace-1', null);
    const start = (await a.nextDiffs()).seq;
    expect((await w.nextDiffs()).seq).toBe(start);

    a.sendOp({ opId: 1, op: brickAt(400, 400) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    expect((await a.nextDiffs()).seq).toBe(start + 1);
    expect((await w.nextDiffs()).seq).toBe(start + 1);

    a.sendOp({ opId: 2, op: brickAt(410, 400) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    // The op's own socket gets its cells at once, at the seq of the last flush: it may still
    // lack other cells of the seqs in between.
    const own = await a.nextDiffs();
    expect(own.seq).toBe(start + 1);
    const cells = await brickCells(410, 400);
    expect(own.diffs.map((d) => d.index).sort((x, y) => x - y)).toEqual(cells);
    // The other sockets wait for the flush.
    expect(await pendingCells(a.stub)).toBe(4);

    await flushNow(a.stub);
    for (const socket of [w, a]) {
      const flushed = await socket.nextDiffs();
      expect(flushed.seq).toBe(start + 2);
      expect(flushed.diffs.map((d) => d.index).sort((x, y) => x - y)).toEqual(cells);
      expect(flushed.diffs.every((d) => d.cell !== 0)).toBe(true);
    }
  });
});

describe('batched op relays (ADR 0041)', () => {
  it('sends the ops that arrive while a call is in flight together in the next one', async () => {
    await stock('batch-a', [O]);
    await stock('batch-b', [O]);
    await stock('batch-c', [O]);
    const a = await connect('pace-2', 'batch-a');
    const b = await connect('pace-2', 'batch-b');
    const c = await connect('pace-2', 'batch-c');
    const start = (await a.nextDiffs()).seq;
    await b.nextDiffs();
    await c.nextDiffs();
    const gate = await gateCanvas(a.stub);

    a.sendOp({ opId: 1, op: brickAt(420, 420) });
    await until('first call', () => gate.sizes.length === 1);
    b.sendOp({ opId: 1, op: brickAt(430, 420) });
    c.sendOp({ opId: 1, op: brickAt(440, 420) });
    for (let tries = 0; (await waitingOps(a.stub)) < 2; tries++) {
      if (tries * 5 > WAIT_MS) throw new Error('ops not waiting');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    gate.released = true;

    // Each socket also gets the first op's cells, before or after its own ack.
    const diffs: Diffs[] = [];
    for (const socket of [a, b, c]) {
      for (;;) {
        const message = await socket.next();
        if (message.type === 'ack') {
          expect(message).toEqual({ type: 'ack', opId: 1, ok: true });
          break;
        }
        if (socket === c && message.type === 'diffs') diffs.push(message);
      }
    }
    expect(gate.sizes).toEqual([1, 2]);
    // The second call is one seq: its frame carries both bricks.
    while (diffs.length < 2) diffs.push(await c.nextDiffs());
    expect(diffs.map((d) => d.seq)).toEqual([start + 1, start + 2]);
    const second = diffs[1]!;
    const both = [...(await brickCells(430, 420)), ...(await brickCells(440, 420))];
    expect(second.diffs.map((d) => d.index).sort((x, y) => x - y)).toEqual(
      both.sort((x, y) => x - y),
    );
  });

  it('refuses ops past the waiting limit with busy, at once', async () => {
    relayLimits.waiting = 1;
    await stock('busy-a', [O, O, O]);
    const a = await connect('pace-3', 'busy-a');
    await a.nextDiffs();
    const gate = await gateCanvas(a.stub);

    a.sendOp({ opId: 1, op: brickAt(450, 450) });
    await until('first call', () => gate.sizes.length === 1);
    a.sendOp({ opId: 2, op: brickAt(460, 450) });
    for (let tries = 0; (await waitingOps(a.stub)) < 1; tries++) {
      if (tries * 5 > WAIT_MS) throw new Error('op not waiting');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    a.sendOp({ opId: 3, op: brickAt(470, 450) });
    // Answered while the call is still held: nothing reached the canvas for it.
    expect(await a.next()).toEqual({ type: 'ack', opId: 3, ok: false, reason: 'busy' });
    gate.released = true;

    const acks: ServerMessage[] = [];
    while (acks.length < 2) {
      const message = await a.next();
      if (message.type === 'ack') acks.push(message);
    }
    expect(acks).toEqual([
      { type: 'ack', opId: 1, ok: true },
      { type: 'ack', opId: 2, ok: true },
    ]);
    expect(gate.sizes).toEqual([1, 1]);
  });

  it('answers every op of a failed call unavailable', async () => {
    await stock('fail-a', [O]);
    await stock('fail-b', [O]);
    await stock('fail-c', [O]);
    const a = await connect('pace-4', 'fail-a');
    const b = await connect('pace-4', 'fail-b');
    const c = await connect('pace-4', 'fail-c');
    for (const socket of [a, b, c]) await socket.nextDiffs();
    const gate = await gateCanvas(a.stub, { failAfterFirst: true });

    a.sendOp({ opId: 1, op: brickAt(480, 480) });
    await until('first call', () => gate.sizes.length === 1);
    b.sendOp({ opId: 1, op: brickAt(490, 480) });
    c.sendOp({ opId: 1, op: brickAt(500, 480) });
    for (let tries = 0; (await waitingOps(a.stub)) < 2; tries++) {
      if (tries * 5 > WAIT_MS) throw new Error('ops not waiting');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    gate.released = true;

    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    for (const socket of [b, c]) {
      let message = await socket.next();
      // The first op's cells may come first.
      if (message.type === 'diffs') message = await socket.next();
      expect(message).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    }
    expect(gate.sizes).toEqual([1, 2]);
  });

  it('gives up on a call that takes too long, and the next one goes out', async () => {
    relayLimits.timeoutMs = 50;
    await stock('slow-a', [O, O]);
    const a = await connect('pace-5', 'slow-a');
    await a.nextDiffs();
    const gate = await gateCanvas(a.stub);

    a.sendOp({ opId: 1, op: brickAt(510, 510) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'unavailable' });
    a.sendOp({ opId: 2, op: brickAt(520, 510) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    expect(gate.sizes).toEqual([1, 1]);
    // The held call still reaches the canvas once let go; it lands before the next test.
    gate.released = true;
    await until('held call', () => gate.landed);
  });

  it('sends a player with several ops in one call its hold once', async () => {
    await stock('hold-a', [O, O, O]);
    const a = await connect('pace-6', 'hold-a');
    await a.nextDiffs();
    await until('first hold', () => a.holds.count === 1);
    const gate = await gateCanvas(a.stub);

    a.sendOp({ opId: 1, op: brickAt(530, 530) });
    await until('first call', () => gate.sizes.length === 1);
    a.sendOp({ opId: 2, op: brickAt(540, 530) });
    a.sendOp({ opId: 3, op: brickAt(550, 530) });
    for (let tries = 0; (await waitingOps(a.stub)) < 2; tries++) {
      if (tries * 5 > WAIT_MS) throw new Error('ops not waiting');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    gate.released = true;

    const acks: ServerMessage[] = [];
    while (acks.length < 3) {
      const message = await a.next();
      if (message.type === 'ack') acks.push(message);
    }
    expect(acks.every((ack) => ack.type === 'ack' && ack.ok)).toBe(true);
    expect(gate.sizes).toEqual([1, 2]);
    // One hold for each call: the join's, then one per call, not one per op.
    await until('holds', () => a.holds.count >= 3);
    expect(a.holds.count).toBe(3);
  });

  it('sends a discard with the ops waiting, in one applyMoves call, and its hold (ADR 0043)', async () => {
    await stock('disc-a', [O]);
    await stock('disc-b', [O, O]);
    const a = await connect('pace-discards', 'disc-a');
    const b = await connect('pace-discards', 'disc-b');
    await a.nextDiffs();
    await b.nextDiffs();
    await until('first holds', () => a.holds.count === 1 && b.holds.count === 1);
    const gate = await gateCanvas(a.stub);

    a.sendOp({ opId: 1, op: brickAt(610, 610) });
    await until('first call', () => gate.sizes.length === 1);
    b.sendDiscard({ opId: 1, discard: O });
    b.sendOp({ opId: 2, op: brickAt(620, 610) });
    for (let tries = 0; (await waitingOps(a.stub)) < 2; tries++) {
      if (tries * 5 > WAIT_MS) throw new Error('moves not waiting');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    gate.released = true;

    // The discard and the op are answered in their order, from one call.
    const acks: ServerMessage[] = [];
    while (acks.length < 2) {
      const message = await b.next();
      if (message.type === 'ack') acks.push(message);
    }
    expect(acks).toEqual([
      { type: 'ack', opId: 1, ok: true },
      { type: 'ack', opId: 2, ok: true },
    ]);
    expect(gate.sizes).toEqual([1, 2]);
    // Ops alone keep applyBatch; a batch with a discard goes through applyMoves.
    expect(gate.calls).toEqual(['applyBatch', 'applyMoves']);
    // One hold for the call, whatever it held: the join's, then the call's.
    await until('hold', () => b.holds.count >= 2);
    expect(b.holds.count).toBe(2);
  });
});

describe('cells waiting for a flush (ADR 0041)', () => {
  it('are not counted as sent by the behind marker', async () => {
    flushTiming.ms = 60 * 60 * 1000;
    await stock('mark-a', [O, O]);
    const a = await connect('pace-7', 'mark-a');
    const start = (await a.nextDiffs()).seq;
    a.sendOp({ opId: 1, op: brickAt(560, 560) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 1, ok: true });
    await a.nextDiffs();
    a.sendOp({ opId: 2, op: brickAt(570, 560) });
    expect(await a.next()).toEqual({ type: 'ack', opId: 2, ok: true });
    await a.nextDiffs();
    expect(await pendingCells(a.stub)).toBe(4);

    const stored = await runInDurableObject(a.stub, (instance: unknown) => {
      const target = instance as {
        ctx: DurableObjectState;
        verifyDelay: number;
        markBehind(): void;
      };
      target.verifyDelay = Number.POSITIVE_INFINITY;
      target.markBehind();
      return target.ctx.storage.kv.get<number>('sentSeq');
    });
    // The sockets have start + 1; start + 2 waits for the flush.
    expect(stored).toBe(start + 1);
  });

  it('go out before a resync replaces the mirror', async () => {
    flushTiming.ms = 60 * 60 * 1000;
    await stock('resync-a', [O, O]);
    await stock('resync-u', [O]);
    const a = await connect('pace-8', 'resync-a');
    const w = await connect('pace-8', null);
    const start = (await a.nextDiffs()).seq;
    expect((await w.nextDiffs()).seq).toBe(start);
    a.sendOp({ opId: 1, op: brickAt(580, 580) });
    expect((await w.nextDiffs()).seq).toBe(start + 1);
    a.sendOp({ opId: 2, op: brickAt(590, 580) });
    await until('cells waiting', () => a.inbox.some((m) => m.type === 'ack' && m.opId === 2));
    expect(await pendingCells(a.stub)).toBe(4);
    // A commit this shard never hears of puts the canvas ahead; the resync catches up.
    const canvas = CANVAS.get(CANVAS.idFromName('canvas'));
    await canvas.applyBatch([{ player: 'resync-u', opId: 1, op: brickAt(600, 580) }]);
    await runInDurableObject(a.stub, async (instance: unknown) => {
      const target = instance as {
        mirror: unknown;
        serial<T>(task: () => Promise<T>): Promise<T>;
        resync(old: unknown): Promise<void>;
      };
      await target.serial(() => target.resync(target.mirror));
    });

    const waiting = await w.nextDiffs();
    expect(waiting.diffs.map((d) => d.index).sort((x, y) => x - y)).toEqual(
      await brickCells(590, 580),
    );
    const caught = await w.nextDiffs();
    expect(caught.seq).toBeGreaterThan(waiting.seq);
    expect(caught.diffs.map((d) => d.index).sort((x, y) => x - y)).toEqual(
      await brickCells(600, 580),
    );
  });
});
