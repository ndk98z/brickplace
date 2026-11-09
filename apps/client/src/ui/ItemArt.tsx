// Small drawings of the items for the landing and the first-time guide (Landing design).

/** A 3 × 2 drawing of cells: a colour per cell or null for none; `ring` outlines one. */
export function BrickCells({
  cells,
  ring = -1,
}: {
  cells: readonly (string | null)[];
  ring?: number;
}) {
  return (
    <span class="item-art" aria-hidden="true">
      {cells.map((color, i) => (
        <span
          key={i}
          class={color ? `item-art-cell${i === ring ? ' item-art-ring' : ''}` : undefined}
          style={color ? { background: color } : undefined}
        />
      ))}
    </span>
  );
}

const O = '#FF6B3D';
const B = '#3D7BFF';
/** A brick: four cells of one colour. */
export const BRICK_ART = [O, O, O, null, O, null];
/** A single brick filling the one hole a brick cannot reach. */
export const SINGLE_ART = [B, B, B, B, '#FFD23F', B];
export const SINGLE_RING = 4;

export const HERO_COLUMNS = 24;
export const HERO_ROWS = 18;
/** Brick colours from the palette, for the scattered cells. */
const SCATTER = ['#E8384F', '#FFA94D', '#FFD23F', '#2BB673', '#12B5CB', '#3D7BFF', '#7B5CFF'];
let hero: (string | null)[] | null = null;
export const HERO_SEED = 5;

/**
 * One step of the hero's 31-bit linear congruential sequence, seed × 1103515245 + 12345 mod
 * 2^31, in exact integer arithmetic (Math.imul): a plain `seed * 1103515245` passes 2^53 and
 * loses its low bits.
 */
export function nextSeed(seed: number): number {
  return (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
}

/**
 * The landing hero's drawing (Landing design): a heart, a striped flag, a sun and a few loose
 * bricks on a HERO_COLUMNS × HERO_ROWS grid, row-major, null for an empty cell. Fixed: the
 * scatter comes from a seeded sequence, so every visit draws the same picture.
 */
export function heroArt(): readonly (string | null)[] {
  if (hero) return hero;
  let seed = HERO_SEED;
  const next = () => {
    seed = nextSeed(seed);
    return seed / 0x80000000;
  };
  const cells: (string | null)[] = [];
  for (let r = 0; r < HERO_ROWS; r++) {
    for (let c = 0; c < HERO_COLUMNS; c++) {
      const hx = (c - 7) / 3.6;
      const hy = -(r - 6) / 3.6;
      const heart = (hx * hx + hy * hy - 1) ** 3 - hx * hx * hy ** 3 <= 0;
      const flag = c >= 14 && c <= 21 && r >= 2 && r <= 7;
      const sun = Math.hypot(c - 17, r - 13) <= 3.2;
      if (heart) cells.push('#E8384F');
      else if (flag) cells.push(r <= 3 ? '#3D7BFF' : r <= 5 ? '#FFD23F' : '#2BB673');
      else if (sun) cells.push('#FFA94D');
      else if (next() < 0.12) cells.push(SCATTER[Math.floor(next() * SCATTER.length)]!);
      else cells.push(null);
    }
  }
  hero = cells;
  return cells;
}
