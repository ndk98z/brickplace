import { FILLED, LINK_DOWN, LINK_RIGHT } from './cell.ts';
import { recount } from './cover.ts';
import { gridHash } from './hash.ts';
import { emptyState, type State, shieldLifetime } from './state.ts';
import type { CoreConfig } from './types.ts';

// Checkpoints (ADR 0014): everything replay needs to carry on from a point in the op log as if
// it had replayed the whole log up to there. Little-endian, integers only, so any port of the
// core can read and write the same bytes:
//
//   0  magic "BPCK"              4  format u16 (1)        6  reserved u16 (0)
//   8  size u32                  12 open x, y, w, h u32   28 maxShield u32
//   32 shieldLifetime u64        40 clock u64
//   48 live queue entries u32    52 shield layers u32 (sum of all shields)
//   56 cells (size² bytes), shields (size² bytes)
//      then, for each cell with shields in index order, its layers' expiry times oldest first
//      (u64 each), then the live part of the expiry queue: its times (u64), then its cells (u32).
//
// The anti-stuck counters are not stored: they are a function of the grid and the open area,
// so decoding recounts them, which also means a checkpoint can never carry wrong counters.
// u64 values are written as two u32 (low word first) and must be safe integers.
//
// The encoding is canonical: states reached by the same history encode to the same bytes,
// however they got there (replayed in one go, or restored from an earlier checkpoint and then
// replayed), since only the live part of the queue is written and layers go in cell order.
// That is how the tests tell two states are the same. Two different histories that end in
// grids which behave alike may still encode differently (stale queue entries for broken
// layers are kept), which is fine: they are different states.

const MAGIC = 0x4b435042; // "BPCK" read as a little-endian u32
export const CHECKPOINT_FORMAT = 1;
const HEADER = 56;
const TWO_32 = 2 ** 32;

export class CheckpointError extends Error {}

/** Encodes the state as a checkpoint. Does not change the state. */
export function encodeCheckpoint(state: State): Uint8Array {
  const { config, cells, shields, shieldExpiry, expiryQueue } = state;
  const { size, open, maxShield } = config;
  const area = size * size;
  let layers = 0;
  for (let i = 0; i < area; i++) layers += shields[i]!;
  const live = expiryQueue.times.length - expiryQueue.head;
  const bytes = new Uint8Array(HEADER + 2 * area + 8 * layers + 12 * live);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, CHECKPOINT_FORMAT, true);
  view.setUint32(8, size, true);
  view.setUint32(12, open.x, true);
  view.setUint32(16, open.y, true);
  view.setUint32(20, open.w, true);
  view.setUint32(24, open.h, true);
  view.setUint32(28, maxShield, true);
  setU64(view, 32, shieldLifetime(config));
  setU64(view, 40, state.clock);
  view.setUint32(48, live, true);
  view.setUint32(52, layers, true);
  bytes.set(cells, HEADER);
  bytes.set(shields, HEADER + area);
  let at = HEADER + 2 * area;
  for (let i = 0; i < area; i++) {
    const n = shields[i]!;
    if (n === 0) continue;
    const times = shieldExpiry.get(i);
    if (!times || times.length !== n) {
      throw new CheckpointError(`cell ${i} has ${n} shields but ${times?.length ?? 0} expiries`);
    }
    for (const t of times) {
      setU64(view, at, t);
      at += 8;
    }
  }
  for (let q = expiryQueue.head; q < expiryQueue.times.length; q++) {
    setU64(view, at, expiryQueue.times[q]!);
    at += 8;
  }
  for (let q = expiryQueue.head; q < expiryQueue.cells.length; q++) {
    view.setUint32(at, expiryQueue.cells[q]!, true);
    at += 4;
  }
  return bytes;
}

/**
 * Rebuilds a state from a checkpoint, counters included. Throws CheckpointError on bytes that
 * are not a well-formed checkpoint or break an invariant every replayed state keeps: filled
 * cells and link bits inside the open area and pointing at filled cells, empty cells all zero,
 * shields only on filled cells and at most maxShield, expiry times sorted and after the clock.
 * These checks catch damage and encoder bugs; they do not prove a history could have
 * produced the state (the checksums and gridHash the canvas stores do the rest).
 */
export function decodeCheckpoint(bytes: Uint8Array): State {
  const state = parse(bytes);
  recount(state);
  return state;
}

/**
 * Runs every check decodeCheckpoint runs and returns the gridHash of the state, without
 * building the counters (most of a decode's cost): for checking a checkpoint just written.
 */
export function verifyCheckpoint(bytes: Uint8Array): string {
  return gridHash(parse(bytes));
}

/** The checked state, counters still zero. */
function parse(bytes: Uint8Array): State {
  if (bytes.byteLength < HEADER) throw new CheckpointError('checkpoint too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new CheckpointError('not a checkpoint');
  const format = view.getUint16(4, true);
  if (format !== CHECKPOINT_FORMAT) throw new CheckpointError(`unknown format ${format}`);
  const size = view.getUint32(8, true);
  const config: CoreConfig = {
    size,
    open: {
      x: view.getUint32(12, true),
      y: view.getUint32(16, true),
      w: view.getUint32(20, true),
      h: view.getUint32(24, true),
    },
    maxShield: view.getUint32(28, true),
    shieldLifetime: getU64(view, 32),
  };
  let state: State;
  try {
    state = emptyState(config);
  } catch (error) {
    throw new CheckpointError(`invalid config: ${(error as Error).message}`);
  }
  const clock = getU64(view, 40);
  const live = view.getUint32(48, true);
  const layers = view.getUint32(52, true);
  const area = size * size;
  if (bytes.byteLength !== HEADER + 2 * area + 8 * layers + 12 * live) {
    throw new CheckpointError('checkpoint length does not match its header');
  }
  state.clock = clock;
  state.cells.set(bytes.subarray(HEADER, HEADER + area));
  state.shields.set(bytes.subarray(HEADER + area, HEADER + 2 * area));
  const { open } = config;
  let at = HEADER + 2 * area;
  let counted = 0;
  const filledAt = (i: number) => (state.cells[i]! & FILLED) !== 0;
  for (let i = 0; i < area; i++) {
    const cell = state.cells[i]!;
    const filled = (cell & FILLED) !== 0;
    const n = state.shields[i]!;
    if (filled) {
      const x = i % size;
      const y = (i - x) / size;
      if (x < open.x || y < open.y || x >= open.x + open.w || y >= open.y + open.h) {
        throw new CheckpointError(`filled cell ${i} outside the open area`);
      }
      if ((cell & LINK_RIGHT) !== 0 && (x + 1 >= size || !filledAt(i + 1))) {
        throw new CheckpointError(`cell ${i} links right to an empty cell`);
      }
      if ((cell & LINK_DOWN) !== 0 && (y + 1 >= size || !filledAt(i + size))) {
        throw new CheckpointError(`cell ${i} links down to an empty cell`);
      }
    } else if (cell !== 0) {
      throw new CheckpointError(`empty cell ${i} has bits set`);
    }
    if (n === 0) continue;
    if (!filled) throw new CheckpointError(`shields on empty cell ${i}`);
    if (n > config.maxShield) throw new CheckpointError(`cell ${i} has more than maxShield`);
    counted += n;
    if (counted > layers) throw new CheckpointError('more shields than expiry times');
    const times: number[] = [];
    let previous = clock;
    for (let k = 0; k < n; k++) {
      const t = getU64(view, at);
      // Every layer whose time is up was swept when the clock reached it.
      if (t <= clock || t < previous) {
        throw new CheckpointError(`cell ${i}: expiry times unsorted or already past`);
      }
      previous = t;
      times.push(t);
      at += 8;
    }
    state.shieldExpiry.set(i, times);
  }
  if (counted !== layers) throw new CheckpointError('fewer shields than expiry times');
  const { times, cells } = state.expiryQueue;
  for (let q = 0; q < live; q++) {
    const t = getU64(view, at);
    if (q > 0 && t < times[q - 1]!) throw new CheckpointError('expiry queue out of order');
    times.push(t);
    at += 8;
  }
  for (let q = 0; q < live; q++) {
    const cell = view.getUint32(at, true);
    if (cell >= area) throw new CheckpointError(`queue cell ${cell} outside the map`);
    cells.push(cell);
    at += 4;
  }
  return state;
}

function setU64(view: DataView, at: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CheckpointError(`${value} is not a safe non-negative integer`);
  }
  view.setUint32(at, value % TWO_32, true);
  view.setUint32(at + 4, Math.floor(value / TWO_32), true);
}

function getU64(view: DataView, at: number): number {
  const value = view.getUint32(at, true) + view.getUint32(at + 4, true) * TWO_32;
  if (!Number.isSafeInteger(value)) throw new CheckpointError('time out of the safe range');
  return value;
}
