import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DEFAULT_MAP_SIZE, type Item, type Op } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import type { Env, Rules } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';
import { RECORD_BYTES, type TickPush } from '../src/push.ts';
import type { FanoutDO } from './entry.ts';

// Diff ticks to FanoutDO shards (ADR 0028), against the recording stand-in in test/entry.ts.

const { CANVAS } = env as unknown as Env;
const FANOUT = (env as unknown as { FANOUT: DurableObjectNamespace<FanoutDO> }).FANOUT;
type Stub = ReturnType<typeof CANVAS.get>;
const O: Item = { kind: 'brick', shape: 1 };
const HAMMER: Item = { kind: 'hammer' };
const NEVER = 2 ** 50;
const brick = (x: number, y: number): Op => ({
  kind: 'brick',
  x,
  y,
  shape: 1,
  rotation: 0,
  color: 3,
});

async function stock(stub: Stub, player: string, items: readonly Item[]) {
  await runInDurableObject(stub, (canvas, state) => {
    foldNow(canvas, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify(items),
      NEVER,
    );
  });
}

/** A canvas whose ticks go out only when the test calls pushTicks(). */
async function manualCanvas(name: string): Promise<Stub> {
  const stub = CANVAS.get(CANVAS.idFromName(name));
  await runInDurableObject(stub, (instance: unknown) => {
    (instance as { pusher: { pushMs: number } }).pusher.pushMs = Number.POSITIVE_INFINITY;
  });
  return stub;
}

function shard(name: string) {
  return FANOUT.get(FANOUT.idFromName(name));
}

/** Records as [index, cell, shield] triples. */
function decode(records: Uint8Array | null): [number, number, number][] | null {
  if (records === null) return null;
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  const out: [number, number, number][] = [];
  for (let at = 0; at < records.byteLength; at += RECORD_BYTES) {
    out.push([view.getUint32(at, true), records[at + 4]!, records[at + 5]!]);
  }
  return out;
}

/** Waits until the shard has received `n` pushes in all, and returns them. */
async function pushesOf(name: string, n: number): Promise<TickPush<Rules>[]> {
  for (let tries = 0; ; tries++) {
    const got = (await shard(name).received()) as TickPush<Rules>[];
    if (got.length >= n) return got;
    // 10 s, as the realtime tests wait: 2 s ran out on a loaded GitHub runner.
    if (tries * 10 > 10_000) throw new Error(`${name}: ${got.length} pushes, wanted ${n}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function shardRows(stub: Stub): Promise<string[]> {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ name: string }>('SELECT name FROM fanout_shards ORDER BY name')
      .toArray()
      .map((r) => r.name),
  );
}

describe('diff ticks (ADR 0028)', () => {
  it('says in cursor() whether a shard follows and whether it could', async () => {
    const canvas = await manualCanvas('cursor');
    expect(await canvas.cursor('cursor:a')).toEqual({
      seq: expect.any(Number),
      following: false,
      acked: null,
      backingOff: false,
      registrable: true,
    });
    await canvas.follow('cursor:a', null, 0);
    expect(await canvas.cursor('cursor:a')).toMatchObject({ following: true, registrable: true });
    // A shard known only by its id cannot be pushed to.
    expect(await canvas.cursor('id:0123')).toMatchObject({ following: false, registrable: false });
    // Without the FANOUT binding no shard can follow.
    await runInDurableObject(canvas, (instance: unknown) => {
      const i = instance as { env: Env };
      i.env = { ...i.env, FANOUT: undefined } as unknown as Env;
    });
    expect(await canvas.cursor('cursor:b')).toMatchObject({ following: false, registrable: false });
    expect(await canvas.follow('cursor:b')).toMatchObject({ following: false, changes: null });
    // Every slot taken: a new shard could not follow either.
    await evictDurableObject(canvas);
    await runInDurableObject(canvas, (instance: unknown) => {
      (instance as { pusher: { hasRoom(): boolean } }).pusher.hasRoom = () => false;
    });
    expect(await canvas.cursor('cursor:c')).toMatchObject({ registrable: false });
    expect(await canvas.cursor('cursor:a')).toMatchObject({ following: true, registrable: true });
  });

  it('pushes one tick of end values to every following shard', async () => {
    const canvas = await manualCanvas('ticks');
    await stock(canvas, 'p1', [O, HAMMER]);
    const followed = await canvas.follow('ticks:a');
    expect(followed.following).toBe(true);
    expect(followed.changes).toBeNull();
    await canvas.follow('ticks:b');
    const start = followed.seq;
    await canvas.applyBatch([{ player: 'p1', opId: 1, op: brick(600, 600) }]);
    // Hammered away before the tick: the tick carries the cell's end value, 0.
    await canvas.applyBatch([{ player: 'p1', opId: 2, op: { kind: 'hammer', x: 600, y: 600 } }]);
    await canvas.pushTicks();
    for (const name of ['ticks:a', 'ticks:b']) {
      const [push] = await pushesOf(name, 1);
      expect(push!.from).toBe(start);
      expect(push!.to).toBe(start + 2);
      expect(push!.rules.mapSize).toBe(DEFAULT_MAP_SIZE);
      const records = decode(push!.records)!;
      expect(records).toHaveLength(4);
      // In index order, and the hammered cell is empty again.
      expect(records.map((r) => r[0])).toEqual([...records.map((r) => r[0])].sort((a, b) => a - b));
      expect(records).toContainEqual([600 * DEFAULT_MAP_SIZE + 600, 0, 0]);
    }
    // Nothing new: no push.
    await canvas.pushTicks();
    await new Promise((r) => setTimeout(r, 50));
    expect(await shard('ticks:a').received()).toHaveLength(1);
    expect(await shardRows(canvas)).toEqual(['ticks:a', 'ticks:b']);
  });

  it('keeps pushing to the others while one shard fails, then catches it up in one push', async () => {
    const canvas = await manualCanvas('slow');
    await stock(canvas, 'p2', [O, O]);
    await canvas.follow('slow:ok');
    const start = (await canvas.follow('slow:down')).seq;
    await shard('slow:down').behave({ fail: true });
    await canvas.applyBatch([{ player: 'p2', opId: 1, op: brick(610, 600) }]);
    await canvas.pushTicks();
    await pushesOf('slow:ok', 1);
    await canvas.applyBatch([{ player: 'p2', opId: 2, op: brick(620, 600) }]);
    // The failing shard is in backoff now: the healthy one is not held up by it.
    await canvas.pushTicks();
    const ok = await pushesOf('slow:ok', 2);
    expect(ok[1]!.from).toBe(start + 1);
    expect(decode(ok[1]!.records)).toHaveLength(4);
    // Back up: once its backoff ends it gets both ops in one push from its own cursor.
    await shard('slow:down').behave({});
    await new Promise((r) => setTimeout(r, 600));
    await canvas.pushTicks();
    const [caught] = await pushesOf('slow:down', 1);
    expect(caught!.from).toBe(start);
    expect(caught!.to).toBe(start + 2);
    expect(decode(caught!.records)).toHaveLength(8);
  });

  it('forgets a shard that has no sockets left, until it follows again', async () => {
    const canvas = await manualCanvas('empty');
    await stock(canvas, 'p3', [O, O]);
    await canvas.follow('empty:a');
    await shard('empty:a').behave({ sockets: 0 });
    await canvas.applyBatch([{ player: 'p3', opId: 1, op: brick(630, 600) }]);
    await canvas.pushTicks();
    await pushesOf('empty:a', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await shardRows(canvas)).toEqual([]);
    await canvas.applyBatch([{ player: 'p3', opId: 2, op: brick(640, 600) }]);
    await canvas.pushTicks();
    await new Promise((r) => setTimeout(r, 50));
    expect(await shard('empty:a').received()).toHaveLength(1);
  });

  it('hands a shard woken without its mirror what its sockets missed', async () => {
    const canvas = await manualCanvas('woken');
    await stock(canvas, 'p4', [O, O]);
    const start = (await canvas.follow('woken:a')).seq;
    await canvas.applyBatch([{ player: 'p4', opId: 1, op: brick(650, 600) }]);
    await canvas.applyBatch([{ player: 'p4', opId: 2, op: brick(660, 600) }]);
    // The shard's sockets have `start`: the canvas knows, and says what changed since.
    const again = await canvas.follow('woken:a', start);
    expect(again.seq).toBe(start + 2);
    expect(decode(again.changes)).toHaveLength(8);
    // Without a seq, the canvas's own cursor for it: still `start`, since the shard has not
    // answered a push since (the last reply could have been lost), so both ops again.
    expect(decode((await canvas.follow('woken:a')).changes)).toHaveLength(8);
    // A seq from before the ring (here: before the canvas's restart, which seeds the ring
    // only from the log rows past the checkpoint) is unknown.
    expect((await canvas.follow('woken:a', -1)).changes).toBeNull();
  });

  it('lists its recent changed cells when a shard asks, for resuming pages (ADR 0040)', async () => {
    const canvas = await manualCanvas('recent');
    await stock(canvas, 'p9', [O, O]);
    const start = (await canvas.follow('recent:a')).seq;
    await canvas.applyBatch([{ player: 'p9', opId: 1, op: brick(650, 600) }]);
    await canvas.applyBatch([{ player: 'p9', opId: 2, op: brick(660, 600) }]);
    // Not asked: no list, as before.
    expect((await canvas.follow('recent:b')).recent).toBeUndefined();
    const asked = await canvas.follow('recent:c', null, 0, 1000);
    expect(asked.recent!.from).toBeLessThanOrEqual(start);
    const ticks = asked.recent!.ticks;
    expect(ticks.at(-1)!.to).toBe(asked.seq);
    const listed = ticks.flatMap((t) => [...t.cells]);
    expect(listed).toHaveLength(8);
    // The cells are those that changed: set in the snapshot it came with.
    for (const index of listed) expect(asked.cells[index]).not.toBe(0);
    // Too few cells allowed for the newest tick: no list rather than a partial one.
    expect((await canvas.follow('recent:d', null, 0, 1)).recent).toBeUndefined();
  });

  it('keeps its shards across a restart and catches them up from the log tail', async () => {
    const canvas = await manualCanvas('restart');
    await stock(canvas, 'p5', [O, O]);
    const start = (await canvas.follow('restart:a')).seq;
    await canvas.applyBatch([{ player: 'p5', opId: 1, op: brick(670, 600) }]);
    await evictDurableObject(canvas);
    const back = await manualCanvas('restart');
    await back.pushTicks();
    const [push] = await pushesOf('restart:a', 1);
    // The cursor is unknown after the restart: the push starts where the ring does (at or
    // before the shard's seq) and carries end values, so applying it again is harmless.
    expect(push!.from).toBeLessThanOrEqual(start);
    expect(push!.to).toBe(start + 1);
    const placed = decode(push!.records)!.find(([index]) => index === 600 * DEFAULT_MAP_SIZE + 670);
    expect(placed?.[1]).not.toBe(0);
  });

  it('pushes new rules when a lock changes, without a seq', async () => {
    const canvas = await manualCanvas('locks');
    const { seq } = await canvas.follow('locks:a');
    const locked = await canvas.lockArea({ area: { x: 700, y: 700, w: 4, h: 4 }, until: null });
    expect(locked.ok).toBe(true);
    await canvas.pushTicks();
    const [push] = await pushesOf('locks:a', 1);
    expect(push!.from).toBe(seq);
    expect(push!.to).toBe(seq);
    expect(decode(push!.records)).toEqual([]);
    expect(push!.rules.locks).toEqual([{ x: 700, y: 700, w: 4, h: 4 }]);
  });

  it('pushes on its own, at most every PUSH_MS, while the map changes', async () => {
    const canvas = CANVAS.get(CANVAS.idFromName('timer'));
    await stock(canvas, 'p6', [O]);
    const { seq } = await canvas.follow('timer:a');
    await canvas.applyBatch([{ player: 'p6', opId: 1, op: brick(680, 600) }]);
    const [push] = await pushesOf('timer:a', 1);
    expect(push!.to).toBe(seq + 1);
  });

  it('refuses to register names it cannot store, and still answers the snapshot', async () => {
    const canvas = await manualCanvas('names');
    const reply = await canvas.follow('x'.repeat(200));
    expect(reply.following).toBe(false);
    expect(reply.cells.length).toBe(DEFAULT_MAP_SIZE * DEFAULT_MAP_SIZE);
    expect(await shardRows(canvas)).toEqual([]);
  });
});
