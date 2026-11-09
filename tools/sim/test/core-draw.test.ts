import {
  apply,
  DEFAULT_ITEM_CONFIG,
  drawContext,
  drawItem,
  holeCount,
  type Op,
  phaseOf,
  type Rotation,
  type ShapeId,
} from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng.ts';
import { CORE_DRAW_RULES, drawFor, fillPhase, fittingShapes } from '../src/sim.ts';
import { TICK_MS, World } from '../src/world.ts';

// The server draws with the core's drawItem (packages/core/src/items.ts) and so does the sim:
// with every experiment off, the sim's draw is the core's draw on the same map and the same
// two 32-bit words, so what the sim measures is what players get.

const WORD = 2 ** 32;

/** An Rng that replays given 32-bit words, so the sim and the core see the same numbers. */
class Replay extends Rng {
  used = 0;
  constructor(private readonly words: readonly number[]) {
    super(1);
  }
  override word(): number {
    const word = this.words[this.used++];
    if (word === undefined) throw new Error('ran out of words');
    return word;
  }
}

/** Plays random ops on a 10×10 open area; calls `check` after each one. */
function randomMaps(check: (world: World, source: Rng) => void): Set<string> {
  const source = new Rng(11);
  const size = 12;
  const open = { x: 1, y: 1, w: 10, h: 10 };
  const phases = new Set<string>();
  for (let run = 0; run < 30; run++) {
    const world = new World(size, open, 2, 60 * TICK_MS);
    const { state } = world;
    for (let step = 0; step < 250; step++) {
      const x = open.x + source.int(open.w);
      const y = open.y + source.int(open.h);
      const roll = source.next();
      // Singles aim at a hole, so the map fills far enough to reach every phase.
      const hole = world.empties().holes[0];
      const op: Op =
        roll < 0.8
          ? {
              kind: 'brick',
              x,
              y,
              shape: source.int(7) as ShapeId,
              rotation: source.int(4) as Rotation,
              color: 1,
            }
          : roll < 0.9 || hole === undefined
            ? { kind: 'hammer', x, y }
            : { kind: 'single', x: hole % size, y: Math.floor(hole / size), color: 2 };
      apply(state, op);
      phases.add(phaseOf(state));
      check(world, source);
    }
  }
  return phases;
}

describe('the sim draws with the core', () => {
  it("draws the core's drawItem from the same map and words, two words a draw", () => {
    let bricks = 0;
    const phases = randomMaps((world, source) => {
      const { state } = world;
      const words = [Math.floor(source.next() * WORD), Math.floor(source.next() * WORD)];
      const rng = new Replay(words);
      const rates = DEFAULT_ITEM_CONFIG.rates[phaseOf(state)];
      const sim = drawFor(state, rates, CORE_DRAW_RULES, rng);
      expect(sim.item).toEqual(drawItem(state, DEFAULT_ITEM_CONFIG, words[0]!, words[1]!));
      expect(rng.used).toBe(2);
      if (sim.item.kind === 'brick') bricks++;
    });
    expect([...phases].sort()).toEqual(['contested', 'saturated', 'settling']);
    expect(bricks).toBeGreaterThan(1_000);
  });

  it("reads the same fitting shapes as the core's draw context", () => {
    randomMaps(({ state }) => {
      expect(fittingShapes(state.counters.placements)).toEqual(drawContext(state).fitting);
    });
  });

  it('puts the fill experiment at the core thresholds: equal to the core while no hole', () => {
    let compared = 0;
    randomMaps(({ state }) => {
      // Without holes, the cells no brick can reach are exactly the filled ones.
      if (holeCount(state) > 0) return;
      expect(fillPhase(state)).toBe(phaseOf(state));
      compared++;
    });
    expect(compared).toBeGreaterThan(1_000);
  });
});
