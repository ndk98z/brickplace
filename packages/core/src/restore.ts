import { colorOf, FILLED, LINK_DOWN, LINK_RIGHT } from './cell.ts';
import { SHIELD_CEILING } from './constants.ts';
import { clearCell, fillCell, inOpenArea } from './cover.ts';
import { expireShields, isTime } from './shields.ts';
import { type State, shieldLifetime } from './state.ts';
import type { ApplyResult, CellDiff, RestoreCell, RestoreEntry } from './types.ts';

// Moderation rollbacks (ADR 0024). The server replays the log without the ops a moderator
// rolls back, compares that replay with the live grid, and logs the cells that differ as one
// `restore` entry carrying their values. Replaying the entry sets them again, so a restart, a
// checkpoint plus its tail and any port of the core reach the same grid without knowing which
// ops were rolled back. Integers only; no clock is read here.

const INVALID: ApplyResult = { ok: false, reason: 'invalid' };

/**
 * Sets every listed cell to its value, shield layers included, or changes nothing and returns
 * `invalid` when the entry is malformed or the grid would break an invariant every replayed
 * state keeps: filled cells inside the open area, empty cells all zero, link bits pointing at a
 * filled cell of the same colour (from the listed cells and into them), shields only on filled
 * cells and at most maxShield, each layer expiring after the clock and no later than a layer
 * placed now would. Takes no time. Counters change through fillCell and clearCell only.
 */
export function applyRestore(state: State, entry: RestoreEntry): ApplyResult {
  const cells = checked(state, entry);
  if (!cells) return INVALID;
  const diffs: CellDiff[] = [];
  /** Restored layers' expiries, entered in the queue together once the cells are set. */
  const layers: { time: number; index: number }[] = [];
  for (const item of cells) {
    const index = item[0];
    const cell = item[1];
    const wasFilled = (state.cells[index]! & FILLED) !== 0;
    const filled = (cell & FILLED) !== 0;
    state.shieldExpiry.delete(index);
    state.shields[index] = 0;
    if (!wasFilled && filled) {
      // One cell at a time, as a brick fills its four: the counters follow the grid.
      fillCell(state, index);
      state.cells[index] = cell;
    } else if (wasFilled && !filled) {
      state.cells[index] = 0;
      clearCell(state, index);
    } else {
      state.cells[index] = cell;
    }
    if (item.length > 2) {
      const times = item.slice(2);
      state.shieldExpiry.set(index, times);
      state.shields[index] = times.length;
      for (const time of times) layers.push({ time, index });
    }
    diffs.push({ index, cell: state.cells[index]!, shield: state.shields[index]! });
  }
  queueExpiries(state, layers);
  return { ok: true, diffs };
}

/**
 * The restore entry that turns `live` into `target`: every cell whose byte, shield count or
 * layer expiry times differ, with its value in `target`, by increasing index. `target` is a
 * scratch replay of the same map (same size, open area and shield rules) that left some ops
 * out; its clock is first brought up to the live one (expired layers go, as at the next op),
 * which changes `target`. Throws when the two cannot describe the same map. Stops after
 * `limit + 1` cells, so a caller that cannot use more than `limit` learns it without holding
 * every difference of two very different maps.
 */
export function restoreEntry(
  live: State,
  target: State,
  limit: number = Number.POSITIVE_INFINITY,
): RestoreEntry {
  const a = live.config;
  const b = target.config;
  if (
    a.size !== b.size ||
    a.maxShield !== b.maxShield ||
    shieldLifetime(a) !== shieldLifetime(b) ||
    a.open.x !== b.open.x ||
    a.open.y !== b.open.y ||
    a.open.w !== b.open.w ||
    a.open.h !== b.open.h
  ) {
    throw new RangeError('restoreEntry: the two states do not share their rules');
  }
  if (target.clock > live.clock) throw new RangeError('restoreEntry: the target is ahead');
  passTime(target, live.clock);
  const cells: RestoreCell[] = [];
  const area = a.size * a.size;
  for (let i = 0; i < area; i++) {
    const shields = target.shields[i]!;
    if (
      live.cells[i] === target.cells[i] &&
      live.shields[i] === shields &&
      (shields === 0 || sameTimes(live.shieldExpiry.get(i), target.shieldExpiry.get(i)))
    ) {
      continue;
    }
    cells.push([i, target.cells[i]!, ...(target.shieldExpiry.get(i) ?? [])]);
    if (cells.length > limit) break;
  }
  return { kind: 'restore', cells };
}

/**
 * Moves the clock to `now`, dropping the shield layers whose time is up, and returns the cells
 * that changed; an invalid time changes nothing. For replays that leave logged ops out (ADR
 * 0024): each row of player ops moved the live clock when it was accepted, so it moves a
 * replay's clock too, whatever becomes of its ops there.
 */
export function passTime(state: State, now: number): CellDiff[] {
  return isTime(state, now) ? expireShields(state, now) : [];
}

function sameTimes(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * The entry's cells when every one is well formed and the grid they leave keeps its
 * invariants, else null. Reads the state, changes nothing.
 */
function checked(state: State, entry: RestoreEntry): readonly RestoreCell[] | null {
  const list: unknown = (entry as { cells?: unknown }).cells;
  if (!Array.isArray(list)) return null;
  const { size, maxShield } = state.config;
  const area = size * size;
  const latest = state.clock + shieldLifetime(state.config);
  const next = new Map<number, number>();
  let previous = -1;
  for (const raw of list as unknown[]) {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const item = raw as readonly unknown[];
    const index = item[0];
    const cell = item[1];
    if (!Number.isInteger(index) || (index as number) <= previous || (index as number) >= area) {
      return null;
    }
    if (!Number.isInteger(cell) || (cell as number) < 0 || (cell as number) > 0xff) return null;
    const i = index as number;
    const value = cell as number;
    const layers = item.length - 2;
    if ((value & FILLED) === 0) {
      if (value !== 0 || layers > 0) return null;
    } else {
      const x = i % size;
      if (!inOpenArea(state, x, (i - x) / size)) return null;
      if (layers > maxShield || layers > SHIELD_CEILING) return null;
      let after = state.clock;
      for (let k = 2; k < item.length; k++) {
        const time = item[k];
        // Sorted, after the clock (a layer whose time is up is gone) and no later than a
        // layer placed now: a restore never makes a shield last longer than it could.
        if (!Number.isSafeInteger(time) || (time as number) <= state.clock) return null;
        if ((time as number) < after || (time as number) > latest) return null;
        after = time as number;
      }
    }
    next.set(i, value);
    previous = i;
  }
  const at = (i: number) => next.get(i) ?? state.cells[i]!;
  /** A link from cell `from` (byte `value`) to cell `to` lands on a filled cell of its colour. */
  const lands = (value: number, to: number) => {
    const target = at(to);
    return (target & FILLED) !== 0 && colorOf(target) === colorOf(value);
  };
  for (const [i, value] of next) {
    const x = i % size;
    const y = (i - x) / size;
    if ((value & LINK_RIGHT) !== 0 && (x + 1 >= size || !lands(value, i + 1))) return null;
    if ((value & LINK_DOWN) !== 0 && (y + 1 >= size || !lands(value, i + size))) return null;
    // Links into this cell from neighbours the entry leaves as they are.
    if (x > 0 && !next.has(i - 1)) {
      const left = state.cells[i - 1]!;
      if ((left & LINK_RIGHT) !== 0 && !lands(left, i)) return null;
    }
    if (y > 0 && !next.has(i - size)) {
      const up = state.cells[i - size]!;
      if ((up & LINK_DOWN) !== 0 && !lands(up, i)) return null;
    }
  }
  return list as readonly RestoreCell[];
}

/**
 * Enters restored layers' expiries in the queue at their place in time, in one merge of the
 * live part: each goes after the entries already queued at an equal time, and equal times of
 * restored layers keep the entry's order (cells by index, layers oldest first). That is the
 * order the layers would get one by one, so replays stay byte for byte the same. Every live
 * entry lies after the clock, and so does every restored one: the consumed prefix is untouched.
 */
function queueExpiries(state: State, layers: { time: number; index: number }[]): void {
  if (layers.length === 0) return;
  // Stable: equal times keep the entry's order.
  layers.sort((a, b) => a.time - b.time);
  const queue = state.expiryQueue;
  const times = queue.times.slice(0, queue.head);
  const cells = queue.cells.slice(0, queue.head);
  let q = queue.head;
  for (const { time, index } of layers) {
    while (q < queue.times.length && queue.times[q]! <= time) {
      times.push(queue.times[q]!);
      cells.push(queue.cells[q]!);
      q++;
    }
    times.push(time);
    cells.push(index);
  }
  for (; q < queue.times.length; q++) {
    times.push(queue.times[q]!);
    cells.push(queue.cells[q]!);
  }
  // The arrays are the state's own (readonly fields): copied back in place, no spread.
  for (let k = 0; k < times.length; k++) {
    queue.times[k] = times[k]!;
    queue.cells[k] = cells[k]!;
  }
}
