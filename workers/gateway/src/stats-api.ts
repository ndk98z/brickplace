import { authorised } from './api.ts';
import { type Context, json } from './http.ts';
import { STAGE0_CANVAS, seasonForWatching } from './seasons.ts';
import { fanoutName } from './socket.ts';
import { cachedJson } from './team-api.ts';

// GET /api/stats (ADR 0030): what the game screen shows about the current canvas, for every
// page, watching or playing. Counts only: players with a socket open, the phase and how full
// the open area is, and the drop rates of each phase. Public and edge-cached for 15 s, so a
// crowd of pages costs the canvas a few calls a minute per colo.

/** Seconds a browser and the edge keep an answer. */
export const STATS_AGES = { browser: 15, edge: 15 } as const;

export async function getStats(ctx: Context): Promise<Response> {
  if (ctx.request.method !== 'GET') return json({ error: 'method' }, 405);
  // The canvas pages watch (the current season's, or Stage 0's while the registry is out).
  const { season } = await seasonForWatching(ctx.env.ACCOUNTS, ctx.now);
  const canvas = season?.canvas ?? STAGE0_CANVAS;
  try {
    return await cachedJson(
      ctx,
      `/api/stats?canvas=${canvas}`,
      async () => {
        // FanoutDO passes the call on: the gateway binds no CanvasDO.
        const fanout = ctx.env.FANOUT.get(ctx.env.FANOUT.idFromName(fanoutName(canvas)));
        const stats = await fanout.stats(canvas);
        // A realtime or game script that predates stats: nothing to show, nothing cached.
        if (stats === null) throw new Error('canvas has no stats()');
        return stats;
      },
      STATS_AGES,
    );
  } catch (error) {
    console.error('stats failed', error);
    return json({ error: 'unavailable' }, 503);
  }
}

/**
 * POST /api/me/season (ADR 0031): the signed-in account's moves on the current canvas, for its
 * own profile: bricks, hammers, shields, days played. Signed in and same-site with the CSRF
 * token, never cached. 503 while the registry is unreadable (the canvas would be a guess) or
 * while realtime or game predates it.
 */
export async function getSeasonNumbers(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  const { season, guessed } = await seasonForWatching(ctx.env.ACCOUNTS, ctx.now);
  if (guessed) return json({ error: 'unavailable' }, 503);
  const canvas = season?.canvas ?? STAGE0_CANVAS;
  try {
    const fanout = ctx.env.FANOUT.get(ctx.env.FANOUT.idFromName(fanoutName(canvas)));
    // The socket's player id (socket.ts): the session's user.
    const numbers = await fanout.playerSeason(canvas, auth.session.u);
    if (numbers === null) return json({ error: 'unavailable' }, 503);
    return json({ season: season?.id ?? null, ...numbers });
  } catch (error) {
    console.error('season numbers failed', error);
    return json({ error: 'unavailable' }, 503);
  }
}
