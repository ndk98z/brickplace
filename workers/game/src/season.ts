import type { Rect } from '@brickplace/core';

// A canvas is one season (ADR 0021). This module keeps its schedule and where it stands in its
// life: open, closing (past the end, final products on their way), ended (read-only, archive
// pending) and sealed (anonymised archive written, player ids purged). Stored as JSON in the
// canvas's `meta`. Kept out of the Worker entry (index.ts), which may export only handlers and
// Durable Object classes.

/** Player ids stay this long after the end (ADR 0008), then the archive is sealed. */
export const ID_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Longest note on a read-only switch (who or why, for the admin audit log). */
export const MAX_READ_ONLY_NOTE = 64;
/** Most removals one canvas takes before its archive is sealed. */
export const MAX_REMOVALS = 1000;

export type SeasonPhase = 'open' | 'closing' | 'ended' | 'sealed';

/** Why the canvas refuses an op or a discard. Ack statuses of the same names (protocol). */
export type Refusal = 'ended' | 'read_only';

export interface SeasonState {
  /**
   * End of the season (ms, the canvas's logical clock: the `at` ops are applied and logged
   * with). An op at or after it is refused. Null: no end set (Stage 0, or not decided yet).
   */
  readonly endsAt: number | null;
  /**
   * Set while the map is paused by an admin or emergency switch (lane I): a short note, kept
   * for the audit trail. Ops and discards are refused with `read_only` meanwhile.
   */
  readonly readOnly: string | null;
  readonly phase: SeasonPhase;
  /** The last log seq of the season, fixed when it starts closing. */
  readonly finalSeq: number | null;
  /** When the final products were all out (wall clock, ms). */
  readonly endedAt: number | null;
  /** When the archive was sealed (wall clock, ms). */
  readonly sealedAt: number | null;
  /** An admin asked to seal before ID_RETENTION_MS has passed. */
  readonly sealRequested: boolean;
}

export const OPEN_SEASON: SeasonState = {
  endsAt: null,
  readOnly: null,
  phase: 'open',
  finalSeq: null,
  endedAt: null,
  sealedAt: null,
  sealRequested: false,
};

/**
 * Content a moderator removed: ops of log seqs `from`..`to` (inclusive) whose anchor cell lies
 * in `area`, and, when `player` is set, that player sent, are left out of the sealed archive
 * and of the keyframes rewritten from it. Anchor only: a moderator pads the area to cover
 * bricks that reach in from outside it. Changes to the open area and restores (ADR 0024) are
 * never removed. Every rollback becomes one (ADR 0024); setRemovals keeps archive-only ones.
 */
export interface Removal {
  readonly from: number;
  readonly to: number;
  readonly area: Rect;
  /** The account id the removal is limited to; in season.json, its pseudonym. */
  readonly player?: string;
}

/** Longest player id a removal names (as CanvasDO's MAX_PLAYER_LENGTH). */
const MAX_REMOVAL_PLAYER = 128;

export function readSeason(sql: SqlStorage): SeasonState {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'season'")
    .toArray()[0];
  return row ? { ...OPEN_SEASON, ...(JSON.parse(row.value) as Partial<SeasonState>) } : OPEN_SEASON;
}

export function writeSeason(sql: SqlStorage, season: SeasonState): void {
  sql.exec(
    "INSERT INTO meta (key, value) VALUES ('season', ?) " +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    JSON.stringify(season),
  );
}

export function readRemovals(sql: SqlStorage): Removal[] {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'removals'")
    .toArray()[0];
  return row ? (JSON.parse(row.value) as Removal[]) : [];
}

export function writeRemovals(sql: SqlStorage, removals: readonly Removal[]): void {
  sql.exec(
    "INSERT INTO meta (key, value) VALUES ('removals', ?) " +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    JSON.stringify(removals),
  );
}

/**
 * Why an op at logical time `at` is refused, or null when it may go to the rules. Once the
 * season is closing every op is refused, whatever time it claims: the final checkpoint is
 * fixed by then. The end is checked against the batch's own `at`, the time it would be logged
 * with, so an accepted op always lies before the end in the log; refused ops are never logged,
 * so replay never needs the schedule.
 */
export function refusal(season: SeasonState, at: number): Refusal | null {
  if (season.phase !== 'open') return 'ended';
  if (season.endsAt !== null && at >= season.endsAt) return 'ended';
  if (season.readOnly !== null) return 'read_only';
  return null;
}

/** What an admin may change (lane I). Fields left out stay as they are. */
export interface ScheduleChange {
  /** A new end (ms, logical clock), or null to clear it. Only while the season is open. */
  readonly endsAt?: number | null;
  /** A note to pause the map, or null to resume it. */
  readonly readOnly?: string | null;
}

export type ScheduleResult =
  | { readonly ok: true; readonly season: SeasonState }
  | { readonly ok: false; readonly reason: 'invalid' | 'closed' };

/** Applies a schedule change, or says why it cannot. Pure: the caller stores the result. */
export function changeSchedule(
  season: SeasonState,
  change: ScheduleChange,
  /** The logical time of the last logged op: an end must lie after it. */
  clock: number,
): ScheduleResult {
  if (typeof change !== 'object' || change === null) return { ok: false, reason: 'invalid' };
  const { endsAt, readOnly } = change;
  if (
    endsAt !== undefined &&
    endsAt !== null &&
    (!Number.isSafeInteger(endsAt) || endsAt <= clock)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (
    readOnly !== undefined &&
    readOnly !== null &&
    (typeof readOnly !== 'string' || readOnly.length === 0 || readOnly.length > MAX_READ_ONLY_NOTE)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  // The end is history once the season closes: the final checkpoint and log are fixed.
  if (endsAt !== undefined && season.phase !== 'open') return { ok: false, reason: 'closed' };
  return {
    ok: true,
    season: {
      ...season,
      ...(endsAt !== undefined ? { endsAt } : {}),
      ...(readOnly !== undefined ? { readOnly } : {}),
    },
  };
}

/** True for a well-formed removal list; ranges and areas are checked, not their content. */
export function validRemovals(removals: unknown): removals is Removal[] {
  if (!Array.isArray(removals) || removals.length > MAX_REMOVALS) return false;
  return removals.every((r: Partial<Removal> | null) => {
    if (typeof r !== 'object' || r === null) return false;
    const { from, to, area, player } = r;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return false;
    if ((from as number) < 1 || (to as number) < (from as number)) return false;
    if (typeof area !== 'object' || area === null) return false;
    if (
      player !== undefined &&
      (typeof player !== 'string' || player.length === 0 || player.length > MAX_REMOVAL_PLAYER)
    ) {
      return false;
    }
    return [area.x, area.y, area.w, area.h].every((v) => Number.isSafeInteger(v) && v >= 0);
  });
}

/**
 * True when the entry is a player op of seq `seq`, sent by `player` (null: not known), that
 * some removal leaves out. A removal limited to a player never matches an op whose sender is
 * not known.
 */
export function removed(
  removals: readonly Removal[],
  seq: number,
  entry: { readonly kind: string; readonly x?: number; readonly y?: number },
  player: string | null = null,
): boolean {
  if (entry.kind === 'open' || entry.kind === 'restore') return false;
  const x = entry.x ?? -1;
  const y = entry.y ?? -1;
  return removals.some(
    (r) =>
      seq >= r.from &&
      seq <= r.to &&
      (r.player === undefined || r.player === player) &&
      x >= r.area.x &&
      x < r.area.x + r.area.w &&
      y >= r.area.y &&
      y < r.area.y + r.area.h,
  );
}
