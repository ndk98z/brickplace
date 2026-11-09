import { type Context, json } from './http.ts';
import { STAGE0_CANVAS, seasonForWatching } from './seasons.ts';
import { cachedJson } from './team-api.ts';

// GET /api/sponsors and GET /api/sponsor-logos/<sha256>.<ext> (ADR 0038): the sponsors the
// admin area set for the current season and the site links, for the game screen and the
// contributors page. Public and edge-cached for a minute; logos come from the private
// SPONSOR_LOGOS bucket through this Worker, so players never load anything from a sponsor's
// server.

/** Seconds a browser and the edge keep the list. */
export const SPONSOR_AGES = { browser: 60, edge: 60 } as const;
/** At most this many on screen at once (ADR 0006). */
export const SHOWN = 5;
/** Seconds a logo is kept by browsers and the edge. */
export const LOGO_MAX_AGE = 86_400;
export const LOGO_PATH = /^\/api\/sponsor-logos\/([0-9a-f]{64})\.(png|webp)$/;

const LOGO_TYPES = { png: 'image/png', webp: 'image/webp' } as const;

export interface PublicSponsor {
  readonly name: string;
  readonly href: string;
  /** A path on this site, or null to show the name. */
  readonly logo: string | null;
  readonly featured: boolean;
}

export interface SponsorList {
  readonly sponsors: readonly PublicSponsor[];
  readonly links: { readonly sponsorInfo: string | null; readonly kofi: string | null };
}

/** `logos/<hash>.<ext>` in the bucket, as the path this Worker serves it at. */
export function logoPath(key: string | null): string | null {
  const match = key === null ? null : /^logos\/([0-9a-f]{64})\.(png|webp)$/.exec(key);
  return match ? `/api/sponsor-logos/${match[1]}.${match[2]}` : null;
}

/** The sponsors of `canvas` showing at `now`, featured first, and the site links. */
export async function sponsorList(
  db: D1Database,
  canvas: string,
  now: number,
): Promise<SponsorList> {
  const [sponsors, links] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT name, href, logo, featured FROM sponsors WHERE canvas = ? AND hidden = 0 ' +
          'AND shows_from <= ? AND shows_until > ? ORDER BY featured DESC, position, id LIMIT ?',
      )
      .bind(canvas, now, now, SHOWN),
    db.prepare('SELECT key, url FROM site_links'),
  ]);
  const link = (key: string) =>
    (links!.results.find((r) => r.key === key)?.url as string | undefined) ?? null;
  return {
    sponsors: sponsors!.results.map((r) => ({
      name: r.name as string,
      href: r.href as string,
      logo: logoPath(r.logo as string | null),
      featured: r.featured === 1,
    })),
    links: { sponsorInfo: link('sponsor_info'), kofi: link('kofi') },
  };
}

export async function getSponsors(ctx: Context): Promise<Response> {
  if (ctx.request.method !== 'GET') return json({ error: 'method' }, 405);
  // The canvas pages watch (the current season's, or Stage 0's while the registry is out).
  const { season } = await seasonForWatching(ctx.env.ACCOUNTS, ctx.now);
  const canvas = season?.canvas ?? STAGE0_CANVAS;
  try {
    return await cachedJson(
      ctx,
      `/api/sponsors?canvas=${canvas}`,
      () => sponsorList(ctx.env.ACCOUNTS, canvas, ctx.now),
      SPONSOR_AGES,
    );
  } catch (error) {
    console.error('sponsors failed', error);
    return json({ error: 'unavailable' }, 503);
  }
}

/** A logo by its hash: immutable, so browsers and the edge keep it for a year. */
export async function getSponsorLogo(ctx: Context, path: string): Promise<Response> {
  if (ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD') {
    return json({ error: 'method' }, 405);
  }
  const match = LOGO_PATH.exec(path);
  if (!match) return json({ error: 'not_found' }, 404);
  const kind = match[2] as keyof typeof LOGO_TYPES;
  const key = `logos/${match[1]}.${kind}`;
  // Only a logo some sponsor still names: deleting the sponsor (or swapping its logo) takes
  // the file off the site, with no one deleting it from the bucket.
  const used = await ctx.env.ACCOUNTS.prepare(
    'SELECT 1 AS used FROM sponsors WHERE logo = ? LIMIT 1',
  )
    .bind(key)
    .first();
  if (!used) return json({ error: 'not_found' }, 404);
  const object = await ctx.env.SPONSOR_LOGOS.get(key);
  if (!object) return json({ error: 'not_found' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': LOGO_TYPES[kind],
      // A day, not a year: a logo taken down leaves browsers and the edge by the next day.
      'Cache-Control': `public, max-age=${LOGO_MAX_AGE}`,
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}
