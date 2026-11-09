import { colorOf, isFilled, type Rect, TILE_SIZE } from '@brickplace/core';
import type { Overview } from '@brickplace/protocol/cdn';
import { hexToRgb, PALETTE } from '../palette.ts';
import type { MapStore } from './store.ts';

const EMPTY = hexToRgb('#FFFFFF');
const CLOSED = hexToRgb('#D6DCE7');
const COLORS = PALETTE.map(hexToRgb);
const BOOST = 4;

export interface DownsampleOptions {
  /**
   * How much a filled cell counts against the background: 4 (the minimap) so a lone brick
   * still shows at minimap scale, 1 for a true average (the zoomed-out map).
   */
  readonly boost?: number;
  /** Write the tile at the top left of `out` instead of at its place on the map. */
  readonly atOrigin?: boolean;
}

/**
 * Downsamples one tile into RGBA pixels: each pixel shows the average colour of the filled
 * cells in its `factor`² block over the empty (or closed) background. Writes into `out`, an
 * RGBA buffer `stride` pixels wide, at the tile's position (or at the origin).
 */
export function drawMinimapTile(
  store: MapStore,
  tile: number,
  factor: number,
  open: Rect,
  out: Uint8ClampedArray | Uint8Array,
  stride: number,
  options: DownsampleOptions = {},
): void {
  const boost = options.boost ?? BOOST;
  const cells = store.cells[tile]!;
  const tx = (tile % store.tilesPerSide) * TILE_SIZE;
  const ty = Math.floor(tile / store.tilesPerSide) * TILE_SIZE;
  const ox = options.atOrigin ? 0 : tx / factor;
  const oy = options.atOrigin ? 0 : ty / factor;
  const block = factor * factor;
  const pixels = TILE_SIZE / factor;
  // A tile whose cells never arrived, drawn from the CDN's overview instead (ADR 0009).
  const overview = store.isHeld(tile) ? null : store.overview;
  if (overview) {
    drawFromOverview(overview, tx, ty, factor, open, boost, out, stride, ox, oy);
    return;
  }
  for (let py = 0; py < pixels; py++) {
    for (let px = 0; px < pixels; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let filled = 0;
      let openCells = 0;
      for (let dy = 0; dy < factor; dy++) {
        const ly = py * factor + dy;
        const y = ty + ly;
        for (let dx = 0; dx < factor; dx++) {
          const lx = px * factor + dx;
          const x = tx + lx;
          if (x >= open.x && y >= open.y && x < open.x + open.w && y < open.y + open.h) {
            openCells++;
          }
          const cell = cells[ly * TILE_SIZE + lx]!;
          if (!isFilled(cell)) continue;
          const c = COLORS[colorOf(cell)]!;
          r += c[0];
          g += c[1];
          b += c[2];
          filled++;
        }
      }
      // Background is white where most of the block is open, grey where it is closed.
      const bg = openCells * 2 >= block ? EMPTY : CLOSED;
      // Coverage is boosted so a lone brick still shows up at minimap scale.
      const cover = Math.min(1, (boost * filled) / block);
      const at = ((oy + py) * stride + (ox + px)) * 4;
      // Rounded: a Uint8Array truncates where a Uint8ClampedArray rounds.
      const mix = (sum: number, base: number) =>
        Math.round(filled === 0 ? base : (sum / filled) * cover + base * (1 - cover));
      out[at] = mix(r, bg[0]);
      out[at + 1] = mix(g, bg[1]);
      out[at + 2] = mix(b, bg[2]);
      out[at + 3] = 255;
    }
  }
}

/**
 * The same downsampling for one tile, from an overview (protocol/cdn): each overview pixel
 * stands for `overview.factor`² cells of one colour, `cover`/255 of them filled. An output
 * block takes every overview pixel it overlaps, weighted by the cells they share, so the
 * result matches what the cells would give as far as the overview can tell.
 */
function drawFromOverview(
  overview: Overview,
  tx: number,
  ty: number,
  factor: number,
  open: Rect,
  boost: number,
  out: Uint8ClampedArray | Uint8Array,
  stride: number,
  ox: number,
  oy: number,
): void {
  const of = overview.factor;
  const block = factor * factor;
  const pixels = TILE_SIZE / factor;
  const overlap = (a0: number, a1: number, b0: number, b1: number) =>
    Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  for (let py = 0; py < pixels; py++) {
    const y0 = ty + py * factor;
    for (let px = 0; px < pixels; px++) {
      const x0 = tx + px * factor;
      let r = 0;
      let g = 0;
      let b = 0;
      let filled = 0;
      for (let qy = Math.floor(y0 / of); qy * of < y0 + factor; qy++) {
        const h = overlap(y0, y0 + factor, qy * of, (qy + 1) * of);
        for (let qx = Math.floor(x0 / of); qx * of < x0 + factor; qx++) {
          const q = qy * overview.side + qx;
          const color = overview.colors[q]!;
          if (color === 0) continue;
          const w = overlap(x0, x0 + factor, qx * of, (qx + 1) * of) * h;
          const cells = (overview.cover[q]! / 255) * w;
          const c = COLORS[color - 1]!;
          r += c[0] * cells;
          g += c[1] * cells;
          b += c[2] * cells;
          filled += cells;
        }
      }
      const openCells =
        overlap(x0, x0 + factor, open.x, open.x + open.w) *
        overlap(y0, y0 + factor, open.y, open.y + open.h);
      const bg = openCells * 2 >= block ? EMPTY : CLOSED;
      const cover = Math.min(1, (boost * filled) / block);
      const at = ((oy + py) * stride + (ox + px)) * 4;
      const mix = (sum: number, base: number) =>
        Math.round(filled === 0 ? base : (sum / filled) * cover + base * (1 - cover));
      out[at] = mix(r, bg[0]);
      out[at + 1] = mix(g, bg[1]);
      out[at + 2] = mix(b, bg[2]);
      out[at + 3] = 255;
    }
  }
}
