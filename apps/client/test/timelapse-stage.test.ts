import { describe, expect, it } from 'vitest';
import {
  closedParts,
  crispScale,
  fitStage,
  frameForKey,
  keyAction,
  playsOverviews,
  relayoutPlan,
  scaledRect,
  viewBounds,
} from '../src/timelapse/stage.ts';

// The timelapse stage (ADR 0021): it shows the open area, not the whole mostly-closed map,
// fitted to the page with whole device pixels per cell when that costs little.

const frame = (x: number, y: number, w: number, h: number) => ({ open: { x, y, w, h } });

describe('timelapse stage bounds', () => {
  it('shows the open area joined over every frame, not the whole map', () => {
    // The open area grows from 256² to 512², centred on a 1024² map.
    const frames = [frame(384, 384, 256, 256), frame(256, 256, 512, 512)];
    expect(viewBounds(frames, 1024)).toEqual({ x: 256, y: 256, w: 512, h: 512 });
    expect(viewBounds(frames.slice(0, 1), 1024)).toEqual({ x: 384, y: 384, w: 256, h: 256 });
  });

  it('widens to whole overview blocks and clamps to the map', () => {
    expect(viewBounds([frame(5, 7, 10, 10)], 64, 4)).toEqual({ x: 4, y: 4, w: 12, h: 16 });
    expect(viewBounds([frame(-10, 60, 20, 20)], 64)).toEqual({ x: 0, y: 60, w: 10, h: 4 });
  });

  it('falls back to the whole map without a usable open area', () => {
    expect(viewBounds([], 1024)).toEqual({ x: 0, y: 0, w: 1024, h: 1024 });
    expect(viewBounds([frame(10, 10, 0, 0)], 1024)).toEqual({ x: 0, y: 0, w: 1024, h: 1024 });
  });

  it('maps bounds into an overview image', () => {
    expect(scaledRect({ x: 256, y: 256, w: 512, h: 512 }, 2)).toEqual({
      x: 128,
      y: 128,
      w: 256,
      h: 256,
    });
    // Unaligned bounds round outward, never cutting a pixel.
    expect(scaledRect({ x: 3, y: 0, w: 2, h: 4 }, 4)).toEqual({ x: 0, y: 0, w: 2, h: 1 });
  });

  it('shades only what was not open yet at a frame', () => {
    const bounds = { x: 0, y: 0, w: 10, h: 10 };
    expect(closedParts(bounds, bounds)).toEqual([]);
    expect(closedParts(bounds, { x: 2, y: 3, w: 4, h: 5 })).toEqual([
      { x: 0, y: 0, w: 10, h: 3 },
      { x: 0, y: 8, w: 10, h: 2 },
      { x: 0, y: 3, w: 2, h: 5 },
      { x: 6, y: 3, w: 4, h: 5 },
    ]);
    // Nothing open inside the bounds: all of it is closed.
    expect(closedParts(bounds, { x: 20, y: 20, w: 5, h: 5 })).toEqual([bounds]);
    // Covered parts add up to the closed area exactly.
    const parts = closedParts(bounds, { x: 0, y: 4, w: 7, h: 6 });
    expect(parts.reduce((sum, p) => sum + p.w * p.h, 0)).toBe(100 - 42);
  });
});

describe('timelapse stage fit', () => {
  it('rounds down to whole pixels a cell only when that costs little', () => {
    expect(crispScale(3.1)).toBe(3);
    expect(crispScale(1.17)).toBe(1);
    // 1 of 1.4 would lose 29%: the exact fit stays.
    expect(crispScale(1.4)).toBe(1.4);
    expect(crispScale(0.6)).toBe(0.6);
    expect(crispScale(0)).toBe(0);
    expect(crispScale(Number.NaN)).toBe(0);
  });

  it('fits the open area to the box, keeping its aspect', () => {
    const square = { x: 384, y: 384, w: 256, h: 256 };
    // 880 × 600 CSS px at 1x: 600 / 256 = 2.34 → 2 px a cell, 512 px square.
    expect(fitStage(square, { width: 880, height: 600 }, 1)).toEqual({
      width: 512,
      height: 512,
      scale: 2,
    });
    // At 2x the same box gives 4.69 device px a cell, rounded to 4: the same 512 CSS px.
    expect(fitStage(square, { width: 880, height: 600 }, 2)).toEqual({
      width: 512,
      height: 512,
      scale: 4,
    });
    // A wide area in a phone column is bounded by the width.
    const wide = { x: 0, y: 0, w: 512, h: 256 };
    const phone = fitStage(wide, { width: 330, height: 400 }, 3);
    expect(phone.width).toBeLessThanOrEqual(330);
    expect(phone.height).toBeCloseTo(phone.width / 2);
  });

  it('never shows a whole 1024² map as a dot: one open tile fills the stage', () => {
    const tile = viewBounds([frame(384, 384, 256, 256)], 1024);
    const fit = fitStage(tile, { width: 860, height: 700 }, 1);
    expect(fit.width).toBeGreaterThan(500);
  });

  it('plays overviews only at two device pixels an overview pixel or fewer', () => {
    expect(playsOverviews(1, 2)).toBe(true);
    expect(playsOverviews(2, 2)).toBe(false);
    expect(playsOverviews(0.5, 4)).toBe(true);
    expect(playsOverviews(0.5, null)).toBe(false);
  });
});

describe('timelapse resize', () => {
  it('refits while the mode holds, rebuilds at the same frame when it flips', () => {
    const player = { small: true, current: 7, frames: 12 };
    expect(relayoutPlan(player, true)).toEqual({ kind: 'refit' });
    expect(relayoutPlan(player, false)).toEqual({ kind: 'rebuild', frame: 7 });
  });

  it('rebuilds at the latest frame when none is shown yet', () => {
    // A resize while the first frame (the latest) is still loading.
    expect(relayoutPlan({ small: false, current: -1, frames: 12 }, true)).toEqual({
      kind: 'rebuild',
      frame: 11,
    });
  });
});

describe('timelapse key actions', () => {
  it('leaves Space to the page with a single frame: nothing to play, nothing prevented', () => {
    expect(keyAction(' ', 'page', false, 0, 1)).toBeNull();
    expect(keyAction('k', 'page', false, 0, 1)).toBeNull();
    expect(keyAction('ArrowRight', 'page', false, 0, 1)).toBeNull();
  });

  it('toggles on Space from the page, but not over a control or in a field', () => {
    expect(keyAction(' ', 'page', true, 3, 12)).toEqual({ kind: 'toggle' });
    expect(keyAction('k', 'page', true, 3, 12)).toEqual({ kind: 'toggle' });
    // A focused button or link: Space presses it.
    expect(keyAction(' ', 'control', true, 3, 12)).toBeNull();
    expect(keyAction(' ', 'field', true, 3, 12)).toBeNull();
  });

  it('steps and jumps from the page or a control, never from a field', () => {
    expect(keyAction('ArrowLeft', 'page', true, 3, 12)).toEqual({ kind: 'show', frame: 2 });
    expect(keyAction('End', 'control', true, 3, 12)).toEqual({ kind: 'show', frame: 11 });
    // The slider and the speed radios are fields: their arrows are their own.
    expect(keyAction('ArrowRight', 'field', true, 3, 12)).toBeNull();
    expect(keyAction('x', 'page', true, 3, 12)).toBeNull();
  });
});

describe('timelapse keys', () => {
  it('steps and jumps within the frames', () => {
    expect(frameForKey('ArrowRight', 0, 5)).toBe(1);
    expect(frameForKey('ArrowRight', 4, 5)).toBe(4);
    expect(frameForKey('ArrowLeft', 0, 5)).toBe(0);
    expect(frameForKey('Home', 3, 5)).toBe(0);
    expect(frameForKey('End', 0, 5)).toBe(4);
    expect(frameForKey('x', 0, 5)).toBeNull();
    expect(frameForKey('End', 0, 0)).toBeNull();
  });
});
