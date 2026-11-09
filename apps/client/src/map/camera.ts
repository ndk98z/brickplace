import { TILE_SIZE } from '@brickplace/core';

/** What the viewport shows: the map point at its centre and the zoom in CSS px per cell. */
export interface Camera {
  readonly cx: number;
  readonly cy: number;
  readonly zoom: number;
}

/** Viewport size in CSS px. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A 2048² map fits a 512 px viewport (1024²: 256 px); one cell fills 64 px at the other end. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 64;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Keeps the centre on the map, so the player can never get lost off its edge. */
export function clampCamera(camera: Camera, mapSize: number): Camera {
  return {
    cx: Math.min(mapSize, Math.max(0, camera.cx)),
    cy: Math.min(mapSize, Math.max(0, camera.cy)),
    zoom: clampZoom(camera.zoom),
  };
}

export function screenToMap(camera: Camera, viewport: Viewport, screen: Point): Point {
  return {
    x: camera.cx + (screen.x - viewport.width / 2) / camera.zoom,
    y: camera.cy + (screen.y - viewport.height / 2) / camera.zoom,
  };
}

export function mapToScreen(camera: Camera, viewport: Viewport, map: Point): Point {
  return {
    x: (map.x - camera.cx) * camera.zoom + viewport.width / 2,
    y: (map.y - camera.cy) * camera.zoom + viewport.height / 2,
  };
}

/** The integer cell under a screen point, or null off the map. */
export function cellAt(
  camera: Camera,
  viewport: Viewport,
  screen: Point,
  mapSize: number,
): Point | null {
  const m = screenToMap(camera, viewport, screen);
  const x = Math.floor(m.x);
  const y = Math.floor(m.y);
  if (x < 0 || y < 0 || x >= mapSize || y >= mapSize) return null;
  return { x, y };
}

/** Moves the camera by a screen-space drag (the map follows the pointer). */
export function panBy(camera: Camera, dx: number, dy: number, mapSize: number): Camera {
  return clampCamera(
    { cx: camera.cx - dx / camera.zoom, cy: camera.cy - dy / camera.zoom, zoom: camera.zoom },
    mapSize,
  );
}

/** Zooms so the map point under `anchor` (screen px) stays under it. */
export function zoomAround(
  camera: Camera,
  viewport: Viewport,
  anchor: Point,
  zoom: number,
  mapSize: number,
): Camera {
  const next = clampZoom(zoom);
  const m = screenToMap(camera, viewport, anchor);
  return clampCamera(
    {
      cx: m.x - (anchor.x - viewport.width / 2) / next,
      cy: m.y - (anchor.y - viewport.height / 2) / next,
      zoom: next,
    },
    mapSize,
  );
}

/** Centres a map rectangle and zooms so it fills the viewport, with `margin` of it to spare. */
export function fitRect(
  rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  viewport: Viewport,
  mapSize: number,
  margin = 0.05,
): Camera {
  const span = 1 + 2 * margin;
  const zoom = Math.min(viewport.width / (rect.w * span), viewport.height / (rect.h * span));
  return clampCamera({ cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, zoom }, mapSize);
}

/** The map rectangle the viewport covers, in cells (not clamped to the map). */
export function visibleRect(
  camera: Camera,
  viewport: Viewport,
): { x0: number; y0: number; x1: number; y1: number } {
  const halfW = viewport.width / 2 / camera.zoom;
  const halfH = viewport.height / 2 / camera.zoom;
  return {
    x0: camera.cx - halfW,
    y0: camera.cy - halfH,
    x1: camera.cx + halfW,
    y1: camera.cy + halfH,
  };
}

/**
 * The whole cells the viewport shows, clamped to the map: what a playing page tells the
 * server it looks at (the view frame, ADR 0026; its tiles plus a margin with ADR 0028).
 */
export function visibleCells(
  camera: Camera,
  viewport: Viewport,
  mapSize: number,
): { x: number; y: number; w: number; h: number } {
  const r = visibleRect(camera, viewport);
  const x = Math.min(mapSize, Math.max(0, Math.floor(r.x0)));
  const y = Math.min(mapSize, Math.max(0, Math.floor(r.y0)));
  const x1 = Math.min(mapSize, Math.max(x, Math.ceil(r.x1)));
  const y1 = Math.min(mapSize, Math.max(y, Math.ceil(r.y1)));
  return { x, y, w: x1 - x, h: y1 - y };
}

/** Indices (row-major) of the tiles that intersect the viewport. */
export function visibleTiles(camera: Camera, viewport: Viewport, mapSize: number): number[] {
  const tilesPerSide = mapSize / TILE_SIZE;
  const r = visibleRect(camera, viewport);
  const tx0 = Math.max(0, Math.floor(r.x0 / TILE_SIZE));
  const ty0 = Math.max(0, Math.floor(r.y0 / TILE_SIZE));
  const tx1 = Math.min(tilesPerSide - 1, Math.floor(r.x1 / TILE_SIZE));
  const ty1 = Math.min(tilesPerSide - 1, Math.floor(r.y1 / TILE_SIZE));
  const out: number[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) out.push(ty * tilesPerSide + tx);
  }
  return out;
}

/**
 * One frame of an eased zoom: moves `current` toward `target` in log space with time
 * constant `tau` ms, and snaps once the gap is invisible. Frame-rate independent.
 */
export function stepZoom(current: number, target: number, dtMs: number, tau = 90): number {
  const gap = Math.log(target / current);
  if (Math.abs(gap) < 0.002) return target;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
  return current * Math.exp(gap * k);
}

export type WheelIntent =
  | { readonly kind: 'zoom'; readonly factor: number; readonly smooth: boolean }
  | { readonly kind: 'pan'; readonly dx: number; readonly dy: number };

export interface WheelLike {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

const LINE_PX = 16;
/** One wheel notch zooms by this much at least: three notches double the zoom. */
export const NOTCH_ZOOM = 2 ** (1 / 3);
/**
 * A wheel event this long (ms) after the previous one starts a new scroll. Trackpads send
 * an event per frame (~16 ms) while a finger moves; a mouse notch comes alone.
 */
export const WHEEL_GAP_MS = 50;

/**
 * Maps a wheel event to zoom or pan, as on a map: scrolling zooms, dragging pans. Trackpad
 * pinches arrive as ctrl+wheel and zoom at once. A mouse wheel and a two-finger trackpad
 * scroll zoom eased; deltas vary widely between devices (macOS sends a slow notch as a few
 * pixels), so the first event after a pause (`gapMs`) zooms by at least a notch. A sideways
 * trackpad swipe or shift+wheel pans.
 */
export function classifyWheel(event: WheelLike, gapMs: number): WheelIntent {
  const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? 400 : 1;
  const dx = event.deltaX * scale;
  const dy = event.deltaY * scale;
  if (event.ctrlKey || event.metaKey) {
    return { kind: 'zoom', factor: Math.exp(-dy * 0.01), smooth: false };
  }
  if (event.shiftKey) return { kind: 'pan', dx: -(dx || dy), dy: 0 };
  if (Math.abs(dx) > Math.abs(dy)) return { kind: 'pan', dx: -dx, dy: 0 };
  let factor = Math.exp(-dy * 0.0025);
  if (gapMs >= WHEEL_GAP_MS && dy !== 0 && Math.abs(Math.log(factor)) < Math.log(NOTCH_ZOOM)) {
    factor = dy < 0 ? NOTCH_ZOOM : 1 / NOTCH_ZOOM;
  }
  return { kind: 'zoom', factor, smooth: true };
}
