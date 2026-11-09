import {
  cellsOf,
  isFilled,
  type Op,
  PLACEMENT_COUNT,
  PLACEMENTS,
  type Rect,
  type RejectReason,
  type Rotation,
  type ShapeId,
} from '@brickplace/core';

/** Sides of a ghost cell that join another cell of the same brick. */
export const SIDE_LEFT = 1;
export const SIDE_RIGHT = 2;
export const SIDE_UP = 4;
export const SIDE_DOWN = 8;

export interface GhostCell {
  readonly x: number;
  readonly y: number;
  /** SIDE_* bits: which neighbours belong to the same brick. */
  readonly sides: number;
}

export interface Ghost {
  /** The op a click would send. */
  readonly op: Op;
  readonly cells: readonly GhostCell[];
  /** Local guess only: the server decides. Null when the op looks valid. */
  readonly problem: RejectReason | 'locked' | null;
  /**
   * True when the client must not send the op: it leaves the map (it cannot even be
   * encoded) or the local map says it would fail. Outside the open area is only a warning,
   * because the server may have grown the area since this build's default.
   */
  readonly blocking: boolean;
}

export type Tool =
  | {
      readonly kind: 'brick';
      readonly shape: ShapeId;
      readonly rotation: Rotation;
      readonly color: number;
    }
  | { readonly kind: 'hammer' }
  | { readonly kind: 'shield' }
  | { readonly kind: 'single'; readonly color: number };

/** Read access to the map the ghost checks against (MapStore satisfies it). */
export interface MapView {
  readonly size: number;
  cell(x: number, y: number): number;
  shield(x: number, y: number): number;
}

export interface Rules {
  readonly open: Rect;
  readonly maxShield: number;
  /** Areas moderators locked (ADR 0024): the server refuses ops touching them. */
  readonly locks?: readonly Rect[];
}

/**
 * The shape cell the cursor holds: the one nearest the centre of the bounding box, so the
 * cursor always sits on the brick and the brick turns around it.
 */
export function pivotOf(shape: ShapeId, rotation: Rotation): readonly [number, number] {
  const cells = cellsOf(shape, rotation);
  const w = Math.max(...cells.map(([x]) => x)) + 1;
  const h = Math.max(...cells.map(([, y]) => y)) + 1;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  let best = cells[0]!;
  let bestD = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    const d = (cell[0] - cx) ** 2 + (cell[1] - cy) ** 2;
    if (d < bestD) {
      best = cell;
      bestD = d;
    }
  }
  return best;
}

function onMap(size: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}

function inOpen(open: Rect, x: number, y: number): boolean {
  return x >= open.x && y >= open.y && x < open.x + open.w && y < open.y + open.h;
}

/** The cells a brick would cover with the cursor on cell (cx, cy), and which sides join. */
export function brickCells(
  shape: ShapeId,
  rotation: Rotation,
  cx: number,
  cy: number,
): { anchor: readonly [number, number]; cells: GhostCell[] } {
  const [px, py] = pivotOf(shape, rotation);
  const ax = cx - px;
  const ay = cy - py;
  const offsets = cellsOf(shape, rotation);
  const has = (dx: number, dy: number) => offsets.some(([ox, oy]) => ox === dx && oy === dy);
  const cells = offsets.map(([dx, dy]) => ({
    x: ax + dx,
    y: ay + dy,
    sides:
      (has(dx - 1, dy) ? SIDE_LEFT : 0) |
      (has(dx + 1, dy) ? SIDE_RIGHT : 0) |
      (has(dx, dy - 1) ? SIDE_UP : 0) |
      (has(dx, dy + 1) ? SIDE_DOWN : 0),
  }));
  return { anchor: [ax, ay], cells };
}

/**
 * Whether some brick placement through (x, y) still fits: all four cells empty and inside
 * the open area. A single brick is refused there (`coverable`, ADR 0005). Mirrors the
 * core's check, scanning the 76 placements instead of keeping its counters.
 */
export function coverable(map: MapView, open: Rect, x: number, y: number): boolean {
  for (let q = 0; q < PLACEMENT_COUNT; q++) {
    let fits = true;
    for (let k = 0; k < 8 && fits; k += 2) {
      const px = x + PLACEMENTS[q * 8 + k]!;
      const py = y + PLACEMENTS[q * 8 + k + 1]!;
      fits = onMap(map.size, px, py) && inOpen(open, px, py) && !isFilled(map.cell(px, py));
    }
    if (fits) return true;
  }
  return false;
}

/**
 * Whether a click with this ghost sends its op. Only `blocking` problems stop it: outside the
 * open area only warns (red ghost), because the area the client knows may be stale (the
 * built-in default before the server's config frame, or just before the area grows) and
 * the server, which decides, may accept the op.
 */
export function shouldSend(ghost: Ghost): boolean {
  return !(ghost.blocking && ghost.problem !== null);
}

/**
 * The preview for the current tool with the cursor on cell (cx, cy). The problem check
 * mirrors the core's rules so the player sees a bad spot before spending an item, but the
 * server's answer is the only one that counts. The open area comes from the server's config
 * frame (a built-in default until it arrives) and may lag behind it, so leaving it warns
 * without blocking (see shouldSend).
 */
export function ghostFor(tool: Tool, cx: number, cy: number, map: MapView, rules: Rules): Ghost {
  const ghost = ruleGhost(tool, cx, cy, map, rules);
  // A locked area (ADR 0024) warns without blocking: the server keeps the item when it
  // refuses, and a lock lifted or ended since the last config frame lets the op through.
  if (ghost.problem !== null || !rules.locks?.length) return ghost;
  const locked = ghost.cells.some(({ x, y }) => rules.locks!.some((lock) => inOpen(lock, x, y)));
  return locked ? { ...ghost, problem: 'locked' } : ghost;
}

function ruleGhost(tool: Tool, cx: number, cy: number, map: MapView, rules: Rules): Ghost {
  if (tool.kind === 'brick') {
    const { anchor, cells } = brickCells(tool.shape, tool.rotation, cx, cy);
    const offMap = cells.some(({ x, y }) => !onMap(map.size, x, y));
    const occupied = !offMap && cells.some(({ x, y }) => isFilled(map.cell(x, y)));
    const outside = cells.some(({ x, y }) => !inOpen(rules.open, x, y));
    const problem: RejectReason | null =
      offMap || (outside && !occupied) ? 'out_of_area' : occupied ? 'occupied' : null;
    return {
      op: {
        kind: 'brick',
        x: anchor[0],
        y: anchor[1],
        shape: tool.shape,
        rotation: tool.rotation,
        color: tool.color,
      },
      cells,
      problem,
      blocking: offMap || occupied,
    };
  }
  const cells = [{ x: cx, y: cy, sides: 0 }];
  if (tool.kind === 'single') {
    const op: Op = { kind: 'single', x: cx, y: cy, color: tool.color };
    let problem: RejectReason | null = null;
    if (!onMap(map.size, cx, cy)) problem = 'out_of_area';
    else if (isFilled(map.cell(cx, cy))) problem = 'occupied';
    // The open area only grows, so a brick that fits inside this build's guess of it also
    // fits on the server: a local "coverable" is safe to block on.
    else if (coverable(map, rules.open, cx, cy)) problem = 'coverable';
    if (problem) return { op, cells, problem, blocking: true };
    problem = inOpen(rules.open, cx, cy) ? null : 'out_of_area';
    return { op, cells, problem, blocking: false };
  }
  if (!onMap(map.size, cx, cy)) {
    return { op: { kind: tool.kind, x: cx, y: cy }, cells, problem: 'out_of_area', blocking: true };
  }
  let problem: RejectReason | null = null;
  if (!isFilled(map.cell(cx, cy))) problem = 'empty';
  else if (tool.kind === 'shield' && map.shield(cx, cy) >= rules.maxShield) problem = 'shield_full';
  if (problem) return { op: { kind: tool.kind, x: cx, y: cy }, cells, problem, blocking: true };
  problem = inOpen(rules.open, cx, cy) ? null : 'out_of_area';
  return { op: { kind: tool.kind, x: cx, y: cy }, cells, problem, blocking: false };
}
