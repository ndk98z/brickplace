import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Item, Op } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import type { CanvasDO, Env } from '../src/index.ts';
import { foldNow, JOURNAL_ROW_BYTES, journalLimits, PlayerState } from '../src/journal.ts';
import { TEAM_CAP_KEY, type TeamLedger } from '../src/teams.ts';

// ADR 0042: holds, team credit, season numbers and dedupe keys go to one journal row per
// write and reach their tables only when folded; a start reads the journal back.

const { CANVAS, MODERATION } = env as unknown as Required<Env>;
type Stub = ReturnType<typeof CANVAS.get>;
type Internals = { env: Env; teams: TeamLedger; state: PlayerState };
const inside = (instance: CanvasDO) => instance as unknown as Internals;

const O: Item = { kind: 'brick', shape: 1 };
const NEVER = 2 ** 50;
const T = 1_000_000;
const brickAt = (x: number, y: number): Op => ({
  kind: 'brick',
  x,
  y,
  shape: 1,
  rotation: 0,
  color: 3,
});

/** Exactly these items in the player's hold (the table, after a fold), cap read. */
async function stock(stub: Stub, player: string, items: readonly Item[]) {
  await runInDurableObject(stub, async (instance: CanvasDO, state) => {
    await inside(instance).teams.refreshCap(inside(instance).env.MODERATION, Date.now());
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify(items),
      NEVER,
    );
  });
}

async function rows(stub: Stub, query: string): Promise<Record<string, SqlStorageValue>[]> {
  return runInDurableObject(stub, (_, state) => state.storage.sql.exec(query).toArray());
}

/** Plays a brick and a discard as `player` of team 7: one journal row each. */
async function playAndDiscard(stub: Stub, player: string, x: number) {
  const op = await stub.applyBatch([{ player, opId: 1, op: brickAt(x, 600), team: 7 }], T);
  expect(op.results[0]!.ok).toBe(true);
  const discard = await stub.discard(player, 2, O, T);
  expect(discard.result).toEqual({ ok: true });
}

describe('player state journal (ADR 0042)', () => {
  it('keeps holds, season numbers, team credit and duplicates across a restart before a fold', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = CANVAS.get(CANVAS.idFromName('journal-restart'));
    await stock(stub, 'j1', [O, O, O]);
    await playAndDiscard(stub, 'j1', 600);
    // Two journal rows, nothing written to the tables: the stocked hold is still there.
    expect(await rows(stub, 'SELECT keys FROM state_journal ORDER BY n')).toEqual([
      { keys: 1 },
      { keys: 1 },
    ]);
    expect(await rows(stub, "SELECT items FROM inventory WHERE player = 'j1'")).toEqual([
      { items: JSON.stringify([O, O, O]) },
    ]);
    expect(await rows(stub, "SELECT * FROM player_season WHERE player = 'j1'")).toEqual([]);

    await evictDurableObject(stub);
    // Both moves are remembered: their retries are duplicates and spend nothing.
    const retry = await stub.applyBatch([{ player: 'j1', opId: 1, op: brickAt(600, 600) }], T);
    expect(retry.results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
    expect((await stub.discard('j1', 2, O, T)).result).toEqual({ ok: true, duplicate: true });
    // One item left of three, the season numbers and the day's team credit as played.
    expect((await stub.holds(['j1'], T)).get('j1')!.items).toEqual([O]);
    expect(await stub.playerSeason('j1')).toEqual({ bricks: 1, hammers: 0, shields: 0, days: 1 });
    const credit = await runInDurableObject(stub, (instance: CanvasDO) =>
      inside(instance).state.get('team_credit', 'j1'),
    );
    expect(credit?.cells).toBe(4);
  });

  it('folds each changed row into its table once, keeping only rows that hold keys', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = CANVAS.get(CANVAS.idFromName('journal-fold'));
    await stock(stub, 'f1', [O, O, O]);
    await playAndDiscard(stub, 'f1', 600);
    // A hold read that changes nothing writes no row; one that changes the hold would be a
    // row without keys, which the fold drops.
    await runInDurableObject(stub, (instance: CanvasDO) => {
      const write = (instance as unknown as { write(body: () => void): void }).write.bind(instance);
      inside(instance).state.put('player_season', 'f2', {
        bricks: 1,
        hammers: 0,
        shields: 0,
        days: 1,
        last_day: 0,
      });
      write(() => {});
    });
    expect(await rows(stub, 'SELECT keys FROM state_journal ORDER BY n')).toEqual([
      { keys: 1 },
      { keys: 1 },
      { keys: 0 },
    ]);
    await stub.tick(T);
    expect(await rows(stub, 'SELECT keys FROM state_journal ORDER BY n')).toEqual([
      { keys: 1 },
      { keys: 1 },
    ]);
    expect(await rows(stub, "SELECT items FROM inventory WHERE player = 'f1'")).toEqual([
      { items: JSON.stringify([O]) },
    ]);
    expect(
      await rows(stub, "SELECT bricks, days FROM player_season WHERE player IN ('f1', 'f2')"),
    ).toHaveLength(2);
    expect(await rows(stub, "SELECT cells FROM team_credit WHERE player = 'f1'")).toEqual([
      { cells: 4 },
    ]);
    // A start after the fold reads the tables, and the keys still answer retries.
    await evictDurableObject(stub);
    expect((await stub.holds(['f1'], T)).get('f1')!.items).toEqual([O]);
    const retry = await stub.applyBatch([{ player: 'f1', opId: 1, op: brickAt(600, 600) }], T);
    expect(retry.results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
  });

  it('splits a write whose rows pass the row size into several journal rows', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('journal-split'));
    for (const player of ['s1', 's2', 's3']) await stock(stub, player, [O, O]);
    journalLimits.rowBytes = 100;
    try {
      // One write changing three players' rows, each past the lowered size: three rows.
      await runInDurableObject(stub, (instance: CanvasDO) => {
        const state = inside(instance).state;
        for (const player of ['s1', 's2', 's3']) {
          state.put('player_season', player, {
            bricks: 1,
            hammers: 0,
            shields: 0,
            days: 1,
            last_day: 0,
          });
        }
        (instance as unknown as { write(body: () => void): void }).write(() => {});
      });
    } finally {
      journalLimits.rowBytes = JOURNAL_ROW_BYTES;
    }
    expect(await rows(stub, 'SELECT n FROM state_journal ORDER BY n')).toHaveLength(3);
    await evictDurableObject(stub);
    for (const player of ['s1', 's2', 's3']) {
      expect((await stub.playerSeason(player)).bricks).toBe(1);
    }
  });

  it('answers retries from the keys kept before ADR 0042, until the window first moves', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('journal-legacy'));
    await stock(stub, 'l1', [O, O, O]);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO accepted_ops (player, client, op_id) VALUES ('l1', '', 9)",
      );
    });
    await evictDurableObject(stub);
    const retry = await stub.applyBatch([{ player: 'l1', opId: 9, op: brickAt(600, 600) }], T);
    expect(retry.results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
    // A small window, so it moves on the second key: the old table goes then.
    await runInDurableObject(stub, (_, state) => {
      const small = new PlayerState(state.storage.sql, 1);
      state.storage.transactionSync(() => {
        small.accept('a');
        small.commit();
        small.accept('b');
        small.commit();
      });
      expect(small.accepted('x', 'l1', '', 9)).toBe(false);
    });
    expect(await rows(stub, 'SELECT n FROM accepted_ops')).toEqual([]);
  });

  it('keeps a table hold written at a later revision than the journal, as after a rollback', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('journal-revision'));
    await stock(stub, 'r1', [O, O, O]);
    await stub.applyBatch([{ player: 'r1', opId: 1, op: brickAt(600, 600) }], T);
    // A game script that ignored the journal wrote the hold since, at a higher revision.
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        "UPDATE inventory SET items = ?, revision = 50 WHERE player = 'r1'",
        JSON.stringify([O, O, O, O]),
      );
    });
    await evictDurableObject(stub);
    expect((await stub.holds(['r1'], T)).get('r1')!.items).toHaveLength(4);
  });

  it('applies only the rows after the fold on a start', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('journal-after-fold'));
    await stock(stub, 'a1', [O, O, O]);
    await stub.applyBatch([{ player: 'a1', opId: 1, op: brickAt(600, 600) }], T);
    await stub.tick(T);
    await stub.applyBatch([{ player: 'a1', opId: 2, op: brickAt(610, 600) }], T);
    await evictDurableObject(stub);
    expect((await stub.holds(['a1'], T)).get('a1')!.items).toEqual([O]);
    expect((await stub.playerSeason('a1')).bricks).toBe(2);
  });
});
