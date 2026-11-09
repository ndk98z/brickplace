import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { forgetWordList, WORD_LIST_KEY } from '../src/nickname.ts';
import { keyRing, seal, unseal } from '../src/token.ts';
import {
  attachmentsAfter,
  Browser,
  devSignIn,
  envIn,
  type MeBody,
  mockOutbound,
  ORIGIN,
  TURNSTILE,
  turnstileSays,
} from './support.ts';

const testEnv = env as unknown as Env;
const db = testEnv.ACCOUNTS;
const SESSION_COOKIE = '__Host-bp_session';
const OAUTH_COOKIE = '__Host-bp_oauth';
const upgrade = { Upgrade: 'websocket' };
let subjects = 0;
/** A provider subject no other test uses (the test database is shared within this file). */
const fresh = (prefix: string) => `${prefix}-${Date.now()}-${++subjects}`;

beforeEach(async () => {
  forgetWordList();
  await testEnv.MODERATION.put(WORD_LIST_KEY, '# test list\nbadword\n=exact\n');
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Signs in through the dev provider and picks a nickname; returns the browser and its csrf. */
async function player(subject = fresh('p'), nickname = subject.replace(/-/g, '_').slice(-20)) {
  const browser = new Browser(envIn('dev'));
  await devSignIn(browser, subject);
  const { csrf } = await browser.me();
  const chosen = await browser.postJson('/api/nickname', { nickname }, { 'X-CSRF-Token': csrf! });
  expect(chosen.status).toBe(200);
  return { browser, csrf: csrf! };
}

async function userIdOf(browser: Browser): Promise<string> {
  const ring = (await keyRing(testEnv.SESSION_KEYS))!;
  const session = await unseal<{ u: string }>(ring, 'session', browser.cookies.get(SESSION_COOKIE));
  return session!.u;
}

describe('signed tokens', () => {
  it('round-trip, and refuse another purpose, a tampered body or an unknown key', async () => {
    const ring = (await keyRing('a:0123456789abcdef0123456789abcdef'))!;
    const token = await seal(ring, 'session', { u: 'x' });
    expect(await unseal(ring, 'session', token)).toEqual({ u: 'x' });
    expect(await unseal(ring, 'csrf', token)).toBeNull();
    const [kid, body, mac] = token.split('.');
    expect(await unseal(ring, 'session', `${kid}.${body}x.${mac}`)).toBeNull();
    const other = (await keyRing('b:0123456789abcdef0123456789abcdef'))!;
    expect(await unseal(other, 'session', token)).toBeNull();
  });

  it('rotate: the first key signs, older keys still verify', async () => {
    const old = (await keyRing('k1:test-only-session-key-number-one-000'))!;
    const both = (await keyRing(testEnv.SESSION_KEYS))!;
    const token = await seal(old, 'session', { u: 'y' });
    expect(await unseal(both, 'session', token)).toEqual({ u: 'y' });
    expect((await seal(both, 'session', {})).startsWith('k2.')).toBe(true);
  });

  it('refuse a missing, short or malformed key list (fail closed)', async () => {
    expect(await keyRing(undefined)).toBeNull();
    expect(await keyRing('k1:short')).toBeNull();
    expect(await keyRing('no-colon-here-0123456789abcdef0123456789')).toBeNull();
    expect(
      await keyRing('k1:0123456789abcdef0123456789abcdef k1:0123456789abcdef0123456789abcdef'),
    ).toBeNull();
  });
});

describe('sign-in with the dev provider', () => {
  it('runs the whole flow: start, provider page, callback, nickname, then the socket plays', async () => {
    const browser = new Browser(envIn('dev'));
    const before = await browser.me();
    expect(before).toMatchObject({ signedIn: false, csrf: null });
    expect(before.config).toEqual({
      providers: ['dev'],
      turnstileSiteKey: '1x00000000000000000000AA',
      devGuest: true,
      tilesUrl: '/api/dev/tiles/c/canvas',
      season: null,
      nextSeason: null,
      playerCap: 5_000,
    });

    const calls = mockOutbound({ [TURNSTILE]: turnstileSays(true) });
    const started = await browser.postForm('/auth/dev/start', { turnstile: 'widget-token' });
    vi.restoreAllMocks();
    expect(started.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect((await calls[0]!.formData()).get('response')).toBe('widget-token');
    const authorize = new URL(started.headers.get('Location')!);
    expect(authorize.origin + authorize.pathname).toBe(`${ORIGIN}/auth/dev/authorize`);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/dev/callback`);
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(browser.cookies.has(OAUTH_COOKIE)).toBe(true);
    // The oauth cookie is Secure, HttpOnly, SameSite=Lax.
    expect(started.headers.getSetCookie()[0]).toMatch(
      /HttpOnly; SameSite=Lax; Max-Age=600; Secure/,
    );

    const page = await browser.get(`${authorize.pathname}${authorize.search}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Dev sign-in');

    const subject = fresh('alice');
    const issued = await browser.postForm(authorize.pathname, {
      ...Object.fromEntries(authorize.searchParams),
      subject,
      name: 'Älice Example',
      email: 'alice@example.test',
    });
    const back = new URL(issued.headers.get('Location')!);
    expect(back.pathname).toBe('/auth/dev/callback');
    const signedIn = await browser.get(`${back.pathname}${back.search}`);
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get('Location')).toBe('/');
    expect(browser.cookies.has(OAUTH_COOKIE)).toBe(false);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(true);

    const me = await browser.me();
    expect(me.signedIn).toBe(true);
    expect(me.user).toMatchObject({
      nickname: null,
      suggestedNickname: 'AliceExample',
      email: 'alice@example.test',
      identities: [{ provider: 'dev', name: 'Älice Example' }],
    });

    // Without a nickname the socket only watches.
    const client = `c-${subject}`.slice(0, 64);
    const watching = await browser.get(`/ws?client=${client}`, upgrade);
    expect((await attachmentsAfter(watching)).find((a) => a.client === client)).toEqual({
      client,
    });

    const nickname = `N${subjects}x${Date.now() % 100000}`;
    const chosen = await browser.postJson(
      '/api/nickname',
      { nickname },
      { 'X-CSRF-Token': me.csrf! },
    );
    expect(chosen.status).toBe(200);
    expect(((await chosen.json()) as { user: { nickname: string } }).user.nickname).toBe(nickname);

    const playing = await browser.get(
      `/ws?client=${client}&player=ignored-when-signed-in`,
      upgrade,
    );
    const user = await userIdOf(browser);
    const attached = (await attachmentsAfter(playing)).find((a) => a.client === client) as {
      until?: number;
    };
    // The socket also learns when its token expires (about an hour from now).
    expect(attached).toEqual({ player: user, client, until: expect.any(Number) });
    expect(attached.until! - Date.now()).toBeGreaterThan(55 * 60_000);
  });

  it('signs a returning player in to the same account, without Turnstile', async () => {
    const subject = fresh('bob');
    const first = new Browser(envIn('dev'));
    await devSignIn(first, subject);
    const firstId = await userIdOf(first);

    const second = new Browser(envIn('dev'));
    mockOutbound({ [TURNSTILE]: turnstileSays(false) });
    const started = await second.postForm('/auth/dev/start', {});
    vi.restoreAllMocks();
    const authorize = new URL(started.headers.get('Location')!);
    const issued = await second.postForm(authorize.pathname, {
      ...Object.fromEntries(authorize.searchParams),
      subject,
    });
    const back = new URL(issued.headers.get('Location')!);
    expect((await second.get(`${back.pathname}${back.search}`)).headers.get('Location')).toBe('/');
    expect(await userIdOf(second)).toBe(firstId);
  });

  it('accepts each flow once: one Turnstile pass cannot be replayed into more accounts', async () => {
    const browser = new Browser(envIn('dev'));
    mockOutbound({ [TURNSTILE]: turnstileSays(true) });
    const started = await browser.postForm('/auth/dev/start', { turnstile: 't' });
    vi.restoreAllMocks();
    const flowCookie = browser.cookies.get(OAUTH_COOKIE)!;
    const authorize = new URL(started.headers.get('Location')!);
    const finish = async (subject: string) => {
      const issued = await browser.postForm(authorize.pathname, {
        ...Object.fromEntries(authorize.searchParams),
        subject,
      });
      const back = new URL(issued.headers.get('Location')!);
      return (await browser.get(`${back.pathname}${back.search}`)).headers.get('Location');
    };
    const first = fresh('once');
    expect(await finish(first)).toBe('/');
    // A script keeps the flow cookie and the authorize URL and goes round again.
    browser.cookies.delete(SESSION_COOKIE);
    browser.cookies.set(OAUTH_COOKIE, flowCookie);
    const second = fresh('twice');
    expect(await finish(second)).toBe('/?auth_error=state');
    const accounts = await db
      .prepare("SELECT subject FROM identities WHERE provider = 'dev' AND subject IN (?, ?)")
      .bind(first, second)
      .all<{ subject: string }>();
    expect(accounts.results.map((r) => r.subject)).toEqual([first]);
  });

  it('claims a flow only after the provider gave an identity', async () => {
    const browser = new Browser(envIn('dev'));
    mockOutbound({ [TURNSTILE]: turnstileSays(true) });
    const started = await browser.postForm('/auth/dev/start', { turnstile: 't' });
    vi.restoreAllMocks();
    const flowCookie = browser.cookies.get(OAUTH_COOKIE)!;
    const authorize = new URL(started.headers.get('Location')!);
    const state = authorize.searchParams.get('state')!;
    const claimed = async () =>
      (await db
        .prepare('SELECT COUNT(*) AS n FROM oauth_flows WHERE state = ?')
        .bind(state)
        .first<{ n: number }>())!.n;
    // A made-up code: the trade fails and nothing is written.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bogus = await browser.get(`/auth/dev/callback?code=made-up&state=${state}`);
    vi.restoreAllMocks();
    expect(bogus.headers.get('Location')).toBe('/?auth_error=provider');
    expect(await claimed()).toBe(0);
    // The real code still finishes the flow, which is then claimed.
    browser.cookies.set(OAUTH_COOKIE, flowCookie);
    const issued = await browser.postForm(authorize.pathname, {
      ...Object.fromEntries(authorize.searchParams),
      subject: fresh('real'),
    });
    const back = new URL(issued.headers.get('Location')!);
    expect((await browser.get(`${back.pathname}${back.search}`)).headers.get('Location')).toBe('/');
    expect(await claimed()).toBe(1);
  });

  it('creates no account when the flow cannot be claimed (D1 down)', async () => {
    let failures = 0;
    const flaky = new Proxy(db, {
      get(target, property) {
        if (property === 'batch' && failures === 0) {
          return async () => {
            failures += 1;
            throw new Error('D1 unavailable');
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const browser = new Browser(envIn('dev'));
    mockOutbound({ [TURNSTILE]: turnstileSays(true) });
    const started = await browser.postForm('/auth/dev/start', { turnstile: 't' });
    vi.restoreAllMocks();
    const authorize = new URL(started.headers.get('Location')!);
    const subject = fresh('down');
    const issued = await browser.postForm(authorize.pathname, {
      ...Object.fromEntries(authorize.searchParams),
      subject,
    });
    const back = new URL(issued.headers.get('Location')!);
    const during = new Browser(envIn('dev', { ACCOUNTS: flaky }));
    for (const [k, v] of browser.cookies) during.cookies.set(k, v);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await during.get(`${back.pathname}${back.search}`);
    expect(failures).toBe(1);
    expect(result.headers.get('Location')).toBe('/?auth_error=unavailable');
    expect(during.cookies.has(SESSION_COOKIE)).toBe(false);
    const row = await db
      .prepare("SELECT 1 AS one FROM identities WHERE provider = 'dev' AND subject = ?")
      .bind(subject)
      .first();
    expect(row).toBeNull();
  });

  it('refuses a new account when Turnstile did not pass', async () => {
    const browser = new Browser(envIn('dev'));
    mockOutbound({ [TURNSTILE]: turnstileSays(false) });
    const started = await browser.postForm('/auth/dev/start', { turnstile: 'bad' });
    vi.restoreAllMocks();
    const authorize = new URL(started.headers.get('Location')!);
    const issued = await browser.postForm(authorize.pathname, {
      ...Object.fromEntries(authorize.searchParams),
      subject: fresh('bot'),
    });
    const back = new URL(issued.headers.get('Location')!);
    const result = await browser.get(`${back.pathname}${back.search}`);
    expect(result.headers.get('Location')).toBe('/?auth_error=turnstile');
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it('refuses a callback whose state, cookie or PKCE verifier does not match', async () => {
    const browser = new Browser(envIn('dev'));
    mockOutbound({ [TURNSTILE]: turnstileSays(true) });
    const started = await browser.postForm('/auth/dev/start', { turnstile: 't' });
    vi.restoreAllMocks();
    const authorize = new URL(started.headers.get('Location')!);
    const issued = await browser.postForm(authorize.pathname, {
      ...Object.fromEntries(authorize.searchParams),
      subject: fresh('eve'),
    });
    const back = new URL(issued.headers.get('Location')!);
    const code = back.searchParams.get('code')!;

    // Another state than the one in the cookie (a forged or replayed callback).
    const forged = await browser.get(`/auth/dev/callback?code=${code}&state=other`);
    expect(forged.headers.get('Location')).toBe('/?auth_error=state');
    // The failed attempt cleared the cookie: the real callback cannot be replayed either.
    const replay = await browser.get(`${back.pathname}${back.search}`);
    expect(replay.headers.get('Location')).toBe('/?auth_error=state');

    // A code issued for another PKCE challenge: the verifier in the cookie does not fit.
    mockOutbound({ [TURNSTILE]: turnstileSays(true) });
    const again = await browser.postForm('/auth/dev/start', { turnstile: 't' });
    vi.restoreAllMocks();
    const authorize2 = new URL(again.headers.get('Location')!);
    const fields = Object.fromEntries(authorize2.searchParams);
    const wrong = await browser.postForm(authorize2.pathname, {
      ...fields,
      code_challenge: 'A'.repeat(43),
      subject: fresh('eve'),
    });
    const wrongBack = new URL(wrong.headers.get('Location')!);
    const result = await browser.get(`${wrongBack.pathname}${wrongBack.search}`);
    expect(result.headers.get('Location')).toBe('/?auth_error=provider');
  });

  it('only redirects to the registered redirect URI and back to this site', async () => {
    const browser = new Browser(envIn('dev'));
    mockOutbound({ [TURNSTILE]: turnstileSays(true) });
    const started = await browser.postForm('/auth/dev/start', {
      turnstile: 't',
      return: '//evil.test/x',
    });
    vi.restoreAllMocks();
    const authorize = new URL(started.headers.get('Location')!);
    const elsewhere = new URLSearchParams(authorize.searchParams);
    elsewhere.set('redirect_uri', 'https://evil.test/auth/dev/callback');
    expect((await browser.get(`${authorize.pathname}?${elsewhere}`)).status).toBe(400);
    const issued = await browser.postForm(authorize.pathname, {
      ...Object.fromEntries(authorize.searchParams),
      subject: fresh('ret'),
    });
    const back = new URL(issued.headers.get('Location')!);
    expect((await browser.get(`${back.pathname}${back.search}`)).headers.get('Location')).toBe('/');
  });

  it('offers the dev provider in dev only', async () => {
    for (const environment of ['staging', 'production'] as const) {
      const browser = new Browser(envIn(environment));
      expect((await browser.me()).config.providers).toEqual([]);
      expect((await browser.postForm('/auth/dev/start', {})).status).toBe(404);
      expect((await browser.get('/auth/dev/authorize')).status).toBe(404);
    }
  });

  it('closes sign-in when PUBLIC_ORIGIN is not set outside dev', async () => {
    const browser = new Browser(
      envIn('production', {
        PUBLIC_ORIGIN: undefined,
        DISCORD_CLIENT_ID: 'id',
        DISCORD_CLIENT_SECRET: 'secret',
      }),
    );
    expect((await browser.me()).config.providers).toEqual([]);
    expect((await browser.postForm('/auth/discord/start', {})).status).toBe(503);
  });
});

describe('sessions', () => {
  it('signs out, and "everywhere" stops other sessions from renewing', async () => {
    const { browser, csrf } = await player();
    const other = new Browser(envIn('dev'));
    for (const [k, v] of browser.cookies) other.cookies.set(k, v);

    // Logout needs the CSRF token.
    expect((await browser.postJson('/auth/logout', {})).status).toBe(403);
    const out = await browser.postJson(
      '/auth/logout',
      { everywhere: true },
      { 'X-CSRF-Token': csrf },
    );
    expect(out.status).toBe(200);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await browser.me()).signedIn).toBe(false);
    // The copy elsewhere is refused at its next check and its cookie cleared.
    expect((await other.me()).signedIn).toBe(false);
    expect(other.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it('renews an expired token after checking the account, and an expired one only watches', async () => {
    const { browser } = await player();
    const ring = (await keyRing(testEnv.SESSION_KEYS))!;
    const session = (await unseal<Record<string, number | string>>(
      ring,
      'session',
      browser.cookies.get(SESSION_COOKIE),
    ))!;
    const now = Date.now();
    const expired = { ...session, i: now - 2 * 3600_000, e: now - 3600_000 };
    browser.cookies.set(SESSION_COOKIE, await seal(ring, 'session', expired));

    const client = `exp-${subjects}-${now % 1000000}`;
    const watching = await browser.get(`/ws?client=${client}`, upgrade);
    expect((await attachmentsAfter(watching)).find((a) => a.client === client)).toEqual({
      client,
    });

    const renewed = await browser.get('/api/me');
    expect(renewed.headers.getSetCookie()).toHaveLength(1);
    const fresh = (await unseal<{ e: number }>(
      ring,
      'session',
      browser.cookies.get(SESSION_COOKIE),
    ))!;
    expect(fresh.e).toBeGreaterThan(now);
    // The page learns how long the renewed token has left, to move its socket in time.
    const left = ((await renewed.json()) as MeBody).sessionExpiresIn!;
    expect(left).toBeGreaterThan(fresh.e - Date.now() - 5_000);
    expect(left).toBeLessThanOrEqual(fresh.e - now);
  });

  it('ends the session of a banned account', async () => {
    const subject = fresh('ban');
    const { browser } = await player(subject);
    const user = await userIdOf(browser);
    await db
      .prepare(
        "INSERT INTO bans (user_id, reason, created_by, created_at) VALUES (?, 'test', 'test', ?)",
      )
      .bind(user, Date.now())
      .run();
    expect((await browser.me()).signedIn).toBe(false);
    // Signing in again is refused too.
    const again = new Browser(envIn('dev'));
    const result = await devSignIn(again, subject);
    expect(result.headers.get('Location')).toBe('/?auth_error=banned');
  });

  it('refuses state changes from another site and without the CSRF token (outside dev)', async () => {
    const { browser } = await player();
    const staging = new Browser(envIn('staging'));
    for (const [k, v] of browser.cookies) staging.cookies.set(k, v);
    const { csrf } = await staging.me();
    expect(csrf).toBeTruthy();
    const foreign = await staging.postJson(
      '/api/nickname',
      { nickname: 'Whatever1' },
      { 'X-CSRF-Token': csrf!, Origin: 'https://evil.test' },
    );
    expect(foreign.status).toBe(403);
    const noToken = await staging.postJson(
      '/api/nickname',
      { nickname: 'Whatever1' },
      { Origin: ORIGIN },
    );
    expect(noToken.status).toBe(403);
    // A CSRF token of another session does not fit either.
    const { csrf: otherCsrf } = await player();
    const wrong = await staging.postJson(
      '/api/nickname',
      { nickname: 'Whatever1' },
      { 'X-CSRF-Token': otherCsrf, Origin: ORIGIN },
    );
    expect(wrong.status).toBe(403);
  });
});

describe('nicknames', () => {
  async function signedInWithoutNickname(name = 'Someone') {
    const browser = new Browser(envIn('dev'));
    await devSignIn(browser, fresh('n'), name);
    const { csrf } = await browser.me();
    const choose = (nickname: unknown) =>
      browser.postJson('/api/nickname', { nickname }, { 'X-CSRF-Token': csrf! });
    return { browser, choose };
  }

  it('checks length and characters', async () => {
    const { choose } = await signedInWithoutNickname();
    const error = async (nickname: unknown) =>
      ((await (await choose(nickname)).json()) as { error: string }).error;
    expect(await error('ab')).toBe('too_short');
    expect(await error('a'.repeat(21))).toBe('too_long');
    expect(await error('has space')).toBe('characters');
    expect(await error('has-dash')).toBe('characters');
    expect(await error('emoji🙂ok')).toBe('characters');
    expect(await error(42)).toBe('characters');
  });

  it('checks the word list from KV, with stand-ins and whole-name entries', async () => {
    const { choose } = await signedInWithoutNickname();
    expect((await choose('xx_B4D_w0rd_xx')).status).toBe(400);
    expect((await choose('exact')).status).toBe(400);
    const fine = await choose(`exactly${subjects}`);
    expect(fine.status).toBe(200);
  });

  it('keeps nicknames unique whatever the letter case', async () => {
    const name = `Uniq${Date.now() % 1_000_000}`;
    const a = await signedInWithoutNickname();
    expect((await a.choose(name)).status).toBe(200);
    const b = await signedInWithoutNickname();
    const taken = await b.choose(name.toUpperCase());
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: 'taken' });
  });

  it('allows a rename once every 30 days', async () => {
    const { browser, choose } = await signedInWithoutNickname();
    const first = `Ren${Date.now() % 1_000_000}`;
    expect((await choose(first)).status).toBe(200);
    const soon = await choose(`${first}b`);
    expect(soon.status).toBe(429);
    const { retryAt } = (await soon.json()) as { retryAt: number };
    expect(retryAt).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
    // Thirty days later (moved back in D1 rather than waiting).
    await db
      .prepare('UPDATE users SET nickname_changed_at = ? WHERE id = ?')
      .bind(Date.now() - 31 * 24 * 3600_000, await userIdOf(browser))
      .run();
    expect((await choose(`${first}b`)).status).toBe(200);
  });

  it('lets only one of two racing renames through', async () => {
    const { browser, choose } = await signedInWithoutNickname();
    const first = `Race${Date.now() % 1_000_000}`;
    expect((await choose(first)).status).toBe(200);
    await db
      .prepare('UPDATE users SET nickname_changed_at = ? WHERE id = ?')
      .bind(Date.now() - 31 * 24 * 3600_000, await userIdOf(browser))
      .run();
    const statuses = (await Promise.all([choose(`${first}a`), choose(`${first}b`)])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([200, 429]);
  });

  it('waits rather than skip the filter when the word list cannot be read (outside dev)', async () => {
    await testEnv.MODERATION.delete(WORD_LIST_KEY);
    forgetWordList();
    const { browser } = await signedInWithoutNickname();
    const staging = new Browser(envIn('staging'));
    for (const [k, v] of browser.cookies) staging.cookies.set(k, v);
    const { csrf } = await staging.me();
    const response = await staging.postJson(
      '/api/nickname',
      { nickname: `Fine${subjects}` },
      { 'X-CSRF-Token': csrf!, Origin: ORIGIN },
    );
    expect(response.status).toBe(503);
  });
});

/** A JWT with these claims; Google's signature is not checked (see providers.ts). */
function idToken(claims: Record<string, unknown>): string {
  const part = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
}

describe('real providers (outbound calls mocked)', () => {
  const providers = {
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    REDDIT_CLIENT_ID: 'reddit-id',
    REDDIT_CLIENT_SECRET: 'reddit-secret',
    DISCORD_CLIENT_ID: 'discord-id',
    DISCORD_CLIENT_SECRET: 'discord-secret',
  };

  async function startWith(
    browser: Browser,
    provider: string,
    fields: Record<string, string> = {},
  ) {
    mockOutbound({ [TURNSTILE]: turnstileSays(true) });
    const started = await browser.postForm(
      `/auth/${provider}/start`,
      { turnstile: 't', ...fields },
      { Origin: ORIGIN },
    );
    vi.restoreAllMocks();
    expect(started.status).toBe(302);
    return new URL(started.headers.get('Location')!);
  }

  it('signs in with Google: PKCE, exact redirect URI, nonce checked in the ID token', async () => {
    const browser = new Browser(envIn('production', providers));
    expect((await browser.me()).config.providers).toEqual(['google', 'reddit', 'discord']);
    const authorize = await startWith(browser, 'google');
    expect(authorize.origin + authorize.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    const q = authorize.searchParams;
    expect(q.get('redirect_uri')).toBe(`${ORIGIN}/auth/google/callback`);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('scope')).toBe('openid email profile');
    const sub = fresh('g');
    const calls = mockOutbound({
      'https://oauth2.googleapis.com/token': async (request) => {
        const form = new URLSearchParams(await request.text());
        expect(form.get('code')).toBe('the-code');
        expect(form.get('redirect_uri')).toBe(`${ORIGIN}/auth/google/callback`);
        expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return Response.json({
          access_token: 'at',
          id_token: idToken({
            iss: 'https://accounts.google.com',
            aud: 'google-id',
            sub,
            email: 'g@example.test',
            email_verified: true,
            name: 'Gee Person',
            nonce: q.get('nonce'),
            exp: Math.floor(Date.now() / 1000) + 600,
          }),
        });
      },
    });
    const result = await browser.get(`/auth/google/callback?code=the-code&state=${q.get('state')}`);
    expect(calls).toHaveLength(1);
    expect(result.headers.get('Location')).toBe('/');
    expect((await browser.me()).user).toMatchObject({
      email: 'g@example.test',
      suggestedNickname: 'GeePerson',
      identities: [{ provider: 'google', name: 'Gee Person' }],
    });
  });

  it('refuses a Google ID token with another nonce or audience', async () => {
    for (const bad of [
      { nonce: 'other' },
      { aud: 'someone-else' },
      // Several audiences: we must also be the authorized party.
      { aud: ['google-id', 'another-app'] },
      { aud: ['google-id', 'another-app'], azp: 'another-app' },
    ]) {
      const browser = new Browser(envIn('production', providers));
      const q = (await startWith(browser, 'google')).searchParams;
      mockOutbound({
        'https://oauth2.googleapis.com/token': () =>
          Response.json({
            id_token: idToken({
              iss: 'accounts.google.com',
              aud: 'google-id',
              sub: fresh('g'),
              nonce: q.get('nonce'),
              exp: Math.floor(Date.now() / 1000) + 600,
              ...bad,
            }),
          }),
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await browser.get(`/auth/google/callback?code=c&state=${q.get('state')}`);
      expect(result.headers.get('Location')).toBe('/?auth_error=provider');
    }
  });

  it('signs in with Reddit (no email) and links Discord, never the same identity twice', async () => {
    const browser = new Browser(envIn('production', providers));
    const q = (await startWith(browser, 'reddit')).searchParams;
    const redditId = fresh('r');
    mockOutbound({
      'https://www.reddit.com/api/v1/access_token': (request) => {
        expect(request.headers.get('Authorization')).toBe(
          `Basic ${btoa('reddit-id:reddit-secret')}`,
        );
        return Response.json({ access_token: 'rt' });
      },
      'https://oauth.reddit.com/api/v1/me': (request) => {
        expect(request.headers.get('Authorization')).toBe('Bearer rt');
        expect(request.headers.get('User-Agent')).toContain('brickplace');
        return Response.json({ id: redditId, name: 'redditor_1' });
      },
    });
    await browser.get(`/auth/reddit/callback?code=c&state=${q.get('state')}`);
    vi.restoreAllMocks();
    const me = await browser.me();
    expect(me.user).toMatchObject({ email: null, identities: [{ provider: 'reddit' }] });

    // Linking needs the CSRF token and skips Turnstile.
    const discordId = fresh('d');
    const linkStart = await startWith(browser, 'discord', { mode: 'link', csrf: me.csrf! });
    expect(linkStart.origin).toBe('https://discord.com');
    const discordRoutes = {
      'https://discord.com/api/oauth2/token': () => Response.json({ access_token: 'dt' }),
      'https://discord.com/api/users/@me': () =>
        Response.json({ id: discordId, username: 'disc', email: 'd@example.test', verified: true }),
    };
    mockOutbound(discordRoutes);
    const linked = await browser.get(
      `/auth/discord/callback?code=c&state=${linkStart.searchParams.get('state')}`,
    );
    vi.restoreAllMocks();
    expect(linked.headers.get('Location')).toBe('/?linked=discord');
    const after = await browser.me();
    expect(after.user!.identities.map((i) => i.provider)).toEqual(['reddit', 'discord']);
    // The first verified email is kept for the account.
    expect(after.user!.email).toBe('d@example.test');

    // Another account cannot take that Discord identity.
    const other = new Browser(envIn('production', providers));
    const otherQ = (await startWith(other, 'reddit')).searchParams;
    mockOutbound({
      'https://www.reddit.com/api/v1/access_token': () => Response.json({ access_token: 'x' }),
      'https://oauth.reddit.com/api/v1/me': () => Response.json({ id: fresh('r'), name: 'n2' }),
    });
    await other.get(`/auth/reddit/callback?code=c&state=${otherQ.get('state')}`);
    vi.restoreAllMocks();
    const otherMe = await other.me();
    const steal = await startWith(other, 'discord', { mode: 'link', csrf: otherMe.csrf! });
    mockOutbound(discordRoutes);
    const stolen = await other.get(
      `/auth/discord/callback?code=c&state=${steal.searchParams.get('state')}`,
    );
    expect(stolen.headers.get('Location')).toBe('/?auth_error=taken');

    // Unlink, but never the last identity.
    vi.restoreAllMocks();
    const headers = { 'X-CSRF-Token': after.csrf!, Origin: ORIGIN };
    expect((await browser.postJson('/api/identities/discord/unlink', {}, headers)).status).toBe(
      200,
    );
    const last = await browser.postJson('/api/identities/reddit/unlink', {}, headers);
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: 'last_identity' });
  });

  it('creates no account from a Turnstile token solved on another site or widget', async () => {
    const discordRoutes = (id: string) => ({
      'https://discord.com/api/oauth2/token': () => Response.json({ access_token: 'dt' }),
      'https://discord.com/api/users/@me': () => Response.json({ id, username: 'u' }),
    });
    const attempt = async (answer: Record<string, unknown>) => {
      const browser = new Browser(envIn('production', providers));
      mockOutbound({ [TURNSTILE]: () => Response.json(answer) });
      const started = await browser.postForm(
        '/auth/discord/start',
        { turnstile: 't' },
        { Origin: ORIGIN },
      );
      vi.restoreAllMocks();
      const state = new URL(started.headers.get('Location')!).searchParams.get('state');
      const id = fresh('t');
      mockOutbound(discordRoutes(id));
      const result = await browser.get(`/auth/discord/callback?code=c&state=${state}`);
      vi.restoreAllMocks();
      const row = await db
        .prepare("SELECT 1 AS one FROM identities WHERE provider = 'discord' AND subject = ?")
        .bind(id)
        .first();
      return { location: result.headers.get('Location'), created: row !== null };
    };
    expect(await attempt({ success: true, hostname: 'evil.test', action: 'signin' })).toEqual({
      location: '/?auth_error=turnstile',
      created: false,
    });
    expect(await attempt({ success: true, hostname: 'brickplace.test', action: 'other' })).toEqual({
      location: '/?auth_error=turnstile',
      created: false,
    });
    expect(await attempt({ success: true, hostname: 'brickplace.test', action: 'signin' })).toEqual(
      { location: '/', created: true },
    );
  });

  it('refuses to link with a copied cookie once the owner signed out everywhere', async () => {
    const { browser, csrf } = await player();
    const user = await userIdOf(browser);
    const thief = new Browser(envIn('dev'));
    for (const [k, v] of browser.cookies) thief.cookies.set(k, v);
    const identities = async () =>
      (await db
        .prepare('SELECT COUNT(*) AS n FROM identities WHERE user_id = ?')
        .bind(user)
        .first<{ n: number }>())!.n;

    // A link started before the sign-out is refused at the callback...
    const early = await thief.postForm('/auth/dev/start', { mode: 'link', csrf });
    const authorize = new URL(early.headers.get('Location')!);
    expect(authorize.pathname).toBe('/auth/dev/authorize');
    const out = await browser.postJson(
      '/auth/logout',
      { everywhere: true },
      { 'X-CSRF-Token': csrf },
    );
    expect(out.status).toBe(200);
    const issued = await thief.postForm(authorize.pathname, {
      ...Object.fromEntries(authorize.searchParams),
      subject: fresh('thief'),
    });
    const back = new URL(issued.headers.get('Location')!);
    expect((await thief.get(`${back.pathname}${back.search}`)).headers.get('Location')).toBe(
      '/?auth_error=session',
    );
    // ...and one started after it is refused at once.
    const late = await thief.postForm('/auth/dev/start', { mode: 'link', csrf });
    expect(late.headers.get('Location')).toBe('/?auth_error=session');
    expect(await identities()).toBe(1);
  });

  it('links only from a recent sign-in', async () => {
    const { browser, csrf } = await player();
    const ring = (await keyRing(testEnv.SESSION_KEYS))!;
    const session = (await unseal<Record<string, number | string>>(
      ring,
      'session',
      browser.cookies.get(SESSION_COOKIE),
    ))!;
    const old = { ...session, a: Date.now() - 11 * 60_000 };
    browser.cookies.set(SESSION_COOKIE, await seal(ring, 'session', old));
    const response = await browser.postForm('/auth/dev/start', { mode: 'link', csrf });
    expect(response.headers.get('Location')).toBe('/?auth_error=session');
    // The client is told until when linking works.
    const fresh = await player();
    const me = await fresh.browser.me();
    expect(me.user!.linkUntil).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it('checks the sign-in age again when the provider sends the browser back', async () => {
    const { browser, csrf } = await player();
    const user = await userIdOf(browser);
    const started = await browser.postForm('/auth/dev/start', { mode: 'link', csrf });
    const authorize = new URL(started.headers.get('Location')!);
    expect(authorize.pathname).toBe('/auth/dev/authorize');
    // While at the provider, the same session (same u and s) turns out to be too old.
    const ring = (await keyRing(testEnv.SESSION_KEYS))!;
    const session = (await unseal<Record<string, number | string>>(
      ring,
      'session',
      browser.cookies.get(SESSION_COOKIE),
    ))!;
    browser.cookies.set(
      SESSION_COOKIE,
      await seal(ring, 'session', { ...session, a: Date.now() - 11 * 60_000 }),
    );
    const issued = await browser.postForm(authorize.pathname, {
      ...Object.fromEntries(authorize.searchParams),
      subject: fresh('late'),
    });
    const back = new URL(issued.headers.get('Location')!);
    expect((await browser.get(`${back.pathname}${back.search}`)).headers.get('Location')).toBe(
      '/?auth_error=session',
    );
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM identities WHERE user_id = ?')
      .bind(user)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('refuses to link without the CSRF token', async () => {
    const { browser } = await player();
    const response = await browser.postForm('/auth/dev/start', { mode: 'link', csrf: 'nope' });
    expect(response.headers.get('Location')).toBe('/?auth_error=session');
  });
});
