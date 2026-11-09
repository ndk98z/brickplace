import {
  colorOf,
  DEFAULT_ITEM_CONFIG,
  ITEM_KINDS,
  isFilled,
  LINK_DOWN,
  LINK_RIGHT,
  ORIENTATIONS,
  type Phase,
  phaseOf,
  type Rates,
  recount,
} from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseRates, type SimConfig, withRates } from '../src/config.ts';
import { Rng } from '../src/rng.ts';
import {
  CORE_DRAW_RULES,
  type DrawRules,
  drawFor,
  fillPhase,
  fittingShapes,
  run,
  SHAPE_ORIENTATIONS,
} from '../src/sim.ts';
import { TICK_MS, World } from '../src/world.ts';

const open = { x: 0, y: 0, w: 8, h: 8 };
/** A shield lifetime of 60 ticks. */
const LIFE = 60 * TICK_MS;

/**
 * Fills every open cell except the listed ones with one-cell pieces. Written straight into
 * the grid, so the core's counters are recounted afterwards.
 */
function fillExcept(world: World, empty: readonly (readonly [number, number])[]): void {
  for (let y = 0; y < world.open.h; y++) {
    for (let x = 0; x < world.open.w; x++) {
      if (!empty.some(([ex, ey]) => ex === x && ey === y))
        world.state.cells[y * world.size + x] = 0x80;
    }
  }
  recount(world.state);
}

describe('World', () => {
  it('sees an empty map as coverable everywhere', () => {
    const world = new World(8, open, 2, LIFE);
    expect(world.canCover(0, 0)).toBe(true);
    expect(world.canCover(7, 7)).toBe(true);
    expect(world.empties().holes).toHaveLength(0);
  });

  it('treats a cell boxed in on all sides as a hole', () => {
    const world = new World(8, open, 2, LIFE);
    fillExcept(world, [[3, 3]]);
    expect(world.isHole(3, 3)).toBe(true);
  });

  it('treats a gap of three in a line as a hole, and four as coverable', () => {
    const world = new World(8, open, 2, LIFE);
    fillExcept(world, [
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
    expect(world.isHole(2, 2)).toBe(true);
    const roomy = new World(8, open, 2, LIFE);
    fillExcept(roomy, [
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
    ]);
    expect(roomy.isHole(2, 2)).toBe(false);
  });

  it('treats a vertical gap of three as a hole', () => {
    const world = new World(8, open, 2, LIFE);
    fillExcept(world, [
      [2, 1],
      [2, 2],
      [2, 3],
    ]);
    expect(world.isHole(2, 2)).toBe(true);
  });

  it('sees a 2×2 gap and an L-shaped gap as coverable', () => {
    const square = new World(8, open, 2, LIFE);
    fillExcept(square, [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ]);
    expect(square.isHole(3, 3)).toBe(false);
    // Only an L or J brick fits here; every one of its cells must still count as coverable.
    const ell = new World(8, open, 2, LIFE);
    const gap = [
      [2, 1],
      [2, 2],
      [2, 3],
      [3, 3],
    ] as const;
    fillExcept(ell, gap);
    for (const [x, y] of gap) expect(ell.isHole(x, y)).toBe(false);
  });

  it('only counts the open area when checking a gap at its edge', () => {
    const world = new World(8, { x: 0, y: 0, w: 4, h: 4 }, 2, LIFE);
    fillExcept(world, [
      [3, 0],
      [3, 1],
      [3, 2],
    ]);
    // A vertical I would need (3, 3), which is filled; (4, *) lies outside the open area.
    expect(world.isHole(3, 1)).toBe(true);
    world.state.cells[3 * 8 + 3] = 0;
    recount(world.state);
    expect(world.isHole(3, 1)).toBe(false);
  });

  it('counts cells outside the open area as blocked', () => {
    const world = new World(8, { x: 0, y: 0, w: 3, h: 1 }, 2, LIFE);
    expect(world.isHole(1, 0)).toBe(true);
  });

  it('places a single brick only into a hole, with no links, through the core', () => {
    const world = new World(8, open, 2, LIFE);
    expect(world.placeSingle(0, 0, 5)).toBe(false);
    expect(world.filled).toBe(0);
    fillExcept(world, [[3, 3]]);
    expect(world.placeSingle(3, 3, 5)).toBe(true);
    const cell = world.state.cells[3 * 8 + 3]!;
    expect(isFilled(cell)).toBe(true);
    expect(colorOf(cell)).toBe(5);
    expect(cell & (LINK_RIGHT | LINK_DOWN)).toBe(0);
    expect(world.placeSingle(3, 3, 5)).toBe(false);
    expect(world.singles).toBe(1);
    // The core counted it: every cell of the open area is filled now.
    expect(world.filled).toBe(64);
    // Hammered away, it is no longer a single brick.
    expect(world.hammer(3, 3)).toBe(true);
    expect(world.singles).toBe(0);
    expect(world.isHole(3, 3)).toBe(true);
  });

  it('expires each shield layer on its own clock, in the core', () => {
    const world = new World(8, open, 3, LIFE);
    expect(world.brick(0, 0, 1, 0, 2)).toBe(true);
    world.tick = 0;
    world.shield(0, 0);
    world.tick = 30;
    world.shield(0, 0);
    expect(world.state.shields[0]).toBe(2);
    // Layers go when the next accepted op at or after their time sweeps them.
    let x = 2;
    const later = (tick: number) => {
      world.tick = tick;
      expect(world.brick(x, 4, 0, 1, 1)).toBe(true);
      x++;
    };
    later(59);
    expect(world.state.shields[0]).toBe(2);
    later(60);
    expect(world.state.shields[0]).toBe(1);
    later(90);
    expect(world.state.shields[0]).toBe(0);
    expect(world.layers.size).toBe(0);
  });

  it('removes the newest shield layer on a hammer hit and keeps counts in step', () => {
    const world = new World(8, open, 3, LIFE);
    world.brick(0, 0, 1, 0, 2);
    world.tick = 0;
    world.shield(0, 0);
    world.tick = 30;
    world.shield(0, 0);
    expect(world.hammer(0, 0)).toBe(true);
    expect(world.layers.get(0)).toEqual([60 * TICK_MS]);
    expect(world.filled).toBe(4);
    world.hammer(0, 0);
    world.hammer(0, 0);
    expect(world.filled).toBe(3);
  });

  it('clears the whole unshielded brick in piece mode', () => {
    const world = new World(8, open, 3, LIFE, 'piece');
    world.brick(0, 0, 1, 0, 2); // O brick over (0,0)-(1,1)
    world.shield(1, 1);
    expect(world.pieceOf(0, 0).sort((a, b) => a - b)).toEqual([0, 1, 8, 9]);
    expect(world.hammer(0, 0)).toBe(true);
    expect(world.filled).toBe(1);
    expect(isFilled(world.state.cells[9]!)).toBe(true);
  });

  it('grows the open area through the core and keeps the cells', () => {
    const world = new World(16, { x: 4, y: 4, w: 8, h: 8 }, 2, LIFE);
    const state = world.state;
    world.brick(4, 4, 1, 0, 3);
    expect(world.brick(0, 0, 1, 0, 3)).toBe(false);
    // 4 of 64 cells: under a 7% threshold, then at it.
    expect(world.growIfFull({ atPercent: 7, step: 4 })).toBe(false);
    expect(world.growIfFull({ atPercent: 6, step: 4 })).toBe(true);
    expect(world.state).toBe(state);
    expect(world.open).toEqual({ x: 0, y: 0, w: 16, h: 16 });
    expect(world.filled).toBe(4);
    expect(isFilled(world.state.cells[4 * 16 + 4]!)).toBe(true);
    // The counters were recounted for the new area.
    expect(world.empties().coverable).toHaveLength(256 - 4);
    expect(world.brick(0, 0, 1, 0, 3)).toBe(true);
    // The whole map is open: nothing left to grow.
    expect(world.growIfFull({ atPercent: 1, step: 4 })).toBe(false);
  });
});

const small: SimConfig = {
  ...DEFAULT_CONFIG,
  hours: 4,
  players: 60,
  mapSize: 64,
  openSize: 32,
  growth: { atPercent: 70, step: 8 },
  arts: 4,
  artSize: 8,
};

describe('run', () => {
  it('is reproducible from the seed', () => {
    expect(run(small)).toEqual(run(small));
    expect(run({ ...small, seed: 2 }).final).not.toEqual(run(small).final);
  });

  it('fills the map, grows the open area and accounts for every item', () => {
    const report = run(small);
    expect(report.snapshots).toHaveLength(4);
    expect(report.growth.length).toBeGreaterThan(0);
    expect(report.final.fill).toBeGreaterThan(0.5);
    for (const kind of ['brick', 'single', 'hammer', 'shield'] as const) {
      // Whatever was drawn was used, thrown away or is still held (at most 3 per player).
      const leftover = report.drawn[kind] - report.used[kind] - report.discarded[kind];
      expect(leftover).toBeGreaterThanOrEqual(0);
      expect(leftover).toBeLessThanOrEqual(small.players * small.items.hold);
    }
  });

  it('plays the defaults of the core', () => {
    expect(DEFAULT_CONFIG.items).toBe(DEFAULT_ITEM_CONFIG);
    // The core takes whole-number rates only, three sets of four, not all zero.
    expect(() => parseRates('7.5/5/0/10,70/10/10/10,40/10/25/25')).toThrow();
    expect(() => parseRates('85/5/0/10,70/10/10/10')).toThrow();
    expect(() => parseRates('0/0/0/0,70/10/10/10,40/10/25/25')).toThrow();
    expect(parseRates('84/5/1/10,70/10/10/10,40/10/25/25')).toEqual(DEFAULT_ITEM_CONFIG.rates);
    expect(() => run({ ...small, items: { ...small.items, cooldown: 30_000 } })).toThrow();
    expect(() => run({ ...small, growth: { atPercent: 0, step: 8 } })).toThrow();
  });

  it("fills the hold the core's way: one item per cooldown, starting items, full holds wait", () => {
    // Shields only, on an empty map: nothing can be played, so the hold fills and the oldest
    // item is thrown away every tick from then on.
    const idle = (startItems: number) => {
      const config = withRates(tiny(4), '0/0/0/100,0/0/0/100,0/0/0/100');
      return run({ ...config, items: { ...config.items, startItems } });
    };
    // One item at once, one per tick after: full at tick 2, then one in and one out per tick.
    const one = idle(1);
    expect(one.drawn.shield).toBe(60);
    expect(one.discarded.shield).toBe(58);
    // Three at once: full at tick 0.
    const three = idle(3);
    expect(three.drawn.shield).toBe(62);
    expect(three.discarded.shield).toBe(60);
    expect(three.used.shield).toBe(0);
  });

  it('hands out bricks instead of single bricks while the map has no hole', () => {
    const report = run(withRates({ ...small, hours: 1 }, '0/100/0/0,0/100/0/0,0/100/0/0'));
    // Every brick handed out is a converted single brick; once the map is full the converted
    // single brick fits nowhere either and becomes a shield.
    expect(report.convertedSingles).toBeGreaterThan(0);
    expect(report.drawn.brick + report.bricksAsShields).toBe(report.convertedSingles);
    expect(report.drawn.shield).toBe(report.bricksAsShields);
  });

  it('lets players with no hole in their artwork fill holes elsewhere', () => {
    // One-cell artworks almost never have a hole, so these single bricks come from the fallback.
    for (const kind of ['builder', 'griefer'] as const) {
      const mix = { builder: 0, casual: 0, griefer: 0, repairer: 0, [kind]: 1 };
      const report = run({ ...small, hours: 12, artSize: 1, mix });
      expect(report.used.single).toBeGreaterThan(100);
    }
  });

  it('never fills a cell with a single brick when single bricks are off', () => {
    const report = run(withRates(small, '80/0/10/10,65/0/22/13,50/0/40/10'));
    expect(report.final.singleShare).toBe(0);
  });
});

/** Fills each cell of the open area with probability `p`, from a fixed seed. */
function scatter(world: World, p: number, seed: number): void {
  const rng = new Rng(seed);
  const { open } = world;
  for (let y = open.y; y < open.y + open.h; y++) {
    for (let x = open.x; x < open.x + open.w; x++) {
      if (rng.chance(p)) world.state.cells[y * world.size + x] = 0x80;
    }
  }
  recount(world.state);
}

/** Valid placements of one orientation, by trying every position on the map. */
function bruteForce(world: World, orientation: number): number {
  let count = 0;
  for (let y = -4; y < world.size + 4; y++) {
    for (let x = -4; x < world.size + 4; x++) {
      if (ORIENTATIONS[orientation]!.every(([dx, dy]) => world.isEmptyOpen(x + dx, y + dy))) {
        count++;
      }
    }
  }
  return count;
}

describe('placement counts (ADR 0010)', () => {
  it('maps every shape to its distinct orientations, 19 in all', () => {
    expect(SHAPE_ORIENTATIONS.map((o) => o.length)).toEqual([2, 1, 4, 2, 2, 4, 4]);
    expect(new Set(SHAPE_ORIENTATIONS.flat()).size).toBe(ORIENTATIONS.length);
  });

  it('counts each valid placement once, as a brute-force count does', () => {
    for (const [p, seed] of [
      [0, 1],
      [0.2, 2],
      [0.45, 3],
      [0.6, 4],
      [0.8, 5],
    ] as const) {
      // An open area off the map edges, so its borders are tested on all four sides.
      const world = new World(16, { x: 2, y: 3, w: 11, h: 9 }, 2, LIFE);
      scatter(world, p, seed);
      const { coverable, holes, placements } = world.empties();
      expect(placements).toEqual(ORIENTATIONS.map((_, o) => bruteForce(world, o)));
      // The scan agrees with the cell-by-cell check on what a brick can cover.
      for (const index of coverable)
        expect(world.canCover(index % 16, Math.floor(index / 16))).toBe(true);
      for (const index of holes)
        expect(world.isHole(index % 16, Math.floor(index / 16))).toBe(true);
      expect(coverable.length + holes.length).toBe(99 - world.state.cells.filter((c) => c).length);
    }
  });

  it("agrees with the core's own counters on the same grid", () => {
    for (const [p, seed] of [
      [0.3, 6],
      [0.55, 7],
    ] as const) {
      const world = new World(16, { x: 1, y: 2, w: 13, h: 12 }, 2, LIFE);
      scatter(world, p, seed);
      const { coverable, placements } = world.empties();
      expect(placements).toEqual(Array.from(world.state.counters.placements));
      expect(coverable.length).toBe(world.state.counters.reachable);
    }
  });

  it('counts a shape as fitting only from the given number of placements', () => {
    // Two flat-or-upright I placements, one O placement, nothing else.
    const placements = new Array<number>(ORIENTATIONS.length).fill(0);
    for (const o of SHAPE_ORIENTATIONS[0]!) placements[o] = 1;
    placements[SHAPE_ORIENTATIONS[1]![0]!] = 1;
    expect(fittingShapes(placements)).toEqual([0, 1]);
    expect(fittingShapes(placements, 2)).toEqual([0]); // the I sums its two orientations
    expect(fittingShapes(placements, 3)).toEqual([]);
  });

  it('knows which shapes fit a narrow gap', () => {
    const world = new World(8, open, 2, LIFE);
    fillExcept(world, [
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
    ]);
    const { placements } = world.empties();
    expect(placements.reduce((a, b) => a + b, 0)).toBe(1);
    expect(fittingShapes(placements)).toEqual([0]); // only the I brick, lying flat
    fillExcept(world, []);
    expect(fittingShapes(world.empties().placements)).toEqual([]);
  });
});

const BRICKS_ONLY = '100/0/0/0,100/0/0/0,100/0/0/0';

/** One casual player on a tiny open area that cannot grow, drawing bricks only. */
function tiny(edge: number, overrides: Partial<SimConfig> = {}, rates = BRICKS_ONLY): SimConfig {
  return withRates(
    {
      ...DEFAULT_CONFIG,
      hours: 1,
      players: 1,
      mapSize: edge,
      openSize: edge,
      arts: 0,
      ...overrides,
    },
    rates,
  );
}

describe('shape draws (ADR 0010)', () => {
  it('draws only shapes that fit the open area', () => {
    // 2×2 fits only the O brick; 3×3 fits everything but the I brick.
    // The first O brick fills the area; from then on nothing fits.
    expect(run(tiny(2)).drawnShapes).toEqual([0, 1, 0, 0, 0, 0, 0]);
    // Draws read the core's live counters, whatever the scan interval players see.
    expect(run(tiny(2, { refreshTicks: 10 })).drawnShapes).toEqual([0, 1, 0, 0, 0, 0, 0]);
    // Hammers keep reopening the 3×3 area so every shape that fits it gets its turn. With no
    // shield layers allowed, the shields handed out for bricks that fit nowhere cannot lock
    // the cells against the hammers.
    const hammering = '50/0/50/0,50/0/50/0,50/0/50/0';
    const three = run(tiny(3, { hours: 24, players: 4, maxShield: 0 }, hammering)).drawnShapes;
    expect(three[0]).toBe(0);
    for (const shape of [1, 2, 3, 4, 5, 6]) expect(three[shape]).toBeGreaterThan(0);
    // The ADR 0005 draw (an experiment now) hands out every shape regardless.
    const any = run(tiny(2, { shapeDraw: 'any' })).drawnShapes;
    expect(any.every((n) => n > 0)).toBe(true);
  });

  it('treats a shape below --fit-min as not fitting', () => {
    // A 2×2 area has exactly one placement, an O; with fitMin 2 not even that counts.
    const report = run(tiny(2, { fitMin: 2 }));
    expect(report.used.brick).toBe(0);
    expect(report.drawnShapes).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(report.bricksAsShields).toBe(60);
    expect(report.final.shapesFit).toBe(0);
    expect(run(tiny(2, { fitMin: 1 })).used.brick).toBe(1);
  });

  it('rescans right after the open area grows', () => {
    // One player fills a 4×4 start, which grows to the whole 16² map within a few ticks.
    // With no scheduled rescan for 1,000 ticks, only the rescan after growth shows the new
    // room; without it the player would keep looking in the full 4×4 start.
    const growth = { atPercent: 70, step: 6 };
    const report = run(tiny(16, { openSize: 4, growth, refreshTicks: 1000 }));
    expect(report.growth).toEqual([{ hour: 3 / 60, edge: 16 }]);
    expect(report.used.brick).toBeGreaterThan(30);
  });

  it('hands out a shield when no shape fits anywhere', () => {
    const report = run(tiny(2));
    // The O brick fills the area at once; from then on every brick is a shield.
    expect(report.used.brick).toBe(1);
    expect(report.bricksAsShields).toBeGreaterThan(40);
    expect(report.drawn.shield).toBe(report.bricksAsShields);
    expect(report.drawn.brick + report.drawn.shield).toBe(60);
    expect(run(tiny(2, { shapeDraw: 'any' })).bricksAsShields).toBe(0);
  });
});

describe('season draws (the core rules, live map)', () => {
  it('draws from the map as it is when the item arrives, not as it was at the tick start', () => {
    // Two players at tick 0: the first places the only O brick, so the second, drawing
    // after it, already finds no room and gets a shield.
    expect(run(tiny(2, { players: 2 })).drawnShapes).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it("draws with the rates of the core's phase by brick room", () => {
    // Bricks only while settling, shields only after: once the O brick fills the 2×2 area
    // the phase is saturated, so no brick is drawn that would have to become a shield.
    const settlingBricks = '100/0/0/0,0/0/0/100,0/0/0/100';
    expect(run(tiny(2, {}, settlingBricks)).bricksAsShields).toBe(0);
    // Bricks while settling or contested, hammers when saturated. Whenever no brick fits,
    // brick room is 100% (saturated), so a brick is never drawn into a map it cannot fit,
    // even when hammers have opened cells and the fill is under 85%.
    const report = run(tiny(3, { hours: 2 }, '100/0/0/0,100/0/0/0,0/0/100/0'));
    expect(report.drawn.hammer).toBeGreaterThan(0);
    expect(report.used.brick).toBeGreaterThan(1);
    expect(report.bricksAsShields).toBe(0);
  });

  it('hands out a shield under --room-scale when there is no room at all', () => {
    // Any shape may be drawn. The empty 2×2 area has one placement, so with a scale of 1
    // every brick is kept until an O brick fills it; from then on there is no placement and,
    // with --no-fit shield, the brick becomes a shield, as the old draw did, not a re-draw.
    const report = run(tiny(2, { shapeDraw: 'any', roomScale: 1 }));
    expect(report.used.brick).toBe(1);
    expect(report.bricksAsShields).toBeGreaterThan(30);
    expect(report.bricksRedrawn).toBe(0);
  });
});

/** The phase a share falls in at the core's 60% and 85% thresholds. */
function phaseAt(share: number): Phase {
  return share < 0.6 ? 'settling' : share < 0.85 ? 'contested' : 'saturated';
}

describe('phases (ADR 0010)', () => {
  it('counts holes as full by brick room (the core), not by fill (the experiment)', () => {
    // 16 isolated empty cells on an 8×8 area: 75% full, and no brick fits anywhere.
    const world = new World(8, open, 2, LIFE);
    const empty: [number, number][] = [];
    for (let y = 0; y < 8; y += 2) for (let x = 0; x < 8; x += 2) empty.push([x, y]);
    fillExcept(world, empty);
    expect(world.fillRatio()).toBe(0.75);
    expect(phaseOf(world.state)).toBe('saturated');
    expect(fillPhase(world.state)).toBe('contested');
  });

  it('puts the fill experiment at the core thresholds', () => {
    // 10 cells wide: each filled cell is 10% of the area.
    const world = new World(10, { x: 0, y: 0, w: 10, h: 1 }, 2, LIFE);
    const at = (filled: number) => {
      fillExcept(world, []);
      for (let x = filled; x < 10; x++) world.state.cells[x] = 0;
      recount(world.state);
      return fillPhase(world.state);
    };
    expect([5, 6, 8, 9, 10].map(at)).toEqual([
      'settling',
      'contested',
      'contested',
      'saturated',
      'saturated',
    ]);
  });

  it('follows the fill in every snapshot with fill-based phases', () => {
    const byFill = run({ ...small, hours: 6, phaseBy: 'fill' });
    for (const s of byFill.snapshots) expect(s.phase).toBe(phaseAt(s.fill));
    const byRoom = run({ ...small, hours: 6 });
    for (const s of byRoom.snapshots) expect(s.phase).toBe(phaseAt(s.blocked));
  });
});

describe('draw order and anti-stuck conversions', () => {
  it('turns a single brick into a brick, then into a shield, never into a shapeless brick', () => {
    // Only single bricks are drawn and the 2×2 area never has a hole: every single brick
    // becomes a brick (an O brick while it fits), then a shield once nothing fits.
    const report = run(tiny(2, {}, '0/100/0/0,0/100/0/0,0/100/0/0'));
    expect(report.drawn.single).toBe(0);
    expect(report.drawn.brick + report.drawn.shield).toBe(60);
    expect(report.drawnShapes.every((n) => Number.isFinite(n))).toBe(true);
    expect(report.drawnShapes.reduce((a, b) => a + b, 0)).toBe(report.drawn.brick);
    expect(report.convertedSingles).toBe(60);
    expect(report.bricksAsShields).toBe(report.drawn.shield);
  });
});

/**
 * An 8×8 map that is full except the listed cells: `roomy` has one hole at (0, 0) and room
 * for exactly one brick (a flat I in row 4), `noRoom` only the hole, `full` nothing.
 */
function mapWith(empty: readonly (readonly [number, number])[]): World {
  const world = new World(8, open, 2, LIFE);
  fillExcept(world, empty);
  return world;
}
const ROOMY: (readonly [number, number])[] = [
  [0, 0],
  [2, 4],
  [3, 4],
  [4, 4],
  [5, 4],
];

/** Shares of each item kind over many draws on one map. */
function shares(world: World, rates: Rates, rules: DrawRules, n = 200_000): number[] {
  const rng = new Rng(9);
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    counts[ITEM_KINDS.indexOf(drawFor(world.state, rates, rules, rng).item.kind)]!++;
  }
  return counts.map((c) => c / n);
}

const K1_SATURATED: Rates = DEFAULT_ITEM_CONFIG.rates.saturated;

function expectShares(got: readonly number[], want: readonly number[]): void {
  for (let i = 0; i < want.length; i++) expect(got[i]).toBeCloseTo(want[i]!, 2);
}

describe('brick room draws (experiments)', () => {
  const roomy = mapWith(ROOMY);
  const noRoom = mapWith([[0, 0]]);
  const full = mapWith([]);
  const redraw: DrawRules = { ...CORE_DRAW_RULES, noFit: 'redraw' };

  it('builds the maps the draws are tested on', () => {
    expect(fittingShapes(roomy.state.counters.placements)).toEqual([0]);
    expect(roomy.empties().holes).toEqual([0]);
    expect(fittingShapes(noRoom.state.counters.placements)).toEqual([]);
    expect(noRoom.empties().holes).toEqual([0]);
    expect(full.empties().holes).toEqual([]);
  });

  it('keeps the phase rates while bricks fit', () => {
    expect(K1_SATURATED).toEqual([40, 10, 25, 25]);
    const got = shares(roomy, K1_SATURATED, CORE_DRAW_RULES);
    expectShares(got, [0.4, 0.1, 0.25, 0.25]);
  });

  it('moves the weight a brick loses to the other items in proportion to their rates', () => {
    // One placement against a scale of 2 keeps half the bricks; the other half of the brick
    // weight (20 of 100) goes to 10/25/25 in proportion.
    const got = shares(roomy, K1_SATURATED, { ...redraw, roomScale: 2 });
    expectShares(got, [0.2, 0.1 + 0.2 / 6, 0.25 + 0.2 * (25 / 60), 0.25 + 0.2 * (25 / 60)]);
    expect(got.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('gives a shield, or re-draws, when no shape fits', () => {
    const shield = shares(noRoom, K1_SATURATED, CORE_DRAW_RULES);
    expectShares(shield, [0, 0.1, 0.25, 0.65]);
    const again = shares(noRoom, K1_SATURATED, redraw);
    expectShares(again, [0, 0.1 + 0.4 / 6, 0.25 + 0.4 * (25 / 60), 0.25 + 0.4 * (25 / 60)]);
  });

  it('leaves single bricks out of the re-draw when there is no hole', () => {
    // Single bricks become bricks (no hole) and bricks fit nowhere: everything goes to
    // hammers and shields, 25 to 25.
    const got = shares(full, K1_SATURATED, redraw);
    expectShares(got, [0, 0, 0.5, 0.5]);
    // With nothing left to draw, the brick becomes a shield.
    const none = shares(noRoom, [100, 0, 0, 0], redraw, 100);
    expect(none).toEqual([0, 0, 0, 1]);
  });

  it('is deterministic for a seed', () => {
    const draws = (seed: number) => {
      const rng = new Rng(seed);
      const rules: DrawRules = { ...redraw, roomScale: 3 };
      return Array.from({ length: 50 }, () => drawFor(roomy.state, K1_SATURATED, rules, rng));
    };
    expect(draws(4)).toEqual(draws(4));
    expect(draws(4)).not.toEqual(draws(5));
    const config = { ...small, roomScale: 400, noFit: 'redraw' as const, fitMin: 20 };
    expect(run(config)).toEqual(run(config));
  });

  it('re-draws bricks that fit nowhere instead of handing out shields', () => {
    const report = run(tiny(2, { hours: 2, noFit: 'redraw' }, '50/0/50/0,50/0/50/0,50/0/50/0'));
    expect(report.bricksRedrawn).toBeGreaterThan(0);
    expect(report.bricksAsShields).toBe(0);
    expect(report.drawn.shield).toBe(0);
  });

  it('keeps fewer bricks as brick room shrinks', () => {
    const plain = run({ ...small, hours: 6 });
    const scaled = run({ ...small, hours: 6, roomScale: 1_000_000, noFit: 'redraw' });
    expect(plain.bricksRedrawn).toBe(0);
    expect(scaled.bricksRedrawn).toBeGreaterThan(0);
    expect(scaled.drawn.brick).toBeLessThan(plain.drawn.brick);
  });
});
