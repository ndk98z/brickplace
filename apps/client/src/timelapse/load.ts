import { type Keyframes, parseKeyframes } from '@brickplace/protocol/cdn';
import { tilesUrlFrom } from '../config.ts';
import type { Fetcher } from '../net/cdn.ts';

// Opening a season's timelapse, apart from the page so tests run it: where its frames are,
// whether there are any, and which of several overlapping opens still counts.

/**
 * The page heading for a season: "so far" while it is live; "final map" once its archive is
 * sealed (the keyframe index says `sealed`, or the gateway, past the latest seal, `ended`);
 * in between (`finalizing`, ADR 0021) moderators may still remove content, so it says so.
 * `sealed` is null until the index is read.
 */
export function seasonHeading(
  season: { readonly id: number; readonly state: string },
  sealed: boolean | null,
): string {
  if (season.id <= 0) return 'The map, frame by frame';
  const name = `Season ${season.id}`;
  if (season.state === 'live') return `${name} · so far`;
  if (sealed === true || season.state === 'ended') return `${name} · final map`;
  return `${name} · final map, under review`;
}

/**
 * The winning team in a season's ranking (`/api/teams/ranking?season=`): the first at rank 1,
 * with how many share that rank; null when no team ranks or the answer is not one.
 */
export function winnerOf(body: unknown): { name: string; tied: number } | null {
  const teams = (body as { teams?: unknown } | null)?.teams;
  if (!Array.isArray(teams)) return null;
  const top = teams.filter(
    (t): t is { name: string; rank: number } =>
      typeof t === 'object' && t !== null && t.rank === 1 && typeof t.name === 'string',
  );
  return top.length > 0 ? { name: top[0]!.name, tied: top.length } : null;
}

/**
 * Hands out tickets, one per open; only the latest is current. A season switched away from
 * while its index was still loading must not paint, nor show its empty state over the next.
 */
export class Latest {
  private ticket = 0;

  next(): number {
    this.ticket += 1;
    return this.ticket;
  }

  isCurrent(ticket: number): boolean {
    return ticket === this.ticket;
  }
}

export type Opened =
  /** The site has no public bucket for this season. */
  | { readonly kind: 'no_bucket' }
  /** No keyframe index yet, or one without frames. */
  | { readonly kind: 'no_frames' }
  | { readonly kind: 'ready'; readonly base: string; readonly index: Keyframes };

/** Reads the keyframe index of the season whose bucket URL is `tilesUrl`. */
export async function openSeason(
  tilesUrl: string | null,
  page: string,
  fetchText: Fetcher<string>,
  signal: AbortSignal,
): Promise<Opened> {
  const base = tilesUrlFrom(tilesUrl, page);
  if (!base) return { kind: 'no_bucket' };
  let text: string;
  try {
    text = await fetchText(`${base}/keyframes.json`, signal);
  } catch {
    // Cancelled by a newer open: let the caller see it, not a "no frames" answer.
    signal.throwIfAborted();
    return { kind: 'no_frames' };
  }
  const index = parseKeyframes(text);
  return index.frames.length === 0 ? { kind: 'no_frames' } : { kind: 'ready', base, index };
}
