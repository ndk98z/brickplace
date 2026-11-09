// OAuth 2.0 / OpenID Connect providers behind one interface (ADR 0015). Authorization code
// flow with PKCE (S256) and state everywhere; Google also gets a nonce in its ID token.

import type { Context } from './http.ts';
import { fromBase64url, pkceChallenge, unseal } from './token.ts';

export const PROVIDERS = ['google', 'reddit', 'discord', 'dev'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** What a provider tells us about the person signing in. */
export interface ProviderIdentity {
  /** The provider's stable id for the person; never their name or email. */
  readonly subject: string;
  /** Only an address the provider has verified; null otherwise (Reddit gives none). */
  readonly email: string | null;
  /** Their name there, to pre-fill the nickname. */
  readonly name: string | null;
}

export interface AuthorizeParams {
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly nonce: string;
}

export interface ExchangeParams {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly nonce: string;
}

export interface Provider {
  readonly id: ProviderId;
  authorizeUrl(params: AuthorizeParams): string;
  /** Trades the code for the identity; throws ProviderError when anything does not check out. */
  exchange(params: ExchangeParams): Promise<ProviderIdentity>;
}

export class ProviderError extends Error {}

/** Reddit refuses API calls without a descriptive User-Agent. */
const USER_AGENT = 'web:brickplace:v0 (sign-in)';
const MAX_SUBJECT = 128;
const MAX_NAME = 100;
const MAX_EMAIL = 254;

/** The providers this deployment can use: configured ones, plus the fake one in dev only. */
export function enabledProviders(ctx: Context): Provider[] {
  const { env } = ctx;
  const list: Provider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    list.push(google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, ctx.now));
  }
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
    list.push(reddit(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET));
  }
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    list.push(discord(env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET));
  }
  if (ctx.dev && ctx.ring) list.push(devProvider(ctx));
  return list;
}

export function providerFor(ctx: Context, id: string): Provider | null {
  return enabledProviders(ctx).find((p) => p.id === id) ?? null;
}

function query(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function postForm(
  url: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...headers,
    },
    body: new URLSearchParams(form).toString(),
  });
  return readJson(response, 'token');
}

async function getJson(url: string, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
  return readJson(response, 'profile');
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new ProviderError(`${what} request failed: ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) throw new ProviderError(`${what}: not JSON`);
  return body as Record<string, unknown>;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function identity(subject: unknown, email: unknown, verified: boolean, name: unknown) {
  const sub = typeof subject === 'number' ? String(subject) : text(subject, MAX_SUBJECT);
  if (!sub) throw new ProviderError('no subject');
  const address = verified ? text(email, MAX_EMAIL) : null;
  return { subject: sub, email: address, name: text(name, MAX_NAME) } satisfies ProviderIdentity;
}

function accessTokenOf(body: Record<string, unknown>): string {
  const token = body.access_token;
  if (typeof token !== 'string' || token === '') throw new ProviderError('no access token');
  return token;
}

/**
 * Google (OpenID Connect). The ID token comes straight from Google's token endpoint over TLS
 * with our client secret, so its claims are checked without verifying its signature (OIDC
 * Core 3.1.3.7, point 6); the nonce ties it to this sign-in.
 */
function google(clientId: string, clientSecret: string, now: number): Provider {
  return {
    id: 'google',
    authorizeUrl: ({ redirectUri, state, codeChallenge, nonce }) =>
      query('https://accounts.google.com/o/oauth2/v2/auth', {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }),
    async exchange({ code, redirectUri, codeVerifier, nonce }) {
      const body = await postForm('https://oauth2.googleapis.com/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      });
      const claims = jwtClaims(body.id_token);
      const issuer = claims.iss;
      if (issuer !== 'https://accounts.google.com' && issuer !== 'accounts.google.com') {
        throw new ProviderError('wrong issuer');
      }
      // OIDC Core 3.1.3.7: we must be the audience; with several audiences we must also be
      // the authorized party.
      const audience = claims.aud;
      const ours = Array.isArray(audience)
        ? audience.includes(clientId) && claims.azp === clientId
        : audience === clientId;
      if (!ours) throw new ProviderError('wrong audience');
      if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) {
        throw new ProviderError('expired ID token');
      }
      if (claims.nonce !== nonce) throw new ProviderError('wrong nonce');
      return identity(claims.sub, claims.email, claims.email_verified === true, claims.name);
    },
  };
}

function jwtClaims(token: unknown): Record<string, unknown> {
  if (typeof token !== 'string') throw new ProviderError('no ID token');
  const payload = token.split('.')[1];
  const bytes = payload ? fromBase64url(payload) : null;
  if (!bytes) throw new ProviderError('malformed ID token');
  try {
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims === 'object' && claims !== null) return claims as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  throw new ProviderError('malformed ID token');
}

/** Reddit (OAuth 2.0, no email). It ignores PKCE; the state still binds the flow. */
function reddit(clientId: string, clientSecret: string): Provider {
  return {
    id: 'reddit',
    authorizeUrl: ({ redirectUri, state, codeChallenge }) =>
      query('https://www.reddit.com/api/v1/authorize', {
        client_id: clientId,
        response_type: 'code',
        state,
        redirect_uri: redirectUri,
        duration: 'temporary',
        scope: 'identity',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }),
    async exchange({ code, redirectUri, codeVerifier }) {
      const body = await postForm(
        'https://www.reddit.com/api/v1/access_token',
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        },
        { Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
      );
      const me = await getJson('https://oauth.reddit.com/api/v1/me', accessTokenOf(body));
      return identity(me.id, null, false, me.name);
    },
  };
}

/** Discord (OAuth 2.0 with PKCE). */
function discord(clientId: string, clientSecret: string): Provider {
  return {
    id: 'discord',
    authorizeUrl: ({ redirectUri, state, codeChallenge }) =>
      query('https://discord.com/oauth2/authorize', {
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'identify email',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }),
    async exchange({ code, redirectUri, codeVerifier }) {
      const body = await postForm('https://discord.com/api/oauth2/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      });
      const me = await getJson('https://discord.com/api/users/@me', accessTokenOf(body));
      return identity(me.id, me.email, me.verified === true, me.global_name ?? me.username);
    },
  };
}

/** A code issued by the dev provider's own page (see devauth.ts). */
export interface DevCode {
  readonly sub: string;
  readonly name: string | null;
  readonly email: string | null;
  /** The PKCE challenge, nonce and redirect URI it was issued for. */
  readonly ch: string;
  readonly nn: string;
  readonly ru: string;
  readonly e: number;
}

/**
 * The fake provider, ENVIRONMENT=dev (and tests) only: a page served by the gateway itself
 * plays the provider, so the whole flow (state, PKCE, nonce, exact redirect URI, accounts,
 * nickname, sessions) runs locally without provider apps. Its codes are signed with the
 * session keys and checked exactly as a real provider would check them.
 */
function devProvider(ctx: Context): Provider {
  return {
    id: 'dev',
    authorizeUrl: ({ redirectUri, state, codeChallenge, nonce }) =>
      query(`${ctx.origin ?? ctx.url.origin}/auth/dev/authorize`, {
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        nonce,
      }),
    async exchange({ code, redirectUri, codeVerifier, nonce }) {
      const ring = ctx.ring;
      const issued = ring ? await unseal<DevCode>(ring, 'devcode', code) : null;
      if (!issued || issued.e < ctx.now) throw new ProviderError('bad or expired code');
      if (issued.ru !== redirectUri) throw new ProviderError('redirect URI mismatch');
      if (issued.ch !== (await pkceChallenge(codeVerifier))) throw new ProviderError('PKCE');
      if (issued.nn !== nonce) throw new ProviderError('wrong nonce');
      return identity(issued.sub, issued.email, issued.email !== null, issued.name);
    },
  };
}
