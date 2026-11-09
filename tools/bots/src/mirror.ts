import {
  type CellDiff,
  cellsOf,
  colorOf,
  FILLED,
  isFilled,
  PLACEMENT_COUNT,
  PLACEMENTS,
  type Rect,
  type Rotation,
  type ShapeId,
} from '@brickplace/core';
import type { ConfigMessage, TileMessage } from '@brickplace/protocol';

/**
 * The map as the bots see it: one copy for the whole run, kept by a watching socket (see
 * driver.ts), so 200 bots do not hold 200 grids. The server decides every move; this copy only
 * aims them, so a cell a few hundred ms out of date costs a refused op, nothing more.
 */
export class Mirror {
  size: number;
  open: Rect;
  maxShield: number;
  locks: readonly Rect[] = [];
  cells: Uint8Array;
  shields: Uint8Array;
  /** Grows with every change, so cached looks at the map know when to look again. */
  version = 0;
  /** True once a whole grid and the config have arrived. */
  ready = false;

  constructor(size: number, open: Rect, maxShield: number) {
    this.size = size;
    this.open = open;
    this.maxShield = maxShield;
    this.cells = new Uint8Array(size * size);
    this.shields = new Uint8Array(size * size);
  }

  /** The canvas rules: a new map size (a new season's canvas) starts from an empty grid. */
  setConfig(config: ConfigMessage): void {
    if (config.mapSize !== this.size) {
      this.size = config.mapSize;
      this.cells = new Uint8Array(this.size * this.size);
      this.shields = new Uint8Array(this.size * this.size);
    }
    this.open = config.open;
    this.maxShield = config.maxShield;
    this.locks = config.locks ?? [];
    this.version++;
  }

  /** Replaces the grid with one received whole (a socket's initial grid). */
  replace(cells: Uint8Array, shields: Uint8Array): void {
    this.cells = cells;
    this.shields = shields;
    this.version++;
  }

  applyDiffs(diffs: readonly CellDiff[]): void {
    for (const { index, cell, shield } of diffs) {
      if (index >= this.cells.length) continue;
      this.cells[index] = cell;
      this.shields[index] = shield;
    }
    if (diffs.length) this.version++;
  }

  applyTile(tile: TileMessage): void {
    const { tx, ty, edge, cells, shields } = tile;
    for (let row = 0; row < edge; row++) {
      const y = ty * edge + row;
      if (y >= this.size) break;
      for (let col = 0; col < edge; col++) {
        const x = tx * edge + col;
        if (x >= this.size) break;
        this.cells[y * this.size + x] = cells[row * edge + col]!;
        this.shields[y * this.size + x] = shields[row * edge + col]!;
      }
    }
    this.version++;
  }

  inOpen(x: number, y: number): boolean {
    const { open } = this;
    return x >= open.x && y >= open.y && x < open.x + open.w && y < open.y + open.h;
  }

  locked(x: number, y: number): boolean {
    return this.locks.some((l) => x >= l.x && y >= l.y && x < l.x + l.w && y < l.y + l.h);
  }

  /** Inside the open area and outside every lock: an op may touch it. */
  playable(x: number, y: number): boolean {
    return this.inOpen(x, y) && !this.locked(x, y);
  }

  filled(index: number): boolean {
    return isFilled(this.cells[index]!);
  }

  /** The colour of a filled cell, or -1 for an empty one. */
  colorAt(index: number): number {
    const cell = this.cells[index]!;
    return isFilled(cell) ? colorOf(cell) : -1;
  }

  isEmptyPlayable(x: number, y: number): boolean {
    return this.playable(x, y) && !this.filled(y * this.size + x);
  }

  /** True when the brick fits with its anchor at (x, y): four empty playable cells. */
  fits(x: number, y: number, shape: ShapeId, rotation: Rotation): boolean {
    return cellsOf(shape, rotation).every(([dx, dy]) => this.isEmptyPlayable(x + dx, y + dy));
  }

  /**
   * True when some brick placement through (x, y) fits, as the core's `canCover` decides a
   * single brick (ADR 0005): the 76 placements through the cell, inside the open area. Locks
   * do not count here, as in the core.
   */
  canCover(x: number, y: number): boolean {
    const { open, size, cells } = this;
    const x1 = open.x + open.w;
    const y1 = open.y + open.h;
    for (let q = 0; q < PLACEMENT_COUNT; q++) {
      const p = q * 8;
      let k = 0;
      for (; k < 8; k += 2) {
        const cx = x + PLACEMENTS[p + k]!;
        const cy = y + PLACEMENTS[p + k + 1]!;
        if (cx < open.x || cy < open.y || cx >= x1 || cy >= y1) break;
        if ((cells[cy * size + cx]! & FILLED) !== 0) break;
      }
      if (k === 8) return true;
    }
    return false;
  }

  /** An empty playable cell no brick can reach: only a single brick fills it. */
  isHole(x: number, y: number): boolean {
    return this.isEmptyPlayable(x, y) && !this.canCover(x, y);
  }
}

/** A rectangle grown by `margin` on every side and clamped to a map of edge `size`. */
export function around(rect: Rect, margin: number, size: number): Rect {
  const x = Math.max(0, rect.x - margin);
  const y = Math.max(0, rect.y - margin);
  const x1 = Math.min(size, rect.x + rect.w + margin);
  const y1 = Math.min(size, rect.y + rect.h + margin);
  return { x, y, w: Math.max(0, x1 - x), h: Math.max(0, y1 - y) };
}

export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}
