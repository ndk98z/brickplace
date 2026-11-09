import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { foldNow } from '@brickplace/game/journal';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { END_LEAD_MS, MIN_START_LEAD_MS } from '../src/seasons.ts';
import { call, claims, envIn, type FakeAccess, fakeAccess, grant, serveKeys } from './support.ts';

// The season registry (ADR 0021, 0022): D1 `seasons` in the accounts database and the end on
// each season's canvas, kept in agreement by the admin Worker.

const testEnv = env as unknown as Env;
const accounts = testEnv.ACCOUNTS;
const admin = testEnv.ADMIN_DB;
const OWNER = 'season-owner@example.test';
const DAY = 86_400_000;
let access: FakeAccess;

beforeAll(async () => {
  access = await fakeAccess('season-key');
  await grant(OWNER, 'owner');
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Rows only: other test files resolve the current canvas from this table. And the Stage 0
  // canvas open again (every end set on it here lies in the future): other tests play on it.
  await accounts.prepare('DELETE FROM seasons').run();
  await testEnv.CANVAS.get(testEnv.CANVAS.idFromName('canvas')).setSchedule({ endsAt: null });
});

const stub = (canvas: string) => testEnv.CANVAS.get(testEnv.CANVAS.idFromName(canvas));

async function as(path: string, body?: unknown, extra: Partial<Env> = {}) {
  serveKeys(access.jwks);
  const token = await access.sign(claims(OWNER, Date.now()));
  return call(envIn('staging', extra), path, { token, body });
}

async function row(canvas: string) {
  return accounts
    .prepare('SELECT canvas, starts_at, ends_at FROM seasons WHERE canvas = ?')
    .bind(canvas)
    .first<{ canvas: string; starts_at: number; ends_at: number }>();
}

async function outcomes(action: string, target: string) {
  const { results } = await admin
    .prepare('SELECT outcome FROM audit_log WHERE action = ? AND target = ? ORDER BY id')
    .bind(action, target)
    .all<{ outcome: string }>();
  return results.map((r) => r.outcome);
}

/** A season far ahead, so the registry is not empty (no Stage 0 end is set). */
async function seed() {
  const far = Date.now() + 365 * DAY;
  await accounts
    .prepare(
      "INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES ('seed', ?, ?, 0)",
    )
    .bind(far, far + DAY)
    .run();
}

/**
 * A canvas that answers reads but whose setSchedule fails for its first `times` calls (then
 * works): `refuses` answers a refusal; `down` throws without taking the change; `lost` takes
 * it, then throws (the answer lost on the way back).
 */
function canvasWith(mode: 'refuses' | 'down' | 'lost', times = Number.POSITIVE_INFINITY) {
  const real = testEnv.CANVAS;
  let calls = 0;
  return {
    idFromName: (name: string) => real.idFromName(name),
    get: (id: DurableObjectId) => {
      const live = real.get(id);
      return {
        seasonStatus: () => live.seasonStatus(),
        setSchedule: async (change: { endsAt: number | null }) => {
          if (calls++ >= times) return live.setSchedule(change);
          if (mode === 'refuses') return { ok: false, reason: 'invalid' };
          if (mode === 'lost') await live.setSchedule(change);
          throw new Error('network');
        },
      };
    },
  } as unknown as Env['CANVAS'];
}

type Change = { endsAt: number | null };
type Live = { setSchedule(change: Change): Promise<unknown> };

/** A canvas whose setSchedule calls run `steps` in turn (each given the live canvas), then work. */
function canvasScript(steps: ((live: Live, change: Change) => Promise<unknown>)[]) {
  const real = testEnv.CANVAS;
  let calls = 0;
  return {
    idFromName: (name: string) => real.idFromName(name),
    get: (id: DurableObjectId) => {
      const live = real.get(id);
      return {
        seasonStatus: () => live.seasonStatus(),
        setSchedule: (change: Change) => {
          const step = steps[calls++];
          return step ? step(live as unknown as Live, change) : live.setSchedule(change);
        },
      };
    },
  } as unknown as Env['CANVAS'];
}

const network = () => Promise.reject(new Error('network'));

/** The accounts database, failing every statement that starts with `verb`. */
function failing(verb: string): D1Database {
  return new Proxy(accounts, {
    get(target, key) {
      if (key !== 'prepare') return Reflect.get(target, key).bind(target);
      return (sql: string) => {
        if (!sql.startsWith(verb)) return target.prepare(sql);
        const fail = { bind: () => fail, run: () => Promise.reject(new Error('D1 down')) };
        return fail;
      };
    },
  });
}

describe('seasons', () => {
  it('registers a season: the row, then the same end on its canvas', async () => {
    const startsAt = Date.now() + 30 * DAY;
    const endsAt = startsAt + 7 * DAY;
    const response = await as('/api/seasons', { canvas: 's1', startsAt, endsAt, reason: 'go' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      season: { canvas: 's1', startsAt, endsAt, state: 'scheduled' },
      // Stage 0 has the defaults, as a new canvas does: nothing to carry over.
      carried: [
        { scope: 'items', carried: 'same' },
        { scope: 'growth', carried: 'same' },
      ],
    });
    expect(await row('s1')).toEqual({ canvas: 's1', starts_at: startsAt, ends_at: endsAt });
    expect((await stub('s1').seasonStatus()).endsAt).toBe(endsAt);
    // The first season also ends the Stage 0 canvas at its start (ADR 0021).
    expect((await stub('canvas').seasonStatus()).endsAt).toBe(startsAt);
    expect(await outcomes('season.create', 's1')).toEqual(['requested', 'ok']);
    const list = await (await as('/api/seasons')).json();
    expect(list).toEqual({
      available: true,
      seasons: [{ canvas: 's1', startsAt, endsAt, state: 'scheduled' }],
    });
    // Clear the Stage 0 end again: other tests play on that canvas.
    expect(await stub('canvas').setSchedule({ endsAt: null })).toMatchObject({ ok: true });
  });

  it('carries the settings in force over to the new canvas, audited, and reports a failure', async () => {
    await seed();
    // The canvas players are on (Stage 0 here) runs a longer cooldown and its own growth rule.
    const real = testEnv.CANVAS;
    const stage0 = real.idFromName('canvas');
    const live = real.get(stage0);
    const state = await live.configState();
    const items = { ...state.items, cooldown: state.items.cooldown * 3 };
    const growth = { atPercent: 60, step: 128 };
    const changed = {
      idFromName: (name: string) => real.idFromName(name),
      get: (id: DurableObjectId) => {
        if (!id.equals(stage0)) return real.get(id);
        return {
          seasonStatus: () => live.seasonStatus(),
          setSchedule: (change: { endsAt: number | null }) => live.setSchedule(change),
          configState: async () => ({ ...(await live.configState()), items, growth }),
        };
      },
    } as unknown as Env['CANVAS'];
    const startsAt = Date.now() + 90 * DAY;
    const body = { canvas: 'carry1', startsAt, endsAt: startsAt + DAY, reason: 'next season' };
    const response = await as('/api/seasons', body, { CANVAS: changed });
    expect(response.status).toBe(200);
    const { carried } = (await response.json()) as { carried: { scope: string }[] };
    expect(carried).toEqual([
      { scope: 'items', carried: expect.any(Number) },
      { scope: 'growth', carried: expect.any(Number) },
    ]);
    // In force on the new canvas from its first op on.
    const now = await stub('carry1').configState(startsAt);
    expect(now.items).toEqual({ ...items, version: now.current.items });
    expect(now.growth).toEqual(growth);
    // Recorded and delivered like any version, and audited under its own action.
    const { results } = await admin
      .prepare(
        "SELECT scope, delivered_at, note FROM config_versions WHERE canvas = 'carry1' ORDER BY id",
      )
      .all<{ scope: string; delivered_at: number | null; note: string }>();
    expect(results.map((r) => [r.scope, r.delivered_at !== null])).toEqual([
      ['items', true],
      ['growth', true],
    ]);
    expect(results[0]!.note).toContain('Carried over from canvas');
    const { results: audits } = await admin
      .prepare("SELECT target, outcome FROM audit_log WHERE action = 'config.carry' ORDER BY id")
      .all<{ target: string; outcome: string }>();
    expect(audits.filter((a) => a.target.startsWith('carry1/')).map((a) => a.outcome)).toEqual([
      'ok',
      'ok',
    ]);

    // A canvas whose settings cannot be read: the season stands, and the reply says so.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable = {
      idFromName: (name: string) => real.idFromName(name),
      get: (id: DurableObjectId) => {
        if (!id.equals(stage0)) return real.get(id);
        return {
          seasonStatus: () => live.seasonStatus(),
          setSchedule: (change: { endsAt: number | null }) => live.setSchedule(change),
          configState: () => Promise.reject(new Error('down')),
        };
      },
    } as unknown as Env['CANVAS'];
    const later = startsAt + 10 * DAY;
    const second = await as(
      '/api/seasons',
      { canvas: 'carry2', startsAt: later, endsAt: later + DAY, reason: 'x' },
      { CANVAS: unreadable },
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { carried: unknown }).carried).toEqual([
      { scope: 'items', error: 'canvas canvas could not be read' },
      { scope: 'growth', error: 'canvas canvas could not be read' },
    ]);
    expect(await row('carry2')).not.toBeNull();
  });

  it("sets a scheduled season's config before it starts, and nothing else beside the current", async () => {
    await seed();
    const startsAt = Date.now() + 120 * DAY;
    const body = { canvas: 'cfg1', startsAt, endsAt: startsAt + DAY, reason: 'next season' };
    expect((await as('/api/seasons', body)).status).toBe(200);
    const before = await stub('cfg1').configState();
    const items = { ...before.items, cooldown: before.items.cooldown + 7_000 };
    const made = await as('/api/config', {
      canvas: 'cfg1',
      scope: 'items',
      config: items,
      effectiveAt: null,
      reason: 'longer cooldown next season',
    });
    expect(made.status).toBe(200);
    // On the scheduled canvas, in force from its first op; the current canvas is untouched.
    expect((await stub('cfg1').configState(startsAt)).items.cooldown).toBe(items.cooldown);
    expect((await stub('canvas').configState()).items.cooldown).toBe(before.items.cooldown);
    const view = (await (await as('/api/config?canvas=cfg1')).json()) as {
      canvas: string;
      versions: { canvas: string }[];
    };
    expect(view.canvas).toBe('cfg1');
    expect(view.versions.every((v) => v.canvas === 'cfg1')).toBe(true);
    const { results } = await admin
      .prepare(
        "SELECT outcome FROM audit_log WHERE action = 'config.schedule' AND target LIKE 'cfg1/%'",
      )
      .all<{ outcome: string }>();
    expect(results.map((r) => r.outcome)).toEqual(['ok']);
    // Cancel and retry take the canvas too: a version of cfg1 is not found on the current one.
    const later = await as('/api/config', {
      canvas: 'cfg1',
      scope: 'items',
      config: items,
      effectiveAt: startsAt + DAY / 2,
      reason: 'midway change',
    });
    expect(later.status).toBe(200);
    const id = ((await later.json()) as { version: { id: number } }).version.id;
    expect((await as(`/api/config/${id}/cancel`, { reason: 'not needed' })).status).toBe(404);
    expect((await as(`/api/config/${id}/deliver`, { reason: 'again' })).status).toBe(404);
    const retried = await as(`/api/config/${id}/deliver`, { canvas: 'cfg1', reason: 'again' });
    expect(retried.status).toBe(200);
    const cancelled = await as(`/api/config/${id}/cancel`, {
      canvas: 'cfg1',
      reason: 'not needed',
    });
    expect(cancelled.status).toBe(200);
    expect(
      (await stub('cfg1').configState()).versions.find((v) => v.effectiveAt === startsAt + DAY / 2)
        ?.cancelled,
    ).toBe(true);
    // A started season, or a name nobody registered, is refused before any canvas is reached.
    const now = Date.now();
    // cfg0 started, then cfg00 after it: cfg00 is current, cfg0 neither current nor scheduled.
    await accounts
      .prepare(
        'INSERT INTO seasons (canvas, starts_at, ends_at, created_at) ' +
          "VALUES ('cfg0', ?, ?, 0), ('cfg00', ?, ?, 0)",
      )
      .bind(now - 10 * DAY, now - 9 * DAY, now - 8 * DAY, now - 7 * DAY)
      .run();
    const reached = vi.fn();
    const watched = { idFromName: reached, get: reached } as unknown as Env['CANVAS'];
    const started = await as(
      '/api/config',
      { canvas: 'cfg0', scope: 'items', config: items, reason: 'x' },
      { CANVAS: watched },
    );
    expect(started.status).toBe(409);
    const unknown = await as('/api/config?canvas=nobody', undefined, { CANVAS: watched });
    expect(unknown.status).toBe(404);
    expect(reached).not.toHaveBeenCalled();
  });

  it('refuses bad names, the Stage 0 name and taken names or starts', async () => {
    await seed();
    const at = Date.now() + 40 * DAY;
    const ok = { canvas: 's2', startsAt: at, endsAt: at + DAY, reason: 'x' };
    expect((await as('/api/seasons', ok)).status).toBe(200);
    for (const body of [
      { ...ok, canvas: 'S3' },
      { ...ok, canvas: '-s3' },
      { ...ok, canvas: 'canvas', startsAt: at + 5 * DAY, endsAt: at + 6 * DAY },
      // The same canvas at another time; another canvas at the same start.
      { ...ok, startsAt: at + 5 * DAY, endsAt: at + 6 * DAY },
      { ...ok, canvas: 's3' },
    ]) {
      expect((await as('/api/seasons', body)).status, JSON.stringify(body)).toBe(409);
    }
    expect((await as('/api/seasons', { ...ok, canvas: 's3', endsAt: at - 1 })).status).toBe(400);
  });

  it('keeps the Stage 0 end at the earliest start, whatever moves', async () => {
    const t = Date.now() + 20 * DAY;
    const s1 = { canvas: 'e1', startsAt: t, endsAt: t + 7 * DAY, reason: 'x' };
    expect((await as('/api/seasons', s1)).status).toBe(200);
    expect((await stub('canvas').seasonStatus()).endsAt).toBe(t);
    // The first season starts later: Stage 0 must not close at the old start.
    const later = await as('/api/seasons/e1/schedule', { startsAt: t + DAY, reason: 'later' });
    expect(later.status).toBe(200);
    expect((await stub('canvas').seasonStatus()).endsAt).toBe(t + DAY);
    // A season before it becomes the first one.
    const before = { canvas: 'e0', startsAt: t - 5 * DAY, endsAt: t - DAY, reason: 'x' };
    expect((await as('/api/seasons', before)).status).toBe(200);
    expect((await stub('canvas').seasonStatus()).endsAt).toBe(t - 5 * DAY);
    // A later season leaves it alone.
    const after = { canvas: 'e2', startsAt: t + 30 * DAY, endsAt: t + 31 * DAY, reason: 'x' };
    expect((await as('/api/seasons', after)).status).toBe(200);
    expect((await stub('canvas').seasonStatus()).endsAt).toBe(t - 5 * DAY);
  });

  it('refuses overlapping seasons and starts in the past', async () => {
    await seed();
    const t = Date.now() + 80 * DAY;
    expect(
      (await as('/api/seasons', { canvas: 'o1', startsAt: t, endsAt: t + 7 * DAY, reason: 'x' }))
        .status,
    ).toBe(200);
    for (const body of [
      { canvas: 'o2', startsAt: t + DAY, endsAt: t + 8 * DAY, reason: 'x' },
      { canvas: 'o2', startsAt: t - DAY, endsAt: t + DAY, reason: 'x' },
      { canvas: 'o2', startsAt: Date.now() - DAY, endsAt: Date.now() + DAY, reason: 'x' },
    ]) {
      expect((await as('/api/seasons', body)).status, JSON.stringify(body)).toBe(409);
    }
    // Back to back is fine; stretching one into the other is not.
    const next = { canvas: 'o2', startsAt: t + 7 * DAY, endsAt: t + 8 * DAY, reason: 'x' };
    expect((await as('/api/seasons', next)).status).toBe(200);
    const stretch = await as('/api/seasons/o1/schedule', { endsAt: t + 7 * DAY + 1, reason: 'x' });
    expect(stretch.status).toBe(409);
    expect((await stub('o1').seasonStatus()).endsAt).toBe(t + 7 * DAY);
  });

  it('needs every start at least five minutes ahead, new or moved', async () => {
    await seed();
    expect(MIN_START_LEAD_MS).toBe(5 * 60 * 1000);
    const soon = Date.now() + MIN_START_LEAD_MS - 10_000;
    const tooSoon = await as('/api/seasons', {
      canvas: 'l1',
      startsAt: soon,
      endsAt: soon + DAY,
      reason: 'x',
    });
    expect(tooSoon.status).toBe(409);
    expect(await tooSoon.json()).toMatchObject({ error: 'refused', detail: /5 minutes/ });
    expect(await row('l1')).toBeNull();
    // Comfortably past the lead: accepted. Moving that start within the lead is refused.
    const later = Date.now() + MIN_START_LEAD_MS + 60_000;
    const ok = { canvas: 'l1', startsAt: later, endsAt: later + DAY, reason: 'x' };
    expect((await as('/api/seasons', ok)).status).toBe(200);
    const moved = await as('/api/seasons/l1/schedule', { startsAt: soon, reason: 'sooner' });
    expect(moved.status).toBe(409);
    expect((await row('l1'))!.starts_at).toBe(later);
  });

  it('moves an end on the canvas and in the registry together', async () => {
    await seed();
    const startsAt = Date.now() + 50 * DAY;
    await as('/api/seasons', { canvas: 's4', startsAt, endsAt: startsAt + DAY, reason: 'x' });
    const endsAt = startsAt + 3 * DAY;
    const moved = await as('/api/seasons/s4/schedule', { endsAt, reason: 'longer' });
    expect(moved.status).toBe(200);
    expect((await row('s4'))?.ends_at).toBe(endsAt);
    expect((await stub('s4').seasonStatus()).endsAt).toBe(endsAt);
    expect(await outcomes('season.schedule', 's4')).toEqual(['requested', 'ok']);
  });

  it('ends a running season now, on both, and ending it again changes nothing', async () => {
    await seed();
    const startsAt = Date.now() - DAY;
    await accounts
      .prepare(
        "INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES ('s5', ?, ?, 0)",
      )
      .bind(startsAt, startsAt + 7 * DAY)
      .run();
    // The season has started: it is the current canvas.
    expect(await (await as('/api/emergency/read-only')).json()).toMatchObject({
      status: { canvas: 's5' },
    });
    const before = Date.now();
    const ended = await as('/api/seasons/s5/end', { reason: 'early end' });
    expect(ended.status).toBe(200);
    const endsAt = (await row('s5'))!.ends_at;
    expect(endsAt).toBeGreaterThanOrEqual(before);
    expect((await stub('s5').seasonStatus()).endsAt).toBe(endsAt);
    const again = await as('/api/seasons/s5/end', { reason: 'again' });
    expect(again.status).toBe(200);
    expect((await row('s5'))!.ends_at).toBe(endsAt);
    expect((await stub('s5').seasonStatus()).endsAt).toBe(endsAt);
    expect(await outcomes('season.end', 's5')).toEqual(['requested', 'ok', 'requested', 'ok']);
  });

  it('undoes the row when the canvas refuses the end, and audits it', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 60 * DAY;
    const body = { canvas: 's6', startsAt, endsAt: startsAt + DAY, reason: 'x' };
    const response = await as('/api/seasons', body, { CANVAS: canvasWith('refuses') });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'undone' });
    expect(await row('s6')).toBeNull();
    expect(await outcomes('season.create', 's6')).toEqual(['requested', 'undone']);
    // If even the undo fails, the result says what each side holds and how to repair it.
    const both = await as('/api/seasons', body, {
      CANVAS: canvasWith('refuses'),
      ACCOUNTS: failing('DELETE'),
    });
    const bothAnswer = (await both.json()) as { error: string; detail: string };
    expect(bothAnswer.error).toBe('inconsistent');
    expect(bothAnswer.detail).toContain(`row: starts ${startsAt}, ends ${startsAt + DAY}`);
    expect(bothAnswer.detail).toContain('canvas end: none');
    expect(bothAnswer.detail).toContain(
      `schedule it with an end different from the row's current end ${startsAt + DAY}`,
    );
    expect(await outcomes('season.create', 's6')).toEqual([
      'requested',
      'undone',
      'requested',
      'inconsistent',
    ]);
  });

  it('removes the row and clears the end when a create cannot reach the canvas', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 62 * DAY;
    const endsAt = startsAt + DAY;
    const body = { canvas: 'c8', startsAt, endsAt, reason: 'x' };
    // The end lands, its answer is lost; clearing it again goes through: undone.
    const lost = await as('/api/seasons', body, { CANVAS: canvasWith('lost', 1) });
    expect(lost.status).toBe(502);
    expect(await lost.json()).toMatchObject({ error: 'undone' });
    expect(await row('c8')).toBeNull();
    expect((await stub('c8').seasonStatus()).endsAt).toBeNull();
    // Nothing reaches the canvas, the clearing included: the read-back finds nothing left.
    const down = await as('/api/seasons', body, { CANVAS: canvasWith('down') });
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ error: 'undone' });
    expect(await row('c8')).toBeNull();
    // The row cannot be removed either: the answer names what each side holds.
    const stuck = await as('/api/seasons', body, {
      CANVAS: canvasWith('down'),
      ACCOUNTS: failing('DELETE'),
    });
    const stuckAnswer = (await stuck.json()) as { error: string; detail: string };
    expect(stuckAnswer.error).toBe('inconsistent');
    expect(stuckAnswer.detail).toContain(`row: starts ${startsAt}, ends ${endsAt}`);
    expect(stuckAnswer.detail).toContain('canvas end: none');
    // The stated repair works.
    const repaired = await as('/api/seasons/c8/schedule', { endsAt: endsAt + DAY, reason: 'y' });
    expect(repaired.status).toBe(200);
    expect((await row('c8'))?.ends_at).toBe(endsAt + DAY);
    expect((await stub('c8').seasonStatus()).endsAt).toBe(endsAt + DAY);
    expect(await outcomes('season.create', 'c8')).toEqual([
      'requested',
      'undone',
      'requested',
      'undone',
      'requested',
      'inconsistent',
    ]);
  });

  it('keeps the name taken while it clears the end, so a concurrent create keeps its own', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 64 * DAY;
    const a = { canvas: 'c10', startsAt, endsAt: startsAt + DAY, reason: 'a' };
    const b = { canvas: 'c10', startsAt, endsAt: startsAt + 2 * DAY, reason: 'b' };
    let concurrent: Response | null = null;
    const racing = canvasScript([
      // A's end lands, its answer is lost.
      async (live, change) => {
        await live.setSchedule(change);
        throw new Error('network');
      },
      // Another admin creates the same season while A cleans up, just before A's clearing.
      async (live, change) => {
        concurrent = await as('/api/seasons', b);
        return live.setSchedule(change);
      },
    ]);
    const first = await as('/api/seasons', a, { CANVAS: racing });
    expect(await first.json()).toMatchObject({ error: 'undone' });
    // A's row still held the name: B could not slip in and lose its end to A's clearing.
    expect(concurrent!.status).toBe(409);
    expect(await row('c10')).toBeNull();
    expect((await stub('c10').seasonStatus()).endsAt).toBeNull();
    // Once A is done, B goes through and keeps its end.
    expect((await as('/api/seasons', b)).status).toBe(200);
    expect((await row('c10'))?.ends_at).toBe(b.endsAt);
    expect((await stub('c10').seasonStatus()).endsAt).toBe(b.endsAt);
  });

  it('answers inconsistent when the canvas refuses the clearing after an unreachable create', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 66 * DAY;
    const body = { canvas: 'c11', startsAt, endsAt: startsAt + DAY, reason: 'x' };
    const refusing = canvasScript([
      // The end lands, its answer is lost; then the clearing is refused.
      async (live, change) => {
        await live.setSchedule(change);
        throw new Error('network');
      },
      async () => ({ ok: false, reason: 'closed' }),
    ]);
    const response = await as('/api/seasons', body, { CANVAS: refusing });
    expect(response.status).toBe(502);
    const answer = (await response.json()) as { error: string; detail: string };
    expect(answer.error).toBe('inconsistent');
    expect(answer.detail).toContain(`row: absent; canvas end: ${body.endsAt}`);
    expect(answer.detail).toContain('create the season again to repair');
    expect(await row('c11')).toBeNull();
    // The stated repair converges.
    expect((await as('/api/seasons', body)).status).toBe(200);
    expect((await row('c11'))?.ends_at).toBe(body.endsAt);
    expect((await stub('c11').seasonStatus()).endsAt).toBe(body.endsAt);
    expect(await outcomes('season.create', 'c11')).toEqual([
      'requested',
      'inconsistent',
      'requested',
      'ok',
    ]);
  });

  it('lets a create stand when its row could not be removed and both sides agree, noting why', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 67 * DAY;
    const body = { canvas: 'c14', startsAt, endsAt: startsAt + DAY, reason: 'x' };
    // Unreachable, cleared, the row cannot be removed: the end is set again.
    const stuck = await as('/api/seasons', body, {
      CANVAS: canvasScript([network]),
      ACCOUNTS: failing('DELETE'),
    });
    expect(stuck.status).toBe(200);
    expect((await row('c14'))?.ends_at).toBe(body.endsAt);
    expect((await stub('c14').seasonStatus()).endsAt).toBe(body.endsAt);
    const { results } = await admin
      .prepare(
        "SELECT outcome, after FROM audit_log WHERE action = 'season.create' AND target = 'c14' " +
          'ORDER BY id',
      )
      .all<{ outcome: string; after: string }>();
    expect(results.map((r) => r.outcome)).toEqual(['requested', 'ok']);
    expect(JSON.parse(results[1]!.after)).toMatchObject({
      canvas: 'c14',
      endsAt: body.endsAt,
      note: 'the end was sent again after the canvas could not be reached and the row could not be removed',
    });
  });

  it('reads back a removal that committed before it threw, and names the repair', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 70 * DAY;
    const body = { canvas: 'c15', startsAt, endsAt: startsAt + DAY, reason: 'x' };
    // The DELETE runs, then its answer is lost.
    const committing = new Proxy(accounts, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key).bind(target);
        return (sql: string) => {
          if (!sql.startsWith('DELETE')) return target.prepare(sql);
          const real = target.prepare(sql);
          const lost = (values: unknown[]) => ({
            bind: (...more: unknown[]) => lost([...values, ...more]),
            run: async () => {
              await real.bind(...values).run();
              throw new Error('D1 answer lost');
            },
          });
          return lost([]);
        };
      },
    });
    const response = await as('/api/seasons', body, {
      CANVAS: canvasScript([network]),
      ACCOUNTS: committing,
    });
    expect(response.status).toBe(502);
    const answer = (await response.json()) as { error: string; detail: string };
    expect(answer.error).toBe('inconsistent');
    expect(answer.detail).toContain(`row: absent; canvas end: ${body.endsAt}`);
    expect(answer.detail).toContain('create the season again to repair');
    // The stated repair converges.
    expect((await as('/api/seasons', body)).status).toBe(200);
    expect((await row('c15'))?.ends_at).toBe(body.endsAt);
    expect((await stub('c15').seasonStatus()).endsAt).toBe(body.endsAt);
  });

  it('names the repair when a stuck row cannot get its end back, and the repair works', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 68 * DAY;
    const endsAt = startsAt + DAY;
    const body = { canvas: 'c12', startsAt, endsAt, reason: 'x' };
    // Unreachable, cleared, the row cannot be removed, and the end cannot be set again.
    const script = canvasScript([
      network,
      (live, change) => live.setSchedule(change),
      async () => ({ ok: false, reason: 'invalid' }),
    ]);
    const response = await as('/api/seasons', body, {
      CANVAS: script,
      ACCOUNTS: failing('DELETE'),
    });
    expect(response.status).toBe(502);
    const answer = (await response.json()) as { error: string; detail: string };
    expect(answer.error).toBe('inconsistent');
    expect(answer.detail).toContain(`row: starts ${startsAt}, ends ${endsAt}; canvas end: none`);
    expect(answer.detail).toContain(
      `schedule it with an end different from the row's current end ${endsAt} to repair`,
    );
    expect((await row('c12'))?.ends_at).toBe(endsAt);
    expect((await stub('c12').seasonStatus()).endsAt).toBeNull();
    // Creating again is refused while the row stays; the stated repair works.
    expect((await as('/api/seasons', body)).status).toBe(409);
    const repaired = await as('/api/seasons/c12/schedule', { endsAt: endsAt + DAY, reason: 'y' });
    expect(repaired.status).toBe(200);
    expect((await row('c12'))?.ends_at).toBe(endsAt + DAY);
    expect((await stub('c12').seasonStatus()).endsAt).toBe(endsAt + DAY);
  });

  it('keeps a row another admin rescheduled while a failed create cleaned up', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 69 * DAY;
    const endsAt = startsAt + DAY;
    const other = endsAt + DAY;
    const body = { canvas: 'c13', startsAt, endsAt, reason: 'x' };
    const script = canvasScript([
      network,
      async (live, change) => {
        const cleared = await live.setSchedule(change);
        // Another admin's change lands on the row between the clearing and the removal.
        await accounts
          .prepare("UPDATE seasons SET ends_at = ? WHERE canvas = 'c13'")
          .bind(other)
          .run();
        return cleared;
      },
    ]);
    // The removal throws: the end is set again, and the read-back finds the two apart.
    const response = await as('/api/seasons', body, {
      CANVAS: script,
      ACCOUNTS: failing('DELETE'),
    });
    expect(response.status).toBe(502);
    const answer = (await response.json()) as { error: string; detail: string };
    expect(answer.error).toBe('inconsistent');
    expect(answer.detail).toContain(
      `row: starts ${startsAt}, ends ${other}; canvas end: ${endsAt}`,
    );
    expect(answer.detail).toContain(`an end different from the row's current end ${other}`);
    expect((await row('c13'))?.ends_at).toBe(other);
    // The stated repair converges.
    const repaired = await as('/api/seasons/c13/schedule', { endsAt: other + DAY, reason: 'y' });
    expect(repaired.status).toBe(200);
    expect((await row('c13'))?.ends_at).toBe(other + DAY);
    expect((await stub('c13').seasonStatus()).endsAt).toBe(other + DAY);
  });

  it('puts nothing back when the row is deleted under a schedule', async () => {
    await seed();
    const startsAt = Date.now() + 72 * DAY;
    const endsAt = startsAt + DAY;
    /** Another admin's removal lands between the canvas's new end and the row's update. */
    const vanishing = (canvas: string) =>
      new Proxy(accounts, {
        get(target, key) {
          if (key !== 'prepare') return Reflect.get(target, key).bind(target);
          return (sql: string) => {
            if (!sql.startsWith('UPDATE seasons SET starts_at')) return target.prepare(sql);
            const real = target.prepare(sql);
            const gone = (values: unknown[]) => ({
              bind: (...more: unknown[]) => gone([...values, ...more]),
              run: async () => {
                await target.prepare('DELETE FROM seasons WHERE canvas = ?').bind(canvas).run();
                return real.bind(...values).run();
              },
            });
            return gone([]);
          };
        },
      });
    // The end moved: the canvas may hold it with no row naming it.
    await as('/api/seasons', { canvas: 'r5', startsAt, endsAt, reason: 'x' });
    const moved = await as(
      '/api/seasons/r5/schedule',
      { endsAt: endsAt + DAY, reason: 'y' },
      { ACCOUNTS: vanishing('r5') },
    );
    expect(moved.status).toBe(502);
    const answer = (await moved.json()) as { error: string; detail: string };
    expect(answer.error).toBe('inconsistent');
    expect(answer.detail).toBe(
      `the row was removed meanwhile; the canvas may hold the end ${endsAt + DAY}; create the season again to repair`,
    );
    expect(await row('r5')).toBeNull();
    // Nothing is put back for a season that is gone.
    expect((await stub('r5').seasonStatus()).endsAt).toBe(endsAt + DAY);
    // Only the start moved: the canvas was not touched, so there is simply no season.
    await as('/api/seasons', {
      canvas: 'r6',
      startsAt: endsAt + 3 * DAY,
      endsAt: endsAt + 4 * DAY,
      reason: 'x',
    });
    const startOnly = await as(
      '/api/seasons/r6/schedule',
      { startsAt: endsAt + 3 * DAY + DAY / 2, reason: 'y' },
      { ACCOUNTS: vanishing('r6') },
    );
    expect(startOnly.status).toBe(404);
    expect(await startOnly.json()).toMatchObject({ error: 'not_found' });
    expect((await stub('r6').seasonStatus()).endsAt).toBe(endsAt + 4 * DAY);
  });

  it('names a repair the admin can run when the canvas cannot be read back', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 80 * DAY;
    const endsAt = startsAt + DAY;
    // A canvas fully down (a deploy resetting it): its reads fail too.
    const gone = {
      idFromName: (name: string) => testEnv.CANVAS.idFromName(name),
      get: () => ({ seasonStatus: network, setSchedule: network }),
    } as unknown as Env['CANVAS'];
    const ask = (canvas: string, extra: Partial<Env>) =>
      as('/api/seasons', { canvas, startsAt, endsAt, reason: 'x' }, { CANVAS: gone, ...extra });
    const detailOf = async (response: Response) => {
      const body = (await response.json()) as { error: string; detail: string };
      expect(body.error).toBe('inconsistent');
      return body.detail;
    };
    // Row removed: never `undone`, as the canvas may hold the end.
    expect(await detailOf(await ask('u3', {}))).toContain(
      'row: absent; canvas end: unreadable; the canvas may hold an end; create the season again to repair',
    );
    // Row left in place: schedule it.
    expect(await detailOf(await ask('u4', { ACCOUNTS: failing('DELETE') }))).toContain(
      `canvas end: unreadable; schedule it with an end different from the row's current end ${endsAt}`,
    );
    // Row unreadable too: both repairs, after listing the seasons. (u4's row would overlap.)
    await accounts.prepare("DELETE FROM seasons WHERE canvas = 'u4'").run();
    const blind = new Proxy(accounts, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key).bind(target);
        return (sql: string) => {
          if (!sql.startsWith('SELECT canvas, starts_at, ends_at FROM seasons WHERE canvas = ?')) {
            return target.prepare(sql);
          }
          const fail = { bind: () => fail, first: () => Promise.reject(new Error('D1 down')) };
          return fail;
        };
      },
    });
    expect(await detailOf(await ask('u5', { ACCOUNTS: blind }))).toContain(
      'row: unreadable; canvas end: unreadable; state unknown: list the seasons; create the season again if it is absent, otherwise schedule it',
    );
  });

  it('says to use another name when the canvas is no longer open', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 82 * DAY;
    const endsAt = startsAt + DAY;
    const ended = {
      idFromName: (name: string) => testEnv.CANVAS.idFromName(name),
      get: () => ({
        seasonStatus: async () => ({ endsAt: 5, readOnly: null, phase: 'ended' }),
        setSchedule: async () => ({ ok: false, reason: 'closed' }),
      }),
    } as unknown as Env['CANVAS'];
    const first = await as(
      '/api/seasons',
      { canvas: 'u6', startsAt, endsAt, reason: 'x' },
      { CANVAS: ended },
    );
    const detail = ((await first.json()) as { detail: string }).detail;
    expect(detail).toContain(
      'canvas end: 5 (ended); its canvas is ended: no end can be set; use another name',
    );
    expect(detail).not.toContain('remove the row');
    const stuck = await as(
      '/api/seasons',
      { canvas: 'u6', startsAt, endsAt, reason: 'x' },
      { CANVAS: ended, ACCOUNTS: failing('DELETE') },
    );
    expect(((await stuck.json()) as { detail: string }).detail).toContain(
      'use another name, and remove the row by hand',
    );
    // A row left in place whose end matches a canvas that is no longer open is not a season
    // that stands: that canvas will never take an op.
    await accounts.prepare("DELETE FROM seasons WHERE canvas = 'u6'").run();
    const sameEnd = {
      idFromName: (name: string) => testEnv.CANVAS.idFromName(name),
      get: () => ({
        seasonStatus: async () => ({ endsAt, readOnly: null, phase: 'ended' }),
        setSchedule: async () => ({ ok: false, reason: 'closed' }),
      }),
    } as unknown as Env['CANVAS'];
    const matching = await as(
      '/api/seasons',
      { canvas: 'u7', startsAt, endsAt, reason: 'x' },
      { CANVAS: sameEnd, ACCOUNTS: failing('DELETE') },
    );
    expect(matching.status).toBe(502);
    const answer = (await matching.json()) as { error: string; detail: string };
    expect(answer.error).toBe('inconsistent');
    expect(answer.detail).toContain(
      `canvas end: ${endsAt} (ended); its canvas is ended: no end can be set; use another name, and remove the row by hand`,
    );
    expect(await outcomes('season.create', 'u7')).toEqual(['requested', 'inconsistent']);
  });

  it('notes a row with other times, and catches a Stage 0 alignment that throws', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 84 * DAY;
    const endsAt = startsAt + DAY;
    const moving = (canvas: string) =>
      canvasScript([
        network,
        async (live, change) => {
          const cleared = await live.setSchedule(change);
          // Another admin moves the start between the clearing and the removal.
          await accounts
            .prepare('UPDATE seasons SET starts_at = ? WHERE canvas = ?')
            .bind(startsAt + DAY / 2, canvas)
            .run();
          return cleared;
        },
      ]);
    const noted = await as(
      '/api/seasons',
      { canvas: 'u7', startsAt, endsAt, reason: 'x' },
      { CANVAS: moving('u7'), ACCOUNTS: failing('DELETE') },
    );
    expect(noted.status).toBe(200);
    expect(((await noted.json()) as { note: string }).note).toBe(
      'the end was sent again after the canvas could not be reached and the row could not be removed; the row holds times another admin wrote',
    );
    // Both sides agree, but Stage 0 cannot be aligned.
    const stage0Fails = new Proxy(accounts, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key).bind(target);
        return (sql: string) => {
          if (sql.startsWith('SELECT MIN(starts_at)')) {
            const fail = { bind: () => fail, first: () => Promise.reject(new Error('D1 down')) };
            return fail;
          }
          if (sql.startsWith('DELETE')) {
            const fail = { bind: () => fail, run: () => Promise.reject(new Error('D1 down')) };
            return fail;
          }
          return target.prepare(sql);
        };
      },
    });
    const response = await as(
      '/api/seasons',
      { canvas: 'u8', startsAt: endsAt + DAY, endsAt: endsAt + 2 * DAY, reason: 'x' },
      { CANVAS: canvasScript([network]), ACCOUNTS: stage0Fails },
    );
    const answer = (await response.json()) as { error: string; detail: string };
    expect(answer.error).toBe('inconsistent');
    expect(answer.detail).toContain(
      'Stage 0 could not be aligned; schedule it again to repair Stage 0',
    );
  });

  it('puts the old end back when a new one cannot reach the canvas', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 75 * DAY;
    const endsAt = startsAt + DAY;
    await as('/api/seasons', { canvas: 'c9', startsAt, endsAt, reason: 'x' });
    // The new end lands, its answer is lost; the old one goes back on the next call.
    const lost = await as(
      '/api/seasons/c9/schedule',
      { endsAt: endsAt + DAY, reason: 'y' },
      { CANVAS: canvasWith('lost', 1) },
    );
    expect(lost.status).toBe(502);
    expect(await lost.json()).toMatchObject({ error: 'undone' });
    expect((await stub('c9').seasonStatus()).endsAt).toBe(endsAt);
    expect((await row('c9'))?.ends_at).toBe(endsAt);
    // Nothing reaches it, the old end included: both values are reported.
    const down = await as(
      '/api/seasons/c9/schedule',
      { endsAt: endsAt + 2 * DAY, reason: 'z' },
      { CANVAS: canvasWith('down') },
    );
    expect(down.status).toBe(502);
    const answer = (await down.json()) as { error: string; detail: string };
    expect(answer.error).toBe('inconsistent');
    expect(answer.detail).toContain(String(endsAt + 2 * DAY));
    expect(answer.detail).toContain(String(endsAt));
    expect((await row('c9'))?.ends_at).toBe(endsAt);
    // A refusal is still a refusal: nothing was taken.
    const refusedNow = await as(
      '/api/seasons/c9/schedule',
      { endsAt: endsAt + 3 * DAY, reason: 'w' },
      { CANVAS: canvasWith('refuses') },
    );
    expect(refusedNow.status).toBe(409);
    expect(await outcomes('season.schedule', 'c9')).toEqual([
      'requested',
      'undone',
      'requested',
      'inconsistent',
      'requested',
      'refused',
    ]);
  });

  it('puts the canvas back when the registry cannot take a new end', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() + 70 * DAY;
    const endsAt = startsAt + DAY;
    await as('/api/seasons', { canvas: 's7', startsAt, endsAt, reason: 'x' });
    const response = await as(
      '/api/seasons/s7/schedule',
      { endsAt: endsAt + DAY, reason: 'y' },
      { ACCOUNTS: failing('UPDATE') },
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'undone' });
    expect((await stub('s7').seasonStatus()).endsAt).toBe(endsAt);
    expect((await row('s7'))?.ends_at).toBe(endsAt);
    expect(await outcomes('season.schedule', 's7')).toEqual(['requested', 'undone']);
  });

  it('ends an active canvas whose ops carry times after the request', async () => {
    await seed();
    const startsAt = Date.now() - DAY;
    await accounts
      .prepare(
        "INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES ('a1', ?, ?, 0)",
      )
      .bind(startsAt, startsAt + 7 * DAY)
      .run();
    // A brick accepted with a time a few seconds ahead of the admin's request.
    const canvas = stub('a1');
    await runInDurableObject(canvas, (instance, state) => {
      foldNow(instance, state.storage);
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
          "VALUES ('p1', ?, 0, ?, 1)",
        JSON.stringify([{ kind: 'brick', shape: 1 }]),
        2 ** 50,
      );
    });
    const at = Date.now() + 5000;
    const brick = { kind: 'brick', x: 600, y: 600, shape: 1, rotation: 0, color: 3 } as const;
    const batch = await canvas.applyBatch([{ player: 'p1', opId: 1, op: brick }], at);
    expect(batch.results[0]).toMatchObject({ ok: true });
    const ended = await as('/api/seasons/a1/end', { reason: 'stop' });
    expect(ended.status).toBe(200);
    const endsAt = (await canvas.seasonStatus()).endsAt!;
    expect(endsAt).toBeGreaterThan(at);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + END_LEAD_MS);
    expect((await row('a1'))!.ends_at).toBe(endsAt);
  });

  it('answers inconsistent when the Stage 0 canvas cannot take the start, and repairs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = testEnv.CANVAS;
    const stage0 = real.idFromName('canvas');
    // Every canvas works but Stage 0, which cannot be set.
    const stage0Down = {
      idFromName: (name: string) => real.idFromName(name),
      get: (id: DurableObjectId) => {
        if (!id.equals(stage0)) return real.get(id);
        const live = real.get(id);
        return {
          seasonStatus: () => live.seasonStatus(),
          setSchedule: () => Promise.reject(new Error('network')),
        };
      },
    } as unknown as Env['CANVAS'];
    const t = Date.now() + 15 * DAY;
    const body = { canvas: 'i1', startsAt: t, endsAt: t + DAY, reason: 'x' };
    const response = await as('/api/seasons', body, { CANVAS: stage0Down });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'inconsistent' });
    // The season itself is saved on both sides.
    expect((await row('i1'))?.ends_at).toBe(t + DAY);
    expect((await stub('i1').seasonStatus()).endsAt).toBe(t + DAY);
    expect(await outcomes('season.create', 'i1')).toEqual(['requested', 'inconsistent']);
    // Scheduling it again aligns Stage 0.
    const again = await as('/api/seasons/i1/schedule', { endsAt: t + DAY, reason: 'repair' });
    expect(again.status).toBe(200);
    expect((await stub('canvas').seasonStatus()).endsAt).toBe(t);
  });

  it('ends the Stage 0 canvas now on request, for owners only', async () => {
    const before = Date.now();
    const response = await as('/api/stage0/end', { reason: 'missed the first start' });
    expect(response.status).toBe(200);
    const endsAt = (await stub('canvas').seasonStatus()).endsAt!;
    expect(endsAt).toBeGreaterThanOrEqual(before + END_LEAD_MS);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + END_LEAD_MS);
    expect(await outcomes('season.end_stage0', 'canvas')).toEqual(['requested', 'ok']);
    // Reopen at once, before the lead runs out: other tests play on it.
    expect(await stub('canvas').setSchedule({ endsAt: null })).toMatchObject({ ok: true });
    await grant('season-mod@example.test', 'moderator');
    serveKeys(access.jwks);
    const token = await access.sign(claims('season-mod@example.test', Date.now()));
    const mod = await call(envIn('staging'), '/api/stage0/end', { token, body: { reason: 'x' } });
    expect(mod.status).toBe(403);
  });

  it('checks overlap again in the write itself', async () => {
    await seed();
    const t = Date.now() + 90 * DAY;
    await as('/api/seasons', { canvas: 'r1', startsAt: t, endsAt: t + 7 * DAY, reason: 'x' });
    // The first check misses the other season (written by another admin meanwhile).
    const blind = new Proxy(accounts, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key).bind(target);
        return (sql: string) => {
          if (!sql.startsWith('SELECT canvas FROM seasons WHERE canvas <> ?')) {
            return target.prepare(sql);
          }
          const none = { bind: () => none, first: async () => null };
          return none;
        };
      },
    });
    const body = { canvas: 'r2', startsAt: t + DAY, endsAt: t + 8 * DAY, reason: 'x' };
    const response = await as('/api/seasons', body, { ACCOUNTS: blind });
    expect(response.status).toBe(409);
    expect(await row('r2')).toBeNull();
    const moved = await as(
      '/api/seasons/r1/schedule',
      { endsAt: t + 9 * DAY, reason: 'x' },
      { ACCOUNTS: blind },
    );
    expect(moved.status).toBe(200);
    // Stretching r1 is fine (nothing after it); now r2 cannot slip in, and r1 cannot stretch
    // over a season the check misses.
    await accounts
      .prepare(
        "INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES ('r3', ?, ?, 0)",
      )
      .bind(t + 20 * DAY, t + 21 * DAY)
      .run();
    const over = await as(
      '/api/seasons/r1/schedule',
      { endsAt: t + 25 * DAY, reason: 'x' },
      { ACCOUNTS: blind },
    );
    expect(over.status).toBe(409);
    // The canvas's end was put back.
    expect((await stub('r1').seasonStatus()).endsAt).toBe(t + 9 * DAY);
    expect((await row('r1'))!.ends_at).toBe(t + 9 * DAY);
  });

  it('answers inconsistent when the end cannot reach the canvas, and repairs when ended again', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() - DAY;
    await accounts
      .prepare(
        "INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES ('u1', ?, ?, 0)",
      )
      .bind(startsAt, startsAt + 7 * DAY)
      .run();
    // The end lands on the canvas, but its answer is lost on the way back.
    const lost = canvasWith('lost');
    const ended = await as('/api/seasons/u1/end', { reason: 'stop' }, { CANVAS: lost });
    expect(ended.status).toBe(502);
    expect(await ended.json()).toMatchObject({ error: 'inconsistent' });
    const canvasEnd = (await stub('u1').seasonStatus()).endsAt!;
    expect((await row('u1'))!.ends_at).not.toBe(canvasEnd);
    // Ending again copies the canvas's end into the row.
    expect((await as('/api/seasons/u1/end', { reason: 'repair' })).status).toBe(200);
    expect((await row('u1'))!.ends_at).toBe(canvasEnd);
    expect(await outcomes('season.end', 'u1')).toEqual([
      'requested',
      'inconsistent',
      'requested',
      'ok',
    ]);

    // Stage 0 alike.
    const stage0 = await as('/api/stage0/end', { reason: 'stop' }, { CANVAS: lost });
    expect(stage0.status).toBe(502);
    expect(await stage0.json()).toMatchObject({ error: 'inconsistent' });
    expect(await outcomes('season.end_stage0', 'canvas')).toContain('inconsistent');
  });

  it('answers unreachable, with nothing changed, when the canvas cannot even be read', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() - DAY;
    await accounts
      .prepare(
        "INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES ('u2', ?, ?, 0)",
      )
      .bind(startsAt, startsAt + 7 * DAY)
      .run();
    const down = {
      idFromName: (name: string) => testEnv.CANVAS.idFromName(name),
      get: () => ({
        seasonStatus: () => Promise.reject(new Error('network')),
        setSchedule: () => Promise.reject(new Error('network')),
      }),
    } as unknown as Env['CANVAS'];
    for (const path of ['/api/seasons/u2/end', '/api/stage0/end']) {
      const response = await as(path, { reason: 'stop' }, { CANVAS: down });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: 'unreachable' });
    }
    expect((await row('u2'))!.ends_at).toBe(startsAt + 7 * DAY);
    expect((await stub('u2').seasonStatus()).endsAt).toBeNull();
    expect(await outcomes('season.end', 'u2')).toEqual(['requested', 'unreachable']);
  });

  it('reports an end the registry missed, and repairs it when ended again', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startsAt = Date.now() - DAY;
    await accounts
      .prepare(
        "INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES ('s8', ?, ?, 0)",
      )
      .bind(startsAt, startsAt + 7 * DAY)
      .run();
    const broken = await as(
      '/api/seasons/s8/end',
      { reason: 'stop' },
      { ACCOUNTS: failing('UPDATE') },
    );
    expect(broken.status).toBe(502);
    expect(await broken.json()).toMatchObject({ error: 'inconsistent' });
    const canvasEnd = (await stub('s8').seasonStatus()).endsAt!;
    expect((await row('s8'))!.ends_at).not.toBe(canvasEnd);
    const repaired = await as('/api/seasons/s8/end', { reason: 'repair' });
    expect(repaired.status).toBe(200);
    expect((await row('s8'))!.ends_at).toBe(canvasEnd);
    expect(await outcomes('season.end', 's8')).toEqual([
      'requested',
      'inconsistent',
      'requested',
      'ok',
    ]);
  });
});
