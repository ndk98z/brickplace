import { cellsOf, type Op, type Rect } from '@brickplace/core';

// Area locks (ADR 0024): rectangles where moderators stop play while they look at a raid. Ops
// touching one are refused with `locked` and never logged, so a replay never needs them and
// they live in the canvas's meta, not in the op log or the core. Kept out of the Worker entry
// (index.ts), which may export only handlers and Durable Object classes.

/** Most locks a canvas holds at once; the client draws up to this many. */
export const MAX_LOCKS = 16;
/** Longest note kept with a lock (the audit log keeps the whole reason). */
export const MAX_LOCK_NOTE = 64;

export interface AreaLock {
  /** Unique within the canvas, never reused. */
  readonly id: number;
  readonly area: Rect;
  /** Ops at or after this time (the canvas's logical clock, ms) pass again; null: until unlocked. */
  readonly until: number | null;
  readonly note: string;
}

/** What meta `locks` holds: the locks and a revision that grows with every change. */
export interface LockState {
  readonly rev: number;
  readonly nextId: number;
  readonly locks: readonly AreaLock[];
}

export const NO_LOCKS: LockState = { rev: 0, nextId: 1, locks: [] };

export interface LockRequest {
  readonly area: Rect;
  readonly until?: number | null;
  readonly note?: string;
}

export type LockResult =
  | { readonly ok: true; readonly lock: AreaLock; readonly locks: readonly AreaLock[] }
  | { readonly ok: false; readonly reason: 'invalid' | 'full' };

export type UnlockResult =
  | { readonly ok: true; readonly locks: readonly AreaLock[] }
  | { readonly ok: false; readonly reason: 'not_found' };

export function readLocks(sql: SqlStorage): LockState {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'locks'")
    .toArray()[0];
  return row ? { ...NO_LOCKS, ...(JSON.parse(row.value) as Partial<LockState>) } : NO_LOCKS;
}

export function writeLocks(sql: SqlStorage, state: LockState): void {
  sql.exec(
    "INSERT INTO meta (key, value) VALUES ('locks', ?) " +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    JSON.stringify(state),
  );
}

/** A lock to add at `now`, or null when the request is malformed for a map of edge `size`. */
export function newLock(
  state: LockState,
  request: LockRequest,
  size: number,
  now: number,
): AreaLock | null {
  if (typeof request !== 'object' || request === null) return null;
  const { area, until = null, note = '' } = request;
  if (typeof area !== 'object' || area === null) return null;
  const { x, y, w, h } = area;
  if (![x, y, w, h].every((v) => Number.isInteger(v) && v >= 0)) return null;
  if (w < 1 || h < 1 || x + w > size || y + h > size) return null;
  if (until !== null && (!Number.isSafeInteger(until) || until <= now)) return null;
  if (typeof note !== 'string') return null;
  return { id: state.nextId, area: { x, y, w, h }, until, note: note.slice(0, MAX_LOCK_NOTE) };
}

/** The locks still in force at `at`. */
export function activeLocks(locks: readonly AreaLock[], at: number): AreaLock[] {
  return locks.filter((l) => l.until === null || at < l.until);
}

/** The cells an op acts on: a brick's four, any other op's one. */
function opCells(op: Op): (readonly [number, number])[] {
  if (op.kind !== 'brick') return [[op.x, op.y]];
  return cellsOf(op.shape, op.rotation).map(([dx, dy]) => [op.x + dx, op.y + dy] as const);
}

/** True when an op at logical time `at` touches a lock in force then. */
export function isLocked(locks: readonly AreaLock[], op: Op, at: number): boolean {
  if (locks.length === 0) return false;
  // A malformed brick (bad shape or rotation) is the core's to refuse, not a lock's.
  let cells: (readonly [number, number])[];
  try {
    cells = opCells(op);
  } catch {
    return false;
  }
  return activeLocks(locks, at).some(({ area }) =>
    cells.some(
      ([x, y]) => x >= area.x && y >= area.y && x < area.x + area.w && y < area.y + area.h,
    ),
  );
}
