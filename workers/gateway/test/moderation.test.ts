// What moderation (ADR 0023) changes on the gateway: team-name reports, a reset nickname or
// team name chosen again, reserved placeholders, and account deletion closing open sockets.
import { env } from 'cloudflare:workers';
import {
  fanoutName,
  KICKED,
  PLAYER_HEADER,
  SESSION_TOKEN_TTL_MS,
  UNTIL_HEADER,
} from '@brickplace/realtime/player';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { forgetWordList, suggestNickname, WORD_LIST_KEY } from '../src/nickname.ts';
import { forgetReportLimit, REPORT_LIMIT_KEY } from '../src/reports.ts';
import { SESSION_TTL_MS } from '../src/session.ts';
import { keyRing, unseal } from '../src/token.ts';
import { Browser, devSignIn, envIn } from './support.ts';

const testEnv = env as unknown as Env;
const db = testEnv.ACCOUNTS;
const SESSION_COOKIE = '__Host-bp_session';
let count = 0;
const fresh = (prefix: string) => `${prefix}-${Date.now()}-${++count}`;
const unique = (prefix: string) => `${prefix}${Date.now() % 1_000_000}x${++count}`;

beforeEach(async () => {
  forgetWordList();
  forgetReportLimit();
  await testEnv.MODERATION.put(WORD_LIST_KEY, '# test list\nbadword\n');
  await testEnv.MODERATION.put(REPORT_LIMIT_KEY, '10');
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Player {
  browser: Browser;
  csrf: string;
  nickname: string;
  id: string;
}

async function sessionOf(browser: Browser) {
  const ring = (await keyRing(testEnv.SESSION_KEYS))!;
  return (await unseal<{ u: string; n: number }>(
    ring,
    'session',
    browser.cookies.get(SESSION_COOKIE),
  ))!;
}

/** A signed-in player in dev (no Origin checks), with a nickname. */
async function player(prefix = 'P'): Promise<Player> {
  const browser = new Browser(envIn('dev'));
  await devSignIn(browser, fresh('m'));
  const { csrf } = await browser.me();
  const nickname = unique(prefix);
  const chosen = await browser.postJson('/api/nickname', { nickname }, { 'X-CSRF-Token': csrf! });
  expect(chosen.status).toBe(200);
  return { browser, csrf: csrf!, nickname, id: (await sessionOf(browser)).u };
}

const post = (who: Player, path: string, body: unknown = {}) =>
  who.browser.postJson(path, body, { 'X-CSRF-Token': who.csrf });

const errorOf = async (response: Response) => ((await response.json()) as { error?: string }).error;

async function teamOf(owner: Player): Promise<number> {
  const created = await post(owner, '/api/teams', { name: unique('Team'), color: 4 });
  expect(created.status).toBe(201);
  const me = (await created.json()) as { user: { team: { id: number } } };
  return me.user.team.id;
}

describe('moderation on the gateway', () => {
  it('agrees with realtime on how long a token plays, which kicks depend on', () => {
    expect(SESSION_TOKEN_TTL_MS).toBe(SESSION_TTL_MS);
  });

  it('never suggests a reserved placeholder as a first nickname', () => {
    expect(suggestNickname('Player_12')).toBe('');
    expect(suggestNickname('team 4')).toBe('team4');
    expect(suggestNickname('team_4x')).toBe('');
  });

  it("reports a team's name, once per reporter while open, never one's own team", async () => {
    const owner = await player('Own');
    const reporter = await player('Rep');
    const team = await teamOf(owner);
    const filed = await post(reporter, '/api/reports', { team, reason: 'team_name' });
    expect(filed.status).toBe(201);
    const row = await db
      .prepare(
        'SELECT target_id, target_team_id, target_nickname, reason, status FROM reports ' +
          'WHERE reporter_id = ?',
      )
      .bind(reporter.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      target_id: null,
      target_team_id: team,
      reason: 'team_name',
      status: 'open',
    });
    expect(row!.target_nickname).toMatch(/^Team/);
    expect(await errorOf(await post(reporter, '/api/reports', { team, reason: 'team_name' }))).toBe(
      'already_reported',
    );
    // A team is reported for its name only, and a nickname never for `team_name`.
    expect(await errorOf(await post(reporter, '/api/reports', { team, reason: 'hateful' }))).toBe(
      'reason',
    );
    expect(
      await errorOf(
        await post(reporter, '/api/reports', { nickname: owner.nickname, reason: 'team_name' }),
      ),
    ).toBe('reason');
    expect(await errorOf(await post(owner, '/api/reports', { team, reason: 'team_name' }))).toBe(
      'self',
    );
    for (const missing of [999_999_999, 0, 'x']) {
      expect(
        await errorOf(await post(reporter, '/api/reports', { team: missing, reason: 'team_name' })),
      ).toBe('not_found');
    }
    // Reporting the owner's nickname is a separate report.
    expect(
      (await post(reporter, '/api/reports', { nickname: owner.nickname, reason: 'offensive' }))
        .status,
    ).toBe(201);
  });

  it('lets a reset account watch until it picks a name, without the 30-day wait', async () => {
    const target = await player('Reset');
    // What the admin Worker's reset does (workers/admin/src/moderation.ts).
    await db
      .prepare(
        'UPDATE users SET nickname_reset_key = nickname_key, ' +
          "nickname = 'player_' || rowid, nickname_key = 'player_' || rowid, " +
          'nickname_reset_at = ? WHERE id = ?',
      )
      .bind(Date.now(), target.id)
      .run();
    const placeholder = await db
      .prepare('SELECT nickname FROM users WHERE id = ?')
      .bind(target.id)
      .first<{ nickname: string }>();
    // The placeholder names nobody: it cannot be reported.
    const reporter = await player('Rep');
    expect(
      await errorOf(
        await post(reporter, '/api/reports', {
          nickname: placeholder!.nickname,
          reason: 'offensive',
        }),
      ),
    ).toBe('not_found');
    // Renewed as an account without a nickname: its sockets watch until it chooses one.
    await target.browser.me();
    const me = await target.browser.me();
    expect(me.user!.nickname).toBeNull();
    expect(me.user!.nicknameChangeableAt).toBeNull();
    expect((await sessionOf(target.browser)).n).toBe(0);
    // Placeholders are nobody's choice.
    for (const reserved of ['player_12', 'Team_3', 'PLAYER_1abc']) {
      expect(
        await errorOf(await post(target, '/api/nickname', { nickname: reserved })),
        reserved,
      ).toBe('blocked');
    }
    // Nor is the name the moderator removed, in any letter case.
    expect(
      await errorOf(
        await post(target, '/api/nickname', { nickname: target.nickname.toUpperCase() }),
      ),
    ).toBe('blocked');
    // The last change was moments ago, and still the new choice goes through.
    const next = unique('Fresh');
    const chosen = await post(target, '/api/nickname', { nickname: next });
    expect(chosen.status).toBe(200);
    expect(((await chosen.json()) as { user: { nickname: string } }).user.nickname).toBe(next);
    expect((await sessionOf(target.browser)).n).toBe(1);
    // ...and the 30-day limit applies again after it.
    expect(await errorOf(await post(target, '/api/nickname', { nickname: unique('Again') }))).toBe(
      'too_soon',
    );
  });

  it("lets a team's owner rename it only after a moderator reset its name", async () => {
    const owner = await player('Own');
    const team = await teamOf(owner);
    expect(await errorOf(await post(owner, '/api/teams/rename', { name: unique('New') }))).toBe(
      'not_reset',
    );
    // Placeholders are nobody's choice for a new team either.
    const founder = await player('Fou');
    expect(await errorOf(await post(founder, '/api/teams', { name: 'team_42', color: 1 }))).toBe(
      'blocked',
    );
    const old = await db
      .prepare('SELECT name FROM teams WHERE id = ?')
      .bind(team)
      .first<{ name: string }>();
    // What the admin Worker's reset does (workers/admin/src/moderation.ts).
    await db
      .prepare(
        "UPDATE teams SET name_reset_key = name_key, name = 'team_' || id, " +
          "name_key = 'team_' || id, name_reset_at = ? WHERE id = ?",
      )
      .bind(Date.now(), team)
      .run();
    expect(
      await errorOf(await post(owner, '/api/teams/rename', { name: old!.name.toLowerCase() })),
    ).toBe('blocked');
    const me = (await owner.browser.me()) as unknown as {
      user: { team: { name: string; nameReset: boolean } };
    };
    expect(me.user.team).toMatchObject({ name: `team_${team}`, nameReset: true });
    // Its placeholder names nothing to report.
    const reporter = await player('Rep');
    expect(await errorOf(await post(reporter, '/api/reports', { team, reason: 'team_name' }))).toBe(
      'not_found',
    );
    expect(await errorOf(await post(owner, '/api/teams/rename', { name: 'team_7' }))).toBe(
      'blocked',
    );
    expect(await errorOf(await post(owner, '/api/teams/rename', { name: 'xbadwordx' }))).toBe(
      'blocked',
    );
    // Nor a player's nickname, in any letter case (ADR 0020).
    const named = await post(owner, '/api/teams/rename', { name: reporter.nickname.toUpperCase() });
    expect(named.status).toBe(409);
    expect(await errorOf(named)).toBe('taken');
    const member = await player('Mem');
    expect((await post(member, `/api/teams/${team}/join`)).status).toBe(200);
    expect(await errorOf(await post(member, '/api/teams/rename', { name: unique('Mine') }))).toBe(
      'not_reset',
    );
    const name = unique('Better');
    const renamed = await post(owner, '/api/teams/rename', { name });
    expect(renamed.status).toBe(200);
    expect(
      ((await renamed.json()) as { user: { team: { name: string; nameReset: boolean } } }).user
        .team,
    ).toMatchObject({ name, nameReset: false });
    expect(await errorOf(await post(owner, '/api/teams/rename', { name: unique('More') }))).toBe(
      'not_reset',
    );
  });

  it('tells a banned account it is suspended, and signs it out', async () => {
    const target = await player('Ban');
    const before = (await target.browser.me()) as unknown as Record<string, unknown>;
    expect(before.signedIn).toBe(true);
    expect(before).not.toHaveProperty('suspended');
    await db
      .prepare(
        "INSERT INTO bans (user_id, reason, created_by, created_at) VALUES (?, 'spam', 'test', ?)",
      )
      .bind(target.id, Date.now())
      .run();
    // The account is read once: the check says why it refused the session.
    let accountReads = 0;
    const counting = new Proxy(db, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key).bind(target);
        return (sql: string) => {
          if (/FROM users t WHERE id = \?/.test(sql)) accountReads++;
          return target.prepare(sql);
        };
      },
    });
    const copy = new Browser(envIn('dev', { ACCOUNTS: counting }));
    for (const [k, v] of target.browser.cookies) copy.cookies.set(k, v);
    const copied = (await (await copy.get('/api/me')).json()) as Record<string, unknown>;
    expect(copied).toMatchObject({ signedIn: false, suspended: true });
    expect(accountReads).toBe(1);
    const response = await target.browser.get('/api/me');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signedIn: false, user: null, suspended: true });
    // The cookie went with it: the next answer is a plain sign-out.
    const after = (await target.browser.me()) as unknown as Record<string, unknown>;
    expect(after.signedIn).toBe(false);
    expect(after).not.toHaveProperty('suspended');
  });

  it('answers a session ended by "sign out everywhere" as a plain sign-out, even once banned', async () => {
    const target = await player('Ended');
    const copy = new Browser(envIn('dev'));
    for (const [k, v] of target.browser.cookies) copy.cookies.set(k, v);
    const out = await post(target, '/auth/logout', { everywhere: true });
    expect(out.status).toBe(200);
    await db
      .prepare(
        "INSERT INTO bans (user_id, reason, created_by, created_at) VALUES (?, 'spam', 'test', ?)",
      )
      .bind(target.id, Date.now())
      .run();
    // The copied cookie was ended before the ban: it learns nothing about the account.
    const answer = (await (await copy.get('/api/me')).json()) as Record<string, unknown>;
    expect(answer).toMatchObject({ signedIn: false, user: null });
    expect(answer).not.toHaveProperty('suspended');
    expect(copy.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it('closes the open sockets of an account signed out everywhere at once', async () => {
    const me = await player('Away');
    const elsewhere = new Browser(envIn('dev'));
    for (const [k, v] of me.browser.cookies) elsewhere.cookies.set(k, v);
    const opened = await elsewhere.fetch('/ws', { headers: { Upgrade: 'websocket' } });
    expect(opened.status).toBe(101);
    const ws = opened.webSocket!;
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    ws.accept();
    const out = await post(me, '/auth/logout', { everywhere: true });
    expect(out.status).toBe(200);
    expect(await closed).toBe(KICKED);
  });

  it('kicks sockets on every shard there may be, whatever FANOUT_SHARDS says now', async () => {
    const me = await player('Shards');
    // A socket left on shard 37 from when FANOUT_SHARDS was higher (ADR 0028).
    const fanout = testEnv.FANOUT.get(testEnv.FANOUT.idFromName(fanoutName('canvas', 37)));
    const opened = await fanout.fetch('https://fanout/ws', {
      headers: {
        Upgrade: 'websocket',
        [PLAYER_HEADER]: me.id,
        [UNTIL_HEADER]: String(Date.now() + 20 * 60_000),
      },
    });
    expect(opened.status).toBe(101);
    const ws = opened.webSocket!;
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    ws.accept();
    const out = await post(me, '/auth/logout', { everywhere: true });
    expect(out.status).toBe(200);
    expect(await closed).toBe(KICKED);
  });

  it('still kicks on every other shard when one cannot be reached', async () => {
    const me = await player('ShardDown');
    const fanout = testEnv.FANOUT.get(testEnv.FANOUT.idFromName(fanoutName('canvas', 11)));
    const opened = await fanout.fetch('https://fanout/ws', {
      headers: {
        Upgrade: 'websocket',
        [PLAYER_HEADER]: me.id,
        [UNTIL_HEADER]: String(Date.now() + 20 * 60_000),
      },
    });
    const ws = opened.webSocket!;
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    ws.accept();
    const down = fanoutName('canvas', 4);
    const partlyDown = {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: (id: { name: string }) =>
        id.name === down
          ? {
              kick: async () => {
                throw new Error('shard unreachable');
              },
            }
          : testEnv.FANOUT.get(testEnv.FANOUT.idFromName(id.name)),
    } as unknown as Env['FANOUT'];
    const browser = new Browser(envIn('dev', { FANOUT: partlyDown }));
    for (const [k, v] of me.browser.cookies) browser.cookies.set(k, v);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await browser.postJson(
      '/auth/logout',
      { everywhere: true },
      {
        'X-CSRF-Token': me.csrf,
      },
    );
    expect(out.status).toBe(200);
    expect(await closed).toBe(KICKED);
  });

  it('closes the open sockets of a deleted account at once', async () => {
    const me = await player('Gone');
    const opened = await me.browser.fetch('/ws', { headers: { Upgrade: 'websocket' } });
    expect(opened.status).toBe(101);
    const ws = opened.webSocket!;
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    ws.accept();
    const deleted = await post(me, '/api/account/delete', { confirm: me.nickname });
    expect(deleted.status).toBe(200);
    expect(await closed).toBe(KICKED);
  });
});
