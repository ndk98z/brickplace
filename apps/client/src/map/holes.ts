import { isFilled, type Rect, TILE_SIZE } from '@brickplace/core';
import { coverable } from './ghost.ts';
import type { DirtyRect, DirtyTracker, MapStore } from './store.ts';

const WHOLE_TILE: DirtyRect = { x0: 0, y0: 0, x1: TILE_SIZE - 1, y1: TILE_SIZE - 1 };

/**
 * Marks the holes of one tile: empty cells inside the open area that no brick placement can
 * cover, the only cells a single brick may fill (ADR 0005). Writes 1 for a hole and 0 for
 * any other cell into `out` (TILE_SIZE² bytes, tile-local, row-major), within `region`
 * (tile-local, inclusive; the whole tile by default), and returns the holes it found there.
 * Mirrors the server's rule on the client's copy of the map, as the ghost does.
 */
export function holeMask(
  store: MapStore,
  open: Rect,
  tile: number,
  out: Uint8Array,
  region: DirtyRect = WHOLE_TILE,
): number {
  const tx = (tile % store.tilesPerSide) * TILE_SIZE;
  const ty = Math.floor(tile / store.tilesPerSide) * TILE_SIZE;
  const cells = store.cells[tile]!;
  let holes = 0;
  for (let ly = region.y0; ly <= region.y1; ly++) {
    for (let lx = region.x0; lx <= region.x1; lx++) {
      const local = ly * TILE_SIZE + lx;
      const x = tx + lx;
      const y = ty + ly;
      const inOpen = x >= open.x && y >= open.y && x < open.x + open.w && y < open.y + open.h;
      const hole = inOpen && !isFilled(cells[local]!) && !coverable(store, open, x, y);
      out[local] = hole ? 1 : 0;
      if (hole) holes++;
    }
  }
  return holes;
}

/** How far a change reaches: a placement through a cell spans at most 3 cells either way. */
const REACH = 3;

function union(a: DirtyRect | undefined, b: DirtyRect): DirtyRect {
  if (!a) return { ...b };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/**
 * Hole masks of the tiles on screen, kept up to date lazily and incrementally. A changed
 * cell can turn cells up to three away into holes (or back), so each change marks that
 * neighbourhood, across tile edges, for recounting; only tiles asked for are computed, and
 * a computed tile is recounted only where it was marked.
 */
export class HoleMasks {
  private readonly masks = new Map<number, Uint8Array>();
  /** Parts of computed masks to recount, tile-local. */
  private readonly pending = new Map<number, DirtyRect>();
  private readonly tracker: DirtyTracker;

  constructor(
    private readonly store: MapStore,
    private open: Rect,
  ) {
    this.tracker = store.track();
    // A new tracker starts with everything dirty; nothing is computed yet anyway.
    this.tracker.take();
  }

  /** The open area changed: every mask is recomputed when next asked for. */
  setOpen(open: Rect): void {
    this.open = open;
    this.masks.clear();
    this.pending.clear();
  }

  /**
   * Brings the masks of `tiles` up to date and returns those that changed, with their mask,
   * for upload.
   */
  update(tiles: Iterable<number>): Map<number, Uint8Array> {
    this.collect();
    const changed = new Map<number, Uint8Array>();
    for (const tile of tiles) {
      let mask = this.masks.get(tile);
      if (!mask) {
        mask = new Uint8Array(TILE_SIZE * TILE_SIZE);
        holeMask(this.store, this.open, tile, mask);
        this.masks.set(tile, mask);
        this.pending.delete(tile);
        changed.set(tile, mask);
        continue;
      }
      const region = this.pending.get(tile);
      if (!region) continue;
      this.pending.delete(tile);
      holeMask(this.store, this.open, tile, mask, region);
      changed.set(tile, mask);
    }
    return changed;
  }

  dispose(): void {
    this.store.untrack(this.tracker);
  }

  /** Turns the store's changes into regions to recount, in every tile they reach. */
  private collect(): void {
    if (this.tracker.size === 0) return;
    const per = this.store.tilesPerSide;
    for (const [tile, rect] of this.tracker.take()) {
      // The changed rectangle grown by REACH, in map cells.
      const ox = (tile % per) * TILE_SIZE;
      const oy = Math.floor(tile / per) * TILE_SIZE;
      const x0 = ox + rect.x0 - REACH;
      const y0 = oy + rect.y0 - REACH;
      const x1 = ox + rect.x1 + REACH;
      const y1 = oy + rect.y1 + REACH;
      for (
        let ty = Math.max(0, Math.floor(y0 / TILE_SIZE));
        ty <= Math.min(per - 1, Math.floor(y1 / TILE_SIZE));
        ty++
      ) {
        for (
          let tx = Math.max(0, Math.floor(x0 / TILE_SIZE));
          tx <= Math.min(per - 1, Math.floor(x1 / TILE_SIZE));
          tx++
        ) {
          const target = ty * per + tx;
          if (!this.masks.has(target)) continue;
          const bx = tx * TILE_SIZE;
          const by = ty * TILE_SIZE;
          const part: DirtyRect = {
            x0: Math.max(0, x0 - bx),
            y0: Math.max(0, y0 - by),
            x1: Math.min(TILE_SIZE - 1, x1 - bx),
            y1: Math.min(TILE_SIZE - 1, y1 - by),
          };
          this.pending.set(target, union(this.pending.get(target), part));
        }
      }
    }
  }
}
