import { describe, expect, it } from 'vitest';
import {
  ENDED_CHECK_MS,
  OVER_WAIT_MS,
  reloadAtOnce,
  SeasonWatch,
  type SeasonWatchDeps,
  START_SPREAD_MS,
  whenSettled,
} from '../src/game/season-watch.ts';
import { type Me, NOBODY, type SeasonInfo } from '../src/net/account.ts';

// A season changing under an open page (ADR 0021): the page asks /api/me again just after the
// next start (or after a refused `ended`) and says so once another canvas is current.

const s1: SeasonInfo = { id: 1, canvas: 's1', startsAt: 0, endsAt: 1_000, state: 'live' };
const s2: SeasonInfo = { id: 2, canvas: 's2', startsAt: 5_000, endsAt: 9_000, state: 'live' };

const me = (season: SeasonInfo | null, next: SeasonInfo | null = null): Me => ({
  ...NOBODY,
  config: {
    ...NOBODY.config,
    season,
    nextSeason: next ? { canvas: next.canvas, startsAt: next.startsAt } : null,
  },
});

/** A clock and timers the test moves by hand, and what the watch did. */
function harness(random = 0.5) {
  let now = 500;
  const timers = new Map<number, { at: number; run: () => void }>();
  let id = 0;
  const refreshes: number[] = [];
  const overs: number[] = [];
  const changes: (SeasonInfo | null)[] = [];
  const deps: SeasonWatchDeps = {
    refresh: async () => {
      refreshes.push(now);
    },
    over: () => overs.push(now),
    changed: (season) => changes.push(season),
    now: () => now,
    random: () => random,
    setTimeout: (run, ms) => {
      timers.set(++id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (timer) => timers.delete(timer as number),
  };
  const advance = (to: number) => {
    now = to;
    for (const [key, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(key);
      timer.run();
    }
  };
  return { deps, advance, refreshes, overs, changes, timers };
}

describe('season watch', () => {
  it('asks again just after the next start, spread at random, and says when it changed', () => {
    const h = harness(0.5);
    const watch = new SeasonWatch(me(s1, s2), h.deps);
    // s1's end, then s2's start: soon enough after it that one check covers both.
    expect([...h.timers.values()].map((t) => t.at)).toEqual([
      s1.endsAt,
      s2.startsAt + START_SPREAD_MS / 2,
    ]);
    h.advance(s1.endsAt);
    expect(h.overs).toEqual([s1.endsAt]);
    h.advance(s2.startsAt + START_SPREAD_MS / 2 - 1);
    expect(h.refreshes).toEqual([]);
    h.advance(s2.startsAt + START_SPREAD_MS / 2);
    expect(h.refreshes).toEqual([s2.startsAt + START_SPREAD_MS / 2]);
    // The answer names s2: the page loaded s1, so it must reload. Once.
    watch.observe(me(s2));
    watch.observe(me(s2));
    expect(h.changes).toEqual([s2]);
  });

  it('stays quiet while the canvas is the same, and plans each newly announced start', () => {
    const h = harness(0);
    const watch = new SeasonWatch(me(null), h.deps);
    expect(h.timers.size).toBe(0);
    // A renewal announces s1; then the same canvas again (Stage 0 has no season).
    watch.observe(me(null, s1));
    expect([...h.timers.values()].map((t) => t.at)).toEqual([500]);
    watch.observe(me(null, s2));
    expect([...h.timers.values()].map((t) => t.at)).toEqual([s2.startsAt]);
    expect(h.changes).toEqual([]);
    // Stage 0 to the first season counts as a change too.
    watch.observe(me(s1));
    expect(h.changes).toEqual([s1]);
    expect(h.timers.size).toBe(0);
  });

  it('stops playing at the end of its season, then asks whether the end moved', () => {
    const h = harness(0.5);
    const watch = new SeasonWatch(me(s1), h.deps);
    expect([...h.timers.values()].map((t) => t.at)).toEqual([
      s1.endsAt,
      s1.endsAt + START_SPREAD_MS / 2,
    ]);
    h.advance(s1.endsAt - 1);
    expect(h.overs).toEqual([]);
    // At the end on this page's clock: play stops at once, no request.
    h.advance(s1.endsAt);
    expect(h.overs).toEqual([s1.endsAt]);
    expect(h.refreshes).toEqual([]);
    // The page takes its last answer again meanwhile (a dialog opened): still live there, but
    // the check after the end stays where it was.
    watch.observe(me(s1));
    expect([...h.timers.values()].map((t) => t.at)).toEqual([s1.endsAt + START_SPREAD_MS / 2]);
    // Spread over the next half minute, the gateway is asked.
    h.advance(s1.endsAt + START_SPREAD_MS / 2);
    expect(h.refreshes).toEqual([s1.endsAt + START_SPREAD_MS / 2]);
    watch.observe(me(s1));
    expect(h.timers.size).toBe(0);
    // It says the season ended: nothing more to plan.
    watch.observe(me({ ...s1, state: 'ended' }));
    expect(h.timers.size).toBe(0);
  });

  it('stops playing once moves in flight are answered, or after a few seconds', () => {
    const h = harness();
    let pending = 2;
    const listeners = new Set<() => void>();
    const moves = {
      pending: () => pending,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const answer = (left: number) => {
      pending = left;
      for (const listener of [...listeners]) listener();
    };
    const stops: number[] = [];
    whenSettled(moves, () => stops.push(1), h.deps);
    answer(1);
    expect(stops).toEqual([]);
    answer(0);
    expect(stops).toEqual([1]);
    // Answered: no listener or timer left behind to stop it twice.
    expect(listeners.size).toBe(0);
    expect(h.timers.size).toBe(0);
    // An answer that never comes: stopped at the deadline.
    pending = 1;
    whenSettled(moves, () => stops.push(2), h.deps);
    h.advance(500 + OVER_WAIT_MS);
    expect(stops).toEqual([1, 2]);
    expect(listeners.size).toBe(0);
    // Nothing in flight: at once.
    pending = 0;
    whenSettled(moves, () => stops.push(3), h.deps);
    expect(stops).toEqual([1, 2, 3]);
  });

  it('follows an end that was moved, and plans none for a season already over', () => {
    const h = harness(0);
    const watch = new SeasonWatch(me(s1), h.deps);
    // An owner pushed the end back: the page plays on until the new one.
    watch.observe(me({ ...s1, endsAt: 3_000 }));
    expect([...h.timers.values()].map((t) => t.at)).toEqual([3_000, 3_000]);
    h.advance(1_000);
    expect(h.overs).toEqual([]);
    // Answers for a season that is over, by state or by time, plan no end.
    watch.observe(me({ ...s1, state: 'ended' }));
    expect(h.timers.size).toBe(0);
    watch.observe(me({ ...s1, endsAt: 900 }));
    expect(h.timers.size).toBe(0);
    expect(h.overs).toEqual([]);
  });

  it('asks again after a refused `ended`, at most once a minute', () => {
    const h = harness();
    // A season still far from its end, so only the refusals ask.
    const watch = new SeasonWatch(me({ ...s1, endsAt: 10 ** 9 }), h.deps);
    watch.ended();
    watch.ended();
    expect(h.refreshes).toEqual([500]);
    h.advance(500 + ENDED_CHECK_MS);
    watch.ended();
    expect(h.refreshes).toEqual([500, 500 + ENDED_CHECK_MS]);
  });

  it('takes no guess for a change: neither a guessed answer nor a season back to Stage 0', () => {
    const h = harness();
    const watch = new SeasonWatch(me(s1, s2), h.deps);
    // D1 down with nothing cached: the gateway guesses Stage 0 and says so.
    const guessed: Me = { ...me(null), config: { ...me(null).config, seasonGuessed: true } };
    watch.observe(guessed);
    // An answer without the mark that names Stage 0 after a season is no change either.
    watch.observe(me(null));
    expect(h.changes).toEqual([]);
    // The planned end and check stay, and a real change still counts.
    expect(h.timers.size).toBe(2);
    watch.observe(me(s2));
    expect(h.changes).toEqual([s2]);
  });

  it('reloads at once only a hidden page with no dialog open and no move awaiting its ack', () => {
    const idle = { hidden: true, dialogOpen: false, awaitingAck: false, holding: false };
    expect(reloadAtOnce(idle)).toBe(true);
    expect(reloadAtOnce({ ...idle, hidden: false })).toBe(false);
    expect(reloadAtOnce({ ...idle, dialogOpen: true })).toBe(false);
    expect(reloadAtOnce({ ...idle, awaitingAck: true })).toBe(false);
    // Another page of the account plays, or a Turnstile check is open (ADR 0026): a reload
    // would forget it, and a page that forgot it takes the socket back when shown.
    expect(reloadAtOnce({ ...idle, holding: true })).toBe(false);
  });

  it('takes its canvas from the first answer when /api/me gave none at load', () => {
    const h = harness();
    const watch = new SeasonWatch(null, h.deps);
    watch.observe(me(s1));
    expect(h.changes).toEqual([]);
    watch.observe(me(s2));
    expect(h.changes).toEqual([s2]);
  });
});
