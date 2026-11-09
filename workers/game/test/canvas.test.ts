import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DEFAULT_MAX_SHIELD, DEFAULT_SHIELD_LIFETIME, type Item, type Op } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import { DEDUPE_WINDOW } from '../src/dedupe.ts';
import type { Env } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';

const { CANVAS } = env as unknown as Env;
type Stub = ReturnType<typeof CANVAS.get>;
const brick = { kind: 'brick', x: 600, y: 600, shape: 1, rotation: 0, color: 3 } as const;
const by = (player: string, opId: number, op: Op) => ({ player, opId, op });
const O: Item = { kind: 'brick', shape: 1 };
const HAMMER: Item = { kind: 'hammer' };
const SHIELD: Item = { kind: 'shield' };
/** A cooldown start so far ahead that no item arrives during a test. */
const NEVER = 2 ** 50;

/** Puts exactly these items in the player's hold, as an admin tool or a test would. */
async function stock(stub: Stub, player: string, items: readonly Item[], since = NEVER) {
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

async function count(stub: ReturnType<typeof CANVAS.get>, table: string): Promise<number> {
  return runInDurableObject(
    stub,
    (_, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n,
  );
}

function readConfig(stub: Stub) {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'").one(),
  );
}

/**
 * A canvas with a small map: its stored config is rewritten before any op, then it restarts
 * from it, as an admin tool would set up a new season.
 */
async function smallCanvas(
  name: string,
  size: number,
  open: { x: number; y: number; w: number; h: number },
  step: number,
): Promise<Stub> {
  const stub = CANVAS.get(CANVAS.idFromName(name));
  const config = JSON.parse((await readConfig(stub)).value);
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(
      "UPDATE meta SET value = ? WHERE key = 'config'",
      JSON.stringify({ ...config, size, open, growth: { atPercent: 70, step } }),
    );
  });
  await evictDurableObject(stub);
  return stub;
}

/** `n` O bricks (from the `from`-th on) tiling 2x2 squares row by row, 8 to a row, from (x0, y0). */
function squares(player: string, from: number, x0: number, y0: number, n: number) {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const op = { kind: 'brick', x: x0 + (i % 8) * 2, y: y0 + Math.floor(i / 8) * 2 } as const;
    return by(player, i + 1, { ...op, shape: 1, rotation: 0, color: 3 });
  });
}

/** The op log's rows, oldest first. */
function logRows(stub: Stub) {
  return runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ ops: string }>('SELECT ops FROM op_log ORDER BY seq')
      .toArray()
      .map((row) => JSON.parse(row.ops)),
  );
}

describe('CanvasDO', () => {
  it('logs accepted ops only, one row per batch', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('log'));
    await stock(stub, 'p1', [O, HAMMER]);
    const { seq, results } = await stub.applyBatch([
      by('p1', 1, brick),
      by('p1', 2, { kind: 'hammer', x: 0, y: 0 }),
    ]);
    expect(seq).toBe(1);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(await count(stub, 'op_log')).toBe(1);
  });

  it('rebuilds the grid from the log after eviction', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('replay'));
    await stock(stub, 'p1', [O, O]);
    await stub.applyBatch([by('p1', 1, brick)]);
    await evictDurableObject(stub);
    const { seq, results } = await stub.applyBatch([by('p1', 2, brick)]);
    expect(results[0]).toEqual({ ok: false, reason: 'occupied' });
    expect(seq).toBe(1);
  });

  it('replays shield decay at the logged times', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('decay'));
    await stock(stub, 'p1', [O, SHIELD, HAMMER]);
    await stub.applyBatch(
      [by('p1', 1, brick), by('p1', 2, { kind: 'shield', x: 600, y: 600 })],
      1_000,
    );
    await evictDurableObject(stub);
    const hammer = { kind: 'hammer', x: 600, y: 600 } as const;
    const { results } = await stub.applyBatch(
      [by('p1', 3, hammer)],
      1_000 + DEFAULT_SHIELD_LIFETIME,
    );
    // The layer expired, so the hammer clears the cell instead of breaking the shield.
    expect(results[0]!.ok && results[0]!.diffs.at(-1)).toMatchObject({ cell: 0, shield: 0 });
  });

  it('upgrades a log written before batches carried a time', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('legacy'));
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      sql.exec('DROP TABLE op_log');
      sql.exec('CREATE TABLE op_log (seq INTEGER PRIMARY KEY, ops TEXT NOT NULL)');
      sql.exec('INSERT INTO op_log (seq, ops) VALUES (1, ?)', JSON.stringify([brick]));
    });
    await evictDurableObject(stub);
    await stock(stub, 'p1', [O]);
    const { seq, results } = await stub.applyBatch([by('p1', 1, brick)]);
    expect(results[0]).toEqual({ ok: false, reason: 'occupied' });
    expect(seq).toBe(1);
  });

  it('pins the shield lifetime in a config stored before it existed', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('old-config'));
    const readConfig = () =>
      runInDurableObject(stub, (_, state) =>
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'")
          .one(),
      );
    expect(JSON.parse((await readConfig()).value).shieldLifetime).toBe(DEFAULT_SHIELD_LIFETIME);
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      const config = JSON.parse(
        sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'").one().value,
      );
      delete config.shieldLifetime;
      sql.exec("UPDATE meta SET value = ? WHERE key = 'config'", JSON.stringify(config));
    });
    await evictDurableObject(stub);
    await stub.applyBatch([by('p1', 1, brick)]);
    expect(JSON.parse((await readConfig()).value).shieldLifetime).toBe(DEFAULT_SHIELD_LIFETIME);
  });

  it('logs the batch time with the op, and its dedupe key and rows in one journal row', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('at'));
    await stock(stub, 'p1', [O]);
    await stub.applyBatch([by('p1', 1, brick)], 5_000);
    const row = await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec<{ at: number }>('SELECT at FROM op_log').one(),
    );
    expect(row.at).toBe(5_000);
    // ADR 0042: the key, the hold and the season numbers, not a row each.
    const journal = await runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ keys: number; k: string; r: string }>('SELECT keys, k, r FROM state_journal')
        .toArray(),
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]!.keys).toBe(1);
    expect(JSON.parse(journal[0]!.k)).toEqual([JSON.stringify(['p1', '', 1])]);
    const rows = JSON.parse(journal[0]!.r) as [string, string][];
    expect(rows.map(([table, player]) => `${table}:${player}`).sort()).toEqual([
      'inventory:p1',
      'player_season:p1',
    ]);
    expect(await count(stub, 'accepted_ops')).toBe(0);
  });

  it('answers a retried (player, opId) as a duplicate and applies it once', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('dedupe'));
    await stock(stub, 'p1', [O, HAMMER, HAMMER]);
    const hammer = { kind: 'hammer', x: 600, y: 600 } as const;
    await stub.applyBatch([by('p1', 1, brick)]);
    const first = await stub.applyBatch([by('p1', 2, hammer)]);
    expect(first.results[0]!.ok).toBe(true);
    // Applied twice, the hammer would hit an empty cell; as a retry it changes nothing.
    const retry = await stub.applyBatch([by('p1', 2, hammer)]);
    expect(retry.results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
    expect(retry.seq).toBe(first.seq);
    expect(await count(stub, 'op_log')).toBe(2);
    // ...and paid for once: one of the two hammers is left.
    expect(retry.holds.get('p1')!.items).toEqual([HAMMER]);
  });

  it('remembers accepted ops across a restart', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('dedupe-restart'));
    await stock(stub, 'p1', [O]);
    await stub.applyBatch([by('p1', 7, brick)]);
    await evictDurableObject(stub);
    const { results } = await stub.applyBatch([by('p1', 7, brick)]);
    expect(results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
  });

  it('keys duplicates by player, and within one batch', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('dedupe-player'));
    await stock(stub, 'p1', [O]);
    await stock(stub, 'p2', [O]);
    const other = { ...brick, x: 700 };
    const { results } = await stub.applyBatch([
      by('p1', 1, brick),
      by('p1', 1, other),
      by('p2', 1, other),
    ]);
    expect(results.map((r) => 'duplicate' in r)).toEqual([false, true, false]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('keys duplicates by connection too: two tabs or a reload may reuse an opId', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('dedupe-client'));
    await stock(stub, 'p1', [O, O, O]);
    const tab = (client: string, opId: number, op: Op) => ({ player: 'p1', client, opId, op });
    const { results } = await stub.applyBatch([
      tab('tab-a', 1, brick),
      tab('tab-b', 1, { ...brick, x: 700 }),
    ]);
    expect(results.map((r) => r.ok && !('duplicate' in r))).toEqual([true, true]);
    // A retry from the same tab is still a duplicate, after a restart too.
    await evictDurableObject(stub);
    const retry = await stub.applyBatch([tab('tab-b', 1, { ...brick, x: 700 })]);
    expect(retry.results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
    expect(retry.holds.get('p1')!.items).toEqual([O]);
    // The same split holds for discards.
    expect((await stub.discard('p1', 2, O, undefined, 'tab-a')).result).toEqual({ ok: true });
    expect((await stub.discard('p1', 2, O, undefined, 'tab-a')).result).toEqual({
      ok: true,
      duplicate: true,
    });
    expect((await stub.discard('p1', 2, O, undefined, 'tab-b')).result).toEqual({
      ok: false,
      reason: 'no_item',
    });
  });

  it('keeps every key through a rollback and a second roll-forward', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('dedupe-reupgrade'));
    await stock(stub, 'p1', [O]);
    await stub.applyBatch([{ player: 'p1', client: 'tab-a', opId: 1, op: brick }]);
    // A rolled-back build wrote its own recent_ops again, numbering from 1.
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      sql.exec(
        'CREATE TABLE recent_ops (n INTEGER PRIMARY KEY, player TEXT NOT NULL, ' +
          'op_id INTEGER NOT NULL, UNIQUE (player, op_id))',
      );
      sql.exec("INSERT INTO recent_ops (player, op_id) VALUES ('p1', 5)");
    });
    await evictDurableObject(stub);
    const { results } = await stub.applyBatch([
      { player: 'p1', client: 'tab-a', opId: 1, op: brick },
      by('p1', 5, { ...brick, x: 700 }),
    ]);
    expect(results).toEqual([
      { ok: true, duplicate: true, diffs: [] },
      { ok: true, duplicate: true, diffs: [] },
    ]);
  });

  it('moves (player, opId) keys of a canvas from before connection ids', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('dedupe-upgrade'));
    await stock(stub, 'p1', [O]);
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      sql.exec('DROP TABLE accepted_ops');
      sql.exec(
        'CREATE TABLE recent_ops (n INTEGER PRIMARY KEY, player TEXT NOT NULL, ' +
          'op_id INTEGER NOT NULL, UNIQUE (player, op_id))',
      );
      sql.exec("INSERT INTO recent_ops (player, op_id) VALUES ('p1', 9)");
    });
    await evictDurableObject(stub);
    // An old FanoutDO (no client) retrying op 9 still gets a duplicate.
    const { results } = await stub.applyBatch([by('p1', 9, brick)]);
    expect(results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
    const tables = await runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'recent_ops'")
        .toArray(),
    );
    expect(tables).toEqual([]);
  });

  it('refuses an overlong connection id', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('dedupe-client-long'));
    const { results } = await stub.applyBatch([
      { player: 'p1', client: 'x'.repeat(65), opId: 1, op: brick },
    ]);
    expect(results[0]).toEqual({ ok: false, reason: 'invalid' });
  });

  it('does not remember rejected ops', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('dedupe-rejected'));
    await stock(stub, 'p1', [HAMMER, O]);
    await stub.applyBatch([by('p1', 1, { kind: 'hammer', x: 600, y: 600 })]);
    expect(await count(stub, 'accepted_ops')).toBe(0);
    const { results } = await stub.applyBatch([by('p1', 1, brick)]);
    expect(results[0]).toMatchObject({ ok: true });
    expect('duplicate' in results[0]!).toBe(false);
  });

  it('refuses ops without a valid identity', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('identity'));
    const { seq, results } = await stub.applyBatch([by('', 1, brick), by('p1', -1, brick)]);
    expect(results).toEqual([
      { ok: false, reason: 'invalid' },
      { ok: false, reason: 'invalid' },
    ]);
    expect(seq).toBe(0);
  });

  it('keeps only the last DEDUPE_WINDOW accepted ops', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('dedupe-window'));
    await stock(stub, 'p0', [O, O]);
    await stock(stub, 'p1', [O, O, O]);
    await stub.applyBatch([by('p0', 0, brick)]);
    // Fill the window with other keys in one write; applying 100k real ops would be slow.
    await runInDurableObject(stub, (canvas) => {
      const inner = canvas as unknown as {
        state: { accept(key: string): void };
        write(body: () => void): void;
      };
      for (let i = 1; i < DEDUPE_WINDOW; i++) inner.state.accept(JSON.stringify(['filler', '', i]));
      inner.write(() => {});
    });
    // The window is full but still holds op 0; the next accepted op pushes its row out.
    await stub.applyBatch([by('p1', 1, { ...brick, x: 700 })]);
    expect(await count(stub, 'state_journal')).toBe(2);
    const { results } = await stub.applyBatch([by('p0', 0, brick)]);
    expect(results[0]).toEqual({ ok: false, reason: 'occupied' });
    // Op 0's row held p0's hold and numbers, written nowhere since: folded before it went.
    await evictDurableObject(stub);
    expect((await stub.holds(['p0'])).get('p0')!.items).toEqual([O]);
    expect((await stub.playerSeason('p0')).bricks).toBe(1);
  });

  it('logs open-area growth with the ops and replays it at the same point', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('grow'));
    await stock(stub, 'p1', [O, O, O]);
    const start = { x: 256, y: 256, w: 512, h: 512 };
    const grown = { x: 128, y: 128, w: 768, h: 768 };
    const outside = { ...brick, x: 200, y: 200 };
    expect(await stub.status()).toMatchObject({
      seq: 0,
      rules: { mapSize: 1024, open: start, maxShield: DEFAULT_MAX_SHIELD },
    });
    const before = await stub.applyBatch([by('p1', 1, outside)]);
    expect(before.results[0]).toEqual({ ok: false, reason: 'out_of_area' });
    expect(before.rules.open).toEqual(start);

    expect(await stub.setOpenArea(grown, 2_000)).toMatchObject({ ok: true, seq: 1 });
    const after = await stub.applyBatch([by('p1', 2, outside)], 3_000);
    expect(after.results[0]!.ok).toBe(true);
    expect(after.seq).toBe(2);
    expect(after.rules.open).toEqual(grown);

    // Replayed in log order: had the growth come after the brick, the brick would be
    // out_of_area again and its cells empty, so this retry under a new opId would fit.
    await evictDurableObject(stub);
    expect((await stub.status()).rules.open).toEqual(grown);
    const replayed = await stub.applyBatch([by('p1', 3, outside)], 4_000);
    expect(replayed.results[0]).toEqual({ ok: false, reason: 'occupied' });
    expect((await stub.snapshot()).rules.open).toEqual(grown);
    // About 2 s alone, all CPU (the counters over a 768² open area, twice with the restore):
    // five game runs in parallel on an 8-core machine took it past 15 s.
  }, 60_000);

  it('refuses an open area that does not contain the current one, and logs nothing', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('grow-refused'));
    const start = { x: 256, y: 256, w: 512, h: 512 };
    expect(await stub.setOpenArea({ x: 300, y: 256, w: 450, h: 512 })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await stub.setOpenArea({ x: 0, y: 0, w: 2048, h: 2048 })).toMatchObject({ ok: false });
    expect(await stub.setOpenArea({ x: 0.5, y: 0, w: 512, h: 512 })).toMatchObject({
      ok: false,
    });
    // The area it already has: accepted, but there is nothing to log.
    expect(await stub.setOpenArea(start)).toMatchObject({ ok: true, seq: 0 });
    expect(await count(stub, 'op_log')).toBe(0);
    expect((await stub.status()).rules.open).toEqual(start);
  });

  it('pins the automatic growth settings in the stored config', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('growth-config'));
    expect(JSON.parse((await readConfig(stub)).value).growth).toEqual({ atPercent: 70, step: 128 });
  });

  it('grows at exactly the threshold, not a cell before', async () => {
    // 16 x 20 = 320 cells: 70% is exactly 224 cells, 56 squares.
    const stub = await smallCanvas('grow-exact', 64, { x: 24, y: 22, w: 16, h: 20 }, 8);
    await stock(
      stub,
      'p1',
      Array.from({ length: 80 }, () => O),
    );
    const under = await stub.applyBatch(squares('p1', 0, 24, 22, 55));
    expect(under.results.every((r) => r.ok)).toBe(true);
    expect(under.grewAt).toBeUndefined();
    expect(under.rules.open).toEqual({ x: 24, y: 22, w: 16, h: 20 });
    const at = await stub.applyBatch(squares('p1', 55, 24, 22, 1));
    expect(at.grewAt).toBe(at.seq + 1);
    expect(at.rules.open).toEqual({ x: 16, y: 14, w: 32, h: 36 });
  });

  it('pins the growth settings in a config stored before they existed', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('old-growth'));
    const config = JSON.parse((await readConfig(stub)).value);
    delete config.growth;
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        "UPDATE meta SET value = ? WHERE key = 'config'",
        JSON.stringify(config),
      );
    });
    expect(JSON.parse((await readConfig(stub)).value).growth).toBeUndefined();
    await evictDurableObject(stub);
    await stock(stub, 'p1', [O]);
    await stub.applyBatch([by('p1', 1, brick)]);
    expect(JSON.parse((await readConfig(stub)).value).growth).toEqual({
      atPercent: 70,
      step: 128,
    });
  });

  it('grows the open area by itself once filled cells reach the threshold', async () => {
    const stub = await smallCanvas('grow-auto', 64, { x: 24, y: 24, w: 16, h: 16 }, 8);
    await stock(
      stub,
      'p1',
      Array.from({ length: 64 }, () => O),
    );
    // 44 of the 64 2x2 squares: 176 of 256 cells, under 70%.
    const first = await stub.applyBatch(squares('p1', 0, 24, 24, 44));
    expect(first.results.every((r) => r.ok)).toBe(true);
    expect(first.rules.open).toEqual({ x: 24, y: 24, w: 16, h: 16 });
    // One more: 180 cells, 70.3%. The batch keeps its seq; the growth takes the next one.
    const second = await stub.applyBatch(squares('p1', 44, 24, 24, 1));
    expect(second.seq).toBe(2);
    expect(second.grewAt).toBe(3);
    expect(first.grewAt).toBeUndefined();
    expect(second.rules).toMatchObject({ open: { x: 16, y: 16, w: 32, h: 32 }, seq: 3 });
    const status = await stub.status();
    expect(status.seq).toBe(3);
    const rows = await logRows(stub);
    expect(rows.at(-1)).toEqual([{ kind: 'open', x: 16, y: 16, w: 32, h: 32 }]);

    // Replayed from the log: the same area at the same seq, the same grid.
    const before = await stub.snapshot();
    await evictDurableObject(stub);
    const after = await stub.snapshot();
    expect(after.seq).toBe(before.seq);
    expect(after.rules).toEqual(before.rules);
    expect(after.cells).toEqual(before.cells);
    expect(await logRows(stub)).toEqual(rows);
  });

  it('clamps a growth at the map edge', async () => {
    const stub = await smallCanvas('grow-clamp', 64, { x: 48, y: 24, w: 16, h: 16 }, 8);
    await stock(
      stub,
      'p1',
      Array.from({ length: 64 }, () => O),
    );
    const { rules } = await stub.applyBatch(squares('p1', 0, 48, 24, 45));
    // Right edge at the map's: it grows left, up and down only.
    expect(rules.open).toEqual({ x: 40, y: 16, w: 24, h: 32 });
  });

  it('stops growing once the whole map is open', async () => {
    const stub = await smallCanvas('grow-full', 16, { x: 0, y: 0, w: 16, h: 16 }, 8);
    await stock(
      stub,
      'p1',
      Array.from({ length: 64 }, () => O),
    );
    const { seq, rules } = await stub.applyBatch(squares('p1', 0, 0, 0, 60));
    expect(rules.open).toEqual({ x: 0, y: 0, w: 16, h: 16 });
    expect(seq).toBe(1);
    expect(await count(stub, 'op_log')).toBe(1);
  });

  it('returns a snapshot of the grid with its seq', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('snapshot'));
    await stock(stub, 'p1', [O]);
    const { results } = await stub.applyBatch([by('p1', 1, brick)]);
    const snapshot = await stub.snapshot();
    expect(snapshot.seq).toBe(1);
    expect(snapshot.cells.length).toBe(1024 * 1024);
    const diffs = results[0]!.ok ? results[0]!.diffs : [];
    for (const d of diffs) expect(snapshot.cells[d.index]).toBe(d.cell);
  });
});
