import {
  apply,
  canCover,
  createState,
  encodeCell,
  isFilled,
  type Rotation,
  type ShapeId,
  type State,
  TILE_SIZE,
} from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import { isSameOriginPath, parseSponsors } from '../src/config.ts';
import { HOLES_MIN_ZOOM, showHoles, useOverview } from '../src/gl/renderer.ts';
import { ghostFor, type Rules, shouldSend, type Tool } from '../src/map/ghost.ts';
import { HoleMasks, holeMask } from '../src/map/holes.ts';
import { drawMinimapTile } from '../src/map/minimap.ts';
import { MapStore } from '../src/map/store.ts';

const SIZE = 512;
const filled = encodeCell(1, false, false);
const fill = (store: MapStore, cells: readonly (readonly [number, number])[]) =>
  store.applyDiffs(cells.map(([x, y]) => ({ index: y * SIZE + x, cell: filled, shield: 0 })));

describe('shouldSend', () => {
  // The client's open area: the built-in default, which the server may have grown since.
  const rules: Rules = { open: { x: 100, y: 100, w: 50, h: 50 }, maxShield: 2 };
  const tools: Tool[] = [
    { kind: 'brick', shape: 1, rotation: 0, color: 3 },
    { kind: 'hammer' },
    { kind: 'shield' },
    { kind: 'single', color: 3 },
  ];

  it('sends an op outside the open area: that only warns', () => {
    const store = new MapStore(SIZE);
    // Filled cells for the hammer and shield, and a walled-in hole for the single brick.
    fill(store, [
      [20, 20],
      [21, 20],
      [20, 21],
      [21, 21],
    ]);
    for (const tool of tools) {
      const at = { brick: [40, 40], single: [300, 300] }[tool.kind as string] ?? [20, 20];
      if (tool.kind === 'single') {
        fill(store, [
          [299, 300],
          [301, 300],
          [300, 299],
          [300, 301],
        ]);
      }
      const ghost = ghostFor(tool, at[0]!, at[1]!, store, rules);
      expect(ghost.problem, tool.kind).toBe('out_of_area');
      expect(shouldSend(ghost), tool.kind).toBe(true);
    }
  });

  it('does not send what the local map already refuses', () => {
    const store = new MapStore(SIZE);
    fill(store, [[120, 120]]);
    const brick = ghostFor(tools[0]!, 120, 120, store, rules);
    expect(brick.problem).toBe('occupied');
    expect(shouldSend(brick)).toBe(false);
    expect(shouldSend(ghostFor({ kind: 'hammer' }, 130, 130, store, rules))).toBe(false);
    // Off the map: it could not even be encoded.
    expect(shouldSend(ghostFor(tools[0]!, SIZE - 1, 0, store, rules))).toBe(false);
    expect(shouldSend(ghostFor(tools[0]!, 125, 125, store, rules))).toBe(true);
  });
});

describe('sponsor logos', () => {
  it('accepts only absolute paths on this site', () => {
    expect(isSameOriginPath('/sponsors/acme.svg')).toBe(true);
    for (const bad of [
      'https://acme.example/logo.svg',
      '//acme.example/logo.svg',
      '/\\acme.example/logo.svg',
      'sponsors/acme.svg',
      'javascript:alert(1)',
      '/logo.svg?track=1',
      '',
      42,
    ]) {
      expect(isSameOriginPath(bad), String(bad)).toBe(false);
    }
  });

  it('drops a third-party logo but keeps the sponsor', () => {
    const list = [
      { name: 'A', href: 'https://a.example', logo: 'https://cdn.a.example/a.png' },
      { name: 'B', href: 'https://b.example', logo: '/sponsors/b.png' },
    ];
    expect(parseSponsors(JSON.stringify(list))).toEqual([
      { name: 'A', href: 'https://a.example' },
      { name: 'B', href: 'https://b.example', logo: '/sponsors/b.png' },
    ]);
  });
});

/** Holes of the open area by the core's own counters: empty cells no brick can cover. */
function coreHoles(state: State, open: Rules['open']): Set<number> {
  const holes = new Set<number>();
  for (let y = open.y; y < open.y + open.h; y++) {
    for (let x = open.x; x < open.x + open.w; x++) {
      if (!isFilled(state.cells[y * SIZE + x]!) && !canCover(state, x, y)) holes.add(y * SIZE + x);
    }
  }
  return holes;
}

describe('hole highlight', () => {
  const open = { x: 192, y: 192, w: 128, h: 128 };

  /** A busy map built by real core ops, mirrored into a store. */
  function busyMap(ops: number, seed: number) {
    const state = createState({ size: SIZE, open, maxShield: 2 });
    const store = new MapStore(SIZE);
    let s = seed;
    const next = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s >>> 8) % n;
    };
    for (let i = 0; i < ops; i++) {
      const result = apply(state, {
        kind: 'brick',
        x: open.x - 2 + next(open.w + 4),
        y: open.y - 2 + next(open.h + 4),
        shape: next(7) as ShapeId,
        rotation: next(4) as Rotation,
        color: next(32),
      });
      if (result.ok) store.applyDiffs(result.diffs);
    }
    return { state, store, next };
  }

  /** Every hole the masks of these tiles mark, as map indices. */
  function marked(store: MapStore, masks: Map<number, Uint8Array>): Set<number> {
    const out = new Set<number>();
    for (const [tile, mask] of masks) {
      const tx = (tile % store.tilesPerSide) * TILE_SIZE;
      const ty = Math.floor(tile / store.tilesPerSide) * TILE_SIZE;
      mask.forEach((v, i) => {
        if (v) out.add((ty + Math.floor(i / TILE_SIZE)) * SIZE + tx + (i % TILE_SIZE));
      });
    }
    return out;
  }

  it('marks exactly the cells the core would let a single brick fill', () => {
    const { state, store } = busyMap(12_000, 11);
    const masks = new Map<number, Uint8Array>();
    let total = 0;
    // The open area spans the four tiles around the map's centre.
    for (const tile of [0, 1, 2, 3]) {
      const mask = new Uint8Array(TILE_SIZE * TILE_SIZE);
      total += holeMask(store, open, tile, mask);
      masks.set(tile, mask);
    }
    const holes = [...marked(store, masks)];
    expect(total).toBe(holes.length);
    expect(total).toBeGreaterThan(0);
    for (const index of holes) {
      const x = index % SIZE;
      const y = Math.floor(index / SIZE);
      expect(isFilled(state.cells[index]!)).toBe(false);
      expect(canCover(state, x, y), `${x},${y}`).toBe(false);
    }
    expect(new Set(holes)).toEqual(coreHoles(state, open));
  });

  it('keeps masks right as cells change, also across tile edges', () => {
    const { state, store, next } = busyMap(12_000, 5);
    const masks = new HoleMasks(store, open);
    const tiles = [0, 1, 2, 3];
    const current = new Map(masks.update(tiles));
    expect(current.size).toBe(4);
    // Nothing changed: nothing to upload.
    expect(masks.update(tiles).size).toBe(0);
    for (let round = 0; round < 30; round++) {
      // Hammer and place around the tile edges at x = 256 and y = 256.
      const x = 250 + next(12);
      const y = 250 + next(12);
      const result = isFilled(state.cells[y * SIZE + x]!)
        ? apply(state, { kind: 'hammer', x, y })
        : apply(state, { kind: 'single', x, y, color: 1 });
      if (result.ok) store.applyDiffs(result.diffs);
      for (const [tile, mask] of masks.update(tiles)) current.set(tile, mask);
      expect(marked(store, current)).toEqual(coreHoles(state, open));
    }
    masks.dispose();
  });

  it('recomputes every mask when the open area grows', () => {
    const store = new MapStore(SIZE);
    const small = { x: 200, y: 200, w: 3, h: 1 };
    const masks = new HoleMasks(store, small);
    // A 3 x 1 open area: no brick fits, so all three cells are holes.
    expect(marked(store, masks.update([0]))).toEqual(
      new Set([0, 1, 2].map((i) => 200 * SIZE + 200 + i)),
    );
    masks.setOpen({ x: 192, y: 192, w: 64, h: 64 });
    expect(marked(store, masks.update([0])).size).toBe(0);
  });

  it('shows holes only for a single brick, and only zoomed in enough to see them', () => {
    expect(showHoles(true, HOLES_MIN_ZOOM)).toBe(true);
    expect(showHoles(true, HOLES_MIN_ZOOM / 2)).toBe(false);
    expect(showHoles(false, 40)).toBe(false);
  });
});

describe('zoomed-out overview', () => {
  it('takes over below one device pixel per cell', () => {
    expect(useOverview(0.5)).toBe(true);
    expect(useOverview(0.999)).toBe(true);
    expect(useOverview(1)).toBe(false);
    expect(useOverview(8)).toBe(false);
  });

  it('averages each 2 x 2 block into one texel at the buffer origin', () => {
    const store = new MapStore(SIZE);
    const red = encodeCell(0, false, false); // #E8384F
    // Tile 3 (x 256.., y 256..): one red cell of the first block, all four of the second.
    store.applyDiffs(
      [
        [256, 256],
        [258, 256],
        [259, 256],
        [258, 257],
        [259, 257],
      ].map(([x, y]) => ({ index: y! * SIZE + x!, cell: red, shield: 0 })),
    );
    const side = TILE_SIZE / 2;
    const out = new Uint8Array(side * side * 4);
    const open = { x: 0, y: 0, w: SIZE, h: SIZE };
    drawMinimapTile(store, 3, 2, open, out, side, { boost: 1, atOrigin: true });
    // A quarter red over white: a true average, not the minimap's boosted coverage.
    const quarter = [0xe8, 0x38, 0x4f].map((c) => Math.round(c * 0.25 + 255 * 0.75));
    expect([...out.slice(0, 4)]).toEqual([...quarter, 255]);
    expect([...out.slice(4, 8)]).toEqual([0xe8, 0x38, 0x4f, 255]);
    expect([...out.slice(8, 12)]).toEqual([255, 255, 255, 255]);
  });
});
