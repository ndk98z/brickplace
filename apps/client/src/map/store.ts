import type { CellDiff } from '@brickplace/core';
import { TILE_SIZE } from '@brickplace/core';
import type { Overview } from '@brickplace/protocol/cdn';

/** Inclusive cell range inside one tile, in tile-local coordinates. */
export interface DirtyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Collects which parts of which tiles changed since the last `take()`. Each consumer (GPU
 * upload, minimap) owns one, so they can flush at their own pace.
 */
export class DirtyTracker {
  private readonly rects = new Map<number, DirtyRect>();

  constructor(private readonly tileCount: number) {}

  mark(tile: number, x: number, y: number): void {
    const rect = this.rects.get(tile);
    if (!rect) {
      this.rects.set(tile, { x0: x, y0: y, x1: x, y1: y });
      return;
    }
    if (x < rect.x0) rect.x0 = x;
    if (x > rect.x1) rect.x1 = x;
    if (y < rect.y0) rect.y0 = y;
    if (y > rect.y1) rect.y1 = y;
  }

  markAll(): void {
    for (let tile = 0; tile < this.tileCount; tile++) {
      this.rects.set(tile, { x0: 0, y0: 0, x1: TILE_SIZE - 1, y1: TILE_SIZE - 1 });
    }
  }

  get size(): number {
    return this.rects.size;
  }

  /** Returns the dirty rects (tile index → rect) and starts collecting afresh. */
  take(): Map<number, DirtyRect> {
    const out = new Map(this.rects);
    this.rects.clear();
    return out;
  }
}

/**
 * The client's copy of the map: one cell byte (layout in packages/core/src/cell.ts) and one
 * shield byte per cell, stored per 256² tile so a tile uploads to its texture without copying.
 *
 * Diffs carry absolute cell values, so applying one twice, or re-applying a frame the client
 * already has, changes nothing.
 */
export class MapStore {
  readonly tilesPerSide: number;
  readonly cells: Uint8Array[] = [];
  readonly shields: Uint8Array[] = [];
  private readonly trackers: DirtyTracker[] = [];
  private listeners = new Set<() => void>();
  /** Tiles whose cells came whole from a tile snapshot or a socket's grid. */
  private readonly held: boolean[];
  private overviewLayer: Overview | null = null;

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size <= 0 || size % TILE_SIZE !== 0) {
      throw new RangeError(`map size ${size} must be a positive multiple of ${TILE_SIZE}`);
    }
    this.tilesPerSide = size / TILE_SIZE;
    for (let i = 0; i < this.tileCount; i++) {
      this.cells.push(new Uint8Array(TILE_SIZE * TILE_SIZE));
      this.shields.push(new Uint8Array(TILE_SIZE * TILE_SIZE));
    }
    this.held = new Array<boolean>(this.tileCount).fill(false);
  }

  get tileCount(): number {
    return this.tilesPerSide * this.tilesPerSide;
  }

  /**
   * True once a tile's cells came whole from a tile snapshot or a socket's grid. A tile that
   * did not is drawn zoomed out from the overview, if there is one (minimap.ts).
   */
  isHeld(tile: number): boolean {
    return this.held[tile] ?? false;
  }

  /**
   * The whole map downscaled, from the CDN (ADR 0009): what pages zoomed far out and the
   * minimap show of tiles they hold no cells for. Never a source of cells: nothing reads it
   * but the downsampling (minimap.ts).
   */
  get overview(): Overview | null {
    return this.overviewLayer;
  }

  /**
   * The tile's cells are no longer current (the CDN feed dropped it past a gap): they stay in
   * place, but zoomed out it is drawn from the overview again until a snapshot reloads it.
   */
  release(tile: number): void {
    if (!this.held[tile]) return;
    this.held[tile] = false;
    for (const tracker of this.trackers) {
      tracker.mark(tile, 0, 0);
      tracker.mark(tile, TILE_SIZE - 1, TILE_SIZE - 1);
    }
    this.emit();
  }

  /** Takes a newer overview; the tiles drawn from it are redrawn. */
  setOverview(overview: Overview): void {
    if (overview.side * overview.factor !== this.size) {
      throw new RangeError(`an overview of ${overview.side}x${overview.factor} is not this map`);
    }
    this.overviewLayer = overview;
    for (let tile = 0; tile < this.tileCount; tile++) {
      if (this.held[tile]) continue;
      for (const tracker of this.trackers) {
        tracker.mark(tile, 0, 0);
        tracker.mark(tile, TILE_SIZE - 1, TILE_SIZE - 1);
      }
    }
    this.emit();
  }

  /** A new consumer starts with everything dirty, since it has seen nothing yet. */
  track(): DirtyTracker {
    const tracker = new DirtyTracker(this.tileCount);
    tracker.markAll();
    this.trackers.push(tracker);
    return tracker;
  }

  untrack(tracker: DirtyTracker): void {
    const at = this.trackers.indexOf(tracker);
    if (at >= 0) this.trackers.splice(at, 1);
  }

  /** Called after any change, once per batch. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cell(x: number, y: number): number {
    if (!this.inside(x, y)) return 0;
    return this.cells[this.tileOf(x, y)]![this.localOf(x, y)]!;
  }

  shield(x: number, y: number): number {
    if (!this.inside(x, y)) return 0;
    return this.shields[this.tileOf(x, y)]![this.localOf(x, y)]!;
  }

  inside(x: number, y: number): boolean {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < this.size &&
      y < this.size
    );
  }

  /**
   * Applies diffs in order and returns how many cells actually changed. Indices outside the
   * map are ignored: a frame from a server with a bigger map must not corrupt memory.
   */
  applyDiffs(diffs: readonly CellDiff[]): number {
    let changed = 0;
    const cellCount = this.size * this.size;
    for (const { index, cell, shield } of diffs) {
      if (!Number.isInteger(index) || index < 0 || index >= cellCount) continue;
      const x = index % this.size;
      const y = (index - x) / this.size;
      const tile = this.tileOf(x, y);
      const local = this.localOf(x, y);
      const cells = this.cells[tile]!;
      const shields = this.shields[tile]!;
      if (cells[local] === cell && shields[local] === shield) continue;
      cells[local] = cell;
      shields[local] = shield;
      const lx = x % TILE_SIZE;
      const ly = y % TILE_SIZE;
      for (const tracker of this.trackers) tracker.mark(tile, lx, ly);
      changed++;
    }
    if (changed > 0) this.emit();
    return changed;
  }

  /**
   * Replaces one tile's cells and shields (row-major, TILE_SIZE² each), e.g. with a tile
   * snapshot from the CDN. Returns true when anything changed; only then is the tile marked
   * dirty and listeners told. `notify: false` leaves telling them to the caller, so a batch of
   * tiles and diffs is drawn as one.
   */
  setTile(tile: number, cells: Uint8Array, shields: Uint8Array, notify = true): boolean {
    const area = TILE_SIZE * TILE_SIZE;
    if (cells.length !== area || shields.length !== area) {
      throw new RangeError(`a tile has ${area} cells`);
    }
    const ownCells = this.cells[tile];
    const ownShields = this.shields[tile];
    if (!ownCells || !ownShields) throw new RangeError(`no tile ${tile}`);
    const wasHeld = this.held[tile];
    this.held[tile] = true;
    if (sameBytes(ownCells, cells) && sameBytes(ownShields, shields)) {
      // Same cells, but drawn from them now instead of from the overview.
      if (!wasHeld && this.overviewLayer) {
        for (const tracker of this.trackers) {
          tracker.mark(tile, 0, 0);
          tracker.mark(tile, TILE_SIZE - 1, TILE_SIZE - 1);
        }
        if (notify) this.emit();
        return true;
      }
      return false;
    }
    ownCells.set(cells);
    ownShields.set(shields);
    for (const tracker of this.trackers) {
      tracker.mark(tile, 0, 0);
      tracker.mark(tile, TILE_SIZE - 1, TILE_SIZE - 1);
    }
    if (notify) this.emit();
    return true;
  }

  /**
   * Takes every tile of another store of the same size (a socket's initial grid, collected
   * off screen), marking only the tiles that differ. One change for listeners.
   */
  replaceFrom(other: MapStore): void {
    if (other.size !== this.size) throw new RangeError('stores differ in size');
    let changed = false;
    for (let tile = 0; tile < this.tileCount; tile++) {
      changed = this.setTile(tile, other.cells[tile]!, other.shields[tile]!, false) || changed;
    }
    if (changed) this.emit();
  }

  /**
   * A copy of every tile's cells and of which tiles are held, with no listeners or trackers:
   * the off-screen map a resuming socket's changes go into (ADR 0040).
   */
  copy(): MapStore {
    const copy = new MapStore(this.size);
    for (let tile = 0; tile < this.tileCount; tile++) {
      copy.cells[tile]!.set(this.cells[tile]!);
      copy.shields[tile]!.set(this.shields[tile]!);
      copy.held[tile] = this.held[tile]!;
    }
    return copy;
  }

  /** True when every tile is held (came whole from a snapshot or a socket's map). */
  get holdsAll(): boolean {
    return this.held.every(Boolean);
  }

  /** Tells listeners about changes made with `notify: false`. */
  changed(): void {
    this.emit();
  }

  /** Forgets the whole map, e.g. before the server resends it on a new connection. */
  reset(): void {
    for (const tile of this.cells) tile.fill(0);
    for (const tile of this.shields) tile.fill(0);
    this.held.fill(false);
    for (const tracker of this.trackers) tracker.markAll();
    this.emit();
  }

  private tileOf(x: number, y: number): number {
    return Math.floor(y / TILE_SIZE) * this.tilesPerSide + Math.floor(x / TILE_SIZE);
  }

  private localOf(x: number, y: number): number {
    return (y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
