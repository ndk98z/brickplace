import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DEFAULT_MAP_SIZE, type Item, type Op } from '@brickplace/core';
import { foldNow } from '@brickplace/game/journal';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { call, claims, envIn, type FakeAccess, fakeAccess, grant, serveKeys } from './support.ts';

// Map moderation (ADR 0024) through the admin Worker: rollbacks with a dry run, area locks and
// the last writer of a cell, each change audited before and after the call to the canvas.

const testEnv = env as unknown as Env;
const db = testEnv.ADMIN_DB;
const OWNER = 'map-owner@example.test';
const MOD = 'map-moderator@example.test';
/** No season is registered here, so the current canvas is the Stage 0 one. */
const canvas = () => testEnv.CANVAS.get(testEnv.CANVAS.idFromName('canvas'));
let access: FakeAccess;
let opId = 1;

beforeAll(async () => {
  access = await fakeAccess('map-key');
  await grant(OWNER, 'owner');
  await grant(MOD, 'moderator');
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Other files play on the same canvas: leave no lock and no job behind.
  const stub = canvas();
  for (const lock of (await stub.areaLocks()).locks) await stub.unlockArea(lock.id);
  await stub.rollbackCancel();
});

async function as(email: string, path: string, body?: unknown) {
  serveKeys(access.jwks);
  const token = await access.sign(claims(email, Date.now()));
  return call(envIn('staging'), path, { token, body });
}

async function auditRows(action: string) {
  const { results } = await db
    .prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id')
    .bind(action)
    .all<Record<string, unknown>>();
  return results;
}

/** Plays one op on the canvas as `player`, after giving them its item. */
async function play(player: string, op: Op) {
  const item: Item = op.kind === 'brick' ? { kind: 'brick', shape: op.shape } : { kind: op.kind };
  await runInDurableObject(canvas(), (instance, state) => {
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify([item]),
      2 ** 50,
    );
  });
  const batch = await canvas().applyBatch([{ player, opId: opId++, op }]);
  return batch.results[0]!;
}

const brick = (x: number, y: number, color = 3): Op => ({
  kind: 'brick',
  x,
  y,
  shape: 1,
  rotation: 0,
  color,
});

/** Polls the dry run until it is ready. */
async function preview(email: string, filter: Record<string, unknown>) {
  for (let i = 0; i < 50; i++) {
    const response = await as(email, '/api/map/rollback/preview', filter);
    const data = (await response.json()) as {
      canvas: string;
      filter: Record<string, unknown>;
      status: { state: string; preview?: { job: string; cells: number } };
      error?: string;
    };
    if (response.status !== 200) return { response, data };
    if (data.status.state === 'ready') return { response, data };
  }
  throw new Error('the dry run never caught up');
}

describe('map moderation', () => {
  it('has its view in the page and its calls in admin.js, under the same CSP', async () => {
    const page = await (await as(MOD, '/')).text();
    expect(page).toContain('data-view="areas"');
    const script = await as(MOD, '/admin.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('Content-Type')).toContain('text/javascript');
    expect(script.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    const text = await script.text();
    expect(text).toContain('/api/map/rollback/preview');
    // Built with textContent only: no HTML strings.
    expect(text).not.toContain('innerHTML');
  });

  it('previews a rollback, applies it with audit rows around the call, and lists it', async () => {
    expect((await play('map-artist', brick(700, 600))).ok).toBe(true);
    expect((await play('map-griefer', { kind: 'hammer', x: 700, y: 600 })).ok).toBe(true);
    const { response, data } = await preview(MOD, { player: 'map-griefer' });
    expect(response.status).toBe(200);
    expect(data.canvas).toBe('canvas');
    expect(data.status.preview).toMatchObject({ cells: 1, removedOps: 1 });
    // The dry run changed nothing and wrote no audit row.
    expect((await canvas().snapshot()).cells[600 * DEFAULT_MAP_SIZE + 700]).toBe(0);
    expect(await auditRows('map.rollback')).toEqual([]);

    // A reason is required; then the canvas applies the job previewed for that filter only.
    const job = data.status.preview!.job;
    expect((await as(MOD, '/api/map/rollback/apply', { job, filter: data.filter })).status).toBe(
      400,
    );
    const other = await as(MOD, '/api/map/rollback/apply', {
      job,
      filter: { player: 'someone-else' },
      reason: 'wrong filter',
    });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: 'no_job' });
    // A filter that is not the job's leaves the job in place: the right one still applies.
    // A reason with personal data never reaches the audit log (ADR 0023).
    for (const reason of ['see mail from someone@example.test', 'id 12345678 again']) {
      const named = await as(MOD, '/api/map/rollback/apply', { job, filter: data.filter, reason });
      expect(named.status).toBe(400);
    }
    const applied = await as(MOD, '/api/map/rollback/apply', {
      job,
      filter: data.filter,
      reason: 'griefing report 12',
    });
    expect(applied.status).toBe(200);
    const body = (await applied.json()) as {
      record: { cells: number; player: string };
      nudged: boolean;
    };
    expect(body.record).toMatchObject({ cells: 1, player: 'map-griefer' });
    // The canvas's FanoutDO was asked to send it to open sockets.
    expect(body.nudged).toBe(true);
    expect((await canvas().snapshot()).cells[600 * DEFAULT_MAP_SIZE + 700]).not.toBe(0);
    const rows = await auditRows('map.rollback');
    expect(rows.map((r) => r.outcome)).toEqual(['requested', 'no_job', 'requested', 'ok']);
    expect(rows.at(-1)).toMatchObject({
      actor: MOD,
      target: 'canvas',
      reason: 'griefing report 12',
    });
    expect(JSON.parse(rows.at(-1)!.after as string)).toMatchObject({
      record: { cells: 1 },
      preview: { cells: 1, removedOps: 1 },
    });
    const listed = await as(MOD, '/api/map/rollbacks');
    const { rollbacks } = (await listed.json()) as { rollbacks: { player?: string }[] };
    expect(rollbacks.at(-1)).toMatchObject({ player: 'map-griefer', cells: 1 });
  }, 30_000);

  it('resolves a nickname, tells who wrote a cell, and keeps whole-map rollbacks for owners', async () => {
    const now = Date.now();
    await testEnv.ACCOUNTS.prepare(
      'INSERT OR REPLACE INTO users (id, nickname, nickname_key, created_at, signed_in_at) ' +
        'VALUES (?, ?, ?, ?, ?)',
    )
      .bind('acct-painter', 'Painter_1', 'painter_1', now, now)
      .run();
    expect((await play('acct-painter', brick(720, 600, 9))).ok).toBe(true);
    const cell = await as(MOD, '/api/map/cell?x=721&y=601');
    expect(await cell.json()).toEqual({
      canvas: 'canvas',
      x: 721,
      y: 601,
      writer: { player: 'acct-painter', team: 0, nickname: 'Painter_1' },
    });
    expect((await as(MOD, '/api/map/cell?x=-1&y=0')).status).toBe(400);
    const nobody = await as(MOD, '/api/map/cell?x=5&y=5');
    expect(await nobody.json()).toMatchObject({ writer: null });

    const byNick = await preview(MOD, { nickname: 'painter_1' });
    expect(byNick.data.filter).toEqual({ player: 'acct-painter' });
    expect(byNick.data.status.preview).toMatchObject({ cells: 4 });
    expect((await as(MOD, '/api/map/rollback/preview', { nickname: 'nobody_here' })).status).toBe(
      404,
    );
    const badArea = { player: 'acct-painter', area: { x: 0 } };
    expect((await as(MOD, '/api/map/rollback/preview', badArea)).status).toBe(400);

    // Every player's ops, by time or by area (an area may be the whole map): an owner's call,
    // recorded when a moderator tries.
    const from = { from: Date.now() - 60_000 };
    const refused = await as(MOD, '/api/map/rollback/preview', from);
    expect(refused.status).toBe(403);
    const everywhere = {
      area: { x: 0, y: 0, w: DEFAULT_MAP_SIZE, h: DEFAULT_MAP_SIZE },
      from: Date.now() - 60_000,
    };
    expect((await as(MOD, '/api/map/rollback/preview', everywhere)).status).toBe(403);
    expect((await auditRows('access.refused')).at(-1)).toMatchObject({
      actor: MOD,
      outcome: 'forbidden',
    });
    const owner = await as(OWNER, '/api/map/rollback/preview', from);
    expect(owner.status).toBe(200);
    const { status } = (await owner.json()) as {
      status: { job?: string; preview?: { job: string } };
    };
    const ownerJob = status.job ?? status.preview?.job;
    expect(ownerJob).toEqual(expect.any(String));
    // Nor may a moderator apply the owner's job, even knowing its id.
    const forbidden = await auditRows('access.refused');
    const taken = await as(MOD, '/api/map/rollback/apply', {
      job: ownerJob,
      filter: from,
      reason: 'the raid',
    });
    expect(taken.status).toBe(403);
    expect(await auditRows('access.refused')).toHaveLength(forbidden.length + 1);
    // A reason naming the player rolled back is refused too.
    const named = await as(MOD, '/api/map/rollback/apply', {
      job: 'any',
      filter: { player: 'acct-painter' },
      reason: 'painter_1 again',
    });
    expect(named.status).toBe(400);
    expect(await named.json()).toMatchObject({ detail: expect.stringMatching(/names/) });
    // Two dry runs replaying the canvas: about a second alone, more under a full run.
  }, 30_000);

  it('locks and unlocks an area, audited, and the canvas refuses ops in it', async () => {
    const area = { x: 740, y: 600, w: 10, h: 10 };
    expect((await as(MOD, '/api/map/locks', { area })).status).toBe(400);
    // The note a lock keeps names no one either.
    const noted = await as(MOD, '/api/map/locks', { area, reason: 'raid', note: 'by a@b.test' });
    expect(noted.status).toBe(400);
    const locked = await as(MOD, '/api/map/locks', { area, reason: 'raid on the logo' });
    expect(locked.status).toBe(200);
    const { lock } = (await locked.json()) as { lock: { id: number; note: string } };
    expect(lock.note).toBe('raid on the logo');
    expect(await play('map-raider', brick(741, 601))).toEqual({ ok: false, reason: 'locked' });
    const list = (await (await as(MOD, '/api/map/locks')).json()) as {
      locks: { id: number }[];
    };
    expect(list.locks.map((l) => l.id)).toContain(lock.id);
    const bad = await as(MOD, '/api/map/locks', {
      area: { x: 1016, y: 0, w: 20, h: 1 },
      reason: 'x',
    });
    expect(bad.status).toBe(400);
    const lifted = await as(MOD, `/api/map/locks/${lock.id}/unlock`, { reason: 'calm again' });
    expect(lifted.status).toBe(200);
    expect((await play('map-raider', brick(741, 601))).ok).toBe(true);
    expect((await as(MOD, `/api/map/locks/${lock.id}/unlock`, { reason: 'again' })).status).toBe(
      404,
    );
    // The request without a reason never reached the canvas, so it has no rows.
    expect((await auditRows('map.lock')).map((r) => r.outcome)).toEqual([
      'requested',
      'ok',
      'requested',
      'invalid',
    ]);
    expect((await auditRows('map.unlock')).map((r) => r.outcome)).toEqual([
      'requested',
      'ok',
      'requested',
      'not_found',
    ]);
  });
});
