// Cloudflare Turnstile, checked server-side before a new account is created (ADR 0015) and
// when a suspicious account must show it is a person (ADR 0026).

import type { Context } from './http.ts';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** The widget's action on the sign-in screen; a token from another widget does not count. */
export const TURNSTILE_ACTION = 'signin';
/** The widget's action in the "confirm you are human" dialog of a playing page (ADR 0026). */
export const CHALLENGE_ACTION = 'challenge';

/**
 * True when the widget's token is good. Fails closed: no secret outside dev, a network error
 * or a malformed answer all count as not passed. Outside dev the token must also come from
 * our own site (hostname) and the widget asked for (`action`: sign-in unless told), so a
 * token solved on another site that shares the site key, or for another widget, is refused.
 * Dev without a secret skips the check, so local sign-in works offline; the example .dev.vars
 * uses Cloudflare's always-pass test key, whose answers carry neither.
 */
export async function passedTurnstile(
  ctx: Context,
  token: string | null,
  action: string = TURNSTILE_ACTION,
): Promise<boolean> {
  const secret = ctx.env.TURNSTILE_SECRET_KEY;
  if (!secret) return ctx.dev;
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  const ip = ctx.request.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  try {
    const response = await fetch(SITEVERIFY, { method: 'POST', body: form });
    if (!response.ok) return false;
    const outcome = (await response.json()) as {
      success?: unknown;
      hostname?: unknown;
      action?: unknown;
    };
    if (outcome.success !== true) return false;
    if (ctx.dev) return true;
    const expected = ctx.origin ? new URL(ctx.origin).hostname : null;
    return outcome.hostname === expected && outcome.action === action;
  } catch (error) {
    console.error('turnstile siteverify failed', error);
    return false;
  }
}
