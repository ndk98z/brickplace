import { describe, expect, it } from 'vitest';
import { SendGate } from '../src/gate.ts';

const WAIT_MS = 30_000;

/** A gate whose timers the test fires by hand, with the delays they asked for. */
function manualGate(limit: number, maxWaiting: number, bytesPerMs: number) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const gate = new SendGate(limit, maxWaiting, bytesPerMs, WAIT_MS, {
    set: (fn, ms) => {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clear: (handle) => {
      (handle as { live: boolean }).live = false;
    },
  });
  /** Fires the first live timer of this delay. */
  const fire = (ms: number) => {
    const timer = timers.find((t) => t.live && t.ms === ms)!;
    timer.live = false;
    timer.fn();
  };
  const live = () => timers.filter((t) => t.live).map((t) => t.ms);
  return { gate, fire, live, all: () => timers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SendGate', () => {
  it('lets `limit` in at once, queues the rest in order and turns away past the queue', async () => {
    const { gate, fire, live } = manualGate(2, 2, 1000);
    const a = (await gate.enter())!;
    const b = (await gate.enter())!;
    const order: string[] = [];
    const c = gate.enter().then((slot) => {
      order.push('c');
      return slot;
    });
    const d = gate.enter().then((slot) => {
      order.push('d');
      return slot;
    });
    expect(await gate.enter()).toBeNull();
    expect(gate.load).toEqual({ active: 2, waiting: 2 });

    // A 6 MB grid at 1000 bytes/ms holds its place for 6 s; then the first waiter gets it.
    a.leave(6_000_000);
    expect(live()).toEqual([WAIT_MS, WAIT_MS, 6000]);
    await tick();
    expect(order).toEqual([]);
    fire(6000);
    expect(await c).not.toBeNull();
    expect(order).toEqual(['c']);
    expect(gate.load).toEqual({ active: 2, waiting: 1 });
    // Served: its wait timer is cleared.
    expect(live()).toEqual([WAIT_MS]);

    // An empty grid leaves at once; leaving twice counts once.
    b.leave(0);
    b.leave(0);
    expect(await d).not.toBeNull();
    expect(order).toEqual(['c', 'd']);
    expect(gate.load).toEqual({ active: 2, waiting: 0 });
    expect(live()).toEqual([]);
  });

  it('gives up on a waiter after the longest wait, and its place goes to no one', async () => {
    const { gate, fire, all } = manualGate(1, 4, 1);
    const a = (await gate.enter())!;
    const late = gate.enter();
    const later = gate.enter();
    expect(gate.load).toEqual({ active: 1, waiting: 2 });
    fire(WAIT_MS);
    expect(await late).toBeNull();
    expect(gate.load).toEqual({ active: 1, waiting: 1 });
    // The place then goes to the next waiter still there.
    a.leave(0);
    expect(await later).not.toBeNull();
    // Its wait timer was cleared; even if it fired late, it would change nothing.
    expect(() => fire(WAIT_MS)).toThrow();
    for (const timer of all()) if (timer.ms === WAIT_MS) timer.fn();
    expect(gate.load).toEqual({ active: 1, waiting: 0 });
  });

  it('frees places when nobody waits, and caps how long one grid holds a place', async () => {
    const { gate, fire, live } = manualGate(1, 0, 1);
    const a = (await gate.enter())!;
    expect(await gate.enter()).toBeNull();
    a.leave(10 ** 9);
    expect(live()).toEqual([10_000]);
    fire(10_000);
    expect(gate.load).toEqual({ active: 0, waiting: 0 });
    expect(await gate.enter()).not.toBeNull();
  });

  it('refuses a configuration that could never let anyone in', () => {
    expect(() => new SendGate(0, 1, 1, 1)).toThrow(RangeError);
    expect(() => new SendGate(1, -1, 1, 1)).toThrow(RangeError);
    expect(() => new SendGate(1, 1, 0, 1)).toThrow(RangeError);
    expect(() => new SendGate(1, 1, 1, 0)).toThrow(RangeError);
  });
});
