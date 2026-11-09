import { holeCount, shapeFits } from './cover.ts';
import type { ShapeId } from './shapes.ts';
import type { State } from './state.ts';
import type { Op } from './types.ts';

// Items, drop rates and the hold (ADR 0005, 0007, 0010, 0011). Like the rest of the core this
// module reads no clock and makes no random choice of its own: times are inputs in the op
// log's unit (ms), and every draw takes uniform 32-bit words chosen by the caller (the server
// derives them from a keyed PRF, so draws are unpredictable to clients yet reproducible).

/** Append only: the protocol sends an item kind as its index here. */
export const ITEM_KINDS = ['brick', 'single', 'hammer', 'shield'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** One item in a hold. A brick is drawn with its shape; the player picks rotation and colour. */
export type Item =
  | { readonly kind: 'brick'; readonly shape: ShapeId }
  | { readonly kind: 'single' }
  | { readonly kind: 'hammer' }
  | { readonly kind: 'shield' };

/** Drop weights in ITEM_KINDS order: non-negative integers that need not sum to 100. */
export type Rates = readonly [brick: number, single: number, hammer: number, shield: number];

export const PHASES = ['settling', 'contested', 'saturated'] as const;
export type Phase = (typeof PHASES)[number];

/**
 * Brick room thresholds in percent (ADR 0010): settling below 60, contested below 85,
 * saturated from there on.
 */
export const PHASE_THRESHOLDS = [60, 85] as const;

/**
 * What a canvas hands out and how fast. Stored with the canvas (pinned like the shield
 * lifetime), so changing a default here never changes a season already running.
 */
export interface ItemConfig {
  /** Bumped by every admin change, so stored holds can tell which config they were drawn under. */
  readonly version: number;
  /** Most items a player can hold (ADR 0007). */
  readonly hold: number;
  /** One item per cooldown while the hold has room (ms, ADR 0007). */
  readonly cooldown: number;
  /** Cooldowns a new player starts with already elapsed: items they get at once (ADR 0012). */
  readonly startItems: number;
  readonly rates: Readonly<Record<Phase, Rates>>;
}

export const DEFAULT_HOLD = 3;
export const DEFAULT_COOLDOWN = 60_000;

/** ADR 0011 starting rates (settling hammer from ADR 0035); a hold of 3 and a 60 s cooldown (ADR 0007). */
export const DEFAULT_ITEM_CONFIG: ItemConfig = {
  version: 1,
  hold: DEFAULT_HOLD,
  cooldown: DEFAULT_COOLDOWN,
  startItems: 1,
  rates: {
    settling: [84, 5, 1, 10],
    contested: [70, 10, 10, 10],
    saturated: [40, 10, 25, 25],
  },
};

/** Largest sum of one phase's rates: keeps `word * total` exact in 53-bit arithmetic. */
const MAX_RATE_TOTAL = 2 ** 20;
const MAX_COOLDOWN = 0xffffffff;
const WORD = 2 ** 32;

/** Throws unless the config can be used for draws and cooldowns. */
export function checkItemConfig(config: ItemConfig): void {
  const { version, hold, cooldown, startItems, rates } = config;
  if (!Number.isSafeInteger(version) || version < 1) throw new RangeError('invalid version');
  if (!Number.isInteger(hold) || hold < 1 || hold > 255) throw new RangeError('invalid hold');
  // At most a u32 of milliseconds (about 49 days), so it fits the wire format.
  if (!Number.isInteger(cooldown) || cooldown < 1 || cooldown > MAX_COOLDOWN) {
    throw new RangeError('invalid cooldown');
  }
  if (!Number.isInteger(startItems) || startItems < 0) throw new RangeError('invalid startItems');
  for (const phase of PHASES) {
    const set = rates?.[phase];
    if (!Array.isArray(set) || set.length !== ITEM_KINDS.length) {
      throw new RangeError(`rates for ${phase} must have ${ITEM_KINDS.length} entries`);
    }
    if (!set.every((w) => Number.isInteger(w) && w >= 0)) {
      throw new RangeError(`rates for ${phase} must be non-negative integers`);
    }
    const total = set.reduce((a, b) => a + b, 0);
    if (total < 1 || total > MAX_RATE_TOTAL) {
      throw new RangeError(`rates for ${phase} must sum to 1..${MAX_RATE_TOTAL}`);
    }
  }
}

// ---- phase and draws ----------------------------------------------------------------

/** Open cells no brick can reach: filled cells plus holes (ADR 0010's brick room measure). */
export function blockedCells(state: State): number {
  const { w, h } = state.config.open;
  return w * h - state.counters.reachable;
}

/**
 * The phase by brick room: the share of the open area no brick can reach. Integer
 * comparisons only, so every port agrees exactly at the thresholds.
 */
export function phaseOf(state: State): Phase {
  const { w, h } = state.config.open;
  const blocked = blockedCells(state) * 100;
  const area = w * h;
  if (blocked < PHASE_THRESHOLDS[0] * area) return 'settling';
  if (blocked < PHASE_THRESHOLDS[1] * area) return 'contested';
  return 'saturated';
}

/**
 * Picks a kind with probability proportional to its rate, from one uniform 32-bit word:
 * the first kind whose running total exceeds word / 2^32 * total. Exact in integers.
 */
export function rollKind(rates: Rates, word: number): ItemKind {
  checkWord(word);
  const total = rates[0] + rates[1] + rates[2] + rates[3];
  const scaled = word * total;
  let running = 0;
  for (let i = 0; i < ITEM_KINDS.length; i++) {
    running += rates[i]!;
    if (scaled < running * WORD) return ITEM_KINDS[i]!;
  }
  // Only reached when every rate is 0, which checkItemConfig refuses.
  return ITEM_KINDS[0];
}

/** What the anti-stuck rules need to know about the map at draw time. */
export interface DrawContext {
  /** Whether the open area has a hole only a single brick can fill. */
  readonly holes: boolean;
  /** Shapes with at least one valid placement, in id order. */
  readonly fitting: readonly ShapeId[];
}

const ALL_SHAPES: readonly ShapeId[] = [0, 1, 2, 3, 4, 5, 6];

export function drawContext(state: State): DrawContext {
  return {
    holes: holeCount(state) > 0,
    fitting: ALL_SHAPES.filter((shape) => shapeFits(state, shape)),
  };
}

/**
 * Draws one item. `kindWord` picks the kind by the rates. A single brick becomes a brick when
 * the map has no hole (ADR 0005). A brick takes a shape drawn uniformly by `shapeWord` among
 * the shapes that fit somewhere, and becomes a shield when none does (ADR 0010), so every
 * item drawn can be used somewhere at the time it is drawn.
 */
export function drawFrom(
  context: DrawContext,
  rates: Rates,
  kindWord: number,
  shapeWord: number,
): Item {
  checkWord(shapeWord);
  let kind = rollKind(rates, kindWord);
  if (kind === 'single' && !context.holes) kind = 'brick';
  if (kind !== 'brick') return { kind };
  const { fitting } = context;
  if (fitting.length === 0) return { kind: 'shield' };
  return { kind, shape: fitting[Math.floor((shapeWord * fitting.length) / WORD)]! };
}

/** Draws one item for the state as it is now, with the rates of its current phase. */
export function drawItem(
  state: State,
  config: ItemConfig,
  kindWord: number,
  shapeWord: number,
): Item {
  return drawFrom(drawContext(state), config.rates[phaseOf(state)], kindWord, shapeWord);
}

function checkWord(word: number): void {
  if (!Number.isInteger(word) || word < 0 || word >= WORD) {
    throw new RangeError(`random word ${word} is not a 32-bit unsigned integer`);
  }
}

// ---- the hold -----------------------------------------------------------------------

/**
 * A player's hold. Items are not handed out by timers: whoever looks at the hold first asks
 * `itemsDue` how many cooldowns have passed since `since` and draws that many (at most the
 * room left), then records them with `addItems`.
 */
export interface Hold {
  readonly items: readonly Item[];
  /**
   * When the cooldown under way started (op log time, ms): the last item's arrival, or the
   * moment a full hold got room again. Not used while the hold is full: a full hold banks
   * no time.
   */
  readonly since: number;
}

/** The hold of a player first seen at `now`: `startItems` cooldowns have already passed. */
export function newHold(now: number, config: ItemConfig): Hold {
  return { items: [], since: now - Math.min(config.startItems, config.hold) * config.cooldown };
}

/** Items that have arrived by `now` and not been drawn yet. */
export function itemsDue(hold: Hold, now: number, config: ItemConfig): number {
  const room = config.hold - hold.items.length;
  if (room <= 0 || now < hold.since) return 0;
  return Math.min(room, Math.floor((now - hold.since) / config.cooldown));
}

/** Adds items just drawn for the cooldowns that passed (at most `itemsDue` of them). */
export function addItems(hold: Hold, drawn: readonly Item[], config: ItemConfig): Hold {
  if (drawn.length === 0) return hold;
  if (hold.items.length + drawn.length > config.hold) throw new RangeError('hold overflow');
  return { items: [...hold.items, ...drawn], since: hold.since + drawn.length * config.cooldown };
}

/** When the next item arrives, or null while the hold is full. */
export function nextItemAt(hold: Hold, config: ItemConfig): number | null {
  return hold.items.length >= config.hold ? null : hold.since + config.cooldown;
}

/** The item an op uses: its kind and, for a brick, its shape. Rotation and colour are free. */
export function itemFor(op: Op): Item {
  return op.kind === 'brick' ? { kind: 'brick', shape: op.shape } : { kind: op.kind };
}

export function sameItem(a: Item, b: Item): boolean {
  return a.kind === b.kind && (a.kind !== 'brick' || (b.kind === 'brick' && a.shape === b.shape));
}

/** Index of the first held item equal to `item`, or -1. */
export function findItem(hold: Hold, item: Item): number {
  return hold.items.findIndex((held) => sameItem(held, item));
}

/**
 * Removes the item at `index`, at time `now`. Taking from a full hold starts the cooldown
 * now, since time spent full does not count.
 */
export function takeItem(hold: Hold, index: number, now: number, config: ItemConfig): Hold {
  if (!Number.isInteger(index) || index < 0 || index >= hold.items.length) {
    throw new RangeError(`no item at ${index}`);
  }
  const items = hold.items.filter((_, i) => i !== index);
  return { items, since: hold.items.length >= config.hold ? now : hold.since };
}
