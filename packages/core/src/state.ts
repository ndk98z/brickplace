import { DEFAULT_SHIELD_LIFETIME, SHIELD_CEILING } from './constants.ts';
import { recount } from './cover.ts';
import { ORIENTATIONS } from './shapes.ts';
import type { CoreConfig, Rect } from './types.ts';

/**
 * Shield layers that will expire, in the order they were placed. Since the logical clock never
 * goes back and the lifetime is fixed per state, that is also the order they expire in, so a
 * FIFO queue is enough. Entries for layers a hammer already broke stay until they are reached
 * and are skipped then.
 */
export interface ExpiryQueue {
  readonly times: number[];
  readonly cells: number[];
  head: number;
}

/**
 * Anti-stuck counters (ADR 0010), kept up to date by every accepted op in O(76) per changed
 * cell, and recounted from scratch when the open area changes (setOpenArea). A placement is
 * one orientation at one position with all four cells empty and inside the open area.
 */
export interface Counters {
  /** Valid placements per orientation, indexed like ORIENTATIONS (19 entries). */
  readonly placements: Uint32Array;
  /** Valid placements through each cell (0..76); 0 for filled cells and outside the open area. */
  readonly cover: Uint8Array;
  /** Empty open cells some brick can still reach (cover > 0). */
  reachable: number;
  /** Filled cells (all inside the open area, since it only grows). */
  filled: number;
}

export interface State {
  /** Replaced only by setOpenArea, which also recounts the counters. */
  config: CoreConfig;
  /** One byte per cell, row-major (index = y * size + x). See cell.ts for the layout. */
  readonly cells: Uint8Array;
  /** Shield layers per cell. */
  readonly shields: Uint8Array;
  /**
   * Logical time of the latest accepted op or expiry sweep, in the op log's unit
   * (milliseconds). Comes from the op log, never from a clock read here; never goes back.
   */
  clock: number;
  /**
   * Expiry time of each shield layer, oldest first, for shielded cells only (sparse).
   * Its length always equals `shields[index]`.
   */
  readonly shieldExpiry: Map<number, number[]>;
  readonly expiryQueue: ExpiryQueue;
  readonly counters: Counters;
}

/** The configured shield lifetime, or the default for configs written before decay existed. */
export function shieldLifetime(config: CoreConfig): number {
  return config.shieldLifetime ?? DEFAULT_SHIELD_LIFETIME;
}

/** Throws unless the rectangle has integer bounds and lies inside a map of edge `size`. */
export function checkOpenArea(open: Rect, size: number): void {
  const { x, y, w, h } = open;
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 0 || h < 0) {
    throw new RangeError('open area must have non-negative integer bounds');
  }
  if (x + w > size || y + h > size) throw new RangeError('open area must lie inside the map');
}

export function createState(config: CoreConfig): State {
  const state = emptyState(config);
  recount(state);
  return state;
}

/**
 * A checked state with an empty grid whose counters are all zero, not yet counted. Internal:
 * for createState and decodeCheckpoint, which fill the grid first and then call recount once.
 */
export function emptyState(config: CoreConfig): State {
  const { size, open, maxShield } = config;
  if (!Number.isInteger(size) || size <= 0) throw new RangeError(`invalid map size ${size}`);
  checkOpenArea(open, size);
  if (maxShield < 0 || maxShield > SHIELD_CEILING) throw new RangeError('maxShield out of range');
  const lifetime = shieldLifetime(config);
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) {
    throw new RangeError('shieldLifetime must be a positive integer');
  }
  return {
    config,
    cells: new Uint8Array(size * size),
    shields: new Uint8Array(size * size),
    clock: 0,
    shieldExpiry: new Map(),
    expiryQueue: { times: [], cells: [], head: 0 },
    counters: {
      placements: new Uint32Array(ORIENTATIONS.length),
      cover: new Uint8Array(size * size),
      reachable: 0,
      filled: 0,
    },
  };
}

/**
 * Grows the open area. It only grows during a season, so the new area must contain the old
 * one (filled cells then stay inside it). Recounts the anti-stuck counters from scratch.
 * Callers that replay must log this change with the ops, at its place in the order.
 */
export function setOpenArea(state: State, open: Rect): void {
  const { config } = state;
  checkOpenArea(open, config.size);
  const old = config.open;
  if (
    open.x > old.x ||
    open.y > old.y ||
    open.x + open.w < old.x + old.w ||
    open.y + open.h < old.y + old.h
  ) {
    throw new RangeError('the open area can only grow');
  }
  state.config = { ...config, open: { x: open.x, y: open.y, w: open.w, h: open.h } };
  recount(state);
}
