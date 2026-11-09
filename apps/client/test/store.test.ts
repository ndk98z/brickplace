import { apply, createState, encodeCell, isFilled, LINK_RIGHT, TILE_SIZE } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import { uploadRegion } from '../src/gl/renderer.ts';
import { drawMinimapTile } from '../src/map/minimap.ts';
import { MapStore } from '../src/map/store.ts';

const SIZE = 512;

/** The first index where the arrays differ, the shorter length if one is a prefix, else -1. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

describe('MapStore', () => {
  it('rejects sizes that are not whole tiles', () => {
    expect(() => new MapStore(300)).toThrow(RangeError);
  });

  it('applies diffs to the right tile and local cell', () => {
    const store = new MapStore(SIZE);
    const cell = encodeCell(5, true, false);
    // (300, 10) lies in tile (1, 0), local (44, 10).
    store.applyDiffs([{ index: 10 * SIZE + 300, cell, shield: 2 }]);
    expect(store.cell(300, 10)).toBe(cell);
    expect(store.shield(300, 10)).toBe(2);
    expect(store.cells[1]![10 * TILE_SIZE + 44]).toBe(cell);
    expect(store.cells[0]!.every((b) => b === 0)).toBe(true);
  });

  it('is idempotent: re-applying a frame changes nothing', () => {
    const store = new MapStore(SIZE);
    const tracker = store.track();
    tracker.take();
    const diffs = [{ index: 7, cell: encodeCell(1, false, false), shield: 0 }];
    expect(store.applyDiffs(diffs)).toBe(1);
    expect(tracker.take().size).toBe(1);
    expect(store.applyDiffs(diffs)).toBe(0);
    expect(tracker.size).toBe(0);
  });

  it('ignores indices outside the map', () => {
    const store = new MapStore(SIZE);
    expect(store.applyDiffs([{ index: SIZE * SIZE, cell: 0x80, shield: 0 }])).toBe(0);
    expect(store.applyDiffs([{ index: -1, cell: 0x80, shield: 0 }])).toBe(0);
  });

  it('matches the core grid after replaying the core diffs', () => {
    const open = { x: 0, y: 0, w: SIZE, h: SIZE };
    const state = createState({ size: SIZE, open, maxShield: 5 });
    const store = new MapStore(SIZE);
    const ops = [
      { kind: 'brick', x: 254, y: 254, shape: 1, rotation: 0, color: 3 },
      { kind: 'brick', x: 10, y: 10, shape: 0, rotation: 1, color: 7 },
      { kind: 'shield', x: 255, y: 255 },
      { kind: 'hammer', x: 10, y: 11 },
      // A flat I brick across the x = 255 / 256 tile edge.
      { kind: 'brick', x: 254, y: 20, shape: 0, rotation: 0, color: 12 },
    ] as const;
    for (const op of ops) {
      const result = apply(state, op);
      expect(result.ok).toBe(true);
      if (result.ok) store.applyDiffs(result.diffs);
    }
    const cells = new Uint8Array(SIZE * SIZE);
    const shields = new Uint8Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        cells[y * SIZE + x] = store.cell(x, y);
        shields[y * SIZE + x] = store.shield(x, y);
      }
    }
    // A byte loop: toEqual on 512² arrays takes seconds on a 2-CPU CI runner.
    expect(firstDifference(cells, state.cells)).toBe(-1);
    expect(firstDifference(shields, state.shields)).toBe(-1);
    // The link from the last column of tile 0 into the first column of tile 1 is kept, and
    // the cell it links to lives in tile 1's own buffer.
    expect(store.cells[0]![20 * TILE_SIZE + 255]! & LINK_RIGHT).toBe(LINK_RIGHT);
    expect(isFilled(store.cells[1]![20 * TILE_SIZE + 0]!)).toBe(true);
  });

  it('reset clears every cell and marks every tile dirty', () => {
    const store = new MapStore(SIZE);
    const tracker = store.track();
    store.applyDiffs([{ index: 3, cell: 0x80, shield: 1 }]);
    tracker.take();
    store.reset();
    expect(store.cell(3, 0)).toBe(0);
    expect(tracker.take().size).toBe(store.tileCount);
  });

  it('notifies subscribers once per changing batch', () => {
    const store = new MapStore(SIZE);
    let calls = 0;
    store.subscribe(() => calls++);
    store.applyDiffs([
      { index: 1, cell: 0x80, shield: 0 },
      { index: 2, cell: 0x80, shield: 0 },
    ]);
    store.applyDiffs([{ index: 1, cell: 0x80, shield: 0 }]);
    expect(calls).toBe(1);
  });
});

describe('dirty tracking and texture uploads', () => {
  it('a new tracker starts with every tile dirty', () => {
    const store = new MapStore(SIZE);
    expect(store.track().take().size).toBe(4);
  });

  it('grows one rect per tile to cover every changed cell', () => {
    const store = new MapStore(SIZE);
    const tracker = store.track();
    tracker.take();
    const at = (x: number, y: number) => y * SIZE + x;
    store.applyDiffs([
      { index: at(5, 9), cell: 0x80, shield: 0 },
      { index: at(20, 3), cell: 0x80, shield: 0 },
      { index: at(300, 300), cell: 0x80, shield: 0 },
    ]);
    const dirty = tracker.take();
    expect([...dirty.keys()].sort()).toEqual([0, 3]);
    expect(dirty.get(0)).toEqual({ x0: 5, y0: 3, x1: 20, y1: 9 });
    expect(dirty.get(3)).toEqual({ x0: 44, y0: 44, x1: 44, y1: 44 });
  });

  it('turns a dirty rect into texSubImage2D arguments over the 256-wide tile buffer', () => {
    expect(uploadRegion({ x0: 5, y0: 3, x1: 20, y1: 9 })).toEqual({
      x: 5,
      y: 3,
      width: 16,
      height: 7,
      offset: 3 * TILE_SIZE + 5,
    });
  });

  it('trackers are independent', () => {
    const store = new MapStore(SIZE);
    const a = store.track();
    const b = store.track();
    a.take();
    b.take();
    store.applyDiffs([{ index: 0, cell: 0x80, shield: 0 }]);
    a.take();
    expect(b.size).toBe(1);
    store.untrack(b);
    store.applyDiffs([{ index: 1, cell: 0x80, shield: 0 }]);
    expect(a.size).toBe(1);
  });
});

describe('minimap', () => {
  it('shows filled blocks in their colour and empty blocks as background', () => {
    const store = new MapStore(SIZE);
    const red = encodeCell(0, false, false); // palette #1, #E8384F
    const diffs = [];
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) diffs.push({ index: y * SIZE + x, cell: red, shield: 0 });
    store.applyDiffs(diffs);
    expect(isFilled(store.cell(0, 0))).toBe(true);
    const side = SIZE / 8;
    const out = new Uint8ClampedArray(side * side * 4);
    drawMinimapTile(store, 0, 8, { x: 0, y: 0, w: 256, h: 256 }, out, side);
    expect([...out.slice(0, 4)]).toEqual([0xe8, 0x38, 0x4f, 255]);
    expect([...out.slice(4, 8)]).toEqual([255, 255, 255, 255]);
    // Tile 1 is outside the open area and was not drawn yet.
    drawMinimapTile(store, 1, 8, { x: 0, y: 0, w: 256, h: 256 }, out, side);
    expect([...out.slice(32 * 4, 32 * 4 + 4)]).toEqual([0xd6, 0xdc, 0xe7, 255]);
  });
});
