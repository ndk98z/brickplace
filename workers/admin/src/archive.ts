import type { Rect } from '@brickplace/core';
import type { Removal, RemovalsResult, ScheduleResult, SeasonPhase } from '@brickplace/game';
import { acting, type Ctx, type Route, withReason } from './acting.ts';
import { audit } from './audit.ts';
import { json } from './http.ts';
import type { Role } from './identity.ts';
import type { Env } from './index.ts';
import { namesOf } from './moderation.ts';
import { personalData } from './moderation-routes.ts';
import { canvasStub, STAGE0_CANVAS } from './ports.ts';

// A season's archive from the admin area (ADR 0021, 0024): the archive-only removals the seal
// leaves out (CanvasDO.setRemovals), and a "seal now" request (CanvasDO.requestSeal). Removals
// are for content found after the end, when a live rollback is no longer possible; until the
// seal starts they can be added and dropped. Each change goes through `acting` (audit rows
// before and after the call) with a reason that names no one. Moderators may add or drop a
// removal limited to one player; one without a player (every player's ops in an area) needs an
// owner, as a rollback does (ADR 0024 §8). Sealing early is the owner's alone: it ends the
// window for any later removal and drops the season's player ids for good.

/** A season's archive as the canvas tells it. */
export interface ArchiveView {
  readonly canvas: string;
  readonly phase: SeasonPhase;
  readonly endsAt: number | null;
  /** The season's last seq once it closes; until then null. */
  readonly finalSeq: number | null;
  /** The live seq: removals cannot reach past it. */
  readonly seq: number;
  readonly sealRequested: boolean;
  readonly sealedAt: number | null;
  /** Archive-only removals, in order. */
  readonly removals: readonly Removal[];
  /** Rollbacks applied while the season was open: the seal removes their ops too. */
  readonly rollbacks: number;
}

/** The canvas's archive calls, behind an interface like the other ports. */
export interface ArchivePort {
  readonly canvas: string;
  view(): Promise<ArchiveView>;
  setRemovals(removals: readonly Removal[], expected: readonly Removal[]): Promise<RemovalsResult>;
  requestSeal(): Promise<ScheduleResult>;
}

export function archivePort(env: Env, canvas: string): ArchivePort {
  const stub = () => canvasStub(env, canvas);
  return {
    canvas,
    view: async () => {
      const s = await stub().seasonStatus();
      return {
        canvas,
        phase: s.phase,
        endsAt: s.endsAt,
        finalSeq: s.finalSeq,
        seq: s.seq,
        sealRequested: s.sealRequested,
        sealedAt: s.sealedAt,
        removals: s.removals as unknown as readonly Removal[],
        rollbacks: s.rollbacks.length,
      };
    },
    setRemovals: (removals, expected) =>
      stub().setRemovals(removals, expected) as Promise<RemovalsResult>,
    requestSeal: () => stub().requestSeal() as Promise<unknown> as Promise<ScheduleResult>,
  };
}

const CANVAS = '([a-z0-9][a-z0-9-]{0,31})';

export function archiveRoutes(moderate: readonly Role[], owner: readonly Role[]): Route[] {
  return [
    {
      method: 'GET',
      path: new RegExp(`^/api/seasons/${CANVAS}/archive$`),
      roles: moderate,
      handler: (ctx, match) => withCanvas(ctx, match[1]!, async (p) => json(await p.view())),
    },
    {
      method: 'POST',
      path: new RegExp(`^/api/seasons/${CANVAS}/removals$`),
      roles: moderate,
      handler: (ctx, match) => withCanvas(ctx, match[1]!, (p) => removals(ctx, p)),
    },
    {
      method: 'POST',
      path: new RegExp(`^/api/seasons/${CANVAS}/seal$`),
      roles: owner,
      handler: (ctx, match) => withCanvas(ctx, match[1]!, (p) => seal(ctx, p)),
    },
  ];
}

/**
 * Runs `body` on a canvas the registry knows (or the Stage 0 one): a name nobody registered
 * must never reach a Durable Object, which would create an empty canvas under it.
 */
async function withCanvas(
  ctx: Ctx,
  canvas: string,
  body: (port: ArchivePort) => Promise<Response>,
): Promise<Response> {
  if (canvas !== STAGE0_CANVAS) {
    const row = await ctx.env.ACCOUNTS.prepare('SELECT 1 AS n FROM seasons WHERE canvas = ?')
      .bind(canvas)
      .first<{ n: number }>();
    if (!row) return json({ error: 'not_found', detail: 'no season has that canvas' }, 404);
  }
  return body(archivePort(ctx.env, canvas));
}

const MAX_PLAYER = 128;

/** The account id of a nickname (accounts database, case-insensitive), or null. */
async function accountOf(env: Env, nickname: string): Promise<string | null> {
  const row = await env.ACCOUNTS.prepare('SELECT id FROM users WHERE nickname_key = ?')
    .bind(nickname.toLowerCase())
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The removal a request adds: `area` (anchor cells), `player` (account id) or `nickname`, and
 * a seq window `from`..`to`. `from` defaults to 1. `to` defaults to the season's final seq once
 * it has closed; while it is still open, to the latest seq so far (later ops are not covered:
 * name a later `to`, which is not capped until the season closes). Past the final seq it is
 * refused. The canvas checks the rest. A response when this cannot be one.
 */
async function removalOf(
  ctx: Ctx,
  body: Record<string, unknown>,
  view: ArchiveView,
): Promise<Removal | Response> {
  const { area, player, nickname, from, to } = body;
  let who: string | undefined;
  if (typeof nickname === 'string' && nickname.trim() !== '') {
    const id = await accountOf(ctx.env, nickname.trim());
    if (!id) return json({ error: 'not_found', detail: 'no account has that nickname' }, 404);
    who = id;
  } else if (player !== undefined && player !== null && player !== '') {
    if (typeof player !== 'string' || player.length > MAX_PLAYER) {
      return json({ error: 'invalid', detail: 'player' }, 400);
    }
    who = player;
  }
  if (typeof area !== 'object' || area === null) {
    return json({ error: 'invalid', detail: 'area {x, y, w, h}' }, 400);
  }
  const { x, y, w, h } = area as Record<string, unknown>;
  const last = view.finalSeq ?? view.seq;
  const removal: Removal = {
    from: from === undefined || from === null ? 1 : (from as number),
    to: to === undefined || to === null ? last : (to as number),
    area: { x, y, w, h } as Rect,
    ...(who !== undefined ? { player: who } : {}),
  };
  if (!Number.isSafeInteger(removal.to)) return json({ error: 'invalid', detail: 'to' }, 400);
  if (view.finalSeq !== null && removal.to > view.finalSeq) {
    return json({ error: 'invalid', detail: `to: at most the season's last seq ${last}` }, 400);
  }
  return removal;
}

/**
 * A removal without a player leaves every player's ops in its area out of the archive: owners
 * only, as a rollback of every player's ops (ADR 0024 §8). The refusal is audited.
 */
async function everyPlayerRefused(ctx: Ctx, removal: Removal): Promise<Response | null> {
  if (removal.player !== undefined || ctx.admin.role === 'owner') return null;
  await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, {
    action: 'access.refused',
    target: `POST ${new URL(ctx.request.url).pathname}`,
    reason: `role ${ctx.admin.role}: a removal of every player's ops`,
    outcome: 'forbidden',
  });
  return json({ error: 'role', detail: "a removal of every player's ops needs an owner" }, 403);
}

/**
 * Adds one removal (`add`) or drops one (`drop`, its index in the list read), against the list
 * the canvas holds: the canvas refuses the change (`stale`) if another admin changed it since.
 */
async function removals(ctx: Ctx, p: ArchivePort): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const view = await p.view();
  const before = view.removals;
  let next: Removal[];
  let changed: Removal;
  let action: string;
  if (body.add !== undefined) {
    if (typeof body.add !== 'object' || body.add === null) {
      return json({ error: 'invalid', detail: 'add' }, 400);
    }
    const removal = await removalOf(ctx, body.add as Record<string, unknown>, view);
    if (removal instanceof Response) return removal;
    changed = removal;
    next = [...before, removal];
    action = 'archive.removal_add';
  } else if (Number.isInteger(body.drop)) {
    const index = body.drop as number;
    const removal = before[index];
    if (!removal) return json({ error: 'not_found', detail: 'no removal at that index' }, 404);
    changed = removal;
    next = before.filter((_, i) => i !== index);
    action = 'archive.removal_drop';
  } else {
    return json({ error: 'invalid', detail: 'add or drop' }, 400);
  }
  const denied = await everyPlayerRefused(ctx, changed);
  if (denied) return denied;
  // The reason names no one, least of all the player the removal is about (ADR 0023).
  const names =
    changed.player === undefined ? [] : await namesOf(ctx.env.ACCOUNTS, { player: changed.player });
  const problem = personalData(reason, names);
  if (problem) return json({ error: 'invalid', detail: problem }, 400);
  const result = await acting(
    ctx,
    { action, target: p.canvas, reason, before: { removals: before.length }, after: changed },
    () => p.setRemovals(next, before),
    (r) => ({ outcome: r.ok ? 'ok' : r.reason, after: changed }),
  );
  if (result.ok) return json({ canvas: p.canvas, removals: next });
  const status = result.reason === 'invalid' ? 400 : 409;
  const detail = {
    invalid: 'the canvas refused that removal (seqs from 1, an area of whole cells)',
    sealed: 'sealing has started: the list is fixed',
    stale: 'another admin changed the list meanwhile; reload and try again',
  }[result.reason];
  return json({ error: result.reason, detail }, status);
}

/** Seals the season's archive at its next maintenance pass instead of 90 days after the end. */
async function seal(ctx: Ctx, p: ArchivePort): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const problem = personalData(parsed.reason, []);
  if (problem) return json({ error: 'invalid', detail: problem }, 400);
  const before = await p.view();
  if (before.phase === 'open') {
    return json({ error: 'open', detail: 'the season has not ended: end it first' }, 409);
  }
  const result = await acting(
    ctx,
    {
      action: 'archive.seal',
      target: p.canvas,
      reason: parsed.reason,
      before: { phase: before.phase, sealRequested: before.sealRequested },
    },
    () => p.requestSeal(),
    (r) =>
      r.ok
        ? { outcome: 'ok', after: { phase: r.season.phase, sealRequested: r.season.sealRequested } }
        : { outcome: r.reason, after: null },
  );
  if (result.ok) return json({ canvas: p.canvas, archive: await p.view() });
  return json({ error: result.reason, detail: 'the canvas refused the request' }, 409);
}
