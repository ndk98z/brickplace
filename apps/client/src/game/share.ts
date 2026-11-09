import { type Camera, clampZoom } from '../map/camera.ts';

// Share links (the Share design): `https://brickplace.io/@x,y,zoomx` opens the map centred on
// cell (x, y) at that zoom. The gateway serves the client for any unknown path, so the link
// needs no server support. There is no OG image (no server rendering): a post carries the
// link, and the PNG is attached by hand.

/** A cell to centre on and a zoom (CSS px per cell). */
export interface View {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

const VIEW_PATH = /^\/@(\d{1,6}),(\d{1,6}),(\d{1,3}(?:\.\d{1,3})?)x\/?$/;

/**
 * Reads a view from a path such as `/@1024,980,4x`; null for any other path, or for a cell
 * off the map. The zoom is clamped to what the camera allows.
 */
export function parseViewPath(pathname: string, mapSize: number): View | null {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const match = VIEW_PATH.exec(path);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const zoom = Number(match[3]);
  if (x >= mapSize || y >= mapSize || !(zoom > 0)) return null;
  return { x, y, zoom: clampZoom(zoom) };
}

/** `4` for 4, `0.5` for 0.5, `2.35` for 2.3456: at most two decimals, no trailing zeros. */
export function formatZoom(zoom: number): string {
  return String(Number(clampZoom(zoom).toFixed(2)));
}

export function viewPath(view: View): string {
  return `/@${view.x},${view.y},${formatZoom(view.zoom)}x`;
}

/** The view a camera shows: the cell at its centre, as the coordinates pill shows it. */
export function viewOf(camera: Camera): View {
  return { x: Math.floor(camera.cx), y: Math.floor(camera.cy), zoom: camera.zoom };
}

/** The camera that shows a view: centred on the middle of its cell. */
export function cameraFor(view: View): Camera {
  return { cx: view.x + 0.5, cy: view.y + 0.5, zoom: view.zoom };
}

/** A season id in an address (`?season=`, `?ranking=`): a positive whole number. */
const SEASON_ID = /^[1-9][0-9]{0,8}$/;

/** The season id `params` give under `key`, or null when absent or not one. */
export function seasonParam(params: URLSearchParams, key: string): number | null {
  const value = params.get(key);
  return value !== null && SEASON_ID.test(value) ? Number(value) : null;
}

/**
 * The link a page was opened with, rebuilt from what it understood (a share link's view and
 * season, a team invite), for a sign-in to come back to; null for a plain visit.
 */
export function arrivalPath(
  view: View | null,
  invitedTeam: number | null,
  season: number | null = null,
): string | null {
  if (view === null && invitedTeam === null) return null;
  const query = new URLSearchParams();
  if (view && season !== null) query.set('season', String(season));
  if (invitedTeam !== null) query.set('team', String(invitedTeam));
  const path = view ? viewPath(view) : '/';
  return query.size > 0 ? `${path}?${query}` : path;
}

/**
 * A share link: this spot and zoom, and the season it was shared in (null: the Stage 0 map,
 * before seasons), so a page opened in a later season can say the map has changed.
 */
export function shareLink(origin: string, view: View, season: number | null = null): string {
  const base = `${origin.replace(/\/+$/, '')}${viewPath(view)}`;
  return season === null ? base : `${base}?season=${season}`;
}

/**
 * Whether a share link names another season than the one the page shows now: the map at its
 * spot has changed, and that season's final map is in the timelapse. Not when the page does
 * not know its season (the registry was unreadable, and the gateway guessed).
 */
export function linkFromAnotherSeason(
  linkSeason: number | null,
  current: { readonly season?: { readonly id: number } | null; readonly seasonGuessed?: true },
): boolean {
  if (linkSeason === null || current.seasonGuessed === true) return false;
  return linkSeason !== (current.season?.id ?? null);
}

const number = new Intl.NumberFormat('en-US');

/** The caption under a shared image: season on the left, coordinates on the right. */
export function caption(view: View, season: number | null): { left: string; right: string } {
  return {
    left: season === null ? 'BrickPlace' : `BrickPlace · Season ${season}`,
    right: `x ${number.format(view.x)} · y ${number.format(view.y)}`,
  };
}

export function shareTitle(view: View, season: number | null): string {
  const { left, right } = caption(view, season);
  return `${left} · ${right}`;
}

/** Reddit's submit page with the link and a title; the image is attached by hand. */
export function redditUrl(link: string, title: string): string {
  return `https://www.reddit.com/submit?url=${encodeURIComponent(link)}&title=${encodeURIComponent(title)}`;
}

/** X's post intent with a short text and the link. */
export function xUrl(link: string, text: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
}

/** What "Copy for Discord" puts on the clipboard as text, next to the image. */
export function discordText(link: string, title: string): string {
  // Angle brackets stop Discord from unfurling the link: there is no preview image to show,
  // and the pasted PNG is the preview.
  return `${title}\n<${link}>`;
}

export function snapshotFileName(view: View): string {
  return `brickplace-${view.x}-${view.y}.png`;
}
