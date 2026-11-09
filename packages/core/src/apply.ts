import { encodeCell, isFilled, LINK_DOWN, LINK_RIGHT } from './cell.ts';
import { PALETTE_SIZE } from './constants.ts';
import { canCover, clearCell, fillCell, inOpenArea } from './cover.ts';
import { applyRestore } from './restore.ts';
import { cellsOf } from './shapes.ts';
import { addLayer, breakLayer, expireShields, isTime, liveLayers } from './shields.ts';
import { type State, setOpenArea } from './state.ts';
import type {
  ApplyResult,
  BrickOp,
  CellDiff,
  HammerOp,
  LogEntry,
  Op,
  ShieldOp,
  SingleOp,
} from './types.ts';

/**
 * Applies one op to the state in place and returns the cells it changed.
 * Deterministic and free of I/O: the same op log always yields the same grid.
 * A rejected op leaves the state untouched.
 *
 * `now` is the op's logical timestamp from the op log (milliseconds), never a clock read.
 * Times before `state.clock` count as `state.clock`, so the clock never goes back; leaving it
 * out means no time passes. An accepted op first expires the shield layers whose time is up
 * (those cells come first in the diffs), then takes effect.
 */
export function apply(state: State, op: Op, now: number = state.clock): ApplyResult {
  if (!isTime(state, now)) return { ok: false, reason: 'invalid' };
  const at = Math.max(now, state.clock);
  switch (op.kind) {
    case 'brick':
      return placeBrick(state, op, at);
    case 'hammer':
      return hammer(state, op, at);
    case 'shield':
      return shield(state, op, at);
    case 'single':
      return placeSingle(state, op, at);
    default:
      return { ok: false, reason: 'invalid' };
  }
}

/**
 * Applies one op log entry: a player op through `apply`, an open-area change through
 * setOpenArea, or a restore (ADR 0024) through applyRestore. A change that does not contain the
 * current area (or leaves the map), or a restore that would break an invariant of the grid, is
 * refused as `invalid` and changes nothing. Neither takes time. This is what a replay of the log
 * calls for every entry.
 */
export function applyEntry(state: State, entry: LogEntry, now: number = state.clock): ApplyResult {
  if (entry.kind === 'restore') return applyRestore(state, entry);
  if (entry.kind !== 'open') return apply(state, entry, now);
  const { x, y, w, h } = entry;
  try {
    setOpenArea(state, { x, y, w, h });
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, reason: 'invalid' };
    throw error;
  }
  return { ok: true, diffs: [] };
}

function isInt(n: number, max: number): boolean {
  return Number.isInteger(n) && n >= 0 && n < max;
}

function diffAt(state: State, index: number): CellDiff {
  return { index, cell: state.cells[index]!, shield: state.shields[index]! };
}

function placeBrick(state: State, op: BrickOp, now: number): ApplyResult {
  if (!isInt(op.shape, 7) || !isInt(op.rotation, 4) || !isInt(op.color, PALETTE_SIZE)) {
    return { ok: false, reason: 'invalid' };
  }
  const { size } = state.config;
  const cells = cellsOf(op.shape, op.rotation).map(([dx, dy]) => [op.x + dx, op.y + dy] as const);
  for (const [x, y] of cells) {
    if (!isInt(x, size) || !isInt(y, size) || !inOpenArea(state, x, y)) {
      return { ok: false, reason: 'out_of_area' };
    }
    if (isFilled(state.cells[y * size + x]!)) return { ok: false, reason: 'occupied' };
  }
  const diffs = expireShields(state, now);
  const inBrick = (x: number, y: number) => cells.some(([cx, cy]) => cx === x && cy === y);
  for (const [x, y] of cells) {
    const index = y * size + x;
    // One cell at a time, so a placement through several of these cells is dropped once.
    fillCell(state, index);
    state.cells[index] = encodeCell(op.color, inBrick(x + 1, y), inBrick(x, y + 1));
    diffs.push(diffAt(state, index));
  }
  return { ok: true, diffs };
}

function placeSingle(state: State, op: SingleOp, now: number): ApplyResult {
  if (!isInt(op.color, PALETTE_SIZE)) return { ok: false, reason: 'invalid' };
  const { size } = state.config;
  if (!isInt(op.x, size) || !isInt(op.y, size) || !inOpenArea(state, op.x, op.y)) {
    return { ok: false, reason: 'out_of_area' };
  }
  const index = op.y * size + op.x;
  if (isFilled(state.cells[index]!)) return { ok: false, reason: 'occupied' };
  if (canCover(state, op.x, op.y)) return { ok: false, reason: 'coverable' };
  const diffs = expireShields(state, now);
  // No placement fits through a hole, so this only counts the cell as filled.
  fillCell(state, index);
  // No link bits: a single brick is its own piece, even next to a cell of the same colour.
  state.cells[index] = encodeCell(op.color, false, false);
  diffs.push(diffAt(state, index));
  return { ok: true, diffs };
}

function hammer(state: State, op: HammerOp, now: number): ApplyResult {
  const { size } = state.config;
  if (!isInt(op.x, size) || !isInt(op.y, size) || !inOpenArea(state, op.x, op.y)) {
    return { ok: false, reason: 'out_of_area' };
  }
  const index = op.y * size + op.x;
  if (!isFilled(state.cells[index]!)) return { ok: false, reason: 'empty' };
  const diffs = expireShields(state, now);
  if (state.shields[index]! > 0) {
    breakLayer(state, index);
    diffs.push(diffAt(state, index));
    return { ok: true, diffs };
  }
  // Clearing the cell drops its own links to the right and below; the links that point
  // into it live in the left and upper neighbours, so those bits must be cleared too.
  // Otherwise a new brick placed in the hole would be drawn merged with the old one.
  state.cells[index] = 0;
  clearCell(state, index);
  diffs.push(diffAt(state, index));
  const left = index - 1;
  if (op.x > 0 && (state.cells[left]! & LINK_RIGHT) !== 0) {
    state.cells[left]! &= ~LINK_RIGHT;
    diffs.push(diffAt(state, left));
  }
  const up = index - size;
  if (op.y > 0 && (state.cells[up]! & LINK_DOWN) !== 0) {
    state.cells[up]! &= ~LINK_DOWN;
    diffs.push(diffAt(state, up));
  }
  return { ok: true, diffs };
}

function shield(state: State, op: ShieldOp, now: number): ApplyResult {
  const { size, maxShield } = state.config;
  if (!isInt(op.x, size) || !isInt(op.y, size) || !inOpenArea(state, op.x, op.y)) {
    return { ok: false, reason: 'out_of_area' };
  }
  const index = op.y * size + op.x;
  if (!isFilled(state.cells[index]!)) return { ok: false, reason: 'empty' };
  // Counted at `now` without touching the state, so a refusal changes nothing.
  if (liveLayers(state, index, now) >= maxShield) return { ok: false, reason: 'shield_full' };
  const diffs = expireShields(state, now);
  addLayer(state, index);
  diffs.push(diffAt(state, index));
  return { ok: true, diffs };
}
