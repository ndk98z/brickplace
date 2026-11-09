import {
  checkGrowth,
  checkItemConfig,
  DEFAULT_ITEM_CONFIG,
  DEFAULT_MAP_SIZE,
  DEFAULT_MAX_SHIELD,
  DEFAULT_OPEN_EDGE,
  DEFAULT_OPEN_GROWTH,
  DEFAULT_SHIELD_LIFETIME,
  type ItemConfig,
  type OpenGrowth,
  PHASES,
  type Phase,
  type Rates,
} from '@brickplace/core';
import type { HammerMode } from './world.ts';

export const PLAYER_KINDS = ['builder', 'casual', 'griefer', 'repairer'] as const;
export type PlayerKind = (typeof PLAYER_KINDS)[number];

/** Drop weights per phase, as the core's ItemConfig holds them. */
export type PhaseRates = Readonly<Record<Phase, Rates>>;

/**
 * What sets the phase. 'room' is the core's rule (ADR 0010, `phaseOf`): the share of the
 * open area no brick can reach, filled cells plus holes. 'fill' is an experiment (the ADR 0005
 * rule): the filled share of the open area, at the core's thresholds.
 */
export type PhaseBy = 'room' | 'fill';

/**
 * How a brick's shape is drawn. 'fit' is the core's rule (ADR 0010): only among shapes with a
 * valid placement in the open area, and a shield when none has one. 'any' is an experiment
 * (the ADR 0005 rule): any of the seven shapes.
 */
export type ShapeDraw = 'fit' | 'any';

export type NoFit = 'shield' | 'redraw';

export interface SimConfig {
  readonly seed: number;
  readonly hours: number;
  /** Concurrent players; each gets one item per cooldown while the hold has room. */
  readonly players: number;
  readonly mapSize: number;
  /** Edge of the open area at season start, centred on the map. */
  readonly openSize: number;
  /** When and by how much the open area grows: the core's rule (ADR 0013), scaled. */
  readonly growth: OpenGrowth;
  readonly maxShield: number;
  /** How long a shield layer lasts, in the core's logical time (ms, ADR 0007). */
  readonly shieldLifetime: number;
  /**
   * Hold, cooldown, starting items and rates per phase: the core's ItemConfig (ADR
   * 0010–0012). The cooldown must be one tick (`TICK_MS`).
   */
  readonly items: ItemConfig;
  /** Share of each player kind; normalised. */
  readonly mix: Readonly<Record<PlayerKind, number>>;
  /** Artworks that builders draw, placed inside the starting open area. */
  readonly arts: number;
  readonly artSize: number;
  /** Spots a player compares before placing a brick: higher packs the map more tightly. */
  readonly search: number;
  readonly hammerMode: HammerMode;
  readonly phaseBy: PhaseBy;
  readonly shapeDraw: ShapeDraw;
  /**
   * Valid placements a shape needs to count as fitting under the 'fit' draw. ADR 0010 says
   * one (the core's `shapeFits`); higher values are an experiment, not a rule.
   */
  readonly fitMin: number;
  /**
   * What a brick draw becomes when no shape fits: a shield (ADR 0010, the core) or, as an
   * experiment, a re-draw among single brick, hammer and shield by their phase rates.
   */
  readonly noFit: NoFit;
  /**
   * Experiment, 0 for off: a brick draw is kept with probability min(1, placements / P),
   * where placements is the total of valid placements in the open area, and re-drawn
   * otherwise. Scales the brick weight by brick room; the removed weight goes to the other
   * items in proportion to their rates.
   */
  readonly roomScale: number;
  /**
   * Ticks between the scans that give players their lists of coverable cells and holes to
   * aim at (a model of what players see, not a rule). Draws and phases always read the
   * core's live counters. The sim also rescans right after the open area grows.
   */
  readonly refreshTicks: number;
}

/** ADR 0005's starting rates, superseded by ADR 0011 (the core's DEFAULT_ITEM_CONFIG). */
export const ADR_0005_RATES: PhaseRates = {
  settling: [75, 5, 10, 10],
  contested: [55, 10, 22, 13],
  saturated: [32, 18, 40, 10],
};

/** The sim map's edge: the real map at half the edge, so a week takes seconds. */
const SIM_MAP_SIZE = 512;
const SCALE = DEFAULT_MAP_SIZE / SIM_MAP_SIZE;

/**
 * A scaled-down season with the core's defaults: the real map is 1024² with a 512² start
 * growing by 128 a side at 70% (ADR 0013, 0027); the sim keeps the same proportions at half
 * the edge. Items, rates, hold and shield lifetime are the core's.
 */
export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  hours: 72,
  players: 500,
  mapSize: SIM_MAP_SIZE,
  // ADR 0027: the open area starts as a 512² square in the centre.
  openSize: DEFAULT_OPEN_EDGE / SCALE,
  growth: { atPercent: DEFAULT_OPEN_GROWTH.atPercent, step: DEFAULT_OPEN_GROWTH.step / SCALE },
  maxShield: DEFAULT_MAX_SHIELD,
  shieldLifetime: DEFAULT_SHIELD_LIFETIME,
  items: DEFAULT_ITEM_CONFIG,
  mix: { builder: 0.4, casual: 0.4, griefer: 0.1, repairer: 0.1 },
  arts: 30,
  artSize: 24,
  search: 12,
  hammerMode: 'cell',
  phaseBy: 'room',
  shapeDraw: 'fit',
  fitMin: 1,
  noFit: 'shield',
  roomScale: 0,
  refreshTicks: 1,
};

/**
 * Parses "75/5/10/10,55/10/22/13,32/18/40/10" into rates for the core's three phases, in
 * order. The core takes whole numbers only.
 */
export function parseRates(text: string): PhaseRates {
  const sets = text.split(',').map((part) => {
    const values = part.split('/').map(Number);
    if (values.length !== 4 || values.some((v) => !Number.isInteger(v) || v < 0)) {
      throw new Error(`bad rates "${part}": expected whole numbers brick/single/hammer/shield`);
    }
    return values as unknown as Rates;
  });
  if (sets.length !== PHASES.length) {
    throw new Error(`expected ${PHASES.length} rate sets, got ${sets.length}`);
  }
  const rates = Object.fromEntries(PHASES.map((phase, i) => [phase, sets[i]!])) as PhaseRates;
  checkItemConfig({ ...DEFAULT_ITEM_CONFIG, rates });
  return rates;
}

/** The config with other rates, everything else unchanged. */
export function withRates(config: SimConfig, rates: PhaseRates | string): SimConfig {
  const parsed = typeof rates === 'string' ? parseRates(rates) : rates;
  return { ...config, items: { ...config.items, rates: parsed } };
}

/** Throws unless the core accepts the item config and growth, and a cooldown is one tick. */
export function checkConfig(config: SimConfig, tickMs: number): void {
  checkItemConfig(config.items);
  checkGrowth(config.growth);
  if (config.items.cooldown !== tickMs) {
    throw new RangeError(`the sim plays one cooldown per tick: cooldown must be ${tickMs} ms`);
  }
}
