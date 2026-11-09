import { type State, shieldLifetime } from './state.ts';
import type { CellDiff } from './types.ts';

// Shield decay (ADR 0007): each layer expires a fixed time after it was placed. Time is the
// logical timestamp the op log carries; this module never reads a clock.

/**
 * True when `now` is usable as a logical timestamp: a non-negative integer small enough that
 * `now + shieldLifetime` (a layer's expiry) is still exact in every language's 53-bit range.
 */
export function isTime(state: State, now: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    now <= Number.MAX_SAFE_INTEGER - shieldLifetime(state.config)
  );
}

/** Shield layers of the cell still standing at `now` (which is at or after `state.clock`). */
export function liveLayers(state: State, index: number, now: number): number {
  const layers = state.shieldExpiry.get(index);
  let live = state.shields[index]!;
  if (!layers) return live;
  for (let i = 0; i < layers.length && layers[i]! <= now; i++) live--;
  return live;
}

/**
 * Advances the logical clock to `now` and drops every shield layer whose time is up (a layer
 * placed at t is gone at t + shieldLifetime, not one tick later). Returns the cells that
 * changed. A `now` before the clock changes nothing: the clock never goes back.
 * Internal: `apply` calls it before every accepted op. It is not exported from the package,
 * because a sweep the op log does not record, followed by an op logged with an earlier time,
 * would replay with a different clock. The one exception is `passTime` (restore.ts), for
 * replays that leave logged ops out: the log does record those ops' times (ADR 0024).
 */
export function expireShields(state: State, now: number): CellDiff[] {
  if (!isTime(state, now)) throw new RangeError(`invalid logical time ${now}`);
  const diffs: CellDiff[] = [];
  if (now <= state.clock) return diffs;
  state.clock = now;
  const queue = state.expiryQueue;
  while (queue.head < queue.times.length && queue.times[queue.head]! <= now) {
    const index = queue.cells[queue.head]!;
    queue.head++;
    const layers = state.shieldExpiry.get(index);
    if (!layers) continue;
    let expired = 0;
    while (expired < layers.length && layers[expired]! <= now) expired++;
    if (expired === 0) continue;
    layers.splice(0, expired);
    state.shields[index] = layers.length;
    if (layers.length === 0) state.shieldExpiry.delete(index);
    diffs.push({ index, cell: state.cells[index]!, shield: state.shields[index]! });
  }
  // Drop the consumed prefix once it dominates, so the queue stays proportional to live layers.
  if (queue.head > 1024 && queue.head * 2 > queue.times.length) {
    queue.times.splice(0, queue.head);
    queue.cells.splice(0, queue.head);
    queue.head = 0;
  }
  return diffs;
}

/** Adds one layer placed at the current clock. */
export function addLayer(state: State, index: number): void {
  const expiry = state.clock + shieldLifetime(state.config);
  const layers = state.shieldExpiry.get(index);
  if (layers) layers.push(expiry);
  else state.shieldExpiry.set(index, [expiry]);
  state.expiryQueue.times.push(expiry);
  state.expiryQueue.cells.push(index);
  state.shields[index]! += 1;
}

/**
 * Removes the layer a hammer breaks. The owner chose newest first (the one that would have
 * lasted longest), so the layers left are the older ones. This is the only place that choice
 * lives; changing it changes golden fixture shield-decay.
 */
export function breakLayer(state: State, index: number): void {
  const layers = state.shieldExpiry.get(index);
  if (layers) {
    layers.pop();
    if (layers.length === 0) state.shieldExpiry.delete(index);
  }
  state.shields[index]! -= 1;
}
