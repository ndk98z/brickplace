import type { CanvasDO } from '@brickplace/game';
import type { FanoutDO } from '@brickplace/realtime';
import { AccessKeys } from './access.ts';
import { auditOncePer, NO_ROLE_AUDIT_MS } from './audit.ts';
import { asset, json, ownRequest } from './http.ts';
import { whoIsAsking } from './identity.ts';
import { api } from './routes.ts';
import { ADMIN_CSS, ADMIN_JS, ADMIN_PAGE } from './ui/page.ts';

// The admin Worker (ADR 0022): config versions, the audit log, emergency switches and season
// control, on its own hostname behind a Cloudflare Access application. Every request but the
// health check must carry a valid Access token and come from someone with a role in D1.
// workerd accepts only handlers and Durable Object classes as exports of this module, so
// helpers and constants live in sibling modules. Type exports are erased and fine.

export interface Env {
  /** The game's CanvasDO (owned by the game script), for config versions. */
  CANVAS: DurableObjectNamespace<CanvasDO>;
  /** Roles, config versions and the audit log; schema in migrations/. */
  ADMIN_DB: D1Database;
  /**
   * The gateway's accounts database (schema in workers/gateway/migrations): the season registry
   * (`seasons`, seasons.ts) and moderation (moderation.ts: reports, bans, nickname and team
   * resets, closing teams; ADR 0023). The binding itself reaches every table: see ADR 0022 on
   * the blast radius.
   */
  ACCOUNTS: D1Database;
  /**
   * The realtime script's FanoutDO, only to close a player's open sockets after a ban or a
   * reset (FanoutDO.kick, ADR 0023).
   */
  FANOUT: DurableObjectNamespace<FanoutDO>;
  /**
   * Sponsor logos (ADR 0038), a private bucket: written here under `logos/<sha256>.<ext>`,
   * served to players by the gateway.
   */
  SPONSOR_LOGOS: R2Bucket;
  /** `locked` closes everything; `dev` replaces Access with a local owner (.dev.vars only). */
  ENVIRONMENT: 'locked' | 'dev' | 'staging' | 'production';
  /** https://<team>.cloudflareaccess.com, the issuer of the Access tokens. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
}

/** One per isolate, so the team's keys are fetched once, not per request. */
const keys = new AccessKeys();

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/healthz') return new Response('ok');
    if (env.ENVIRONMENT === 'locked') return json({ error: 'locked' }, 501);
    const now = Date.now();
    try {
      const who = await whoIsAsking(request, env, keys, now);
      if (!who.ok) {
        // Someone Access let in tried to change something without a role: worth a record,
        // but only for a request from our own page (another site cannot write rows in their
        // name by sending their browser here), and one per person per hour (they could
        // otherwise fill the log by repeating the request).
        if (who.identity && request.method === 'POST' && ownRequest(request)) {
          await auditOncePer(env.ADMIN_DB, who.identity, now, NO_ROLE_AUDIT_MS, {
            action: 'access.refused',
            target: `POST ${path.slice(0, 200)}`,
            reason: who.error,
            outcome: 'forbidden',
          });
        }
        return json({ error: who.error, detail: who.detail }, who.status);
      }
      if (request.method === 'GET') {
        if (path === '/') return asset(ADMIN_PAGE, 'text/html; charset=utf-8');
        if (path === '/admin.js') return asset(ADMIN_JS, 'text/javascript; charset=utf-8');
        if (path === '/admin.css') return asset(ADMIN_CSS, 'text/css; charset=utf-8');
      }
      if (path.startsWith('/api/')) return await api({ env, request, admin: who.admin, now }, path);
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      // D1 or the canvas down: say so rather than guess.
      console.error('admin: request failed', error);
      return json({ error: 'unavailable' }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
