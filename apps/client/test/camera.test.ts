import { describe, expect, it } from 'vitest';
import {
  cellAt,
  clampCamera,
  classifyWheel,
  fitRect,
  MAX_ZOOM,
  MIN_ZOOM,
  mapToScreen,
  NOTCH_ZOOM,
  panBy,
  screenToMap,
  stepZoom,
  visibleTiles,
  zoomAround,
} from '../src/map/camera.ts';

const viewport = { width: 800, height: 600 };
const camera = { cx: 1024, cy: 1024, zoom: 4 };

describe('coordinate transforms', () => {
  it('maps the viewport centre to the camera centre', () => {
    expect(screenToMap(camera, viewport, { x: 400, y: 300 })).toEqual({ x: 1024, y: 1024 });
  });

  it('screenToMap and mapToScreen are inverses', () => {
    const p = { x: 123.5, y: 456.25 };
    const back = mapToScreen(camera, viewport, screenToMap(camera, viewport, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('finds the cell under a point and null off the map', () => {
    expect(cellAt(camera, viewport, { x: 401, y: 299 }, 2048)).toEqual({ x: 1024, y: 1023 });
    const corner = { cx: 0, cy: 0, zoom: 4 };
    expect(cellAt(corner, viewport, { x: 0, y: 0 }, 2048)).toBeNull();
  });

  it('panning moves the map with the pointer', () => {
    const moved = panBy(camera, 40, -20, 2048);
    expect(moved).toEqual({ cx: 1014, cy: 1029, zoom: 4 });
  });

  it('keeps the centre on the map and the zoom in range', () => {
    expect(clampCamera({ cx: -5, cy: 5000, zoom: 1000 }, 2048)).toEqual({
      cx: 0,
      cy: 2048,
      zoom: MAX_ZOOM,
    });
    expect(clampCamera({ cx: 1, cy: 1, zoom: 0 }, 2048).zoom).toBe(MIN_ZOOM);
  });

  it('zooming keeps the map point under the anchor fixed', () => {
    const anchor = { x: 650, y: 120 };
    const before = screenToMap(camera, viewport, anchor);
    const zoomed = zoomAround(camera, viewport, anchor, 16, 2048);
    const after = screenToMap(zoomed, viewport, anchor);
    expect(zoomed.zoom).toBe(16);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe('visible tiles', () => {
  it('lists only the tiles the viewport touches', () => {
    // 800 x 600 px at 4 px per cell = 200 x 150 cells around (1024, 1024): tiles 3..4 both ways.
    expect(visibleTiles(camera, viewport, 2048)).toEqual([27, 28, 35, 36]);
  });

  it('clamps to the map when zoomed far out', () => {
    expect(visibleTiles({ cx: 1024, cy: 1024, zoom: 0.25 }, viewport, 2048)).toHaveLength(64);
  });
});

describe('eased zoom', () => {
  it('approaches the target and then snaps to it', () => {
    let z = 4;
    for (let i = 0; i < 5; i++) z = stepZoom(z, 8, 16);
    expect(z).toBeGreaterThan(4);
    expect(z).toBeLessThan(8);
    for (let i = 0; i < 200; i++) z = stepZoom(z, 8, 16);
    expect(z).toBe(8);
  });

  it('is frame-rate independent', () => {
    let fast = 4;
    for (let i = 0; i < 4; i++) fast = stepZoom(fast, 16, 8);
    const slow = stepZoom(4, 16, 32);
    expect(fast).toBeCloseTo(slow, 9);
  });
});

describe('fitting the open area', () => {
  it('centres the area and fits its longer side with a margin', () => {
    const open = { x: 256, y: 256, w: 512, h: 512 };
    const wide = fitRect(open, { width: 1600, height: 900 }, 1024);
    expect(wide.cx).toBe(512);
    expect(wide.cy).toBe(512);
    expect(wide.zoom).toBeCloseTo(900 / (512 * 1.1), 9);
    expect(fitRect(open, { width: 390, height: 800 }, 1024).zoom).toBeCloseTo(390 / 563.2, 9);
  });

  it('keeps the zoom within its limits', () => {
    expect(fitRect({ x: 0, y: 0, w: 1, h: 1 }, { width: 4000, height: 4000 }, 1024).zoom).toBe(
      MAX_ZOOM,
    );
    expect(fitRect({ x: 0, y: 0, w: 1024, h: 1024 }, { width: 50, height: 50 }, 1024).zoom).toBe(
      MIN_ZOOM,
    );
  });
});

describe('wheel input', () => {
  const wheel = {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };
  const PAUSE = 1_000;
  const factorOf = (intent: ReturnType<typeof classifyWheel>) =>
    intent.kind === 'zoom' ? intent.factor : Number.NaN;

  it('treats ctrl+wheel (trackpad pinch) as immediate zoom', () => {
    const intent = classifyWheel({ ...wheel, deltaY: -10, ctrlKey: true }, PAUSE);
    expect(intent.kind).toBe('zoom');
    if (intent.kind === 'zoom') {
      expect(intent.factor).toBeGreaterThan(1);
      expect(intent.smooth).toBe(false);
    }
  });

  it('zooms a full notch on a slow notch, however small its delta (macOS sends a few px)', () => {
    for (const deltaY of [4, 4.000244140625, 1, 30]) {
      expect(classifyWheel({ ...wheel, deltaY }, PAUSE)).toMatchObject({
        kind: 'zoom',
        smooth: true,
      });
      expect(factorOf(classifyWheel({ ...wheel, deltaY }, PAUSE))).toBeCloseTo(1 / NOTCH_ZOOM, 9);
      expect(factorOf(classifyWheel({ ...wheel, deltaY: -deltaY }, PAUSE))).toBeCloseTo(
        NOTCH_ZOOM,
        9,
      );
    }
    expect(factorOf(classifyWheel({ ...wheel, deltaY: 3, deltaMode: 1 }, PAUSE))).toBeLessThan(
      1 / NOTCH_ZOOM + 1e-9,
    );
  });

  it('zooms in proportion within a scroll, and by more than a notch for a big delta', () => {
    // A trackpad's stream of small deltas: no notch jump on each frame.
    const small = factorOf(classifyWheel({ ...wheel, deltaY: 4 }, 16));
    expect(small).toBeCloseTo(Math.exp(-4 * 0.0025), 9);
    expect(factorOf(classifyWheel({ ...wheel, deltaY: -400 }, PAUSE))).toBeGreaterThan(NOTCH_ZOOM);
  });

  it('pans on a sideways swipe or shift+wheel', () => {
    expect(classifyWheel({ ...wheel, deltaX: 9.5, deltaY: -2 }, 16)).toEqual({
      kind: 'pan',
      dx: -9.5,
      dy: 0,
    });
    expect(classifyWheel({ ...wheel, deltaY: 40, shiftKey: true }, PAUSE)).toEqual({
      kind: 'pan',
      dx: -40,
      dy: 0,
    });
  });
});
