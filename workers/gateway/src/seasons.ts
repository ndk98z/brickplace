// The season registry (ADR 0021): D1 table `seasons` (migrations/0005). Each season is a canvas
// of its own; the gateway sends sockets and pages to the current one. Without any row the
// Stage 0 canvas `canvas` is current, as before seasons existed.

import { ID_RETENTION_MS } from '@brickplace/game/season';
import { type Context, json } from './http.ts';
import { tilesUrl } from './tiles.ts';

/** The Stage 0 canvas, from before seasons (FanoutDO and CanvasDO name, R2 prefix c/canvas). */
export const STAGE0_CANVAS = 'canvas';
/** Rows are read at most this often per isolate (ms). Boundaries are still exact: see current(). */
const CACHE_MS = 30_000;
/**
 * While D1 cannot answer, the last answer is used for at most this long (ms) after it was read:
 * it holds the next season too, so a start within it is still exact. Beyond it, the
 * registry is unknown.
 */
export const STALE_MS = 60 * 60 * 1000;
/** After a failed read, D1 is asked again at most this often (ms). */
const RETRY_MS = 5_000;

export interface Season {
  readonly id: number;
  readonly canvas: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

/**
 * Where a season stands, from its times. `finalizing`: over and read-only, but its archive is
 * not sealed yet, so moderators may still remove content from the final map and its timelapse
 * (ADR 0021). The seal comes ID_RETENTION_MS after the end at the latest; an owner may seal
 * earlier, which only the keyframe index in the CDN shows (`sealed`), since the gateway binds
 * no canvas. `ended`: past that, sealed.
 */
export type SeasonState = 'scheduled' | 'live' | 'finalizing' | 'ended';

/** What pages are told about a season. */
export interface SeasonView extends Season {
  readonly state: SeasonState;
  /** The canvas in the public tiles bucket, as in /api/me's config; null without a CDN. */
  readonly tilesUrl: string | null;
}

type Row = { id: number; canvas: string; starts_at: number; ends_at: number };

const toSeason = (row: Row): Season => ({
  id: row.id,
  canvas: row.canvas,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
});

export function stateOf(season: Season, now: number): SeasonState {
  if (now < season.startsAt) return 'scheduled';
  if (now < season.endsAt) return 'live';
  return now < season.endsAt + ID_RETENTION_MS ? 'finalizing' : 'ended';
}

/** The season whose start passed last, and the next one: enough to know the current one. */
let cached: { at: number; last: Season | null; next: Season | null } | null = null;

/** Every registered season, newest first, as /api/seasons last read them. */
let listed: { at: number; seasons: Season[] } | null = null;

/** When D1 last failed a read, so a dead D1 is not asked on every request. */
let failedAt = Number.NEGATIVE_INFINITY;

/**
 * Reads through a cache entry read at `at`: fresh within CACHE_MS; past it, read again; if
 * D1 fails, keep the old entry up to STALE_MS (asking again every RETRY_MS), else throw.
 */
async function refreshed<E extends { at: number }>(
  entry: E | null,
  now: number,
  read: () => Promise<E>,
): Promise<E> {
  const fresh = entry && now >= entry.at && now - entry.at < CACHE_MS;
  if (fresh) return entry;
  const usable = entry && now >= entry.at && now - entry.at < STALE_MS;
  if (usable && now - failedAt < RETRY_MS) return entry;
  try {
    return await read();
  } catch (error) {
    failedAt = now;
    if (usable) {
      console.error('season registry unreadable; using the last answer', error);
      return entry;
    }
    throw error;
  }
}

/** Forgets the cached rows (tests, and after an admin writes the registry). */
export function forgetSeasons(): void {
  cached = null;
  listed = null;
  failedAt = Number.NEGATIVE_INFINITY;
}

/**
 * The current season at `now`: the one whose start passed last (live, or ended while the next
 * has not started), or null when the registry is empty (the Stage 0 canvas plays). The next
 * season is cached too, so a page asking at its start gets it at once, not up to a cache
 * lifetime later. While D1 cannot answer, the last answer serves for up to STALE_MS; with
 * none, this throws, and callers decide (players get no socket, watchers fall back).
 */
export async function currentSeason(db: D1Database, now: number): Promise<Season | null> {
  cached = await refreshed(cached, now, async () => {
    const [last, next] = await db.batch<Row>([
      db
        .prepare(
          'SELECT id, canvas, starts_at, ends_at FROM seasons WHERE starts_at <= ? ' +
            'ORDER BY starts_at DESC LIMIT 1',
        )
        .bind(now),
      db
        .prepare(
          'SELECT id, canvas, starts_at, ends_at FROM seasons WHERE starts_at > ? ' +
            'ORDER BY starts_at LIMIT 1',
        )
        .bind(now),
    ]);
    const first = (r: typeof last) => (r?.results[0] ? toSeason(r.results[0]) : null);
    return { at: now, last: first(last), next: first(next) };
  });
  if (cached.next && cached.next.startsAt <= now) return cached.next;
  return cached.last;
}

/**
 * The next season to start after `now`, as the last read of the registry (currentSeason) saw
 * it; null when none is registered, or none was read yet. Open pages ask /api/me again just
 * after its start, so they learn of a new current canvas at once (ADR 0021).
 */
export function nextSeason(now: number): Season | null {
  const next = cached?.next ?? null;
  return next && next.startsAt > now ? next : null;
}

/** The canvas pages and sockets use now: the current season's, else Stage 0's. */
export async function currentCanvas(db: D1Database, now: number): Promise<string> {
  return (await currentSeason(db, now))?.canvas ?? STAGE0_CANVAS;
}

/**
 * The current season for someone who only watches: when the registry cannot be read at all
 * (D1 down, nothing cached), Stage 0's canvas rather than no map. A guess is acceptable for
 * watching, never for playing (see the /ws route).
 */
export async function seasonForWatching(
  db: D1Database,
  now: number,
): Promise<{ season: Season | null; guessed: boolean }> {
  try {
    return { season: await currentSeason(db, now), guessed: false };
  } catch (error) {
    console.error('season registry unreadable and nothing cached; watching Stage 0', error);
    // Said so in /api/me: an open page must not take the guess for a change of season.
    return { season: null, guessed: true };
  }
}

export function viewOf(ctx: Context, season: Season): SeasonView {
  return { ...season, state: stateOf(season, ctx.now), tilesUrl: tilesUrl(ctx, season.canvas) };
}

/**
 * Every season that has started at `now`, newest first (the latest 100). Public reads, so D1
 * is read at most once per CACHE_MS per isolate; filtered at use, so a season that starts
 * within the cache lifetime counts at once.
 */
async function startedSeasons(db: D1Database, now: number): Promise<Season[]> {
  listed = await refreshed(listed, now, async () => {
    const rows = await db
      .prepare(
        'SELECT id, canvas, starts_at, ends_at FROM seasons ORDER BY starts_at DESC LIMIT 100',
      )
      .all<Row>();
    return { at: now, seasons: rows.results.map(toSeason) };
  });
  return listed.seasons.filter((season) => season.startsAt <= now);
}

/**
 * A season that has started, by id (a past season's ranking); null when there is none, or
 * when it is older than the latest 100 (two years of weekly seasons).
 */
export async function startedSeason(
  db: D1Database,
  id: number,
  now: number,
): Promise<Season | null> {
  return (await startedSeasons(db, now)).find((season) => season.id === id) ?? null;
}

/**
 * GET /api/seasons: every season that has started, newest first, and the canvas in use now,
 * for the timelapse page. Public and the same for everyone, so cached a minute.
 */
export async function listSeasons(ctx: Context): Promise<Response> {
  if (ctx.request.method !== 'GET') return json({ error: 'method' }, 405);
  const seasons = (await startedSeasons(ctx.env.ACCOUNTS, ctx.now)).map((season) =>
    viewOf(ctx, season),
  );
  const { season } = await seasonForWatching(ctx.env.ACCOUNTS, ctx.now);
  const canvas = season?.canvas ?? STAGE0_CANVAS;
  const response = json({ current: { canvas, tilesUrl: tilesUrl(ctx, canvas) }, seasons }, 200);
  response.headers.set('Cache-Control', 'public, max-age=60');
  return response;
}
