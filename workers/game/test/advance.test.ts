import { DEFAULT_ITEM_CONFIG, type Item, type ItemConfig } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import type { ItemSegment } from '../src/config.ts';
import { advance, restamp } from '../src/inventory.ts';

// The pure parts of moving a hold through item versions (ADR 0022).

const T = 1_000_000;
const MIN = 60_000;
const v = (version: number, change: Partial<ItemConfig> = {}): ItemConfig => ({
  ...DEFAULT_ITEM_CONFIG,
  version,
  ...change,
});
const SHIELD: Item = { kind: 'shield' };
/** A draw that gives `budget` items, then runs out of words. */
const drawing = (budget = Number.POSITIVE_INFINITY) => {
  let left = budget;
  return () => {
    if (left <= 0) return undefined;
    left -= 1;
    return SHIELD;
  };
};

describe('advance', () => {
  // v1: 60 s; v2 from E: 120 s. Both hold 5.
  const E = T + 150_000;
  const segments: ItemSegment[] = [
    { config: v(1, { hold: 5 }), since: Number.NEGATIVE_INFINITY },
    { config: v(2, { hold: 5, cooldown: 2 * MIN }), since: E },
  ];
  const AT = T + 400_000;
  const start = { items: [], since: T };

  it('draws under each version, then restamps', () => {
    // Two items under v1 by T + 120 s; 30 s of the next cooldown run at E, kept as 60 s of
    // 120 s; then items at T + 210 s and T + 330 s under v2.
    expect(advance(start, segments, AT, drawing())).toEqual({
      hold: { items: [SHIELD, SHIELD, SHIELD, SHIELD], since: T + 330_000 },
      drawn: 4,
      version: 2,
    });
  });

  it('stops at the version reached when words run out, and resumes to the same hold', () => {
    const cut = advance(start, segments, AT, drawing(1));
    // One of the two items due under v1: still under v1, not restamped into v2.
    expect(cut).toEqual({ hold: { items: [SHIELD], since: T + MIN }, drawn: 1, version: 1 });
    const rest = advance(cut.hold, segments.slice(0), AT, drawing());
    expect(rest.version).toBe(2);
    expect(cut.drawn + rest.drawn).toBe(4);
    expect(rest.hold).toEqual(advance(start, segments, AT, drawing()).hold);
  });

  it('stops in the last segment too, at its version', () => {
    const cut = advance(start, segments, AT, drawing(3));
    expect(cut).toMatchObject({ drawn: 3, version: 2 });
    expect(cut.hold.items).toHaveLength(3);
  });
});

describe('restamp', () => {
  const from = v(1);
  const to = v(2, { cooldown: 2 * MIN, hold: 5 });

  it('restarts a full hold at the switch and keeps the share of a cooldown under way', () => {
    expect(restamp({ items: [SHIELD, SHIELD, SHIELD], since: T }, from, to, T + 10)).toEqual({
      items: [SHIELD, SHIELD, SHIELD],
      since: T + 10,
    });
    // 30 s of 60 s run: 60 s of 120 s.
    expect(restamp({ items: [], since: T }, from, to, T + 30_000)).toEqual({
      items: [],
      since: T + 30_000 - MIN,
    });
  });

  it('leaves a hold whose count starts at or after the switch as it is', () => {
    for (const items of [[], [SHIELD, SHIELD, SHIELD]]) {
      const hold = { items, since: T + 50 };
      expect(restamp(hold, from, to, T)).toBe(hold);
      const same = { items, since: T };
      expect(restamp(same, from, to, T)).toBe(same);
    }
  });
});
