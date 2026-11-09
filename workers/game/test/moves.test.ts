import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DEFAULT_ITEM_CONFIG, type Item, type Op } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';

// ADR 0043: a shard relays ops and discards to the canvas in one call (applyMoves). A discard
// takes the item from the hold, is remembered like an op (a retry is a duplicate) and is
// never logged; discard() answers the same way through the same path.

const { CANVAS } = env as unknown as Env;
type Stub = ReturnType<typeof CANVAS.get>;
const MIN = DEFAULT_ITEM_CONFIG.cooldown;
const T = 1_000_000;
const O: Item = { kind: 'brick', shape: 1 };
const HAMMER: Item = { kind: 'hammer' };
const SHIELD: Item = { kind: 'shield' };
const brickAt = (x: number) =>
  ({ kind: 'brick', x, y: 600, shape: 1, rotation: 0, color: 3 }) as Op;
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

type Result = Awaited<ReturnType<Stub['applyMoves']>>['results'][number];
const outcome = (r: Result) => (r.ok ? ('duplicate' in r ? 'duplicate' : 'ok') : r.reason);

describe('CanvasDO moves with discards (ADR 0043)', () => {
  it('takes ops and discards in one call, logs the ops only and remembers both', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('moves-mixed'));
    // Cooldowns started at T: nothing is drawn during the test.
    await stock(stub, 'm1', [O, SHIELD, HAMMER], T);
    await stock(stub, 'm2', [SHIELD], T);
    const batch = await stub.applyMoves(
      [
        by('m1', 1, brickAt(600)),
        { player: 'm2', opId: 1, discard: SHIELD },
        { player: 'm1', opId: 2, discard: HAMMER },
        // The same discard again in one call: a duplicate, paid for once.
        { player: 'm1', opId: 2, discard: HAMMER },
        // Nothing of that kind held.
        { player: 'm2', opId: 2, discard: O },
      ],
      T,
    );
    expect(batch.results.map(outcome)).toEqual(['ok', 'ok', 'ok', 'duplicate', 'no_item']);
    expect(batch.results[1]).toEqual({ ok: true, diffs: [] });
    expect(batch.holds.get('m1')).toMatchObject({ items: [SHIELD] });
    expect(batch.holds.get('m2')).toMatchObject({ items: [] });
    // One log row and one seq: the op's. The discards are not in the log.
    expect(batch.seq).toBe(1);
    const rows = await runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ ops: string }>('SELECT ops FROM op_log ORDER BY seq')
        .toArray()
        .map((row) => JSON.parse(row.ops)),
    );
    expect(rows).toEqual([[brickAt(600)]]);
    // A call of discards only moves no seq.
    const only = await stub.applyMoves([{ player: 'm1', opId: 3, discard: SHIELD }], T + 1);
    expect(only.results[0]).toEqual({ ok: true, diffs: [] });
    expect(only.seq).toBe(1);
    expect(only.holds.get('m1')).toMatchObject({ items: [] });
    // Every accepted move is remembered across a restart: retries apply nothing.
    await evictDurableObject(stub);
    const retry = await stub.applyMoves(
      [
        by('m1', 1, brickAt(600)),
        { player: 'm2', opId: 1, discard: SHIELD },
        { player: 'm1', opId: 2, discard: HAMMER },
        { player: 'm1', opId: 3, discard: SHIELD },
      ],
      T + 2,
    );
    expect(retry.results.map(outcome)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
    expect(retry.seq).toBe(1);
    expect(retry.holds.get('m1')).toMatchObject({ items: [] });
  });

  it('answers a discard through discard() as applyMoves does', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('moves-discard'));
    await stock(stub, 'd1', [HAMMER], T);
    expect(await stub.discard('d1', 1, HAMMER, T, 'tab')).toMatchObject({
      result: { ok: true },
      hold: { items: [], nextAt: T + MIN },
    });
    // The key is shared with applyMoves: the same discard there is a duplicate.
    const again = await stub.applyMoves(
      [{ player: 'd1', client: 'tab', opId: 1, discard: HAMMER }],
      T + 1,
    );
    expect(again.results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
    expect(await stub.discard('d1', 2, HAMMER, T + 2, 'tab')).toMatchObject({
      result: { ok: false, reason: 'no_item' },
      hold: { items: [] },
    });
    expect((await stub.discard('', 3, HAMMER, T)).result).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
