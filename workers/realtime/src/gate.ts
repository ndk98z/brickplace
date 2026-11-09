// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.

/** A place in the gate, held while one socket's initial grid goes out. */
export interface GateSlot {
  /**
   * Frees the place once `bytes` (what was sent) have had time to drain at the gate's rate.
   * Safe to call more than once; only the first call counts.
   */
  leave(bytes: number): void;
}

export interface GateTimers {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const REAL_TIMERS: GateTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Longest a place is held for one grid, whatever the estimate says. */
const MAX_HOLD_MS = 10_000;

interface Waiter {
  readonly admit: () => void;
  readonly timer: unknown;
}

/**
 * Caps how many initial grids go out at once. A socket's whole grid is handed to the runtime
 * in one go (up to about 6 MiB late in a season), and the runtime buffers what the network
 * has not taken yet; in a reconnect storm a thousand sockets at once would buffer gigabytes.
 *
 * Workers WebSockets report no buffered amount, so a place is held for the time the grid
 * should take to drain at `bytesPerMs`, an estimate, not a measurement. Small grids (early
 * in a season) leave at once. Waiters are served in arrival order. At most `maxWaiting`
 * wait, and none longer than `maxWaitMs`: past either, `enter` answers null and the client
 * retries after its jittered backoff, so memory and the wait for a join stay bounded, and a
 * client that left meanwhile does not keep a place for long.
 */
export class SendGate {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(
    readonly limit: number,
    readonly maxWaiting: number,
    readonly bytesPerMs: number,
    readonly maxWaitMs: number,
    private readonly timers: GateTimers = REAL_TIMERS,
  ) {
    if (!(limit >= 1) || !(maxWaiting >= 0) || !(bytesPerMs > 0) || !(maxWaitMs > 0)) {
      throw new RangeError('gate needs a positive limit, rate and wait, and a queue of 0 or more');
    }
  }

  /** Sockets sending or waiting to send their grid. */
  get load(): { readonly active: number; readonly waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  /**
   * Resolves with a place, or with null when the queue is full or the wait ran out: the
   * caller then turns the client away.
   */
  enter(): Promise<GateSlot | null> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.slot());
    }
    if (this.waiting.length >= this.maxWaiting) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        admit: () => {
          this.timers.clear(waiter.timer);
          resolve(this.slot());
        },
        timer: this.timers.set(() => {
          const at = this.waiting.indexOf(waiter);
          if (at < 0) return;
          this.waiting.splice(at, 1);
          resolve(null);
        }, this.maxWaitMs),
      };
      this.waiting.push(waiter);
    });
  }

  private slot(): GateSlot {
    let left = false;
    return {
      leave: (bytes: number) => {
        if (left) return;
        left = true;
        const ms = Math.min(MAX_HOLD_MS, Math.ceil(Math.max(0, bytes) / this.bytesPerMs));
        if (ms === 0) this.release();
        else this.timers.set(() => this.release(), ms);
      },
    };
  }

  /** Hands the place to the next waiter, or frees it. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next.admit();
    else this.active--;
  }
}
