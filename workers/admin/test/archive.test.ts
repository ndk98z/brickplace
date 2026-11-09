import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { foldNow } from '@brickplace/game/journal';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { call, claims, envIn, type FakeAccess, fakeAccess, grant, serveKeys } from './support.ts';

// A season's archive from the admin area (ADR 0021, 0024): archive-only removals, added and
// dropped against the list the canvas holds, and the owner's "seal now", each audited before
// and after the call to the canvas.

const testEnv = env as unknown as Env;
const accounts = testEnv.ACCOUNTS;
const db = testEnv.ADMIN_DB;
const OWNER = 'archive-owner@example.test';
const MOD = 'archive-moderator@example.test';
const DAY = 86_400_000;
let access: FakeAccess;
let count = 0;

beforeAll(async () => {
  access = await fakeAccess('archive-key');
  await grant(OWNER, 'owner');
  await grant(MOD, 'moderator');
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Other files resolve the current canvas from this table.
  await accounts.prepare("DELETE FROM seasons WHERE canvas LIKE 'arch-%'").run();
});

const stub = (canvas: string) => testEnv.CANVAS.get(testEnv.CANVAS.idFromName(canvas));

async function as(email: string, path: string, body?: unknown, extra: Partial<Env> = {}) {
  serveKeys(access.jwks);
  const token = await access.sign(claims(email, Date.now()));
  return call(envIn('staging', extra), path, { token, body });
}

/**
 * A registered season whose canvas has ended (registered far ahead, so the current canvas of
 * other tests stays Stage 0). Its canvas holds two ops (seqs 1 and 2).
 */
async function endedSeason(): Promise<string> {
  const canvas = `arch-${++count}-${Date.now() % 100_000}`;
  const far = Date.now() + 400 * DAY + count * 2 * DAY;
  await accounts
    .prepare('INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES (?, ?, ?, 0)')
    .bind(canvas, far, far + DAY)
    .run();
  await playTwo(canvas);
  const endsAt = Date.now() + 1_000;
  expect((await stub(canvas).setSchedule({ endsAt })).ok).toBe(true);
  for (let i = 0; i < 10 && (await stub(canvas).seasonStatus()).phase !== 'ended'; i++) {
    await runInDurableObject(stub(canvas), (instance: { tick(now: number): Promise<void> }) =>
      instance.tick(endsAt + 60_000 * (i + 1)),
    );
  }
  expect((await stub(canvas).seasonStatus()).phase).toBe('ended');
  return canvas;
}

/** Two ops on `canvas`, so the season has seqs to remove. */
async function playTwo(canvas: string): Promise<void> {
  await runInDurableObject(stub(canvas), (instance, state) => {
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        "VALUES ('arch-player', ?, 0, ?, 1)",
      JSON.stringify([
        { kind: 'brick', shape: 1 },
        { kind: 'brick', shape: 1 },
      ]),
      2 ** 50,
    );
  });
  for (const x of [600, 610]) {
    const op = { kind: 'brick', x, y: 600, shape: 1, rotation: 0, color: 3 } as const;
    const batch = await stub(canvas).applyBatch([{ player: 'arch-player', opId: x, op }]);
    expect(batch.results[0]!.ok).toBe(true);
  }
}

async function openSeason(): Promise<string> {
  const canvas = `arch-${++count}-${Date.now() % 100_000}`;
  const far = Date.now() + 400 * DAY + count * 2 * DAY;
  await accounts
    .prepare('INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES (?, ?, ?, 0)')
    .bind(canvas, far, far + DAY)
    .run();
  return canvas;
}

async function player() {
  const id = crypto.randomUUID();
  const nickname = `Arch${Date.now() % 100_000}x${++count}`;
  await accounts
    .prepare(
      'INSERT INTO users (id, email, nickname, nickname_key, nickname_changed_at, created_at, ' +
        'signed_in_at) VALUES (?, ?, ?, ?, 0, 0, 0)',
    )
    .bind(id, `${id}@players.test`, nickname, nickname.toLowerCase())
    .run();
  return { id, nickname };
}

async function audits(action: string, target: string) {
  const { results } = await db
    .prepare(
      'SELECT actor, outcome, after FROM audit_log WHERE action = ? AND target = ? ORDER BY id',
    )
    .bind(action, target)
    .all<{ actor: string; outcome: string; after: string | null }>();
  return results;
}

const area = { x: 600, y: 600, w: 4, h: 4 };

describe('season archive', () => {
  it('has its part of the page, built without HTML strings', async () => {
    const page = await (await as(MOD, '/')).text();
    expect(page).toContain('id="ar-load"');
    const script = await (await as(MOD, '/admin.js')).text();
    expect(script).toContain("'/removals'");
    expect(script).toContain("'/seal'");
    expect(script).not.toContain('innerHTML');
  });

  it('answers 404 for a canvas no season has, without reaching a canvas', async () => {
    const get = vi.fn();
    const watched = { idFromName: get, get } as unknown as Env['CANVAS'];
    const response = await as(MOD, '/api/seasons/arch-nobody/archive', undefined, {
      CANVAS: watched,
    });
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("adds a player's removal by nickname over the whole season, audited before and after", async () => {
    const canvas = await endedSeason();
    const { id, nickname } = await player();
    const path = `/api/seasons/${canvas}`;
    const response = await as(MOD, `${path}/removals`, {
      add: { nickname, area },
      reason: 'offensive drawing found after the end',
    });
    expect(response.status).toBe(200);
    const final = (await stub(canvas).seasonStatus()).finalSeq!;
    const removal = { from: 1, to: final, area, player: id };
    expect(((await response.json()) as { removals: unknown[] }).removals).toEqual([removal]);
    expect((await stub(canvas).seasonStatus()).removals).toEqual([removal]);
    const rows = await audits('archive.removal_add', canvas);
    expect(rows.map((r) => [r.actor, r.outcome])).toEqual([
      [MOD, 'requested'],
      [MOD, 'ok'],
    ]);
    expect(JSON.parse(rows[1]!.after!)).toEqual(removal);
    // The archive view lists it, for any role.
    const view = (await (await as(MOD, `${path}/archive`)).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ canvas, phase: 'ended', removals: [removal], rollbacks: 0 });
    // Dropped again by its index.
    const dropped = await as(MOD, `${path}/removals`, { drop: 0, reason: 'added in error' });
    expect(dropped.status).toBe(200);
    expect((await stub(canvas).seasonStatus()).removals).toEqual([]);
    expect((await audits('archive.removal_drop', canvas)).map((r) => r.outcome)).toEqual([
      'requested',
      'ok',
    ]);
  });

  it("needs an owner for a removal of every player's ops, and a reason that names no one", async () => {
    const canvas = await endedSeason();
    const path = `/api/seasons/${canvas}/removals`;
    const everyone = { add: { area }, reason: 'a raid after the end' };
    const refused = await as(MOD, path, everyone);
    expect(refused.status).toBe(403);
    expect((await audits('access.refused', `POST ${path}`)).map((r) => r.outcome)).toEqual([
      'forbidden',
    ]);
    expect((await stub(canvas).seasonStatus()).removals).toEqual([]);
    expect((await as(OWNER, path, everyone)).status).toBe(200);
    // The reason may not name the player the removal is about.
    const { nickname } = await player();
    const named = await as(MOD, path, { add: { nickname, area }, reason: `it was ${nickname}` });
    expect(named.status).toBe(400);
    expect((await audits('archive.removal_add', canvas)).map((r) => r.outcome)).toEqual([
      'requested',
      'ok',
    ]);
    // Seqs past the season's last are refused before anything is sent.
    const final = (await stub(canvas).seasonStatus()).finalSeq!;
    const late = await as(OWNER, path, { add: { area, to: final + 1 }, reason: 'x' });
    expect(late.status).toBe(400);
  });

  it('covers the seqs so far by default while a season is open, and caps `to` only once closed', async () => {
    const canvas = await openSeason();
    await playTwo(canvas);
    const path = `/api/seasons/${canvas}/removals`;
    const add = (extra: Record<string, unknown> = {}) =>
      as(OWNER, path, { add: { area, ...extra }, reason: 'a raid' });
    // Open: up to the latest seq (2) by default; a later `to` covers ops still to come.
    expect((await add()).status).toBe(200);
    expect((await add({ to: 50 })).status).toBe(200);
    expect((await stub(canvas).seasonStatus()).removals.map((r) => [r.from, r.to])).toEqual([
      [1, 2],
      [1, 50],
    ]);
    // Closed: past the final seq is refused.
    const ended = await endedSeason();
    const late = await as(OWNER, `/api/seasons/${ended}/removals`, {
      add: { area, to: 3 },
      reason: 'a raid',
    });
    expect(late.status).toBe(400);
  });

  it('refuses a change when another admin changed the list in between', async () => {
    const canvas = await endedSeason();
    const other = { from: 1, to: 1, area: { x: 0, y: 0, w: 1, h: 1 } };
    // The other admin's change lands between this request's read and its write.
    const real = testEnv.CANVAS;
    const racing = {
      idFromName: (name: string) => real.idFromName(name),
      get: (id: DurableObjectId) => {
        const live = real.get(id);
        return {
          seasonStatus: () => live.seasonStatus(),
          setRemovals: async (removals: unknown, expected: unknown) => {
            await live.setRemovals([other]);
            return live.setRemovals(removals as never, expected as never);
          },
        };
      },
    } as unknown as Env['CANVAS'];
    const response = await as(
      OWNER,
      `/api/seasons/${canvas}/removals`,
      { add: { area }, reason: 'x' },
      { CANVAS: racing },
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('stale');
    expect((await stub(canvas).seasonStatus()).removals).toEqual([other]);
    expect((await audits('archive.removal_add', canvas)).map((r) => r.outcome)).toEqual([
      'requested',
      'stale',
    ]);
  });

  it('seals now on an owner request only, once the season has ended; then the list is fixed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const open = await openSeason();
    const early = await as(OWNER, `/api/seasons/${open}/seal`, { reason: 'no report open' });
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toBe('open');
    expect((await stub(open).seasonStatus()).sealRequested).toBe(false);

    const canvas = await endedSeason();
    const path = `/api/seasons/${canvas}`;
    const moderator = await as(MOD, `${path}/seal`, { reason: 'no report open' });
    expect(moderator.status).toBe(403);
    expect((await stub(canvas).seasonStatus()).sealRequested).toBe(false);

    const response = await as(OWNER, `${path}/seal`, { reason: 'no report open' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { archive: unknown }).archive).toMatchObject({
      canvas,
      sealRequested: true,
    });
    const rows = await audits('archive.seal', canvas);
    expect(rows.map((r) => [r.actor, r.outcome])).toEqual([
      [OWNER, 'requested'],
      [OWNER, 'ok'],
    ]);
    // The next maintenance pass seals it (this test canvas has no OPLOG: sealed without an
    // archive, ADR 0025's archive_seal_no_bucket), and no removal can be added after that.
    await runInDurableObject(stub(canvas), (instance: { tick(now: number): Promise<void> }) =>
      instance.tick(Date.now() + 3_600_000),
    );
    expect((await stub(canvas).seasonStatus()).phase).toBe('sealed');
    const late = await as(OWNER, `${path}/removals`, { add: { area }, reason: 'x' });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe('sealed');
  });
});
