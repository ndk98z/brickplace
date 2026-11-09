import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DEFAULT_ITEM_CONFIG, DEFAULT_OPEN_GROWTH, type State } from '@brickplace/core';
import { cdnKeys, parseManifest } from '@brickplace/protocol/cdn';
import { describe, expect, it } from 'vitest';
import type { ConfigSchedule } from '../src/config.ts';
import type { CanvasDO, Env } from '../src/index.ts';
import { MAX_REPORT_TEAMS, PRESENCE_TTL_MS, Presence, readReport } from '../src/presence.ts';
import { type CdnPublisher, STATS_MS, STATS_REFRESH_MS } from '../src/publish.ts';
import { pendingAlarm } from './alarms.ts';

// Who is playing (ADR 0030): shards report counts with their watchdog's cursor() call, the
// canvas sums the fresh ones and answers GET /api/stats through stats(), and puts the same
// numbers in the public manifest (ADR 0033).

const { CANVAS, TILES } = env as unknown as Required<Env>;

describe('presence reports', () => {
  it('accepts whole, bounded counts with distinct positive team ids only', () => {
    expect(
      readReport({
        players: 3,
        teams: [
          [7, 2],
          [9, 1],
        ],
      }),
    ).toEqual({
      players: 3,
      teams: [
        [7, 2],
        [9, 1],
      ],
    });
    expect(readReport({ players: 0, teams: [] })).toEqual({ players: 0, teams: [] });
    for (const bad of [
      null,
      undefined,
      'x',
      { players: -1, teams: [] },
      { players: 1.5, teams: [] },
      { players: 2 },
      { players: 2, teams: [[0, 1]] },
      { players: 2, teams: [[7, 3]] },
      {
        players: 2,
        teams: [
          [7, 1],
          [7, 1],
        ],
      },
      { players: 2, teams: [[7]] },
      { players: 2, teams: [['7', 1]] },
      { players: 1, teams: Array.from({ length: MAX_REPORT_TEAMS + 1 }, (_, i) => [i + 1, 0]) },
    ]) {
      expect(readReport(bad)).toBeNull();
    }
  });

  it('sums the fresh reports, one per shard, and only the teams asked for', () => {
    const presence = new Presence();
    presence.report(
      'a',
      {
        players: 5,
        teams: [
          [7, 2],
          [8, 3],
        ],
      },
      1_000,
    );
    presence.report('b', { players: 4, teams: [[7, 1]] }, 2_000);
    // A shard's new report replaces its last one.
    presence.report('a', { players: 6, teams: [[7, 4]] }, 3_000);
    expect(presence.totals([7], 3_000)).toEqual({ playing: 10, teams: [[7, 5]] });
    expect(presence.totals([8, 9], 3_000)).toEqual({
      playing: 10,
      teams: [
        [8, 0],
        [9, 0],
      ],
    });
    // b's report goes stale first.
    expect(presence.playing(2_000 + PRESENCE_TTL_MS)).toBe(6);
    expect(presence.totals([7], 2_000 + PRESENCE_TTL_MS)).toEqual({ playing: 6, teams: [[7, 4]] });
    expect(presence.playing(3_000 + PRESENCE_TTL_MS)).toBe(0);
  });

  it('says when the next report that counts players goes stale', () => {
    const presence = new Presence();
    expect(presence.staleAt()).toBeNull();
    // A report of nobody changes no count when it goes.
    presence.report('a', { players: 0, teams: [] }, 1_000);
    expect(presence.staleAt()).toBeNull();
    presence.report('b', { players: 2, teams: [] }, 2_000);
    presence.report('c', { players: 1, teams: [] }, 3_000);
    expect(presence.staleAt()).toBe(2_000 + PRESENCE_TTL_MS);
    presence.playing(2_000 + PRESENCE_TTL_MS);
    expect(presence.staleAt()).toBe(3_000 + PRESENCE_TTL_MS);
  });
});

describe('canvas presence and stats (ADR 0030)', () => {
  it('answers a shard report with the totals, and stats() with phase, filled and rates', async () => {
    const canvas = CANVAS.get(CANVAS.idFromName('presence'));
    const now = Date.now();
    // An older shard sends no report: the reply is as before.
    expect(await canvas.cursor('presence:fanout-0')).not.toHaveProperty('presence');
    // So is a report under a name no shard could have.
    expect(
      await canvas.cursor('x'.repeat(10_000), { players: 1, teams: [] }, now),
    ).not.toHaveProperty('presence');
    // A malformed one is ignored the same way.
    expect(await canvas.cursor('presence:fanout-0', { players: -2, teams: [] })).not.toHaveProperty(
      'presence',
    );
    const a = await canvas.cursor('presence:fanout-0', { players: 3, teams: [[5, 2]] }, now);
    expect(a.presence).toEqual({ playing: 3, teams: [[5, 2]] });
    const b = await canvas.cursor(
      'presence:fanout-1',
      {
        players: 2,
        teams: [
          [5, 1],
          [6, 1],
        ],
      },
      now,
    );
    expect(b.presence).toEqual({
      playing: 5,
      teams: [
        [5, 3],
        [6, 1],
      ],
    });
    const stats = await canvas.stats(now);
    expect(stats).toEqual({
      playing: 5,
      phase: 'settling',
      filled: 0,
      built: 0,
      growsAt: DEFAULT_OPEN_GROWTH.atPercent,
      rates: DEFAULT_ITEM_CONFIG.rates,
    });
    // Reports age out: nobody plays once every shard has gone quiet.
    expect((await canvas.stats(now + PRESENCE_TTL_MS)).playing).toBe(0);
  });

  it('tells the bricks growth counts (built) from the share no brick reaches (filled)', async () => {
    const canvas = CANVAS.get(CANVAS.idFromName('presence-built'));
    // Counters as on staging on 2026-11-02: 66% of the open area filled, 9% holes no brick
    // fits. Set by hand and put back: the stats only read them.
    const read = await runInDurableObject(canvas, async (o: CanvasDO) => {
      const { grid } = inside(o);
      const area = grid.config.open.w * grid.config.open.h;
      const saved = { ...grid.counters, config: grid.config };
      grid.counters.filled = Math.floor(area * 0.666);
      grid.counters.reachable = area - grid.counters.filled - Math.floor(area * 0.09);
      const growing = await o.stats(Date.now());
      // A map already open in full grows no more.
      grid.config = {
        ...grid.config,
        open: { x: 0, y: 0, w: grid.config.size, h: grid.config.size },
      };
      const whole = await o.stats(Date.now());
      grid.counters.filled = saved.filled;
      grid.counters.reachable = saved.reachable;
      grid.config = saved.config;
      return { growing, whole };
    });
    expect(read.growing.built).toBe(66);
    expect(read.growing.filled).toBe(75);
    expect(read.growing.growsAt).toBe(DEFAULT_OPEN_GROWTH.atPercent);
    expect(read.whole.growsAt).toBeNull();
  });

  it('puts the stats in the manifest, a count change alone at most every STATS_MS (ADR 0033)', async () => {
    const name = 'presence-cdn';
    const canvas = CANVAS.get(CANVAS.idFromName(name));
    const tick = (at: number) => runInDurableObject(canvas, (o: CanvasDO) => o.tick(at));
    const published = async () => {
      const object = await TILES.get(cdnKeys.manifest(`c/${name}`));
      return parseManifest(await object!.text()).stats;
    };
    const shard = `${name}:fanout-0`;
    const t0 = Date.now();
    const expectTickArms = (at: number, delay: number) =>
      expectArmed(canvas, () => tick(at), delay);
    const dueAt = () => runInDurableObject(canvas, (o: CanvasDO) => inside(o).cdn?.statsDueAt);
    // The first report owes a manifest at once, even on an empty, idle map; `at` is its time.
    await canvas.cursor(shard, { players: 3, teams: [] }, t0);
    await tick(t0);
    expect(await published()).toEqual({
      at: t0,
      playing: 3,
      phase: 'settling',
      filled: 0,
      built: 0,
      growsAt: DEFAULT_OPEN_GROWTH.atPercent,
      rates: DEFAULT_ITEM_CONFIG.rates,
    });
    // A new count waits STATS_MS after the last manifest, and the report asks for a tick
    // then (wall clock: the delay counted from the call).
    await expectArmed(
      canvas,
      () => canvas.cursor(shard, { players: 4, teams: [] }, t0 + 1_000),
      STATS_MS - 1_000,
    );
    await tick(t0 + 2_000);
    expect((await published())?.playing).toBe(3);
    await tick(t0 + STATS_MS);
    expect(await published()).toMatchObject({ playing: 4, at: t0 + STATS_MS });
    // The shard's next report, unchanged, keeps its stale time well past the refresh below.
    await canvas.cursor(shard, { players: 4, teams: [] }, t0 + STATS_MS);
    // Unchanged while someone plays: written again STATS_REFRESH_MS later, `at` moved on.
    // A tick asks for that wake itself.
    const refresh = t0 + STATS_MS + STATS_REFRESH_MS;
    expect(await dueAt()).toBe(refresh);
    await expectTickArms(t0 + STATS_MS, STATS_REFRESH_MS);
    await tick(refresh);
    expect(await published()).toMatchObject({ playing: 4, at: refresh });
    // The shard goes quiet: its report goes stale and the count falls back with no call. A
    // tick asks for a wake at the stale time, with nothing else to wake it.
    const stale = t0 + STATS_MS + PRESENCE_TTL_MS;
    expect(await runInDurableObject(canvas, (o: CanvasDO) => inside(o).presence.staleAt())).toBe(
      stale,
    );
    await expectTickArms(refresh, stale - refresh);
    await tick(stale);
    expect(await published()).toMatchObject({ playing: 0, at: stale });
    // Nobody left to count: nothing more owed, not even a refresh.
    expect(await dueAt()).toBeNull();
    // While the public bucket backs off, a report's tick waits for the backoff's end.
    const later = stale + 1_000;
    const backoffEnd = later + 200_000;
    await runInDurableObject(canvas, (o: CanvasDO) => {
      inside(o).cdnNextAt = backoffEnd;
    });
    await expectArmed(
      canvas,
      () => canvas.cursor(shard, { players: 2, teams: [] }, later),
      backoffEnd - later,
    );
    // So does a tick's wait for those stats: the 2-player report's stale time comes first.
    await expectTickArms(later, PRESENCE_TTL_MS);
  });

  it('shows a scheduled item config in the manifest once it takes effect', async () => {
    const name = 'presence-rates';
    const canvas = CANVAS.get(CANVAS.idFromName(name));
    const tick = (at: number) => runInDurableObject(canvas, (o: CanvasDO) => o.tick(at));
    const rates = async () => {
      const object = await TILES.get(cdnKeys.manifest(`c/${name}`));
      return parseManifest(await object!.text()).stats?.rates.settling;
    };
    const t0 = Date.now();
    await tick(t0);
    expect(await rates()).toEqual(DEFAULT_ITEM_CONFIG.rates.settling);
    expect(await pendingAlarm(canvas)).toBeNull();
    const settling = [1, 1, 1, 1] as const;
    const at = t0 + 10 * STATS_MS;
    const config = {
      ...DEFAULT_ITEM_CONFIG,
      version: 2,
      rates: { ...DEFAULT_ITEM_CONFIG.rates, settling },
    };
    // The canvas asks to wake when it takes effect, schedule() keeps asking after any tick,
    // and that tick writes the manifest.
    await expectArmed(
      canvas,
      async () => {
        const scheduled = await canvas.scheduleConfig(
          { scope: 'items', version: 2, effectiveAt: at, config },
          t0,
        );
        expect(scheduled.ok).toBe(true);
      },
      at - t0,
    );
    expect(
      await runInDurableObject(canvas, (o: CanvasDO) => inside(o).settings.nextItemsAt(t0)),
    ).toBe(at);
    await expectArmed(canvas, () => tick(t0 + 1), at - t0 - 1);
    await tick(at - 1);
    expect(await rates()).toEqual(DEFAULT_ITEM_CONFIG.rates.settling);
    await tick(at);
    expect(await rates()).toEqual(settling);
  });
});

/** The canvas's private parts, for tests. */
interface Inside {
  presence: Presence;
  cdn: CdnPublisher | null;
  settings: ConfigSchedule;
  alarmAt: number | null;
  cdnNextAt: number;
  grid: State;
}

function inside(o: CanvasDO): Inside {
  return o as unknown as Inside;
}

/** Drops the canvas's pending alarm, so a test sees only the ones asked for after. */
async function clearAlarm(canvas: DurableObjectStub<CanvasDO>): Promise<void> {
  await runInDurableObject(canvas, async (o: CanvasDO, state) => {
    await state.storage.deleteAlarm();
    inside(o).alarmAt = null;
  });
  expect(await pendingAlarm(canvas)).toBeNull();
}

/**
 * Checks that `step`, from a canvas with no alarm pending, asks for one `delay` ms out. The
 * canvas counts the delay from a wall-clock moment inside the step, so the alarm lies between
 * the step's start and end plus `delay`, however slow the runner.
 */
async function expectArmed(
  canvas: DurableObjectStub<CanvasDO>,
  step: () => Promise<unknown>,
  delay: number,
): Promise<void> {
  await clearAlarm(canvas);
  const before = Date.now();
  await step();
  const after = Date.now();
  const alarm = await pendingAlarm(canvas);
  expect(alarm).not.toBeNull();
  expect(alarm!).toBeGreaterThanOrEqual(before + delay);
  expect(alarm!).toBeLessThanOrEqual(after + delay);
}
