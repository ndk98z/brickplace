// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.
//
// Per-socket tile views (ADR 0028): which tiles' diffs each socket gets, and the frames that
// carry them. Pure, so the cost per op can be measured without sockets (test/views.test.ts).

import {
  encodeServerMessage,
  MAX_DIFFS_PER_FRAME,
  Opcode,
  PROTOCOL_VERSION,
  VIEW_TILE,
} from '@brickplace/protocol';

/** [index u32][cell u8][shield u8]: a Diffs frame's records, and CanvasDO's tick records. */
export const RECORD_BYTES = 6;
const DIFFS_HEADER = 8;

export interface TileRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The tiles of one map: `perSide` a side, row-major. */
export interface TileGrid {
  readonly size: number;
  readonly perSide: number;
  readonly count: number;
}

export function tileGrid(size: number): TileGrid {
  const perSide = Math.max(1, Math.ceil(size / VIEW_TILE));
  return { size, perSide, count: perSide * perSide };
}

/** The tile holding cell `index` of a map of edge `size`. */
export function tileOf(index: number, grid: TileGrid): number {
  const x = index % grid.size;
  const y = (index - x) / grid.size;
  return Math.floor(y / VIEW_TILE) * grid.perSide + Math.floor(x / VIEW_TILE);
}

/** A set of tiles as a bitmask, one bit per tile. */
export type TileMask = Uint8Array;

export function emptyMask(grid: TileGrid): TileMask {
  return new Uint8Array(Math.ceil(grid.count / 8));
}

export function hasTile(mask: TileMask, tile: number): boolean {
  return ((mask[tile >> 3] ?? 0) & (1 << (tile & 7))) !== 0;
}

function addTile(mask: TileMask, tile: number): void {
  mask[tile >> 3]! |= 1 << (tile & 7);
}

/** The tiles a view rectangle (in tiles) covers, clamped to the map. */
export function maskOf(rect: TileRect, grid: TileGrid): TileMask {
  const mask = emptyMask(grid);
  const x1 = Math.min(grid.perSide, rect.x + rect.w);
  const y1 = Math.min(grid.perSide, rect.y + rect.h);
  for (let ty = rect.y; ty < y1; ty++) {
    for (let tx = rect.x; tx < x1; tx++) addTile(mask, ty * grid.perSide + tx);
  }
  return mask;
}

/** Tiles in `next` and not in `previous` (null: every tile, so nothing is new). */
export function addedTiles(previous: TileMask | null, next: TileMask, grid: TileGrid): number[] {
  if (previous === null) return [];
  const out: number[] = [];
  for (let tile = 0; tile < grid.count; tile++) {
    if (hasTile(next, tile) && !hasTile(previous, tile)) out.push(tile);
  }
  return out;
}

/** Frame bytes one TickFrames keeps for reuse; past it, frames are built per socket. */
export const MAX_SHARED_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * The frames of one seq's changed cells for each socket: only the records of the tiles the
 * socket views, split at MAX_DIFFS_PER_FRAME (all full but the last, as the client expects:
 * it takes a frame that is not full as the end of its seq). The records are grouped by tile
 * once, so a socket's frames cost a copy of its own tiles' records, never a pass over every
 * record. Sockets that see the same changed tiles share one set of frames while the shared
 * frames stay under MAX_SHARED_FRAME_BYTES; past that (a huge tick and many different views)
 * frames are built for each socket and dropped once sent.
 */
export class TickFrames {
  /** The records, grouped by tile in ascending tile order. */
  private readonly grouped: Uint8Array;
  /** Per touched tile (ascending): where its records start in `grouped`, and how many. */
  private readonly segments = new Map<number, { readonly start: number; readonly count: number }>();
  /** The distinct tiles touched, ascending. */
  private readonly touched: number[];
  private readonly built = new Map<string, Uint8Array[]>();
  private sharedBytes = 0;
  /** Frame sets built (distinct tile sets, or per socket past the share limit). */
  builds = 0;

  constructor(
    readonly seq: number,
    records: Uint8Array,
    grid: TileGrid,
    private readonly maxShared = MAX_SHARED_FRAME_BYTES,
  ) {
    const count = records.byteLength / RECORD_BYTES;
    const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
    const tiles = new Uint32Array(count);
    const counts = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const tile = tileOf(view.getUint32(i * RECORD_BYTES, true), grid);
      tiles[i] = tile;
      counts.set(tile, (counts.get(tile) ?? 0) + 1);
    }
    this.touched = [...counts.keys()].sort((a, b) => a - b);
    const next = new Map<number, number>();
    let start = 0;
    for (const tile of this.touched) {
      const n = counts.get(tile)!;
      this.segments.set(tile, { start, count: n });
      next.set(tile, start);
      start += n;
    }
    this.grouped = new Uint8Array(records.byteLength);
    for (let i = 0; i < count; i++) {
      const at = next.get(tiles[i]!)!;
      next.set(tiles[i]!, at + 1);
      this.grouped.set(
        records.subarray(i * RECORD_BYTES, (i + 1) * RECORD_BYTES),
        at * RECORD_BYTES,
      );
    }
  }

  /** Frames for a socket viewing `mask` (null: every tile); empty when none of its tiles moved. */
  framesFor(mask: TileMask | null): readonly Uint8Array[] {
    const seen = mask === null ? this.touched : this.touched.filter((t) => hasTile(mask, t));
    if (seen.length === 0) return [];
    const key = seen.length === this.touched.length ? '*' : seen.join(',');
    const cached = this.built.get(key);
    if (cached) return cached;
    const frames = this.build(seen);
    this.builds++;
    const bytes = frames.reduce((n, f) => n + f.byteLength, 0);
    if (this.sharedBytes + bytes <= this.maxShared) {
      this.built.set(key, frames);
      this.sharedBytes += bytes;
    }
    return frames;
  }

  /** The frames of these tiles' records, split at MAX_DIFFS_PER_FRAME. */
  private build(tiles: readonly number[]): Uint8Array[] {
    let total = 0;
    for (const t of tiles) total += this.segments.get(t)!.count;
    const frames: Uint8Array[] = [];
    let frame: Uint8Array | null = null;
    let filled = 0;
    let left = total;
    const open = () => {
      const n = Math.min(MAX_DIFFS_PER_FRAME, left);
      const f = new Uint8Array(DIFFS_HEADER + n * RECORD_BYTES);
      const view = new DataView(f.buffer);
      view.setUint8(0, PROTOCOL_VERSION);
      view.setUint8(1, Opcode.Diffs);
      view.setUint32(2, this.seq, true);
      view.setUint16(6, n, true);
      frames.push(f);
      return f;
    };
    for (const t of tiles) {
      const { start, count } = this.segments.get(t)!;
      let done = 0;
      while (done < count) {
        if (frame === null || filled === (frame.byteLength - DIFFS_HEADER) / RECORD_BYTES) {
          frame = open();
          filled = 0;
        }
        const room = (frame.byteLength - DIFFS_HEADER) / RECORD_BYTES - filled;
        const take = Math.min(room, count - done);
        const from = (start + done) * RECORD_BYTES;
        frame.set(
          this.grouped.subarray(from, from + take * RECORD_BYTES),
          DIFFS_HEADER + filled * RECORD_BYTES,
        );
        filled += take;
        done += take;
        left -= take;
      }
    }
    return frames;
  }
}

/** Records for these cell diffs, in their order. */
export function toRecords(
  diffs: readonly { readonly index: number; readonly cell: number; readonly shield: number }[],
): Uint8Array {
  const records = new Uint8Array(diffs.length * RECORD_BYTES);
  const view = new DataView(records.buffer);
  diffs.forEach((d, i) => {
    view.setUint32(i * RECORD_BYTES, d.index, true);
    records[i * RECORD_BYTES + 4] = d.cell;
    records[i * RECORD_BYTES + 5] = d.shield;
  });
  return records;
}

/** A Tile frame for one tile of a whole-map grid. */
export function tileFrame(
  grid: { readonly seq: number; readonly cells: Uint8Array; readonly shields: Uint8Array },
  tiles: TileGrid,
  tile: number,
): Uint8Array {
  const tx = tile % tiles.perSide;
  const ty = (tile - tx) / tiles.perSide;
  const edge = Math.min(VIEW_TILE, tiles.size);
  const cells = new Uint8Array(edge * edge);
  const shields = new Uint8Array(edge * edge);
  for (let row = 0; row < edge; row++) {
    const from = (ty * edge + row) * tiles.size + tx * edge;
    cells.set(grid.cells.subarray(from, from + edge), row * edge);
    shields.set(grid.shields.subarray(from, from + edge), row * edge);
  }
  return encodeServerMessage({ type: 'tile', seq: grid.seq, tx, ty, edge, cells, shields });
}
