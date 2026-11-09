// How many may play at once (ADR 0039): the owner sets it in the admin area, as the
// `player_cap` row of `site_settings` (migrations/0008). The gateway passes each playing
// socket's FanoutDO shard its share; FanoutDO turns players away past it.

/** The cap with no row: the owner's choice for the first months (ADR 0039). */
export const DEFAULT_PLAYER_CAP = 5_000;
/** Most a cap may be: 64 shards of the runtime's 32,768 sockets, rounded down. */
export const MAX_PLAYER_CAP = 2_000_000;
/** The row is read at most this often per isolate (ms). */
const CACHE_MS = 30_000;
/** After a failed read, D1 is asked again at most this often (ms). */
const RETRY_MS = 5_000;

/** The cap in force: a whole number of players, or null for none. */
export type PlayerCap = number | null;

let cached: { at: number; cap: PlayerCap } | null = null;
let failedAt = Number.NEGATIVE_INFINITY;

/** Forgets the cached row (tests). */
export function forgetPlayerCap(): void {
  cached = null;
  failedAt = Number.NEGATIVE_INFINITY;
}

/** A stored value as a cap: null stays null (off), anything malformed means the default. */
export function capOf(value: unknown): PlayerCap {
  if (value === null) return null;
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_PLAYER_CAP
    ? (value as number)
    : DEFAULT_PLAYER_CAP;
}

/**
 * The cap at `now`, read through a per-isolate cache. While D1 cannot answer, the last answer
 * stands, or the default when there is none: a broken read never lifts the cap.
 */
export async function playerCap(db: D1Database, now: number): Promise<PlayerCap> {
  if (cached && now >= cached.at && now - cached.at < CACHE_MS) return cached.cap;
  if (now - failedAt < RETRY_MS) return cached ? cached.cap : DEFAULT_PLAYER_CAP;
  // Each request reads for itself: a read shared across requests could be left unsettled by
  // the request that started it being cancelled, and every later one would wait on it. The
  // requests in flight when the cache runs out each read once, then the cache serves 30 s.
  try {
    const row = await db
      .prepare("SELECT value FROM site_settings WHERE key = 'player_cap'")
      .first<{ value: number | null }>();
    cached = { at: now, cap: row ? capOf(row.value) : DEFAULT_PLAYER_CAP };
    return cached.cap;
  } catch (error) {
    failedAt = now;
    console.error('player cap unreadable; keeping the last one', error);
    return cached ? cached.cap : DEFAULT_PLAYER_CAP;
  }
}

/** One shard's share of the cap: players reach shards by account hash, so shares fill evenly. */
export function capShare(cap: number, shards: number): number {
  return Math.ceil(cap / shards);
}
