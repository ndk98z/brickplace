import { parseSponsors, type SiteInfo, type Sponsor } from '../config.ts';
import { type InstanceEnv, instanceFrom, isHttpsUrl, sponsorHref } from '../instance.ts';
import type { Contributor, Role } from './contributors-list.ts';

// What the contributors page shows, from the static list, the sponsors and links the admin
// area sets (`site`, ADR 0038) and the build's VITE_* settings when those are missing.

/** The Ko-fi page from the admin area, else VITE_KOFI_URL; the button is hidden without one. */
export function kofiLink(env: InstanceEnv, site: SiteInfo | null = null): string | null {
  return site?.kofiUrl ?? instanceFrom(env).kofiUrl;
}

/**
 * Where "Become a sponsor" points: the admin area's page, else VITE_SPONSOR_INFO_URL, else a
 * mail to VITE_CONTACT_EMAIL; the button is hidden without any.
 */
export function sponsorLink(env: InstanceEnv, site: SiteInfo | null = null): string | null {
  return site?.sponsorInfoUrl ?? sponsorHref(instanceFrom(env));
}

/** The featured sponsor (shown on the map too) and the others. */
export function sponsorsOf(
  env: { VITE_SPONSORS?: string },
  site: SiteInfo | null = null,
): {
  featured: Sponsor | null;
  others: Sponsor[];
} {
  const all =
    site && site.sponsors.length > 0 ? [...site.sponsors] : parseSponsors(env.VITE_SPONSORS);
  return {
    featured: all.find((s) => s.featured) ?? null,
    others: all.filter((s) => !s.featured),
  };
}

export type Filter = Role | 'all';

export function filtered(list: readonly Contributor[], filter: Filter): Contributor[] {
  return list.filter((person) => filter === 'all' || person.roles.includes(filter));
}

/** A person's link, only if it is https. */
export function personUrl(person: Contributor): string | null {
  return isHttpsUrl(person.url) ? person.url : null;
}

/** The letter on a person's tile. */
export function initialOf(name: string): string {
  const letter = name.replace(/[^\p{L}\p{N}]/gu, '')[0];
  return (letter ?? '?').toUpperCase();
}
