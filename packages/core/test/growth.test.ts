import { describe, expect, it } from 'vitest';
import {
  apply,
  checkGrowth,
  createState,
  DEFAULT_MAP_SIZE,
  DEFAULT_OPEN_EDGE,
  DEFAULT_OPEN_GROWTH,
  nextOpenArea,
  type Rect,
  type State,
  setOpenArea,
} from '../src/index.ts';

/** Fills `n` 2x2 squares of the open area with O bricks, row by row. */
function fillSquares(state: State, n: number): void {
  const { open } = state.config;
  const perRow = open.w / 2;
  for (let i = 0; i < n; i++) {
    const x = open.x + (i % perRow) * 2;
    const y = open.y + Math.floor(i / perRow) * 2;
    const result = apply(state, { kind: 'brick', x, y, shape: 1, rotation: 0, color: 3 });
    if (!result.ok) throw new Error(`square ${i} refused: ${result.reason}`);
  }
}

const growth = { atPercent: 70, step: 8 };
const state = (size: number, open: Rect) => createState({ size, open, maxShield: 2 });

describe('open-area growth', () => {
  it('grows exactly at the threshold, not a cell before', () => {
    // 16 x 20 = 320 cells; 70% is exactly 224 cells, 56 squares.
    const s = state(64, { x: 24, y: 22, w: 16, h: 20 });
    fillSquares(s, 55);
    expect(s.counters.filled).toBe(220);
    expect(nextOpenArea(s, growth)).toBeNull();
    // The 56th square, where fillSquares would put it.
    apply(s, { kind: 'brick', x: 38, y: 34, shape: 1, rotation: 0, color: 3 });
    expect(s.counters.filled).toBe(224);
    expect(nextOpenArea(s, growth)).toEqual({ x: 16, y: 14, w: 32, h: 36 });
  });

  it('clamps to the map, and stops once the whole map is open', () => {
    const edge = state(64, { x: 48, y: 0, w: 16, h: 16 });
    fillSquares(edge, 64);
    expect(nextOpenArea(edge, growth)).toEqual({ x: 40, y: 0, w: 24, h: 24 });
    const full = state(16, { x: 0, y: 0, w: 16, h: 16 });
    fillSquares(full, 64);
    expect(nextOpenArea(full, growth)).toBeNull();
  });

  it('opens the default map from the default start in whole steps: 512², 768², 1024²', () => {
    const { step } = DEFAULT_OPEN_GROWTH;
    // The centred start leaves the same margin on every side, a whole number of steps wide,
    // so the last growth reaches the map's edge exactly instead of being clamped (ADR 0027).
    expect(((DEFAULT_MAP_SIZE - DEFAULT_OPEN_EDGE) / 2) % step).toBe(0);
    const edges: number[] = [];
    for (let edge = DEFAULT_OPEN_EDGE; edge <= DEFAULT_MAP_SIZE; edge += 2 * step) {
      edges.push(edge);
    }
    expect(edges).toEqual([512, 768, 1024]);
  });

  it('only reads the state, and setOpenArea then takes the area it names', () => {
    const s = state(64, { x: 24, y: 24, w: 16, h: 16 });
    fillSquares(s, 64);
    const before = JSON.stringify(s.config);
    const next = nextOpenArea(s, growth)!;
    expect(JSON.stringify(s.config)).toBe(before);
    setOpenArea(s, next);
    expect(s.config.open).toEqual({ x: 16, y: 16, w: 32, h: 32 });
    // 256 of 1024 cells now: under the threshold again.
    expect(nextOpenArea(s, growth)).toBeNull();
  });

  it('defaults to 70% and 128 cells, and refuses settings it cannot use', () => {
    expect(DEFAULT_OPEN_GROWTH).toEqual({ atPercent: 70, step: 128 });
    expect(() => checkGrowth(DEFAULT_OPEN_GROWTH)).not.toThrow();
    for (const bad of [
      { atPercent: 0, step: 8 },
      { atPercent: 101, step: 8 },
      { atPercent: 70.5, step: 8 },
      { atPercent: 70, step: 0 },
      { atPercent: 70, step: 1.5 },
    ]) {
      expect(() => checkGrowth(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});
