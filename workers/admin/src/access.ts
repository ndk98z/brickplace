// Cloudflare Access application tokens (ADR 0022). Access puts a signed JWT in the
// `Cf-Access-Jwt-Assertion` header of every request it lets through. A header alone proves
// nothing (anyone can send one to an address Access does not cover), so the Worker checks the
// RS256 signature against the team's published keys, then the issuer (the team domain), the
// audience (the application's AUD tag) and the token's times, before it trusts any claim.

export const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';

/** Where Access publishes its signing keys, under the team domain. */
export const CERTS_PATH = '/cdn-cgi/access/certs';

/** Clock difference tolerated on `exp`, `nbf` and `iat` (s). */
const LEEWAY_S = 30;
/** Keys are fetched again after this long (ms); Access rotates them every few weeks. */
const KEYS_TTL_MS = 10 * 60 * 1000;
/** A token naming an unknown key refetches at most this often (ms), so forged kids cannot. */
const REFETCH_MS = 30 * 1000;
/** Keys already known stay usable this long when a refetch fails (ms). */
const KEYS_GRACE_MS = 6 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 16 * 1024;

export interface AccessSettings {
  /** https://<team>.cloudflareaccess.com: the tokens' issuer and the keys' home. */
  readonly teamDomain: string;
  /** The Access application's AUD tag. */
  readonly audience: string;
}

/** Who Access says is asking: a person signed in through the team's identity provider. */
export interface AccessIdentity {
  /** Lower case. */
  readonly email: string;
  /** Access's user id; '' never passes (service tokens carry no person). */
  readonly sub: string;
}

export type AccessResult =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | { readonly ok: false; readonly reason: AccessFailure };

export type AccessFailure =
  | 'missing'
  | 'malformed'
  | 'algorithm'
  | 'unknown_key'
  | 'keys_unavailable'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'not_yet_valid'
  | 'not_a_person';

/** Reads the team's key set: returns the parsed JSON body of the certs URL. */
export type KeySetFetcher = (url: string) => Promise<unknown>;

/** The settings, or null when they are missing or malformed (the area then stays closed). */
export function accessSettings(
  teamDomain: string | undefined,
  audience: string | undefined,
): AccessSettings | null {
  const aud = audience?.trim() ?? '';
  if (!teamDomain || !/^[A-Za-z0-9]{8,128}$/.test(aud)) return null;
  try {
    const url = new URL(teamDomain);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.username) {
      return null;
    }
    return { teamDomain: url.origin, audience: aud };
  } catch {
    return null;
  }
}

const defaultFetcher: KeySetFetcher = async (url) => {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Access keys: HTTP ${response.status}`);
  return response.json();
};

interface Entry {
  keys: Map<string, CryptoKey>;
  /** Last successful fetch. */
  fetchedAt: number;
  /** Last fetch started, successful or not: the throttle counts from here. */
  attemptedAt: number;
  /** Whether the last fetch failed. */
  failed: boolean;
  pending: Promise<void> | null;
}

/**
 * The team's verification keys by `kid`, cached per isolate. The set is fetched again once
 * stale, or for a `kid` it does not have (key rotation), but at most once per REFETCH_MS
 * whatever the outcome: neither a certs outage nor a stream of made-up kids makes every
 * request fetch.
 */
export class AccessKeys {
  private readonly teams = new Map<string, Entry>();

  constructor(private readonly fetcher: KeySetFetcher = defaultFetcher) {}

  async key(teamDomain: string, kid: string, now: number): Promise<CryptoKey | null> {
    let entry = this.teams.get(teamDomain);
    if (!entry) {
      entry = {
        keys: new Map(),
        fetchedAt: Number.NEGATIVE_INFINITY,
        attemptedAt: Number.NEGATIVE_INFINITY,
        failed: false,
        pending: null,
      };
      this.teams.set(teamDomain, entry);
    }
    const stale = now - entry.fetchedAt >= KEYS_TTL_MS;
    const unknown = !entry.keys.has(kid);
    if ((stale || unknown) && now - entry.attemptedAt >= REFETCH_MS) {
      entry.attemptedAt = now;
      this.refresh(teamDomain, entry, now);
    }
    // A fetch under way (this request's or another's) is waited for.
    if (entry.pending) await entry.pending;
    const known = entry.keys.get(kid);
    // During a certs outage known keys keep working for a while, then nothing does.
    if (known && now - entry.fetchedAt < KEYS_GRACE_MS) return known;
    if (known || entry.failed) throw new Error('Access keys unavailable');
    return null;
  }

  private refresh(teamDomain: string, entry: Entry, now: number): void {
    entry.pending ??= (async () => {
      try {
        const body = await this.fetcher(`${teamDomain}${CERTS_PATH}`);
        entry.keys = await importKeys(body);
        entry.fetchedAt = now;
        entry.failed = false;
      } catch (error) {
        console.error('admin: could not fetch the Access keys', error);
        entry.failed = true;
      } finally {
        entry.pending = null;
      }
    })();
  }
}

async function importKeys(body: unknown): Promise<Map<string, CryptoKey>> {
  const list = (body as { keys?: unknown })?.keys;
  if (!Array.isArray(list)) throw new Error('Access keys: no key list');
  const keys = new Map<string, CryptoKey>();
  for (const jwk of list as JsonWebKey[] & { kid?: string }[]) {
    const kid = (jwk as { kid?: unknown }).kid;
    if (typeof kid !== 'string' || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(kid, key);
  }
  return keys;
}

/**
 * Checks an Access application token. Nothing in it is read as a claim before its signature
 * has been checked with a key the team published.
 */
export async function verifyAccessToken(
  token: string | null,
  settings: AccessSettings,
  keys: AccessKeys,
  now: number,
): Promise<AccessResult> {
  const fail = (reason: AccessFailure): AccessResult => ({ ok: false, reason });
  if (!token) return fail('missing');
  if (token.length > MAX_TOKEN_LENGTH) return fail('malformed');
  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed');
  const [head, body, signature] = parts as [string, string, string];
  const header = decodeJson(head);
  if (!header) return fail('malformed');
  if (header.alg !== 'RS256') return fail('algorithm');
  if (typeof header.kid !== 'string' || header.kid.length === 0) return fail('malformed');
  let key: CryptoKey | null;
  try {
    key = await keys.key(settings.teamDomain, header.kid, now);
  } catch (error) {
    console.error('admin: no usable Access keys', error);
    return fail('keys_unavailable');
  }
  if (!key) return fail('unknown_key');
  const signed = new TextEncoder().encode(`${head}.${body}`);
  const bytes = decodeBase64Url(signature);
  if (!bytes) return fail('malformed');
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes, signed);
  if (!valid) return fail('signature');

  const claims = decodeJson(body);
  if (!claims) return fail('malformed');
  if (claims.iss !== settings.teamDomain) return fail('issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(settings.audience)) return fail('audience');
  const seconds = now / 1000;
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S <= seconds) return fail('expired');
  for (const start of [claims.nbf, claims.iat]) {
    if (start !== undefined && (typeof start !== 'number' || start - LEEWAY_S > seconds)) {
      return fail('not_yet_valid');
    }
  }
  // Application tokens of people only (`type` app, which Access always sets on them; `org`
  // is the global session token); a service token has an empty `sub` and no email.
  if (claims.type !== 'app') return fail('not_a_person');
  const { email, sub } = claims;
  if (typeof email !== 'string' || !email.includes('@') || email.length > 254) {
    return fail('not_a_person');
  }
  if (typeof sub !== 'string' || sub.length === 0) return fail('not_a_person');
  return { ok: true, identity: { email: email.toLowerCase(), sub } };
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(part);
  if (!bytes) return null;
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(part: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
