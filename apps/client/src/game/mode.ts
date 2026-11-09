import type { Role } from '../net/account.ts';

// When a page holds a game socket (ADR 0009, 0018). Watching needs none: the map comes from
// the CDN. A socket is opened only to play, and given back once the player stops.

/**
 * Zoom (CSS px per cell) at or above which a player is playing. Below it a cell is too small
 * to aim at, so the page counts as watching. The page opens at 4.
 */
export const PLAY_MIN_ZOOM = 2;
/** A player hidden or zoomed out this long (ms) gives the socket back and reads the CDN. */
export const SOCKET_IDLE_MS = 60_000;

export interface ModeInputs {
  readonly role: Role;
  /**
   * A usable CDN is configured; without one (or once it proved unusable) every page keeps a
   * socket, as before.
   */
  readonly cdn: boolean;
  readonly zoom: number;
  readonly hidden: boolean;
}

/** True when the page should hold a socket now (before SOCKET_IDLE_MS of grace). */
export function wantsSocket({ role, cdn, zoom, hidden }: ModeInputs): boolean {
  if (!cdn) return true;
  if (role === 'watcher') return false;
  return !hidden && zoom >= PLAY_MIN_ZOOM;
}
