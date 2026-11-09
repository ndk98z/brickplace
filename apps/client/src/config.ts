import {
  DEFAULT_MAP_SIZE,
  DEFAULT_MAX_SHIELD,
  DEFAULT_OPEN_EDGE,
  type Rect,
} from '@brickplace/core';
import { instanceFrom, isHttpsUrl } from './instance.ts';

export interface Sponsor {
  readonly name: string;
  readonly href: string;
  /**
   * Optional logo, a same-origin path (`/sponsors/acme.svg`, shipped in the client's
   * `public/`); the name is shown when it is missing. See isSameOriginPath.
   */
  readonly logo?: string;
  readonly featured?: boolean;
}

/** The tool column shows at most this many sponsors (ADR 0006). */
export const MAX_SPONSORS = 5;

/**
 * True for an absolute path on this site, such as `/sponsors/acme.svg`. Sponsor logos are
 * same-origin only: an image from a sponsor's server would let it log every player's IP
 * address and visit time (a referrer policy hides the page, not the request), swap the
 * image after review, or break the screen when that server is down, and it would need a
 * third-party `img-src` in the CSP. Logos ship with the client build, or the gateway serves
 * them from its own bucket under /api/sponsor-logos/ (ADR 0038). A
 * protocol-relative `//host` (or `/\host`, which browsers read the same way) is refused.
 */
export function isSameOriginPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/(?![/\\])[A-Za-z0-9._~%/-]*$/.test(value);
}

/**
 * Reads the sponsor list from JSON. Anything malformed is dropped rather than shown: a bad
 * entry must never break the game screen. The featured sponsor (at most one) comes first.
 */
export function parseSponsors(json: string | undefined): Sponsor[] {
  if (!json) return [];
  try {
    return sponsorList(JSON.parse(json));
  } catch {
    return [];
  }
}

/** The same checks on a value already parsed: VITE_SPONSORS, or /api/sponsors (ADR 0038). */
export function sponsorList(raw: unknown): Sponsor[] {
  if (!Array.isArray(raw)) return [];
  const sponsors: Sponsor[] = [];
  let featured = false;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, href, logo, featured: wantsFeature } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '' || !isHttpsUrl(href)) continue;
    const isFeatured: boolean = wantsFeature === true && !featured;
    featured ||= isFeatured;
    sponsors.push({
      name: name.trim(),
      href,
      ...(isSameOriginPath(logo) ? { logo } : {}),
      ...(isFeatured ? { featured: true } : {}),
    });
  }
  sponsors.sort((a, b) => Number(b.featured ?? false) - Number(a.featured ?? false));
  return sponsors.slice(0, MAX_SPONSORS);
}

/**
 * What the admin area sets (ADR 0038), from GET /api/sponsors: the sponsors showing now and
 * the two links. A link left unset there is null here and falls back to the build's value.
 */
export interface SiteInfo {
  readonly sponsors: readonly Sponsor[];
  readonly kofiUrl: string | null;
  readonly sponsorInfoUrl: string | null;
}

/** /api/sponsors's answer, checked like the build's list; null when it is not one. */
export function siteInfoFrom(raw: unknown): SiteInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { sponsors, links } = raw as { sponsors?: unknown; links?: unknown };
  if (!Array.isArray(sponsors)) return null;
  const link = (key: string): string | null => {
    const value = (links as Record<string, unknown> | null | undefined)?.[key];
    return isHttpsUrl(value) ? value : null;
  };
  return {
    sponsors: sponsorList(sponsors),
    kofiUrl: link('kofi'),
    sponsorInfoUrl: link('sponsorInfo'),
  };
}

/** Sponsors and links from the gateway, or null when it does not answer within `ms`. */
export async function fetchSiteInfo(ms = 1500): Promise<SiteInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch('/api/sponsors', { signal: controller.signal });
    return response.ok ? siteInfoFrom(await response.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ClientConfig {
  readonly socketUrl: string;
  readonly mapSize: number;
  /**
   * Area players may act in until the server's config frame says otherwise: the Stage 0
   * default in workers/game (one region in the middle of the map).
   */
  readonly open: Rect;
  /** Shield cap until the config frame arrives. */
  readonly maxShield: number;
  /** Ko-fi page for the Donate button; the button is disabled when unset. */
  readonly kofiUrl: string | null;
  readonly sponsors: readonly Sponsor[];
  /** Where "Become a sponsor" points; hidden when unset. */
  readonly sponsorInfoUrl: string | null;
  /**
   * Base URL of the canvas in the public tiles bucket (ADR 0009, 0018), given by the gateway
   * in /api/me. Set, the page watches through the CDN and opens a socket only to play;
   * unset, every page keeps a socket.
   */
  readonly tilesUrl?: string | null;
}

/**
 * The tiles URL from the gateway, made absolute against the page; null unless it is https,
 * or a path on this site (the dev route). Anything else is ignored.
 */
export function tilesUrlFrom(value: unknown, page: string): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value, page);
    const sameSite = url.origin === new URL(page).origin;
    if (url.protocol !== 'https:' && !sameSite) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function defaultSocketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

/**
 * Build-time settings come from VITE_* variables (see vite.config.ts); the tiles URL comes
 * from the gateway at run time (`/api/me`), and so do sponsors and links when `site` is
 * given (ADR 0038): its list replaces the build's unless it is empty (so the build's sponsors
 * stay until the admin area has some), and its links win over the build's.
 */
export function loadConfig(tilesUrl: unknown = null, site: SiteInfo | null = null): ClientConfig {
  const env = import.meta.env;
  const instance = instanceFrom(env);
  const offset = (DEFAULT_MAP_SIZE - DEFAULT_OPEN_EDGE) / 2;
  return {
    tilesUrl: tilesUrlFrom(tilesUrl, location.href),
    socketUrl: env.VITE_SOCKET_URL || defaultSocketUrl(),
    mapSize: DEFAULT_MAP_SIZE,
    open: { x: offset, y: offset, w: DEFAULT_OPEN_EDGE, h: DEFAULT_OPEN_EDGE },
    maxShield: DEFAULT_MAX_SHIELD,
    kofiUrl: site?.kofiUrl ?? instance.kofiUrl,
    sponsors: site && site.sponsors.length > 0 ? site.sponsors : parseSponsors(env.VITE_SPONSORS),
    sponsorInfoUrl: site?.sponsorInfoUrl ?? instance.sponsorInfoUrl,
  };
}
