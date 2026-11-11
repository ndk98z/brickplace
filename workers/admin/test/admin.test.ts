import { env } from 'cloudflare:workers';
import { DEFAULT_ITEM_CONFIG, DEFAULT_OPEN_GROWTH } from '@brickplace/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { ADMIN_JS, ADMIN_PAGE } from '../src/ui/page.ts';
import {
  call,
  claims,
  envIn,
  type FakeAccess,
  fakeAccess,
  grant,
  ORIGIN,
  serveKeys,
} from './support.ts';

const db = (env as unknown as Env).ADMIN_DB;
const OWNER = 'owner@example.test';
const MOD = 'moderator@example.test';
let access: FakeAccess;

beforeAll(async () => {
  // A kid of its own: the Worker caches keys per isolate across test files.
  access = await fakeAccess('route-key');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function tokenFor(email: string, extra: Record<string, unknown> = {}) {
  return access.sign(claims(email, Date.now(), extra));
}

async function as(email: string, path: string, body?: unknown) {
  serveKeys(access.jwks);
  return call(envIn('staging'), path, { token: await tokenFor(email), body });
}

async function auditRows(action: string) {
  const { results } = await db
    .prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id')
    .bind(action)
    .all<Record<string, unknown>>();
  return results;
}

describe('admin page', () => {
  it('defines every element id its script looks up', () => {
    const defined = new Set([...ADMIN_PAGE.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const looked = [...ADMIN_JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
    expect(looked.length).toBeGreaterThan(20);
    for (const id of looked) expect(defined.has(id), id).toBe(true);
  });

  it('has a view for every sidebar link and a sidebar link for every view', () => {
    const links = [...ADMIN_PAGE.matchAll(/<a href="#([a-z]+)"/g)].map((m) => m[1]);
    const sections = [...ADMIN_PAGE.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
    const registered = [...ADMIN_JS.matchAll(/view\('([a-z]+)', '/g)].map((m) => m[1]);
    for (const name of sections) expect(links, name).toContain(name);
    expect(new Set(registered)).toEqual(new Set(sections));
    // Every #link (the sidebar's and the cards' own) opens a view.
    for (const name of links) expect(sections, name).toContain(name);
  });

  it('builds every element without parsing HTML', () => {
    for (const unsafe of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect(ADMIN_JS).not.toContain(unsafe);
    }
    // The page's CSP refuses inline style and script.
    expect(ADMIN_PAGE).not.toMatch(/ style="|<style|<script>/);
  });
});

describe('admin Worker: who may enter', () => {
  it('answers health checks in every environment', async () => {
    for (const environment of ['locked', 'dev', 'staging'] as const) {
      const response = await call(envIn(environment), '/healthz');
      expect(await response.text()).toBe('ok');
    }
  });

  it('stays closed when locked, whatever the request carries', async () => {
    serveKeys(access.jwks);
    await grant(OWNER, 'owner');
    const token = await tokenFor(OWNER);
    for (const path of ['/', '/api/me', '/admin.js']) {
      const response = await call(envIn('locked'), path, { token });
      expect(response.status).toBe(501);
    }
  });

  it('commits no environment that bypasses Access', () => {
    const committed = (env as unknown as { COMMITTED_ENVIRONMENTS: Record<string, string> })
      .COMMITTED_ENVIRONMENTS;
    expect(committed['']).toBe('locked');
    expect(Object.values(committed)).not.toContain('dev');
    expect(committed).toMatchObject({ staging: 'staging', production: 'production' });
  });

  it('opens no workers.dev address or preview URLs anywhere, and each env on its domain only', () => {
    type Routes = { workersDev: boolean | null; previewUrls: boolean | null; routes: string[] };
    const routes = (env as unknown as { COMMITTED_ROUTES: Record<string, Routes> })
      .COMMITTED_ROUTES;
    // ADR 0022 and 0029 (amended): reached on a custom domain behind its own Access
    // application only. Every committed environment, so a new env block cannot open
    // workers.dev unnoticed.
    expect(Object.keys(routes).sort()).toEqual(['', 'production', 'staging']);
    for (const [name, opened] of Object.entries(routes)) {
      expect({ workersDev: opened.workersDev, previewUrls: opened.previewUrls }, name).toEqual({
        workersDev: false,
        previewUrls: false,
      });
    }
    expect(routes.staging?.routes).toEqual(['admin-staging.brickplace.app (custom domain)']);
    expect(routes.production?.routes).toEqual(['admin.brickplace.app (custom domain)']);
  });

  it('is closed until the Access application is configured', async () => {
    const fetchSpy = serveKeys(access.jwks);
    const token = await tokenFor(OWNER);
    for (const extra of [
      { ACCESS_AUD: '' },
      { ACCESS_TEAM_DOMAIN: '' },
      { ACCESS_AUD: undefined },
    ]) {
      const response = await call(envIn('production', extra), '/api/me', { token });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'access_not_configured' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses requests without a valid Access token outside dev', async () => {
    serveKeys(access.jwks);
    await grant(OWNER, 'owner');
    const forger = await fakeAccess('route-key');
    const forged = await forger.sign(claims(OWNER, Date.now()));
    const cases: [string | undefined, string][] = [
      [undefined, 'missing'],
      ['not-a-token', 'malformed'],
      [forged, 'signature'],
      [await tokenFor(OWNER, { aud: ['b'.repeat(64)] }), 'audience'],
      [await tokenFor(OWNER, { iss: 'https://other.cloudflareaccess.com' }), 'issuer'],
      [await tokenFor(OWNER, { exp: Math.floor(Date.now() / 1000) - 120 }), 'expired'],
    ];
    for (const environment of ['staging', 'production'] as const) {
      for (const [token, detail] of cases) {
        for (const path of ['/', '/api/me', '/api/audit']) {
          const response = await call(envIn(environment), path, { token });
          expect(response.status, `${environment} ${path} ${detail}`).toBe(401);
          expect(await response.json()).toEqual({ error: 'access', detail });
        }
      }
    }
  });

  it('never takes the dev identity outside dev', async () => {
    serveKeys(access.jwks);
    // The dev identity's own email, signed by a key the team never published.
    const forger = await fakeAccess('route-key');
    const token = await forger.sign(claims('dev-admin@localhost', Date.now()));
    for (const environment of ['staging', 'production'] as const) {
      expect((await call(envIn(environment), '/api/me')).status).toBe(401);
      expect((await call(envIn(environment), '/api/me', { token })).status).toBe(401);
    }
  });

  it('lets dev in as a local owner without Access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await call(
      envIn('dev', { ACCESS_AUD: '', ACCESS_TEAM_DOMAIN: '' }),
      '/api/me',
    );
    expect(await response.json()).toMatchObject({
      email: 'dev-admin@localhost',
      role: 'owner',
      dev: true,
      environment: 'dev',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the current canvas's live counts, and says so when it cannot reach it", async () => {
    await grant(MOD, 'moderator');
    const response = await as(MOD, '/api/stats');
    expect(response.status).toBe(200);
    const stats = (await response.json()) as Record<string, unknown>;
    expect(stats).toMatchObject({ canvas: 'canvas', playing: 0 });
    expect(typeof stats.phase).toBe('string');
    expect(typeof stats.filled).toBe('number');
    // What growth reads and its threshold, apart from the phase measure (ADR 0033).
    expect(stats).toMatchObject({ built: 0, growsAt: DEFAULT_OPEN_GROWTH.atPercent });

    const real = (env as unknown as Env).CANVAS;
    const down = {
      idFromName: (name: string) => real.idFromName(name),
      get: () => ({ stats: () => Promise.reject(new Error('network')) }),
    } as unknown as Env['CANVAS'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    serveKeys(access.jwks);
    const failed = await call(envIn('staging', { CANVAS: down }), '/api/stats', {
      token: await tokenFor(MOD),
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'unreachable' });
  });

  it('needs a role in D1, not only an Access sign-in', async () => {
    const response = await as('nobody@example.test', '/api/me');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no_role' });
  });

  it('serves the page and the API to a signed-in admin, with a strict CSP', async () => {
    await grant(OWNER, 'owner');
    const page = await as(OWNER, '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toContain('text/html');
    expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('<script src="/admin.js" defer>');
    expect((await as(OWNER, '/admin.js')).status).toBe(200);
    const me = await as(OWNER.toUpperCase(), '/api/me');
    expect(await me.json()).toMatchObject({ email: OWNER, role: 'owner', dev: false });
  });
});

describe('admin Worker: changes', () => {
  it('takes changes only as JSON from its own page', async () => {
    await grant(OWNER, 'owner');
    serveKeys(access.jwks);
    const token = await tokenFor(OWNER);
    const body = { readOnly: false, reason: 'test' };
    const cases: Record<string, string>[] = [
      { 'X-BrickPlace-Admin': '' },
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      { Origin: 'https://evil.example' },
    ];
    for (const headers of cases) {
      const response = await call(envIn('staging'), '/api/emergency/read-only', {
        token,
        body,
        headers,
      });
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    const same = await call(envIn('staging'), '/api/emergency/read-only', {
      token,
      body,
      headers: { Origin: ORIGIN },
    });
    expect(same.status).toBe(200);
  });

  it('requires a reason for every change', async () => {
    await grant(OWNER, 'owner');
    const response = await as(OWNER, '/api/emergency/cooldown-double', { reason: '  ' });
    expect(response.status).toBe(400);
  });

  it('schedules a config version that the canvas picks up at its time, and audits it', async () => {
    await grant(OWNER, 'owner');
    const at = Date.now() + 60 * 60 * 1000;
    const config = { ...DEFAULT_ITEM_CONFIG, cooldown: 90_000 };
    const response = await as(OWNER, '/api/config', {
      scope: 'items',
      config,
      effectiveAt: at,
      reason: 'slower items for the weekend',
    });
    expect(response.status).toBe(200);
    const { version } = (await response.json()) as { version: Record<string, unknown> };
    expect(version).toMatchObject({
      scope: 'items',
      effectiveAt: at,
      createdBy: OWNER,
      note: 'slower items for the weekend',
      cancelledAt: null,
    });
    expect(version.deliveredAt).toEqual(expect.any(Number));
    expect((version.config as { version: number }).version).toBe(version.version);

    const view = (await (await as(OWNER, '/api/config')).json()) as {
      state: { versions: { version: number; effectiveAt: number }[]; items: { cooldown: number } };
    };
    expect(view.state.versions).toContainEqual(
      expect.objectContaining({ version: version.version, effectiveAt: at }),
    );
    // Not in force yet.
    expect(view.state.items.cooldown).not.toBe(90_000);
    const stub = (env as unknown as Env).CANVAS.get(
      (env as unknown as Env).CANVAS.idFromName('canvas'),
    );
    expect((await stub.configState(at)).items.cooldown).toBe(90_000);

    const rows = await auditRows('config.schedule');
    const row = rows.find((r) => r.target === `canvas/items@${version.version}`)!;
    expect(row).toMatchObject({
      actor: OWNER,
      outcome: 'ok',
      reason: 'slower items for the weekend',
    });
    expect(JSON.parse(row.after as string)).toMatchObject({ effectiveAt: at });

    // Cancelled before it takes effect: it never applies.
    const cancel = await as(OWNER, `/api/config/${version.id}/cancel`, { reason: 'changed mind' });
    expect(cancel.status).toBe(200);
    expect((await stub.configState(at)).items.cooldown).not.toBe(90_000);
    expect(await auditRows('config.cancel')).toContainEqual(
      expect.objectContaining({
        target: `canvas/items@${version.version}`,
        reason: 'changed mind',
      }),
    );
    const again = await as(OWNER, `/api/config/${version.id}/cancel`, { reason: 'twice' });
    expect(again.status).toBe(409);
  });

  it('answers 409 when another admin takes the same version number first', async () => {
    await grant(OWNER, 'owner');
    const real = (env as unknown as Env).CANVAS;
    const latest = (await real.get(real.idFromName('canvas')).configState()).latest.growth;
    // The other admin's row lands between this request's read of the highest version and its
    // insert: here, the read is made to miss it.
    await db
      .prepare(
        "INSERT INTO config_versions (canvas, scope, version, json, effective_at, created_by, created_at) VALUES ('canvas', 'growth', ?, '{}', 0, 'other@example.test', 0)",
      )
      .bind(latest + 1)
      .run();
    const blind = new Proxy(db, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key).bind(target);
        return (sql: string) =>
          sql.includes('MAX(version)')
            ? target.prepare('SELECT NULL AS v WHERE ? IS NOT NULL OR ? IS NOT NULL')
            : target.prepare(sql);
      },
    });
    serveKeys(access.jwks);
    const response = await call(envIn('staging', { ADMIN_DB: blind }), '/api/config', {
      token: await tokenFor(OWNER),
      body: { scope: 'growth', config: { atPercent: 75, step: 256 }, reason: 'race' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'version_taken' });
  });

  it('refuses invalid settings and records nothing', async () => {
    await grant(OWNER, 'owner');
    const before = await db
      .prepare('SELECT COUNT(*) AS n FROM config_versions')
      .first<{ n: number }>();
    for (const body of [
      { scope: 'items', config: { ...DEFAULT_ITEM_CONFIG, cooldown: 0 }, reason: 'x' },
      { scope: 'growth', config: { atPercent: 101, step: 256 }, reason: 'x' },
      { scope: 'shields', config: {}, reason: 'x' },
      { scope: 'items', config: DEFAULT_ITEM_CONFIG, effectiveAt: 'soon', reason: 'x' },
    ]) {
      const response = await as(OWNER, '/api/config', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const after = await db
      .prepare('SELECT COUNT(*) AS n FROM config_versions')
      .first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('doubles the cooldown in force, effective now', async () => {
    await grant(MOD, 'moderator');
    const stub = (env as unknown as Env).CANVAS.get(
      (env as unknown as Env).CANVAS.idFromName('canvas'),
    );
    const was = (await stub.configState()).items.cooldown;
    const response = await as(MOD, '/api/emergency/cooldown-double', { reason: 'bot wave' });
    expect(response.status).toBe(200);
    expect((await stub.configState()).items.cooldown).toBe(was * 2);
    const rows = await auditRows('emergency.cooldown_double');
    const last = rows.at(-1)!;
    expect(last).toMatchObject({ actor: MOD, outcome: 'ok' });
    expect(JSON.parse(last.before as string).config.cooldown).toBe(was);
    expect(JSON.parse(last.after as string).config.cooldown).toBe(was * 2);
  });

  it('keeps a version whose delivery failed, and delivers it on retry', async () => {
    await grant(OWNER, 'owner');
    const real = (env as unknown as Env).CANVAS;
    // A canvas that answers reads but drops the version on the way.
    const flaky = {
      idFromName: (name: string) => real.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = real.get(id);
        return {
          configState: () => stub.configState(),
          scheduleConfig: () => Promise.reject(new Error('network')),
          cancelConfig: () => Promise.reject(new Error('network')),
        };
      },
    } as unknown as Env['CANVAS'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    serveKeys(access.jwks);
    const token = await tokenFor(OWNER);
    const failed = await call(envIn('staging', { CANVAS: flaky }), '/api/config', {
      token,
      body: { scope: 'growth', config: { atPercent: 80, step: 256 }, reason: 'later growth' },
    });
    expect(failed.status).toBe(502);
    const { id } = (await failed.json()) as { id: number };
    const row = await db.prepare('SELECT * FROM config_versions WHERE id = ?').bind(id).first();
    expect(row).toMatchObject({ delivered_at: null, created_by: OWNER });
    expect((await auditRows('config.schedule')).at(-1)).toMatchObject({ outcome: 'not_delivered' });

    expect((await as(OWNER, `/api/config/${id}/deliver`, {})).status).toBe(400);
    const retry = await as(OWNER, `/api/config/${id}/deliver`, { reason: 'canvas is back' });
    expect(retry.status).toBe(200);
    const stub = real.get(real.idFromName('canvas'));
    expect((await stub.configState()).growth).toEqual({ atPercent: 80, step: 256 });
    expect((await auditRows('config.deliver')).at(-1)).toMatchObject({ outcome: 'ok' });
  });

  it('pauses and reopens the current canvas, with audit rows before and after', async () => {
    await grant(OWNER, 'owner');
    const stub = (env as unknown as Env).CANVAS.get(
      (env as unknown as Env).CANVAS.idFromName('canvas'),
    );
    const reason = `raid on the north wall ${'x'.repeat(80)}`;
    const on = await as(OWNER, '/api/emergency/read-only', { readOnly: true, reason });
    expect(on.status).toBe(200);
    // The canvas keeps a short note; the audit log keeps the whole reason.
    const note = reason.slice(0, 64);
    expect(await on.json()).toEqual({ status: { canvas: 'canvas', readOnly: true, note } });
    expect((await stub.seasonStatus()).readOnly).toBe(note);
    const status = await as(OWNER, '/api/emergency/read-only');
    expect(await status.json()).toEqual({
      available: true,
      status: { canvas: 'canvas', readOnly: true, note },
    });
    const rows = (await auditRows('emergency.read_only_on')).slice(-2);
    expect(rows.map((r) => r.outcome)).toEqual(['requested', 'ok']);
    expect(rows.every((r) => r.reason === reason && r.target === 'canvas')).toBe(true);

    const off = await as(OWNER, '/api/emergency/read-only', { readOnly: false, reason: 'over' });
    expect(off.status).toBe(200);
    expect((await stub.seasonStatus()).readOnly).toBeNull();
    expect((await auditRows('emergency.read_only_off')).slice(-2).map((r) => r.outcome)).toEqual([
      'requested',
      'ok',
    ]);
  });

  it('records a read-only switch the canvas cannot take', async () => {
    await grant(OWNER, 'owner');
    const real = (env as unknown as Env).CANVAS;
    const down = {
      idFromName: (name: string) => real.idFromName(name),
      get: () => ({
        seasonStatus: async () => ({ readOnly: null }),
        setSchedule: () => Promise.reject(new Error('network')),
      }),
    } as unknown as Env['CANVAS'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    serveKeys(access.jwks);
    const response = await call(envIn('staging', { CANVAS: down }), '/api/emergency/read-only', {
      token: await tokenFor(OWNER),
      body: { readOnly: true, reason: 'raid' },
    });
    expect(response.status).toBe(502);
    expect((await auditRows('emergency.read_only_on')).slice(-2).map((r) => r.outcome)).toEqual([
      'requested',
      'unreachable',
    ]);
  });

  it('limits moderators to reads and the emergency switches', async () => {
    await grant(MOD, 'moderator');
    await grant(OWNER, 'owner');
    const stub = (env as unknown as Env).CANVAS.get(
      (env as unknown as Env).CANVAS.idFromName('canvas'),
    );
    const config = { scope: 'items', config: DEFAULT_ITEM_CONFIG, reason: 'x' };
    expect((await as(MOD, '/api/config', config)).status).toBe(403);
    expect((await as(MOD, '/api/roles')).status).toBe(403);
    // Someone else's role: a refusal of their own would come from the own-role rule instead.
    const promote = { email: 'third@example.test', role: 'owner', reason: 'x' };
    expect((await as(MOD, '/api/roles', promote)).status).toBe(403);
    expect(
      await db.prepare("SELECT 1 FROM admin_roles WHERE email = 'third@example.test'").first(),
    ).toBeNull();
    expect((await as(MOD, '/api/seasons/s1/end', { reason: 'x' })).status).toBe(403);
    expect((await as(MOD, '/api/audit')).status).toBe(200);
    // Both switches, but only an owner reopens the map.
    expect(
      (await as(MOD, '/api/emergency/read-only', { readOnly: true, reason: 'raid' })).status,
    ).toBe(200);
    expect((await stub.seasonStatus()).readOnly).toBe('raid');
    const reopen = await as(MOD, '/api/emergency/read-only', { readOnly: false, reason: 'x' });
    expect(reopen.status).toBe(403);
    expect((await stub.seasonStatus()).readOnly).toBe('raid');
    expect(
      (await as(OWNER, '/api/emergency/read-only', { readOnly: false, reason: 'over' })).status,
    ).toBe(200);
    expect((await stub.seasonStatus()).readOnly).toBeNull();
    // Every refused change is in the audit log; refused reads are not.
    const refusals = (await auditRows('access.refused')).filter((r) => r.actor === MOD);
    expect(refusals.map((r) => r.target)).toEqual(
      expect.arrayContaining([
        'POST /api/config',
        'POST /api/roles',
        'POST /api/seasons/s1/end',
        'POST /api/emergency/read-only',
      ]),
    );
    expect(refusals.every((r) => r.outcome === 'forbidden')).toBe(true);
    expect(refusals.some((r) => r.target === 'GET /api/roles')).toBe(false);
  });

  it('audits a change tried by someone Access let in but who has no role', async () => {
    const response = await as('stranger@example.test', '/api/emergency/cooldown-double', {
      reason: 'let me in',
    });
    expect(response.status).toBe(403);
    expect((await auditRows('access.refused')).at(-1)).toMatchObject({
      actor: 'stranger@example.test',
      actor_sub: 'sub-stranger@example.test',
      target: 'POST /api/emergency/cooldown-double',
      reason: 'no_role',
      outcome: 'forbidden',
    });
    const before = (await auditRows('access.refused')).length;
    expect((await as('stranger@example.test', '/api/audit')).status).toBe(403);
    // Repeating the change within the hour adds no row: they cannot fill the log.
    for (let i = 0; i < 3; i++) {
      const again = await as('stranger@example.test', '/api/config', { reason: `again ${i}` });
      expect(again.status).toBe(403);
    }
    expect(await auditRows('access.refused')).toHaveLength(before);
    // Nor a POST another site made someone's browser send: it cannot write rows in their name.
    serveKeys(access.jwks);
    const forged = await call(envIn('staging'), '/api/emergency/cooldown-double', {
      token: await tokenFor('passer-by@example.test'),
      body: { reason: 'forged' },
      headers: { Origin: 'https://evil.example' },
    });
    expect(forged.status).toBe(403);
    expect(await auditRows('access.refused')).toHaveLength(before);
    // The same person from our own page is recorded.
    expect((await as('passer-by@example.test', '/api/config', { reason: 'own' })).status).toBe(403);
    expect(await auditRows('access.refused')).toHaveLength(before + 1);
  });

  it('audits refused cancels and deliveries', async () => {
    await grant(OWNER, 'owner');
    expect((await as(OWNER, '/api/config/999999/cancel', { reason: 'gone?' })).status).toBe(404);
    expect((await as(OWNER, '/api/config/999999/deliver', { reason: 'gone?' })).status).toBe(404);
    const missing = (await auditRows('config.cancel')).at(-1);
    expect(missing).toMatchObject({ target: 'id 999999', outcome: 'not_found', reason: 'gone?' });
    expect((await auditRows('config.deliver')).at(-1)).toMatchObject({ outcome: 'not_found' });

    const at = Date.now() + 60 * 60 * 1000;
    const made = await as(OWNER, '/api/config', {
      scope: 'growth',
      config: { atPercent: 70, step: 128 },
      effectiveAt: at,
      reason: 'later',
    });
    const { version } = (await made.json()) as { version: { id: number; version: number } };
    const real = (env as unknown as Env).CANVAS;
    const down = {
      idFromName: (name: string) => real.idFromName(name),
      get: () => ({ cancelConfig: () => Promise.reject(new Error('network')) }),
    } as unknown as Env['CANVAS'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    serveKeys(access.jwks);
    const cancel = await call(
      envIn('staging', { CANVAS: down }),
      `/api/config/${version.id}/cancel`,
      {
        token: await tokenFor(OWNER),
        body: { reason: 'try' },
      },
    );
    expect(cancel.status).toBe(503);
    expect((await auditRows('config.cancel')).at(-1)).toMatchObject({
      target: `canvas/growth@${version.version}`,
      outcome: 'canvas_unavailable',
    });
    expect((await as(OWNER, `/api/config/${version.id}/cancel`, { reason: 'now' })).status).toBe(
      200,
    );
    // Each cancel that reached the canvas has its `requested` row before the outcome.
    const target = `canvas/growth@${version.version}`;
    const cancels = (await auditRows('config.cancel')).filter((r) => r.target === target);
    expect(cancels.map((r) => r.outcome)).toEqual([
      'requested',
      'canvas_unavailable',
      'requested',
      'ok',
    ]);
    expect((await as(OWNER, `/api/config/${version.id}/deliver`, { reason: 'x' })).status).toBe(
      409,
    );
    expect((await auditRows('config.deliver')).at(-1)).toMatchObject({ outcome: 'cancelled' });
  });

  it('lets owners grant and revoke roles, never their own', async () => {
    await grant(OWNER, 'owner');
    const newcomer = 'New.Mod@Example.test';
    const granted = await as(OWNER, '/api/roles', {
      email: newcomer,
      role: 'moderator',
      reason: 'r',
    });
    expect(await granted.json()).toEqual({ email: 'new.mod@example.test', role: 'moderator' });
    expect((await as('new.mod@example.test', '/api/me')).status).toBe(200);
    const revoked = await as(OWNER, '/api/roles', { email: newcomer, role: null, reason: 'r2' });
    expect(revoked.status).toBe(200);
    expect((await as('new.mod@example.test', '/api/me')).status).toBe(403);
    const own = await as(OWNER, '/api/roles', { email: OWNER, role: null, reason: 'oops' });
    expect(own.status).toBe(409);
    const grants = await auditRows('role.grant');
    expect(grants.at(-1)).toMatchObject({ target: 'new.mod@example.test', after: '"moderator"' });
    expect((await auditRows('role.revoke')).at(-1)).toMatchObject({ before: '"moderator"' });
    const list = (await (await as(OWNER, '/api/roles')).json()) as { roles: { email: string }[] };
    expect(list.roles.map((r) => r.email)).toContain(OWNER);
  });

  it('pages the audit log, newest first', async () => {
    await grant(OWNER, 'owner');
    for (let i = 0; i < 3; i++) {
      await as(OWNER, '/api/emergency/read-only', { readOnly: false, reason: `page ${i}` });
    }
    const first = (await (await as(OWNER, '/api/audit')).json()) as { entries: { id: number }[] };
    const ids = first.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const older = (await (await as(OWNER, `/api/audit?before=${ids[0]}`)).json()) as {
      entries: { id: number }[];
    };
    expect(older.entries[0]!.id).toBeLessThan(ids[0]!);
  });
});

describe('admin database', () => {
  it('keeps the audit log append-only and config versions fixed', async () => {
    await db
      .prepare(
        "INSERT INTO audit_log (at, actor, action) VALUES (1, 'someone@example.test', 'test.append')",
      )
      .run();
    await expect(db.prepare("UPDATE audit_log SET reason = 'edited'").run()).rejects.toThrow(
      /append-only/,
    );
    await expect(db.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);
    await db
      .prepare(
        "INSERT INTO config_versions (canvas, scope, version, json, effective_at, created_by, created_at) VALUES ('fixed', 'growth', 9, '{}', 0, 'a', 0)",
      )
      .run();
    await expect(
      db.prepare("UPDATE config_versions SET json = '{\"x\":1}' WHERE canvas = 'fixed'").run(),
    ).rejects.toThrow(/fixed/);
    await expect(
      db.prepare("DELETE FROM config_versions WHERE canvas = 'fixed'").run(),
    ).rejects.toThrow(/never deleted/);
    await db.prepare("UPDATE config_versions SET delivered_at = 5 WHERE canvas = 'fixed'").run();
  });

  it('refuses REPLACE, which deletes without firing DELETE triggers', async () => {
    const appended = await db
      .prepare(
        "INSERT INTO audit_log (at, actor, action, reason) VALUES (1, 'a@example.test', 'test.replace', 'original') RETURNING id",
      )
      .first<{ id: number }>();
    const id = appended!.id;
    for (const verb of ['INSERT OR REPLACE', 'REPLACE']) {
      await expect(
        db
          .prepare(
            `${verb} INTO audit_log (id, at, actor, action, reason) VALUES (?, 2, 'b@example.test', 'test.replace', 'forged')`,
          )
          .bind(id)
          .run(),
        verb,
      ).rejects.toThrow(/append-only/);
    }
    expect(await db.prepare('SELECT reason FROM audit_log WHERE id = ?').bind(id).first()).toEqual({
      reason: 'original',
    });

    const made = await db
      .prepare(
        "INSERT INTO config_versions (canvas, scope, version, json, effective_at, created_by, created_at) VALUES ('replace', 'items', 4, '{\"a\":1}', 0, 'a', 0) RETURNING id",
      )
      .first<{ id: number }>();
    const insert = (verb: string, row: string) =>
      db
        .prepare(
          `${verb} INTO config_versions (id, canvas, scope, version, json, effective_at, created_by, created_at) VALUES (${row})`,
        )
        .run();
    for (const verb of ['INSERT OR REPLACE', 'REPLACE', 'INSERT']) {
      // Same id, another version; another id, same version.
      await expect(
        insert(verb, `${made!.id}, 'replace', 'items', 5, '{"b":2}', 0, 'b', 0`),
      ).rejects.toThrow(/never replaced/);
      await expect(
        insert(verb, `NULL, 'replace', 'items', 4, '{"b":2}', 0, 'b', 0`),
      ).rejects.toThrow(/UNIQUE/);
    }
    expect(
      await db
        .prepare("SELECT id, json, created_by FROM config_versions WHERE canvas = 'replace'")
        .all(),
    ).toMatchObject({ results: [{ id: made!.id, json: '{"a":1}', created_by: 'a' }] });
  });

  it('keeps ids positive, so no row can match an auto-assigned id in the triggers', async () => {
    await expect(
      db.prepare("INSERT INTO audit_log (id, at, actor, action) VALUES (-1, 1, 'a', 'x')").run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db
        .prepare(
          "INSERT INTO config_versions (id, canvas, scope, version, json, effective_at, created_by, created_at) VALUES (-1, 'neg', 'items', 2, '{}', 0, 'a', 0)",
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it('records delivery and cancellation once, never undone', async () => {
    const made = await db
      .prepare(
        "INSERT INTO config_versions (canvas, scope, version, json, effective_at, created_by, created_at) VALUES ('once', 'items', 2, '{}', 10, 'a', 0) RETURNING id",
      )
      .first<{ id: number }>();
    const update = (set: string) =>
      db.prepare(`UPDATE config_versions SET ${set} WHERE id = ?`).bind(made!.id).run();
    // Before delivery the effective time may still move (the canvas's own time replaces it).
    await update('effective_at = 20');
    await update('delivered_at = 30, effective_at = 25');
    await expect(update('delivered_at = NULL')).rejects.toThrow(/once delivered/);
    await expect(update('delivered_at = 31')).rejects.toThrow(/once delivered/);
    await expect(update('effective_at = 40')).rejects.toThrow(/once delivered/);
    await update("cancelled_at = 50, cancelled_by = 'a'");
    await expect(update('cancelled_at = NULL')).rejects.toThrow(/once cancelled/);
    await expect(update("cancelled_by = 'b'")).rejects.toThrow(/once cancelled/);
    expect(
      await db.prepare('SELECT * FROM config_versions WHERE id = ?').bind(made!.id).first(),
    ).toMatchObject({ effective_at: 25, delivered_at: 30, cancelled_at: 50, cancelled_by: 'a' });
  });
});
