// Teams: creating, joining, switching, leaving, closing, ranking (ADR 0020).
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { forgetWordList, WORD_LIST_KEY } from '../src/nickname.ts';
import { forgetSeasons } from '../src/seasons.ts';
import {
  CLOSED_TEAM_NAME,
  CREATE_EVERY_MS,
  creatableAt,
  JOIN_EVERY_MS,
  joinableAt,
  type Place,
  RANKED_CANVAS,
  RANKING_SIZE,
  ranking,
  STANDINGS_READ,
  teamDetail,
} from '../src/teams.ts';
import { keyRing, unseal } from '../src/token.ts';
import { attachmentsAfter, Browser, devSignIn, envIn, ORIGIN } from './support.ts';

const testEnv = env as unknown as Env;
const db = testEnv.ACCOUNTS;
const SESSION_COOKIE = '__Host-bp_session';
const DAY = 24 * 60 * 60 * 1000;
let count = 0;
const fresh = (prefix: string) => `${prefix}-${Date.now()}-${++count}`;
/** A name no other test uses: letters and digits, at most 20 characters. */
const unique = (prefix: string) => `${prefix}${Date.now() % 1_000_000}x${++count}`;

beforeEach(async () => {
  forgetWordList();
  await testEnv.MODERATION.put(WORD_LIST_KEY, '# test list\nbadword\n');
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

interface MeView {
  user: {
    team: { id: number; name: string; color: number; owner: boolean } | null;
    teamJoinableAt: number;
    teamCreatableAt: number;
  };
}

async function sessionOf(browser: Browser) {
  const ring = (await keyRing(testEnv.SESSION_KEYS))!;
  return (await unseal<{ u: string; t?: number }>(
    ring,
    'session',
    browser.cookies.get(SESSION_COOKIE),
  ))!;
}

/** A signed-in player in dev (no Origin checks), with a nickname unless `nickname` is false. */
async function player(prefix = 'P', nickname = true): Promise<Player> {
  const browser = new Browser(envIn('dev'));
  await devSignIn(browser, fresh('t'));
  const { csrf } = await browser.me();
  const name = unique(prefix);
  if (nickname) {
    const chosen = await browser.postJson(
      '/api/nickname',
      { nickname: name },
      { 'X-CSRF-Token': csrf! },
    );
    expect(chosen.status).toBe(200);
  }
  return { browser, csrf: csrf!, nickname: name, id: (await sessionOf(browser)).u };
}

const post = (who: Player, path: string, body: unknown = {}) =>
  who.browser.postJson(path, body, { 'X-CSRF-Token': who.csrf });

const create = (who: Player, name: string, color = 16) => post(who, '/api/teams', { name, color });
const join = (who: Player, team: number) => post(who, `/api/teams/${team}/join`);
const leave = (who: Player) => post(who, '/api/teams/leave');
const errorOf = async (response: Response) => ((await response.json()) as { error?: string }).error;

async function createdTeam(who: Player, name = unique('Team')): Promise<number> {
  const response = await create(who, name);
  expect(response.status).toBe(201);
  return ((await response.json()) as MeView).user.team!.id;
}

/** Moves an account's team clocks back, as if `ms` had passed. */
async function age(who: Player, ms: number) {
  await db
    .prepare(
      'UPDATE team_players SET joined_at = joined_at - ?, created_team_at = created_team_at - ? ' +
        'WHERE user_id = ?',
    )
    .bind(ms, ms, who.id)
    .run();
}

const detail = async (id: number) =>
  (
    (await (await new Browser(envIn('dev')).get(`/api/teams/${id}`)).json()) as {
      team: { members: number; closedAt: number | null; owner: string | null; rank: number | null };
    }
  ).team;

describe('creating a team', () => {
  it('makes the creator its owner and member, and puts the team in the session token', async () => {
    const owner = await player('Own');
    const name = unique('Brick_Crew');
    const response = await create(owner, name, 7);
    expect(response.status).toBe(201);
    const me = (await response.json()) as MeView;
    expect(me.user.team).toMatchObject({ name, color: 7, owner: true });
    const now = Date.now();
    expect(me.user.teamCreatableAt).toBeGreaterThan(now + CREATE_EVERY_MS - 60_000);
    expect(me.user.teamJoinableAt).toBeGreaterThan(now + JOIN_EVERY_MS - 60_000);
    expect((await sessionOf(owner.browser)).t).toBe(me.user.team!.id);

    // The socket plays for the team the token names.
    const client = `team-${count}-${now % 100000}`;
    const socket = await owner.browser.get(`/ws?client=${client}`, { Upgrade: 'websocket' });
    const attached = (await attachmentsAfter(socket)).find((a) => a.client === client);
    expect(attached).toMatchObject({ player: owner.id, team: me.user.team!.id });

    expect(await detail(me.user.team!.id)).toMatchObject({
      members: 1,
      owner: owner.nickname,
      closedAt: null,
    });
  });

  it('checks the name, the colour, the word list, the nickname and CSRF', async () => {
    const someone = await player('Chk');
    expect(await errorOf(await create(someone, 'ab'))).toBe('too_short');
    expect(await errorOf(await create(someone, 'has space'))).toBe('characters');
    expect(await errorOf(await create(someone, 'x'.repeat(21)))).toBe('too_long');
    expect(await errorOf(await create(someone, 'B4dW0rd_team'))).toBe('blocked');
    expect(await errorOf(await create(someone, unique('Ok'), 32))).toBe('color');
    expect(await errorOf(await create(someone, unique('Ok'), 1.5))).toBe('color');
    const noCsrf = await someone.browser.postJson('/api/teams', { name: unique('Ok'), color: 1 });
    expect(noCsrf.status).toBe(403);
    const watcher = await player('Wat', false);
    expect(await errorOf(await create(watcher, unique('Ok')))).toBe('no_nickname');
    // Outside dev, another site's Origin is refused.
    const staging = new Browser(envIn('staging'));
    for (const [k, v] of someone.browser.cookies) staging.cookies.set(k, v);
    const { csrf } = await staging.me();
    const foreign = await staging.postJson(
      '/api/teams',
      { name: unique('Ok'), color: 1 },
      { 'X-CSRF-Token': csrf!, Origin: 'https://evil.test' },
    );
    expect(await errorOf(foreign)).toBe('origin');
    const same = await staging.postJson(
      '/api/teams',
      { name: unique('Ok'), color: 1 },
      { 'X-CSRF-Token': csrf!, Origin: ORIGIN },
    );
    expect(same.status).toBe(201);
  });

  it('keeps names unique among open teams, in any letter case', async () => {
    const first = await player('Uq');
    const second = await player('Uq');
    const name = unique('Same');
    const id = await createdTeam(first, name);
    expect(await errorOf(await create(second, name.toUpperCase()))).toBe('taken');
    // Once the team closes, its name is free again.
    expect((await leave(first)).status).toBe(200);
    expect((await detail(id)).closedAt).not.toBeNull();
    expect((await create(second, name.toLowerCase())).status).toBe(201);
  });

  it('keeps team names and nicknames apart, both ways and in any letter case', async () => {
    const someone = await player('Nick');
    const founder = await player('Fnd');
    // A team named after a player, whatever the case, its own owner's nickname included.
    expect(await errorOf(await create(founder, someone.nickname.toUpperCase()))).toBe('taken');
    expect(await errorOf(await create(founder, founder.nickname.toLowerCase()))).toBe('taken');
    // Nothing was made: the next try with a free name goes through at once.
    const name = unique('Crew');
    const id = await createdTeam(founder, name);
    // A player named after an open team, whatever the case, at first choice and on a rename.
    const newcomer = await player('New', false);
    const first = await post(newcomer, '/api/nickname', { nickname: name.toLowerCase() });
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toBe('taken');
    await db
      .prepare('UPDATE users SET nickname_changed_at = 0 WHERE id = ?')
      .bind(someone.id)
      .run();
    expect(
      await errorOf(await post(someone, '/api/nickname', { nickname: name.toUpperCase() })),
    ).toBe('taken');
    // Once the team closes its name is a plain name again.
    expect((await leave(founder)).status).toBe(200);
    expect((await detail(id)).closedAt).not.toBeNull();
    expect((await post(newcomer, '/api/nickname', { nickname: name })).status).toBe(200);
    // Placeholders stay reserved both ways (ADR 0023).
    expect(await errorOf(await post(someone, '/api/nickname', { nickname: 'team_12' }))).toBe(
      'blocked',
    );
  });

  it('allows one creation per 7 days, and one team owned at a time', async () => {
    const owner = await player('Wk');
    await createdTeam(owner);
    // Owning a team: no second one.
    expect(await errorOf(await create(owner, unique('Two')))).toBe('owner');
    expect((await leave(owner)).status).toBe(200);
    const early = await create(owner, unique('Two'));
    expect(early.status).toBe(429);
    const { retryAt } = (await early.json()) as { retryAt: number };
    expect(retryAt).toBeGreaterThan(Date.now() + CREATE_EVERY_MS - 60_000);
    // 3 days on, joining would be allowed, creating not yet.
    await age(owner, JOIN_EVERY_MS);
    expect((await create(owner, unique('Two'))).status).toBe(429);
    await age(owner, CREATE_EVERY_MS - JOIN_EVERY_MS);
    expect((await create(owner, unique('Two'))).status).toBe(201);
  });
});

describe('joining, switching and leaving', () => {
  it('lets a player switch at most every 3 days', async () => {
    const a = await createdTeam(await player('Ta'));
    const b = await createdTeam(await player('Tb'));
    const member = await player('Mem');
    // The first join is at once.
    const joined = await join(member, a);
    expect(joined.status).toBe(200);
    expect(((await joined.json()) as MeView).user.team).toMatchObject({ id: a, owner: false });
    expect((await sessionOf(member.browser)).t).toBe(a);
    expect((await detail(a)).members).toBe(2);
    // Joining the team one is in changes nothing.
    expect((await join(member, a)).status).toBe(200);
    const early = await join(member, b);
    expect(early.status).toBe(429);
    expect(((await early.json()) as { retryAt: number }).retryAt).toBeGreaterThan(Date.now());
    // Leaving does not reset the wait.
    expect((await leave(member)).status).toBe(200);
    expect((await sessionOf(member.browser)).t).toBeUndefined();
    expect(await errorOf(await join(member, b))).toBe('too_soon');
    await age(member, JOIN_EVERY_MS);
    expect((await join(member, b)).status).toBe(200);
    expect((await sessionOf(member.browser)).t).toBe(b);
    expect((await detail(a)).members).toBe(1);
  });

  it('closes the team when its owner leaves; members may join another at once', async () => {
    const owner = await player('Cls');
    const team = await createdTeam(owner);
    const other = await createdTeam(await player('Oth'));
    const member = await player('Mbr');
    expect((await join(member, team)).status).toBe(200);
    // An owner cannot switch away: leaving closes the team, so it must be on purpose.
    expect(await errorOf(await join(owner, other))).toBe('owner');
    const left = await leave(owner);
    expect(((await left.json()) as MeView).user.team).toBeNull();
    expect(await detail(team)).toMatchObject({ members: 0, owner: null });
    expect(await errorOf(await join(member, team))).toBe('closed');
    // The member's next renewal drops the closed team from their token...
    expect((await sessionOf(member.browser)).t).toBe(team);
    const me = (await member.browser.me()) as unknown as MeView;
    expect(me.user.team).toBeNull();
    expect((await sessionOf(member.browser)).t).toBeUndefined();
    // ...and their wait does not apply after a closure...
    expect(me.user.teamJoinableAt).toBe(0);
    expect((await join(member, other)).status).toBe(200);
    // ...but the owner's own does.
    expect(await errorOf(await join(owner, other))).toBe('too_soon');
    expect(await errorOf(await join(member, 999_999_999))).toBe('closed');
  });

  it('counts the waits from the last join, for joining and creating alike', () => {
    const base: Place = {
      team_id: null,
      joined_at: null,
      created_team_at: null,
      free_join: 0,
      name: null,
      color: null,
      owner_id: null,
      name_reset_at: null,
    };
    expect(joinableAt(null)).toBe(0);
    expect(creatableAt(null)).toBe(0);
    expect(joinableAt({ ...base, joined_at: 1_000 })).toBe(1_000 + JOIN_EVERY_MS);
    expect(joinableAt({ ...base, joined_at: 1_000, free_join: 1 })).toBe(0);
    expect(creatableAt({ ...base, joined_at: 1_000, created_team_at: 500 })).toBe(
      500 + CREATE_EVERY_MS,
    );
    expect(creatableAt({ ...base, joined_at: 9 * DAY, created_team_at: 500 })).toBe(
      9 * DAY + JOIN_EVERY_MS,
    );
  });
});

describe('teams and account deletion', () => {
  const remove = (who: Player) =>
    who.browser.postJson(
      '/api/account/delete',
      { confirm: who.nickname },
      { 'X-CSRF-Token': who.csrf },
    );

  it('closes the team of an owner who deletes their account, and frees its members', async () => {
    const owner = await player('Del');
    const team = await createdTeam(owner);
    const member = await player('Dm');
    expect((await join(member, team)).status).toBe(200);
    expect((await remove(owner)).status).toBe(200);
    expect(await detail(team)).toMatchObject({ closedAt: expect.any(Number), owner: null });
    const me = (await member.browser.me()) as unknown as MeView;
    expect(me.user.team).toBeNull();
    expect(me.user.teamJoinableAt).toBe(0);
    const owned = await db
      .prepare('SELECT COUNT(*) AS n FROM teams WHERE owner_id = ?')
      .bind(owner.id)
      .first<{ n: number }>();
    expect(owned!.n).toBe(0);
  });

  it('removes a member who deletes their account', async () => {
    const team = await createdTeam(await player('Keep'));
    const member = await player('Gone');
    expect((await join(member, team)).status).toBe(200);
    expect((await detail(team)).members).toBe(2);
    expect((await remove(member)).status).toBe(200);
    expect((await detail(team)).members).toBe(1);
    const rows = await db
      .prepare('SELECT COUNT(*) AS n FROM team_players WHERE user_id = ?')
      .bind(member.id)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('puts the team in the data download', async () => {
    const owner = await player('Exp');
    const name = unique('Export');
    await createdTeam(owner, name);
    const response = await post(owner, '/api/account/export');
    const data = (await response.json()) as { team: Record<string, unknown> };
    expect(data.team).toMatchObject({ teamName: name, teamOwner: 1 });
    expect(data.team.joinedAt).toEqual(expect.any(String));
  });
});

describe('ranking and lists', () => {
  async function stand(team: number, cells: number, built = cells) {
    await testEnv.STANDINGS.prepare(
      'INSERT OR REPLACE INTO team_standings (canvas, team_id, cells, built, cleared, ' +
        'shields, updated_at) VALUES (?, ?, ?, ?, 2, 3, ?)',
    )
      .bind(RANKED_CANVAS, team, cells, built, 1_000 + cells)
      .run();
  }
  const rankingKey = new Request(`${ORIGIN}/api/teams/ranking?canvas=${RANKED_CANVAS}`);

  it('ranks open teams by cells standing, ties sharing a rank, and caches the answer', async () => {
    await (caches as unknown as { default: Cache }).default.delete(rankingKey);
    const big = unique('Big');
    const ids = {
      big: await createdTeam(await player('R1'), big),
      tieA: await createdTeam(await player('R2')),
      tieB: await createdTeam(await player('R3')),
    };
    const closer = await player('R4');
    const closed = await createdTeam(closer);
    await stand(ids.big, 9_000_000);
    await stand(ids.tieA, 8_000_000, 10);
    await stand(ids.tieB, 8_000_000, 20);
    await stand(closed, 8_500_000);
    await leave(closer);

    const browser = new Browser(envIn('dev'));
    const response = await browser.get('/api/teams/ranking');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=30, s-maxage=60');
    const body = (await response.json()) as {
      canvas: string;
      updatedAt: number;
      teams: { id: number; rank: number; name: string; cells: number; members: number }[];
    };
    expect(body.canvas).toBe(RANKED_CANVAS);
    const top = body.teams.slice(0, 3);
    expect(top.map((t) => [t.id, t.rank])).toEqual([
      [ids.big, 1],
      [ids.tieB, 2],
      [ids.tieA, 2],
    ]);
    expect(top[0]).toMatchObject({ name: big, cells: 9_000_000, members: 1, built: 9_000_000 });
    expect(body.teams.some((t) => t.id === closed)).toBe(false);
    expect(body.updatedAt).toBeGreaterThanOrEqual(1_000 + 9_000_000);
    expect(await detail(ids.tieA)).toMatchObject({ rank: 2 });
    expect(await detail(closed)).toMatchObject({ rank: null });

    // Served from the edge cache until it expires.
    await stand(ids.tieA, 9_500_000);
    const cached = (await (await browser.get('/api/teams/ranking')).json()) as typeof body;
    expect(cached.teams[0]!.id).toBe(ids.big);
    await (caches as unknown as { default: Cache }).default.delete(rankingKey);
    const next = (await (await browser.get('/api/teams/ranking')).json()) as typeof body;
    expect(next.teams[0]!.id).toBe(ids.tieA);
    expect((await browser.postJson('/api/teams/ranking', {})).status).toBe(405);
  });

  it("ranks a past season's teams from its own canvas, and no season that has not started", async () => {
    const pastName = unique('Past');
    const team = await createdTeam(await player('R9'), pastName);
    // The season's winner, closed since: it keeps its place in that season's ranking.
    const closer = await player('R10');
    const goneName = unique('Gone');
    const gone = await createdTeam(closer, goneName);
    await leave(closer);
    const now = Date.now();
    await db
      .prepare(
        'INSERT INTO seasons (id, canvas, starts_at, ends_at, created_at) VALUES ' +
          '(?, ?, ?, ?, 0), (?, ?, ?, ?, 0), (?, ?, ?, ?, 0)',
      )
      .bind(
        951,
        'rank-past',
        now - 20 * DAY,
        now - 13 * DAY,
        953,
        'rank-now',
        now - DAY,
        now + DAY,
        952,
        'rank-later',
        now + 2 * DAY,
        now + 8 * DAY,
      )
      .run();
    forgetSeasons();
    try {
      const stand = (canvas: string, id: number, cells: number) =>
        testEnv.STANDINGS.prepare(
          'INSERT INTO team_standings (canvas, team_id, cells, built, cleared, shields, ' +
            'updated_at) VALUES (?, ?, ?, 50, 1, 2, 7)',
        )
          .bind(canvas, id, cells)
          .run();
      await stand('rank-past', team, 40);
      await stand('rank-past', gone, 90);
      await stand('rank-now', team, 40);
      await stand('rank-now', gone, 90);
      const browser = new Browser(envIn('dev'));
      const response = await browser.get('/api/teams/ranking?season=951');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        canvas: string;
        over?: boolean;
        teams: { id: number; rank: number; name: string; closed: boolean; members: number }[];
      };
      expect(body.canvas).toBe('rank-past');
      expect(body.over).toBe(true);
      expect(body.teams.map((t) => [t.id, t.rank, t.closed])).toEqual([
        [gone, 1, true],
        [team, 2, false],
      ]);
      expect(body.teams[0]!.members).toBe(0);
      // No report or reset reaches a closed team's name: it is not shown.
      expect(body.teams.map((t) => t.name)).toEqual([CLOSED_TEAM_NAME, pastName]);
      expect(JSON.stringify(body)).not.toContain(goneName);
      // Nor on its own page, which the ranking's id leads to.
      const page = await (await browser.get(`/api/teams/${gone}`)).text();
      expect(page).not.toContain(goneName);
      expect(JSON.parse(page)).toMatchObject({ team: { name: CLOSED_TEAM_NAME } });
      expect((await detail(team)) as unknown).toMatchObject({ name: pastName });
      // A season under way, asked by id: closed teams drop out, as in the live ranking.
      const live = (await (await browser.get('/api/teams/ranking?season=953')).json()) as {
        over?: boolean;
        teams: { id: number; closed: boolean }[];
      };
      expect(live.over).toBeUndefined();
      expect(live.teams.map((t) => [t.id, t.closed])).toEqual([[team, false]]);
      // Not started yet, never registered, or not a season id at all.
      for (const season of ['952', '9999', '0', '-1', '1.5', 'x', '']) {
        expect((await browser.get(`/api/teams/ranking?season=${season}`)).status, season).toBe(404);
      }
    } finally {
      await db.prepare('DELETE FROM seasons WHERE id IN (951, 952, 953)').run();
      forgetSeasons();
    }
  });

  it('ranks open teams behind more closed ones than one page holds, reading only rows ahead for a rank', async () => {
    // A canvas of its own: nothing else stands on it.
    const canvas = fresh('crowded').toLowerCase();
    const tag = unique('gone');
    const closedCount = STANDINGS_READ + 50;
    await db
      .prepare(
        'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2) ' +
          'INSERT INTO teams (name, name_key, color, owner_id, created_at, closed_at) ' +
          "SELECT ?1 || 'x' || i, lower(?1) || 'x' || i, 3, NULL, 1, 2 FROM n",
      )
      .bind(tag, closedCount)
      .run();
    const { results: gone } = await db
      .prepare('SELECT id FROM teams WHERE name_key LIKE ?')
      .bind(`${tag.toLowerCase()}x%`)
      .all<{ id: number }>();
    expect(gone).toHaveLength(closedCount);
    // Every closed team stands above the open ones but the first.
    await testEnv.STANDINGS.prepare(
      'INSERT INTO team_standings (canvas, team_id, cells, built, cleared, shields, updated_at) ' +
        'SELECT ?, value, 1000000 + key, 0, 0, 0, 1 FROM json_each(?)',
    )
      .bind(canvas, JSON.stringify(gone.map((g) => g.id)))
      .run();
    const open = {
      top: await createdTeam(await player('C1')),
      a: await createdTeam(await player('C2')),
      b: await createdTeam(await player('C3')),
      c: await createdTeam(await player('C4')),
    };
    const put = (team: number, cells: number, built: number) =>
      testEnv.STANDINGS.prepare(
        'INSERT INTO team_standings (canvas, team_id, cells, built, cleared, shields, ' +
          'updated_at) VALUES (?, ?, ?, ?, 0, 0, 1)',
      )
        .bind(canvas, team, cells, built)
        .run();
    await put(open.top, 2_000_000, 1);
    await put(open.a, 500, 5);
    await put(open.b, 400, 5);
    await put(open.c, 400, 9);

    const ranked = await ranking(db, testEnv.STANDINGS, canvas);
    expect(ranked.teams.map((t) => [t.id, t.rank])).toEqual([
      [open.top, 1],
      [open.a, 2],
      [open.c, 3],
      [open.b, 3],
    ]);
    for (const [id, rank] of ranked.teams.map((t) => [t.id, t.rank] as const)) {
      expect((await teamDetail(db, testEnv.STANDINGS, canvas, id))?.rank).toBe(rank);
    }
    expect((await teamDetail(db, testEnv.STANDINGS, canvas, gone[0]!.id))?.rank).toBeNull();

    // The top team's rank reads its own standing and nothing ahead of it.
    let rows = 0;
    const count = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === 'bind') return (...values: unknown[]) => count(target.bind(...values));
          if (key === 'all' || key === 'first') {
            return async () => {
              const result = await (key === 'all' ? target.all() : target.first());
              rows += key === 'all' ? (result as D1Result).results.length : result ? 1 : 0;
              return result;
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const counted = new Proxy(testEnv.STANDINGS, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => count(target.prepare(sql));
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect((await teamDetail(db, counted, canvas, open.top))?.rank).toBe(1);
    expect(rows).toBe(1);
  });

  /** `count` teams made straight in D1 (open ones with an owner each), ids in order. */
  async function seedTeams(count: number, open: boolean): Promise<number[]> {
    const tag = unique('seed').toLowerCase();
    if (open) {
      await db
        .prepare(
          'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2) ' +
            'INSERT INTO users (id, created_at, signed_in_at) ' +
            "SELECT ?1 || 'u' || i, 1, 1 FROM n",
        )
        .bind(tag, count)
        .run();
    }
    await db
      .prepare(
        'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2) ' +
          'INSERT INTO teams (name, name_key, color, owner_id, created_at, closed_at) ' +
          "SELECT ?1 || 't' || i, ?1 || 't' || i, 3, " +
          `${open ? "?1 || 'u' || i" : 'NULL'}, 1, ${open ? 'NULL' : '2'} FROM n`,
      )
      .bind(tag, count)
      .run();
    const { results } = await db
      .prepare("SELECT id FROM teams WHERE name_key LIKE ? || 't%' ORDER BY id")
      .bind(tag)
      .all<{ id: number }>();
    expect(results).toHaveLength(count);
    return results.map((r) => r.id);
  }

  /** Standings on `canvas`: [team, cells, built] each. */
  async function standAll(canvas: string, rows: readonly (readonly [number, number, number])[]) {
    await testEnv.STANDINGS.prepare(
      'INSERT INTO team_standings (canvas, team_id, cells, built, cleared, shields, updated_at) ' +
        "SELECT ?, value ->> '$[0]', value ->> '$[1]', value ->> '$[2]', 0, 0, 1 " +
        'FROM json_each(?)',
    )
      .bind(canvas, JSON.stringify(rows))
      .run();
  }

  const rankOf = async (canvas: string, id: number, pages?: number) =>
    (await teamDetail(db, testEnv.STANDINGS, canvas, id, pages))?.rank;

  it('cuts the ranking at 100 inside a tie on cells and built, and the detail agrees', async () => {
    const canvas = fresh('cut').toLowerCase();
    const ids = await seedTeams(RANKING_SIZE + 1, true);
    // 98 teams with cells of their own, then three tied on cells and built: id decides.
    await standAll(
      canvas,
      ids.map((id, i): [number, number, number] => (i < 98 ? [id, 10_000 - i, 0] : [id, 500, 7])),
    );
    // Closed teams above and inside the tie take no place.
    const gone = await seedTeams(3, false);
    await standAll(canvas, [
      [gone[0]!, 20_000, 0],
      [gone[1]!, 500, 7],
      [gone[2]!, 500, 9],
    ]);
    const ranked = await ranking(db, testEnv.STANDINGS, canvas);
    expect(ranked.teams).toHaveLength(RANKING_SIZE);
    expect(ranked.teams.slice(96).map((t) => [t.id, t.rank])).toEqual([
      [ids[96], 97],
      [ids[97], 98],
      [ids[98], 99],
      [ids[99], 99],
    ]);
    expect(ranked.teams.some((t) => t.id === ids[100])).toBe(false);
    // The detail gives each the ranking's rank, and none to the 101st.
    for (const at of [0, 97, 98, 99]) {
      expect(await rankOf(canvas, ids[at]!)).toBe(ranked.teams[at]!.rank);
    }
    expect(await rankOf(canvas, ids[100]!)).toBeNull();
    expect(await rankOf(canvas, gone[1]!)).toBeNull();
  });

  it('gives no rank when the pages run out before the team, as the ranking leaves it out', async () => {
    const canvas = fresh('pages').toLowerCase();
    // A full page of closed teams above the only open one.
    const gone = await seedTeams(STANDINGS_READ, false);
    const [open] = await seedTeams(1, true);
    await standAll(canvas, [...gone.map((id, i) => [id, 1_000 + i, 0] as const), [open!, 5, 0]]);
    expect((await ranking(db, testEnv.STANDINGS, canvas, 1)).teams).toEqual([]);
    expect(await rankOf(canvas, open!, 1)).toBeNull();
    // One page more reaches it.
    expect((await ranking(db, testEnv.STANDINGS, canvas, 2)).teams.map((t) => t.id)).toEqual([
      open,
    ]);
    expect(await rankOf(canvas, open!, 2)).toBe(1);
    expect(await rankOf(canvas, open!)).toBe(1);
  });

  it('finds open teams by name prefix, in any letter case', async () => {
    const prefix = unique('Find');
    const open = await createdTeam(await player('F1'), `${prefix}_one`);
    const closer = await player('F2');
    const gone = await createdTeam(closer, `${prefix}_two`);
    await leave(closer);
    const browser = new Browser(envIn('dev'));
    const found = (await (await browser.get(`/api/teams?q=${prefix.toUpperCase()}`)).json()) as {
      teams: { id: number }[];
    };
    expect(found.teams.map((t) => t.id)).toEqual([open]);
    expect(found.teams.some((t) => t.id === gone)).toBe(false);
    // The unfiltered list is the same for everyone: cached like the ranking.
    const all = await browser.get('/api/teams');
    expect(all.headers.get('Cache-Control')).toBe('public, max-age=30, s-maxage=60');
    const odd = (await (await browser.get('/api/teams?q=%25')).json()) as { teams: unknown[] };
    expect(odd.teams).toEqual([]);
    expect((await browser.get('/api/teams/123456789012')).status).toBe(404);
  });
});
