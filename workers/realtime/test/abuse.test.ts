import { describe, expect, it } from 'vitest';
import {
  type AbusePolicy,
  allowance,
  inside,
  parsePolicy,
  type SignalPolicy,
  Signals,
  Windows,
} from '../src/abuse.ts';

// Every number here is made up for the tests; the real ones live in KV (ADR 0002, 0026).

const SIGNALS: SignalPolicy = {
  halfLifeMs: 60_000,
  offView: 1,
  viewMargin: 4,
  noView: 0.5,
  onCooldown: 5,
  samples: 3,
  withinMs: 2_000,
  spreadMs: 100,
  trustPenalty: 10,
  challengeAt: 8,
  flagAt: 2,
};

const POLICY: AbusePolicy = {
  opens: {
    account: { limit: 3, windowMs: 10_000 },
    address: { limit: 5, windowMs: 10_000 },
    network: { limit: 9, windowMs: 10_000 },
  },
  ops: { account: { limit: 4, windowMs: 1_000 } },
  trust: {
    unscored: 50,
    windowMs: 3_600_000,
    tiers: [
      { below: 20, uses: 1 },
      { below: 40, uses: 3 },
    ],
  },
  signals: SIGNALS,
};

describe('parsePolicy', () => {
  it('reads a whole policy back', () => {
    expect(parsePolicy(JSON.stringify(POLICY))).toEqual(POLICY);
  });

  it('takes any part alone, and an empty policy that limits nothing', () => {
    expect(parsePolicy('{}')).toEqual({});
    expect(parsePolicy(JSON.stringify({ ops: POLICY.ops }))).toEqual({ ops: POLICY.ops });
    expect(parsePolicy(JSON.stringify({ opens: { address: POLICY.opens!.address } }))).toEqual({
      opens: { address: POLICY.opens!.address },
    });
  });

  it('refuses the whole policy when any part is malformed, so no limit drops silently', () => {
    const bad: unknown[] = [
      null,
      'not json',
      '[]',
      '7',
      { ops: { account: { limit: -1, windowMs: 1000 } } },
      { ops: { account: { limit: 1.5, windowMs: 1000 } } },
      { ops: { account: { limit: 1, windowMs: 10 } } },
      { opens: { account: { limit: 1 } } },
      {
        trust: {
          ...POLICY.trust,
          tiers: [
            { below: 40, uses: 1 },
            { below: 20, uses: 1 },
          ],
        },
      },
      { trust: { ...POLICY.trust, unscored: 101 } },
      { trust: { windowMs: 1000, tiers: [] } },
      { signals: { ...SIGNALS, samples: 1 } },
      { signals: { ...SIGNALS, samples: 99 } },
      { signals: { ...SIGNALS, offView: Number.NaN } },
      { signals: { ...SIGNALS, flagAt: undefined } },
    ];
    for (const value of bad) {
      const text =
        typeof value === 'string' ? value : value === null ? null : JSON.stringify(value);
      expect(parsePolicy(text), String(text)).toBeNull();
    }
  });
});

describe('Windows', () => {
  const rule = { limit: 2, windowMs: 1_000 };

  it('counts per key in fixed windows and refuses past the limit without counting', () => {
    const w = new Windows(10);
    expect(w.take('a', rule, 0)).toBe(true);
    expect(w.take('a', rule, 10)).toBe(true);
    expect(w.take('a', rule, 20)).toBe(false);
    expect(w.used('a', rule, 20)).toBe(2);
    expect(w.take('b', rule, 20)).toBe(true);
    // A new window starts afresh.
    expect(w.take('a', rule, 1_000)).toBe(true);
    expect(w.used('a', rule, 1_000)).toBe(1);
    expect(w.used('a', rule, 2_500)).toBe(0);
  });

  it('gives a reserved event back to the window it was taken in, and to no other', () => {
    const w = new Windows(10);
    const first = w.reserve('a', rule, 0);
    expect(first).toBe(0);
    w.reserve('a', rule, 0);
    expect(w.reserve('a', rule, 0)).toBeNull();
    w.refund('a', first!);
    expect(w.take('a', rule, 20)).toBe(true);
    // Taken just before the window rolled over, refunded after it: the new window keeps its
    // count, so a refused op of the old window frees no room in the new one.
    w.reserve('b', rule, 0);
    const late = w.reserve('b', rule, 999);
    expect(late).toBe(0);
    expect(w.reserve('b', rule, 1_001)).toBe(1_001);
    w.refund('b', late!);
    expect(w.used('b', rule, 1_001)).toBe(1);
    // Never below zero.
    w.refund('c', 0);
    expect(w.used('c', rule, 0)).toBe(0);
  });

  it('adds past the limit when told to, and keeps at most `max` keys, oldest out', () => {
    const w = new Windows(2);
    w.add('a', rule, 0);
    w.add('a', rule, 0);
    w.add('a', rule, 0);
    expect(w.used('a', rule, 0)).toBe(3);
    w.take('b', rule, 1);
    w.take('c', rule, 2);
    expect(w.size).toBe(2);
    expect(w.used('a', rule, 3)).toBe(0);
    expect(w.used('c', rule, 3)).toBe(1);
  });
});

describe('Signals', () => {
  const view = [100, 100, 50, 40] as const;

  it('flags ops outside the view (with its margin) and ops without one', () => {
    const s = new Signals(100);
    expect(s.op('p', { x: 120, y: 120 }, view, null, SIGNALS, 0)).toEqual({ fired: [], score: 0 });
    expect(s.op('p', { x: 153, y: 139 }, view, null, SIGNALS, 0).fired).toEqual([]);
    expect(s.op('p', { x: 154, y: 120 }, view, null, SIGNALS, 0)).toEqual({
      fired: ['offView'],
      score: 1,
    });
    expect(s.op('p', { x: 120, y: 120 }, null, null, SIGNALS, 0)).toEqual({
      fired: ['noView'],
      score: 1.5,
    });
  });

  it('halves suspicion every half-life; a passed Turnstile resets the score, not the counts', () => {
    const s = new Signals(100);
    s.op('p', { x: 0, y: 0 }, view, null, SIGNALS, 0);
    s.op('p', { x: 0, y: 0 }, view, null, SIGNALS, 0);
    expect(s.score('p', SIGNALS, 60_000)).toBeCloseTo(1);
    expect(s.score('p', SIGNALS, 120_000)).toBeCloseTo(0.5);
    s.passed('p', 120_000);
    expect(s.score('p', SIGNALS, 120_000)).toBe(0);
    // Still listed for moderators, with its history.
    expect(s.flagged(SIGNALS, 120_000, 10)).toEqual([
      { player: 'p', score: 0, offView: 2, noView: 0, onCooldown: 0, passed: 1 },
    ]);
  });

  it('drops the player updated longest ago when full, not the one first seen', () => {
    const s = new Signals(2);
    s.op('a', { x: 0, y: 0 }, view, null, SIGNALS, 0);
    s.op('b', { x: 0, y: 0 }, view, null, SIGNALS, 1);
    // `a` acts again: `b` is now the stalest.
    s.op('a', { x: 0, y: 0 }, view, null, SIGNALS, 2);
    s.op('c', { x: 0, y: 0 }, view, null, SIGNALS, 3);
    expect(s.score('a', SIGNALS, 3)).toBeGreaterThan(1.9);
    expect(s.score('b', SIGNALS, 3)).toBe(0);
  });

  it('fires the timing signal on fresh items used at the same lag, once per streak', () => {
    const s = new Signals(100);
    const at = { x: 110, y: 110 };
    const use = (arrived: number, lag: number) =>
      s.op('bot', at, view, arrived, SIGNALS, arrived + lag).fired;
    expect(use(60_000, 300)).toEqual([]);
    expect(use(120_000, 320)).toEqual([]);
    expect(use(180_000, 290)).toEqual(['onCooldown']);
    // The streak starts over after firing.
    expect(use(240_000, 300)).toEqual([]);
    // The same arrival counts once, and an item held on (no arrival) is not sampled.
    expect(s.op('bot', at, view, 240_000, SIGNALS, 240_900).fired).toEqual([]);
    expect(s.op('bot', at, view, null, SIGNALS, 241_000).fired).toEqual([]);
  });

  it('does not fire for a person: lags that vary, or a wait that breaks the streak', () => {
    const s = new Signals(100);
    const at = { x: 110, y: 110 };
    const use = (arrived: number, lag: number) =>
      s.op('person', at, view, arrived, SIGNALS, arrived + lag).fired;
    expect([use(60_000, 400), use(120_000, 1_400), use(180_000, 900)].flat()).toEqual([]);
    expect([use(240_000, 300), use(300_000, 30_000), use(360_000, 310)].flat()).toEqual([]);
    expect(use(420_000, 305)).toEqual([]);
  });

  it('lists flagged players, most suspicious first, without the unflagged', () => {
    const s = new Signals(100);
    for (let i = 0; i < 3; i++) s.op('a', { x: 0, y: 0 }, view, null, SIGNALS, 0);
    s.op('b', { x: 0, y: 0 }, view, null, SIGNALS, 0);
    for (let i = 0; i < 5; i++) s.op('c', { x: 0, y: 0 }, null, null, SIGNALS, 0);
    expect(s.flagged(SIGNALS, 0, 10)).toEqual([
      { player: 'a', score: 3, offView: 3, noView: 0, onCooldown: 0, passed: 0 },
      { player: 'c', score: 2.5, offView: 0, noView: 5, onCooldown: 0, passed: 0 },
    ]);
    expect(s.flagged(SIGNALS, 0, 1)).toHaveLength(1);
  });

  it('keeps at most `max` players', () => {
    const s = new Signals(2);
    for (const p of ['a', 'b', 'c']) s.op(p, { x: 0, y: 0 }, view, null, SIGNALS, 0);
    expect(s.size).toBe(2);
    expect(s.score('a', SIGNALS, 0)).toBe(0);
  });
});

describe('allowance', () => {
  it('picks the first tier the score is below, and none past the last', () => {
    expect(allowance(POLICY, 10, 0)).toEqual({ limit: 1, windowMs: 3_600_000 });
    expect(allowance(POLICY, 20, 0)).toEqual({ limit: 3, windowMs: 3_600_000 });
    expect(allowance(POLICY, 40, 0)).toBeNull();
    expect(allowance(POLICY, 100, 0)).toBeNull();
  });

  it('scores a token without one as `unscored`, and lowers it by suspicion', () => {
    expect(allowance(POLICY, undefined, 0)).toBeNull();
    expect(allowance(POLICY, undefined, 1.5)).toEqual({ limit: 3, windowMs: 3_600_000 });
    expect(allowance(POLICY, 100, 9)).toEqual({ limit: 1, windowMs: 3_600_000 });
  });

  it('limits nothing without a trust part', () => {
    expect(allowance({ signals: SIGNALS }, 0, 100)).toBeNull();
  });
});

describe('inside', () => {
  it('counts the margin on every side', () => {
    expect(inside({ x: 6, y: 6 }, [10, 10, 5, 5], 4)).toBe(true);
    expect(inside({ x: 5, y: 10 }, [10, 10, 5, 5], 4)).toBe(false);
    expect(inside({ x: 18, y: 18 }, [10, 10, 5, 5], 4)).toBe(true);
    expect(inside({ x: 19, y: 18 }, [10, 10, 5, 5], 4)).toBe(false);
  });
});
