import { DEFAULT_PLAYER_CAP, MAX_PLAYER_CAP } from '@brickplace/realtime/player';
import { acting, type Ctx, type Route, withReason } from './acting.ts';
import { json } from './http.ts';
import type { Role } from './identity.ts';

// How many may play at once (ADR 0039): the `player_cap` row of `site_settings` in the
// accounts database (gateway migration 0008). The gateway reads it (cached 30 s) and passes
// each playing socket's shard its share. Owners change it; every change is in the audit log.
// The default and the maximum are realtime/player's, which the gateway's tests check too.

export interface PlayerCapView {
  /** The cap in force: a whole number of players, or null for none. */
  readonly cap: number | null;
  /** True while no row is set and the default applies. */
  readonly isDefault: boolean;
  readonly updatedAt: number | null;
}

export function playerCapRoutes(read: readonly Role[], write: readonly Role[]): Route[] {
  return [
    { method: 'GET', path: /^\/api\/player-cap$/, roles: read, handler: get },
    { method: 'POST', path: /^\/api\/player-cap$/, roles: write, handler: set },
  ];
}

async function view(db: D1Database): Promise<PlayerCapView> {
  const row = await db
    .prepare("SELECT value, updated_at FROM site_settings WHERE key = 'player_cap'")
    .first<{ value: number | null; updated_at: number }>();
  return row
    ? { cap: row.value, isDefault: false, updatedAt: row.updated_at }
    : { cap: DEFAULT_PLAYER_CAP, isDefault: true, updatedAt: null };
}

/** GET /api/player-cap. */
async function get(ctx: Ctx): Promise<Response> {
  return json(await view(ctx.env.ACCOUNTS));
}

/**
 * POST /api/player-cap {cap, reason}: a whole number from 0 to MAX_PLAYER_CAP, or null for no
 * cap. Lowering it closes no socket: it stops new players until the count falls under it.
 */
async function set(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const cap = body.cap;
  if (
    cap !== null &&
    !(Number.isInteger(cap) && (cap as number) >= 0 && (cap as number) <= MAX_PLAYER_CAP)
  ) {
    return json(
      { error: 'invalid', detail: `cap: a whole number from 0 to ${MAX_PLAYER_CAP}, or null` },
      400,
    );
  }
  const db = ctx.env.ACCOUNTS;
  const before = await view(db);
  await acting(
    ctx,
    { action: 'player_cap.set', target: 'site', before: before.cap, after: cap, reason },
    () =>
      db
        .prepare(
          "INSERT INTO site_settings (key, value, updated_at) VALUES ('player_cap', ?, ?) " +
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .bind(cap, ctx.now)
        .run(),
    () => ({ outcome: 'ok', after: cap }),
  );
  return json(await view(db));
}
