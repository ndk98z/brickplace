// A fake Cloudflare Access for the tests: a locally generated RSA key signs application tokens,
// and its public half is served as the team's key set (JWKS).
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import worker, { type Env } from '../src/index.ts';

export const TEAM = 'https://brickplace-test.cloudflareaccess.com';
export const AUD = 'a'.repeat(64);
export const ORIGIN = 'https://admin.brickplace.test';

export interface FakeAccess {
  readonly kid: string;
  readonly jwks: { keys: JsonWebKey[] };
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function fakeAccess(kid = 'test-key-1'): Promise<FakeAccess> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    kid,
    jwks: {
      keys: [{ kty: 'RSA', n: pub.n, e: pub.e, alg: 'RS256', kid, use: 'sig' } as JsonWebKey],
    },
    async sign(claims, header = {}) {
      const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }));
      const body = b64url(JSON.stringify(claims));
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );
      return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
    },
  };
}

/** The claims of a person's application token, valid for `now` (ms). */
export function claims(email: string, now: number, extra: Record<string, unknown> = {}) {
  const s = Math.floor(now / 1000);
  return {
    aud: [AUD],
    email,
    exp: s + 300,
    iat: s,
    nbf: s,
    iss: TEAM,
    type: 'app',
    identity_nonce: 'nonce',
    sub: `sub-${email}`,
    country: 'VN',
    ...extra,
  };
}

export function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Serves `jwks` at the team's certs URL; any other fetch fails the test. */
export function serveKeys(jwks: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify(jwks), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

/** The test Worker's env in this ENVIRONMENT, with the test team's Access settings. */
export function envIn(environment: Env['ENVIRONMENT'], extra: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    ENVIRONMENT: environment,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ...extra,
  };
}

export async function call(
  environment: Env,
  path: string,
  init: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Cf-Access-Jwt-Assertion', init.token);
  let request: Request;
  if (init.body !== undefined) {
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (!headers.has('X-BrickPlace-Admin')) headers.set('X-BrickPlace-Admin', '1');
    request = new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
    });
  } else {
    request = new Request(`${ORIGIN}${path}`, { headers });
  }
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], environment);
}

export async function grant(email: string, role: 'owner' | 'moderator') {
  const db = (env as unknown as Env).ADMIN_DB;
  await db
    .prepare(
      'INSERT OR REPLACE INTO admin_roles (email, role, granted_by, granted_at) VALUES (?, ?, ?, ?)',
    )
    .bind(email, role, 'test-setup', 0)
    .run();
}
