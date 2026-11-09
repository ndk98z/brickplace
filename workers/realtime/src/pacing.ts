// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.
//
// How a FanoutDO shard paces its work (ADR 0041): map changes reach its sockets at most once
// per flush, and its ops reach the canvas in batches, one call in flight at a time. Without
// it, a shard's frames grew with ops × sockets and its canvas calls with ops, and 2,000 busy
// players on one shard queued its requests past what it could take (2026-10-27 measurement).

/** The least time (ms) between two flushes of map changes to the sockets. */
export const FLUSH_MS = 250;

export const flushTiming = {
  /**
   * The flush interval in use. A change with no flush in the `ms` before it goes out at once;
   * the rest wait for the next flush. Tests set 0 (every change at once) unless a test is
   * about the pacing itself.
   */
  ms: FLUSH_MS,
};

/**
 * Cells waiting for a flush past which they go out at once: a large catch-up tick or shield
 * expiry between two flushes must not grow the set without bound (a few MB at this size).
 */
export const MAX_PENDING_CELLS = 1 << 16;

/** Ops in one applyBatch call to the canvas, at most. */
export const MAX_RELAY_BATCH = 64;
/** Ops waiting for the call in flight, past which new ones are refused `busy` at once. */
export const MAX_RELAY_WAITING = 256;
/**
 * A call in flight longer than this (ms) counts as failed, so one stuck call cannot hold
 * every op of the shard: its ops are answered `unavailable` and the next call goes out. The
 * canvas may still apply them; the pages' retries are then answered as duplicates.
 */
export const RELAY_TIMEOUT_MS = 10_000;

/** The relay limits in use; tests lower them. */
export const relayLimits = {
  batch: MAX_RELAY_BATCH,
  waiting: MAX_RELAY_WAITING,
  timeoutMs: RELAY_TIMEOUT_MS,
};
