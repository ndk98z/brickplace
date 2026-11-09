import type { Rotation, ShapeId } from './shapes.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface CoreConfig {
  /** Map edge in cells. */
  readonly size: number;
  /** Area players may currently act in. Only grows during a season. */
  readonly open: Rect;
  /** Maximum shield layers per cell (admin-configurable, at most 255). */
  readonly maxShield: number;
  /**
   * How long a shield layer lasts after it was placed, in op log time (milliseconds).
   * Admin-configurable; DEFAULT_SHIELD_LIFETIME (48 h) when absent.
   */
  readonly shieldLifetime?: number;
}

export interface BrickOp {
  readonly kind: 'brick';
  readonly x: number;
  readonly y: number;
  readonly shape: ShapeId;
  readonly rotation: Rotation;
  readonly color: number;
}

export interface HammerOp {
  readonly kind: 'hammer';
  readonly x: number;
  readonly y: number;
}

export interface ShieldOp {
  readonly kind: 'shield';
  readonly x: number;
  readonly y: number;
}

/**
 * A one-cell repair item (ADR 0005). It fills one empty open cell that no brick placement can
 * cover, and has no link bits: the cell is its own piece.
 */
export interface SingleOp {
  readonly kind: 'single';
  readonly x: number;
  readonly y: number;
  readonly color: number;
}

export type Op = BrickOp | HammerOp | ShieldOp | SingleOp;

/**
 * The open area grows to this rectangle (setOpenArea). Not a player op: the server writes it
 * into the op log at its place in the order, so a replay grows the area at the same point.
 * It takes no time: the logical clock moves only with accepted ops.
 */
export interface OpenAreaEntry {
  readonly kind: 'open';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * One cell a restore entry sets: its index (y * size + x), its new cell byte, then the expiry
 * time of each of its shield layers, oldest first (so the cell's shield count is the length
 * minus two).
 */
export type RestoreCell = readonly [index: number, cell: number, ...expiries: number[]];

/**
 * A moderation rollback (ADR 0024): sets each listed cell to the value it has in a replay of
 * the log that leaves the rolled-back ops out. Not a player op: the server computes it, logs it
 * in its own row and replays it like any entry. Cells are listed by increasing index, at most
 * once. It takes no time, like an open-area change: the clock moves only with accepted ops.
 */
export interface RestoreEntry {
  readonly kind: 'restore';
  readonly cells: readonly RestoreCell[];
}

/** One entry of the op log: a player op, an open-area change or a restore. */
export type LogEntry = Op | OpenAreaEntry | RestoreEntry;

/**
 * Append only: the protocol sends a rejection as its index here, so reordering would change
 * the meaning of ack status codes already in the field.
 */
export const REJECT_REASONS = [
  'invalid',
  'out_of_area',
  'occupied',
  'empty',
  'shield_full',
  /** Single brick refused: some brick placement could still cover the cell. */
  'coverable',
  /**
   * The player holds no item for the op (its kind, and for a brick its shape). Never returned
   * by `apply`: the server checks the hold before applying.
   */
  'no_item',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** New value of one cell after an op. Clients apply diffs idempotently. */
export interface CellDiff {
  readonly index: number;
  readonly cell: number;
  readonly shield: number;
}

export type ApplyResult =
  | { readonly ok: true; readonly diffs: readonly CellDiff[] }
  | { readonly ok: false; readonly reason: RejectReason };
