// Reporting a nickname, the data download and account deletion (ADR 0019).
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRIBUTIONS_NOTE } from '../src/account-api.ts';
import type { Env } from '../src/index.ts';
import { forgetWordList, WORD_LIST_KEY } from '../src/nickname.ts';
import { forgetReportLimit, REPORT_LIMIT_KEY } from '../src/reports.ts';
import { keyRing, seal, unseal } from '../src/token.ts';
import { Browser, devSignIn, envIn, ORIGIN } from './support.ts';

const testEnv = env as unknown as Env;
const db = testEnv.ACCOUNTS;
const SESSION_COOKIE = '__Host-bp_session';
let count = 0;
const fresh = (prefix: string) => `${prefix}-${Date.now()}-${++count}`;
/** A nickname no other test uses: letters and digits, at most 20 characters. */
const uniqueNickname = (prefix: string) => `${prefix}${Date.now() % 1_000_000}x${++count}`;

beforeEach(async () => {
  forgetWordList();
  forgetReportLimit();
  await testEnv.MODERATION.put(WORD_LIST_KEY, '# test list\nbadword\n');
  await testEnv.MODERATION.put(REPORT_LIMIT_KEY, '3');
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Player {
  browser: Browser;
  csrf: string;
  nickname: string;
  subject: string;
  id: string;
}

async function userIdOf(browser: Browser): Promise<string> {
  const ring = (await keyRing(testEnv.SESSION_KEYS))!;
  const session = await unseal<{ u: string }>(ring, 'session', browser.cookies.get(SESSION_COOKIE));
  return session!.u;
}

/** A signed-in player with a nickname, in dev (no Origin checks). */
async function player(prefix = 'P'): Promise<Player> {
  const browser = new Browser(envIn('dev'));
  const subject = fresh('r');
  await devSignIn(browser, subject);
  const { csrf } = await browser.me();
  const nickname = uniqueNickname(prefix);
  const chosen = await browser.postJson('/api/nickname', { nickname }, { 'X-CSRF-Token': csrf! });
  expect(chosen.status).toBe(200);
  return { browser, csrf: csrf!, nickname, subject, id: await userIdOf(browser) };
}

/** The same cookies, seen by a staging deployment (Origin and KV rules apply). */
async function inStaging(from: Player) {
  const browser = new Browser(envIn('staging'));
  for (const [k, v] of from.browser.cookies) browser.cookies.set(k, v);
  const { csrf } = await browser.me();
  return { browser, csrf: csrf! };
}

const reportAs = (who: { browser: Browser; csrf: string }, nickname: unknown, reason: unknown) =>
  who.browser.postJson(
    '/api/reports',
    { nickname, reason },
    { 'X-CSRF-Token': who.csrf, Origin: ORIGIN },
  );

const errorOf = async (response: Response) => ((await response.json()) as { error?: string }).error;

describe('reporting a nickname', () => {
  it('files one open report per reporter and target, with the nickname as it was', async () => {
    const reporter = await player('Rep');
    const target = await player('Tgt');
    // Any letter case finds the account.
    const filed = await reportAs(reporter, target.nickname.toLowerCase(), 'offensive');
    expect(filed.status).toBe(201);
    const rows = await db
      .prepare(
        'SELECT target_id, target_nickname, reason, status FROM reports WHERE reporter_id = ?',
      )
      .bind(reporter.id)
      .all();
    expect(rows.results).toEqual([
      {
        target_id: target.id,
        target_nickname: target.nickname,
        reason: 'offensive',
        status: 'open',
      },
    ]);
    const again = await reportAs(reporter, target.nickname, 'hateful');
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toBe('already_reported');
    // Once a moderator closes it, the same player may report the same nickname again.
    await db
      .prepare("UPDATE reports SET status = 'dismissed', resolved_at = ? WHERE reporter_id = ?")
      .bind(Date.now(), reporter.id)
      .run();
    expect((await reportAs(reporter, target.nickname, 'hateful')).status).toBe(201);
  });

  it('refuses unknown names, a reason outside the set, oneself and accounts without a nickname', async () => {
    const reporter = await player('Rep');
    const target = await player('Tgt');
    expect(await errorOf(await reportAs(reporter, 'Nobody_has_this_1', 'offensive'))).toBe(
      'not_found',
    );
    expect(await errorOf(await reportAs(reporter, 'not a name!', 'offensive'))).toBe('not_found');
    expect(await errorOf(await reportAs(reporter, target.nickname, 'boring'))).toBe('reason');
    expect(await errorOf(await reportAs(reporter, reporter.nickname, 'offensive'))).toBe('self');

    const watcher = new Browser(envIn('dev'));
    await devSignIn(watcher, fresh('w'));
    const { csrf } = await watcher.me();
    const refused = await reportAs({ browser: watcher, csrf: csrf! }, target.nickname, 'offensive');
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toBe('no_nickname');
    // Signed out, or without the CSRF token: refused before anything is read.
    expect((await new Browser(envIn('dev')).postJson('/api/reports', {})).status).toBe(401);
    expect((await reporter.browser.postJson('/api/reports', {})).status).toBe(403);
  });

  it('caps reports per account per 24 hours at the number in KV', async () => {
    await testEnv.MODERATION.put(REPORT_LIMIT_KEY, '2');
    const reporter = await player('Rep');
    const targets = [await player('T'), await player('T'), await player('T')];
    expect((await reportAs(reporter, targets[0]!.nickname, 'offensive')).status).toBe(201);
    expect((await reportAs(reporter, targets[1]!.nickname, 'offensive')).status).toBe(201);
    const third = await reportAs(reporter, targets[2]!.nickname, 'offensive');
    expect(third.status).toBe(429);
    expect(await errorOf(third)).toBe('too_many');
    // A day later the oldest no longer counts.
    await db
      .prepare(
        'UPDATE reports SET created_at = ? WHERE id = (SELECT MIN(id) FROM reports WHERE reporter_id = ?)',
      )
      .bind(Date.now() - 25 * 3600_000, reporter.id)
      .run();
    expect((await reportAs(reporter, targets[2]!.nickname, 'offensive')).status).toBe(201);
  });

  it('lets only one of two simultaneous reports on the same nickname through', async () => {
    await testEnv.MODERATION.put(REPORT_LIMIT_KEY, '5');
    const reporter = await player('Rep');
    const target = await player('Tgt');
    // Both pass the "already reported?" read before either writes: the partial UNIQUE index
    // is what keeps the second one out.
    const statuses = await Promise.all([
      reportAs(reporter, target.nickname, 'offensive'),
      reportAs(reporter, target.nickname, 'hateful'),
    ]);
    expect(statuses.map((r) => r.status).sort()).toEqual([201, 409]);
    const open = await db
      .prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND status = 'open'")
      .bind(reporter.id)
      .first<{ n: number }>();
    expect(open!.n).toBe(1);
  });

  it('lets only as many simultaneous reports through as the cap allows', async () => {
    await testEnv.MODERATION.put(REPORT_LIMIT_KEY, '1');
    const reporter = await player('Rep');
    const targets = [await player('T'), await player('T'), await player('T')];
    const statuses = await Promise.all(
      targets.map(
        async (t) => (await reportAs(reporter, t.nickname, 'spam_is_not_a_reason')).status,
      ),
    );
    expect(statuses).toEqual([400, 400, 400]);
    const racing = await Promise.all(
      targets.map(async (t) => (await reportAs(reporter, t.nickname, 'impersonation')).status),
    );
    expect(racing.sort()).toEqual([201, 429, 429]);
  });

  it('refuses reports outside dev when the cap is missing or malformed (fail closed)', async () => {
    const reporter = await player('Rep');
    const target = await player('Tgt');
    const staging = await inStaging(reporter);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await testEnv.MODERATION.delete(REPORT_LIMIT_KEY);
    forgetReportLimit();
    const missing = await reportAs(staging, target.nickname, 'offensive');
    expect(missing.status).toBe(503);
    expect(await errorOf(missing)).toBe('unavailable');
    await testEnv.MODERATION.put(REPORT_LIMIT_KEY, 'lots');
    forgetReportLimit();
    expect((await reportAs(staging, target.nickname, 'offensive')).status).toBe(503);
    // `0` closes reporting on purpose.
    await testEnv.MODERATION.put(REPORT_LIMIT_KEY, '0');
    forgetReportLimit();
    expect((await reportAs(staging, target.nickname, 'offensive')).status).toBe(429);
    await testEnv.MODERATION.put(REPORT_LIMIT_KEY, ' 5\n');
    forgetReportLimit();
    expect((await reportAs(staging, target.nickname, 'offensive')).status).toBe(201);
  });

  it('has no cap in dev when KV has none', async () => {
    await testEnv.MODERATION.delete(REPORT_LIMIT_KEY);
    forgetReportLimit();
    const reporter = await player('Rep');
    for (let i = 0; i < 4; i++) {
      const target = await player('T');
      expect((await reportAs(reporter, target.nickname, 'offensive')).status).toBe(201);
    }
  });
});

describe('data download', () => {
  it('gives the account, identities, bans and reports filed, and nothing of anyone else', async () => {
    const me = await player('Exp');
    const other = await player('Oth');
    expect((await reportAs(me, other.nickname, 'personal_info')).status).toBe(201);
    // Reports about me are not mine to see.
    expect((await reportAs(other, me.nickname, 'offensive')).status).toBe(201);
    await db
      .prepare(
        'INSERT INTO bans (user_id, reason, created_by, created_at, expires_at, lifted_at) ' +
          "VALUES (?, 'spam', 'moderator-7', ?, ?, ?)",
      )
      .bind(me.id, 1_000, 2_000, 1_500)
      .run();

    const staging = await inStaging(me);
    expect((await staging.browser.get('/api/account/export')).status).toBe(405);
    expect(
      (await staging.browser.postJson('/api/account/export', {}, { Origin: ORIGIN })).status,
    ).toBe(403);
    const response = await staging.browser.postJson(
      '/api/account/export',
      {},
      { 'X-CSRF-Token': staging.csrf, Origin: ORIGIN },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="brickplace-account-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toMatchObject({
      format: 'brickplace-account-export',
      version: 1,
      account: {
        id: me.id,
        email: `${me.subject}@example.test`,
        nickname: me.nickname,
        sessionsValidAfter: null,
      },
      identities: [
        {
          provider: 'dev',
          subject: me.subject,
          email: `${me.subject}@example.test`,
          displayName: 'Alice Example',
        },
      ],
      bans: [
        {
          reason: 'spam',
          createdAt: new Date(1_000).toISOString(),
          expiresAt: new Date(2_000).toISOString(),
          liftedAt: new Date(1_500).toISOString(),
        },
      ],
      reportsFiled: [
        {
          targetNickname: other.nickname,
          reason: 'personal_info',
          status: 'open',
          resolvedAt: null,
        },
      ],
      contributions: CONTRIBUTIONS_NOTE,
    });
    const text = JSON.stringify(data);
    // No moderator ids, nobody else's account id, no tokens of any kind.
    expect(text).not.toContain('moderator-7');
    expect(text).not.toContain(other.id);
    expect(text).not.toMatch(/token|secret/i);
    expect((data.bans as object[])[0]).not.toHaveProperty('createdBy');
  });
});

describe('account deletion', () => {
  const remove = (who: { browser: Browser; csrf: string }, confirm: unknown) =>
    who.browser.postJson(
      '/api/account/delete',
      { confirm },
      { 'X-CSRF-Token': who.csrf, Origin: ORIGIN },
    );

  async function signInAgo(who: Player, ms: number) {
    const ring = (await keyRing(testEnv.SESSION_KEYS))!;
    const session = (await unseal<Record<string, unknown>>(
      ring,
      'session',
      who.browser.cookies.get(SESSION_COOKIE),
    ))!;
    who.browser.cookies.set(
      SESSION_COOKIE,
      await seal(ring, 'session', { ...session, a: Date.now() - ms }),
    );
  }

  it('needs a recent sign-in and the nickname typed again', async () => {
    const me = await player('Del');
    await signInAgo(me, 11 * 60_000);
    const stale = await remove(me, me.nickname);
    expect(stale.status).toBe(403);
    expect(await errorOf(stale)).toBe('reauth');
    await signInAgo(me, 60_000);
    const wrong = await remove(me, `${me.nickname}x`);
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe('confirm');
    expect(await errorOf(await remove(me, undefined))).toBe('confirm');
    expect((await me.browser.me()).signedIn).toBe(true);
  });

  it('deletes the account, ends its sessions, frees the nickname and never reuses the id', async () => {
    const me = await player('Del');
    const other = await player('Oth');
    const elsewhere = new Browser(envIn('dev'));
    for (const [k, v] of me.browser.cookies) elsewhere.cookies.set(k, v);
    expect((await reportAs(me, other.nickname, 'offensive')).status).toBe(201);
    expect((await reportAs(other, me.nickname, 'offensive')).status).toBe(201);
    await db
      .prepare(
        'INSERT INTO bans (user_id, reason, created_by, created_at, expires_at) ' +
          "VALUES (?, 'old ban', 'moderator-3', ?, ?)",
      )
      .bind(me.id, 1_000, 2_000)
      .run();

    const staging = await inStaging(me);
    // Typed in another letter case, with spaces around it.
    const deleted = await remove(staging, ` ${me.nickname.toUpperCase()} `);
    expect(deleted.status).toBe(200);
    expect(staging.browser.cookies.has(SESSION_COOKIE)).toBe(false);
    // A copy of the cookie elsewhere is refused at its next check.
    expect((await elsewhere.me()).signedIn).toBe(false);

    const left = async (table: string, where: string) =>
      (await db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
        .bind(me.id)
        .first<{ n: number }>())!.n;
    expect(await left('users', 'id = ?1')).toBe(0);
    expect(await left('identities', 'user_id = ?1')).toBe(0);
    expect(await left('bans', 'user_id = ?1')).toBe(0);
    expect(await left('reports', 'reporter_id = ?1 OR target_id = ?1')).toBe(0);
    // The ban stays as an audit row that names nobody.
    const audit = await db
      .prepare(
        "SELECT * FROM bans_of_deleted_accounts WHERE reason = 'old ban' AND created_by = 'moderator-3'",
      )
      .all<Record<string, unknown>>();
    expect(audit.results).toHaveLength(1);
    expect(Object.keys(audit.results[0]!).sort()).toEqual([
      'account_deleted_at',
      'created_at',
      'created_by',
      'expires_at',
      'id',
      'lifted_at',
      'reason',
    ]);

    // The id is retired: D1 refuses to give it out again.
    const tombstone = await db
      .prepare('SELECT deleted_at FROM deleted_accounts WHERE id = ?')
      .bind(me.id)
      .first<{ deleted_at: number }>();
    expect(tombstone?.deleted_at).toBeGreaterThan(0);
    await expect(
      db
        .prepare('INSERT INTO users (id, created_at, signed_in_at) VALUES (?, 1, 1)')
        .bind(me.id)
        .run(),
    ).rejects.toThrow(/deleted account id/);

    // The nickname is free for someone else.
    const newcomer = new Browser(envIn('dev'));
    await devSignIn(newcomer, fresh('n'));
    const { csrf } = await newcomer.me();
    const taken = await newcomer.postJson(
      '/api/nickname',
      { nickname: me.nickname },
      { 'X-CSRF-Token': csrf! },
    );
    expect(taken.status).toBe(200);

    // While the deleted account's tokens may still play (an hour), the same provider account
    // cannot make a second player: delete and sign up again would multiply players.
    const soon = new Browser(envIn('dev'));
    const refused = await devSignIn(soon, me.subject);
    expect(refused.headers.get('Location')).toBe('/?auth_error=recently_deleted');
    expect(soon.cookies.has(SESSION_COOKIE)).toBe(false);
    // Only a keyed hash of the identity is kept, never the provider's id.
    const held = await db
      .prepare('SELECT hash FROM deleted_identities WHERE deleted_at = ?')
      .bind(tombstone!.deleted_at)
      .all<{ hash: string }>();
    expect(held.results.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(held.results)).not.toContain(me.subject);

    // After the hold-off, signing in again makes a new account with a new id.
    await db
      .prepare('UPDATE deleted_identities SET deleted_at = ? WHERE deleted_at = ?')
      .bind(Date.now() - 61 * 60_000, tombstone!.deleted_at)
      .run();
    const back = new Browser(envIn('dev'));
    await devSignIn(back, me.subject);
    const again = await back.me();
    expect(again.signedIn).toBe(true);
    expect(again.user!.nickname).toBeNull();
    expect(await userIdOf(back)).not.toBe(me.id);
  });

  it('keeps the hold-off when the session key rotates in between', async () => {
    const me = await player('Rot');
    expect((await remove(me, me.nickname)).status).toBe(200);
    // Deleted under k2 (the signer); a new key k3 now signs and k2 only verifies.
    const rotated = envIn('dev', {
      SESSION_KEYS:
        'k3:test-only-session-key-number-three-0 k2:test-only-session-key-number-two-000',
    });
    const after = new Browser(rotated);
    const refused = await devSignIn(after, me.subject);
    expect(refused.headers.get('Location')).toBe('/?auth_error=recently_deleted');
  });

  it('lets an account without a nickname confirm with the word delete', async () => {
    const browser = new Browser(envIn('dev'));
    await devSignIn(browser, fresh('nn'));
    const { csrf } = await browser.me();
    const id = await userIdOf(browser);
    expect(await errorOf(await remove({ browser, csrf: csrf! }, 'yes'))).toBe('confirm');
    expect((await remove({ browser, csrf: csrf! }, 'Delete')).status).toBe(200);
    const row = await db.prepare('SELECT 1 AS one FROM users WHERE id = ?').bind(id).first();
    expect(row).toBeNull();
  });
});

describe('host check', () => {
  it('answers /api and /auth only on the configured origin outside dev', async () => {
    const staging = new Browser(envIn('staging'));
    const elsewhere = await staging.get('https://brickplace-gateway.example.workers.dev/api/me');
    expect(elsewhere.status).toBe(421);
    expect(await errorOf(elsewhere)).toBe('host');
    const start = await staging.postForm(
      'https://brickplace-gateway.example.workers.dev/auth/google/start',
      {},
    );
    expect(start.status).toBe(421);
    expect((await staging.get('/api/me')).status).toBe(200);
    // Dev serves whatever host it runs on (localhost, a LAN address).
    const dev = new Browser(envIn('dev'));
    expect((await dev.get('http://192.168.1.20:8787/api/me')).status).toBe(200);
  });
});
