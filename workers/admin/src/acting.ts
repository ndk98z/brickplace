import { audit } from './audit.ts';
import { json, readBody, text } from './http.ts';
import type { Admin, Role } from './identity.ts';
import type { Env } from './index.ts';

// What every admin route shares (ADR 0022): the request context, the route shape, the typed
// reason every change needs, and `acting()`, which audits an action before and after it. Kept
// apart from routes.ts so route modules (moderation-routes.ts) import it without a cycle.

export interface Ctx {
  readonly env: Env;
  readonly request: Request;
  readonly admin: Admin;
  readonly now: number;
}

export type Handler = (ctx: Ctx, match: RegExpExecArray) => Promise<Response>;

export interface Route {
  readonly method: 'GET' | 'POST';
  readonly path: RegExp;
  readonly roles: readonly Role[];
  readonly handler: Handler;
}

/** The body with a non-empty reason, or a 400 response. */
export async function withReason(
  ctx: Ctx,
): Promise<{ body: Record<string, unknown>; reason: string } | Response> {
  const body = await readBody(ctx.request);
  if (!body) return json({ error: 'invalid', detail: 'body' }, 400);
  const reason = text(body.reason);
  if (!reason) return json({ error: 'invalid', detail: 'a reason is required' }, 400);
  return { body, reason };
}

/**
 * Runs an action that acts on the game, with an audit row before it (outcome `requested`, so
 * a failure after the call cannot leave the action unrecorded) and one after it with how it
 * ended. A call that throws is recorded as `error` and answered 503 by the entry.
 */
export async function acting<T>(
  ctx: Ctx,
  entry: { action: string; target: string; reason: string; before?: unknown; after?: unknown },
  run: () => Promise<T>,
  ended: (result: T) => { outcome: string; after: unknown },
): Promise<T> {
  await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, { ...entry, outcome: 'requested' });
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, { ...entry, outcome: 'error' });
    throw error;
  }
  await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, { ...entry, ...ended(result) });
  return result;
}
