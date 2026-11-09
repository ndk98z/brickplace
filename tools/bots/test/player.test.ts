import {
  apply,
  canCover,
  cellsOf,
  colorOf,
  createState,
  type Item,
  type Op,
  type Rotation,
  type ShapeId,
  type State,
} from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import { type Art, lookAt, makeArt, NONE, randomArt, targetAt } from '../src/art.ts';
import { contains, Mirror } from '../src/mirror.ts';
import { PLAYER_KINDS, Player, type World } from '../src/player.ts';
import { Rng } from '../src/rng.ts';

const SIZE = 128;
const OPEN = { x: 16, y: 16, w: 96, h: 96 };

/** The core's map with some random bricks and shields, as the server would hold it. */
function playedState(rng: Rng, bricks: number): State {
  const state = createState({ size: SIZE, open: OPEN, maxShield: 3 });
  for (let i = 0; i < bricks; i++) {
    apply(state, {
      kind: 'brick',
      x: OPEN.x + rng.int(OPEN.w),
      y: OPEN.y + rng.int(OPEN.h),
      shape: rng.int(7) as ShapeId,
      rotation: rng.int(4) as Rotation,
      color: rng.int(32),
    });
    if (rng.chance(0.2))
      apply(state, { kind: 'shield', x: OPEN.x + rng.int(OPEN.w), y: OPEN.y + rng.int(OPEN.h) });
  }
  return state;
}

/** The bots' copy of that map. */
function mirrorOf(state: State): Mirror {
  const mirror = new Mirror(SIZE, OPEN, state.config.maxShield);
  mirror.replace(state.cells.slice(), state.shields.slice());
  mirror.ready = true;
  return mirror;
}

const ITEMS: Item[] = [
  ...Array.from({ length: 7 }, (_, shape) => ({ kind: 'brick', shape: shape as ShapeId }) as const),
  { kind: 'single' },
  { kind: 'hammer' },
  { kind: 'shield' },
];

describe('the mirror', () => {
  it('tells holes from coverable cells exactly as the core does', () => {
    const state = playedState(new Rng(7), 1500);
    const mirror = mirrorOf(state);
    let holes = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        expect(mirror.canCover(x, y), `${x},${y}`).toBe(canCover(state, x, y));
        if (mirror.isHole(x, y)) holes++;
      }
    }
    expect(holes).toBeGreaterThan(0);
  });

  it('keeps ops out of locked areas', () => {
    const mirror = mirrorOf(createState({ size: SIZE, open: OPEN, maxShield: 3 }));
    mirror.setConfig({
      type: 'config',
      mapSize: SIZE,
      open: OPEN,
      maxShield: 3,
      locks: [{ x: 20, y: 20, w: 4, h: 4 }],
    });
    expect(mirror.playable(21, 21)).toBe(false);
    expect(mirror.fits(19, 20, 0, 0)).toBe(false);
    expect(mirror.fits(30, 30, 0, 0)).toBe(true);
  });
});

describe('players', () => {
  it('only propose ops the core accepts, inside their view', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const rng = new Rng(seed);
      const state = playedState(rng, 300 + seed * 150);
      const mirror = mirrorOf(state);
      const arts = [
        randomArt(rng, { x: 30, y: 30, w: 24, h: 24 }),
        randomArt(rng, { x: 70, y: 60, w: 24, h: 24 }),
      ];
      const world: World = { mirror, arts, rng, now: 0 };
      let proposed = 0;
      for (const kind of PLAYER_KINDS) {
        const player = new Player(kind, seed % 2, world);
        for (const item of ITEMS) {
          for (let k = 0; k < 4; k++) {
            const view = player.view(world);
            const op = player.move(item, { ...world, now: proposed });
            if (!op) continue;
            proposed++;
            expect(op.kind).toBe(item.kind);
            expect(
              cellsTouched(op).every(([x, y]) => contains(view, x, y)),
              `${kind} ${JSON.stringify(op)}`,
            ).toBe(true);
            const before = state.cells.slice();
            const result = apply(state, op);
            expect(result.ok ? 'ok' : result.reason, `${kind} ${JSON.stringify(op)}`).toBe('ok');
            mirror.applyDiffs(result.ok ? result.diffs : []);
            expect(
              state.cells.some((c, i) => c !== before[i]) ||
                op.kind === 'shield' ||
                op.kind === 'hammer',
            ).toBe(true);
          }
        }
      }
      expect(proposed).toBeGreaterThan(50);
    }
  });

  it('builders draw an image: exact bricks first, then the cells where colours meet', () => {
    const rng = new Rng(3);
    const state = createState({ size: SIZE, open: OPEN, maxShield: 3 });
    const mirror = mirrorOf(state);
    // Two colour bands and a transparent column: a strict artwork, as from a PNG.
    const rect = { x: 40, y: 40, w: 20, h: 12 };
    const target = new Int8Array(rect.w * rect.h).map((_, i) => {
      const x = i % rect.w;
      const y = Math.floor(i / rect.w);
      return x === 10 ? NONE : y < 6 ? 5 : 17;
    });
    const art: Art = makeArt(rect, target, true);
    const world: World = { mirror, arts: [art], rng, now: 0 };
    const builders = Array.from({ length: 8 }, () => new Player('builder', 0, world));
    let now = 0;
    let offWhileRoomy = 0;
    const outside = new Set<number>();
    for (let turn = 0; turn < 3000; turn++) {
      const player = builders[turn % builders.length]!;
      const roll = rng.int(10);
      const item: Item =
        roll < 8
          ? { kind: 'brick', shape: rng.int(7) as ShapeId }
          : roll < 9
            ? { kind: 'single' }
            : { kind: 'hammer' };
      now += 1000;
      const roomy = lookAt(art, mirror, now).empty.length * 4 > art.cells;
      const op = player.move(item, { ...world, now });
      if (!op) continue;
      const result = apply(state, op);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      mirror.applyDiffs(result.diffs);
      if (op.kind === 'brick' || op.kind === 'single') {
        for (const [x, y] of cellsTouched(op)) {
          const wanted = targetAt(art, x, y);
          if (wanted === NONE) outside.add(y * SIZE + x);
          else if (roomy && colorOf(state.cells[y * SIZE + x]!) !== wanted) offWhileRoomy++;
        }
      }
    }
    // While there is room, every brick matches the picture exactly.
    expect(offWhileRoomy).toBe(0);
    const look = lookAt(art, mirror, Number.POSITIVE_INFINITY);
    expect(look.correct.length / art.cells).toBeGreaterThan(0.9);
    // An image's builders keep their bricks to it: at most a brick's spill past its edges.
    for (const index of outside) {
      const x = index % SIZE;
      const y = (index - x) / SIZE;
      expect(
        x >= rect.x - 3 && y >= rect.y - 3 && x < rect.x + rect.w + 3 && y < rect.y + rect.h + 3,
      ).toBe(true);
    }
  });

  it('hammer wrong cells and shield right ones, as builders and repairers', () => {
    const rng = new Rng(5);
    const state = createState({ size: SIZE, open: OPEN, maxShield: 3 });
    const rect = { x: 40, y: 40, w: 8, h: 8 };
    const art = makeArt(rect, new Int8Array(64).fill(9));
    // The whole artwork filled with bricks of colour 9, but one brick in colour 2.
    for (let y = 0; y < 8; y += 2) {
      for (let x = 0; x < 8; x += 2) {
        apply(state, {
          kind: 'brick',
          x: 40 + x,
          y: 40 + y,
          shape: 1,
          rotation: 0,
          color: x === 2 && y === 4 ? 2 : 9,
        });
      }
    }
    const mirror = mirrorOf(state);
    const world: World = { mirror, arts: [art], rng, now: 0 };
    const repairer = new Player('repairer', 0, world);
    for (let i = 0; i < 10; i++) {
      const hammer = repairer.move({ kind: 'hammer' }, world);
      expect(hammer?.kind).toBe('hammer');
      expect(targetAt(art, hammer!.x, hammer!.y)).toBe(9);
      expect(colorOf(state.cells[hammer!.y * SIZE + hammer!.x]!)).toBe(2);
      const shield = repairer.move({ kind: 'shield' }, world);
      expect(colorOf(state.cells[shield!.y * SIZE + shield!.x]!)).toBe(9);
    }
  });
});

/** The cells an op touches. */
function cellsTouched(op: Op): (readonly [number, number])[] {
  if (op.kind !== 'brick') return [[op.x, op.y]];
  return cellsOf(op.shape, op.rotation).map(([dx, dy]) => [op.x + dx, op.y + dy] as const);
}
