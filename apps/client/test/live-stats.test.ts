import { DEFAULT_ITEM_CONFIG } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import {
  type CanvasStats,
  dropShares,
  LiveStats,
  latestCount,
  mapIsFull,
  parseStats,
  STATS_POLL_MS,
  STATS_STALE_MS,
} from '../src/game/live-stats.ts';

// The game screen's live numbers (ADR 0030): what /api/stats may say, how drop rates read as
// shares, and which count shows when the poll and the socket disagree.

const GOOD = {
  playing: 1284,
  phase: 'settling',
  filled: 42,
  built: 36,
  growsAt: 70,
  rates: DEFAULT_ITEM_CONFIG.rates,
};

describe('a full map (ADR 0039)', () => {
  it('is full once the players reach the cap, and never on a guess', () => {
    const stats = parseStats(GOOD);
    expect(mapIsFull(1284, stats)).toBe(true);
    expect(mapIsFull(1000, stats)).toBe(true);
    expect(mapIsFull(1285, stats)).toBe(false);
    // No cap, no cap known (an older gateway) or no fresh stats: not full.
    expect(mapIsFull(null, stats)).toBe(false);
    expect(mapIsFull(undefined, stats)).toBe(false);
    expect(mapIsFull(10, null)).toBe(false);
  });
});

describe('stats answers', () => {
  it('takes a well-formed answer and refuses anything else', () => {
    expect(parseStats(GOOD)).toEqual(GOOD);
    for (const bad of [
      null,
      'x',
      { ...GOOD, playing: -1 },
      { ...GOOD, playing: 1.5 },
      { ...GOOD, filled: 101 },
      { ...GOOD, phase: 'final' },
      { ...GOOD, rates: { ...GOOD.rates, saturated: [1, 2, 3] } },
      { ...GOOD, rates: { ...GOOD.rates, contested: [0, 0, 0, 0] } },
      { ...GOOD, rates: { settling: GOOD.rates.settling } },
    ]) {
      expect(parseStats(bad)).toBeNull();
    }
  });

  it('reads built and growsAt when they are percents, as absent otherwise (ADR 0033)', () => {
    // A canvas that predates them, and a map already open in full.
    const { built: _b, growsAt: _g, ...older } = GOOD;
    expect(parseStats(older)).toEqual({ ...older, built: null, growsAt: null });
    expect(parseStats({ ...GOOD, growsAt: null })).toEqual({ ...GOOD, growsAt: null });
    // A value that is not a percent drops that field only.
    expect(parseStats({ ...GOOD, built: 140, growsAt: 'soon' })).toEqual({
      ...GOOD,
      built: null,
      growsAt: null,
    });
  });

  it('reads rates as whole-percent shares in item order', () => {
    expect(dropShares([85, 5, 0, 10])).toEqual([
      { kind: 'brick', percent: 85 },
      { kind: 'single', percent: 5 },
      { kind: 'hammer', percent: 0 },
      { kind: 'shield', percent: 10 },
    ]);
    // Weights need not sum to 100.
    expect(dropShares([2, 1, 1, 0]).map((s) => s.percent)).toEqual([50, 25, 25, 0]);
  });
});

describe('which count shows', () => {
  it('shows the newer of the poll and the socket, and nothing once both are stale', () => {
    const poll = { value: 10, at: 1_000 };
    const socket = { value: 12, at: 2_000 };
    expect(latestCount(poll, socket, 3_000)).toBe(12);
    expect(latestCount(poll, null, 3_000)).toBe(10);
    expect(latestCount(null, null, 3_000)).toBeNull();
    // The socket's count went stale first: the newer poll shows.
    expect(
      latestCount({ value: 10, at: 2_000 + STATS_STALE_MS }, socket, 2_000 + STATS_STALE_MS),
    ).toBe(10);
    expect(latestCount(poll, socket, 2_000 + STATS_STALE_MS)).toBeNull();
  });

  it('keeps the last good answer until it is stale', async () => {
    let now = 0;
    let answer: CanvasStats | null = GOOD as CanvasStats;
    const live = new LiveStats(
      async () => answer,
      () => now,
    );
    await live.refresh();
    expect(live.current(0)).toEqual(GOOD);
    // A failed poll keeps the last answer...
    answer = null;
    now = 30_000;
    await live.refresh();
    expect(live.current(30_000)).toEqual(GOOD);
    // ...until it is too old to show.
    expect(live.current(STATS_STALE_MS)).toBeNull();
  });

  it('asks the gateway only when the manifest has not brought stats lately (ADR 0033)', async () => {
    let now = 0;
    let asked = 0;
    const live = new LiveStats(
      async () => {
        asked++;
        return GOOD as CanvasStats;
      },
      () => now,
    );
    const fromManifest = { ...GOOD, playing: 7 } as CanvasStats;
    live.offerManifest({ ...fromManifest, at: 5_000 });
    // Unreadable manifest values change nothing.
    for (const bad of [null, 'x', { ...fromManifest }, { ...fromManifest, at: '1' }]) {
      live.offerManifest(bad);
    }
    now = STATS_POLL_MS - 1;
    await live.refreshIfOld();
    expect(asked).toBe(0);
    expect(live.current(now)).toEqual(fromManifest);
    // The feed stopped (a socket took over): the poll resumes.
    now = STATS_POLL_MS;
    await live.refreshIfOld();
    expect(asked).toBe(1);
    expect(live.current(now)).toEqual(GOOD);
  });

  it('skips manifest stats older than those in hand, or no longer written', () => {
    let now = 0;
    const live = new LiveStats(
      async () => null,
      () => now,
    );
    const shown = () => live.current(now)?.playing;
    live.offerManifest({ ...GOOD, playing: 7, at: 5_000 });
    // Another edge's older copy of the same manifest.
    now = 1_000;
    live.offerManifest({ ...GOOD, playing: 6, at: 4_000 });
    expect(shown()).toBe(7);
    // The canvas writes them at least once a minute while anyone plays: an `at` that stays
    // put that long means it stopped, and they are no longer taken.
    now = STATS_STALE_MS - 1;
    live.offerManifest({ ...GOOD, playing: 7, at: 5_000 });
    expect(live.state.get().at).toBe(STATS_STALE_MS - 1);
    now = STATS_STALE_MS;
    live.offerManifest({ ...GOOD, playing: 7, at: 5_000 });
    expect(live.state.get().at).toBe(STATS_STALE_MS - 1);
    // A newer write is taken again.
    live.offerManifest({ ...GOOD, playing: 8, at: 70_000 });
    expect(shown()).toBe(8);
    // With nobody playing nothing is rewritten, and none is needed: old ones stand.
    live.offerManifest({ ...GOOD, playing: 0, at: 80_000 });
    now = 10 * STATS_STALE_MS;
    live.offerManifest({ ...GOOD, playing: 0, at: 80_000 });
    expect(live.state.get().at).toBe(now);
  });
});
