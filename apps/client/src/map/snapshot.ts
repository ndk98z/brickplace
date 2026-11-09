import { colorOf, isFilled, LINK_DOWN, LINK_RIGHT, type Rect } from '@brickplace/core';
import { hexToRgb, PALETTE } from '../palette.ts';
import { type Camera, type Viewport, visibleRect } from './camera.ts';
import type { MapStore } from './store.ts';

// The share image (Share design): the cells of an area of the client's own map store, drawn in
// the browser. Nothing is rendered on a server. Pure, so tests can check the pixels.

/** The longest side of a snapshot, in pixels. */
export const MAX_SNAPSHOT_PX = 2048;
/** The most pixels a cell gets; small areas are scaled up to this. */
export const MAX_CELL_PX = 8;

/** An empty cell: white, as in the design's previews. */
const EMPTY = hexToRgb('#FFFFFF');
/** Brick edges between cells of different bricks, at 4 px per cell and up. */
const SEAM = 0.78;
/** The BrickPlace mark: the logo's four squares, in its order. */
const MARK = ['#FF6B3D', '#3D7BFF', '#FFD23F', '#2BB673'].map(hexToRgb);

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major; an ArrayBuffer of its own, so ImageData can take it without a copy. */
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

/** The cells a camera shows, cut to the map; at least one cell. */
export function areaInView(camera: Camera, viewport: Viewport, mapSize: number): Rect {
  const r = visibleRect(camera, viewport);
  const x0 = Math.min(mapSize - 1, Math.max(0, Math.floor(r.x0)));
  const y0 = Math.min(mapSize - 1, Math.max(0, Math.floor(r.y0)));
  const x1 = Math.max(x0 + 1, Math.min(mapSize, Math.ceil(r.x1)));
  const y1 = Math.max(y0 + 1, Math.min(mapSize, Math.ceil(r.y1)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A point on a snapshot, in image pixels from its top-left corner. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The fewest cells a drag selection keeps on each side: a click or a slip selects nothing. */
export const MIN_SELECTION_CELLS = 4;
/**
 * The least a drag moves on each axis, in CSS px, to select: zoomed far out a cell is smaller
 * than a screen pixel, so a few cells alone would let a wobbling tap select.
 */
export const MIN_DRAG_PX = 8;

/** Whether a pointer moved far enough on both axes (client px) for a drag to select. */
export function dragSelects(start: Point, end: Point): boolean {
  return Math.abs(end.x - start.x) >= MIN_DRAG_PX && Math.abs(end.y - start.y) >= MIN_DRAG_PX;
}

/**
 * Where a pointer (client px) is on a snapshot drawn into a canvas of `canvas` size and shown
 * in `box` (its client rect), in image pixels, held to the image: a point on the caption band
 * under it lands on the last row.
 */
export function pointOnImage(
  pointer: Point,
  box: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  canvas: { readonly width: number; readonly height: number },
  image: { readonly width: number; readonly height: number },
): Point {
  const x = ((pointer.x - box.left) * canvas.width) / Math.max(1, box.width);
  const y = ((pointer.y - box.top) * canvas.height) / Math.max(1, box.height);
  return {
    x: Math.min(image.width - 1, Math.max(0, x)),
    y: Math.min(image.height - 1, Math.max(0, y)),
  };
}

/**
 * The cells of `area` a drag across its snapshot covers, from one point to another (either
 * corner first, `scale` pixels per cell), cut to the area; at least one cell.
 */
export function cellSpan(area: Rect, scale: number, from: Point, to: Point): Rect {
  const cell = (px: number, side: number) =>
    Math.min(side - 1, Math.max(0, Math.floor(px / scale)));
  const x0 = cell(Math.min(from.x, to.x), area.w);
  const y0 = cell(Math.min(from.y, to.y), area.h);
  const x1 = cell(Math.max(from.x, to.x), area.w) + 1;
  const y1 = cell(Math.max(from.y, to.y), area.h) + 1;
  return { x: area.x + x0, y: area.y + y0, w: x1 - x0, h: y1 - y0 };
}

/** The part of `area` a drag selects, or null when it spans too few cells to keep. */
export function selectedArea(area: Rect, scale: number, from: Point, to: Point): Rect | null {
  const span = cellSpan(area, scale, from, to);
  return span.w >= MIN_SELECTION_CELLS && span.h >= MIN_SELECTION_CELLS ? span : null;
}

/** Pixels per cell for an area: as large as fits MAX_SNAPSHOT_PX, from 1 to MAX_CELL_PX. */
export function snapshotScale(area: Rect): number {
  const side = Math.max(area.w, area.h, 1);
  return Math.max(1, Math.min(MAX_CELL_PX, Math.floor(MAX_SNAPSHOT_PX / side)));
}

/**
 * Draws an area of the map, `scale` pixels per cell, with the BrickPlace mark in the bottom
 * right corner. Cells of different bricks get a darker seam once a cell is 4 px or more.
 */
export function renderSnapshot(store: MapStore, area: Rect, scale: number): Pixels {
  const width = area.w * scale;
  const height = area.h * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  const colors = PALETTE.map(hexToRgb);
  const seams = scale >= 4;
  for (let cy = 0; cy < area.h; cy++) {
    for (let cx = 0; cx < area.w; cx++) {
      const cell = store.cell(area.x + cx, area.y + cy);
      const filled = isFilled(cell);
      const rgb = filled ? colors[colorOf(cell)]! : EMPTY;
      const seamRight = seams && filled && (cell & LINK_RIGHT) === 0;
      const seamDown = seams && filled && (cell & LINK_DOWN) === 0;
      for (let py = 0; py < scale; py++) {
        let at = ((cy * scale + py) * width + cx * scale) * 4;
        for (let px = 0; px < scale; px++, at += 4) {
          const edge = (seamRight && px === scale - 1) || (seamDown && py === scale - 1);
          const k = edge ? SEAM : 1;
          data[at] = rgb[0] * k;
          data[at + 1] = rgb[1] * k;
          data[at + 2] = rgb[2] * k;
          data[at + 3] = 255;
        }
      }
    }
  }
  drawMark({ width, height, data });
  return { width, height, data };
}

/** Where the mark goes: its square size, gap and top-left corner; null when it does not fit. */
export function markLayout(
  width: number,
  height: number,
): { size: number; gap: number; x: number; y: number } | null {
  const side = Math.min(width, height);
  const size = Math.max(3, Math.round(side / 48));
  const gap = Math.max(1, Math.round(size / 4));
  const margin = size;
  const box = 2 * size + gap;
  if (box + 2 * margin > side) return null;
  return { size, gap, x: width - margin - box, y: height - margin - box };
}

/** The logo's four squares, bottom right, on a white plate one gap wide. */
function drawMark(image: Pixels): void {
  const layout = markLayout(image.width, image.height);
  if (!layout) return;
  const { size, gap, x, y } = layout;
  const box = 2 * size + gap;
  fill(image, x - gap, y - gap, box + 2 * gap, box + 2 * gap, [255, 255, 255]);
  MARK.forEach((rgb, i) => {
    fill(image, x + (i % 2) * (size + gap), y + Math.floor(i / 2) * (size + gap), size, size, rgb);
  });
}

function fill(
  image: Pixels,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: readonly number[],
): void {
  for (let py = Math.max(0, y); py < Math.min(image.height, y + h); py++) {
    for (let px = Math.max(0, x); px < Math.min(image.width, x + w); px++) {
      const at = (py * image.width + px) * 4;
      image.data[at] = rgb[0]!;
      image.data[at + 1] = rgb[1]!;
      image.data[at + 2] = rgb[2]!;
      image.data[at + 3] = 255;
    }
  }
}

/** The caption band under the image: its height and font size, from the image's width. */
export function captionLayout(width: number): { height: number; font: number; pad: number } {
  const height = Math.max(28, Math.min(72, Math.round(width / 24)));
  return { height, font: Math.round(height * 0.42), pad: Math.round(height * 0.4) };
}
