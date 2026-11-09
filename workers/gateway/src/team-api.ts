// Teams API (ADR 0020). Changes follow api.ts: POST, a same-site Origin and the session's
// CSRF token, and they answer with the account view and a token carrying the new team, so
// the page's next socket plays for it. Reads are public; the ranking is cached at the edge.

import { authorised, signedIn } from './api.ts';
import { type Context, json } from './http.ts';
import { blocked, checkShape, reservedName, wordList } from './nickname.ts';
import { seasonForWatching, startedSeason } from './seasons.ts';
import {
  creatableAt,
  createTeam,
  joinableAt,
  joinTeam,
  leaveTeam,
  listTeams,
  myTeam,
  placeOf,
  RANKED_CANVAS,
  ranking,
  renameTeam,
  TEAM_COLORS,
  teamDetail,
} from './teams.ts';

/** How long browsers and the edge keep the ranking (s): the canvas sends it once a minute. */
const RANKING_MAX_AGE = 30;
const RANKING_EDGE_AGE = 60;

/** A team search: what a name can hold, nothing else. */
const SEARCH = /^[A-Za-z0-9_]{0,20}$/;

/** POST /api/teams {name, color}: creates a team and moves the account into it. */
export async function createOwnTeam(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  const { session, user } = auth;
  if (user.nickname === null) return json({ error: 'no_nickname' }, 403);
  const body = (await ctx.request.json().catch(() => null)) as {
    name?: unknown;
    color?: unknown;
  } | null;
  // Team names follow the nickname rules (ADR 0016): ASCII letters, digits and _, 3–20.
  const checked = checkShape(body?.name);
  if (!checked.ok) return json({ error: checked.problem }, 400);
  const color = body?.color;
  if (typeof color !== 'number' || !Number.isInteger(color) || color < 0 || color >= TEAM_COLORS) {
    return json({ error: 'color' }, 400);
  }
  const db = ctx.env.ACCOUNTS;
  const place = await placeOf(db, user.id);
  if (myTeam(place, user.id)?.owner) return json({ error: 'owner' }, 409);
  const next = creatableAt(place);
  if (ctx.now < next) return json({ error: 'too_soon', retryAt: next }, 429);
  if (reservedName(checked.nickname)) return json({ error: 'blocked' }, 400);
  const list = await wordList(ctx.env.MODERATION, ctx.dev, ctx.now);
  if (!list) return json({ error: 'unavailable' }, 503);
  if (blocked(checked.nickname, list)) return json({ error: 'blocked' }, 400);
  const created = await createTeam(
    db,
    user.id,
    { name: checked.nickname, key: checked.key, color },
    ctx.now,
  );
  if (!created.ok) {
    if (created.reason === 'too_soon') {
      // Another request of this account won the race; its time is the one to wait from.
      return json({ error: 'too_soon', retryAt: creatableAt(await placeOf(db, user.id)) }, 429);
    }
    return json({ error: created.reason }, 409);
  }
  return signedIn(ctx, session, user, 201);
}

/**
 * POST /api/teams/rename {name}: the owner's new name for a team a moderator reset to its
 * placeholder (ADR 0023), checked like a new team's. Team names are otherwise fixed.
 */
export async function renameOwnTeam(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  const { session, user } = auth;
  const body = (await ctx.request.json().catch(() => null)) as { name?: unknown } | null;
  const checked = checkShape(body?.name);
  if (!checked.ok) return json({ error: checked.problem }, 400);
  if (reservedName(checked.nickname)) return json({ error: 'blocked' }, 400);
  const list = await wordList(ctx.env.MODERATION, ctx.dev, ctx.now);
  if (!list) return json({ error: 'unavailable' }, 503);
  if (blocked(checked.nickname, list)) return json({ error: 'blocked' }, 400);
  const renamed = await renameTeam(ctx.env.ACCOUNTS, user.id, {
    name: checked.nickname,
    key: checked.key,
  });
  if (renamed === 'taken') return json({ error: 'taken' }, 409);
  if (renamed === 'not_reset') return json({ error: 'not_reset' }, 409);
  if (renamed === 'blocked') return json({ error: 'blocked' }, 400);
  return signedIn(ctx, session, user);
}

/** POST /api/teams/:id/join: joins a team, leaving the current one (a switch). */
export async function joinOwnTeam(ctx: Context, team: number): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  const { session, user } = auth;
  if (user.nickname === null) return json({ error: 'no_nickname' }, 403);
  const db = ctx.env.ACCOUNTS;
  const result = await joinTeam(db, user.id, team, ctx.now);
  if (result === 'closed') return json({ error: 'closed' }, 404);
  if (result === 'owner') return json({ error: 'owner' }, 409);
  if (result === 'too_soon') {
    return json({ error: 'too_soon', retryAt: joinableAt(await placeOf(db, user.id)) }, 429);
  }
  return signedIn(ctx, session, user);
}

/** POST /api/teams/leave: leaves the team; the owner leaving closes it for everyone. */
export async function leaveOwnTeam(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  await leaveTeam(ctx.env.ACCOUNTS, auth.user.id, ctx.now);
  return signedIn(ctx, auth.session, auth.user);
}

/**
 * GET /api/teams?q=: open teams, by name prefix or the biggest. Public. The unfiltered list,
 * what every team screen opens with, is cached at the edge like the ranking.
 */
export async function findTeams(ctx: Context): Promise<Response> {
  if (ctx.request.method !== 'GET') return json({ error: 'method' }, 405);
  const q = ctx.url.searchParams.get('q') ?? '';
  if (!SEARCH.test(q)) return json({ teams: [] });
  const { ACCOUNTS, STANDINGS } = ctx.env;
  const canvas = await rankedCanvas(ctx);
  if (q) return json({ teams: await listTeams(ACCOUNTS, STANDINGS, canvas, q) });
  return cachedJson(ctx, `/api/teams?canvas=${canvas}`, async () => ({
    teams: await listTeams(ACCOUNTS, STANDINGS, canvas, ''),
  }));
}

/**
 * The canvas whose standings teams are ranked by: the current season's (ADR 0021), whose
 * canvas keeps its own standings (ADR 0020), or Stage 0's while no season is registered. A
 * season that ended stays ranked until the next one starts. Edge-cached answers are keyed by
 * it, so a new season's ranking shows at once.
 */
async function rankedCanvas(ctx: Context): Promise<string> {
  const { season } = await seasonForWatching(ctx.env.ACCOUNTS, ctx.now);
  return season?.canvas ?? RANKED_CANVAS;
}

/** GET /api/teams/:id: one team, open or closed. Public. */
export async function getTeam(ctx: Context, id: number): Promise<Response> {
  if (ctx.request.method !== 'GET') return json({ error: 'method' }, 405);
  const canvas = await rankedCanvas(ctx);
  const team = await teamDetail(ctx.env.ACCOUNTS, ctx.env.STANDINGS, canvas, id);
  return team ? json({ team }) : json({ error: 'not_found' }, 404);
}

/** A season id as `?season=` gives it: a positive whole number. */
const SEASON_ID = /^[1-9][0-9]{0,8}$/;

/**
 * GET /api/teams/ranking: the open teams by cells standing. Public and the same for everyone,
 * so it is kept in the edge cache for a minute (the canvas writes standings about that often)
 * and browsers may keep it half that. `?season=<id>` ranks a season that has started, past
 * ones included, from its own canvas's standings (ADR 0020, 0021); an unknown one is 404. A
 * season that is over says so (`over`) and keeps teams closed since in their place (they
 * built its map), marked closed and without their names, under a cache key of its own.
 */
export async function getRanking(ctx: Context): Promise<Response> {
  if (ctx.request.method !== 'GET') return json({ error: 'method' }, 405);
  const asked = ctx.url.searchParams.get('season');
  if (asked === null) {
    const canvas = await rankedCanvas(ctx);
    return cachedJson(ctx, `/api/teams/ranking?canvas=${canvas}`, () =>
      ranking(ctx.env.ACCOUNTS, ctx.env.STANDINGS, canvas),
    );
  }
  const season = SEASON_ID.test(asked)
    ? await startedSeason(ctx.env.ACCOUNTS, Number(asked), ctx.now)
    : null;
  if (!season) return json({ error: 'not_found' }, 404);
  const { canvas } = season;
  if (ctx.now < season.endsAt) {
    return cachedJson(ctx, `/api/teams/ranking?canvas=${canvas}`, () =>
      ranking(ctx.env.ACCOUNTS, ctx.env.STANDINGS, canvas),
    );
  }
  return cachedJson(ctx, `/api/teams/ranking?canvas=${canvas}&over=1`, async () => ({
    ...(await ranking(ctx.env.ACCOUNTS, ctx.env.STANDINGS, canvas, undefined, true)),
    over: true,
  }));
}

/**
 * A public JSON answer kept in the edge cache under `path` (a minute by default; browsers
 * half that). The key is the gateway's own (the canvas named in it), never the request's
 * query.
 */
export async function cachedJson(
  ctx: Context,
  path: string,
  read: () => Promise<unknown>,
  ages: { readonly browser: number; readonly edge: number } = {
    browser: RANKING_MAX_AGE,
    edge: RANKING_EDGE_AGE,
  },
): Promise<Response> {
  const key = new Request(new URL(path, ctx.url).toString());
  const cache = edgeCache();
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return hit;
  const body = await read();
  const response = new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ages.browser}, s-maxage=${ages.edge}`,
    },
  });
  try {
    await cache?.put(key, response.clone());
  } catch (error) {
    // No cache (e.g. *.workers.dev): every request reads D1.
    console.warn(`${path} not cached`, error);
  }
  return response;
}

function edgeCache(): Cache | null {
  try {
    return (caches as unknown as { default: Cache }).default;
  } catch {
    return null;
  }
}
