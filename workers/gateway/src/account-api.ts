// Account API, part two (ADR 0008, 0019): report a nickname, download your data, delete your
// account. Same rules as api.ts: POST, same-site Origin, the session's CSRF token.

import { accountData, deleteAccount, userByNickname } from './accounts.ts';
import { authorised } from './api.ts';
import { type Context, json } from './http.ts';
import { kickPlayer } from './kick.ts';
import { checkShape, nicknameKey } from './nickname.ts';
import {
  fileReport,
  isReportReason,
  type ReportTarget,
  reportLimit,
  TEAM_NAME_REASON,
} from './reports.ts';
import { clearSessionCookie, mayLink, REJOIN_AFTER_DELETE_MS } from './session.ts';
import { reportableTeam } from './teams.ts';

/**
 * POST /api/reports {nickname, reason} or {team, reason: 'team_name'}: reports another
 * player's nickname, or a team's name (ADR 0023). Needs a playing
 * account (one with a nickname). No Turnstile: the account already passed it at sign-up,
 * the daily cap bounds what one account can file, and moderators read reports, nothing acts
 * on them automatically (ADR 0019).
 */
export async function report(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  if (user.nickname === null) return json({ error: 'no_nickname' }, 403);
  const body = (await ctx.request.json().catch(() => null)) as {
    nickname?: unknown;
    team?: unknown;
    reason?: unknown;
  } | null;
  const target = await reportTarget(ctx, user.id, body);
  if (target instanceof Response) return target;
  const limit = await reportLimit(ctx.env.MODERATION, ctx.dev, ctx.now);
  if (limit === null) return json({ error: 'unavailable' }, 503);
  const result = await fileReport(ctx.env.ACCOUNTS, {
    reporter: user.id,
    target,
    now: ctx.now,
    limit,
  });
  if (result === 'already_reported') return json({ error: result }, 409);
  if (result === 'too_many') return json({ error: result }, 429);
  return json({ ok: true }, 201);
}

/**
 * What a report body names: `{nickname, reason}` for a player (one of the nickname reasons),
 * or `{team, reason: 'team_name'}` for an open team's name (ADR 0023). Nobody reports
 * themselves, or a team they own.
 */
async function reportTarget(
  ctx: Context,
  reporter: string,
  body: { nickname?: unknown; team?: unknown; reason?: unknown } | null,
): Promise<ReportTarget | Response> {
  const reason = body?.reason;
  if (body?.team !== undefined) {
    if (reason !== TEAM_NAME_REASON) return json({ error: 'reason' }, 400);
    const id = body.team;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      return json({ error: 'not_found' }, 404);
    }
    const team = await reportableTeam(ctx.env.ACCOUNTS, id);
    if (!team) return json({ error: 'not_found' }, 404);
    if (team.owner_id === reporter) return json({ error: 'self' }, 400);
    return { team: id, name: team.name };
  }
  if (!isReportReason(reason)) return json({ error: 'reason' }, 400);
  const shape = checkShape(body?.nickname);
  // A name no account could hold is not anyone's.
  if (!shape.ok) return json({ error: 'not_found' }, 404);
  const target = await userByNickname(ctx.env.ACCOUNTS, shape.key);
  if (!target) return json({ error: 'not_found' }, 404);
  if (target.id === reporter) return json({ error: 'self' }, 400);
  return { player: target.id, nickname: target.nickname, reason };
}

/** What the download says about ops placed on the map, instead of listing them (ADR 0019). */
export const CONTRIBUTIONS_NOTE =
  'Items you used on the map are kept in each season’s operation log under your account id ' +
  'until 90 days after that season ends, then the id is removed. They are not listed here: ' +
  'the log is stored per map, not per player, so it cannot be read back by player cheaply. ' +
  'Deleting your account removes the link between that id and you; the cells stay on the map.';

/** snake_case column names to camelCase keys, times (ms) to ISO strings (0 or null: null). */
function readable(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const time = /_(at|after)$/.test(key);
    out[name] = time
      ? typeof value === 'number' && value > 0
        ? new Date(value).toISOString()
        : null
      : value;
  }
  return out;
}

/**
 * POST /api/account/export: a JSON file of everything D1 holds about the account. A POST with
 * the CSRF token rather than a GET link, so no other site can make the browser fetch it.
 */
export async function exportAccount(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  const data = await accountData(ctx.env.ACCOUNTS, auth.user.id);
  if (!data.user) return json({ error: 'signed_out' }, 401, [clearSessionCookie(ctx)]);
  const body = {
    format: 'brickplace-account-export',
    version: 1,
    exportedAt: new Date(ctx.now).toISOString(),
    account: readable(data.user),
    identities: data.identities.map(readable),
    bans: data.bans.map(readable),
    reportsFiled: data.reportsFiled.map(readable),
    team: data.team ? readable(data.team) : null,
    nicknameHistory:
      'Only the current nickname is stored; earlier ones are not kept, except as the ' +
      'nickname named in a report someone filed about it.',
    contributions: CONTRIBUTIONS_NOTE,
  };
  const response = json(body);
  const day = new Date(ctx.now).toISOString().slice(0, 10);
  response.headers.set(
    'Content-Disposition',
    `attachment; filename="brickplace-account-${day}.json"`,
  );
  return response;
}

/** What an account without a nickname types to confirm its deletion. */
export const DELETE_WORD = 'delete';

/**
 * POST /api/account/delete {confirm}: deletes the account. Needs a sign-in from the last ten
 * minutes (like linking) and the nickname typed again (any letter case), or `delete` when the
 * account never chose one. The cookie is cleared; other sessions fail their next renewal, and
 * open sockets are closed at once, and may not play again with a token issued before (ADR
 * 0023). Should that call fail, they stop playing when their token expires, within the hour
 * (ADR 0015).
 */
export async function deleteOwnAccount(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  const { session, user } = auth;
  if (!mayLink(ctx, session)) return json({ error: 'reauth' }, 403);
  const body = (await ctx.request.json().catch(() => null)) as { confirm?: unknown } | null;
  const typed = typeof body?.confirm === 'string' ? nicknameKey(body.confirm.trim()) : null;
  if (typed !== nicknameKey(user.nickname ?? DELETE_WORD)) return json({ error: 'confirm' }, 400);
  // authorised() read a signed session, so the key ring exists.
  await deleteAccount(ctx.env.ACCOUNTS, ctx.ring!, user.id, ctx.now, REJOIN_AFTER_DELETE_MS);
  // After the row is gone, so no renewal can hand out a token the kick does not cover.
  await kickPlayer(ctx.env, user.id, ctx.now, true);
  return json({ ok: true }, 200, [clearSessionCookie(ctx)]);
}
