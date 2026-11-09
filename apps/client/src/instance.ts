// Who runs this copy of the game, from the build's VITE_* settings (ADR 0037). The code carries
// no operator, address, contact, donation page or repository of its own: the deploy workflow
// passes them from the repository's GitHub Actions variables, so a fork shows its own and never the
// upstream owner's. Unset, a local or CI build says so on the page instead of guessing.

export interface InstanceEnv {
  readonly VITE_OPERATOR_NAME?: string;
  readonly VITE_OPERATOR_ADDRESS?: string;
  readonly VITE_CONTACT_EMAIL?: string;
  readonly VITE_SOURCE_URL?: string;
  readonly VITE_KOFI_URL?: string;
  readonly VITE_SPONSOR_INFO_URL?: string;
}

export interface Instance {
  /** Who runs the game, as the legal pages name them ("we"). */
  readonly operatorName: string | null;
  /** Their postal address, for the legal pages. */
  readonly operatorAddress: string | null;
  /** The contact address for legal, privacy and sponsor questions. */
  readonly contactEmail: string | null;
  /** The source code this build was made from, as AGPL-3.0 section 13 requires. */
  readonly sourceUrl: string | null;
  /** Ko-fi page for the Donate buttons; they are disabled or hidden when unset. */
  readonly kofiUrl: string | null;
  /** Page explaining how to become a sponsor. */
  readonly sponsorInfoUrl: string | null;
}

export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A plain address such as `contact@example.org`; anything else is dropped. */
function email(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(trimmed)
    ? trimmed
    : null;
}

function https(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!isHttpsUrl(trimmed)) return null;
  // No query or fragment: the pages append paths to some of these.
  const url = new URL(trimmed);
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

export function instanceFrom(env: InstanceEnv): Instance {
  return {
    operatorName: text(env.VITE_OPERATOR_NAME),
    operatorAddress: text(env.VITE_OPERATOR_ADDRESS),
    contactEmail: email(env.VITE_CONTACT_EMAIL),
    sourceUrl: https(env.VITE_SOURCE_URL),
    kofiUrl: https(env.VITE_KOFI_URL),
    sponsorInfoUrl: https(env.VITE_SPONSOR_INFO_URL),
  };
}

/** Where "Become a sponsor" points: the sponsor page, else the contact address, else nowhere. */
export function sponsorHref(instance: Instance): string | null {
  if (instance.sponsorInfoUrl) return instance.sponsorInfoUrl;
  return instance.contactEmail ? `mailto:${instance.contactEmail}` : null;
}

/** Shown on a page built without the setting, so a missing variable is plain to see. */
export const UNSET = '[not configured]';

/**
 * The settings the legal pages cannot do without, by variable name, that this build lacks. A
 * deploy build (VITE_REQUIRE_OPERATOR=1, see vite.config.ts) fails while any is missing or
 * invalid, so the pages never ship saying UNSET.
 */
export function missingOperator(instance: Instance): string[] {
  const missing: string[] = [];
  if (!instance.operatorName) missing.push('VITE_OPERATOR_NAME');
  if (!instance.operatorAddress) missing.push('VITE_OPERATOR_ADDRESS');
  if (!instance.contactEmail) missing.push('VITE_CONTACT_EMAIL');
  return missing;
}

function escapeHtml(value: string): string {
  return (
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      // Vite's own `%VITE_*%` pass runs after this one and must not see a value's `%`.
      .replaceAll('%', '&#37;')
  );
}

/**
 * Fills the `{{operatorName}}`-style placeholders of the static pages (vite.config.ts), each
 * value HTML-escaped. An unset value reads UNSET, an unset link `#`. Unknown names throw, so
 * a typo in a page fails the build rather than shipping a placeholder.
 */
export function fillInstance(html: string, instance: Instance): string {
  const values: Record<string, string> = {
    operatorName: instance.operatorName ?? UNSET,
    operatorAddress: instance.operatorAddress ?? UNSET,
    contactEmail: instance.contactEmail ?? UNSET,
    contactHref: instance.contactEmail ? `mailto:${instance.contactEmail}` : '#',
    sourceUrl: instance.sourceUrl ?? '#',
    // GitHub's and Gitea's layout; HEAD is the default branch, whatever its name.
    contributingUrl: instance.sourceUrl ? `${instance.sourceUrl}/blob/HEAD/CONTRIBUTING.md` : '#',
    sponsorHref: sponsorHref(instance) ?? '#',
    kofiUrl: instance.kofiUrl ?? '#',
  };
  return html.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`unknown instance placeholder {{${name}}}`);
    return escapeHtml(value);
  });
}
