import { describe, expect, it } from 'vitest';
import { Spread } from '../src/net/spread.ts';

// Ten cells per "tile", so tests can place cells in tiles by index.
const tileOf = (index: number) => Math.floor(index / 10);
const seqOf = (tile: number) => 100 + tile;
/** A fixed order: random() always 0 shuffles the batch one way, deterministically. */
const zero = () => 0;

const diff = (index: number, cell: number) => ({ index, cell, shield: 0 });

describe('Spread', () => {
  it('spreads a batch evenly over the interval, each change once', () => {
    const spread = new Spread();
    spread.add([diff(1, 5), diff(2, 6), diff(3, 7), diff(4, 8)], 1000, 2000, zero, tileOf, seqOf);
    expect(spread.size).toBe(4);
    expect(spread.nextDue).toBe(1500);
    expect(spread.take(1499)).toEqual([]);
    expect(spread.take(1500)).toHaveLength(1);
    expect(spread.take(2500)).toHaveLength(2);
    expect(spread.take(3000)).toHaveLength(1);
    expect(spread.size).toBe(0);
    expect(spread.nextDue).toBeNull();
  });

  it('draws the batch in shuffled order, not cell order', () => {
    const spread = new Spread();
    const diffs = Array.from({ length: 20 }, (_, i) => diff(i, 1));
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    spread.add(diffs, 0, 2000, random, tileOf, seqOf);
    const order = spread.take().map((d) => d.index);
    expect([...order].sort((a, b) => a - b)).toEqual(diffs.map((d) => d.index));
    expect(order).not.toEqual(diffs.map((d) => d.index));
  });

  it('keeps only the newest value of a cell, within a batch and across batches', () => {
    const spread = new Spread();
    spread.add([diff(1, 5), diff(2, 6), diff(1, 9)], 0, 2000, zero, tileOf, seqOf);
    expect(spread.size).toBe(2);
    spread.add([diff(2, 4)], 500, 2000, zero, tileOf, seqOf);
    const all = spread.take();
    expect(all).toHaveLength(2);
    expect(all.find((d) => d.index === 1)?.cell).toBe(9);
    expect(all.find((d) => d.index === 2)?.cell).toBe(4);
  });

  it('merges a new batch with what still waits, by due time', () => {
    const spread = new Spread();
    spread.add([diff(1, 1), diff(2, 1)], 0, 2000, zero, tileOf, seqOf); // due 1000, 2000
    spread.add([diff(3, 1), diff(4, 1)], 1500, 2000, zero, tileOf, seqOf); // due 2500, 3500
    expect(spread.take(1000)).toHaveLength(1);
    expect(spread.take(2000)).toHaveLength(1);
    expect(spread.nextDue).toBe(2500);
  });

  it('draws cells linked to each other in one step, and other cells in steps of their own', () => {
    const spread = new Spread();
    // 1-2-3 linked in a chain (one brick); 5 alone; 7 linked to 8, which is not in the batch.
    const links = new Map([
      [1, [2]],
      [2, [3]],
      [7, [8]],
    ]);
    spread.add(
      [diff(1, 1), diff(2, 1), diff(3, 1), diff(5, 1), diff(7, 1)],
      0,
      3000,
      zero,
      tileOf,
      seqOf,
      (index) => links.get(index) ?? [],
    );
    const steps = [1000, 2000, 3000].map((t) =>
      spread
        .take(t)
        .map((d) => d.index)
        .sort(),
    );
    expect(steps.map((s) => s.length).sort()).toEqual([1, 1, 3]);
    expect(steps.find((s) => s.length === 3)).toEqual([1, 2, 3]);
  });

  it('takes what waits for some tiles at once, oldest first, leaving the others', () => {
    const spread = new Spread();
    spread.add([diff(1, 1), diff(11, 1)], 0, 2000, zero, tileOf, seqOf);
    spread.add([diff(2, 1)], 100, 2000, zero, tileOf, seqOf);
    expect(
      spread
        .takeTiles(new Set([0]))
        .map((d) => d.index)
        .sort(),
    ).toEqual([1, 2]);
    expect(spread.size).toBe(1);
    expect(spread.discard()).toEqual(new Map([[1, 101]]));
  });

  it('drops the changes of tiles reloaded whole, and their rollback seqs', () => {
    const spread = new Spread();
    spread.add([diff(1, 1), diff(11, 1), diff(12, 1)], 0, 2000, zero, tileOf, seqOf);
    spread.drop(new Set([1]));
    expect(spread.size).toBe(1);
    expect(spread.take().map((d) => d.index)).toEqual([1]);
  });

  it('on discard, says which seq each tile with changes waiting is surely at', () => {
    const spread = new Spread();
    spread.add([diff(1, 1), diff(21, 1)], 0, 2000, zero, tileOf, seqOf);
    // A later batch for tile 0 keeps the seq from before the first one.
    spread.add([diff(2, 1)], 100, 2000, zero, tileOf, () => 999);
    expect(spread.discard()).toEqual(
      new Map([
        [0, 100],
        [2, 102],
      ]),
    );
    expect(spread.size).toBe(0);
    expect(spread.discard().size).toBe(0);
  });

  it('forgets rollback seqs once everything waiting is drawn', () => {
    const spread = new Spread();
    spread.add([diff(1, 1)], 0, 2000, zero, tileOf, seqOf);
    spread.take();
    expect(spread.discard().size).toBe(0);
  });

  it("forgets a tile's rollback seq once its own last change is drawn, others waiting or not", () => {
    const spread = new Spread();
    // Tile 0 (cells 1, 2) and tile 1 (cell 11), spread over 3 steps of 1000 ms.
    spread.add([diff(1, 1), diff(2, 1), diff(11, 1)], 0, 3000, zero, tileOf, seqOf);
    // A newer value for cell 1 replaces the waiting one: still two cells of tile 0 waiting.
    spread.add([diff(1, 2)], 0, 3000, zero, tileOf, seqOf);
    expect([spread.baseOf(0), spread.baseOf(1)]).toEqual([100, 101]);
    spread.take(1500);
    spread.take(2500);
    spread.take(3500);
    // Drawn as they came due; each tile forgets its base once nothing of it waits.
    const left = [spread.baseOf(0), spread.baseOf(1)];
    expect(left.filter((b) => b !== undefined).length).toBeLessThanOrEqual(1);
    spread.take();
    expect([spread.baseOf(0), spread.baseOf(1)]).toEqual([undefined, undefined]);
  });

  it('keeps the rollback seq of a tile with changes still waiting, after another tile drains', () => {
    const spread = new Spread();
    // Three groups due at 1000, 2000 and 3000 ms: whichever tile drains first, the other stays.
    spread.add([diff(1, 1), diff(11, 1), diff(12, 1)], 0, 3000, zero, tileOf, seqOf);
    let both = true;
    for (const at of [1000, 2000, 3000]) {
      spread.take(at);
      const bases = [spread.baseOf(0), spread.baseOf(1)];
      if (bases.includes(undefined)) both = false;
      if (!both && spread.size > 0) {
        // The tile with changes left keeps its base.
        expect(bases.filter((b) => b !== undefined)).toHaveLength(1);
      }
    }
    expect(spread.size).toBe(0);
  });
});
