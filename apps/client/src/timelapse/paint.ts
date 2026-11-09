import { colorOf, encodeCell, isFilled } from '@brickplace/core';
import { hexToRgb, PALETTE } from '../palette.ts';

// Paints keyframe tiles into an RGBA image of the whole map (one pixel per cell), for the
// timelapse's 2D canvas. Shields and brick outlines are left out: at the scale a whole map is
// watched, the colours are what shows.

/** The empty-cell colour: the map background of the game page (--map-bg). */
const EMPTY = '#E4E8F0';

/** RGBA for every possible cell byte. */
export function cellColors(): Uint8ClampedArray {
  const lookup = new Uint8ClampedArray(256 * 4);
  const empty = hexToRgb(EMPTY);
  for (let cell = 0; cell < 256; cell++) {
    const [r, g, b] = isFilled(cell) ? hexToRgb(PALETTE[colorOf(cell)]!) : empty;
    lookup.set([r, g, b, 255], cell * 4);
  }
  return lookup;
}

/**
 * Writes a frame's overview into `image` (RGBA, `overview.side`² pixels): each pixel the
 * colour most of its cells have, over the empty colour by how much of it is filled. `colors`
 * is cellColors(): the colour of index c is that of a filled cell byte of colour c.
 */
export function paintOverview(
  image: Uint8ClampedArray,
  overview: { readonly colors: Uint8Array; readonly cover: Uint8Array },
  colors: Uint8ClampedArray,
): void {
  const empty = hexToRgb(EMPTY);
  for (let p = 0; p < overview.colors.length; p++) {
    const color = overview.colors[p]!;
    const at = p * 4;
    const c = color === 0 ? -1 : encodeCell(color - 1, false, false) * 4;
    // Doubled, so a block half filled shows its colour in full, as pixel art reads at a glance.
    const alpha = color === 0 ? 0 : Math.min(1, (2 * overview.cover[p]!) / 255);
    for (let k = 0; k < 3; k++) {
      const top = c < 0 ? empty[k]! : colors[c + k]!;
      image[at + k] = Math.round(top * alpha + empty[k]! * (1 - alpha));
    }
    image[at + 3] = 255;
  }
}

/** Writes one tile's cells into `image` (RGBA, `size`² pixels) at its place. */
export function paintTile(
  image: Uint8ClampedArray,
  size: number,
  tileSize: number,
  tile: number,
  cells: Uint8Array,
  colors: Uint8ClampedArray,
): void {
  const perRow = size / tileSize;
  const tx = tile % perRow;
  const ty = (tile - tx) / perRow;
  for (let row = 0; row < tileSize; row++) {
    let at = ((ty * tileSize + row) * size + tx * tileSize) * 4;
    const from = row * tileSize;
    for (let col = 0; col < tileSize; col++, at += 4) {
      const c = cells[from + col]! * 4;
      image[at] = colors[c]!;
      image[at + 1] = colors[c + 1]!;
      image[at + 2] = colors[c + 2]!;
      image[at + 3] = 255;
    }
  }
}
