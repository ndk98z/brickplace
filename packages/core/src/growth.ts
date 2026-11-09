import type { State } from './state.ts';
import type { Rect } from './types.ts';

// When the open area grows by itself (ADR 0013). The decision is taken by the server after
// a batch and written to the op log as an `open` entry, so a replay never calls this: the
// log, not the rule, is what replays. Integers only, so every port decides alike.

/**
 * The open area grows by `step` cells on each side (clamped to the map) once its filled
 * cells reach `atPercent` percent of it.
 */
export interface OpenGrowth {
  /** Integer, 1 to 100. */
  readonly atPercent: number;
  /** Cells added on each side; a positive integer. */
  readonly step: number;
}

/**
 * The design doc's 70% threshold and ADR 0027's 128 cells a side: on the 1024² map with a 512²
 * start, 512² → 768² → 1024².
 */
export const DEFAULT_OPEN_GROWTH: OpenGrowth = { atPercent: 70, step: 128 };

/** Throws unless `atPercent` is an integer from 1 to 100 and `step` a positive integer. */
export function checkGrowth(growth: OpenGrowth): void {
  const { atPercent, step } = growth;
  if (!Number.isInteger(atPercent) || atPercent < 1 || atPercent > 100) {
    throw new RangeError('growth.atPercent must be an integer from 1 to 100');
  }
  if (!Number.isInteger(step) || step < 1) {
    throw new RangeError('growth.step must be a positive integer');
  }
}

/**
 * The rectangle the open area grows to now, or null when it does not grow: filled cells are
 * under the threshold, or the whole map is already open. Reads the state, changes nothing.
 */
export function nextOpenArea(state: State, growth: OpenGrowth): Rect | null {
  const { size, open } = state.config;
  if (state.counters.filled * 100 < growth.atPercent * open.w * open.h) return null;
  const x = Math.max(0, open.x - growth.step);
  const y = Math.max(0, open.y - growth.step);
  const next = {
    x,
    y,
    w: Math.min(size, open.x + open.w + growth.step) - x,
    h: Math.min(size, open.y + open.h + growth.step) - y,
  };
  return next.w === open.w && next.h === open.h ? null : next;
}
