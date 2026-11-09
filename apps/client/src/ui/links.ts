import { instanceFrom } from '../instance.ts';

// Pages outside the game screen. They are plain HTML entries of the client build (see
// vite.config.ts); the gateway serves them as static assets, `terms.html` at `/terms` (Workers
// static assets drop the extension). The Vite dev server alone needs the `.html` names.

export const LEGAL = {
  terms: '/terms',
  privacy: '/privacy',
  trademarks: '/trademarks',
} as const;

export const CONTRIBUTORS_PAGE = '/contributors';

/** For links that leave the site: no window handle, no referrer. */
export const EXTERNAL_REL = 'noopener noreferrer';
export const TIMELAPSE_PAGE = '/timelapse.html';

/**
 * The source code, as the license (AGPL-3.0) requires a hosted copy to offer it: the repository
 * the deploy ran from (VITE_SOURCE_URL, ADR 0037); `#` in a build without it, like the pages.
 */
export const SOURCE_URL: string = instanceFrom(import.meta.env).sourceUrl ?? '#';

/** The timelapse of one season's canvas (ADR 0021); the current one without a canvas. */
export function timelapseLink(canvas: string | null): string {
  return canvas ? `${TIMELAPSE_PAGE}?canvas=${encodeURIComponent(canvas)}` : TIMELAPSE_PAGE;
}
