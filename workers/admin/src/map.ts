import type { Rect } from '@brickplace/core';
import type {
  AreaLock,
  LockRequest,
  LockResult,
  RollbackFilter,
  RollbackRecord,
  RollbackResult,
  RollbackStatus,
  UnlockResult,
  Who,
} from '@brickplace/game';
import { fanoutName } from '@brickplace/realtime/player';
import { acting, type Ctx, type Route, withReason } from './acting.ts';
import { audit } from './audit.ts';
import { json, readBody, text } from './http.ts';
import type { Role } from './identity.ts';
import type { Env } from './index.ts';
import { namesOf } from './moderation.ts';
import { personalData } from './moderation-routes.ts';
import { canvasStub, currentCanvas } from './ports.ts';

// Map moderation (ADR 0024): who last wrote a cell, rollbacks (a dry run, then apply) and area
// locks, on the current season's canvas. Every change goes through `acting` (audit rows before
// and after the call), with a reason that names no one (ADR 0023's `personalData`; the audit
// rows may keep account ids). Moderators may do all of it, except a rollback without a player
// (every player's ops in an area and time range, up to the whole map), which needs an owner.
// After a change the canvas's FanoutDO is asked to send it to open sockets at once. The page
// part is ui/areas.ts.

/** The canvas's map moderation calls, behind an interface like the other ports. */
export interface MapPort {
  readonly canvas: string;
  lastWriter(x: number, y: number): Promise<Who | null>;
  preview(filter: RollbackFilter, by: Role): Promise<RollbackStatus>;
  apply(job: string, filter: RollbackFilter): Promise<RollbackResult>;
  cancel(): Promise<{ readonly ok: true; readonly dropped: boolean }>;
  rollbacks(): Promise<readonly RollbackRecord[]>;
  locks(): Promise<{ readonly rev: number; readonly locks: readonly AreaLock[] }>;
  lock(request: LockRequest): Promise<LockResult>;
  unlock(id: number): Promise<UnlockResult>;
  /** Asks the canvas's FanoutDO to send open sockets what changed; false when it failed. */
  refreshSockets(): Promise<boolean>;
}

export function mapPort(env: Env, canvas: string): MapPort {
  const stub = () => canvasStub(env, canvas);
  // RPC types widen readonly tuples and unions; the values are the canvas's own.
  return {
    canvas,
    lastWriter: (x, y) => stub().lastWriter(x, y) as Promise<Who | null>,
    preview: (filter, by) =>
      stub().rollbackPreview(filter, undefined, by) as Promise<unknown> as Promise<RollbackStatus>,
    apply: (job, filter) =>
      stub().rollbackApply(job, undefined, filter) as Promise<unknown> as Promise<RollbackResult>,
    cancel: () => stub().rollbackCancel(),
    rollbacks: async () =>
      (await stub().seasonStatus()).rollbacks as unknown as readonly RollbackRecord[],
    locks: () =>
      stub().areaLocks() as Promise<unknown> as Promise<{ rev: number; locks: AreaLock[] }>,
    lock: (request) => stub().lockArea(request) as Promise<unknown> as Promise<LockResult>,
    unlock: (id) => stub().unlockArea(id) as Promise<unknown> as Promise<UnlockResult>,
    refreshSockets: async () => {
      try {
        await env.FANOUT.get(env.FANOUT.idFromName(fanoutName(canvas))).refresh();
        return true;
      } catch (error) {
        // Sockets on every shard still get the change with the canvas's next diff tick
        // (ADR 0028); the refresh only brings shard 0 up at once.
        console.error('admin: socket refresh failed', error);
        return false;
      }
    },
  };
}

/** The map moderation routes, for routes.ts: open to moderators and owners alike. */
export function mapRoutes(moderate: readonly Role[]): Route[] {
  return [
    { method: 'GET', path: /^\/api\/map\/cell$/, roles: moderate, handler: cell },
    { method: 'POST', path: /^\/api\/map\/rollback\/preview$/, roles: moderate, handler: preview },
    { method: 'POST', path: /^\/api\/map\/rollback\/apply$/, roles: moderate, handler: apply },
    {
      method: 'POST',
      path: /^\/api\/map\/rollback\/cancel$/,
      roles: moderate,
      handler: async (ctx) => json(await (await port(ctx)).cancel()),
    },
    {
      method: 'GET',
      path: /^\/api\/map\/rollbacks$/,
      roles: moderate,
      handler: async (ctx) => {
        const p = await port(ctx);
        return json({ canvas: p.canvas, rollbacks: await p.rollbacks() });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/map\/locks$/,
      roles: moderate,
      handler: async (ctx) => {
        const p = await port(ctx);
        return json({ canvas: p.canvas, ...(await p.locks()) });
      },
    },
    { method: 'POST', path: /^\/api\/map\/locks$/, roles: moderate, handler: lock },
    {
      method: 'POST',
      path: /^\/api\/map\/locks\/(\d{1,9})\/unlock$/,
      roles: moderate,
      handler: (ctx, match) => unlock(ctx, Number(match[1])),
    },
  ];
}

/** The current season's canvas (ADR 0021), resolved per request; never guessed. */
async function port(ctx: Ctx): Promise<MapPort> {
  return mapPort(ctx.env, await currentCanvas(ctx.env, ctx.now));
}

const MAX_PLAYER = 128;

/** The account id of a nickname (accounts database, case-insensitive), or null. */
async function accountOf(env: Env, nickname: string): Promise<string | null> {
  const row = await env.ACCOUNTS.prepare('SELECT id FROM users WHERE nickname_key = ?')
    .bind(nickname.toLowerCase())
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function nicknameOf(env: Env, player: string): Promise<string | null> {
  const row = await env.ACCOUNTS.prepare('SELECT nickname FROM users WHERE id = ?')
    .bind(player)
    .first<{ nickname: string | null }>();
  return row?.nickname ?? null;
}

/**
 * A 400 answer when typed text for the audit log (a reason, a lock note) quotes personal data:
 * an address, a long number, or a name `player` holds or held (ADR 0023), else null.
 */
async function namesSomeone(
  ctx: Ctx,
  texts: readonly string[],
  player?: string,
): Promise<Response | null> {
  const names = player === undefined ? [] : await namesOf(ctx.env.ACCOUNTS, { player });
  for (const value of texts) {
    const problem = personalData(value, names);
    if (problem) return json({ error: 'invalid', detail: problem }, 400);
  }
  return null;
}

async function cell(ctx: Ctx): Promise<Response> {
  const params = new URL(ctx.request.url).searchParams;
  const x = Number(params.get('x') ?? '');
  const y = Number(params.get('y') ?? '');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    return json({ error: 'invalid', detail: 'x and y' }, 400);
  }
  const p = await port(ctx);
  const who = await p.lastWriter(x, y);
  if (!who) return json({ canvas: p.canvas, x, y, writer: null });
  const [player, team] = who;
  return json({
    canvas: p.canvas,
    x,
    y,
    writer: { player, team, nickname: await nicknameOf(ctx.env, player) },
  });
}

/**
 * A rollback filter from a request body: `player` (account id) or `nickname`, `area`, `from`
 * and `to` (ms). The canvas checks the rest; a response when this cannot be one.
 */
async function filterOf(
  ctx: Ctx,
  body: Record<string, unknown>,
): Promise<RollbackFilter | Response> {
  const { player, nickname, area, from, to } = body;
  const filter: { player?: string; area?: Rect; from?: number; to?: number } = {};
  if (typeof nickname === 'string' && nickname.trim() !== '') {
    const id = await accountOf(ctx.env, nickname.trim());
    if (!id) return json({ error: 'not_found', detail: 'no account has that nickname' }, 404);
    filter.player = id;
  } else if (player !== undefined && player !== null && player !== '') {
    if (typeof player !== 'string' || player.length > MAX_PLAYER) {
      return json({ error: 'invalid', detail: 'player' }, 400);
    }
    filter.player = player;
  }
  if (area !== undefined && area !== null) filter.area = area as Rect;
  if (from !== undefined && from !== null) filter.from = from as number;
  if (to !== undefined && to !== null) filter.to = to as number;
  return filter;
}

/**
 * A rollback without a player undoes everyone's ops in its area and time range: an area as
 * large as the map is the whole map back in time. Owners only, whatever the area.
 */
async function wholeMapRefused(ctx: Ctx, filter: RollbackFilter): Promise<Response | null> {
  if (filter.player !== undefined) return null;
  if (ctx.admin.role === 'owner') return null;
  await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, {
    action: 'access.refused',
    target: `POST ${new URL(ctx.request.url).pathname}`,
    reason: `role ${ctx.admin.role}: a rollback of every player's ops`,
    outcome: 'forbidden',
  });
  return json({ error: 'role', detail: "a rollback of every player's ops needs an owner" }, 403);
}

/** The dry run: changes nothing on the map, so it writes no audit row. */
async function preview(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.request);
  if (!body) return json({ error: 'invalid', detail: 'body' }, 400);
  const filter = await filterOf(ctx, body);
  if (filter instanceof Response) return filter;
  const denied = await wholeMapRefused(ctx, filter);
  if (denied) return denied;
  const p = await port(ctx);
  // A moderator's preview never replaces a job an owner started (the canvas checks).
  const status = await p.preview(filter, ctx.admin.role);
  if (status.state === 'failed') {
    return json(
      { canvas: p.canvas, error: status.error, status },
      status.error === 'invalid' ? 400 : 409,
    );
  }
  return json({ canvas: p.canvas, filter, status });
}

async function apply(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const job = body.job;
  if (typeof job !== 'string' || job.length === 0 || job.length > 64) {
    return json({ error: 'invalid', detail: 'job' }, 400);
  }
  if (typeof body.filter !== 'object' || body.filter === null) {
    return json({ error: 'invalid', detail: 'filter' }, 400);
  }
  // The filter the preview answered with: the canvas applies the job only if it is that one.
  const filter = body.filter as RollbackFilter;
  const denied = await wholeMapRefused(ctx, filter);
  if (denied) return denied;
  const named = await namesSomeone(
    ctx,
    [reason],
    typeof filter.player === 'string' ? filter.player : undefined,
  );
  if (named) return named;
  const p = await port(ctx);
  const result = await acting(
    ctx,
    { action: 'map.rollback', target: p.canvas, reason, before: { job, filter } },
    async () => {
      const r = await p.apply(job, filter);
      return r.ok ? { ...r, nudged: await p.refreshSockets() } : r;
    },
    (r) =>
      r.ok
        ? {
            outcome: 'ok',
            after: { record: r.record, preview: summary(r.preview), nudged: r.nudged },
          }
        : { outcome: r.reason, after: { detail: r.detail } },
  );
  if (result.ok) {
    return json({
      canvas: p.canvas,
      record: result.record,
      preview: result.preview,
      nudged: result.nudged,
    });
  }
  return json({ error: result.reason, detail: result.detail }, 409);
}

/** What the audit row keeps of a preview: the numbers, not the sample. */
function summary(preview: Extract<RollbackResult, { ok: true }>['preview']) {
  const { sample: _sample, ...rest } = preview;
  return rest;
}

async function lock(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const note = text(body.note, 64) || reason.slice(0, 64);
  const named = await namesSomeone(ctx, [reason, note]);
  if (named) return named;
  const request = { area: body.area as Rect, until: (body.until ?? null) as number | null, note };
  const p = await port(ctx);
  const result = await acting(
    ctx,
    { action: 'map.lock', target: p.canvas, reason, after: request },
    async () => {
      const r = await p.lock(request);
      return r.ok ? { ...r, nudged: await p.refreshSockets() } : r;
    },
    (r) =>
      r.ok
        ? { outcome: 'ok', after: { ...r.lock, nudged: r.nudged } }
        : { outcome: r.reason, after: request },
  );
  if (result.ok) return json({ canvas: p.canvas, lock: result.lock, locks: result.locks });
  return json({ error: result.reason }, result.reason === 'invalid' ? 400 : 409);
}

async function unlock(ctx: Ctx, id: number): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const named = await namesSomeone(ctx, [parsed.reason]);
  if (named) return named;
  const p = await port(ctx);
  const before = (await p.locks()).locks.find((l) => l.id === id) ?? null;
  const result = await acting(
    ctx,
    { action: 'map.unlock', target: p.canvas, reason: parsed.reason, before },
    async () => {
      const r = await p.unlock(id);
      return r.ok ? { ...r, nudged: await p.refreshSockets() } : r;
    },
    (r) => ({ outcome: r.ok ? 'ok' : r.reason, after: { id, nudged: r.ok && r.nudged } }),
  );
  if (result.ok) return json({ canvas: p.canvas, locks: result.locks });
  return json({ error: result.reason }, 404);
}
