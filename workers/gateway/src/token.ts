// Signed tokens (ADR 0015): sessions, the OAuth state cookie, CSRF tokens and the dev
// provider's codes. Kept out of the Worker entry (index.ts): workerd accepts only handlers
// and Durable Object classes as exports of the main module.

/**
 * HMAC-SHA-256 keys from the SESSION_KEYS secret: `kid:secret` entries separated by spaces,
 * commas or newlines. The first entry signs; every entry verifies. Rotation is two puts of
 * the one secret: prepend the new key, then drop the old one once its tokens have expired
 * (30 days for sessions, see session.ts).
 */
export interface KeyRing {
  readonly signer: { readonly kid: string; readonly key: CryptoKey };
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

/** What a token is for. Mixed into the MAC, so a token for one use is useless for another. */
export type Purpose = 'session' | 'oauth' | 'csrf' | 'devcode';

const KID = /^[A-Za-z0-9_-]{1,16}$/;
/** 32 bytes of base64 is 44 characters; anything shorter is a placeholder or a mistake. */
export const MIN_SECRET_LENGTH = 32;

const rings = new Map<string, Promise<KeyRing | null>>();

/** The key ring for this secret, or null when it is missing or malformed (fail closed). */
export function keyRing(spec: string | undefined): Promise<KeyRing | null> {
  if (!spec) return Promise.resolve(null);
  let ring = rings.get(spec);
  if (!ring) {
    ring = buildRing(spec);
    rings.set(spec, ring);
  }
  return ring;
}

async function buildRing(spec: string): Promise<KeyRing | null> {
  const entries = spec.split(/[\s,]+/).filter(Boolean);
  const keys = new Map<string, CryptoKey>();
  let signer: KeyRing['signer'] | null = null;
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const kid = entry.slice(0, colon);
    const secret = entry.slice(colon + 1);
    if (colon < 1 || !KID.test(kid) || secret.length < MIN_SECRET_LENGTH || keys.has(kid)) {
      console.error('SESSION_KEYS: an entry is malformed; no sessions can be issued');
      return null;
    }
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    keys.set(kid, key);
    signer ??= { kid, key };
  }
  return signer ? { signer, keys } : null;
}

/** `kid.payload.mac`, payload and mac in base64url. */
export async function seal(ring: KeyRing, purpose: Purpose, payload: object): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const { kid, key } = ring.signer;
  const mac = await crypto.subtle.sign('HMAC', key, macInput(purpose, kid, body));
  return `${kid}.${body}.${base64url(new Uint8Array(mac))}`;
}

/**
 * The payload of a token sealed for this purpose by any key of the ring, or null. Checks the
 * signature only: callers check the times they care about.
 */
export async function unseal<T>(
  ring: KeyRing,
  purpose: Purpose,
  token: string | null | undefined,
): Promise<T | null> {
  if (!token || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [kid, body, mac] = parts as [string, string, string];
  const key = ring.keys.get(kid);
  const signature = fromBase64url(mac);
  if (!key || !signature) return null;
  // subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify('HMAC', key, signature, macInput(purpose, kid, body));
  if (!ok) return null;
  const bytes = fromBase64url(body);
  if (!bytes) return null;
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof payload === 'object' && payload !== null ? (payload as T) : null;
  } catch {
    return null;
  }
}

function macInput(purpose: Purpose, kid: string, body: string): Uint8Array<ArrayBuffer> {
  return utf8(`bp-token-v1|${purpose}|${kid}|${body}`);
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** `n` random bytes in base64url: state, nonce, PKCE verifier, session ids. */
export function randomToken(n = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(n)));
}

/** The PKCE S256 challenge of a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
