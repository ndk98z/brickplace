import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Item, Op } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/index.ts';
import { foldNow, PlayerState } from '../src/journal.ts';
import { countMoves, readSeasonNumbers } from '../src/season-numbers.ts';

// The profile's "Your season" numbers (ADR 0031): moves the canvas accepted, by kind, and the
// days a player made one.

const { CANVAS } = env as unknown as Env;
type Stub = ReturnType<typeof CANVAS.get>;
const T = 1_000_000;
const DAY = 24 * 60 * 60 * 1000;
const O: Item = { kind: 'brick', shape: 1 };
const HAMMER: Item = { kind: 'hammer' };
const SHIELD: Item = { kind: 'shield' };
const brickAt = (x: number, y = 600) =>
  ({ kind: 'brick', x, y, shape: 1, rotation: 0, color: 3 }) as Op;
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

describe('season numbers', () => {
  it('counts accepted moves by kind and the days they were made on', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('numbers-count'));
    await stock(stub, 'p1', [O, O, SHIELD], T);
    const first = await stub.applyBatch(
      [
        by('p1', 1, brickAt(600)),
        by('p1', 2, brickAt(610)),
        by('p1', 3, { kind: 'shield', x: 600, y: 600 }),
      ],
      T,
    );
    expect(first.results.map((r) => r.ok)).toEqual([true, true, true]);
    // The same day: no new day. Nothing in the hold: refused, counts nothing.
    expect(
      (await stub.applyBatch([by('p1', 4, brickAt(620))], T + 1_000)).results[0],
    ).toMatchObject({ ok: false, reason: 'no_item' });
    expect(await stub.playerSeason('p1')).toEqual({ bricks: 2, hammers: 0, shields: 1, days: 1 });
    // The next day: a hammer and a brick, and a discard that counts as no move.
    await stock(stub, 'p1', [HAMMER, O, O], T + DAY);
    const next = await stub.applyBatch(
      [by('p1', 5, { kind: 'hammer', x: 610, y: 600 }), by('p1', 6, brickAt(630))],
      T + DAY,
    );
    expect(next.results.map((r) => r.ok)).toEqual([true, true]);
    expect((await stub.discard('p1', 7, O, T + DAY)).result.ok).toBe(true);
    // A retry of an accepted op is a duplicate: counted once.
    await stub.applyBatch([by('p1', 6, brickAt(630))], T + DAY);
    expect(await stub.playerSeason('p1')).toEqual({ bricks: 3, hammers: 1, shields: 1, days: 2 });
    // Someone with no move, or no identity at all: zeros.
    expect(await stub.playerSeason('p2')).toEqual({ bricks: 0, hammers: 0, shields: 0, days: 0 });
    expect(await stub.playerSeason('')).toEqual({ bricks: 0, hammers: 0, shields: 0, days: 0 });
  });

  it('keeps each player apart within one batch', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('numbers-players'));
    await stock(stub, 'a1', [O], T);
    await stock(stub, 'b1', [O, O], T);
    await stub.applyBatch(
      [
        by('a1', 1, brickAt(600, 650)),
        by('b1', 1, brickAt(610, 650)),
        by('b1', 2, brickAt(620, 650)),
      ],
      T,
    );
    expect((await stub.playerSeason('a1')).bricks).toBe(1);
    expect((await stub.playerSeason('b1')).bricks).toBe(2);
  });

  it('counts a day once when the clock steps back over midnight and forward again', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('numbers-skew'));
    const move = [{ player: 'c1', op: brickAt(600) }];
    await runInDurableObject(stub, (_, state) => {
      const rows = new PlayerState(state.storage.sql).store('player_season');
      countMoves(rows, move, T + DAY);
      countMoves(rows, move, T + DAY - 1_000);
      countMoves(rows, move, T + DAY + 1_000);
      expect(readSeasonNumbers(rows, 'c1')).toEqual({ bricks: 3, hammers: 0, shields: 0, days: 1 });
      countMoves(rows, move, T + 2 * DAY);
      expect(readSeasonNumbers(rows, 'c1').days).toBe(2);
    });
  });
});
