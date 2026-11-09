import { describe, expect, it } from 'vitest';
import {
  type ApplyResult,
  apply,
  applyEntry,
  type CoreConfig,
  createState,
  decodeCheckpoint,
  encodeCell,
  encodeCheckpoint,
  gridHash,
  LINK_DOWN,
  LINK_RIGHT,
  type LogEntry,
  type Op,
  passTime,
  type Rect,
  type RestoreEntry,
  type Rotation,
  recount,
  restoreEntry,
  type ShapeId,
  type State,
} from '../src/index.ts';

// Rollbacks (ADR 0024): a restore entry turns the live grid into a replay that leaves some ops
// out, and replays like any other entry.

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

/** A log row: a player op with its time and sender, an open-area change, or a restore. */
type Row = { op: Op; at: number; player: number } | { open: Rect } | { restore: RestoreEntry };

const SIZE = 12;
const STAGES: Rect[] = [
  { x: 4, y: 4, w: 4, h: 4 },
  { x: 2, y: 3, w: 8, h: 6 },
  { x: 0, y: 0, w: SIZE, h: SIZE },
];
// Layers last about a hundred ops, so rolled-back hammers and shields leave layers to restore.
const CONFIG: CoreConfig = { size: SIZE, open: STAGES[0]!, maxShield: 3, shieldLifetime: 120_000 };

/** Random rows. Ops aim at the open area as it will be when they run, plus a margin. */
function randomRows(seed: number, length: number, start = { stage: 0, at: 0 }): Row[] {
  const next = generator(seed);
  const rows: Row[] = [];
  let { stage, at } = start;
  for (let step = 0; step < length; step++) {
    if (stage < STAGES.length - 1 && next(60) === 0) {
      stage++;
      rows.push({ open: STAGES[stage]! });
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
    rows.push({ op, at: time, player: next(4) });
  }
  return rows;
}

/** A plain replay, as the canvas does on restart: every row through applyEntry. */
function replay(state: State, rows: readonly Row[]): ApplyResult[] {
  return rows.map((row) => {
    if ('open' in row) return applyEntry(state, { kind: 'open', ...row.open });
    if ('restore' in row) return applyEntry(state, row.restore);
    return applyEntry(state, row.op, row.at);
  });
}

/**
 * Applies rows to `state` and returns the ones a canvas would log: refused ops never reach the
 * log, so every op row of a real log was accepted (and moved the clock) when it ran.
 */
function logged(state: State, rows: readonly Row[]): { rows: Row[]; results: ApplyResult[] } {
  const results = replay(state, rows);
  return { rows: rows.filter((_, i) => results[i]!.ok), results };
}

/** Which ops a rollback leaves out: by position in the log, sender and anchor cell. */
interface Filter {
  readonly from: number;
  readonly to: number;
  readonly player?: number;
  readonly area?: Rect;
}

function leftOut(filters: readonly Filter[], i: number, row: Row): boolean {
  if (!('op' in row)) return false;
  return filters.some(
    (f) =>
      i >= f.from &&
      i <= f.to &&
      (f.player === undefined || f.player === row.player) &&
      (f.area === undefined ||
        (row.op.x >= f.area.x &&
          row.op.y >= f.area.y &&
          row.op.x < f.area.x + f.area.w &&
          row.op.y < f.area.y + f.area.h)),
  );
}

/**
 * A replay that leaves ops out (ADR 0024): restore rows are skipped, the ops of every filter
 * are left out, and each row of player ops still moves the clock, as it did live.
 */
function replayWithout(rows: readonly Row[], filters: readonly Filter[]): State {
  const state = createState(CONFIG);
  rows.forEach((row, i) => {
    if ('restore' in row) return;
    if ('open' in row) {
      applyEntry(state, { kind: 'open', ...row.open });
      return;
    }
    passTime(state, row.at);
    if (!leftOut(filters, i, row)) applyEntry(state, row.op, row.at);
  });
  return state;
}

/** The grid as values: cells, shields, every layer's expiry, the clock and the counters. */
function grid(s: State) {
  const counted = decodeCheckpoint(encodeCheckpoint(s));
  recount(counted);
  return {
    hash: gridHash(s),
    cells: [...s.cells],
    shields: [...s.shields],
    expiry: [...s.shieldExpiry].sort((a, b) => a[0] - b[0]),
    clock: s.clock,
    open: s.config.open,
    placements: [...s.counters.placements],
    cover: [...s.counters.cover],
    reachable: s.counters.reachable,
    filled: s.counters.filled,
    // Counters kept per op must equal a recount from scratch.
    recounted: [...counted.counters.placements].join() === [...s.counters.placements].join(),
  };
}

function randomFilter(next: (n: number) => number, length: number): Filter {
  const from = next(length);
  const to = from + next(length - from);
  const x = next(SIZE);
  const y = next(SIZE);
  return {
    from,
    to,
    ...(next(2) === 0 ? { player: next(4) } : {}),
    ...(next(2) === 0 ? { area: { x, y, w: 1 + next(SIZE - x), h: 1 + next(SIZE - y) } } : {}),
  };
}

describe('restore entries', () => {
  it('turn the live grid into the replay without the rolled-back ops, which then carry on alike', () => {
    let restored = 0;
    let cells = 0;
    let withShields = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const next = generator(seed * 7919);
      const live = createState(CONFIG);
      const { rows } = logged(live, randomRows(seed, 200));
      const filters: Filter[] = [];
      const log: Row[] = [...rows];
      // Two rollbacks, each of them with more ops after it.
      for (let round = 0; round < 2; round++) {
        filters.push(randomFilter(next, log.length));
        const target = replayWithout(log, filters);
        const entry = restoreEntry(live, target);
        const result = applyEntry(live, entry);
        expect(result.ok, `seed ${seed}`).toBe(true);
        if (result.ok) expect(result.diffs.length).toBe(entry.cells.length);
        if (entry.cells.length > 0) restored++;
        cells += entry.cells.length;
        if (entry.cells.some((c) => c.length > 2)) withShields++;
        log.push({ restore: entry });
        const context = `seed ${seed} round ${round}`;
        expect(grid(live), context).toEqual(grid(target));
        expect(grid(live).recounted, context).toBe(true);
        // The ops that follow behave the same on the live grid and on the replay without: same
        // results, diffs included, and the same grid after them.
        const stage = STAGES.findIndex((s) => s.w === live.config.open.w);
        const tried = randomRows(seed * 31 + round, 60, { stage, at: live.clock });
        const { rows: more, results } = logged(live, tried);
        const liveResults = results.filter((r) => r.ok);
        const targetResults = more.map((row) => {
          if ('open' in row) return applyEntry(target, { kind: 'open', ...row.open });
          if ('restore' in row) return applyEntry(target, row.restore);
          // The sweep comes first in the op's diffs, as when apply runs it.
          const swept = passTime(target, row.at);
          const result = applyEntry(target, row.op, row.at);
          return result.ok ? { ok: true, diffs: [...swept, ...result.diffs] } : result;
        });
        expect(JSON.stringify(liveResults), context).toBe(JSON.stringify(targetResults));
        log.push(...more);
        expect(grid(live), context).toEqual(grid(replayWithout(log, filters)));
      }
      // A plain replay of the whole log, restores included, reaches the same state byte for
      // byte, from the start or from a checkpoint at any cut.
      const full = createState(CONFIG);
      replay(full, log);
      expect([...encodeCheckpoint(full)]).toEqual([...encodeCheckpoint(live)]);
      for (let cut = 0; cut <= log.length; cut += 17) {
        const head = createState(CONFIG);
        replay(head, log.slice(0, cut));
        const tail = decodeCheckpoint(encodeCheckpoint(head));
        replay(tail, log.slice(cut));
        expect([...encodeCheckpoint(tail)], `seed ${seed} cut ${cut}`).toEqual([
          ...encodeCheckpoint(full),
        ]);
      }
    }
    // The logs must exercise real restores, shield layers included.
    expect(restored).toBeGreaterThan(40);
    expect(cells).toBeGreaterThan(350);
    expect(withShields).toBeGreaterThan(5);
  }, 60_000);

  it('set cells, links and shield layers, and take no time', () => {
    const config: CoreConfig = {
      size: 8,
      open: { x: 0, y: 0, w: 8, h: 8 },
      maxShield: 2,
      shieldLifetime: 1_000,
    };
    const state = createState(config);
    apply(state, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 5 }, 100);
    apply(state, { kind: 'shield', x: 4, y: 4 }, 100);
    const before = state.clock;
    // Puts a two-cell piece back at (3, 3)-(4, 3), linked, the right one with two layers.
    const result = applyEntry(state, {
      kind: 'restore',
      cells: [
        [3 * 8 + 3, encodeCell(7, true, false)],
        [3 * 8 + 4, encodeCell(7, false, false), 600, 1_050],
      ],
    });
    expect(result).toEqual({
      ok: true,
      diffs: [
        { index: 27, cell: encodeCell(7, true, false), shield: 0 },
        { index: 28, cell: encodeCell(7, false, false), shield: 2 },
      ],
    });
    expect(state.clock).toBe(before);
    expect(state.shieldExpiry.get(28)).toEqual([600, 1_050]);
    // The restored layers expire in order with the rest.
    const counted = createState(config);
    counted.cells.set(state.cells);
    recount(counted);
    expect([...state.counters.cover]).toEqual([...counted.counters.cover]);
    expect(state.counters.filled).toBe(counted.counters.filled);
    const swept = apply(state, { kind: 'shield', x: 0, y: 0 }, 700);
    expect(swept.ok && swept.diffs.find((d) => d.index === 28)?.shield).toBe(1);
    const later = apply(state, { kind: 'shield', x: 1, y: 0 }, 1_060);
    expect(later.ok && later.diffs.find((d) => d.index === 28)?.shield).toBe(0);
    // Emptying a cell: its counters come back, and no link may point into it.
    expect(applyEntry(state, { kind: 'restore', cells: [[28, 0]] }).ok).toBe(false);
    expect(
      applyEntry(state, {
        kind: 'restore',
        cells: [
          [27, 0],
          [28, 0],
        ],
      }).ok,
    ).toBe(true);
    const empty = createState(config);
    empty.cells.set(state.cells);
    recount(empty);
    expect([...state.counters.placements]).toEqual([...empty.counters.placements]);
  });

  it('refuse an entry that would break the grid, changing nothing', () => {
    const config: CoreConfig = {
      size: 8,
      open: { x: 1, y: 1, w: 6, h: 6 },
      maxShield: 2,
      shieldLifetime: 1_000,
    };
    const state = createState(config);
    apply(state, { kind: 'brick', x: 1, y: 1, shape: 1, rotation: 0, color: 5 }, 100);
    apply(state, { kind: 'shield', x: 1, y: 1 }, 200);
    const snapshot = () => ({
      bytes: [...encodeCheckpoint(state)],
      cover: [...state.counters.cover],
      queue: [...state.expiryQueue.times],
    });
    const before = snapshot();
    const filled = encodeCell(3, false, false);
    const bad: unknown[][] = [
      // Malformed: no cells array, short tuples, unsorted or repeated or outside indices.
      [[9]],
      [
        [12, filled],
        [10, filled],
      ],
      [
        [10, filled],
        [10, filled],
      ],
      [[64, filled]],
      [[-1, filled]],
      [[10.5, filled]],
      [[10, 256]],
      // An empty cell with bits or layers; a filled cell outside the open area.
      [[10, 0x04]],
      [[10, 0, 500]],
      [[0, filled]],
      // Too many layers; a layer at or before the clock, beyond a new layer's life, unsorted.
      [[10, filled, 300, 400, 500]],
      [[10, filled, 200]],
      [[10, filled, 1_201]],
      [[10, filled, 500, 400]],
      // Links: to an empty cell, off the map's edge, to another colour, and into a cleared cell.
      [[20, encodeCell(3, true, false)]],
      [[62, encodeCell(3, false, true)]],
      [
        [20, encodeCell(3, true, false)],
        [21, encodeCell(4, false, false)],
      ],
      [[10, 0]],
      // The brick's cell (2, 1) links down into (2, 2): recolouring (2, 2) alone breaks it.
      [[18, encodeCell(6, false, false)]],
    ];
    for (const cells of bad) {
      const result = applyEntry(state, { kind: 'restore', cells } as unknown as LogEntry);
      expect(result, JSON.stringify(cells)).toEqual({ ok: false, reason: 'invalid' });
      expect(snapshot()).toEqual(before);
    }
    expect(applyEntry(state, { kind: 'restore' } as unknown as LogEntry).ok).toBe(false);
    // The same cells with their own links and colour are fine, and so is an empty list.
    expect(applyEntry(state, { kind: 'restore', cells: [] }).ok).toBe(true);
    const brick = [9, 10, 17, 18].map((i) => [i, state.cells[i]!] as [number, number]);
    expect(applyEntry(state, { kind: 'restore', cells: brick }).ok).toBe(true);
    expect(state.cells[9]! & LINK_RIGHT).toBe(LINK_RIGHT);
    expect(state.cells[9]! & LINK_DOWN).toBe(LINK_DOWN);
  });

  it('build nothing when the two states are the same, and refuse states of other rules', () => {
    const live = createState(CONFIG);
    const { rows } = logged(live, randomRows(5, 150));
    expect(restoreEntry(live, replayWithout(rows, [])).cells).toEqual([]);
    const other = createState({ ...CONFIG, maxShield: 2 });
    expect(() => restoreEntry(live, other)).toThrow(RangeError);
    // A limit stops the scan one cell past it.
    const empty = replayWithout(rows, [{ from: 0, to: rows.length }]);
    const all = restoreEntry(live, empty).cells.length;
    expect(all).toBeGreaterThan(3);
    expect(
      restoreEntry(live, replayWithout(rows, [{ from: 0, to: rows.length }]), 2).cells,
    ).toHaveLength(3);
    const ahead = replayWithout(rows, []);
    passTime(ahead, live.clock + 1);
    expect(() => restoreEntry(live, ahead)).toThrow(/ahead/);
    // Each rule on its own: one field differs and the two states are refused.
    const { open } = CONFIG;
    for (const rules of [
      { ...CONFIG, shieldLifetime: 60_000 },
      { ...CONFIG, maxShield: 2 },
      { ...CONFIG, size: SIZE + 4 },
      { ...CONFIG, open: { ...open, x: open.x + 1 } },
      { ...CONFIG, open: { ...open, y: open.y + 1 } },
      { ...CONFIG, open: { ...open, w: open.w + 1 } },
      { ...CONFIG, open: { ...open, h: open.h + 1 } },
    ]) {
      expect(() => restoreEntry(createState(CONFIG), createState(rules))).toThrow(/rules/);
    }
  });
});

// Each refusal on its own: cell 9, (1, 1) of an 8² map, has no filled neighbour, so only the
// check under test can refuse the entry (the brick at (5, 5) holds the clock and a layer).
describe('restore refusals, one check at a time', () => {
  const config: CoreConfig = {
    size: 8,
    open: { x: 0, y: 0, w: 8, h: 8 },
    maxShield: 2,
    shieldLifetime: 1_000,
  };
  const f = encodeCell(3, false, false);
  const base = () => {
    const s = createState(config);
    apply(s, { kind: 'brick', x: 5, y: 5, shape: 1, rotation: 0, color: 5 }, 100);
    apply(s, { kind: 'shield', x: 5, y: 5 }, 200);
    return s;
  };
  const bytes = (s: State) => [...encodeCheckpoint(s)];
  const refuses = (s: State, cells: unknown) => {
    const before = bytes(s);
    const result = applyEntry(s, { kind: 'restore', cells } as unknown as LogEntry);
    expect(result, JSON.stringify(cells)).toEqual({ ok: false, reason: 'invalid' });
    expect(bytes(s)).toEqual(before);
  };
  const accepts = (s: State, cells: unknown) => {
    const result = applyEntry(s, { kind: 'restore', cells } as unknown as LogEntry);
    expect(result.ok, JSON.stringify(cells)).toBe(true);
  };
  const cases: Record<string, unknown> = {
    notAnArray: 5,
    notATuple: [9],
    shortTuple: [[9]],
    repeatedIndex: [
      [9, f],
      [9, f],
    ],
    unsortedIndex: [
      [10, f],
      [9, f],
    ],
    indexPastTheMap: [[64, 0]],
    negativeIndex: [[-1, 0]],
    fractionalIndex: [[9.5, f]],
    byteOver255: [[9, 0x180]],
    negativeByte: [[9, -1]],
    emptyWithBits: [[9, 0x04]],
    emptyWithLayers: [[9, 0, 500]],
    moreLayersThanMaxShield: [[9, f, 300, 400, 500]],
    layerAtTheClock: [[9, f, 200]],
    layerBeforeTheClock: [[9, f, 150]],
    layersOutOfOrder: [[9, f, 500, 400]],
    layerOutlivingANewOne: [[9, f, 1_201]],
    layerNotANumber: [[9, f, 'x']],
    layerNotAnInteger: [[9, f, 300.5]],
    linkToAnotherColour: [
      [9, encodeCell(3, true, false)],
      [10, encodeCell(4, false, false)],
    ],
    linkToAnEmptyCell: [[9, encodeCell(3, true, false)]],
    linkDownToAnEmptyCell: [[9, encodeCell(3, false, true)]],
    // x = 7 links right: without the edge check it would land on (0, 1), filled here.
    linkRightOffTheEdge: [
      [7, encodeCell(3, true, false)],
      [8, f],
    ],
  };
  for (const [name, cells] of Object.entries(cases)) {
    it(`refuses ${name}`, () => refuses(base(), cells));
  }

  it('accepts the limits themselves: maxShield layers, the latest time, links that land', () => {
    const s = base();
    accepts(s, [[9, f, 201, 1_200]]);
    expect(s.shieldExpiry.get(9)).toEqual([201, 1_200]);
    accepts(s, [
      [17, encodeCell(3, true, true)],
      [18, f],
      [25, f],
    ]);
  });

  it('refuses a cell outside the open area', () => {
    const s = createState({ ...config, open: { x: 1, y: 1, w: 6, h: 6 } });
    refuses(s, [[0, f]]);
    accepts(s, [[9, f]]);
  });

  it('refuses emptying or recolouring a cell a left or upper neighbour links into', () => {
    const left = base();
    accepts(left, [
      [9, encodeCell(3, true, false)],
      [10, f],
    ]);
    refuses(left, [[10, 0]]);
    refuses(left, [[10, encodeCell(4, false, false)]]);
    const up = base();
    accepts(up, [
      [3, encodeCell(3, false, true)],
      [11, f],
    ]);
    refuses(up, [[11, 0]]);
    refuses(up, [[11, encodeCell(4, false, false)]]);
  });

  it('drops the layers a restored cell had, and counts what it fills and empties', () => {
    const s = base();
    // (5, 5) keeps its byte but loses its layer: nothing of the old layer may stay behind.
    accepts(s, [[45, s.cells[45]!]]);
    expect(s.shields[45]).toBe(0);
    expect(s.shieldExpiry.has(45)).toBe(false);
    apply(s, { kind: 'shield', x: 5, y: 5 }, 300);
    expect(s.shieldExpiry.get(45)).toEqual([1_300]);
    expect(() => encodeCheckpoint(s)).not.toThrow();
    accepts(s, [
      [9, f],
      [45, 0],
      [46, 0],
      [53, 0],
      [54, 0],
    ]);
    const recounted = createState(config);
    recounted.cells.set(s.cells);
    recount(recounted);
    expect({ ...s.counters }).toEqual({ ...recounted.counters });
  });

  it('queues restored layers in time order, after layers already queued at the same time', () => {
    const s = base();
    // The brick's layer expires at 1200; restored ones at 1200 (a tie), 900 and 500.
    accepts(s, [
      [9, f, 900],
      [12, f, 500, 1_200],
    ]);
    const { times, cells, head } = s.expiryQueue;
    expect(times.slice(head)).toEqual([500, 900, 1_200, 1_200]);
    expect(cells.slice(head)).toEqual([12, 9, 45, 12]);
    // The earliest one goes first, whatever order the entry listed it in.
    apply(s, { kind: 'shield', x: 6, y: 6 }, 600);
    expect(s.shields[12]).toBe(1);
    expect(s.shields[9]).toBe(1);
  });

  it('lists a cell whose layers differ only in their times', () => {
    const live = createState(config);
    const target = createState(config);
    for (const s of [live, target]) {
      apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 5 }, 0);
    }
    apply(live, { kind: 'shield', x: 0, y: 0 }, 100);
    apply(target, { kind: 'shield', x: 1, y: 1 }, 100);
    apply(live, { kind: 'shield', x: 1, y: 1 }, 300);
    apply(target, { kind: 'shield', x: 0, y: 0 }, 300);
    // Same bytes, one layer each, other expiries: both cells are listed.
    expect(restoreEntry(live, target).cells).toEqual([
      [0, live.cells[0], 1_300],
      [9, live.cells[9], 1_100],
    ]);
  });

  it('brings the target up to the live clock before comparing', () => {
    const live = createState(config);
    const target = createState(config);
    for (const s of [live, target]) {
      apply(s, { kind: 'brick', x: 0, y: 0, shape: 1, rotation: 0, color: 5 }, 0);
      apply(s, { kind: 'shield', x: 0, y: 0 }, 0);
    }
    // Live has moved past the layer's end; the target has not swept it yet.
    apply(live, { kind: 'brick', x: 4, y: 4, shape: 1, rotation: 0, color: 6 }, 1_500);
    apply(target, { kind: 'brick', x: 4, y: 4, shape: 1, rotation: 0, color: 6 }, 900);
    expect(target.shields[0]).toBe(1);
    expect(restoreEntry(live, target).cells).toEqual([]);
    expect(target.clock).toBe(1_500);
  });
});
