import { acting, type Ctx, type Route, withReason } from './acting.ts';
import { audit } from './audit.ts';
import { json } from './http.ts';
import type { Role } from './identity.ts';
import {
  activeBan,
  BAN_MAX_MS,
  BAN_REASON_MAX,
  banPlayer,
  closeReports,
  closeTeam,
  findPlayers,
  findTeams,
  isSelf,
  kickPlayer,
  namesOf,
  PLAYER_ID,
  playerView,
  reportQueue,
  resetNickname,
  resetTeamName,
  suspects,
  type Target,
  targetName,
  teamView,
  unbanPlayer,
} from './moderation.ts';

// Player moderation routes (ADR 0023): the report queue, bans, nickname and team-name resets,
// closing a team. Owners and moderators alike, except lifting a permanent ban (owners only).
// Every change goes through `acting()` (audit rows before and after), refuses an admin acting
// on their own account, and names players by id in the audit log.

const MODERATION: readonly Role[] = ['owner', 'moderator'];
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const TEAM = '([1-9]\\d{0,9})';
const at = (path: string) => new RegExp(`^/api/moderation/${path}$`);

export const moderationRoutes: Route[] = [
  { method: 'GET', path: at('reports'), roles: MODERATION, handler: queue },
  { method: 'POST', path: at('reports/dismiss'), roles: MODERATION, handler: dismiss },
  { method: 'GET', path: at('players'), roles: MODERATION, handler: searchPlayers },
  { method: 'GET', path: at(`players/${ID}`), roles: MODERATION, handler: onePlayer },
  { method: 'POST', path: at(`players/${ID}/ban`), roles: MODERATION, handler: ban },
  { method: 'POST', path: at(`players/${ID}/unban`), roles: MODERATION, handler: unban },
  {
    method: 'POST',
    path: at(`players/${ID}/reset-nickname`),
    roles: MODERATION,
    handler: resetPlayerName,
  },
  { method: 'GET', path: at('signals'), roles: MODERATION, handler: botSignals },
  { method: 'GET', path: at('teams'), roles: MODERATION, handler: searchTeams },
  { method: 'POST', path: at(`teams/${TEAM}/reset-name`), roles: MODERATION, handler: resetName },
  { method: 'POST', path: at(`teams/${TEAM}/close`), roles: MODERATION, handler: close },
];

const query = (ctx: Ctx) =>
  (new URL(ctx.request.url).searchParams.get('q') ?? '').trim().slice(0, 64);

async function queue(ctx: Ctx): Promise<Response> {
  return json({ entries: await reportQueue(ctx.env.ACCOUNTS, ctx.now) });
}

async function searchPlayers(ctx: Ctx): Promise<Response> {
  return json({ players: await findPlayers(ctx.env.ACCOUNTS, query(ctx), ctx.now) });
}

async function onePlayer(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const player = await playerView(ctx.env.ACCOUNTS, match[1]!, ctx.now);
  return player ? json({ player }) : json({ error: 'not_found' }, 404);
}

/** Accounts the fanout flagged for bot signals or holds for a Turnstile (ADR 0026). */
async function botSignals(ctx: Ctx): Promise<Response> {
  const found = await suspects(ctx.env, ctx.now);
  // `partial`: some shards could not be reached (ADR 0028); the list is what the others hold.
  return found
    ? json({ players: found.players, partial: found.partial })
    : json({ error: 'unavailable' }, 503);
}

async function searchTeams(ctx: Ctx): Promise<Response> {
  return json({ teams: await findTeams(ctx.env.ACCOUNTS, query(ctx)) });
}

/**
 * Refuses an action on the admin's own account (or a team they own), with an audit row: the
 * attempt is worth a record, as a refusal for want of a role is.
 */
async function refuseSelf(ctx: Ctx, action: string, target: Target, reason: string) {
  await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, {
    action,
    target: targetName(target),
    reason,
    outcome: 'self',
  });
  return json({ error: 'self', detail: 'that account has your email address' }, 409);
}

/** Whether the team's owner may be the admin; a closed team has no owner. */
async function ownsTeam(ctx: Ctx, team: number): Promise<boolean> {
  const view = await teamView(ctx.env.ACCOUNTS, team);
  return view?.ownerId ? isSelf(ctx.env.ACCOUNTS, ctx.admin, view.ownerId) : false;
}

/**
 * Why a reason may hold personal data, or null. Every reason here goes into the append-only
 * audit log, which outlives the account, and a ban reason also into the player's data download
 * (ADR 0019): an address, a long number, or a name the target holds or held (the nickname, the
 * name a reset removed, a team's owner) is refused. A guard against slips, not a filter:
 * moderators write reasons as "what", never "who".
 */
export function personalData(reason: string, names: readonly string[]): string | null {
  if (reason.includes('@')) return 'no email addresses';
  if (/\d{7,}/.test(reason)) return 'no long numbers';
  const text = reason.toLowerCase();
  if (names.some((name) => name.length >= 3 && text.includes(name.toLowerCase()))) {
    return 'no names: say what happened, not who';
  }
  return null;
}

/** A 400 answer when the reason about `target` quotes personal data, else null. */
async function refusedReason(ctx: Ctx, reason: string, target: Target): Promise<Response | null> {
  const problem = personalData(reason, await namesOf(ctx.env.ACCOUNTS, target));
  return problem ? json({ error: 'invalid', detail: problem }, 400) : null;
}

const flag = (value: unknown) => value === true;

const failure = (reason: string) =>
  json({ error: reason }, reason === 'not_found' || reason === 'not_banned' ? 404 : 409);

// ---- Reports ------------------------------------------------------------------------------

/**
 * POST /api/moderation/reports/dismiss {player | team, reason, upTo?}: closes the open reports
 * on the target, no action. With `upTo` (ms, the newest report the moderator saw: the queue's
 * `lastAt`), only those filed by then: a report filed or renewed since stays open for a
 * moderator to see, instead of being dismissed unread.
 */
async function dismiss(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const upTo = body.upTo;
  if (upTo !== undefined && !(Number.isSafeInteger(upTo) && (upTo as number) >= 0)) {
    return json({ error: 'invalid', detail: 'upTo' }, 400);
  }
  let target: Target;
  if (typeof body.player === 'string' && PLAYER_ID.test(body.player)) {
    target = { player: body.player };
  } else if (Number.isSafeInteger(body.team) && (body.team as number) > 0) {
    target = { team: body.team as number };
  } else {
    return json({ error: 'invalid', detail: 'player or team' }, 400);
  }
  const db = ctx.env.ACCOUNTS;
  const refused = await refusedReason(ctx, reason, target);
  if (refused) return refused;
  const self =
    'player' in target
      ? await isSelf(db, ctx.admin, target.player)
      : await ownsTeam(ctx, target.team);
  if (self) return refuseSelf(ctx, 'reports.dismiss', target, reason);
  const result = await acting(
    ctx,
    { action: 'reports.dismiss', target: targetName(target), reason },
    async () => {
      const seen =
        upTo === undefined ? undefined : { sql: 'created_at <= ?', values: [upTo as number] };
      return (await closeReports(db, target, 'dismissed', ctx.now, seen).run()).meta.changes;
    },
    (closed) => ({
      outcome: closed > 0 ? 'ok' : 'not_found',
      after: { dismissed: closed, upTo: upTo ?? null },
    }),
  );
  return result > 0 ? json({ dismissed: result }) : json({ error: 'not_found' }, 404);
}

// ---- Players ------------------------------------------------------------------------------

/** POST /api/moderation/players/:id/ban {reason, expiresAt?, closeReports?}. */
async function ban(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const player = match[1]!;
  if (reason.length > BAN_REASON_MAX) {
    return json({ error: 'invalid', detail: `a ban reason is at most ${BAN_REASON_MAX}` }, 400);
  }
  const expiresAt = body.expiresAt ?? null;
  if (
    expiresAt !== null &&
    (!Number.isSafeInteger(expiresAt) ||
      (expiresAt as number) <= ctx.now ||
      (expiresAt as number) > ctx.now + BAN_MAX_MS)
  ) {
    return json({ error: 'invalid', detail: 'expiresAt: a future time, or none' }, 400);
  }
  const db = ctx.env.ACCOUNTS;
  const view = await playerView(db, player, ctx.now);
  if (!view) return json({ error: 'not_found' }, 404);
  const refused = await refusedReason(ctx, reason, { player });
  if (refused) return refused;
  if (await isSelf(db, ctx.admin, player)) return refuseSelf(ctx, 'player.ban', { player }, reason);
  const until = expiresAt as number | null;
  const result = await acting(
    ctx,
    {
      action: 'player.ban',
      target: targetName({ player }),
      reason,
      before: { banned: view.bans.some((b) => b.active) },
      after: { expiresAt: until },
    },
    async () => {
      const banned = await banPlayer(
        db,
        {
          player,
          reason,
          expiresAt: until,
          issuer: `access:${ctx.admin.sub}`,
          closeReports: flag(body.closeReports),
        },
        ctx.now,
      );
      return banned.ok ? { ...banned, kicked: await kickPlayer(ctx.env, player, ctx.now) } : banned;
    },
    (r) =>
      r.ok
        ? {
            outcome: r.kicked ? 'ok' : 'ok_not_kicked',
            after: { ban: r.ban, expiresAt: until, kicked: r.kicked },
          }
        : { outcome: r.reason, after: { expiresAt: until } },
  );
  return result.ok ? json({ ban: result.ban, kicked: result.kicked }) : failure(result.reason);
}

/**
 * POST /api/moderation/players/:id/unban {reason}: lifts the bans in force. Lifting a
 * permanent ban is for owners: a moderator's attempt is refused and recorded.
 */
async function unban(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { reason } = parsed;
  const player = match[1]!;
  const db = ctx.env.ACCOUNTS;
  const before = await activeBan(db, player, ctx.now);
  if (!before) return json({ error: 'not_banned' }, 404);
  const refused = await refusedReason(ctx, reason, { player });
  if (refused) return refused;
  if (await isSelf(db, ctx.admin, player)) {
    return refuseSelf(ctx, 'player.unban', { player }, reason);
  }
  const owner = ctx.admin.role === 'owner';
  if (before.permanent && !owner) {
    await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, {
      action: 'access.refused',
      target: `POST ${new URL(ctx.request.url).pathname}`,
      reason: 'only an owner lifts a permanent ban',
      outcome: 'forbidden',
    });
    return json({ error: 'role', detail: 'only an owner lifts a permanent ban' }, 403);
  }
  const result = await acting(
    ctx,
    { action: 'player.unban', target: targetName({ player }), reason, before },
    () => unbanPlayer(db, player, owner, ctx.now),
    (r) =>
      r.ok ? { outcome: 'ok', after: { lifted: r.lifted } } : { outcome: r.reason, after: null },
  );
  if (result.ok) return json({ lifted: result.lifted });
  return result.reason === 'owner_only'
    ? json({ error: 'role', detail: 'only an owner lifts a permanent ban' }, 403)
    : failure(result.reason);
}

/** POST /api/moderation/players/:id/reset-nickname {reason, closeReports?}. */
async function resetPlayerName(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const player = match[1]!;
  const db = ctx.env.ACCOUNTS;
  const refused = await refusedReason(ctx, reason, { player });
  if (refused) return refused;
  if (await isSelf(db, ctx.admin, player)) {
    return refuseSelf(ctx, 'player.reset_nickname', { player }, reason);
  }
  const result = await acting(
    ctx,
    { action: 'player.reset_nickname', target: targetName({ player }), reason },
    async () => {
      const reset = await resetNickname(db, player, flag(body.closeReports), ctx.now);
      return reset.ok ? { ...reset, kicked: await kickPlayer(ctx.env, player, ctx.now) } : reset;
    },
    // The placeholder names no one; the old nickname stays out of the append-only log.
    (r) =>
      r.ok
        ? {
            outcome: r.kicked ? 'ok' : 'ok_not_kicked',
            after: { nickname: r.name, kicked: r.kicked },
          }
        : { outcome: r.reason, after: null },
  );
  return result.ok
    ? json({ nickname: result.name, kicked: result.kicked })
    : failure(result.reason);
}

// ---- Teams --------------------------------------------------------------------------------

/** POST /api/moderation/teams/:id/reset-name {reason, closeReports?}. */
async function resetName(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const team = Number(match[1]);
  const refused = await refusedReason(ctx, reason, { team });
  if (refused) return refused;
  if (await ownsTeam(ctx, team)) return refuseSelf(ctx, 'team.reset_name', { team }, reason);
  const before = await teamView(ctx.env.ACCOUNTS, team);
  const result = await acting(
    ctx,
    {
      action: 'team.reset_name',
      target: targetName({ team }),
      reason,
      before: before ? { name: before.name } : null,
    },
    () => resetTeamName(ctx.env.ACCOUNTS, team, flag(body.closeReports), ctx.now),
    (r) => (r.ok ? { outcome: 'ok', after: { name: r.name } } : { outcome: r.reason, after: null }),
  );
  return result.ok ? json({ name: result.name }) : failure(result.reason);
}

/**
 * POST /api/moderation/teams/:id/close {reason, resetName?, closeReports?}: closes a team
 * whose owner is gone or whose name is offensive. Its cells stay (ADR 0020).
 */
async function close(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const team = Number(match[1]);
  const refused = await refusedReason(ctx, reason, { team });
  if (refused) return refused;
  if (await ownsTeam(ctx, team)) return refuseSelf(ctx, 'team.close', { team }, reason);
  const before = await teamView(ctx.env.ACCOUNTS, team);
  const options = { resetName: flag(body.resetName), closeReports: flag(body.closeReports) };
  const result = await acting(
    ctx,
    {
      action: 'team.close',
      target: targetName({ team }),
      reason,
      before: before ? { name: before.name, members: before.members } : null,
      after: options,
    },
    () => closeTeam(ctx.env.ACCOUNTS, team, options, ctx.now),
    (r) =>
      r.ok
        ? { outcome: 'ok', after: { name: r.name, members: r.members } }
        : { outcome: r.reason, after: options },
  );
  return result.ok ? json({ name: result.name, members: result.members }) : failure(result.reason);
}
