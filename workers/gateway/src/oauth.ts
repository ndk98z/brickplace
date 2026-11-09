// The sign-in flow (ADR 0015): POST /auth/:provider/start sends the browser to the provider,
// GET /auth/:provider/callback brings it back with a code we trade for the identity.

import {
  banned,
  createUser,
  linkIdentity,
  recentlyDeleted,
  recordSignIn,
  userByIdentity,
} from './accounts.ts';
import {
  type Context,
  cookie,
  foreignOrigin,
  json,
  readCookie,
  redirect,
  safeReturnPath,
} from './http.ts';
import { type ProviderId, providerFor } from './providers.ts';
import {
  current,
  liveUser,
  mayLink,
  newSession,
  REJOIN_AFTER_DELETE_MS,
  readSession,
  sessionCookie,
  validCsrf,
} from './session.ts';
import { pkceChallenge, randomToken, seal, unseal } from './token.ts';
import { trustScore } from './trust.ts';
import { passedTurnstile } from './turnstile.ts';

/** The flow's state, in a signed HttpOnly cookie for the round trip to the provider. */
interface OAuthState {
  readonly p: ProviderId;
  /** `state` sent to the provider; the callback must bring back the same value. */
  readonly st: string;
  /** PKCE code verifier. */
  readonly v: string;
  /** OIDC nonce (Google puts it in the ID token). */
  readonly nn: string;
  /** Path to return to. */
  readonly r: string;
  /** 1 when Turnstile passed at the start: needed to create an account. */
  readonly h: 0 | 1;
  /** Linking: the signed-in user the identity is added to. */
  readonly l?: string;
  readonly e: number;
}

/** How long the round trip to the provider may take. */
const FLOW_TTL_MS = 10 * 60 * 1000;

/** Callback failures, shown by the client from `?auth_error=`. */
export type AuthError =
  | 'not_configured'
  | 'provider'
  | 'state'
  | 'cancelled'
  | 'session'
  | 'turnstile'
  | 'banned'
  | 'taken'
  | 'provider_taken'
  | 'recently_deleted'
  | 'unavailable';

export function redirectUri(origin: string, provider: ProviderId): string {
  return `${origin}/auth/${provider}/callback`;
}

/**
 * Starts a sign-in (or, with mode=link and the CSRF token, a link to the signed-in account).
 * A form POST, so the Turnstile token travels in the body; Turnstile is checked here, but
 * only required once the callback finds the person has no account yet.
 */
export async function start(ctx: Context, providerId: string): Promise<Response> {
  if (ctx.request.method !== 'POST') return json({ error: 'method' }, 405);
  if (foreignOrigin(ctx)) return json({ error: 'origin' }, 403);
  if (!ctx.origin || !ctx.ring) return json({ error: 'not_configured' }, 503);
  const provider = providerFor(ctx, providerId);
  if (!provider) return json({ error: 'provider' }, 404);
  const form = await ctx.request.formData().catch(() => null);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === 'string' ? value : null;
  };
  const returnTo = safeReturnPath(field('return'));
  let link: string | undefined;
  if (field('mode') === 'link') {
    const session = await readSession(ctx);
    if (
      !session ||
      !current(ctx, session) ||
      !(await validCsrf(ctx, session, field('csrf'))) ||
      !mayLink(ctx, session) ||
      !(await liveUser(ctx, session))
    ) {
      return redirect('/?auth_error=session');
    }
    link = session.u;
  }
  const human = link === undefined && (await passedTurnstile(ctx, field('turnstile')));
  const state: OAuthState = {
    p: provider.id,
    st: randomToken(),
    v: randomToken(),
    nn: randomToken(),
    r: returnTo,
    h: human ? 1 : 0,
    ...(link === undefined ? {} : { l: link }),
    e: ctx.now + FLOW_TTL_MS,
  };
  const location = provider.authorizeUrl({
    redirectUri: redirectUri(ctx.origin, provider.id),
    state: state.st,
    codeChallenge: await pkceChallenge(state.v),
    nonce: state.nn,
  });
  const sealed = await seal(ctx.ring, 'oauth', state);
  return redirect(location, [cookie(ctx, 'oauth', sealed, FLOW_TTL_MS / 1000)]);
}

/** The provider's redirect back: checks the flow, trades the code, signs the person in. */
export async function callback(ctx: Context, providerId: string): Promise<Response> {
  const clear = cookie(ctx, 'oauth', '', 0);
  const fail = (error: AuthError) => redirect(`/?auth_error=${error}`, [clear]);
  if (!ctx.origin || !ctx.ring) return fail('not_configured');
  const provider = providerFor(ctx, providerId);
  if (!provider) return fail('provider');
  const params = ctx.url.searchParams;
  const state = await unseal<OAuthState>(ctx.ring, 'oauth', readCookie(ctx, 'oauth'));
  if (params.has('error')) return fail('cancelled');
  const code = params.get('code');
  if (
    !state ||
    !(state.e > ctx.now) ||
    state.p !== provider.id ||
    params.get('state') !== state.st ||
    !code
  ) {
    return fail('state');
  }
  let identity: Awaited<ReturnType<typeof provider.exchange>>;
  try {
    identity = await provider.exchange({
      code,
      redirectUri: redirectUri(ctx.origin, provider.id),
      codeVerifier: state.v,
      nonce: state.nn,
    });
  } catch (error) {
    console.error(`${provider.id} sign-in failed`, error);
    return fail('provider');
  }
  const db = ctx.env.ACCOUNTS;
  // Single use: the cookie and the authorize URL of a finished flow cannot be replayed to
  // create more accounts on one Turnstile pass. Claimed only once the provider has given a
  // real identity (so no D1 write without a valid code), before any account is read or
  // written.
  try {
    if (!(await claimFlow(db, state.st, state.e, ctx.now))) return fail('state');
  } catch (error) {
    console.error('accounts unavailable during sign-in', error);
    return fail('unavailable');
  }
  try {
    if (state.l !== undefined) {
      // Checked again: the account may have been banned or signed out everywhere while the
      // browser was at the provider.
      const session = await readSession(ctx);
      if (
        !session ||
        session.u !== state.l ||
        !mayLink(ctx, session) ||
        !(await liveUser(ctx, session))
      ) {
        return fail('session');
      }
      const linked = await linkIdentity(db, state.l, provider.id, identity, ctx.now);
      if (linked === 'taken' || linked === 'provider_taken') return fail(linked);
      return redirect(withParam(state.r, 'linked', provider.id), [clear]);
    }
    let user = await userByIdentity(db, provider.id, identity.subject);
    if (user) {
      if (await banned(db, user.id, ctx.now)) return fail('banned');
      await recordSignIn(db, user.id, provider.id, identity, ctx.now);
    } else {
      if (state.h !== 1) return fail('turnstile');
      // A deleted account's tokens still play for up to an hour: no second player from the
      // same provider account until they have expired (ADR 0019).
      if (
        await recentlyDeleted(
          db,
          ctx.ring,
          provider.id,
          identity.subject,
          ctx.now,
          REJOIN_AFTER_DELETE_MS,
        )
      ) {
        return fail('recently_deleted');
      }
      user = await createUser(db, provider.id, identity, ctx.now);
    }
    const session = newSession(ctx, user.id, user.nickname !== null, await trustScore(ctx, user));
    return redirect(state.r, [clear, await sessionCookie(ctx, session)]);
  } catch (error) {
    console.error('accounts unavailable during sign-in', error);
    return fail('unavailable');
  }
}

/**
 * Records a flow's state as used; false when it already was. Also drops rows of flows that
 * have expired, which could not be finished anyway.
 */
async function claimFlow(
  db: D1Database,
  state: string,
  expiresAt: number,
  now: number,
): Promise<boolean> {
  const [, inserted] = await db.batch([
    db.prepare('DELETE FROM oauth_flows WHERE expires_at < ?').bind(now),
    db
      .prepare('INSERT OR IGNORE INTO oauth_flows (state, expires_at) VALUES (?, ?)')
      .bind(state, expiresAt),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

function withParam(path: string, name: string, value: string): string {
  const url = new URL(path, 'https://site.invalid');
  url.searchParams.set(name, value);
  return `${url.pathname}${url.search}`;
}
