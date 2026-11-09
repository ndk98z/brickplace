// Session tokens and CSRF tokens (ADR 0015). Sessions are not stored: the cookie holds a
// signed token, and D1 is read only when one is renewed.

import { banned, type User, userById } from './accounts.ts';
import { type Context, cookie, readCookie } from './http.ts';
import { randomToken, seal, unseal } from './token.ts';

/** How long a token lets a socket play without the server looking at the account again. */
export const SESSION_TTL_MS = 60 * 60 * 1000;
/**
 * After an account is deleted, no new account is made from its provider identities for this
 * long: until the deleted account's last token has expired, so one provider account never
 * plays as two players at once (ADR 0019). The token lifetime, not an abuse threshold.
 */
export const REJOIN_AFTER_DELETE_MS = SESSION_TTL_MS;
/** /api/me reissues a token older than this, after checking the account in D1. */
export const RENEW_AFTER_MS = 10 * 60 * 1000;
/** A sign-in lasts this long (cookie lifetime and renewal limit); then OAuth again. */
export const SIGN_IN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Linking another provider needs a sign-in at most this old: a cookie copied long ago
 * cannot add an attacker's identity to the account (ADR 0015).
 */
export const LINK_WINDOW_MS = 10 * 60 * 1000;

/** The token's payload; short keys keep the cookie small. Times in ms. */
export interface Session {
  /** Account id (users.id); also the player id sockets play under. */
  readonly u: string;
  /** Random per sign-in, kept across renewals: CSRF tokens are bound to it. */
  readonly s: string;
  /** When the user signed in with the provider. */
  readonly a: number;
  /** When this token was issued. */
  readonly i: number;
  /** When it stops being enough on its own (a socket then watches; /api/me renews). */
  readonly e: number;
  /** 1 once the nickname is chosen: only then does a socket play. */
  readonly n: 0 | 1;
  /**
   * The team the account was in when the token was issued (ADR 0020); absent: none. Sockets
   * opened with the token count their ops for it. A team change reissues the token.
   */
  readonly t?: number;
  /**
   * The account's trust score (0..100) when the token was issued (ADR 0026); absent when the
   * gateway had no weights. Sockets opened with the token are limited by it.
   */
  readonly r?: number;
}

export function newSession(
  ctx: Context,
  user: string,
  nickname: boolean,
  trust: number | null = null,
): Session {
  return renewed(
    ctx,
    { u: user, s: randomToken(16), a: ctx.now, i: 0, e: 0, n: 0 },
    nickname,
    0,
    trust,
  );
}

/**
 * A fresh token for this sign-in; `team` replaces the team it carries (0: none), `trust` the
 * trust score (null: none).
 */
export function renewed(
  ctx: Context,
  session: Session,
  nickname: boolean,
  team: number = session.t ?? 0,
  trust: number | null = session.r ?? null,
): Session {
  const { t: _old, r: _oldTrust, ...rest } = session;
  return {
    ...rest,
    i: ctx.now,
    e: ctx.now + SESSION_TTL_MS,
    n: nickname ? 1 : 0,
    ...(team > 0 ? { t: team } : {}),
    ...(trust !== null ? { r: trust } : {}),
  };
}

/** The Set-Cookie line carrying this session. */
export async function sessionCookie(ctx: Context, session: Session): Promise<string> {
  if (!ctx.ring) throw new Error('no session keys');
  const token = await seal(ctx.ring, 'session', session);
  const left = Math.max(0, Math.floor((session.a + SIGN_IN_MAX_AGE_MS - ctx.now) / 1000));
  return cookie(ctx, 'session', token, left);
}

export function clearSessionCookie(ctx: Context): string {
  return cookie(ctx, 'session', '', 0);
}

/**
 * The session in the cookie if its signature is good and the sign-in is not too old; it may
 * be past `e` (see `current`). Null otherwise.
 */
export async function readSession(ctx: Context): Promise<Session | null> {
  if (!ctx.ring) return null;
  const session = await unseal<Session>(ctx.ring, 'session', readCookie(ctx, 'session'));
  if (!session || typeof session.u !== 'string' || typeof session.s !== 'string') return null;
  if (!Number.isFinite(session.a) || !Number.isFinite(session.e)) return null;
  if (ctx.now > session.a + SIGN_IN_MAX_AGE_MS || session.a > ctx.now + 60_000) return null;
  return session;
}

/** True while the token is enough on its own, without a D1 check. */
export function current(ctx: Context, session: Session): boolean {
  return ctx.now < session.e;
}

/** The CSRF token for a session: sent by /api/me, required on every state change. */
export async function csrfToken(ctx: Context, session: Session): Promise<string> {
  if (!ctx.ring) throw new Error('no session keys');
  return seal(ctx.ring, 'csrf', { s: session.s });
}

/** True when `token` (X-CSRF-Token header or a form field) belongs to this session. */
export async function validCsrf(
  ctx: Context,
  session: Session,
  token: string | null,
): Promise<boolean> {
  if (!ctx.ring || !token) return false;
  const payload = await unseal<{ s: string }>(ctx.ring, 'csrf', token);
  return payload?.s === session.s;
}

/**
 * The account behind a session, read from D1: null when it is gone, banned, or signed out
 * everywhere since this sign-in. Every renewal and every account change goes through it.
 */
export async function liveUser(ctx: Context, session: Session): Promise<User | null> {
  const checked = await checkSession(ctx, session);
  return 'user' in checked ? checked.user : null;
}

/**
 * Like liveUser, but says why a session is refused: its account is `gone`, the session was
 * `revoked` ("sign out everywhere" since this sign-in), or the account is `banned`. Checked in
 * that order, so `banned` means the session would be good but for the ban.
 */
export async function checkSession(
  ctx: Context,
  session: Session,
): Promise<{ readonly user: User } | { readonly refused: 'gone' | 'revoked' | 'banned' }> {
  const db = ctx.env.ACCOUNTS;
  const user = await userById(db, session.u);
  if (!user) return { refused: 'gone' };
  if (session.a < user.sessions_valid_after) return { refused: 'revoked' };
  if (await banned(db, user.id, ctx.now)) return { refused: 'banned' };
  return { user };
}

/**
 * True while this sign-in is recent enough to link another provider or delete the account
 * (the same window: both are what a copied cookie must not be able to do).
 */
export function mayLink(ctx: Context, session: Session): boolean {
  return ctx.now - session.a < LINK_WINDOW_MS;
}
