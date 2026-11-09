import { PALETTE_SIZE } from '@brickplace/core';

/**
 * The 32 brick colours as RGB, in swatch order: the client's PALETTE (apps/client/src/palette.ts),
 * repeated so a Node tool does not import the client. A test checks they agree.
 */
export const PALETTE_RGB: readonly (readonly [number, number, number])[] = [
  0xe8384f, 0xff6b6b, 0xff9eaa, 0xc2185b, 0xff7a1a, 0xffa94d, 0xffd23f, 0xfff1a8, 0x2bb673,
  0x7bd389, 0xb8e986, 0x1e7f5c, 0x12b5cb, 0x7fdbff, 0x3d7bff, 0x1f4fb8, 0x7b5cff, 0xb49cff,
  0xe07be0, 0x8e2c8e, 0x8b5a3c, 0xc98e5d, 0xf2d7b6, 0xffffff, 0xe3e6ee, 0xb5bccb, 0x6e7891,
  0x3b4256, 0x1d2130, 0xff4fa3, 0x00c2a8, 0xffe0f0,
].map((n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const);

if (PALETTE_RGB.length !== PALETTE_SIZE) throw new Error('palette must have exactly 32 colours');

/**
 * The palette colour closest to an RGB colour, by squared distance weighted for the eye
 * (the "redmean" approximation): good enough to turn a picture into brick colours.
 */
export function nearestColor(r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  PALETTE_RGB.forEach(([pr, pg, pb], index) => {
    const mean = (r + pr) / 2;
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const distance = (2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db;
    if (distance < bestDistance) [best, bestDistance] = [index, distance];
  });
  return best;
}
