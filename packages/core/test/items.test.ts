import { describe, expect, it } from 'vitest';
import {
  addItems,
  apply,
  blockedCells,
  checkItemConfig,
  createState,
  DEFAULT_ITEM_CONFIG,
  drawFrom,
  drawItem,
  findItem,
  type Hold,
  ITEM_KINDS,
  type Item,
  type ItemConfig,
  type ItemKind,
  itemFor,
  itemsDue,
  newHold,
  nextItemAt,
  phaseOf,
  type Rates,
  rollKind,
  takeItem,
} from '../src/index.ts';

const WORD = 2 ** 32;
const config = DEFAULT_ITEM_CONFIG;
const MIN = config.cooldown;

describe('item config', () => {
  it('accepts the ADR 0011 defaults', () => {
    expect(() => checkItemConfig(DEFAULT_ITEM_CONFIG)).not.toThrow();
    expect(DEFAULT_ITEM_CONFIG.rates.settling).toEqual([84, 5, 1, 10]);
    expect(DEFAULT_ITEM_CONFIG.hold).toBe(3);
    expect(DEFAULT_ITEM_CONFIG.cooldown).toBe(60_000);
  });

  it('refuses configs that cannot draw or count', () => {
    const bad: Partial<ItemConfig>[] = [
      { hold: 0 },
      { cooldown: 0 },
      { cooldown: 1.5 },
      { cooldown: 2 ** 32 },
      { startItems: -1 },
      { version: 0 },
      { rates: { ...config.rates, contested: [0, 0, 0, 0] } },
      { rates: { ...config.rates, saturated: [40, 10, 25] as unknown as Rates } },
      { rates: { ...config.rates, settling: [85, 5, -1, 10] } },
      { rates: { ...config.rates, settling: [85.5, 5, 0, 10] } },
      { rates: { ...config.rates, settling: [2 ** 20, 1, 0, 0] } },
    ];
    for (const change of bad) {
      expect(() => checkItemConfig({ ...config, ...change }), JSON.stringify(change)).toThrow(
        RangeError,
      );
    }
  });
});

describe('phase by brick room', () => {
  it('counts filled cells and holes, with exact thresholds at 60% and 85%', () => {
    const s = createState({ size: 20, open: { x: 0, y: 0, w: 10, h: 10 }, maxShield: 2 });
    expect(blockedCells(s)).toBe(0);
    expect(phaseOf(s)).toBe('settling');
    // The thresholds compare whole cells: set the counter directly to hit them exactly.
    const at = (blocked: number) => {
      s.counters.reachable = 100 - blocked;
      return phaseOf(s);
    };
    expect([at(59), at(60), at(84), at(85), at(100)]).toEqual([
      'settling',
      'contested',
      'contested',
      'saturated',
      'saturated',
    ]);
  });

  it('counts a hole no brick can reach as blocked', () => {
    // Open 2x4: two O bricks fill it, a hammer leaves a one-cell hole.
    const s = createState({ size: 8, open: { x: 0, y: 0, w: 2, h: 4 }, maxShield: 2 });
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 1 });
    expect(blockedCells(s)).toBe(4);
    expect(phaseOf(s)).toBe('settling');
    apply(s, { kind: 'brick', x: 0, y: 2, shape: 1, rotation: 0, color: 1 });
    apply(s, { kind: 'hammer', x: 1, y: 3 });
    expect(s.counters.filled).toBe(7);
    expect(blockedCells(s)).toBe(8);
    expect(phaseOf(s)).toBe('saturated');
  });
});

describe('item draws', () => {
  const rates: Rates = [85, 5, 0, 10];

  it('splits the 32-bit range exactly by the rates', () => {
    // brick while word * 100 < 85 * 2^32, i.e. word <= 3650722201.
    expect(rollKind(rates, 0)).toBe('brick');
    expect(rollKind(rates, 3650722201)).toBe('brick');
    expect(rollKind(rates, 3650722202)).toBe('single');
    expect(rollKind(rates, 3865470566)).toBe('single');
    expect(rollKind(rates, 3865470567)).toBe('shield');
    expect(rollKind(rates, WORD - 1)).toBe('shield');
    expect(() => rollKind(rates, WORD)).toThrow(RangeError);
    expect(() => rollKind(rates, -1)).toThrow(RangeError);
    expect(() => rollKind(rates, 0.5)).toThrow(RangeError);
  });

  it('gives each kind its share of evenly spread words', () => {
    const counts: Record<ItemKind, number> = { brick: 0, single: 0, hammer: 0, shield: 0 };
    const n = 100_000;
    for (let i = 0; i < n; i++) counts[rollKind([40, 10, 25, 25], Math.ceil((i * WORD) / n))]++;
    expect(counts).toEqual({ brick: 40_000, single: 10_000, hammer: 25_000, shield: 25_000 });
  });

  it('turns a single brick into a brick when there is no hole', () => {
    const single = 3700000000;
    expect(drawFrom({ holes: true, fitting: [0] }, rates, single, 0)).toEqual({ kind: 'single' });
    expect(drawFrom({ holes: false, fitting: [0] }, rates, single, 0)).toEqual({
      kind: 'brick',
      shape: 0,
    });
  });

  it('draws a shape uniformly among those that fit, or a shield when none fits', () => {
    const fitting = { holes: false, fitting: [1, 3] as const };
    expect(drawFrom(fitting, rates, 0, 0)).toEqual({ kind: 'brick', shape: 1 });
    expect(drawFrom(fitting, rates, 0, WORD / 2 - 1)).toEqual({ kind: 'brick', shape: 1 });
    expect(drawFrom(fitting, rates, 0, WORD / 2)).toEqual({ kind: 'brick', shape: 3 });
    expect(drawFrom(fitting, rates, 0, WORD - 1)).toEqual({ kind: 'brick', shape: 3 });
    expect(drawFrom({ holes: false, fitting: [] }, rates, 0, 0)).toEqual({ kind: 'shield' });
    // A single brick that has to become a brick also becomes a shield when nothing fits.
    expect(drawFrom({ holes: false, fitting: [] }, rates, 3700000000, 0)).toEqual({
      kind: 'shield',
    });
    expect(() => drawFrom(fitting, rates, 0, WORD)).toThrow(RangeError);
  });

  it('reads the phase, the holes and the fitting shapes from the state', () => {
    const s = createState({ size: 8, open: { x: 0, y: 0, w: 2, h: 4 }, maxShield: 2 });
    apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 1 });
    // Settling (half the area blocked), only the O fits, no hole yet.
    const brickWord = 0;
    const singleWord = Math.ceil((config.rates.settling[0] * WORD) / 100);
    expect(rollKind(config.rates.settling, singleWord)).toBe('single');
    expect(drawItem(s, config, brickWord, WORD - 1)).toEqual({ kind: 'brick', shape: 1 });
    expect(drawItem(s, config, singleWord, 0)).toEqual({ kind: 'brick', shape: 1 });
    apply(s, { kind: 'brick', x: 0, y: 2, shape: 1, rotation: 0, color: 1 });
    apply(s, { kind: 'hammer', x: 1, y: 3 });
    // Saturated now, with a hole and no shape that fits.
    const saturated = config.rates.saturated;
    expect(drawItem(s, config, Math.ceil((saturated[0] * WORD) / 100), 0)).toEqual({
      kind: 'single',
    });
    expect(drawItem(s, config, 0, 0)).toEqual({ kind: 'shield' });
  });
});

describe('the hold', () => {
  const brick = (shape: 0 | 1 | 2 | 3 | 4 | 5 | 6): Item => ({ kind: 'brick', shape });
  const hammer: Item = { kind: 'hammer' };
  const shield: Item = { kind: 'shield' };

  it('gives a new player startItems at once, then one per cooldown', () => {
    let hold = newHold(1_000_000, config);
    expect(itemsDue(hold, 1_000_000, config)).toBe(1);
    hold = addItems(hold, [hammer], config);
    expect(hold.since).toBe(1_000_000);
    expect(nextItemAt(hold, config)).toBe(1_000_000 + MIN);
    expect(itemsDue(hold, 1_000_000 + MIN - 1, config)).toBe(0);
    expect(itemsDue(hold, 1_000_000 + MIN, config)).toBe(1);
    // Ten minutes later only the room left arrives.
    expect(itemsDue(hold, 1_000_000 + 10 * MIN, config)).toBe(2);
    expect(itemsDue(newHold(0, { ...config, startItems: 9 }), 0, config)).toBe(3);
    expect(() => addItems(hold, [hammer, hammer, hammer], config)).toThrow(RangeError);
  });

  it('keeps partial cooldowns and banks no time while full', () => {
    let hold: Hold = { items: [hammer], since: 0 };
    // 2.5 cooldowns: two arrive, the half carries over.
    hold = addItems(hold, [shield, brick(2)], config);
    expect(hold.since).toBe(2 * MIN);
    expect(itemsDue(hold, 2.5 * MIN, config)).toBe(0);
    expect(nextItemAt(hold, config)).toBeNull();
    // An hour later the hold is still just full; taking one starts the cooldown then.
    hold = takeItem(hold, 0, 60 * MIN, config);
    expect(hold.items).toEqual([shield, brick(2)]);
    expect(hold.since).toBe(60 * MIN);
    expect(itemsDue(hold, 61 * MIN - 1, config)).toBe(0);
    expect(itemsDue(hold, 61 * MIN, config)).toBe(1);
    // Taking from a hold with room keeps the cooldown under way.
    const after = takeItem(hold, 1, 60.5 * MIN, config);
    expect(after.since).toBe(60 * MIN);
    expect(() => takeItem(after, 1, 0, config)).toThrow(RangeError);
  });

  it('matches an op to a held item by kind and, for bricks, shape', () => {
    const hold: Hold = { items: [brick(2), hammer, brick(5)], since: 0 };
    const at = { x: 3, y: 4 };
    expect(findItem(hold, itemFor({ kind: 'brick', ...at, shape: 5, rotation: 3, color: 7 }))).toBe(
      2,
    );
    expect(findItem(hold, itemFor({ kind: 'brick', ...at, shape: 1, rotation: 0, color: 7 }))).toBe(
      -1,
    );
    expect(findItem(hold, itemFor({ kind: 'hammer', ...at }))).toBe(1);
    expect(findItem(hold, itemFor({ kind: 'shield', ...at }))).toBe(-1);
    expect(findItem(hold, itemFor({ kind: 'single', ...at, color: 1 }))).toBe(-1);
    expect(ITEM_KINDS).toEqual(['brick', 'single', 'hammer', 'shield']);
  });
});
