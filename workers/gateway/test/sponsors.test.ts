import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/index.ts';
import { LOGO_MAX_AGE, logoPath, SHOWN, sponsorList } from '../src/sponsors-api.ts';
import { Browser, envIn } from './support.ts';

// Sponsors and site links (ADR 0038): the admin area writes them, the gateway serves the ones
// showing now on the current canvas, and their logos from the private bucket.

const testEnv = env as unknown as Env;
const db = testEnv.ACCOUNTS;
const HASH = 'a'.repeat(64);

afterEach(async () => {
  await db.batch([db.prepare('DELETE FROM sponsors'), db.prepare('DELETE FROM site_links')]);
});

async function add(
  canvas: string,
  name: string,
  from: number,
  until: number,
  extra: { featured?: boolean; hidden?: boolean; position?: number; logo?: string } = {},
) {
  await db
    .prepare(
      'INSERT INTO sponsors (canvas, name, href, logo, shows_from, shows_until, featured, hidden, ' +
        'position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)',
    )
    .bind(
      canvas,
      name,
      `https://${name.toLowerCase()}.example`,
      extra.logo ?? null,
      from,
      until,
      extra.featured ? 1 : 0,
      extra.hidden ? 1 : 0,
      extra.position ?? 1,
    )
    .run();
}

describe('sponsorList', () => {
  it('shows only the canvas, the window and the visible ones, featured first', async () => {
    const now = 1_000_000;
    await add('s2', 'Late', now + 1, now + 10, { position: 1 });
    await add('s2', 'Ended', 0, now, { position: 2 });
    await add('s2', 'Hidden', 0, now + 10, { hidden: true, position: 3 });
    await add('s2', 'Second', 0, now + 10, { position: 5 });
    await add('s2', 'First', 0, now + 10, { position: 4, logo: `logos/${HASH}.png` });
    await add('s2', 'Star', 0, now + 10, { featured: true, position: 9 });
    await add('s3', 'Other', 0, now + 10);
    const list = await sponsorList(db, 's2', now);
    expect(list.sponsors.map((s) => s.name)).toEqual(['Star', 'First', 'Second']);
    expect(list.sponsors[0]!.featured).toBe(true);
    expect(list.sponsors[1]!.logo).toBe(`/api/sponsor-logos/${HASH}.png`);
    expect(list.sponsors[2]!.logo).toBeNull();
    expect(list.links).toEqual({ sponsorInfo: null, kofi: null });
  });

  it('shows at most five', async () => {
    for (let i = 0; i < SHOWN + 3; i++) await add('s4', `Name${i}`, 0, 10, { position: i });
    expect((await sponsorList(db, 's4', 5)).sponsors).toHaveLength(SHOWN);
  });

  it('answers the site links', async () => {
    await db
      .prepare(
        "INSERT INTO site_links (key, url, updated_at) VALUES ('kofi', 'https://ko-fi.com/x', 0)",
      )
      .run();
    expect((await sponsorList(db, 's2', 0)).links).toEqual({
      sponsorInfo: null,
      kofi: 'https://ko-fi.com/x',
    });
  });

  it('turns only well-formed keys into paths', () => {
    expect(logoPath(`logos/${HASH}.webp`)).toBe(`/api/sponsor-logos/${HASH}.webp`);
    expect(logoPath('logos/../secret.png')).toBeNull();
    expect(logoPath(null)).toBeNull();
  });
});

describe('the routes', () => {
  it('serves the current canvas list with a short public cache', async () => {
    await add('canvas', 'Stage', 0, Date.now() + 60_000);
    const response = await new Browser(envIn('staging')).get('/api/sponsors');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=60');
    const body = (await response.json()) as { sponsors: unknown[] };
    expect(Array.isArray(body.sponsors)).toBe(true);
  });

  it('serves a logo a sponsor names, as an image of its own type kept for a day', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await testEnv.SPONSOR_LOGOS.put(`logos/${HASH}.png`, bytes);
    const browser = new Browser(envIn('staging'));
    // Stored but named by no sponsor (never saved, or its sponsor deleted): not served.
    expect((await browser.get(`/api/sponsor-logos/${HASH}.png`)).status).toBe(404);
    await add('s5', 'Owner', 0, 10, { logo: `logos/${HASH}.png` });
    const response = await browser.get(`/api/sponsor-logos/${HASH}.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe(`public, max-age=${LOGO_MAX_AGE}`);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect((await browser.get(`/api/sponsor-logos/${'b'.repeat(64)}.png`)).status).toBe(404);
    expect((await browser.get(`/api/sponsor-logos/${HASH}.svg`)).status).toBe(404);
  });
});
