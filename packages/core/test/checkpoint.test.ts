import { describe, expect, it } from 'vitest';
import {
  type ApplyResult,
  apply,
  applyEntry,
  CheckpointError,
  type CoreConfig,
  canCover,
  createState,
  decodeCheckpoint,
  encodeCheckpoint,
  gridHash,
  isFilled,
  type Op,
  type Rect,
  type Rotation,
  type ShapeId,
  type State,
  verifyCheckpoint,
} from '../src/index.ts';

/** Small deterministic generator (mulberry32) so failures replay; the core itself has none. */
function generator(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** One op-log entry: an op at a logical time, or a growth of the open area. */
type Entry = { op: Op; at: number } | { open: Rect };

const SIZE = 12;
const STAGES: Rect[] = [
  { x: 4, y: 4, w: 4, h: 4 },
  { x: 2, y: 3, w: 8, h: 6 },
  { x: 0, y: 0, w: SIZE, h: SIZE },
];

/** A random log. Ops aim at the open area as it will be when they run, plus a margin. */
function randomLog(seed: number, length: number): Entry[] {
  const next = generator(seed);
  const log: Entry[] = [];
  let stage = 0;
  let at = 0;
  for (let step = 0; step < length; step++) {
    if (stage < STAGES.length - 1 && next(60) === 0) {
      stage++;
      log.push({ open: STAGES[stage]! });
      continue;
    }
    // Time mostly moves on, sometimes stays, sometimes is logged before the clock.
    const roll = next(10);
    if (roll < 6) at += next(4_000);
    const time = roll === 9 ? Math.max(0, at - 5_000) : at;
    const { x: ox, y: oy, w, h } = STAGES[stage]!;
    const x = ox - 1 + next(w + 2);
    const y = oy - 1 + next(h + 2);
    const kind = next(100);
    let op: Op;
    if (kind < 40) {
      op = {
        kind: 'brick',
        x,
        y,
        shape: next(7) as ShapeId,
        rotation: next(4) as Rotation,
        color: next(32),
      };
    } else if (kind < 65) op = { kind: 'hammer', x, y };
    else if (kind < 92) op = { kind: 'shield', x, y };
    else op = { kind: 'single', x, y, color: next(32) };
    log.push({ op, at: time });
  }
  return log;
}

/**
 * Replays entries the way the canvas does, every one through applyEntry (growth rows are
 * `open` log entries); returns every result, for comparison.
 */
function replay(state: State, entries: readonly Entry[]): ApplyResult[] {
  return entries.map((entry) => {
    if ('open' in entry) {
      const result = applyEntry(state, { kind: 'open', ...entry.open });
      expect(result.ok).toBe(true);
      return result;
    }
    return applyEntry(state, entry.op, entry.at);
  });
}

/** Everything a state holds, as plain values; counters included, although they are derived. */
function everything(s: State) {
  return {
    encoded: [...encodeCheckpoint(s)],
    hash: gridHash(s),
    placements: [...s.counters.placements],
    cover: [...s.counters.cover],
    reachable: s.counters.reachable,
    filled: s.counters.filled,
    clock: s.clock,
    open: s.config.open,
  };
}

const CONFIG: CoreConfig = { size: SIZE, open: STAGES[0]!, maxShield: 3, shieldLifetime: 30_000 };

describe('checkpoints', () => {
  it('restore + replay of the tail equals a replay of the whole log, at every cut', () => {
    let accepted = 0;
    let sweeps = 0;
    /** Cuts whose tail grows the open area: growth rows replayed after a restore. */
    let growthInTails = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const log = randomLog(seed, 300);
      const full = createState(CONFIG);
      const fullResults = replay(full, log);
      fullResults.forEach((r, i) => {
        const entry = log[i]!;
        if ('open' in entry || !r.ok) return;
        accepted++;
        // More diffs than the op itself makes: layers expired just before it.
        const own = { brick: 4, single: 1, shield: 1, hammer: 3 }[entry.op.kind];
        if (r.diffs.length > own) sweeps++;
      });
      const expected = JSON.stringify(everything(full));
      // One state walks the log; at every few entries it is checkpointed and the restored
      // copy replays the rest on its own.
      const head = createState(CONFIG);
      let at = 0;
      for (let cut = 0; cut <= log.length; cut += 3 + (seed % 5)) {
        replay(head, log.slice(at, cut));
        at = cut;
        const restored = decodeCheckpoint(encodeCheckpoint(head));
        const context = `seed ${seed} cut ${cut}`;
        // The restored state is the same state, not only the same grid...
        expect(JSON.stringify(everything(restored)), context).toBe(
          JSON.stringify(everything(head)),
        );
        // ...and it carries on identically: same results (diffs in order) and same end state.
        const tail = replay(restored, log.slice(cut));
        if (log.slice(cut).some((e) => 'open' in e)) growthInTails++;
        expect(JSON.stringify(tail), context).toBe(JSON.stringify(fullResults.slice(cut)));
        expect(JSON.stringify(everything(restored)), context).toBe(expected);
      }
    }
    // The logs must exercise accepted ops, not only refusals.
    expect(accepted).toBeGreaterThan(1000);
    expect(sweeps).toBeGreaterThan(100);
    expect(growthInTails).toBeGreaterThan(100);
    // About a second alone; more when the whole repo's tests run at once.
  }, 30_000);

  it('survive a chain of checkpoints, one after every few entries', () => {
    const log = randomLog(77, 400);
    const full = createState(CONFIG);
    replay(full, log);
    let state = createState(CONFIG);
    for (let i = 0; i < log.length; i += 13) {
      replay(state, log.slice(i, i + 13));
      state = decodeCheckpoint(encodeCheckpoint(state));
    }
    expect(everything(state)).toEqual(everything(full));
  });

  it('keep the expiry queue across its compaction', () => {
    // More than 1024 layers expire in one sweep, so the queue drops its consumed prefix.
    const config: CoreConfig = {
      size: 64,
      open: { x: 0, y: 0, w: 64, h: 64 },
      maxShield: 2,
      shieldLifetime: 1_000,
    };
    const log: Entry[] = [];
    for (let y = 0; y < 64; y += 2) {
      for (let x = 0; x < 64; x += 2)
        log.push({ op: { kind: 'brick', x, y, shape: 1, rotation: 0, color: 1 }, at: 0 });
    }
    for (let i = 0; i < 1500; i++) {
      const x = i % 64;
      const y = Math.floor(i / 64);
      log.push({ op: { kind: 'shield', x, y }, at: i < 1100 ? 0 : 600 });
    }
    // Sweeps the first 1100 layers (compaction), leaving 400 live entries; then more layers.
    log.push({ op: { kind: 'shield', x: 63, y: 63 }, at: 1_000 });
    log.push({ op: { kind: 'hammer', x: 1, y: 1 }, at: 1_200 });
    log.push({ op: { kind: 'shield', x: 0, y: 30 }, at: 1_300 });
    log.push({ op: { kind: 'hammer', x: 5, y: 20 }, at: 1_700 });
    const full = createState(config);
    const results = replay(full, log);
    for (const cut of [1024, 2524, 2525, 2526, 2527, log.length]) {
      const head = createState(config);
      replay(head, log.slice(0, cut));
      const restored = decodeCheckpoint(encodeCheckpoint(head));
      expect(replay(restored, log.slice(cut))).toEqual(results.slice(cut));
      expect(everything(restored)).toEqual(everything(full));
    }
    expect(full.expiryQueue.head).toBeLessThan(full.expiryQueue.times.length);
  });

  it('keep single-brick cover, since counters are recounted on decode', () => {
    const state = createState({ size: 8, open: { x: 0, y: 0, w: 2, h: 4 }, maxShield: 2 });
    apply(state, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 1 });
    apply(state, { kind: 'brick', x: 0, y: 2, shape: 1, rotation: 0, color: 1 });
    apply(state, { kind: 'hammer', x: 1, y: 3 });
    const restored = decodeCheckpoint(encodeCheckpoint(state));
    expect(canCover(restored, 1, 3)).toBe(false);
    expect(apply(restored, { kind: 'single', x: 1, y: 3, color: 2 }).ok).toBe(true);
    expect(isFilled(restored.cells[3 * 8 + 1]!)).toBe(true);
  });

  it('pin the default shield lifetime into the checkpoint', () => {
    const state = createState({ size: 4, open: { x: 0, y: 0, w: 4, h: 4 }, maxShield: 1 });
    expect(decodeCheckpoint(encodeCheckpoint(state)).config.shieldLifetime).toBe(
      48 * 60 * 60 * 1000,
    );
  });

  it('refuse bytes that are not a well-formed checkpoint', () => {
    const state = createState({ size: 4, open: { x: 1, y: 1, w: 2, h: 2 }, maxShield: 2 });
    apply(state, { kind: 'brick', x: 1, y: 1, shape: 1, rotation: 0, color: 1 }, 10);
    apply(state, { kind: 'shield', x: 1, y: 1 }, 10);
    apply(state, { kind: 'shield', x: 2, y: 1 }, 20);
    const good = encodeCheckpoint(state);
    // Layout here: cells at 56, shields at 72, layer times at 88 and 96, queue times at 104
    // and 112, queue cells at 120 and 124.
    const broken = (change: (bytes: Uint8Array, view: DataView) => void) => {
      const bytes = good.slice();
      change(bytes, new DataView(bytes.buffer));
      return () => decodeCheckpoint(bytes);
    };
    expect(() => decodeCheckpoint(good.subarray(0, 20))).toThrow(CheckpointError);
    expect(broken((b) => (b[0] = 0))).toThrow(CheckpointError);
    expect(broken((_, v) => v.setUint16(4, 2, true))).toThrow(/format/);
    expect(broken((_, v) => v.setUint32(20, 9, true))).toThrow(/config/);
    expect(() => decodeCheckpoint(good.subarray(0, good.length - 1))).toThrow(/length/);
    // A shield on an empty cell, and a filled cell outside the open area.
    expect(broken((b) => (b[56 + 16] = 1))).toThrow(CheckpointError);
    expect(broken((b) => (b[56] = 0x80))).toThrow(/outside/);
    expect(broken((b) => (b[56 + 16 + 5] = 0))).toThrow(/fewer shields/);
    expect(broken((b) => (b[56] = 0x01))).toThrow(/bits set/);
    expect(broken((b) => (b[56 + 9] = 0))).toThrow(/links down/);
    // Cell 6 is the top right of the brick; nothing is filled to its right.
    expect(broken((b) => (b[56 + 6] = 0x80 | 0x04 | 0x02 | 0x01))).toThrow(/links right/);
    expect(broken((b) => (b[72 + 5] = 3))).toThrow(/maxShield/);
    expect(broken((_, v) => v.setUint32(40, 2 ** 31, true))).toThrow(/already past/);
    expect(broken((_, v) => v.setUint32(104, 2 ** 31, true))).toThrow(/out of order/);

    // Two layers on one cell: swapped times, or a time equal to the clock, are refused.
    const two = createState({ size: 4, open: { x: 0, y: 0, w: 4, h: 4 }, maxShield: 2 });
    apply(two, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 1 }, 10);
    apply(two, { kind: 'shield', x: 0, y: 0 }, 10);
    apply(two, { kind: 'shield', x: 0, y: 0 }, 20);
    const bytes = encodeCheckpoint(two);
    // Cells at 56, shields at 72, cell 0's layer times at 88 and 96 (low words first).
    const view = new DataView(bytes.buffer);
    const [first, second] = [view.getUint32(88, true), view.getUint32(96, true)];
    expect(first).toBeLessThan(second);
    const swapped = bytes.slice();
    const swappedView = new DataView(swapped.buffer);
    swappedView.setUint32(88, second, true);
    swappedView.setUint32(96, first, true);
    expect(() => decodeCheckpoint(swapped)).toThrow(/unsorted/);
    const atClock = bytes.slice();
    new DataView(atClock.buffer).setUint32(40, first, true);
    expect(() => decodeCheckpoint(atClock)).toThrow(/already past/);
    const justBefore = bytes.slice();
    new DataView(justBefore.buffer).setUint32(40, first - 1, true);
    expect(() => decodeCheckpoint(justBefore)).not.toThrow();
    expect(() => decodeCheckpoint(good)).not.toThrow();
    // The cheap check a writer runs: same checks, same hash, no counters.
    expect(verifyCheckpoint(good)).toBe(gridHash(state));
    const bad = good.slice();
    bad[56] = 0x01;
    expect(() => verifyCheckpoint(bad)).toThrow(/bits set/);
  });
});
