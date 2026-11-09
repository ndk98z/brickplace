import { PALETTE_SIZE, type Rect } from '@brickplace/core';
import type { Mirror } from './mirror.ts';
import { nearestColor } from './palette.ts';
import type { Image } from './png.ts';
import type { Rng } from './rng.ts';

/** No target here: a transparent pixel, which builders leave alone. */
export const NONE = -1;

/** A picture builders draw: a target colour (or NONE) per cell of its rectangle. */
export interface Art {
  readonly rect: Rect;
  readonly target: Int8Array;
  /** Cells with a target. */
  readonly cells: number;
  /** Builders place no brick with a cell off its target (an image), rather than one in four. */
  readonly strict: boolean;
  look: ArtLook | null;
}

/** What an artwork looks like now, as lists of map indices (cached, see lookAt). */
export interface ArtLook {
  readonly version: number;
  readonly at: number;
  /** Empty playable cells with a target. */
  readonly empty: number[];
  /** Of those, the ones no brick can reach (only a single brick fills them). */
  readonly holes: number[];
  /** Filled cells of another colour than their target. */
  readonly wrong: number[];
  /** Filled cells of their target colour. */
  readonly correct: number[];
}

/** How long a look is reused while the map keeps changing (ms). */
const LOOK_EVERY_MS = 1000;

export function makeArt(rect: Rect, target: Int8Array, strict = false): Art {
  let cells = 0;
  for (const t of target) if (t !== NONE) cells++;
  return { rect, target, cells, strict, look: null };
}

/** A few colour regions with irregular borders (nearest of a handful of seeds), as tools/sim. */
export function randomArt(rng: Rng, rect: Rect): Art {
  const colors = Array.from({ length: 3 + rng.int(3) }, () => rng.int(PALETTE_SIZE));
  const seeds = Array.from({ length: 4 + rng.int(4) }, () => ({
    x: rng.int(rect.w),
    y: rng.int(rect.h),
    color: rng.pick(colors),
  }));
  const target = new Int8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      let best = seeds[0]!;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const seed of seeds) {
        const distance = (seed.x - x) ** 2 + (seed.y - y) ** 2;
        if (distance < bestDistance) [best, bestDistance] = [seed, distance];
      }
      target[y * rect.w + x] = best.color;
    }
  }
  return makeArt(rect, target);
}

/**
 * An image as an artwork with its top-left cell at (x, y), `width` cells wide (the height
 * keeps the aspect ratio; nearest pixel, no smoothing, so hard edges stay hard). Each pixel
 * takes the nearest palette colour; pixels less than half opaque have no target.
 */
export function imageArt(image: Image, x: number, y: number, width = image.width): Art {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round((image.height * w) / image.width));
  const target = new Int8Array(w * h);
  for (let row = 0; row < h; row++) {
    const sy = Math.min(image.height - 1, Math.floor(((row + 0.5) * image.height) / h));
    for (let col = 0; col < w; col++) {
      const sx = Math.min(image.width - 1, Math.floor(((col + 0.5) * image.width) / w));
      const p = (sy * image.width + sx) * 4;
      const { rgba } = image;
      target[row * w + col] =
        rgba[p + 3]! < 128 ? NONE : nearestColor(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
    }
  }
  return makeArt({ x, y, w, h }, target, true);
}

/** The target colour at a map cell, or NONE outside the artwork or on a transparent pixel. */
export function targetAt(art: Art, x: number, y: number): number {
  const { rect } = art;
  if (x < rect.x || y < rect.y || x >= rect.x + rect.w || y >= rect.y + rect.h) return NONE;
  return art.target[(y - rect.y) * rect.w + (x - rect.x)]!;
}

/** The artwork as it is on the map, looked at again at most once a second while it changes. */
export function lookAt(art: Art, mirror: Mirror, now: number): ArtLook {
  const old = art.look;
  if (old && (old.version === mirror.version || now - old.at < LOOK_EVERY_MS)) return old;
  const look: ArtLook = {
    version: mirror.version,
    at: now,
    empty: [],
    holes: [],
    wrong: [],
    correct: [],
  };
  const { rect } = art;
  const { size } = mirror;
  for (let y = rect.y; y < Math.min(size, rect.y + rect.h); y++) {
    for (let x = rect.x; x < Math.min(size, rect.x + rect.w); x++) {
      const target = art.target[(y - rect.y) * rect.w + (x - rect.x)]!;
      if (target === NONE) continue;
      const index = y * size + x;
      const color = mirror.colorAt(index);
      if (color >= 0) (color === target ? look.correct : look.wrong).push(index);
      else if (mirror.playable(x, y)) {
        look.empty.push(index);
        if (!mirror.canCover(x, y)) look.holes.push(index);
      }
    }
  }
  art.look = look;
  return look;
}

/** Share of the artwork's target cells showing their colour now. */
export function accuracy(art: Art, mirror: Mirror, now: number): number {
  return art.cells ? lookAt(art, mirror, now).correct.length / art.cells : 0;
}
