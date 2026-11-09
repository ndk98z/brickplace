// Where the timelapse page draws the map and how big (ADR 0021). The map is mostly closed
// early in a season (ADR 0013): drawing all of it shrinks the open area to a dot, so the stage
// shows the open area only, as large as the page allows, with whole device pixels per cell
// when that costs little. Pure, so tests cover it without a browser.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * A map shown with at most this many device pixels per overview pixel plays the frames'
 * overviews (ADR 0009, 0021): one object a frame instead of every changed tile, at no visible
 * loss.
 */
export const SMALL_PX_PER_PIXEL = 2;

/**
 * Rounding down to whole device pixels per cell keeps every cell the same size, but it may not
 * shrink the map by more than this share; below it the exact fit wins.
 */
export const MAX_CRISP_LOSS = 0.15;

/**
 * The part of the map the timelapse shows: every frame's open area joined (open areas only
 * grow, so in practice the last frame's), widened to whole blocks of `align` cells (the
 * overview factor, so an overview pixel is never cut) and clamped to the map. The whole map
 * when there is no frame or no usable open area.
 */
export function viewBounds(
  frames: readonly { readonly open: Rect }[],
  size: number,
  align = 1,
): Rect {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const { open } of frames) {
    if (!(open.w > 0 && open.h > 0)) continue;
    x0 = Math.min(x0, open.x);
    y0 = Math.min(y0, open.y);
    x1 = Math.max(x1, open.x + open.w);
    y1 = Math.max(y1, open.y + open.h);
  }
  const step = Math.max(1, Math.floor(align));
  x0 = Math.max(0, Math.floor(x0 / step) * step);
  y0 = Math.max(0, Math.floor(y0 / step) * step);
  x1 = Math.min(size, Math.ceil(x1 / step) * step);
  y1 = Math.min(size, Math.ceil(y1 / step) * step);
  if (!(x1 > x0 && y1 > y0)) return { x: 0, y: 0, w: size, h: size };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Device pixels per cell for a raw fit: whole when rounding down loses at most
 * MAX_CRISP_LOSS of the size (every cell drawn the same size), the raw fit otherwise (below one
 * pixel a cell, or when a whole number would shrink the map too much).
 */
export function crispScale(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  if (raw < 1) return raw;
  const whole = Math.floor(raw);
  return whole / raw >= 1 - MAX_CRISP_LOSS ? whole : raw;
}

export interface StageFit {
  /** CSS pixels of the drawn map. */
  readonly width: number;
  readonly height: number;
  /** Device pixels per map cell. */
  readonly scale: number;
}

/** The largest size `bounds` (in cells) fits in `box` (CSS pixels) at device ratio `dpr`. */
export function fitStage(
  bounds: Rect,
  box: { readonly width: number; readonly height: number },
  dpr: number,
): StageFit {
  const ratio = dpr > 0 ? dpr : 1;
  const raw = Math.min(box.width / bounds.w, box.height / bounds.h) * ratio;
  const scale = crispScale(raw);
  return { width: (bounds.w * scale) / ratio, height: (bounds.h * scale) / ratio, scale };
}

/**
 * Whether a stage drawn at `scale` device pixels a cell plays overviews of `factor` cells a
 * pixel instead of tiles (null: the frames have none).
 */
export function playsOverviews(scale: number, factor: number | null): boolean {
  return factor !== null && scale * factor <= SMALL_PX_PER_PIXEL;
}

/** `bounds` in an image of `factor` cells a pixel (bounds are aligned to it by viewBounds). */
export function scaledRect(bounds: Rect, factor: number): Rect {
  const x = Math.floor(bounds.x / factor);
  const y = Math.floor(bounds.y / factor);
  return {
    x,
    y,
    w: Math.ceil((bounds.x + bounds.w) / factor) - x,
    h: Math.ceil((bounds.y + bounds.h) / factor) - y,
  };
}

/**
 * What a resize does to the player: refit the canvas when the mode (overviews or tiles) holds,
 * or rebuild it in the other mode at the frame it shows (the latest when none is shown yet,
 * which is the frame a fresh open shows first).
 */
export function relayoutPlan(
  player: { readonly small: boolean; readonly current: number; readonly frames: number },
  small: boolean,
): { readonly kind: 'refit' } | { readonly kind: 'rebuild'; readonly frame: number } {
  if (small === player.small) return { kind: 'refit' };
  const frame = player.current >= 0 ? player.current : player.frames - 1;
  return { kind: 'rebuild', frame };
}

/**
 * The parts of `bounds` outside `open` (the area not open yet at a frame), as at most four
 * rectangles: full-width bands above and below, then the sides between them.
 */
export function closedParts(bounds: Rect, open: Rect): Rect[] {
  const x0 = Math.max(bounds.x, Math.min(open.x, bounds.x + bounds.w));
  const y0 = Math.max(bounds.y, Math.min(open.y, bounds.y + bounds.h));
  const x1 = Math.min(bounds.x + bounds.w, Math.max(open.x + open.w, x0));
  const y1 = Math.min(bounds.y + bounds.h, Math.max(open.y + open.h, y0));
  if (x1 <= x0 || y1 <= y0) return [bounds];
  const parts = [
    { x: bounds.x, y: bounds.y, w: bounds.w, h: y0 - bounds.y },
    { x: bounds.x, y: y1, w: bounds.w, h: bounds.y + bounds.h - y1 },
    { x: bounds.x, y: y0, w: x0 - bounds.x, h: y1 - y0 },
    { x: x1, y: y0, w: bounds.x + bounds.w - x1, h: y1 - y0 },
  ];
  return parts.filter((part) => part.w > 0 && part.h > 0);
}

/**
 * What a key pressed on the timelapse page does, or null when the page leaves it alone (no
 * preventDefault: the browser's own handling stays, such as Space scrolling). `focus` is where
 * the key landed: a field (input, select, textarea: the key is theirs), a control (button or
 * link: Space presses it) or the page. `playable`: there are frames to play (two or more).
 */
export function keyAction(
  key: string,
  focus: 'field' | 'control' | 'page',
  playable: boolean,
  shown: number,
  frames: number,
): { readonly kind: 'toggle' } | { readonly kind: 'show'; readonly frame: number } | null {
  if (focus === 'field' || !playable) return null;
  if (key === ' ' || key === 'k') return focus === 'control' ? null : { kind: 'toggle' };
  const frame = frameForKey(key, shown, frames);
  return frame === null ? null : { kind: 'show', frame };
}

/** The frame a key moves to from `shown` of `frames`, or null for a key the stage ignores. */
export function frameForKey(key: string, shown: number, frames: number): number | null {
  if (frames <= 0) return null;
  const last = frames - 1;
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, shown - 1);
    case 'ArrowRight':
      return Math.min(last, shown + 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}
