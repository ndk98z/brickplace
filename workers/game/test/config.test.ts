import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  DEFAULT_ITEM_CONFIG,
  DEFAULT_OPEN_GROWTH,
  type Item,
  type ItemConfig,
} from '@brickplace/core';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigVersion, Env } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';

const { CANVAS } = env as unknown as Env;
type Stub = ReturnType<typeof CANVAS.get>;
const MIN = DEFAULT_ITEM_CONFIG.cooldown;
const T = 5_000_000;

const items = (version: number, change: Partial<ItemConfig> = {}): ItemConfig => ({
  ...DEFAULT_ITEM_CONFIG,
  version,
  ...change,
});
const itemsAt = (version: number, effectiveAt: number, change: Partial<ItemConfig> = {}) =>
  ({ scope: 'items', version, effectiveAt, config: items(version, change) }) as ConfigVersion;

async function hold(stub: Stub, player: string, at: number) {
  return (await stub.holds([player], at)).get(player)!;
}

const O: Item = { kind: 'brick', shape: 1 };
const brick = { kind: 'brick', x: 600, y: 600, shape: 1, rotation: 0, color: 3 } as const;
/** A cooldown start so far ahead that no item arrives during a test. */
const NEVER = 2 ** 50;

/** Puts exactly these items in the player's hold, stamped with the stored config (v1). */
async function stock(stub: Stub, player: string, held: readonly Item[], since: number) {
  await runInDurableObject(stub, (canvas, state) => {
    foldNow(canvas, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify(held),
      since,
    );
  });
}

/** A 64² map with a 16 x 20 open area (320 cells) and the stored growth rule 70% / 8. */
async function smallCanvas(name: string): Promise<Stub> {
  const stub = CANVAS.get(CANVAS.idFromName(name));
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    const config = JSON.parse(
      sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'").one().value,
    );
    const open = { x: 24, y: 22, w: 16, h: 20 };
    const small = { ...config, size: 64, open, growth: { atPercent: 70, step: 8 } };
    sql.exec("UPDATE meta SET value = ? WHERE key = 'config'", JSON.stringify(small));
  });
  await evictDurableObject(stub);
  return stub;
}

const square = (player: string, opId: number, x: number, y: number) =>
  ({ player, opId, op: { kind: 'brick', x, y, shape: 1, rotation: 0, color: 3 } }) as const;

describe('CanvasDO config versions (ADR 0022)', () => {
  it('switches the cooldown at the effective time: the share already run is kept', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-cooldown'));
    const first = await hold(stub, 'p1', T);
    expect(first).toMatchObject({ cooldown: MIN, nextAt: T + MIN });
    const E = T + MIN / 2;
    const result = await stub.scheduleConfig(itemsAt(2, E, { cooldown: 2 * MIN }), T);
    expect(result).toMatchObject({ ok: true, version: { effectiveAt: E, cancelled: false } });
    // Before the effective time the stored config still applies.
    expect(await hold(stub, 'p1', E - 1)).toMatchObject({ cooldown: MIN, nextAt: T + MIN });
    // Half of 60 s had run at E; the other half runs at 120 s, so 60 s after E.
    const after = await hold(stub, 'p1', T + MIN);
    expect(after).toMatchObject({ cooldown: 2 * MIN, nextAt: E + MIN });
    expect(after.items).toHaveLength(1);
    expect((await hold(stub, 'p1', E + MIN - 1)).items).toHaveLength(1);
    expect((await hold(stub, 'p1', E + MIN)).items).toHaveLength(2);
  });

  it('brings a hold through every version since it was last looked at', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-chain'));
    await hold(stub, 'c1', T);
    const E1 = T + MIN / 2;
    const E2 = T + (3 * MIN) / 2;
    await stub.scheduleConfig(itemsAt(2, E1, { cooldown: 2 * MIN }), T);
    await stub.scheduleConfig(itemsAt(3, E2, { cooldown: MIN / 2 }), T);
    // Under v2 the item due at E1 + 60 s = E2 arrives; v3 then counts 30 s from E2. With only
    // the last config (30 s from T) the hold would already be full.
    const view = await hold(stub, 'c1', T + 100_000);
    expect(view.items).toHaveLength(2);
    expect(view).toMatchObject({ cooldown: MIN / 2, nextAt: E2 + MIN / 2 });
  });

  it('prepares words for every draw the history makes due, in one call', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-needed'));
    await stub.scheduleConfig(itemsAt(2, T, { cooldown: MIN / 2, hold: 5 }), T);
    expect((await hold(stub, 'n1', T)).items).toHaveLength(1);
    await stub.scheduleConfig(itemsAt(3, T + 90_000, { cooldown: 2 * MIN, hold: 5 }), T);
    // Three items under 30 s by T + 90 s, none since under 120 s. The config in force alone
    // (120 s from T) would make one due, and words prepared for one would stop the rest.
    const view = await hold(stub, 'n1', T + 120_000);
    expect(view.items).toHaveLength(4);
    expect(view).toMatchObject({ cooldown: 2 * MIN, nextAt: T + 90_000 + 2 * MIN });
  });

  it('does not stamp a hold back to an older version for a call out of time order', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-order-calls'));
    await hold(stub, 'o1', T);
    const E = T + 1000;
    await stub.scheduleConfig(itemsAt(2, E, { cooldown: 2 * MIN }), T);
    // At E + 10 the hold moves to v2: 1 s of 60 s run, kept as 2 s of 120 s.
    expect(await hold(stub, 'o1', E + 10)).toMatchObject({ nextAt: E - 2000 + 2 * MIN });
    // A call whose time is before E uses v1 but must not stamp the hold back to v1 ...
    await hold(stub, 'o1', T + 500);
    // ... or v1 to v2 would be applied a second time, moving the next item again.
    expect(await hold(stub, 'o1', E + MIN)).toMatchObject({ nextAt: E - 2000 + 2 * MIN });
  });

  it('hands out nothing to a call before the version a hold is counted in', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-early-call'));
    await stub.scheduleConfig(itemsAt(2, T, { cooldown: MIN / 2, hold: 5 }), T);
    expect((await hold(stub, 'e1', T)).items).toHaveLength(1);
    const E = T + 25_000;
    await stub.scheduleConfig(itemsAt(3, E, { cooldown: 2 * MIN, hold: 5 }), T);
    const after = await hold(stub, 'e1', E + 10);
    expect(after.items).toHaveLength(1);
    // Before E the hold's count is in v3's units: under v2 it would make items from nothing.
    const early = await hold(stub, 'e1', E - 1);
    expect(early.items).toHaveLength(1);
    expect(early.revision).toBe(after.revision);
    // And the hold carries on under v3 as if the early call never happened.
    expect(await hold(stub, 'e1', E + 10)).toEqual(after);
  });

  it('keeps filling a hold whose version is gone for good, under the config in force', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-gone'));
    await stub.scheduleConfig(itemsAt(2, T, { cooldown: 2 * MIN }), T);
    expect((await hold(stub, 'g1', T + 1)).items).toHaveLength(1);
    // v2 is damaged in storage: the canvas ignores it from its next start.
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE config_schedule SET json = 'not json' WHERE version = 2");
    });
    await evictDurableObject(stub);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Ten minutes on, under the stored config (60 s), the hold has filled.
    const view = await hold(stub, 'g1', T + 10 * MIN);
    expect(view.items).toHaveLength(3);
    expect(view.cooldown).toBe(MIN);
    errors.mockRestore();
  });

  it('reports a damaged stored version and keeps its number taken', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-damaged'));
    await stub.configState(T);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO config_schedule (scope, version, effective_at, json) VALUES ('items', 2, 0, 'not json')",
      );
    });
    await evictDurableObject(stub);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = await stub.configState(T);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('CONFIG VERSION UNREADABLE'),
      'not json',
    );
    expect(state).toMatchObject({ unreadable: ['items@2'], latest: { items: 2 } });
    expect(state.items).toEqual(DEFAULT_ITEM_CONFIG);
    expect(await stub.scheduleConfig(itemsAt(2, T), T)).toMatchObject({ reason: 'stale' });
    expect(await stub.scheduleConfig(itemsAt(3, T), T)).toMatchObject({ ok: true });
    errors.mockRestore();
  });

  it('gives a full hold no burst when the hold grows', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-full'));
    await stock(stub, 'f1', [O, O, O], T - 10 * MIN);
    await stub.scheduleConfig(itemsAt(2, T, { hold: 5 }), T);
    // Full since long before T: counting starts at T, not at the last arrival.
    const view = await hold(stub, 'f1', T + 1);
    expect(view.items).toHaveLength(3);
    expect(view).toMatchObject({ capacity: 5, nextAt: T + MIN });
    expect((await hold(stub, 'f1', T + MIN)).items).toHaveLength(4);
  });

  it('uses the version in force in applyBatch: a full hold restarts at the new cooldown', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-batch'));
    await stock(stub, 'b1', [O, O, O], T - 10 * MIN);
    await stub.scheduleConfig(itemsAt(2, T, { cooldown: 2 * MIN }), T);
    const result = await stub.applyBatch([{ player: 'b1', opId: 1, op: brick }], T + 5);
    expect(result.results[0]).toMatchObject({ ok: true });
    expect(result.holds.get('b1')).toMatchObject({ cooldown: 2 * MIN, nextAt: T + 5 + 2 * MIN });
  });

  it('grows the open area by the growth rule in force at the batch time', async () => {
    const stub = await smallCanvas('config-growth');
    await stock(stub, 'g1', [O, O, O], NEVER);
    await stub.scheduleConfig(
      { scope: 'growth', version: 2, effectiveAt: T + 100, config: { atPercent: 1, step: 8 } },
      T,
    );
    // 4 of 320 cells is over 1% but under the stored 70%: no growth before T + 100.
    const before = await stub.applyBatch([square('g1', 1, 24, 22)], T + 99);
    expect(before.results[0]).toMatchObject({ ok: true });
    expect(before.grewAt).toBeUndefined();
    const at = await stub.applyBatch([square('g1', 2, 26, 22)], T + 100);
    expect(at.grewAt).toBe(at.seq + 1);
    expect(at.rules.open).toEqual({ x: 16, y: 14, w: 32, h: 36 });
  });

  it('draws with the drop rates in force', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-rates'));
    const shieldsOnly = {
      settling: [0, 0, 0, 1],
      contested: [0, 0, 0, 1],
      saturated: [0, 0, 0, 1],
    };
    await stub.scheduleConfig(
      itemsAt(2, T, { rates: shieldsOnly as unknown as ItemConfig['rates'], startItems: 3 }),
      T,
    );
    const view = await hold(stub, 'r1', T);
    expect(view.items).toEqual([{ kind: 'shield' }, { kind: 'shield' }, { kind: 'shield' }]);
  });

  it('starts a version given a past time when it is stored, and keeps it across restarts', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-past'));
    const result = await stub.scheduleConfig(itemsAt(2, 0, { cooldown: 30_000 }), T);
    expect(result).toMatchObject({ ok: true, version: { effectiveAt: T } });
    await evictDurableObject(stub);
    const state = await stub.configState(T);
    expect(state.items.cooldown).toBe(30_000);
    expect(state.current).toEqual({ items: 2, growth: 1 });
    expect(state.latest).toEqual({ items: 2, growth: 1 });
    expect((await stub.configState(T - 1)).items).toEqual(DEFAULT_ITEM_CONFIG);
  });

  it('is idempotent for a retry and refuses stale, conflicting and invalid versions', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-checks'));
    const v2 = itemsAt(2, T + 100, { cooldown: 90_000 });
    expect(await stub.scheduleConfig(v2, T)).toMatchObject({ ok: true });
    expect(await stub.scheduleConfig(v2, T + 1)).toMatchObject({ ok: true, duplicate: true });
    expect(await stub.scheduleConfig(itemsAt(2, T + 100, { cooldown: 1 }), T)).toEqual({
      ok: false,
      reason: 'conflict',
    });
    // Version 1 is the stored config; a version must be newer than every one known.
    expect(await stub.scheduleConfig(itemsAt(1, T), T)).toMatchObject({ reason: 'stale' });
    const invalid = [
      { ...itemsAt(3, T), config: items(4) },
      itemsAt(3, T, { cooldown: 0 }),
      itemsAt(3, T, { hold: 300 }),
      itemsAt(3, T, { rates: { settling: [0, 0, 0, 0] } as unknown as ItemConfig['rates'] }),
      { scope: 'teams', version: 3, effectiveAt: T, config: {} },
      { scope: 'growth', version: 2, effectiveAt: T, config: { atPercent: 0, step: 256 } },
      { scope: 'growth', version: 2, effectiveAt: -1, config: DEFAULT_OPEN_GROWTH },
    ] as ConfigVersion[];
    for (const version of invalid) {
      expect(await stub.scheduleConfig(version, T), JSON.stringify(version)).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    }
    // Unknown fields are dropped, not stored.
    const extra = {
      ...itemsAt(3, T),
      config: { ...items(3), extra: 'x' },
    } as unknown as ConfigVersion;
    const stored = await stub.scheduleConfig(extra, T);
    expect(stored.ok && stored.version.config).toEqual(items(3));
  });

  it('cancels a version only before it takes effect', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-cancel'));
    await stub.scheduleConfig(itemsAt(2, T + 1000, { cooldown: 120_000 }), T);
    await stub.scheduleConfig(itemsAt(3, T + 10, { cooldown: 45_000 }), T);
    expect(await stub.cancelConfig('items', 3, T + 10)).toEqual({
      ok: false,
      reason: 'already_effective',
    });
    expect(await stub.cancelConfig('items', 2, T + 20)).toEqual({ ok: true });
    expect(await stub.cancelConfig('items', 2, T + 30)).toEqual({ ok: false, reason: 'cancelled' });
    expect(await stub.cancelConfig('items', 9, T)).toEqual({ ok: false, reason: 'not_found' });
    // Version 3 stays in force after version 2's time: the cancelled one never applies.
    expect((await stub.configState(T + 2000)).items.cooldown).toBe(45_000);
    // A cancelled version cannot be scheduled again under its number.
    expect(
      await stub.scheduleConfig(itemsAt(2, T + 1000, { cooldown: 120_000 }), T + 40),
    ).toMatchObject({ ok: false, reason: 'cancelled' });
  });

  it('takes the latest effective time, then the higher version', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('config-order'));
    await stub.scheduleConfig(itemsAt(2, T + 500, { cooldown: 20_000 }), T);
    await stub.scheduleConfig(itemsAt(3, T + 100, { cooldown: 30_000 }), T);
    await stub.scheduleConfig(
      { scope: 'growth', version: 2, effectiveAt: T + 100, config: { atPercent: 90, step: 128 } },
      T,
    );
    expect((await stub.configState(T + 100)).items.cooldown).toBe(30_000);
    const later = await stub.configState(T + 500);
    expect(later.items.cooldown).toBe(20_000);
    expect(later.growth).toEqual({ atPercent: 90, step: 128 });
    expect(later.current).toEqual({ items: 2, growth: 2 });
    expect(later.latest).toEqual({ items: 3, growth: 2 });
    expect(later.versions.map((v) => `${v.scope}@${v.version}`)).toEqual([
      'items@2',
      'items@3',
      'growth@2',
    ]);
  });
});
