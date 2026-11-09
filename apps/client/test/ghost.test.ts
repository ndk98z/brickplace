import {
  apply,
  canCover,
  createState,
  encodeCell,
  LINK_DOWN,
  LINK_RIGHT,
  ROTATIONS,
  type Rotation,
  type ShapeId,
} from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import { ghostUniform } from '../src/gl/renderer.ts';
import {
  brickCells,
  coverable,
  ghostFor,
  pivotOf,
  SIDE_DOWN,
  SIDE_LEFT,
  SIDE_RIGHT,
  SIDE_UP,
} from '../src/map/ghost.ts';
import { MapStore } from '../src/map/store.ts';
import { noticeFor } from '../src/net/messages.ts';

const SIZE = 256;
const rules = { open: { x: 0, y: 0, w: SIZE, h: SIZE }, maxShield: 2 };
const all = ROTATIONS.flatMap((rots, shape) =>
  rots.map((_, rotation) => [shape as ShapeId, rotation as Rotation] as const),
);

describe('brick ghost cells', () => {
  it('always puts the cursor cell inside the brick', () => {
    for (const [shape, rotation] of all) {
      const { cells } = brickCells(shape, rotation, 50, 60);
      expect(cells.some((c) => c.x === 50 && c.y === 60)).toBe(true);
    }
  });

  it('picks the cell nearest the bounding-box centre as the pivot', () => {
    expect(pivotOf(2, 0)).toEqual([1, 0]); // T: the stem's top
    expect(pivotOf(5, 0)).toEqual([1, 1]); // J: middle of the long side
  });

  it('covers exactly the cells the core fills for the same op', () => {
    for (const [shape, rotation] of all) {
      const state = createState({ size: SIZE, open: rules.open, maxShield: 2 });
      const store = new MapStore(SIZE);
      const ghost = ghostFor({ kind: 'brick', shape, rotation, color: 9 }, 100, 100, store, rules);
      expect(ghost.problem).toBeNull();
      const result = apply(state, ghost.op);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const filled = result.diffs.map((d) => [d.index % SIZE, Math.floor(d.index / SIZE)]);
      expect(ghost.cells.map((c) => [c.x, c.y]).sort()).toEqual(filled.sort());
      // Ghost sides agree with the link bits the core writes.
      for (const c of ghost.cells) {
        const cell = state.cells[c.y * SIZE + c.x]!;
        expect((c.sides & SIDE_RIGHT) !== 0).toBe((cell & LINK_RIGHT) !== 0);
        expect((c.sides & SIDE_DOWN) !== 0).toBe((cell & LINK_DOWN) !== 0);
      }
    }
  });

  it('marks joined sides in both directions', () => {
    // I brick lying flat: inner cells join left and right, the ends join one side.
    const { cells } = brickCells(0, 0, 10, 10);
    expect(cells.map((c) => c.sides)).toEqual([
      SIDE_RIGHT,
      SIDE_LEFT | SIDE_RIGHT,
      SIDE_LEFT | SIDE_RIGHT,
      SIDE_LEFT,
    ]);
    const square = brickCells(1, 0, 10, 10).cells;
    expect(square[0]!.sides).toBe(SIDE_RIGHT | SIDE_DOWN);
    expect(square[3]!.sides).toBe(SIDE_LEFT | SIDE_UP);
  });

  it('packs ghost cells for the shader uniform', () => {
    const store = new MapStore(SIZE);
    const ghost = ghostFor({ kind: 'brick', shape: 1, rotation: 0, color: 0 }, 5, 5, store, rules);
    expect([...ghostUniform(ghost)]).toEqual([
      5,
      5,
      SIDE_RIGHT | SIDE_DOWN,
      6,
      5,
      SIDE_LEFT | SIDE_DOWN,
      5,
      6,
      SIDE_RIGHT | SIDE_UP,
      6,
      6,
      SIDE_LEFT | SIDE_UP,
    ]);
  });
});

describe('ghost problems (local hint only)', () => {
  const brick = { kind: 'brick', shape: 1, rotation: 0, color: 0 } as const;

  const small = { ...rules, open: { x: 10, y: 10, w: 10, h: 10 } };

  it('blocks bricks that leave the map', () => {
    const store = new MapStore(SIZE);
    expect(ghostFor(brick, 255, 0, store, rules)).toMatchObject({
      problem: 'out_of_area',
      blocking: true,
    });
  });

  it('only warns outside the open area, which the server may have grown', () => {
    const store = new MapStore(SIZE);
    expect(ghostFor(brick, 19, 15, store, small)).toMatchObject({
      problem: 'out_of_area',
      blocking: false,
    });
    expect(ghostFor(brick, 12, 12, store, small)).toMatchObject({ problem: null, blocking: false });
  });

  it('blocks bricks over filled cells', () => {
    const store = new MapStore(SIZE);
    store.applyDiffs([{ index: 6 * SIZE + 6, cell: encodeCell(1, false, false), shield: 0 }]);
    expect(ghostFor(brick, 5, 5, store, rules)).toMatchObject({
      problem: 'occupied',
      blocking: true,
    });
  });

  it('hammer and shield target one filled cell', () => {
    const store = new MapStore(SIZE);
    expect(ghostFor({ kind: 'hammer' }, 3, 3, store, rules)).toMatchObject({
      op: { kind: 'hammer', x: 3, y: 3 },
      problem: 'empty',
      blocking: true,
    });
    store.applyDiffs([{ index: 3 * SIZE + 3, cell: encodeCell(1, false, false), shield: 2 }]);
    expect(ghostFor({ kind: 'hammer' }, 3, 3, store, rules).problem).toBeNull();
    expect(ghostFor({ kind: 'shield' }, 3, 3, store, rules)).toMatchObject({
      problem: 'shield_full',
      blocking: true,
    });
    // A filled cell outside the assumed open area: warn, still send.
    expect(ghostFor({ kind: 'hammer' }, 3, 3, store, small)).toMatchObject({
      problem: 'out_of_area',
      blocking: false,
    });
  });

  it('warns over a locked area without blocking, after every other problem (ADR 0024)', () => {
    const store = new MapStore(SIZE);
    const locked = { ...rules, locks: [{ x: 10, y: 10, w: 4, h: 4 }] };
    const brick = { kind: 'brick', shape: 1, rotation: 0, color: 3 } as const;
    // One cell of the brick reaches into the lock.
    expect(ghostFor(brick, 9, 9, store, locked)).toMatchObject({
      problem: 'locked',
      blocking: false,
    });
    expect(ghostFor(brick, 20, 20, store, locked).problem).toBeNull();
    // An empty cell is still `empty` for a hammer, even in the lock.
    expect(ghostFor({ kind: 'hammer' }, 11, 11, store, locked)).toMatchObject({
      problem: 'empty',
      blocking: true,
    });
    store.applyDiffs([{ index: 11 * SIZE + 11, cell: encodeCell(1, false, false), shield: 0 }]);
    expect(ghostFor({ kind: 'hammer' }, 11, 11, store, locked).problem).toBe('locked');
    expect(noticeFor('locked', 'hammer').title).toBe('This area is locked');
  });
});

describe('single brick', () => {
  const single = { kind: 'single', color: 4 } as const;

  it('finds coverable cells exactly like the core', () => {
    const open = { x: 8, y: 8, w: 40, h: 40 };
    const state = createState({ size: SIZE, open, maxShield: 2 });
    const store = new MapStore(SIZE);
    // Fill most of the area with bricks so holes of every size appear.
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 900; i++) {
      const op = {
        kind: 'brick',
        x: open.x + next(open.w),
        y: open.y + next(open.h),
        shape: next(7) as ShapeId,
        rotation: next(4) as Rotation,
        color: next(32),
      } as const;
      const result = apply(state, op);
      if (result.ok) store.applyDiffs(result.diffs);
    }
    let holes = 0;
    for (let y = 0; y < 56; y++) {
      for (let x = 0; x < 56; x++) {
        const mine = coverable(store, open, x, y);
        expect(mine, `cell ${x},${y}`).toBe(canCover(state, x, y));
        if (!mine && !store.cell(x, y) && x >= 8 && y >= 8 && x < 48 && y < 48) holes++;
      }
    }
    expect(holes).toBeGreaterThan(0);
  });

  it('blocks on a cell a brick could still cover, or a filled one', () => {
    const store = new MapStore(SIZE);
    expect(ghostFor(single, 50, 50, store, rules)).toMatchObject({
      op: { kind: 'single', x: 50, y: 50, color: 4 },
      problem: 'coverable',
      blocking: true,
    });
    store.applyDiffs([{ index: 50 * SIZE + 50, cell: encodeCell(1, false, false), shield: 0 }]);
    expect(ghostFor(single, 50, 50, store, rules)).toMatchObject({
      problem: 'occupied',
      blocking: true,
    });
  });

  it('accepts a hole no brick can reach', () => {
    const store = new MapStore(SIZE);
    // (50, 50) walled in on all four sides.
    const wall = [
      [49, 50],
      [51, 50],
      [50, 49],
      [50, 51],
    ];
    store.applyDiffs(
      wall.map(([x, y]) => ({
        index: y! * SIZE + x!,
        cell: encodeCell(1, false, false),
        shield: 0,
      })),
    );
    expect(ghostFor(single, 50, 50, store, rules)).toMatchObject({
      problem: null,
      blocking: false,
    });
  });
});
