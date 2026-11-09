// Account API for the client (ADR 0015, 0016): who am I, nickname, unlink, sign out.
// Every state change needs the session's CSRF token in X-CSRF-Token and a same-site Origin.

import {
  identitiesOf,
  revokeSessions,
  setNickname,
  type User,
  unlinkIdentity,
} from './accounts.ts';
import { type Context, foreignOrigin, json, readCookie } from './http.ts';
import { kickPlayer } from './kick.ts';
import {
  blocked,
  checkShape,
  type NicknameProblem,
  RENAME_EVERY_MS,
  reservedName,
  suggestNickname,
  wordList,
} from './nickname.ts';
import { playerCap } from './player-cap.ts';
import { enabledProviders, isProviderId, type ProviderId } from './providers.ts';
import {
  nextSeason,
  type SeasonView,
  STAGE0_CANVAS,
  seasonForWatching,
  viewOf as seasonView,
} from './seasons.ts';
import {
  checkSession,
  clearSessionCookie,
  csrfToken,
  current,
  LINK_WINDOW_MS,
  liveUser,
  RENEW_AFTER_MS,
  readSession,
  renewed,
  type Session,
  sessionCookie,
  validCsrf,
} from './session.ts';
import { creatableAt, joinableAt, type MyTeam, myTeam, type Place, placeOf } from './teams.ts';
import { tilesUrl } from './tiles.ts';
import { trustScore } from './trust.ts';

/** What the sign-in screen needs to know about this deployment. */
export interface AuthConfig {
  readonly providers: readonly ProviderId[];
  /** Turnstile site key (public); null when sign-up is not configured. */
  readonly turnstileSiteKey: string | null;
  /** Local dev: a signed-out page may play under a dev id (`?player=`). */
  readonly devGuest: boolean;
  /**
   * The canvas in the public tiles bucket (ADR 0009, 0018): pages watch the map from there
   * and open a socket only to play. Null: no CDN, pages keep a socket.
   */
  readonly tilesUrl: string | null;
  /**
   * The season being played (ADR 0021): its canvas, times and state; null before the first
   * season is registered (the Stage 0 canvas plays, with no end).
   */
  readonly season: SeasonView | null;
  /**
   * The next season to start (ADR 0021), so an open page asks again just after its start and
   * reloads onto its canvas; null when none is registered (or the registry could not be read).
   */
  readonly nextSeason: { readonly canvas: string; readonly startsAt: number } | null;
  /**
   * Present (true) when the registry could not be read and nothing was cached: `season` and
   * `tilesUrl` are then the Stage 0 guess for watching, not the current season.
   */
  readonly seasonGuessed?: true;
  /**
   * How many may play at once (ADR 0039); null: no cap. With the manifest's player count, a
   * page that sees the map full watches instead of opening a socket that would be turned away.
   */
  readonly playerCap: number | null;
}

export interface UserView {
  readonly nickname: string | null;
  /** From the provider's name, to pre-fill the first nickname. */
  readonly suggestedNickname: string;
  /** When the nickname may change next (ms); null while none is chosen. */
  readonly nicknameChangeableAt: number | null;
  readonly email: string | null;
  /** Until when (ms) this sign-in may link another provider; then sign in again first. */
  readonly linkUntil: number;
  readonly identities: readonly { readonly provider: ProviderId; readonly name: string | null }[];
  /** The account's team (ADR 0020), or null. */
  readonly team: MyTeam | null;
  /** When joining or switching to a team is allowed next (ms); 0: now. */
  readonly teamJoinableAt: number;
  /** When creating a team is allowed next (ms); 0: now (unless it owns one). */
  readonly teamCreatableAt: number;
}

export interface Me {
  readonly signedIn: boolean;
  readonly user: UserView | null;
  readonly csrf: string | null;
  /**
   * How long (ms) the session token in the cookie, as renewed by this response, has left;
   * null when signed out. Sockets stop playing then, so the page reconnects before it.
   * Relative, so a page whose clock is off still counts it right.
   */
  readonly sessionExpiresIn: number | null;
  readonly config: AuthConfig;
  /**
   * Present (true) when the cookie's account is banned (ADR 0023): the page shows the
   * suspended state instead of a plain sign-out. The answer is otherwise a signed-out one.
   */
  readonly suspended?: true;
}

async function authConfig(ctx: Context): Promise<AuthConfig> {
  // Signed-out pages need no D1 beyond this: with the registry unreadable they still get a map
  // to watch (the last answer, or Stage 0's) instead of a 503.
  const [{ season, guessed }, cap] = await Promise.all([
    seasonForWatching(ctx.env.ACCOUNTS, ctx.now),
    playerCap(ctx.env.ACCOUNTS, ctx.now),
  ]);
  const next = nextSeason(ctx.now);
  return {
    playerCap: cap,
    providers: ctx.origin ? enabledProviders(ctx).map((p) => p.id) : [],
    turnstileSiteKey: ctx.env.TURNSTILE_SITE_KEY || null,
    devGuest: ctx.dev,
    tilesUrl: tilesUrl(ctx, season?.canvas ?? STAGE0_CANVAS),
    season: season ? seasonView(ctx, season) : null,
    nextSeason: next ? { canvas: next.canvas, startsAt: next.startsAt } : null,
    ...(guessed ? { seasonGuessed: true as const } : {}),
  };
}

async function viewOf(
  ctx: Context,
  session: Session,
  user: User,
  place: Place | null,
): Promise<UserView> {
  const identities = await identitiesOf(ctx.env.ACCOUNTS, user.id);
  const changed = user.nickname === null ? null : (user.nickname_changed_at ?? 0);
  return {
    nickname: user.nickname,
    suggestedNickname: suggestNickname(identities[0]?.display_name ?? null),
    nicknameChangeableAt: changed === null ? null : changed + RENAME_EVERY_MS,
    email: user.email,
    linkUntil: session.a + LINK_WINDOW_MS,
    identities: identities.map((i) => ({ provider: i.provider, name: i.display_name })),
    team: myTeam(place, user.id),
    teamJoinableAt: joinableAt(place),
    teamCreatableAt: creatableAt(place),
  };
}

/**
 * The account view, with a new token in the cookie when the old one is due, or when the
 * nickname or the team it carries changed (sockets play with the token's team, ADR 0020).
 */
export async function signedIn(
  ctx: Context,
  session: Session,
  user: User,
  status = 200,
): Promise<Response> {
  const nickname = user.nickname !== null;
  const place = await placeOf(ctx.env.ACCOUNTS, user.id);
  const team = myTeam(place, user.id)?.id ?? 0;
  const cookies: string[] = [];
  let token = session;
  if (
    !current(ctx, session) ||
    ctx.now - session.i > RENEW_AFTER_MS ||
    session.n !== (nickname ? 1 : 0) ||
    (session.t ?? 0) !== team
  ) {
    // The trust score is read afresh with every token (ADR 0026): D1 is read here anyway.
    token = renewed(ctx, session, nickname, team, await trustScore(ctx, user));
    cookies.push(await sessionCookie(ctx, token));
  }
  const body: Me = {
    signedIn: true,
    user: await viewOf(ctx, session, user, place),
    csrf: await csrfToken(ctx, session),
    sessionExpiresIn: Math.max(0, token.e - ctx.now),
    config: await authConfig(ctx),
  };
  return json(body, status, cookies);
}

async function signedOut(ctx: Context, clear: boolean, suspended = false): Promise<Response> {
  const body: Me = {
    signedIn: false,
    user: null,
    csrf: null,
    sessionExpiresIn: null,
    config: await authConfig(ctx),
    ...(suspended ? { suspended: true as const } : {}),
  };
  return json(body, 200, clear ? [clearSessionCookie(ctx)] : []);
}

/**
 * GET /api/me: the account (renewing the session token when due) or signed out. A session
 * whose account is banned is signed out with `suspended: true`, which the page shows as the
 * suspended state (ADR 0023); a deleted or signed-out-everywhere one is a plain sign-out, even
 * when the account is also banned: a session already ended learns nothing more about it.
 */
export async function me(ctx: Context): Promise<Response> {
  const session = await readSession(ctx);
  if (!session) return signedOut(ctx, readCookie(ctx, 'session') !== null);
  const checked = await checkSession(ctx, session);
  // Only a session that would be good but for the ban is told about it.
  if (!('user' in checked)) return signedOut(ctx, true, checked.refused === 'banned');
  return signedIn(ctx, session, checked.user);
}

/** A signed-in, same-site request with the session's CSRF token, or the response refusing it. */
export async function authorised(
  ctx: Context,
): Promise<{ session: Session; user: User } | Response> {
  if (ctx.request.method !== 'POST') return json({ error: 'method' }, 405);
  if (foreignOrigin(ctx)) return json({ error: 'origin' }, 403);
  const session = await readSession(ctx);
  if (!session) return json({ error: 'signed_out' }, 401);
  if (!(await validCsrf(ctx, session, ctx.request.headers.get('X-CSRF-Token')))) {
    return json({ error: 'csrf' }, 403);
  }
  const user = await liveUser(ctx, session);
  if (!user) return json({ error: 'signed_out' }, 401, [clearSessionCookie(ctx)]);
  return { session, user };
}

function problem(error: NicknameProblem, extra: Record<string, unknown> = {}): Response {
  const status =
    error === 'taken' ? 409 : error === 'too_soon' ? 429 : error === 'unavailable' ? 503 : 400;
  return json({ error, ...extra }, status);
}

/**
 * POST /api/nickname {nickname}: the first choice, or a rename once per 30 days. After a
 * moderator's reset the account has no nickname (ADR 0023), so its next choice is a first one.
 */
export async function chooseNickname(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  const { session, user } = auth;
  const body = (await ctx.request.json().catch(() => null)) as { nickname?: unknown } | null;
  const checked = checkShape(body?.nickname);
  if (!checked.ok) return problem(checked.problem);
  if (checked.nickname === user.nickname) return signedIn(ctx, session, user);
  if (user.nickname !== null) {
    const next = (user.nickname_changed_at ?? 0) + RENAME_EVERY_MS;
    if (ctx.now < next) return problem('too_soon', { retryAt: next });
  }
  if (reservedName(checked.nickname)) return problem('blocked');
  const list = await wordList(ctx.env.MODERATION, ctx.dev, ctx.now);
  if (!list) return problem('unavailable');
  if (blocked(checked.nickname, list)) return problem('blocked');
  const set = await setNickname(
    ctx.env.ACCOUNTS,
    user.id,
    checked.nickname,
    checked.key,
    ctx.now,
    RENAME_EVERY_MS,
  );
  if (set === 'taken') return problem('taken');
  if (set === 'blocked') return problem('blocked');
  if (set === 'too_soon') {
    // Another rename won the race; its time is the one to wait from.
    return problem('too_soon', { retryAt: ctx.now + RENAME_EVERY_MS });
  }
  return signedIn(ctx, session, {
    ...user,
    nickname: checked.nickname,
    nickname_changed_at: ctx.now,
  });
}

/** POST /api/identities/:provider/unlink: never the last one. */
export async function unlink(ctx: Context, provider: string): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) return auth;
  if (!isProviderId(provider)) return json({ error: 'provider' }, 404);
  const result = await unlinkIdentity(ctx.env.ACCOUNTS, auth.user.id, provider);
  if (result === 'last') return json({ error: 'last_identity' }, 409);
  if (result === 'missing') return json({ error: 'not_linked' }, 404);
  return signedIn(ctx, auth.session, auth.user);
}

/**
 * POST /auth/logout {everywhere?}: clears the cookie; `everywhere` also stops every other
 * session of the account from being renewed and kicks its open sockets (ADR 0023), so they
 * stop playing at once instead of when their tokens expire. A failed kick falls back to that.
 */
export async function logout(ctx: Context): Promise<Response> {
  const auth = await authorised(ctx);
  if (auth instanceof Response) {
    // Without a valid session there is nothing to end; still clear whatever cookie is there.
    return auth.status === 401 ? json({ ok: true }, 200, [clearSessionCookie(ctx)]) : auth;
  }
  const body = (await ctx.request.json().catch(() => null)) as { everywhere?: unknown } | null;
  if (body?.everywhere === true) {
    await revokeSessions(ctx.env.ACCOUNTS, auth.user.id, ctx.now);
    // After the revocation, so no renewal can hand out a token the kick does not cover.
    await kickPlayer(ctx.env, auth.user.id, ctx.now);
  }
  return json({ ok: true }, 200, [clearSessionCookie(ctx)]);
}
