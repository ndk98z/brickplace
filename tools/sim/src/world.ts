import {
  apply,
  canCover,
  createState,
  DEFAULT_COOLDOWN,
  isFilled,
  LINK_DOWN,
  LINK_RIGHT,
  nextOpenArea,
  type Op,
  type OpenGrowth,
  type Rect,
  type Rotation,
  type ShapeId,
  type State,
  setOpenArea,
} from '@brickplace/core';

/** 'cell' is the core rule; 'piece' is an experiment where a hammer clears a whole brick. */
export type HammerMode = 'cell' | 'piece';

/** One tick is one cooldown (the core's default); the core's logical clock counts ms. */
export const TICK_MS = DEFAULT_COOLDOWN;

/**
 * The map as the sim sees it: the real core's State, played only through the core. Every
 * move is `apply` at the tick's logical time (single bricks, ADR 0005; shield decay, ADR
 * 0007, with layers expiring as the next accepted op sweeps them; newest layer first on a
 * hammer, ADR 0010), growth is the core's `nextOpenArea` and `setOpenArea` (ADR 0013), and
 * the anti-stuck counters (ADR 0010) are the core's own `state.counters`. What is left here
 * is bookkeeping for the report (which cells hold a single brick) and the whole-brick hammer
 * experiment.
 */
export class World {
  state: State;
  readonly size: number;
  /** 1 where the cell holds a single brick (the core does not tell them apart). */
  readonly single: Uint8Array;
  singles = 0;
  tick = 0;

  constructor(
    size: number,
    open: Rect,
    maxShield: number,
    /** Shield layer lifetime in the core's logical time (ms). */
    shieldLifetime: number,
    private readonly hammerMode: HammerMode = 'cell',
  ) {
    this.state = createState({ size, open, maxShield, shieldLifetime });
    this.size = size;
    this.single = new Uint8Array(size * size);
  }

  get open(): Rect {
    return this.state.config.open;
  }

  /** The core's logical time for this tick. */
  get now(): number {
    return this.tick * TICK_MS;
  }

  /** Filled cells, from the core's counters. */
  get filled(): number {
    return this.state.counters.filled;
  }

  /** Expiry times (ms) of the shield layers of each shielded cell, oldest first. */
  get layers(): ReadonlyMap<number, readonly number[]> {
    return this.state.shieldExpiry;
  }

  inOpen(x: number, y: number): boolean {
    const { open } = this;
    return x >= open.x && y >= open.y && x < open.x + open.w && y < open.y + open.h;
  }

  isEmptyOpen(x: number, y: number): boolean {
    return this.inOpen(x, y) && !isFilled(this.state.cells[y * this.size + x]!);
  }

  /** True when at least one brick placement through (x, y) fits (the core's counters). */
  canCover(x: number, y: number): boolean {
    return canCover(this.state, x, y);
  }

  /** An empty open cell that no brick can reach: only a single brick can fill it. */
  isHole(x: number, y: number): boolean {
    return this.isEmptyOpen(x, y) && !this.canCover(x, y);
  }

  private play(op: Op): boolean {
    return apply(this.state, op, this.now).ok;
  }

  brick(x: number, y: number, shape: ShapeId, rotation: Rotation, color: number): boolean {
    return this.play({ kind: 'brick', x, y, shape, rotation, color });
  }

  /** The core refuses it unless (x, y) is a hole (`coverable` otherwise). */
  placeSingle(x: number, y: number, color: number): boolean {
    if (!this.play({ kind: 'single', x, y, color })) return false;
    this.single[y * this.size + x] = 1;
    this.singles += 1;
    return true;
  }

  hammer(x: number, y: number): boolean {
    if (this.hammerMode === 'cell') return this.hammerCell(x, y);
    const index = y * this.size + x;
    if ((this.state.shields[index] ?? 0) > 0) return this.hammerCell(x, y);
    // Experiment, not a rule: an unshielded hit clears every unshielded cell of its piece.
    const piece = this.pieceOf(x, y);
    if (!this.hammerCell(x, y)) return false;
    for (const other of piece) {
      if (other !== index && this.state.shields[other] === 0) {
        this.hammerCell(other % this.size, Math.floor(other / this.size));
      }
    }
    return true;
  }

  /** Cells of the brick (or single brick) holding (x, y), found through the link bits. */
  pieceOf(x: number, y: number): number[] {
    const { size } = this;
    const { cells } = this.state;
    const start = y * size + x;
    if (!isFilled(cells[start]!)) return [];
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const index = queue.pop()!;
      const cx = index % size;
      const links = [
        cells[index]! & LINK_RIGHT ? index + 1 : -1,
        cells[index]! & LINK_DOWN ? index + size : -1,
        cx > 0 && cells[index - 1]! & LINK_RIGHT ? index - 1 : -1,
        index >= size && cells[index - size]! & LINK_DOWN ? index - size : -1,
      ];
      for (const next of links) {
        if (next >= 0 && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return [...seen];
  }

  private hammerCell(x: number, y: number): boolean {
    if (!this.play({ kind: 'hammer', x, y })) return false;
    const index = y * this.size + x;
    // Cleared (rather than a shield layer broken): it no longer holds a single brick.
    if (!isFilled(this.state.cells[index]!) && this.single[index]) {
      this.single[index] = 0;
      this.singles -= 1;
    }
    return true;
  }

  shield(x: number, y: number): boolean {
    return this.play({ kind: 'shield', x, y });
  }

  /**
   * Grows the open area as the server does after a batch (the core's nextOpenArea, ADR
   * 0013): by `growth.step` cells a side, clamped to the map, once filled cells reach
   * `growth.atPercent`. False when it does not grow.
   */
  growIfFull(growth: OpenGrowth): boolean {
    const next = nextOpenArea(this.state, growth);
    if (!next) return false;
    setOpenArea(this.state, next);
    return true;
  }

  fillRatio(): number {
    return this.filled / (this.open.w * this.open.h);
  }

  /**
   * Every empty open cell, split into those a brick can still cover and holes, plus the
   * number of valid placements of each of the 19 orientations: the core's counters (ADR
   * 0010), read as lists. Costs one pass over the open area, no placement scan.
   */
  empties(): { coverable: number[]; holes: number[]; placements: number[] } {
    const { open, size } = this;
    const { cells } = this.state;
    const { cover, placements } = this.state.counters;
    const coverable: number[] = [];
    const holes: number[] = [];
    for (let y = open.y; y < open.y + open.h; y++) {
      for (let index = y * size + open.x; index < y * size + open.x + open.w; index++) {
        if (isFilled(cells[index]!)) continue;
        (cover[index]! > 0 ? coverable : holes).push(index);
      }
    }
    return { coverable, holes, placements: Array.from(placements) };
  }
}
