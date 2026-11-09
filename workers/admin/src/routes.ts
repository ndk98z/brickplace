import { acting, type Ctx, type Route, withReason } from './acting.ts';
import { archiveRoutes } from './archive.ts';
import { AUDIT_PAGE, audit, listAudit } from './audit.ts';
import {
  cancelVersion,
  carryConfig,
  configView,
  createVersion,
  doubleCooldown,
  type Outcome,
  retryDelivery,
} from './config.ts';
import { json, ownRequest } from './http.ts';
import { allowed, type Role } from './identity.ts';
import { mapRoutes } from './map.ts';
import { moderationRoutes } from './moderation-routes.ts';
import { playerCapRoutes } from './player-cap.ts';
import {
  type CanvasConfigPort,
  canvasConfig,
  canvasStub,
  currentCanvas,
  readOnlySwitch,
  type SeasonResult,
} from './ports.ts';
import { listRoles, setRole } from './roles.ts';
import { seasonRegistry } from './seasons.ts';
import { sponsorRoutes } from './sponsors.ts';

// The shared route pieces moved to acting.ts; re-exported for modules that import them here.
export { acting, type Ctx, type Route, withReason } from './acting.ts';

// The admin API (ADR 0022). Reads need any role; changes need a JSON request from our own
// page (see ownRequest) and the role each route names. Owners change config, seasons and
// roles; moderators may also pull the emergency switches (reopening a read-only map is an
// owner's: see readOnly).

const OWNER: readonly Role[] = ['owner'];
const ANY: readonly Role[] = ['owner', 'moderator'];
const EMERGENCY: readonly Role[] = ['owner', 'moderator'];

const routes: Route[] = [
  { method: 'GET', path: /^\/api\/me$/, roles: ANY, handler: me },
  { method: 'GET', path: /^\/api\/stats$/, roles: ANY, handler: stats },
  { method: 'GET', path: /^\/api\/config$/, roles: ANY, handler: getConfig },
  { method: 'POST', path: /^\/api\/config$/, roles: OWNER, handler: postConfig },
  { method: 'POST', path: /^\/api\/config\/(\d{1,15})\/cancel$/, roles: OWNER, handler: cancel },
  { method: 'POST', path: /^\/api\/config\/(\d{1,15})\/deliver$/, roles: OWNER, handler: retry },
  {
    method: 'POST',
    path: /^\/api\/emergency\/cooldown-double$/,
    roles: EMERGENCY,
    handler: cooldownDouble,
  },
  { method: 'GET', path: /^\/api\/emergency\/read-only$/, roles: ANY, handler: readOnlyStatus },
  { method: 'POST', path: /^\/api\/emergency\/read-only$/, roles: EMERGENCY, handler: readOnly },
  { method: 'GET', path: /^\/api\/seasons$/, roles: ANY, handler: listSeasons },
  { method: 'POST', path: /^\/api\/seasons$/, roles: OWNER, handler: createSeason },
  { method: 'POST', path: /^\/api\/stage0\/end$/, roles: OWNER, handler: endStage0 },
  {
    method: 'POST',
    path: /^\/api\/seasons\/([A-Za-z0-9_-]{1,64})\/(schedule|end)$/,
    roles: OWNER,
    handler: changeSeason,
  },
  { method: 'GET', path: /^\/api\/audit$/, roles: ANY, handler: getAudit },
  { method: 'GET', path: /^\/api\/roles$/, roles: OWNER, handler: getRoles },
  { method: 'POST', path: /^\/api\/roles$/, roles: OWNER, handler: postRole },
  // Player moderation (ADR 0023): moderation-routes.ts.
  ...moderationRoutes,
  // Map moderation (ADR 0024): rollbacks and area locks, handlers in map.ts.
  ...mapRoutes(ANY),
  // A season's archive (ADR 0021, 0024): archive-only removals and "seal now", in archive.ts.
  ...archiveRoutes(ANY, OWNER),
  // Sponsors and site links (ADR 0038), handlers in sponsors.ts.
  ...sponsorRoutes(ANY, OWNER),
  // The players-at-once cap (ADR 0039), handlers in player-cap.ts.
  ...playerCapRoutes(ANY, OWNER),
];

export async function api(ctx: Ctx, path: string): Promise<Response> {
  const method = ctx.request.method;
  let known = false;
  for (const route of routes) {
    const match = route.path.exec(path);
    if (!match) continue;
    known = true;
    if (route.method !== method) continue;
    if (method === 'POST' && !ownRequest(ctx.request)) return json({ error: 'forbidden' }, 403);
    if (!allowed(ctx.admin, route.roles)) {
      // A change refused for want of the role is recorded; a refused read is not.
      if (method === 'POST') {
        await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, {
          action: 'access.refused',
          target: `POST ${path}`,
          reason: `role ${ctx.admin.role}`,
          outcome: 'forbidden',
        });
      }
      return json({ error: 'role' }, 403);
    }
    return route.handler(ctx, match);
  }
  return known ? json({ error: 'method' }, 405) : json({ error: 'not_found' }, 404);
}

const reply = ({ status, body }: Outcome) => json(body, status);

async function me(ctx: Ctx): Promise<Response> {
  const { email, role, dev } = ctx.admin;
  return json({ email, role, dev, environment: ctx.env.ENVIRONMENT, auditPage: AUDIT_PAGE });
}

/**
 * The current canvas's live counts (ADR 0030: CanvasDO.stats(), the numbers the game screen
 * shows), for the page's overview. Uncached, unlike the gateway's public copy.
 */
async function stats(ctx: Ctx): Promise<Response> {
  const canvas = await currentCanvas(ctx.env, ctx.now);
  try {
    const { playing, phase, filled, built, growsAt } = await canvasStub(ctx.env, canvas).stats(
      ctx.now,
    );
    // `built` is what growth reads, `filled` what sets the phase (ADR 0033 amended).
    return json({ canvas, playing, phase, filled, built, growsAt });
  } catch (error) {
    console.error('admin: could not reach the canvas for stats', error);
    return json({ error: 'unreachable' }, 502);
  }
}

/** The current season's canvas (ADR 0021), resolved per request from the registry. */
async function configPort(ctx: Ctx) {
  return canvasConfig(ctx.env, await currentCanvas(ctx.env, ctx.now));
}

/**
 * The canvas a config request names (ADR 0022): the current one when it names none (or that
 * one), else a registered season that has not started yet, so its settings can be set before
 * its first op. Anything else (an ended season, a name nobody registered) is refused before a
 * canvas is reached.
 */
async function configTarget(ctx: Ctx, requested: unknown): Promise<CanvasConfigPort | Response> {
  const current = await currentCanvas(ctx.env, ctx.now);
  if (requested === undefined || requested === null || requested === '' || requested === current) {
    return canvasConfig(ctx.env, current);
  }
  if (typeof requested !== 'string' || requested.length > 64) {
    return json({ error: 'invalid', detail: 'canvas' }, 400);
  }
  const row = await ctx.env.ACCOUNTS.prepare('SELECT starts_at FROM seasons WHERE canvas = ?')
    .bind(requested)
    .first<{ starts_at: number }>();
  if (!row) return json({ error: 'not_found', detail: 'no season has that canvas' }, 404);
  if (row.starts_at <= ctx.now) {
    return json(
      { error: 'not_scheduled', detail: 'only the current canvas or a season not yet started' },
      409,
    );
  }
  return canvasConfig(ctx.env, requested);
}

async function getConfig(ctx: Ctx): Promise<Response> {
  const port = await configTarget(ctx, new URL(ctx.request.url).searchParams.get('canvas'));
  if (port instanceof Response) return port;
  return reply(await configView(ctx.env.ADMIN_DB, port));
}

async function postConfig(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const port = await configTarget(ctx, body.canvas);
  if (port instanceof Response) return port;
  return reply(
    await createVersion(
      ctx.env.ADMIN_DB,
      port,
      ctx.admin,
      { scope: body.scope, config: body.config, effectiveAt: body.effectiveAt, note: reason },
      ctx.now,
    ),
  );
}

async function cancel(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const id = Number(match[1]);
  const port = await configTarget(ctx, parsed.body.canvas);
  if (port instanceof Response) return port;
  return reply(await cancelVersion(ctx.env.ADMIN_DB, port, ctx.admin, id, parsed.reason, ctx.now));
}

async function retry(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const id = Number(match[1]);
  const port = await configTarget(ctx, parsed.body.canvas);
  if (port instanceof Response) return port;
  return reply(await retryDelivery(ctx.env.ADMIN_DB, port, ctx.admin, id, parsed.reason, ctx.now));
}

async function cooldownDouble(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  return reply(
    await doubleCooldown(
      ctx.env.ADMIN_DB,
      await configPort(ctx),
      ctx.admin,
      parsed.reason,
      ctx.now,
    ),
  );
}

async function readOnlyStatus(ctx: Ctx): Promise<Response> {
  const canvas = await currentCanvas(ctx.env, ctx.now);
  return json({ available: true, status: await readOnlySwitch(ctx.env, canvas).status() });
}

async function readOnly(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const on = body.readOnly;
  if (typeof on !== 'boolean') {
    return json({ error: 'invalid', detail: 'readOnly must be true or false' }, 400);
  }
  // Moderators pull the switch; only an owner reopens the map (owner decision, ADR 0022).
  if (!on && ctx.admin.role !== 'owner') {
    await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, {
      action: 'access.refused',
      target: `POST ${new URL(ctx.request.url).pathname}`,
      reason: 'only an owner reopens the map',
      outcome: 'forbidden',
    });
    return json({ error: 'role', detail: 'only an owner reopens the map' }, 403);
  }
  const port = readOnlySwitch(ctx.env, await currentCanvas(ctx.env, ctx.now));
  const before = await port.status();
  const result = await acting(
    ctx,
    {
      action: on ? 'emergency.read_only_on' : 'emergency.read_only_off',
      target: port.canvas,
      reason,
      before,
      after: { readOnly: on },
    },
    () => port.set(on, reason),
    (r) => ({
      outcome: r.ok ? 'ok' : r.reason,
      after: r.ok ? r.status : { readOnly: on, detail: r.detail },
    }),
  );
  if (result.ok) return json({ status: result.status });
  return json(
    { error: result.reason, detail: result.detail },
    result.reason === 'unreachable' ? 502 : 409,
  );
}

async function listSeasons(ctx: Ctx): Promise<Response> {
  const seasons = await seasonRegistry(ctx.env, ctx.now).list();
  return json({ available: true, seasons });
}

async function createSeason(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const { canvas, startsAt, endsAt } = body;
  if (typeof canvas !== 'string' || !isTime(startsAt) || !isTime(endsAt) || endsAt <= startsAt) {
    return json({ error: 'invalid', detail: 'canvas, startsAt < endsAt (ms)' }, 400);
  }
  const input = { canvas, startsAt, endsAt };
  const registry = seasonRegistry(ctx.env, ctx.now);
  // The canvas players are on now, read before the create: its settings carry over.
  const previous = await currentCanvas(ctx.env, ctx.now);
  const result = await acting(
    ctx,
    { action: 'season.create', target: canvas, reason, after: input },
    () => registry.create(input),
    (r) => seasonOutcome(r, input),
  );
  if (!result.ok) return seasonReply(result);
  // ADR 0022 (owner to confirm): the item config and growth rule in force carry over.
  const carried = await carryConfig(
    ctx.env.ADMIN_DB,
    canvasConfig(ctx.env, previous),
    canvasConfig(ctx.env, result.season.canvas),
    ctx.admin,
    reason,
    ctx.now,
  );
  const reply = seasonReply(result);
  return json({ ...((await reply.json()) as Record<string, unknown>), carried }, reply.status);
}

async function changeSeason(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const canvas = match[1]!;
  const registry = seasonRegistry(ctx.env, ctx.now);
  if (match[2] === 'end') {
    return seasonReply(
      await acting(
        ctx,
        { action: 'season.end', target: canvas, reason, after: { endsAt: ctx.now } },
        () => registry.end(canvas),
        (r) => seasonOutcome(r, { endsAt: ctx.now }),
      ),
    );
  }
  const times: { startsAt?: number; endsAt?: number } = {};
  for (const key of ['startsAt', 'endsAt'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (!isTime(value)) return json({ error: 'invalid', detail: key }, 400);
    times[key] = value;
  }
  if (Object.keys(times).length === 0) {
    return json({ error: 'invalid', detail: 'startsAt or endsAt' }, 400);
  }
  return seasonReply(
    await acting(
      ctx,
      { action: 'season.schedule', target: canvas, reason, after: times },
      () => registry.reschedule(canvas, times),
      (r) => seasonOutcome(r, times),
    ),
  );
}

async function endStage0(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const registry = seasonRegistry(ctx.env, ctx.now);
  return seasonReply(
    await acting(
      ctx,
      { action: 'season.end_stage0', target: 'canvas', reason: parsed.reason },
      () => registry.endStage0(),
      (r) => seasonOutcome(r, { endsAt: 'now' }),
    ),
  );
}

function seasonOutcome(result: SeasonResult, requested: unknown) {
  if (result.ok) {
    return {
      outcome: 'ok',
      after: result.note ? { ...result.season, note: result.note } : result.season,
    };
  }
  return { outcome: result.reason, after: { requested, detail: result.detail } };
}

function seasonReply(result: SeasonResult): Response {
  if (result.ok)
    return json(
      result.note ? { season: result.season, note: result.note } : { season: result.season },
    );
  const status = {
    not_found: 404,
    refused: 409,
    undone: 502,
    inconsistent: 502,
    unreachable: 502,
  }[result.reason];
  return json({ error: result.reason, detail: result.detail }, status);
}

async function getAudit(ctx: Ctx): Promise<Response> {
  const raw = new URL(ctx.request.url).searchParams.get('before');
  const before = raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  return json({ entries: await listAudit(ctx.env.ADMIN_DB, before) });
}

async function getRoles(ctx: Ctx): Promise<Response> {
  return reply(await listRoles(ctx.env.ADMIN_DB));
}

async function postRole(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  return reply(await setRole(ctx.env.ADMIN_DB, ctx.admin, body.email, body.role, reason, ctx.now));
}

function isTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
