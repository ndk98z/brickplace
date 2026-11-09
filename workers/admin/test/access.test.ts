import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AccessKeys,
  type AccessSettings,
  accessSettings,
  verifyAccessToken,
} from '../src/access.ts';
import { AUD, b64url, claims, type FakeAccess, fakeAccess, TEAM } from './support.ts';

const NOW = 1_800_000_000_000;
const settings: AccessSettings = { teamDomain: TEAM, audience: AUD };

describe('Access token verification', () => {
  let access: FakeAccess;
  let other: FakeAccess;
  let fetched: string[];
  const keysFor = (jwks: unknown) => {
    fetched = [];
    return new AccessKeys(async (url) => {
      fetched.push(url);
      return jwks;
    });
  };

  beforeAll(async () => {
    access = await fakeAccess('unit-key');
    // Same kid, different key: what a forger who copied the kid would hold.
    other = await fakeAccess('unit-key');
  });

  const verify = (token: string | null, keys = keysFor(access.jwks), now = NOW) =>
    verifyAccessToken(token, settings, keys, now);

  it('accepts a token signed by a team key, for this audience, now', async () => {
    const token = await access.sign(claims('Owner@Example.test', NOW));
    expect(await verify(token)).toEqual({
      ok: true,
      identity: { email: 'owner@example.test', sub: 'sub-Owner@Example.test' },
    });
    expect(fetched).toEqual([`${TEAM}/cdn-cgi/access/certs`]);
  });

  it('accepts an audience given as a plain string', async () => {
    const token = await access.sign(claims('a@example.test', NOW, { aud: AUD }));
    expect(await verify(token)).toMatchObject({ ok: true });
  });

  it('refuses a missing or malformed header', async () => {
    expect(await verify(null)).toEqual({ ok: false, reason: 'missing' });
    expect(await verify('')).toEqual({ ok: false, reason: 'missing' });
    expect(await verify('a.b')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verify('!!.!!.!!')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a token whose signature does not match a team key', async () => {
    const forged = await other.sign(claims('owner@example.test', NOW));
    expect(await verify(forged)).toEqual({ ok: false, reason: 'signature' });
    // Claims changed after signing.
    const token = await access.sign(claims('mod@example.test', NOW));
    const [head, , sig] = token.split('.');
    const swapped = `${head}.${b64url(JSON.stringify(claims('owner@example.test', NOW)))}.${sig}`;
    expect(await verify(swapped)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses other algorithms, unsigned tokens included', async () => {
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'unit-key' }))}.${b64url(
      JSON.stringify(claims('owner@example.test', NOW)),
    )}.`;
    expect(await verify(none)).toEqual({ ok: false, reason: 'algorithm' });
    const hs = await access.sign(claims('owner@example.test', NOW), { alg: 'HS256' });
    expect(await verify(hs)).toEqual({ ok: false, reason: 'algorithm' });
  });

  it('refuses a key the team never published', async () => {
    const token = await access.sign(claims('owner@example.test', NOW), { kid: 'elsewhere' });
    expect(await verify(token)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('refuses another issuer or audience', async () => {
    const issuer = await access.sign(
      claims('owner@example.test', NOW, { iss: 'https://evil.cloudflareaccess.com' }),
    );
    expect(await verify(issuer)).toEqual({ ok: false, reason: 'issuer' });
    const audience = await access.sign(
      claims('owner@example.test', NOW, { aud: ['b'.repeat(64)] }),
    );
    expect(await verify(audience)).toEqual({ ok: false, reason: 'audience' });
    const none = await access.sign(claims('owner@example.test', NOW, { aud: undefined }));
    expect(await verify(none)).toEqual({ ok: false, reason: 'audience' });
  });

  it('refuses expired and future tokens, with a small clock leeway', async () => {
    const token = await access.sign(claims('owner@example.test', NOW));
    expect(await verify(token, keysFor(access.jwks), NOW + 320_000)).toMatchObject({ ok: true });
    expect(await verify(token, keysFor(access.jwks), NOW + 331_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await verify(token, keysFor(access.jwks), NOW - 31_000)).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
    const noExp = await access.sign(claims('owner@example.test', NOW, { exp: undefined }));
    expect(await verify(noExp)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses service tokens and other token types: admins are people', async () => {
    const service = await access.sign(
      claims('x@example.test', NOW, { email: undefined, sub: '', common_name: 'id.access' }),
    );
    expect(await verify(service)).toEqual({ ok: false, reason: 'not_a_person' });
    const org = await access.sign(claims('owner@example.test', NOW, { type: 'org' }));
    expect(await verify(org)).toEqual({ ok: false, reason: 'not_a_person' });
    // Access always names the type of an application token: one without it is refused.
    const untyped = await access.sign(claims('owner@example.test', NOW, { type: undefined }));
    expect(await verify(untyped)).toEqual({ ok: false, reason: 'not_a_person' });
  });

  it('does not refetch per request during an outage, whatever kids tokens name', async () => {
    let calls = 0;
    let up = false;
    const keys = new AccessKeys(async () => {
      calls += 1;
      if (!up) throw new Error('down');
      return access.jwks;
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) {
      const token = await access.sign(claims('a@example.test', NOW), { kid: `made-up-${i}` });
      expect(await verifyAccessToken(token, settings, keys, NOW + i * 1000)).toEqual({
        ok: false,
        reason: 'keys_unavailable',
      });
    }
    const real = await access.sign(claims('a@example.test', NOW));
    expect(await verifyAccessToken(real, settings, keys, NOW + 10_000)).toMatchObject({
      reason: 'keys_unavailable',
    });
    expect(calls).toBe(1);
    // Back up: the next attempt is allowed once the throttle has passed.
    up = true;
    const later = NOW + 31_000;
    const fresh = await access.sign(claims('a@example.test', later));
    expect(await verifyAccessToken(fresh, settings, keys, later)).toMatchObject({ ok: true });
    expect(calls).toBe(2);
    errors.mockRestore();
  });

  it('refetches the key set for a new kid, but not on every request', async () => {
    const keys = keysFor(access.jwks);
    await verify(await access.sign(claims('a@example.test', NOW)), keys, NOW);
    const unknown = await access.sign(claims('a@example.test', NOW), { kid: 'rotated' });
    await verify(unknown, keys, NOW + 1000);
    await verify(unknown, keys, NOW + 2000);
    // One fetch at start; a new kid within REFETCH_MS of it does not fetch again.
    expect(fetched).toHaveLength(1);
    await verify(unknown, keys, NOW + 31_000);
    expect(fetched).toHaveLength(2);
  });

  it('fails closed when the keys cannot be read, unless a known key is recent', async () => {
    let up = true;
    const keys = new AccessKeys(async () => {
      if (!up) throw new Error('down');
      return access.jwks;
    });
    const token = await access.sign(claims('a@example.test', NOW));
    expect(await verifyAccessToken(token, settings, keys, NOW)).toMatchObject({ ok: true });
    up = false;
    // Past the cache's lifetime: the refetch fails but the known key still works for a while.
    const later = NOW + 11 * 60 * 1000;
    const fresh = await access.sign(claims('a@example.test', later));
    expect(await verifyAccessToken(fresh, settings, keys, later)).toMatchObject({ ok: true });
    const muchLater = NOW + 7 * 60 * 60 * 1000;
    const old = await access.sign(claims('a@example.test', muchLater));
    expect(await verifyAccessToken(old, settings, keys, muchLater)).toEqual({
      ok: false,
      reason: 'keys_unavailable',
    });
    const empty = new AccessKeys(async () => {
      throw new Error('down');
    });
    expect(await verifyAccessToken(token, settings, empty, NOW)).toEqual({
      ok: false,
      reason: 'keys_unavailable',
    });
  });

  it('ignores keys that are not RSA signing keys', async () => {
    const keys = keysFor({ keys: [{ ...access.jwks.keys[0], kty: 'EC' }] });
    const token = await access.sign(claims('a@example.test', NOW));
    expect(await verify(token, keys)).toEqual({ ok: false, reason: 'unknown_key' });
  });
});

describe('Access settings', () => {
  it('needs an https team origin and an AUD tag', () => {
    expect(accessSettings(TEAM, AUD)).toEqual({ teamDomain: TEAM, audience: AUD });
    expect(accessSettings(`${TEAM}/`, ` ${AUD} `)).toEqual({ teamDomain: TEAM, audience: AUD });
    expect(accessSettings('', AUD)).toBeNull();
    expect(accessSettings(TEAM, '')).toBeNull();
    expect(accessSettings(undefined, undefined)).toBeNull();
    expect(accessSettings('http://team.cloudflareaccess.com', AUD)).toBeNull();
    expect(accessSettings(`${TEAM}/cdn-cgi`, AUD)).toBeNull();
    expect(accessSettings('not a url', AUD)).toBeNull();
    expect(accessSettings(TEAM, 'short')).toBeNull();
  });
});
