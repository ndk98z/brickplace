/** The seven four-cell brick shapes, identified by index. */
export const SHAPE_NAMES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const;
export type ShapeId = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type Rotation = 0 | 1 | 2 | 3;
export type Offset = readonly [dx: number, dy: number];

const BASE: readonly (readonly Offset[])[] = [
  [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ],
  [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  [
    [0, 0],
    [1, 0],
    [2, 0],
    [1, 1],
  ],
  [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
  ],
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
  ],
  [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  [
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
];

/** Rotate 90 degrees clockwise, then shift so the bounding box starts at (0, 0). */
function rotate(cells: readonly Offset[]): Offset[] {
  const turned = cells.map(([x, y]) => [-y, x] as const);
  const minX = Math.min(...turned.map(([x]) => x));
  const minY = Math.min(...turned.map(([, y]) => y));
  return turned
    .map(([x, y]) => [x - minX, y - minY] as const)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function key(cells: readonly Offset[]): string {
  return cells.map(([x, y]) => `${x},${y}`).join(';');
}

/** ROTATIONS[shape][rotation] = the four cell offsets from the bounding box's top-left anchor. */
export const ROTATIONS: readonly (readonly (readonly Offset[])[])[] = BASE.map((base) => {
  const out: Offset[][] = [rotate(rotate(rotate(rotate(base))))];
  for (let r = 1; r < 4; r++) out.push(rotate(out[r - 1]!));
  return out;
});

/** Distinct placements of all shapes (19). The anti-stuck counters track one count per entry. */
export const ORIENTATIONS: readonly (readonly Offset[])[] = (() => {
  const seen = new Map<string, readonly Offset[]>();
  for (const rotations of ROTATIONS) for (const cells of rotations) seen.set(key(cells), cells);
  return [...seen.values()];
})();

/**
 * The 76 placements through one cell (19 orientations x 4 cells), flattened: for placement p,
 * PLACEMENTS[p * 8 .. p * 8 + 7] holds the (dx, dy) of its four cells relative to that cell.
 * Placement p uses orientation PLACEMENT_ORIENTATION[p].
 */
export const PLACEMENTS: Int8Array = Int8Array.from(
  ORIENTATIONS.flatMap((cells) =>
    cells.flatMap(([ax, ay]) => cells.flatMap(([dx, dy]) => [dx - ax, dy - ay])),
  ),
);
export const PLACEMENT_COUNT = PLACEMENTS.length / 8;
export const PLACEMENT_ORIENTATION: Uint8Array = Uint8Array.from(
  ORIENTATIONS.flatMap((cells, o) => cells.map(() => o)),
);

/** ORIENTATION_OF[shape][rotation] = index into ORIENTATIONS (rotations of O share one). */
export const ORIENTATION_OF: readonly (readonly number[])[] = ROTATIONS.map((rotations) =>
  rotations.map((cells) => ORIENTATIONS.findIndex((o) => key(o) === key(cells))),
);

export function cellsOf(shape: ShapeId, rotation: Rotation): readonly Offset[] {
  return ROTATIONS[shape]![rotation]!;
}
