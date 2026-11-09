import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  createState,
  DEFAULT_ITEM_CONFIG,
  DEFAULT_MAP_SIZE,
  DEFAULT_OPEN_EDGE,
  drawItem,
  type Item,
  type Op,
} from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import { drawWords, importDrawKey, parseSalt } from '../src/draws.ts';
import type { Env } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';

const { CANVAS } = env as unknown as Env & { ITEM_DRAW_KEY: string };
type Stub = ReturnType<typeof CANVAS.get>;
const MIN = DEFAULT_ITEM_CONFIG.cooldown;
const T = 1_000_000;
const O: Item = { kind: 'brick', shape: 1 };
const HAMMER: Item = { kind: 'hammer' };
const SHIELD: Item = { kind: 'shield' };
const brickAt = (x: number, shape = 1) =>
  ({ kind: 'brick', x, y: 600, shape, rotation: 0, color: 3 }) as Op;
const by = (player: string, opId: number, op: Op) => ({ player, opId, op });

async function stock(stub: Stub, player: string, items: readonly Item[], since: number) {
  await runInDurableObject(stub, (canvas, state) => {
    foldNow(canvas, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify(items),
      since,
    );
  });
}

async function hold(stub: Stub, player: string, at: number) {
  return (await stub.holds([player], at)).get(player)!;
}

describe('CanvasDO inventory', () => {
  it('gives a new player one item at once, drawn by the keyed PRF', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-new'));
    const first = await hold(stub, 'n1', T);
    expect(first.items).toHaveLength(1);
    expect(first).toMatchObject({ capacity: 3, cooldown: MIN, nextAt: T + MIN });
    // Anyone with the key can recompute the draw from (player, index): here an empty map.
    const key = await importDrawKey((env as unknown as { ITEM_DRAW_KEY: string }).ITEM_DRAW_KEY);
    const salt = await runInDurableObject(stub, (_, state) =>
      parseSalt(
        JSON.parse(
          state.storage.sql
            .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'")
            .one().value,
        ).drawSalt,
      ),
    );
    const [kind, shape] = await drawWords(key!, salt, 'n1', 0);
    const offset = (DEFAULT_MAP_SIZE - DEFAULT_OPEN_EDGE) / 2;
    const empty = createState({
      size: DEFAULT_MAP_SIZE,
      open: { x: offset, y: offset, w: DEFAULT_OPEN_EDGE, h: DEFAULT_OPEN_EDGE },
      maxShield: 5,
    });
    expect(first.items[0]).toEqual(drawItem(empty, DEFAULT_ITEM_CONFIG, kind, shape));
    // Asking again changes nothing: the item was drawn once and stored.
    expect(await hold(stub, 'n1', T + 1)).toEqual(first);
  });

  it('adds one item per cooldown, lazily, and stops at the hold of 3', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-cooldown'));
    await hold(stub, 'c1', T);
    expect((await hold(stub, 'c1', T + MIN - 1)).items).toHaveLength(1);
    const second = await hold(stub, 'c1', T + MIN);
    expect(second.items).toHaveLength(2);
    expect(second.nextAt).toBe(T + 2 * MIN);
    // An hour away: only the room left fills, and a full hold has no next item.
    const full = await hold(stub, 'c1', T + 60 * MIN);
    expect(full.items).toHaveLength(3);
    expect(full.nextAt).toBeNull();
    expect(full.items.slice(0, 2)).toEqual(second.items);
  });

  it('draws different items for different players and indices', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-spread'));
    const drawn: Item[] = [];
    for (let p = 0; p < 40; p++) {
      await hold(stub, `s${p}`, T);
      drawn.push(...(await hold(stub, `s${p}`, T + 2 * MIN)).items);
    }
    expect(drawn).toHaveLength(120);
    const kinds = new Set(drawn.map((item) => item.kind));
    const shapes = new Set(drawn.flatMap((item) => (item.kind === 'brick' ? [item.shape] : [])));
    // Settling rates on an empty map: bricks of many shapes and some shields. A hammer may or
    // may not turn up (1%, and the salt is new each run); a single never does without holes.
    expect(kinds.has('brick') && kinds.has('shield')).toBe(true);
    expect(kinds.has('single')).toBe(false);
    expect(shapes.size).toBeGreaterThan(4);
  });

  it('bumps the hold revision on every write and only then', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-revision'));
    const first = await hold(stub, 'v1', T);
    expect(first.revision).toBe(1);
    expect((await hold(stub, 'v1', T + 10)).revision).toBe(1);
    const second = await hold(stub, 'v1', T + MIN);
    expect(second.revision).toBe(2);
    const stored = await runInDurableObject(stub, (canvas, state) => {
      foldNow(canvas, state.storage);
      return state.storage.sql
        .exec<{ revision: number }>("SELECT revision FROM inventory WHERE player = 'v1'")
        .one();
    });
    expect(stored.revision).toBe(2);
  });

  it('refuses an op without a matching item, and refunds a rejected op', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-refund'));
    await stock(stub, 'r1', [HAMMER, O], T);
    // A brick of a shape the player does not hold.
    const wrong = await stub.applyBatch([by('r1', 1, brickAt(600, 0))], T + 10);
    expect(wrong.results[0]).toEqual({ ok: false, reason: 'no_item' });
    // A hammer on an empty cell: rejected by the core, the hammer comes back.
    const missed = await stub.applyBatch([by('r1', 2, { kind: 'hammer', x: 600, y: 600 })], T + 20);
    expect(missed.results[0]).toEqual({ ok: false, reason: 'empty' });
    expect(missed.holds.get('r1')).toMatchObject({ items: [HAMMER, O], nextAt: T + MIN });
    expect(await stub.snapshot()).toMatchObject({ seq: 0 });
    // The O is used; rotation and colour are the player's choice.
    const placed = await stub.applyBatch(
      [by('r1', 3, { kind: 'brick', x: 600, y: 600, shape: 1, rotation: 2, color: 9 })],
      T + 30,
    );
    expect(placed.results[0]!.ok).toBe(true);
    expect(placed.holds.get('r1')!.items).toEqual([HAMMER]);
    // A second O in the same batch finds none left.
    const again = await stub.applyBatch(
      [by('r1', 4, brickAt(700)), by('r1', 5, { kind: 'hammer', x: 600, y: 600 })],
      T + 40,
    );
    expect(again.results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['no_item', 'ok']);
    expect(again.holds.get('r1')!.items).toEqual([]);
  });

  it('restarts the cooldown when a full hold gets room, and refunds that too', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-full'));
    await stock(stub, 'f1', [HAMMER, SHIELD, O], 0);
    expect((await hold(stub, 'f1', T)).nextAt).toBeNull();
    const missed = await stub.applyBatch([by('f1', 1, { kind: 'shield', x: 600, y: 600 })], T);
    expect(missed.results[0]).toEqual({ ok: false, reason: 'empty' });
    expect(missed.holds.get('f1')!.nextAt).toBeNull();
    const used = await stub.applyBatch([by('f1', 2, brickAt(600))], T + 5);
    expect(used.results[0]!.ok).toBe(true);
    expect(used.holds.get('f1')).toMatchObject({ items: [HAMMER, SHIELD], nextAt: T + 5 + MIN });
  });

  it('keeps holds across a restart and never pays twice for a retried op', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-retry'));
    await stock(stub, 'd1', [O, O], T);
    await stub.applyBatch([by('d1', 1, brickAt(600))], T + 1);
    await evictDurableObject(stub);
    const retry = await stub.applyBatch([by('d1', 1, brickAt(600))], T + 2);
    expect(retry.results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
    expect(retry.holds.get('d1')!.items).toEqual([O]);
  });

  it('discards a held item once per opId', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-discard'));
    await stock(stub, 'x1', [HAMMER, SHIELD, SHIELD], 0);
    const thrown = await stub.discard('x1', 1, SHIELD, T);
    expect(thrown.result).toEqual({ ok: true });
    expect(thrown.hold).toMatchObject({ items: [HAMMER, SHIELD], nextAt: T + MIN });
    const retry = await stub.discard('x1', 1, SHIELD, T + 1);
    expect(retry.result).toEqual({ ok: true, duplicate: true });
    expect(retry.hold!.items).toEqual([HAMMER, SHIELD]);
    expect((await stub.discard('x1', 2, O, T + 2)).result).toEqual({
      ok: false,
      reason: 'no_item',
    });
    // The discard's key is taken: an op with the same id is a retry of it.
    const op = await stub.applyBatch([by('x1', 1, { kind: 'hammer', x: 1, y: 1 })], T + 3);
    expect(op.results[0]).toMatchObject({ ok: true, duplicate: true });
    expect((await stub.discard('', 3, HAMMER, T)).result).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('draws nothing without ITEM_DRAW_KEY (fails closed)', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-no-key'));
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as { env: Env };
      target.env = { ...target.env, ITEM_DRAW_KEY: undefined };
    });
    const empty = await hold(stub, 'k1', T);
    expect(empty).toMatchObject({ items: [], nextAt: null });
    // Items already held stay usable.
    await stock(stub, 'k2', [O], T);
    const { results } = await stub.applyBatch([by('k2', 1, brickAt(600))], T + 5 * MIN);
    expect(results[0]!.ok).toBe(true);
  });

  it('pins the item config in a config stored before items existed, and uses it', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('inv-config'));
    const readConfig = () =>
      runInDurableObject(stub, (_, state) =>
        JSON.parse(
          state.storage.sql
            .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'")
            .one().value,
        ),
      );
    expect((await readConfig()).items).toEqual(DEFAULT_ITEM_CONFIG);
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      const config = JSON.parse(
        sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'").one().value,
      );
      delete config.items;
      delete config.drawSalt;
      sql.exec("UPDATE meta SET value = ? WHERE key = 'config'", JSON.stringify(config));
    });
    await evictDurableObject(stub);
    await hold(stub, 'g0', T);
    const pinned = await readConfig();
    expect(pinned.items).toEqual(DEFAULT_ITEM_CONFIG);
    // A salt is made once for the old config and then kept.
    expect(pinned.drawSalt).toMatch(/^[0-9a-f]{32}$/);
    await evictDurableObject(stub);
    await hold(stub, 'g0', T);
    expect((await readConfig()).drawSalt).toBe(pinned.drawSalt);
    // An admin change to the stored config (a 1 s cooldown, a hold of 2) applies on restart.
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      const config = JSON.parse(
        sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'").one().value,
      );
      config.items = { ...config.items, version: 2, cooldown: 1000, hold: 2 };
      sql.exec("UPDATE meta SET value = ? WHERE key = 'config'", JSON.stringify(config));
    });
    await evictDurableObject(stub);
    const fast = await hold(stub, 'g1', T);
    expect(fast).toMatchObject({ capacity: 2, cooldown: 1000, nextAt: T + 1000 });
    expect((await hold(stub, 'g1', T + 5000)).items).toHaveLength(2);
  });
});
