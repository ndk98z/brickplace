import type { HoldView, OpResult, Rules, Snapshot } from '@brickplace/game';
import {
  encodeServerMessage,
  MAX_DIFFS_PER_FRAME,
  Opcode,
  PROTOCOL_VERSION,
  ProtocolError,
} from '@brickplace/protocol';

// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.

type CellDiff = Extract<OpResult, { ok: true }>['diffs'][number];

const DIFFS_HEADER = 8;
const DIFF_BYTES = 6;

/**
 * Diff frames for every cell of `grid` that `include` selects, with the cell's value in
 * `grid`. Up to a million cells at Stage 0, so the records are written straight into the
 * frames (counted first, no CellDiff objects). Same layout as encodeServerMessage's diffs
 * frame; the tests decode these frames with decodeServerMessage to keep the two in step.
 */
export function cellFrames(
  grid: Pick<Snapshot, 'seq' | 'cells' | 'shields'>,
  include: (index: number) => boolean,
): Uint8Array[] {
  const { seq, cells, shields } = grid;
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new ProtocolError(`seq ${seq} out of range 0..${0xffffffff}`);
  }
  let left = 0;
  for (let i = 0; i < cells.length; i++) if (include(i)) left++;
  const frames: Uint8Array[] = [];
  let index = 0;
  do {
    const count = Math.min(left, MAX_DIFFS_PER_FRAME);
    const view = new DataView(new ArrayBuffer(DIFFS_HEADER + count * DIFF_BYTES));
    view.setUint8(0, PROTOCOL_VERSION);
    view.setUint8(1, Opcode.Diffs);
    view.setUint32(2, seq, true);
    view.setUint16(6, count, true);
    for (let written = 0; written < count; index++) {
      if (!include(index)) continue;
      const at = DIFFS_HEADER + written * DIFF_BYTES;
      view.setUint32(at, index, true);
      view.setUint8(at + 4, cells[index]!);
      view.setUint8(at + 5, shields[index]!);
      written++;
    }
    frames.push(new Uint8Array(view.buffer));
    left -= count;
  } while (left > 0);
  return frames;
}

/**
 * Diff frames for the cells at `indices` (ascending), with their values in `grid`: what a
 * resuming socket gets (ADR 0040). Same layout as cellFrames, all full but the last, and at
 * least one, so the page learns the seq even when nothing changed.
 */
export function indexFrames(
  grid: Pick<Snapshot, 'seq' | 'cells' | 'shields'>,
  indices: Uint32Array,
): Uint8Array[] {
  const { seq, cells, shields } = grid;
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new ProtocolError(`seq ${seq} out of range 0..${0xffffffff}`);
  }
  const frames: Uint8Array[] = [];
  let at = 0;
  do {
    const count = Math.min(indices.length - at, MAX_DIFFS_PER_FRAME);
    const view = new DataView(new ArrayBuffer(DIFFS_HEADER + count * DIFF_BYTES));
    view.setUint8(0, PROTOCOL_VERSION);
    view.setUint8(1, Opcode.Diffs);
    view.setUint32(2, seq, true);
    view.setUint16(6, count, true);
    for (let i = 0; i < count; i++) {
      const index = indices[at + i]!;
      const offset = DIFFS_HEADER + i * DIFF_BYTES;
      view.setUint32(offset, index, true);
      view.setUint8(offset + 4, cells[index] ?? 0);
      view.setUint8(offset + 5, shields[index] ?? 0);
    }
    frames.push(new Uint8Array(view.buffer));
    at += count;
  } while (at < indices.length);
  return frames;
}

/**
 * A hold message for a hold read from the canvas. The canvas gives the next item's time on
 * its clock; the client gets the delay from `now`, so its own clock never matters.
 */
export function holdFrame(hold: HoldView, now: number): Uint8Array {
  const nextIn =
    hold.nextAt === null ? null : Math.min(MAX_NEXT_IN, Math.max(0, hold.nextAt - now));
  return encodeServerMessage({
    type: 'hold',
    capacity: hold.capacity,
    cooldown: hold.cooldown,
    nextIn,
    revision: hold.revision,
    items: hold.items,
  });
}

/** Largest delay a hold frame carries (u32, one value kept for "none"): about 49 days. */
const MAX_NEXT_IN = 0xfffffffe;

/** At least one frame, so even an empty grid tells the client which seq it starts from. */
export function diffFrames(seq: number, diffs: readonly CellDiff[]): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let at = 0;
  do {
    const part = diffs.slice(at, at + MAX_DIFFS_PER_FRAME);
    frames.push(encodeServerMessage({ type: 'diffs', seq, diffs: part }));
    at += MAX_DIFFS_PER_FRAME;
  } while (at < diffs.length);
  return frames;
}

/**
 * The config frame for the canvas rules (open area, maxShield, area locks) a client checks
 * moves with. Locks go out only from a canvas that sends them (ADR 0024), as appended bytes;
 * `views` says this FanoutDO takes View frames (ADR 0028).
 */
export function configFrame(rules: Rules, views = false): Uint8Array {
  return encodeServerMessage({
    type: 'config',
    mapSize: rules.mapSize,
    open: rules.open,
    maxShield: rules.maxShield,
    ...(rules.locks !== undefined ? { locks: rules.locks } : {}),
    ...(views ? { views: true } : {}),
  });
}

/** True when two rule sets would give clients the same config frame. */
export function sameRules(a: Rules | null, b: Rules | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.mapSize === b.mapSize &&
    a.maxShield === b.maxShield &&
    sameRect(a.open, b.open) &&
    (a.locks === undefined) === (b.locks === undefined) &&
    (a.locks ?? []).length === (b.locks ?? []).length &&
    (a.locks ?? []).every((lock, i) => sameRect(lock, b.locks![i]!))
  );
}

function sameRect(a: Rules['open'], b: Rules['open']): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * True when `rules` were read before `known`: at an older canvas seq, or at the same seq
 * before a lock change (which takes no seq; ADR 0024). Such rules could undo newer ones.
 */
export function olderRules(rules: Rules, known: Rules): boolean {
  const seq = rules.seq ?? 0;
  const knownSeq = known.seq ?? 0;
  if (seq !== knownSeq) return seq < knownSeq;
  return (rules.locksRev ?? 0) < (known.locksRev ?? 0);
}
