// Small HTTP helpers for the auth routes: the request context, cookies, JSON and redirects.

import type { Env } from './index.ts';
import { type KeyRing, keyRing, randomToken } from './token.ts';

/** What every auth route needs to know about the request it serves. */
export interface Context {
  readonly env: Env;
  readonly request: Request;
  readonly url: URL;
  /**
   * The site's public origin, which every redirect URI is built from (they must match the
   * provider apps exactly). PUBLIC_ORIGIN outside dev; in dev the request's own origin.
   * Null when it is not configured: sign-in is then closed.
   */
  readonly origin: string | null;
  /** Cookies get Secure and the __Host- prefix; false only for plain-http local dev. */
  readonly secure: boolean;
  /** Null when SESSION_KEYS is missing or malformed: nothing can be signed (fail closed). */
  readonly ring: KeyRing | null;
  readonly now: number;
  readonly dev: boolean;
}

export async function contextFor(request: Request, env: Env, now = Date.now()): Promise<Context> {
  const url = new URL(request.url);
  const dev = env.ENVIRONMENT === 'dev';
  const configured = env.PUBLIC_ORIGIN ? safeOrigin(env.PUBLIC_ORIGIN) : null;
  const origin = configured ?? (dev ? url.origin : null);
  const secure = !dev || (origin ?? url.origin).startsWith('https:');
  const ring = (await keyRing(env.SESSION_KEYS)) ?? (dev ? await devRing() : null);
  return { env, request, url, origin, secure, ring, now, dev };
}

let devKeys: Promise<KeyRing | null> | null = null;

/**
 * Dev without SESSION_KEYS (a .dev.vars made before it existed): a random key per isolate,
 * so local sign-in still works and sessions end when `wrangler dev` restarts.
 */
function devRing(): Promise<KeyRing | null> {
  devKeys ??= (() => {
    console.warn('SESSION_KEYS is not set: using a random dev key (see .dev.vars.example)');
    return keyRing(`dev:${randomToken(32)}`);
  })();
  return devKeys;
}

function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.hostname === 'localhost' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * True when a state-changing request plainly comes from another site: its Origin header
 * names one that is not ours. Browsers send Origin on every POST and WebSocket handshake.
 * Dev skips it (the Vite dev server proxies from another port).
 */
export function foreignOrigin(ctx: Context): boolean {
  if (ctx.dev) return false;
  const sent = ctx.request.headers.get('Origin');
  return sent !== null && sent !== (ctx.origin ?? ctx.url.origin);
}

export type CookieBase = 'session' | 'oauth';

export function cookieName(ctx: Context, base: CookieBase): string {
  return ctx.secure ? `__Host-bp_${base}` : `bp_${base}`;
}

export function readCookie(ctx: Context, base: CookieBase): string | null {
  const name = cookieName(ctx, base);
  for (const part of (ctx.request.headers.get('Cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * HttpOnly, SameSite=Lax (sent on the top-level redirect back from the provider, not on
 * cross-site subrequests or POSTs), Path=/ and, unless plain-http dev, Secure. A max age of
 * 0 deletes the cookie.
 */
export function cookie(ctx: Context, base: CookieBase, value: string, maxAgeSeconds: number) {
  const secure = ctx.secure ? '; Secure' : '';
  return `${cookieName(ctx, base)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(body: unknown, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers({ ...NO_STORE, 'Content-Type': 'application/json' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}

export function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ ...NO_STORE, Location: location });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      ...NO_STORE,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    },
  });
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * A path on this site to return to after sign-in: relative, not protocol-relative, short.
 * Anything else becomes `/`, so the redirect can never leave the site.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || value.length > 200) return '/';
  return /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : '/';
}
