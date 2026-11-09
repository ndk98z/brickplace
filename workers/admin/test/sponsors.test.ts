import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { httpsUrl, logoInfo, logoProblem, MAX_LOGO_BYTES } from '../src/sponsors.ts';
import { call, claims, envIn, type FakeAccess, fakeAccess, grant, serveKeys } from './support.ts';

// Sponsors and site links from the admin area (ADR 0038): owners change them, moderators read
// them; logos are checked here and stored in the private bucket under their hash.

const testEnv = env as unknown as Env;
const accounts = testEnv.ACCOUNTS;
const OWNER = 'sponsor-owner@example.test';
const MOD = 'sponsor-mod@example.test';
const DAY = 86_400_000;
const START = Date.UTC(2030, 0, 1);
let access: FakeAccess;

beforeAll(async () => {
  access = await fakeAccess('sponsor-key');
  await grant(OWNER, 'owner');
  await grant(MOD, 'moderator');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await accounts.batch([
    accounts.prepare('DELETE FROM sponsors'),
    accounts.prepare('DELETE FROM site_links'),
    accounts.prepare('DELETE FROM seasons'),
  ]);
});

async function as(who: string, path: string, body?: unknown) {
  serveKeys(access.jwks);
  const token = await access.sign(claims(who, Date.now()));
  return call(envIn('staging'), path, { token, body });
}

/** A season far ahead, so it never becomes the current canvas of other tests. */
async function season(canvas = 's9') {
  await accounts
    .prepare('INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES (?, ?, ?, 0)')
    .bind(canvas, START, START + 60 * DAY)
    .run();
}

/** A PNG's first bytes: the signature and an IHDR of `w` × `h`. */
function png(w: number, h: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(
    [...'IHDR'].map((c) => c.charCodeAt(0)),
    12,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(16, w);
  view.setUint32(20, h);
  return bytes;
}

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function sponsor(extra: Record<string, unknown> = {}) {
  return {
    canvas: 's9',
    name: 'Sponsor A',
    href: 'https://sponsor-a.example',
    logo: null,
    showsFrom: START,
    showsUntil: START + 30 * DAY,
    featured: false,
    hidden: false,
    reason: 'signed',
    ...extra,
  };
}

async function listed() {
  const response = await as(MOD, '/api/sponsors');
  expect(response.status).toBe(200);
  return (await response.json()) as {
    sponsors: { id: number; name: string; featured: boolean; position: number }[];
    links: { sponsorInfo: string | null; kofi: string | null };
  };
}

describe('logo checks', () => {
  it('reads PNG and WebP sizes from their headers', () => {
    expect(logoInfo(png(640, 240))).toEqual({ kind: 'png', w: 640, h: 240 });
    const webp = new Uint8Array(32);
    webp.set(
      [...'RIFF'].map((c) => c.charCodeAt(0)),
      0,
    );
    webp.set(
      [...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
      8,
    );
    webp.set([0x7f, 0x02, 0x00, 0xef, 0x00, 0x00], 24);
    expect(logoInfo(webp)).toEqual({ kind: 'webp', w: 640, h: 240 });
    // Lossy (VP8): a key frame's start code, then 14-bit width and height.
    const lossy = new Uint8Array(32);
    lossy.set(
      [...'RIFF'].map((c) => c.charCodeAt(0)),
      0,
    );
    lossy.set(
      [...'WEBPVP8 '].map((c) => c.charCodeAt(0)),
      8,
    );
    lossy.set([0x9d, 0x01, 0x2a, 0x80, 0x02, 0xf0, 0x00], 23);
    expect(logoInfo(lossy)).toEqual({ kind: 'webp', w: 640, h: 240 });
    // Lossless (VP8L): the 0x2f signature, then 14-bit width-1 and height-1 packed in bits.
    const lossless = new Uint8Array(32);
    lossless.set(
      [...'RIFF'].map((c) => c.charCodeAt(0)),
      0,
    );
    lossless.set(
      [...'WEBPVP8L'].map((c) => c.charCodeAt(0)),
      8,
    );
    const w = 639;
    const h = 239;
    lossless.set(
      [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f],
      20,
    );
    expect(logoInfo(lossless)).toEqual({ kind: 'webp', w: 640, h: 240 });
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(64),
    );
    expect(logoInfo(svg)).toBeNull();
  });

  it('refuses files too small, too large or of another type', () => {
    expect(logoProblem(png(320, 120))).toBeNull();
    expect(logoProblem(png(40, 120))).toContain('each side');
    expect(logoProblem(png(4096, 120))).toContain('each side');
    expect(logoProblem(png(320, 120, MAX_LOGO_BYTES + 1))).toContain('larger');
    expect(logoProblem(new Uint8Array(64))).toBe('not a PNG or WebP');
  });

  it('refuses animated logos: APNG and animated WebP', () => {
    // An APNG: IHDR (13 bytes of data), then an acTL chunk before any IDAT.
    const apng = png(320, 120, 80);
    apng.set([0, 0, 0, 8, ...[...'acTL'].map((c) => c.charCodeAt(0))], 33);
    expect(logoProblem(apng)).toContain('animated');
    const still = png(320, 120, 80);
    still.set([0, 0, 0, 0, ...[...'IDAT'].map((c) => c.charCodeAt(0))], 33);
    expect(logoProblem(still)).toBeNull();
    const webp = new Uint8Array(32);
    webp.set(
      [...'RIFF'].map((c) => c.charCodeAt(0)),
      0,
    );
    webp.set(
      [...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
      8,
    );
    webp.set([0x7f, 0x02, 0x00, 0xef, 0x00, 0x00], 24);
    expect(logoProblem(webp)).toBeNull();
    webp[20] = 0x02;
    expect(logoProblem(webp)).toContain('animated');
  });

  it('takes only https links with a host and no password', () => {
    expect(httpsUrl(' https://a.example/x ')).toBe('https://a.example/x');
    expect(httpsUrl('http://a.example')).toBeNull();
    expect(httpsUrl('https://user:pw@a.example')).toBeNull();
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
    expect(httpsUrl('https://localhost')).toBeNull();
  });
});

describe('sponsor routes', () => {
  it('lets moderators read but not change', async () => {
    await season();
    expect((await as(MOD, '/api/sponsors', sponsor())).status).toBe(403);
    const made = await as(OWNER, '/api/sponsors', sponsor());
    const id = ((await made.json()) as { sponsor: { id: number } }).sponsor.id;
    for (const [path, body] of [
      ['/api/sponsors/logo', { data: b64(png(320, 120)) }],
      [`/api/sponsors/${id}/move`, { by: 1 }],
      [`/api/sponsors/${id}/delete`, { reason: 'x' }],
      ['/api/site-links', { kofi: 'https://ko-fi.com/x', reason: 'x' }],
    ] as const) {
      expect((await as(MOD, path, body)).status, path).toBe(403);
    }
    await accounts.prepare('DELETE FROM sponsors').run();
    expect((await listed()).sponsors).toEqual([]);
  });

  it('stores a logo once under its hash and serves it back', async () => {
    const bytes = png(320, 120);
    const first = await as(OWNER, '/api/sponsors/logo', { data: b64(bytes) });
    expect(first.status).toBe(200);
    const { logo } = (await first.json()) as { logo: string };
    expect(logo).toMatch(/^logos\/[0-9a-f]{64}\.png$/);
    const again = (await (await as(OWNER, '/api/sponsors/logo', { data: b64(bytes) })).json()) as {
      logo: string;
    };
    expect(again.logo).toBe(logo);
    const served = await as(MOD, `/api/sponsors/${logo}`);
    expect(served.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
    const bad = await as(OWNER, '/api/sponsors/logo', { data: b64(png(10, 10)) });
    expect(bad.status).toBe(400);
  });

  it('adds, edits, features, moves and deletes, with an audit row each', async () => {
    await season();
    const a = await as(OWNER, '/api/sponsors', sponsor({ featured: true }));
    expect(a.status).toBe(200);
    const b = await as(OWNER, '/api/sponsors', sponsor({ name: 'Sponsor B' }));
    const idB = ((await b.json()) as { sponsor: { id: number } }).sponsor.id;
    // Featuring B unfeatures A.
    expect(
      (await as(OWNER, '/api/sponsors', sponsor({ id: idB, name: 'Sponsor B', featured: true })))
        .status,
    ).toBe(200);
    let list = (await listed()).sponsors;
    expect(list.map((s) => [s.name, s.featured])).toEqual([
      ['Sponsor A', false],
      ['Sponsor B', true],
    ]);
    expect((await as(OWNER, `/api/sponsors/${idB}/move`, { by: -1 })).status).toBe(200);
    list = (await listed()).sponsors;
    expect(list.map((s) => s.name)).toEqual(['Sponsor B', 'Sponsor A']);
    expect((await as(OWNER, `/api/sponsors/${idB}/delete`, { reason: 'ended' })).status).toBe(200);
    expect((await listed()).sponsors.map((s) => s.name)).toEqual(['Sponsor A']);
    const { results } = await testEnv.ADMIN_DB.prepare(
      "SELECT action FROM audit_log WHERE action LIKE 'sponsor.%' AND actor = ? ORDER BY id",
    )
      .bind(OWNER)
      .all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'sponsor.create',
        'sponsor.update',
        'sponsor.move',
        'sponsor.delete',
      ]),
    );
  });

  it('refuses dates outside the season, unknown seasons, bad links and missing logos', async () => {
    await season();
    const outside = await as(OWNER, '/api/sponsors', sponsor({ showsUntil: START + 90 * DAY }));
    expect(outside.status).toBe(400);
    expect((await as(OWNER, '/api/sponsors', sponsor({ canvas: 'nope' }))).status).toBe(404);
    expect((await as(OWNER, '/api/sponsors', sponsor({ href: 'http://x.example' }))).status).toBe(
      400,
    );
    expect((await as(OWNER, '/api/sponsors', sponsor({ reason: '' }))).status).toBe(400);
    const missing = sponsor({ logo: `logos/${'c'.repeat(64)}.png` });
    expect((await as(OWNER, '/api/sponsors', missing)).status).toBe(400);
  });

  it('sets and clears the site links', async () => {
    const set = await as(OWNER, '/api/site-links', {
      sponsorInfo: 'https://example.org/sponsor',
      kofi: 'https://ko-fi.com/example',
      reason: 'new pages',
    });
    expect(set.status).toBe(200);
    expect((await listed()).links).toEqual({
      sponsorInfo: 'https://example.org/sponsor',
      kofi: 'https://ko-fi.com/example',
    });
    await as(OWNER, '/api/site-links', { kofi: null, reason: 'closed' });
    expect((await listed()).links.kofi).toBeNull();
    expect(
      (await as(OWNER, '/api/site-links', { kofi: 'http://ko-fi.com/x', reason: 'x' })).status,
    ).toBe(400);
  });
});
