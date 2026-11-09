// Turnstile on suspicious activity: POST /api/challenge lifts a FanoutDO challenge (ADR 0026).
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { forgetSeasons } from '../src/seasons.ts';
import { fanoutName, shardOf } from '../src/socket.ts';
import { keyRing, unseal } from '../src/token.ts';
import { Browser, devSignIn, envIn, mockOutbound, ORIGIN, TURNSTILE } from './support.ts';

const testEnv = env as unknown as Env;
let count = 0;

afterEach(() => {
  vi.restoreAllMocks();
});

const fanout = () => testEnv.FANOUT.get(testEnv.FANOUT.idFromName('fanout-0'));

async function challengeOf(player: string): Promise<number | undefined> {
  return runInDurableObject(fanout(), (_, state) =>
    state.storage.kv.get<number>(`challenge:${player}`),
  );
}

/**
 * A signed-in account in dev, and the same cookies in `environment`. Dev drops the test
 * Turnstile secret so it really skips the check, as it does with no secret set; with the
 * secret, dev would call the real siteverify and the test would need the network.
 */
async function account(environment: Env['ENVIRONMENT'] = 'dev', extra: Partial<Env> = {}) {
  if (environment === 'dev') extra = { TURNSTILE_SECRET_KEY: undefined, ...extra };
  const dev = new Browser(envIn('dev'));
  await devSignIn(dev, `challenge-${Date.now()}-${++count}`);
  const ring = (await keyRing(testEnv.SESSION_KEYS))!;
  const { u: id } = (await unseal<{ u: string }>(
    ring,
    'session',
    dev.cookies.get('__Host-bp_session'),
  ))!;
  const browser = new Browser(envIn(environment, extra));
  for (const [name, value] of dev.cookies) browser.cookies.set(name, value);
  const { csrf } = await dev.me();
  // Challenged by FanoutDO, as after its bot signals crossed the threshold.
  await runInDurableObject(fanout(), (_, state) => {
    state.storage.kv.put(`challenge:${id}`, Date.now());
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    browser.postJson('/api/challenge', body, { 'X-CSRF-Token': csrf!, Origin: ORIGIN, ...headers });
  return { id, post };
}

describe('POST /api/challenge', () => {
  it('lifts the challenge on the current fanout once Turnstile passes (dev skips the check)', async () => {
    const { id, post } = await account();
    const response = await post({ turnstile: 'token' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cleared: true });
    expect(await challengeOf(id)).toBeUndefined();
    // Nothing pending: still fine, nothing cleared.
    expect(await (await post({ turnstile: 'token' })).json()).toEqual({ ok: true, cleared: false });
  });

  it('outside dev, needs a token from our challenge widget, not the sign-in one', async () => {
    const { id, post } = await account('staging', { TURNSTILE_SECRET_KEY: 'test-secret' });
    let action = 'signin';
    mockOutbound({
      [TURNSTILE]: () => Response.json({ success: true, hostname: 'brickplace.test', action }),
    });
    const refused = await post({ turnstile: 'token' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'turnstile' });
    expect(await challengeOf(id)).toBeTypeOf('number');
    expect((await post({})).status).toBe(403);
    action = 'challenge';
    const passed = await post({ turnstile: 'token' });
    expect(passed.status).toBe(200);
    expect(await challengeOf(id)).toBeUndefined();
  });

  it('also lifts it on the canvas the page loaded, if that is a known one (a season changed)', async () => {
    const { id, post } = await account();
    const now = Date.now();
    await testEnv.ACCOUNTS.prepare(
      'INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind('chal-now', now - 60_000, now + 86_400_000, now)
      .run();
    forgetSeasons();
    try {
      // The page loaded Stage 0's canvas, where its socket met the challenge.
      const passed = await post({ turnstile: 'token', canvas: 'canvas' });
      expect(await passed.json()).toEqual({ ok: true, cleared: true });
      expect(await challengeOf(id)).toBeUndefined();
      // A canvas nobody registered is not touched: only the current one is.
      const unknown = testEnv.FANOUT.get(testEnv.FANOUT.idFromName('nope-1:fanout-0'));
      await runInDurableObject(unknown, (_, state) => {
        state.storage.kv.put(`challenge:${id}`, Date.now());
      });
      const refused = await post({ turnstile: 'token', canvas: 'nope-1' });
      expect(await refused.json()).toEqual({ ok: true, cleared: false });
      const kept = await runInDurableObject(unknown, (_, state) =>
        state.storage.kv.get<number>(`challenge:${id}`),
      );
      expect(kept).toBeTypeOf('number');
      // A malformed name is ignored, not an error.
      expect((await post({ turnstile: 'token', canvas: '../x' })).status).toBe(200);
    } finally {
      await testEnv.ACCOUNTS.prepare("DELETE FROM seasons WHERE canvas = 'chal-now'").run();
      forgetSeasons();
    }
  });

  it('lifts it on the shard the account plays on when the canvas has several (ADR 0028)', async () => {
    const shards = 4;
    const { id, post } = await account('dev', { FANOUT_SHARDS: String(shards) });
    const shard = shardOf(id, shards);
    const own = testEnv.FANOUT.get(testEnv.FANOUT.idFromName(fanoutName('canvas', shard)));
    await runInDurableObject(own, (instance: unknown, state) => {
      state.storage.kv.put(`challenge:${id}`, Date.now());
      (instance as { challenges: unknown }).challenges = null;
    });
    const passed = await post({ turnstile: 'token' });
    expect(await passed.json()).toEqual({ ok: true, cleared: true });
    const left = await runInDurableObject(own, (_, state) =>
      state.storage.kv.get<number>(`challenge:${id}`),
    );
    expect(left).toBeUndefined();
  });

  it('needs a session, CSRF and our own origin', async () => {
    const { post } = await account('staging', { TURNSTILE_SECRET_KEY: 'test-secret' });
    expect((await post({ turnstile: 'token' }, { 'X-CSRF-Token': 'forged' })).status).toBe(403);
    expect((await post({ turnstile: 'token' }, { Origin: 'https://evil.test' })).status).toBe(403);
    const stranger = new Browser(envIn('staging'));
    const anonymous = await stranger.postJson(
      '/api/challenge',
      { turnstile: 'token' },
      { Origin: ORIGIN },
    );
    expect(anonymous.status).toBe(401);
  });
});
