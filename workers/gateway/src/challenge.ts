// Turnstile on suspicious activity (ADR 0026). When an account's bot signals cross the
// policy's threshold, FanoutDO closes its socket with 4428 and refuses its moves; the page
// shows a Turnstile widget and posts its token here, which lifts the challenge on the current
// season's fanout. The same plumbing as the sign-up check (turnstile.ts), another action.

import { authorised } from './api.ts';
import { type Context, json } from './http.ts';
import { currentCanvas, STAGE0_CANVAS } from './seasons.ts';
import { fanoutName, shardCount, shardOf } from './socket.ts';
import { CHALLENGE_ACTION, passedTurnstile } from './turnstile.ts';

/** What a canvas name may look like (the season registry's CHECK, realtime CANVAS_NAME). */
const CANVAS_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * POST /api/challenge {turnstile, canvas?}: a signed-in account (CSRF, same site) shows it is
 * a person. The challenge is lifted on the current season's fanout and, when the page names
 * another canvas it plays (its socket opened before a season change), on that one too, if it
 * is Stage 0's or a registered season's: otherwise a page on the previous canvas would meet
 * 4428 again. 403 `turnstile` when the token does not pass (fails closed: outside dev a
 * deployment without a Turnstile secret passes nobody, as at sign-up); 503 when a fanout
 * cannot be reached, so the page may try again. `cleared` says whether a challenge was pending.
 */
export async function passChallenge(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  const body = (await ctx.request.json().catch(() => null)) as {
    turnstile?: unknown;
    canvas?: unknown;
  } | null;
  const token = typeof body?.turnstile === 'string' ? body.turnstile : null;
  if (!(await passedTurnstile(ctx, token, CHALLENGE_ACTION))) {
    return json({ error: 'turnstile' }, 403);
  }
  const asked =
    typeof body?.canvas === 'string' && CANVAS_NAME.test(body.canvas) ? body.canvas : null;
  try {
    const canvases = [await currentCanvas(ctx.env.ACCOUNTS, ctx.now)];
    if (asked && asked !== canvases[0] && (await knownCanvas(ctx.env.ACCOUNTS, asked))) {
      canvases.push(asked);
    }
    let cleared = false;
    // The shard the account plays on (ADR 0028), which holds its challenge.
    const shard = shardOf(auth.user.id, shardCount(ctx.env.FANOUT_SHARDS));
    for (const canvas of canvases) {
      const fanout = ctx.env.FANOUT.get(ctx.env.FANOUT.idFromName(fanoutName(canvas, shard)));
      cleared = (await fanout.clearChallenge(auth.user.id)).cleared || cleared;
    }
    return json({ ok: true, cleared });
  } catch (error) {
    console.error('challenge could not be lifted', error);
    return json({ error: 'unavailable' }, 503);
  }
}

/** True for Stage 0's canvas and every canvas in the season registry. */
async function knownCanvas(db: D1Database, canvas: string): Promise<boolean> {
  if (canvas === STAGE0_CANVAS) return true;
  const row = await db
    .prepare('SELECT 1 AS found FROM seasons WHERE canvas = ?')
    .bind(canvas)
    .first();
  return row !== null;
}
