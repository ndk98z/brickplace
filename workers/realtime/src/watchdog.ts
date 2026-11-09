// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.
//
// The tick watchdog of a FanoutDO shard (ADR 0028): a shard that follows its canvas expects a
// push whenever the map changes. If the canvas stops pushing to it (a canvas that lost the
// shard, pushes that keep failing), nothing else would ever bring its sockets the other shards'
// changes; the watchdog notices and follows again. Against a game script without cursor()
// (rolled back, run with one shard) it does nothing.

export const watchdogTiming = {
  /**
   * How often (ms) a shard with open sockets asks its canvas, through an alarm, whether it is
   * still followed and how far the log is. Tests set Infinity (no periodic alarm).
   */
  ms: 30_000,
  /**
   * How long (ms) the canvas may be ahead of a following shard's mirror without a tick
   * arriving before the shard follows again: well past one tick (250 ms) plus the canvas's
   * first retries. Tests that push ticks by hand set Infinity, or lower it.
   */
  stallMs: 3_000,
  /**
   * How long (ms) a following shard leaves the canvas's own retries to work when the canvas
   * says its pushes to the shard are failing (its backoff tops out at 30 s), before it follows
   * again. Each refollow copies the whole grid, so the two must not race.
   */
  backoffGraceMs: 33_000,
};

/**
 * Cost: while sockets are open, one alarm and one cursor() call per shard every `ms`, about
 * 5,760 requests a day per shard at 30 s; nothing while a shard has no sockets.
 */
