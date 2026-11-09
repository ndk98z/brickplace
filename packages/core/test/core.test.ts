import { describe, expect, it } from 'vitest';
import {
  apply,
  applyEntry,
  colorOf,
  createState,
  DEFAULT_SHIELD_LIFETIME,
  gridHash,
  isFilled,
  LINK_DOWN,
  LINK_RIGHT,
  type Op,
  ORIENTATIONS,
  type State,
} from '../src/index.ts';
// Internal on purpose (not exported from the package): see its doc comment.
import { expireShields } from '../src/shields.ts';

const config = { size: 16, open: { x: 0, y: 0, w: 16, h: 16 }, maxShield: 2 };
const at = (s: State, x: number, y: number) => s.cells[y * s.config.size + x]!;

describe('shapes', () => {
  it('has 19 distinct orientations, each touching 4 cells', () => {
    expect(ORIENTATIONS).toHaveLength(19);
    for (const cells of ORIENTATIONS) expect(cells).toHaveLength(4);
  });
});

describe('brick', () => {
  it('fills four empty cells with links inside the brick only', () => {
    const s = createState(config);
    const r = apply(s, { kind: 'brick', x: 2, y: 3, shape: 1, rotation: 0, color: 7 });
    expect(r.ok).toBe(true);
    expect(colorOf(at(s, 2, 3))).toBe(7);
    expect(at(s, 2, 3) & LINK_RIGHT).toBeTruthy();
    expect(at(s, 2, 3) & LINK_DOWN).toBeTruthy();
    expect(at(s, 3, 4) & (LINK_RIGHT | LINK_DOWN)).toBe(0);
  });

  it('rejects overlap and leaves the grid untouched', () => {
    const s = createState(config);
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 0, rotation: 0, color: 1 });
    const before = gridHash(s);
    const r = apply(s, { kind: 'brick', x: 3, y: 0, shape: 0, rotation: 1, color: 2 });
    expect(r).toEqual({ ok: false, reason: 'occupied' });
    expect(gridHash(s)).toBe(before);
  });

  it('rejects cells outside the open area', () => {
    const s = createState({ ...config, open: { x: 4, y: 4, w: 4, h: 4 } });
    const r = apply(s, { kind: 'brick', x: 5, y: 4, shape: 0, rotation: 0, color: 1 });
    expect(r).toEqual({ ok: false, reason: 'out_of_area' });
  });

  it('rejects malformed ops', () => {
    const s = createState(config);
    // @ts-expect-error shape out of range on purpose
    expect(apply(s, { kind: 'brick', x: 0, y: 0, shape: 9, rotation: 0, color: 1 }).ok).toBe(false);
    expect(apply(s, { kind: 'brick', x: 0, y: 0, shape: 0, rotation: 0, color: 32 }).ok).toBe(
      false,
    );
  });
});

describe('hammer', () => {
  it('clears a cell and the links that pointed into it', () => {
    const s = createState(config);
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 3 });
    const r = apply(s, { kind: 'hammer', x: 1, y: 1 });
    expect(r.ok).toBe(true);
    expect(isFilled(at(s, 1, 1))).toBe(false);
    expect(at(s, 0, 1) & LINK_RIGHT).toBe(0);
    expect(at(s, 1, 0) & LINK_DOWN).toBe(0);
    expect(at(s, 0, 0) & LINK_RIGHT).toBeTruthy();
  });

  it('breaks one shield layer before the cell', () => {
    const s = createState(config);
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 3 });
    apply(s, { kind: 'shield', x: 0, y: 0 });
    apply(s, { kind: 'hammer', x: 0, y: 0 });
    expect(isFilled(at(s, 0, 0))).toBe(true);
    apply(s, { kind: 'hammer', x: 0, y: 0 });
    expect(isFilled(at(s, 0, 0))).toBe(false);
  });

  it('rejects an empty cell so the item can be refunded', () => {
    expect(apply(createState(config), { kind: 'hammer', x: 5, y: 5 })).toEqual({
      ok: false,
      reason: 'empty',
    });
  });
});

describe('single brick', () => {
  // Open area 4x4 at (4, 4). Bricks along its top and left edges leave (4, 4) as a hole:
  // both its open neighbours are filled and the other two lie outside the open area.
  const corner = () => {
    const s = createState({ ...config, open: { x: 4, y: 4, w: 4, h: 4 } });
    apply(s, { kind: 'brick', x: 5, y: 4, shape: 2, rotation: 0, color: 1 });
    apply(s, { kind: 'brick', x: 4, y: 5, shape: 1, rotation: 0, color: 1 });
    return s;
  };

  it('fills a hole no brick can cover, with no link bits', () => {
    const s = corner();
    const r = apply(s, { kind: 'single', x: 4, y: 4, color: 1 });
    expect(r.ok).toBe(true);
    expect(colorOf(at(s, 4, 4))).toBe(1);
    expect(at(s, 4, 4) & (LINK_RIGHT | LINK_DOWN)).toBe(0);
  });

  it('refuses a cell some brick could still cover, leaving the grid untouched', () => {
    const s = corner();
    const before = gridHash(s);
    expect(apply(s, { kind: 'single', x: 7, y: 7, color: 1 })).toEqual({
      ok: false,
      reason: 'coverable',
    });
    expect(gridHash(s)).toBe(before);
  });

  it('counts a placement through one free neighbour as cover', () => {
    // Only a vertical I through (0, 0)..(0, 3) fits: column 0 is free, column 1 is filled.
    const s = createState({ ...config, open: { x: 0, y: 0, w: 2, h: 4 } });
    apply(s, { kind: 'brick', x: 1, y: 0, shape: 0, rotation: 1, color: 2 });
    expect(apply(s, { kind: 'single', x: 0, y: 0, color: 1 }).ok).toBe(false);
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 0, rotation: 1, color: 2 });
    apply(s, { kind: 'hammer', x: 0, y: 3 });
    expect(apply(s, { kind: 'single', x: 0, y: 3, color: 1 }).ok).toBe(true);
  });

  it('never paints over a filled cell', () => {
    const s = corner();
    expect(apply(s, { kind: 'single', x: 5, y: 4, color: 3 })).toEqual({
      ok: false,
      reason: 'occupied',
    });
  });

  it('rejects cells outside the open area and bad colours', () => {
    const s = corner();
    expect(apply(s, { kind: 'single', x: 3, y: 4, color: 1 })).toEqual({
      ok: false,
      reason: 'out_of_area',
    });
    expect(apply(s, { kind: 'single', x: 4, y: 4, color: 32 })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('shield', () => {
  it('stacks up to maxShield', () => {
    const s = createState(config);
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 3 });
    expect(apply(s, { kind: 'shield', x: 0, y: 0 }).ok).toBe(true);
    expect(apply(s, { kind: 'shield', x: 0, y: 0 }).ok).toBe(true);
    expect(apply(s, { kind: 'shield', x: 0, y: 0 })).toEqual({ ok: false, reason: 'shield_full' });
  });
});

describe('shield decay', () => {
  const H = 3_600_000;
  const L = DEFAULT_SHIELD_LIFETIME;
  const shielded = () => {
    const s = createState(config);
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 3 }, 0);
    apply(s, { kind: 'shield', x: 0, y: 0 }, 0);
    apply(s, { kind: 'shield', x: 0, y: 0 }, H);
    return s;
  };

  it('defaults to 48 hours', () => {
    expect(L).toBe(48 * H);
  });

  it('keeps a layer until exactly its lifetime, then drops it with the next op', () => {
    const s = shielded();
    apply(s, { kind: 'brick', x: 4, y: 4, shape: 1, rotation: 0, color: 1 }, L - 1);
    expect(s.shields[0]).toBe(2);
    const r = apply(s, { kind: 'brick', x: 8, y: 8, shape: 1, rotation: 0, color: 1 }, L);
    expect(s.shields[0]).toBe(1);
    expect(r.ok && r.diffs[0]).toEqual({ index: 0, cell: at(s, 0, 0), shield: 1 });
    expect(s.shieldExpiry.get(0)).toEqual([L + H]);
  });

  it('counts expired layers as gone when checking a full shield', () => {
    const s = shielded();
    expect(apply(s, { kind: 'shield', x: 0, y: 0 }, L - 1)).toEqual({
      ok: false,
      reason: 'shield_full',
    });
    expect(apply(s, { kind: 'shield', x: 0, y: 0 }, L).ok).toBe(true);
    expect(s.shieldExpiry.get(0)).toEqual([L + H, 2 * L]);
  });

  it('breaks the newest layer first', () => {
    const s = shielded();
    apply(s, { kind: 'hammer', x: 0, y: 0 }, 2 * H);
    expect(s.shieldExpiry.get(0)).toEqual([L]);
    // The layer left is the older one, so the cell is bare from L on.
    apply(s, { kind: 'hammer', x: 0, y: 0 }, L);
    expect(isFilled(at(s, 0, 0))).toBe(false);
    expect(s.shieldExpiry.size).toBe(0);
  });

  it('leaves the state untouched, clock included, when an op is refused', () => {
    const s = shielded();
    const before = gridHash(s);
    expect(apply(s, { kind: 'hammer', x: 9, y: 9 }, 10 * L).ok).toBe(false);
    expect(apply(s, { kind: 'shield', x: 0, y: 0 }, -1)).toEqual({ ok: false, reason: 'invalid' });
    expect(apply(s, { kind: 'shield', x: 0, y: 0 }, 1.5)).toEqual({ ok: false, reason: 'invalid' });
    expect(s.clock).toBe(H);
    expect(s.shields[0]).toBe(2);
    expect(gridHash(s)).toBe(before);
  });

  it('refuses times whose layer expiry would leave the 53-bit integer range', () => {
    const s = shielded();
    const last = Number.MAX_SAFE_INTEGER - L;
    expect(apply(s, { kind: 'shield', x: 1, y: 1 }, last + 1)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(s.clock).toBe(H);
    expect(apply(s, { kind: 'shield', x: 1, y: 1 }, last).ok).toBe(true);
    expect(s.shieldExpiry.get(17)).toEqual([Number.MAX_SAFE_INTEGER]);
    expect(() => expireShields(s, last + 1)).toThrow(RangeError);
  });

  it('never moves the clock back', () => {
    const s = shielded();
    apply(s, { kind: 'brick', x: 4, y: 4, shape: 1, rotation: 0, color: 1 }, L);
    expect(s.clock).toBe(L);
    // Logged earlier than the clock: treated as L, so its layer lasts from L.
    apply(s, { kind: 'shield', x: 0, y: 0 }, 5);
    expect(s.clock).toBe(L);
    expect(s.shieldExpiry.get(0)).toEqual([L + H, 2 * L]);
  });

  it('sweeps expired layers when the clock advances', () => {
    const s = shielded();
    expect(expireShields(s, L + H)).toEqual([{ index: 0, cell: at(s, 0, 0), shield: 0 }]);
    expect(s.shields[0]).toBe(0);
    expect(expireShields(s, 0)).toEqual([]);
    expect(() => expireShields(s, Number.NaN)).toThrow(RangeError);
  });

  it('honours a configured lifetime and validates it', () => {
    const s = createState({ ...config, shieldLifetime: 10 });
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 3 }, 0);
    apply(s, { kind: 'shield', x: 0, y: 0 }, 100);
    expireShields(s, 110);
    expect(s.shields[0]).toBe(0);
    expect(() => createState({ ...config, shieldLifetime: 0 })).toThrow(RangeError);
  });

  it('keeps the expiry queue bounded by live layers', () => {
    const s = createState({ ...config, shieldLifetime: 10, maxShield: 1 });
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 3 }, 0);
    for (let t = 0; t < 50_000; t += 10) apply(s, { kind: 'shield', x: 0, y: 0 }, t);
    expect(s.expiryQueue.times.length - s.expiryQueue.head).toBeLessThanOrEqual(1);
    expect(s.expiryQueue.times.length).toBeLessThan(2100);
  });
});

describe('log entries', () => {
  it('grows the open area at its place in the log, without moving the clock', () => {
    const s = createState({ ...config, open: { x: 4, y: 4, w: 8, h: 8 } });
    const brick = { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 3 } as const;
    expect(applyEntry(s, brick, 5)).toEqual({ ok: false, reason: 'out_of_area' });
    expect(applyEntry(s, { kind: 'open', x: 0, y: 0, w: 16, h: 16 }, 50)).toEqual({
      ok: true,
      diffs: [],
    });
    expect(s.clock).toBe(0);
    expect(s.config.open).toEqual({ x: 0, y: 0, w: 16, h: 16 });
    expect(applyEntry(s, brick, 5).ok).toBe(true);
    expect(s.counters.filled).toBe(4);
  });

  it('refuses a change that would shrink the area, and changes nothing', () => {
    const s = createState({ ...config, open: { x: 4, y: 4, w: 8, h: 8 } });
    const before = gridHash(s);
    const shrink = { kind: 'open', x: 5, y: 4, w: 7, h: 8 } as const;
    expect(applyEntry(s, shrink)).toEqual({ ok: false, reason: 'invalid' });
    expect(applyEntry(s, { kind: 'open', x: 0, y: 0, w: 17, h: 16 }).ok).toBe(false);
    expect(applyEntry(s, { kind: 'open', x: 0.5, y: 0, w: 8, h: 8 }).ok).toBe(false);
    expect(s.config.open).toEqual({ x: 4, y: 4, w: 8, h: 8 });
    expect(gridHash(s)).toBe(before);
  });

  it('never lets a player op grow the area', () => {
    const s = createState({ ...config, open: { x: 4, y: 4, w: 8, h: 8 } });
    const open = { kind: 'open', x: 0, y: 0, w: 16, h: 16 } as unknown as Op;
    expect(apply(s, open)).toEqual({ ok: false, reason: 'invalid' });
    expect(s.config.open.w).toBe(8);
  });
});
