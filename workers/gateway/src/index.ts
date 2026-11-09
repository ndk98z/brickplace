import type { FanoutDO } from '@brickplace/realtime';
import { deleteOwnAccount, exportAccount, report } from './account-api.ts';
import { chooseNickname, logout, me, unlink } from './api.ts';
import { passChallenge } from './challenge.ts';
import { devAuthorize } from './devauth.ts';
import { contextFor, json } from './http.ts';
import { callback, start } from './oauth.ts';
import { capShare, playerCap } from './player-cap.ts';
import { currentCanvas, listSeasons, STAGE0_CANVAS, seasonForWatching } from './seasons.ts';
import { fanoutFor, shardCount, socketIdentity, withIdentity } from './socket.ts';
import { getSponsorLogo, getSponsors } from './sponsors-api.ts';
import { getSeasonNumbers, getStats } from './stats-api.ts';
import {
  createOwnTeam,
  findTeams,
  getRanking,
  getTeam,
  joinOwnTeam,
  leaveOwnTeam,
  renameOwnTeam,
} from './team-api.ts';
import { DEV_TILES_PATH, devTiles } from './tiles.ts';

// The Worker entry: workerd accepts only handlers and Durable Object classes as exports
// here, so helpers and constants live in sibling modules. Type exports are erased and fine.

export interface Env {
  ASSETS: Fetcher;
  FANOUT: DurableObjectNamespace<FanoutDO>;
  /** Accounts (ADR 0016); schema in migrations/. */
  ACCOUNTS: D1Database;
  /**
   * Team standings the canvas writes (ADR 0020); schema in ../game/migrations. Read here for
   * the ranking and team pages.
   */
  STANDINGS: D1Database;
  /**
   * Moderation data and abuse thresholds managed from the private ops repo: the nickname
   * word list (`nickname-words`, also for team names), the daily report cap
   * (`report-daily-limit`), the trust score weights (`trust-weights`, ADR 0026). The game
   * Worker reads the daily team cap from the same namespace, the realtime one `abuse-policy`.
   */
  MODERATION: KVNamespace;
  ENVIRONMENT: 'locked' | 'dev' | 'staging' | 'production';
  /** The site's origin, e.g. https://brickplace.example; redirect URIs are built from it. */
  PUBLIC_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  REDDIT_CLIENT_ID?: string;
  DISCORD_CLIENT_ID?: string;
  /** Turnstile site key: public, shown to the browser. */
  TURNSTILE_SITE_KEY?: string;
  /**
   * Public origin of the tiles bucket (https, its custom domain), e.g.
   * https://tiles.brickplace.example. Pages watch the map from there (ADR 0009, 0018).
   */
  TILES_ORIGIN?: string;
  /**
   * The local tiles bucket, dev only: served read-only under /api/dev/tiles/ since local dev
   * has no bucket domain. Deployed environments do not bind it.
   */
  DEV_TILES?: R2Bucket;
  /**
   * Sponsor logos (ADR 0038), a private bucket the admin Worker writes; served read-only
   * under /api/sponsor-logos/.
   */
  SPONSOR_LOGOS: R2Bucket;
  /**
   * FanoutDO shards per canvas (ADR 0028), a whole number from 1 to 64; absent: 1. Sockets are
   * spread over them by player (watchers by connection id). Kicks go to every shard there may
   * be, whatever this says. Raising it moves players to other shards only as their sockets
   * reconnect. Set it only once the realtime script runs the version that follows ticks.
   */
  FANOUT_SHARDS?: string;
  // Workers secrets (never in wrangler.jsonc; local values in .dev.vars):
  GOOGLE_CLIENT_SECRET?: string;
  REDDIT_CLIENT_SECRET?: string;
  DISCORD_CLIENT_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Session signing keys, `kid:secret` entries, the first one signs (see token.ts). */
  SESSION_KEYS?: string;
  /**
   * Staging only (ADR 0034): a socket sending `Authorization: Bearer <BOT_KEY>` and `?bot=<n>`
   * plays as `bot-<n>`. At least 32 characters; absent, shorter or outside staging: no bots.
   */
  BOT_KEY?: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/healthz') return new Response('ok');
    const isWs = path === '/ws';
    const isApi = path.startsWith('/api/') || path.startsWith('/auth/');
    if (!isWs && !isApi) return env.ASSETS.fetch(request);
    if (isWs && request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // A deploy without --env has no accounts or keys of its own: everything stays closed.
    if (env.ENVIRONMENT === 'locked') {
      return isWs
        ? new Response('locked deployment', { status: 501 })
        : json({ error: 'locked' }, 501);
    }
    const ctx = await contextFor(request, env);
    // Outside dev, /api and /auth answer only on the site's own host: the rate-limiting rules
    // the owner sets on that zone (ADR 0019) must not be skipped through *.workers.dev or a
    // preview URL. Sign-in cannot work on another host anyway (redirect URIs, cookies).
    if (isApi && !ctx.dev && ctx.origin !== null && ctx.url.origin !== ctx.origin) {
      return json({ error: 'host' }, 421);
    }
    if (isWs) {
      const identity = await socketIdentity(ctx);
      if (typeof identity === 'number') return new Response('refused', { status: identity });
      // The current season's canvas (ADR 0021). With the registry unreadable and nothing
      // cached, a watcher watches Stage 0's canvas; a player gets no socket rather than a guess.
      let canvas: string;
      // The players-at-once cap (ADR 0039), read alongside; watchers are not counted.
      let cap: number | null = null;
      if ('watch' in identity) {
        const { season } = await seasonForWatching(env.ACCOUNTS, ctx.now);
        canvas = season?.canvas ?? STAGE0_CANVAS;
      } else {
        try {
          [canvas, cap] = await Promise.all([
            currentCanvas(env.ACCOUNTS, ctx.now),
            playerCap(env.ACCOUNTS, ctx.now),
          ]);
        } catch (error) {
          console.error('season lookup failed', error);
          return new Response('season registry unavailable', { status: 503 });
        }
      }
      const shards = shardCount(env.FANOUT_SHARDS);
      const name = fanoutFor(canvas, identity, shards);
      const fanout = env.FANOUT.get(env.FANOUT.idFromName(name));
      // The shard's share of the cap.
      const share = cap === null ? null : capShare(cap, shards);
      return fanout.fetch(withIdentity(request, identity, canvas, share));
    }
    try {
      return await route(ctx.request.method, path, ctx);
    } catch (error) {
      // D1 or KV down: say so rather than look signed out.
      console.error('auth route failed', error);
      return json({ error: 'unavailable' }, 503);
    }
  },
} satisfies ExportedHandler<Env>;

type Ctx = Awaited<ReturnType<typeof contextFor>>;

function route(method: string, path: string, ctx: Ctx): Promise<Response> | Response {
  if (path === '/api/me' && method === 'GET') return me(ctx);
  if (path === '/api/seasons') return listSeasons(ctx);
  if (path === '/api/stats') return getStats(ctx);
  if (path === '/api/sponsors') return getSponsors(ctx);
  if (path.startsWith('/api/sponsor-logos/')) return getSponsorLogo(ctx, path);
  if (path === '/api/me/season') return getSeasonNumbers(ctx);
  if (path === '/api/nickname') return chooseNickname(ctx);
  if (path === '/api/reports') return report(ctx);
  if (path === '/api/challenge') return passChallenge(ctx);
  if (path === '/api/account/export') return exportAccount(ctx);
  if (path === '/api/account/delete') return deleteOwnAccount(ctx);
  if (path === '/api/teams') return method === 'POST' ? createOwnTeam(ctx) : findTeams(ctx);
  if (path === '/api/teams/ranking') return getRanking(ctx);
  if (path === '/api/teams/leave') return leaveOwnTeam(ctx);
  if (path === '/api/teams/rename') return renameOwnTeam(ctx);
  const teamPath = /^\/api\/teams\/([1-9]\d{0,9})(\/join)?$/.exec(path);
  if (teamPath) {
    const id = Number(teamPath[1]);
    return teamPath[2] ? joinOwnTeam(ctx, id) : getTeam(ctx, id);
  }
  if (path === '/auth/logout') return logout(ctx);
  if (path === '/auth/dev/authorize') return devAuthorize(ctx);
  if (path.startsWith(DEV_TILES_PATH)) return devTiles(ctx, ctx.env, path);
  const unlinkPath = /^\/api\/identities\/([a-z]+)\/unlink$/.exec(path);
  if (unlinkPath) return unlink(ctx, unlinkPath[1]!);
  const flow = /^\/auth\/([a-z]+)\/(start|callback)$/.exec(path);
  if (flow) return flow[2] === 'start' ? start(ctx, flow[1]!) : callback(ctx, flow[1]!);
  return json({ error: 'not_found' }, 404);
}
