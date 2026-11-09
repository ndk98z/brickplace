import { FILLED } from './cell.ts';
import {
  ORIENTATION_OF,
  ORIENTATIONS,
  PLACEMENT_COUNT,
  PLACEMENT_ORIENTATION,
  PLACEMENTS,
  type ShapeId,
} from './shapes.ts';
import type { State } from './state.ts';

// Anti-stuck counters (ADR 0010) and the single-brick cover check (ADR 0005). Every change of a
// cell between empty and filled goes through fillCell or clearCell, which look only at the 76
// placements through that cell, so an op costs O(76) per changed cell, never a scan.

export function inOpenArea(state: State, x: number, y: number): boolean {
  const { open } = state.config;
  return x >= open.x && y >= open.y && x < open.x + open.w && y < open.y + open.h;
}

/**
 * Calls `found(q)` for each placement q of the 76 through (x, y) whose four cells are empty
 * and inside the open area. Hot path: one call per changed cell, so it is kept to plain loops.
 */
function eachFit(state: State, x: number, y: number, found: (q: number) => void): void {
  const { cells } = state;
  const { size, open } = state.config;
  const x1 = open.x + open.w;
  const y1 = open.y + open.h;
  for (let q = 0; q < PLACEMENT_COUNT; q++) {
    const p = q * 8;
    let k = 0;
    for (; k < 8; k += 2) {
      const cx = x + PLACEMENTS[p + k]!;
      const cy = y + PLACEMENTS[p + k + 1]!;
      if (cx < open.x || cy < open.y || cx >= x1 || cy >= y1) break;
      if ((cells[cy * size + cx]! & FILLED) !== 0) break;
    }
    if (k === 8) found(q);
  }
}

/** Adds (+1) or removes (-1) one valid placement from the counters. */
function count(state: State, x: number, y: number, q: number, delta: 1 | -1): void {
  const { placements, cover } = state.counters;
  const { size } = state.config;
  placements[PLACEMENT_ORIENTATION[q]!]! += delta;
  const p = q * 8;
  for (let k = 0; k < 8; k += 2) {
    const index = (y + PLACEMENTS[p + k + 1]!) * size + x + PLACEMENTS[p + k]!;
    const before = cover[index]!;
    cover[index] = before + delta;
    if (before === 0) state.counters.reachable++;
    else if (before + delta === 0) state.counters.reachable--;
  }
}

/**
 * Call just before an empty open cell becomes filled: every placement through it that still
 * fits stops fitting.
 */
export function fillCell(state: State, index: number): void {
  state.counters.filled++;
  if (state.counters.cover[index] === 0) return;
  const { size } = state.config;
  const x = index % size;
  const y = (index - x) / size;
  eachFit(state, x, y, (q) => count(state, x, y, q, -1));
}

/** Call just after a filled cell became empty: placements through it may fit again. */
export function clearCell(state: State, index: number): void {
  state.counters.filled--;
  const { size } = state.config;
  const x = index % size;
  const y = (index - x) / size;
  eachFit(state, x, y, (q) => count(state, x, y, q, 1));
}

/**
 * Rebuilds every counter from the grid: O(open area x 19), plus one memset of `cover` over the
 * whole map. For createState and open area changes only.
 */
export function recount(state: State): void {
  const { size, open } = state.config;
  const { cells } = state;
  const { placements, cover } = state.counters;
  placements.fill(0);
  cover.fill(0);
  for (let o = 0; o < ORIENTATIONS.length; o++) {
    const offsets = ORIENTATIONS[o]!;
    const w = Math.max(...offsets.map(([dx]) => dx)) + 1;
    const h = Math.max(...offsets.map(([, dy]) => dy)) + 1;
    const [d0, d1, d2, d3] = offsets.map(([dx, dy]) => dy * size + dx) as [
      number,
      number,
      number,
      number,
    ];
    let valid = 0;
    for (let y = open.y; y + h <= open.y + open.h; y++) {
      const row = y * size;
      for (let x = open.x; x + w <= open.x + open.w; x++) {
        const at = row + x;
        if (
          ((cells[at + d0]! | cells[at + d1]! | cells[at + d2]! | cells[at + d3]!) & FILLED) !==
          0
        ) {
          continue;
        }
        valid++;
        cover[at + d0]!++;
        cover[at + d1]!++;
        cover[at + d2]!++;
        cover[at + d3]!++;
      }
    }
    placements[o] = valid;
  }
  // Cover is 0 outside the open area, and every filled cell lies inside it (it only grows).
  let reachable = 0;
  let filled = 0;
  for (let y = open.y; y < open.y + open.h; y++) {
    for (let i = y * size + open.x; i < y * size + open.x + open.w; i++) {
      if (cover[i] !== 0) reachable++;
      if ((cells[i]! & FILLED) !== 0) filled++;
    }
  }
  state.counters.reachable = reachable;
  state.counters.filled = filled;
}

/** True when at least one brick placement through (x, y) fits (O(1), from the counters). */
export function canCover(state: State, x: number, y: number): boolean {
  return inOpenArea(state, x, y) && state.counters.cover[y * state.config.size + x]! > 0;
}

/** True when the shape fits somewhere in at least one rotation: only then may it be drawn. */
export function shapeFits(state: State, shape: ShapeId): boolean {
  return ORIENTATION_OF[shape]!.some((o) => state.counters.placements[o]! > 0);
}

/** Empty open cells no brick can reach: only a single brick can fill them. */
export function holeCount(state: State): number {
  const { open } = state.config;
  return open.w * open.h - state.counters.filled - state.counters.reachable;
}
