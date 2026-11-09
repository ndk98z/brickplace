import { describe, expect, it } from 'vitest';
import {
  apply,
  canCover,
  createState,
  holeCount,
  isFilled,
  type Op,
  ORIENTATION_OF,
  ORIENTATIONS,
  type Rect,
  type Rotation,
  type ShapeId,
  type State,
  setOpenArea,
  shapeFits,
} from '../src/index.ts';

/** Small deterministic generator (mulberry32) so failures replay; the core itself has none. */
function generator(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** Recounts everything the slow way: every orientation at every position of the map. */
function bruteForce(s: State) {
  const { size, open } = s.config;
  const inOpen = (x: number, y: number) =>
    x >= open.x && y >= open.y && x < open.x + open.w && y < open.y + open.h;
  const placements = ORIENTATIONS.map(() => 0);
  const cover = new Uint8Array(size * size);
  ORIENTATIONS.forEach((offsets, o) => {
    for (let y = -4; y < size; y++) {
      for (let x = -4; x < size; x++) {
        const cells = offsets.map(([dx, dy]) => [x + dx, y + dy] as const);
        const fits = cells.every(
          ([cx, cy]) => inOpen(cx, cy) && !isFilled(s.cells[cy * size + cx]!),
        );
        if (!fits) continue;
        placements[o]!++;
        for (const [cx, cy] of cells) cover[cy * size + cx]!++;
      }
    }
  });
  let reachable = 0;
  let filled = 0;
  for (let i = 0; i < size * size; i++) {
    if (cover[i]! > 0) reachable++;
    if (isFilled(s.cells[i]!)) filled++;
  }
  return { placements, cover, reachable, filled };
}

function expectCounters(s: State, context: string): void {
  const brute = bruteForce(s);
  expect([...s.counters.placements], context).toEqual(brute.placements);
  expect(s.counters.reachable, context).toBe(brute.reachable);
  expect(s.counters.filled, context).toBe(brute.filled);
  const wrong = brute.cover.findIndex((n, i) => s.counters.cover[i] !== n);
  expect(wrong, `${context}: cover differs at cell ${wrong}`).toBe(-1);
}

/** Everything an op may change, as plain values. */
function snapshot(s: State) {
  return {
    cells: [...s.cells],
    shields: [...s.shields],
    placements: [...s.counters.placements],
    cover: [...s.counters.cover],
    reachable: s.counters.reachable,
    filled: s.counters.filled,
    clock: s.clock,
    shieldExpiry: [...s.shieldExpiry].map(([index, layers]) => [index, [...layers]]),
    queue: [s.expiryQueue.head, s.expiryQueue.times.length],
  };
}

/** Open areas a sequence grows through: a centred square, a wider one, then the whole map. */
const SIZE = 10;
const STAGES: Rect[] = [
  { x: 3, y: 3, w: 4, h: 4 },
  { x: 1, y: 2, w: 7, h: 6 },
  { x: 0, y: 0, w: SIZE, h: SIZE },
];

function randomOp(s: State, next: (n: number) => number): Op {
  // Aim at the open area plus a one-cell margin, so edges and refusals are both covered.
  const { open } = s.config;
  const x = open.x - 1 + next(open.w + 2);
  const y = open.y - 1 + next(open.h + 2);
  const roll = next(100);
  if (roll < 45) {
    const shape = next(7) as ShapeId;
    return { kind: 'brick', x, y, shape, rotation: next(4) as Rotation, color: next(32) };
  }
  if (roll < 75) return { kind: 'hammer', x, y };
  if (roll < 85) return { kind: 'shield', x, y };
  // Singles: half at a random cell, half at a known hole so some are accepted.
  const holes: [number, number][] = [];
  for (let hy = open.y; hy < open.y + open.h; hy++) {
    for (let hx = open.x; hx < open.x + open.w; hx++) {
      if (!isFilled(s.cells[hy * SIZE + hx]!) && !canCover(s, hx, hy)) holes.push([hx, hy]);
    }
  }
  const [sx, sy] = holes.length > 0 && next(2) === 0 ? holes[next(holes.length)]! : [x, y];
  return { kind: 'single', x: sx, y: sy, color: next(32) };
}

describe('anti-stuck counters', () => {
  it('start with every placement of an empty open area', () => {
    const s = createState({ size: 16, open: { x: 2, y: 2, w: 8, h: 6 }, maxShield: 2 });
    expectCounters(s, 'fresh');
    // A horizontal I fits at 5 columns x 6 rows; an O at 7 x 5.
    expect(s.counters.placements[ORIENTATION_OF[0]![0]!]).toBe(30);
    expect(s.counters.placements[ORIENTATION_OF[1]![0]!]).toBe(35);
    expect(s.counters.reachable).toBe(48);
    expect(holeCount(s)).toBe(0);
  });

  // About 1 s alone; a loaded machine running every suite at once can stretch it past 5 s.
  it('match a brute-force recount after every op of random sequences', { timeout: 30_000 }, () => {
    const accepted: Record<string, number> = { brick: 0, hammer: 0, shield: 0, single: 0 };
    for (let seed = 1; seed <= 40; seed++) {
      const next = generator(seed);
      // Layers last 20 steps, so expiry runs between the other ops too.
      const s = createState({ size: SIZE, open: STAGES[0]!, maxShield: 2, shieldLifetime: 20_000 });
      for (let step = 0; step < 240; step++) {
        if (step === 80 || step === 160) setOpenArea(s, STAGES[step / 80]!);
        const op = randomOp(s, next);
        const before = snapshot(s);
        const result = apply(s, op, step * 1000);
        const context = `seed ${seed} step ${step} ${JSON.stringify(op)}`;
        if (!result.ok) {
          // A refused op leaves everything as it was, not only the grid.
          expect(snapshot(s), context).toEqual(before);
          continue;
        }
        accepted[op.kind]!++;
        expectCounters(s, context);
      }
    }
    // The sequences must exercise every path, not only refusals.
    for (const [kind, n] of Object.entries(accepted)) expect(n, kind).toBeGreaterThan(100);
  });

  it('let a single brick in exactly where the brute force finds no cover', () => {
    const next = generator(99);
    const s = createState({ size: SIZE, open: STAGES[2]!, maxShield: 2 });
    for (let step = 0; step < 400; step++) {
      apply(s, randomOp(s, next));
      const { cover } = bruteForce(s);
      for (let i = 0; i < SIZE * SIZE; i++) {
        const x = i % SIZE;
        const y = (i - x) / SIZE;
        expect(canCover(s, x, y)).toBe(cover[i]! > 0);
      }
    }
  });

  it('report which shapes still fit and how many holes are left', () => {
    // Open 2x4: only a vertical I or an O fits, in this column pair.
    const s = createState({ size: 8, open: { x: 0, y: 0, w: 2, h: 4 }, maxShield: 2 });
    expect([0, 1, 2, 3, 4, 5, 6].map((shape) => shapeFits(s, shape as ShapeId))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 1 });
    // Left: a 2x2 block at the bottom. Only the O fits now.
    expect([0, 1, 2, 3, 4, 5, 6].map((shape) => shapeFits(s, shape as ShapeId))).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    apply(s, { kind: 'brick', x: 0, y: 2, shape: 1, rotation: 0, color: 1 });
    apply(s, { kind: 'hammer', x: 1, y: 3 });
    expect(shapeFits(s, 1)).toBe(false);
    expect(holeCount(s)).toBe(1);
    apply(s, { kind: 'single', x: 1, y: 3, color: 2 });
    expect(holeCount(s)).toBe(0);
    expect(s.counters.filled).toBe(8);
  });

  it('recount when the open area grows, and refuse to shrink it', () => {
    const s = createState({ size: 8, open: { x: 2, y: 2, w: 2, h: 2 }, maxShield: 2 });
    apply(s, { kind: 'brick', x: 2, y: 2, shape: 1, rotation: 0, color: 1 });
    expect(s.counters.reachable).toBe(0);
    setOpenArea(s, { x: 0, y: 0, w: 8, h: 8 });
    expectCounters(s, 'grown');
    expect(s.counters.reachable).toBe(60);
    expect(() => setOpenArea(s, { x: 1, y: 0, w: 7, h: 8 })).toThrow(RangeError);
    expect(() => setOpenArea(s, { x: 0, y: 0, w: 9, h: 8 })).toThrow(RangeError);
  });
});
