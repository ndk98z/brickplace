import {
  cellsOf,
  type Item,
  type Op,
  PALETTE_SIZE,
  type Rect,
  type Rotation,
  type ShapeId,
} from '@brickplace/core';
import { type Art, type ArtLook, lookAt, NONE, targetAt } from './art.ts';
import { around, contains, type Mirror } from './mirror.ts';
import type { Rng } from './rng.ts';

export const PLAYER_KINDS = ['builder', 'casual', 'griefer', 'repairer'] as const;
export type PlayerKind = (typeof PLAYER_KINDS)[number];

/** Cells around a bot's work area that its view (what its "page" shows) also takes in. */
export const VIEW_PAD = 16;
/** Edge of a casual player's home area. */
export const HOME_EDGE = 48;

/** What a player reads to decide: the shared map, the artworks, the run's randomness. */
export interface World {
  readonly mirror: Mirror;
  readonly arts: readonly Art[];
  readonly rng: Rng;
  /** Wall clock (ms), only to pace looks at the map. */
  readonly now: number;
}

/**
 * How one bot plays, after the kinds in tools/sim: builders draw an artwork, casual players fill
 * room near a home spot, griefers spoil an artwork, repairers mend the most damaged one. Every
 * move stays inside the bot's view (`view`), which the bot reports to the server as a page does:
 * ops outside the view are a bot signal (ADR 0026). A move is only a proposal; the server
 * decides.
 */
export class Player {
  /** The artwork this player works on (builders, griefers, repairers), by index. */
  art: number;
  /** A casual player's area, moved when it fills up. */
  home: Rect;
  /** Colours a casual player likes. */
  private readonly colors: readonly [number, number];
  /** Casual moves that found nothing in a row: past a few, the player moves home. */
  private misses = 0;

  constructor(
    readonly kind: PlayerKind,
    art: number,
    world: World,
  ) {
    const { rng } = world;
    this.art = art;
    this.home = randomHome(world.mirror, rng);
    this.colors = [rng.int(PALETTE_SIZE), rng.int(PALETTE_SIZE)];
  }

  /** The cells this player works in. */
  area(world: World): Rect {
    const art = world.arts[this.art];
    return this.kind === 'casual' || !art ? this.home : art.rect;
  }

  /** What its page shows: the work area and a margin, clamped to the map. */
  view(world: World): Rect {
    return around(this.area(world), VIEW_PAD, world.mirror.size);
  }

  /**
   * Where and how to use the item, or null when this player has no use for it now (the bot
   * keeps it, or throws it away once the hold is full).
   */
  move(item: Item, world: World): Op | null {
    const art = world.arts[this.art];
    if (this.kind === 'casual' || !art) return this.casual(item, world);
    const look = lookAt(art, world.mirror, world.now);
    return this.kind === 'griefer'
      ? this.grief(item, art, look, world)
      : this.maintain(item, art, look, world);
  }

  /** Repairers go to the most damaged artwork; griefers sometimes switch. Called now and then. */
  retarget(world: World): void {
    const { arts, rng, mirror, now } = world;
    if (!arts.length) return;
    if (this.kind === 'repairer') {
      let worst = this.art;
      let worstShare = Number.POSITIVE_INFINITY;
      arts.forEach((art, i) => {
        const share = art.cells ? lookAt(art, mirror, now).correct.length / art.cells : 1;
        if (share < worstShare) [worst, worstShare] = [i, share];
      });
      this.art = worst;
    } else if (this.kind === 'griefer' && rng.chance(0.25)) {
      this.art = rng.int(arts.length);
    }
  }

  /** Builders and repairers: draw the artwork, fill its holes, clear wrong cells, guard it. */
  private maintain(item: Item, art: Art, look: ArtLook, world: World): Op | null {
    const { mirror, rng } = world;
    switch (item.kind) {
      case 'brick':
        // A finished artwork leaves bricks free for the room around it; around an image they
        // would only frame it with clutter, so its builders keep them.
        return (
          artBrick(art, look, item.shape, true, world) ??
          (art.strict ? null : this.casual(item, world))
        );
      case 'single': {
        const index = pickFrom(look.holes, rng, (i) =>
          mirror.isHole(i % mirror.size, (i / mirror.size) | 0),
        );
        if (index === null) return art.strict ? null : this.casual(item, world);
        const x = index % mirror.size;
        const y = (index - x) / mirror.size;
        return { kind: 'single', x, y, color: targetAt(art, x, y) };
      }
      case 'hammer':
        return at(
          'hammer',
          weakest(
            look.wrong,
            world,
            Number.POSITIVE_INFINITY,
            (i, x, y) => mirror.colorAt(i) !== targetAt(art, x, y),
          ),
          mirror,
        );
      case 'shield':
        return at(
          'shield',
          weakest(
            look.correct,
            world,
            mirror.maxShield,
            (i, x, y) => mirror.colorAt(i) === targetAt(art, x, y),
          ),
          mirror,
        );
    }
  }

  /** Griefers: break correct cells, add wrong colours, shield the damage. */
  private grief(item: Item, art: Art, look: ArtLook, world: World): Op | null {
    const { mirror, rng, arts } = world;
    switch (item.kind) {
      case 'brick':
        return artBrick(art, look, item.shape, false, world) ?? this.casual(item, world);
      case 'single': {
        const index = pickFrom(look.holes, rng, (i) =>
          mirror.isHole(i % mirror.size, (i / mirror.size) | 0),
        );
        if (index === null) return this.casual(item, world);
        const x = index % mirror.size;
        const y = (index - x) / mirror.size;
        return { kind: 'single', x, y, color: wrongColor(rng, targetAt(art, x, y)) };
      }
      case 'hammer': {
        const index = weakest(
          look.correct,
          world,
          Number.POSITIVE_INFINITY,
          (i, x, y) => mirror.colorAt(i) === targetAt(art, x, y),
        );
        // Nothing left to break here: move on to another artwork.
        if (index === null && look.correct.length === 0) this.art = rng.int(arts.length);
        return at('hammer', index, mirror);
      }
      case 'shield':
        return at(
          'shield',
          weakest(
            look.wrong,
            world,
            mirror.maxShield,
            (i, x, y) => mirror.colorAt(i) !== targetAt(art, x, y),
          ),
          mirror,
        );
    }
  }

  /**
   * Anything, anywhere in the view, in colours this player likes. Builders and repairers keep
   * such moves off their own artwork's target cells, which they would spoil.
   */
  private casual(item: Item, world: World): Op | null {
    const { mirror, rng } = world;
    const view = this.view(world);
    const art = world.arts[this.art];
    const spare =
      art && (this.kind === 'builder' || this.kind === 'repairer')
        ? (x: number, y: number) => targetAt(art, x, y) !== NONE
        : null;
    const op = casualMove(item, view, this.colors, world, spare);
    if (op) this.misses = 0;
    if (op || this.kind !== 'casual') return op;
    // Little room left here: look elsewhere next time (the bot reports the new view first).
    if (++this.misses >= 3) {
      this.home = randomHome(mirror, rng);
      this.misses = 0;
    }
    return null;
  }
}

/** A random home area inside the open area. */
function randomHome(mirror: Mirror, rng: Rng): Rect {
  const { open } = mirror;
  const w = Math.min(HOME_EDGE, open.w);
  const h = Math.min(HOME_EDGE, open.h);
  return { x: open.x + rng.int(open.w - w + 1), y: open.y + rng.int(open.h - h + 1), w, h };
}

/**
 * A casual move inside `area`, touching no cell `spare` names. A brick goes where it touches
 * the most filled cells of a few spots that fit (players tidy up), a single brick into a hole,
 * a hammer or a shield on a random filled cell.
 */
export function casualMove(
  item: Item,
  area: Rect,
  colors: readonly number[],
  world: World,
  spare: ((x: number, y: number) => boolean) | null = null,
): Op | null {
  const { mirror, rng } = world;
  const free = (x: number, y: number) => contains(area, x, y) && !spare?.(x, y);
  const randomCell = () => [area.x + rng.int(area.w), area.y + rng.int(area.h)] as const;
  if (area.w <= 0 || area.h <= 0) return null;
  switch (item.kind) {
    case 'brick': {
      let best: { x: number; y: number; rotation: Rotation; contact: number } | null = null;
      for (let i = 0; i < 24; i++) {
        const [cx, cy] = randomCell();
        if (!mirror.isEmptyPlayable(cx, cy)) continue;
        const rotation = rng.int(4) as Rotation;
        const offsets = cellsOf(item.shape, rotation);
        const [ax, ay] = offsets[rng.int(4)]!;
        const x = cx - ax;
        const y = cy - ay;
        if (!offsets.every(([dx, dy]) => free(x + dx, y + dy))) continue;
        const contact = contactOf(mirror, x, y, offsets);
        if (contact >= 0 && (!best || contact > best.contact)) best = { x, y, rotation, contact };
      }
      if (!best) return null;
      const { x, y, rotation } = best;
      return { kind: 'brick', x, y, shape: item.shape, rotation, color: rng.pick(colors) };
    }
    case 'single':
      for (let i = 0; i < 64; i++) {
        const [x, y] = randomCell();
        if (free(x, y) && mirror.isHole(x, y))
          return { kind: 'single', x, y, color: rng.pick(colors) };
      }
      return null;
    case 'hammer':
    case 'shield':
      for (let i = 0; i < 16; i++) {
        const [x, y] = randomCell();
        const index = y * mirror.size + x;
        if (!free(x, y) || !mirror.playable(x, y) || !mirror.filled(index)) continue;
        if (item.kind === 'shield' && mirror.shields[index]! >= mirror.maxShield) continue;
        return { kind: item.kind, x, y };
      }
      return null;
  }
}

/**
 * A brick on empty artwork cells. Honest players take the colour most of its cells want and
 * accept at most one cell off, as in tools/sim; cells without a target never count as off.
 * On a strict artwork (an image) they look harder and accept a cell off only once three
 * quarters of it are drawn: the cells left by then sit where colours meet, and no brick fits
 * them exactly. The cell off is hammered later and, walled in, filled by a single brick.
 * Griefers pick any other colour.
 */
function artBrick(
  art: Art,
  look: ArtLook,
  shape: ShapeId,
  honest: boolean,
  world: World,
): Op | null {
  const { mirror, rng } = world;
  if (look.empty.length === 0) return null;
  let best: { x: number; y: number; rotation: Rotation; color: number; score: number } | null =
    null;
  const attempts = art.strict ? 96 : 24;
  const least = art.strict && look.empty.length * 4 > art.cells ? 4 : 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const index = rng.pick(look.empty);
    const rotation = rng.int(4) as Rotation;
    const offsets = cellsOf(shape, rotation);
    const [ax, ay] = offsets[rng.int(4)]!;
    const ox = (index % mirror.size) - ax;
    const oy = Math.floor(index / mirror.size) - ay;
    if (!mirror.fits(ox, oy, shape, rotation)) continue;
    const wanted = new Map<number, number>();
    let outside = 0;
    for (const [dx, dy] of offsets) {
      const target = targetAt(art, ox + dx, oy + dy);
      if (target === NONE) outside++;
      else wanted.set(target, (wanted.get(target) ?? 0) + 1);
    }
    let majority = 0;
    let votes = -1;
    for (const [color, count] of wanted) if (count > votes) [majority, votes] = [color, count];
    const color = honest ? majority : wrongColor(rng, majority);
    const score = honest ? votes + outside : 4;
    if (!best || score > best.score) best = { x: ox, y: oy, rotation, color, score };
    if (score === 4) break;
  }
  if (!best || best.score < least) return null;
  const { x, y, rotation, color } = best;
  return { kind: 'brick', x, y, shape, rotation, color };
}

/** Sides of a brick at (x, y) touching a filled cell or the edge of the room, or -1 if it does not fit. */
function contactOf(
  mirror: Mirror,
  x: number,
  y: number,
  offsets: readonly (readonly [number, number])[],
): number {
  const inBrick = (cx: number, cy: number) =>
    offsets.some(([dx, dy]) => x + dx === cx && y + dy === cy);
  let contact = 0;
  for (const [dx, dy] of offsets) {
    if (!mirror.isEmptyPlayable(x + dx, y + dy)) return -1;
    for (const [nx, ny] of [
      [x + dx + 1, y + dy],
      [x + dx - 1, y + dy],
      [x + dx, y + dy + 1],
      [x + dx, y + dy - 1],
    ] as const) {
      if (!inBrick(nx, ny) && !mirror.isEmptyPlayable(nx, ny)) contact++;
    }
  }
  return contact;
}

/** The least shielded of a few cells that still pass `still` and have fewer than `below` layers. */
function weakest(
  cells: readonly number[],
  world: World,
  below: number,
  still: (index: number, x: number, y: number) => boolean,
): number | null {
  const { mirror, rng } = world;
  let best: number | null = null;
  let bestShield = below;
  for (let i = 0; i < Math.min(8, cells.length); i++) {
    const index = rng.pick(cells);
    const x = index % mirror.size;
    const y = (index - x) / mirror.size;
    const shield = mirror.shields[index]!;
    if (
      mirror.filled(index) &&
      mirror.playable(x, y) &&
      still(index, x, y) &&
      shield < bestShield
    ) {
      best = index;
      bestShield = shield;
    }
  }
  return best;
}

/** One of a few random picks that still passes `still`, or null. */
function pickFrom(
  cells: readonly number[],
  rng: Rng,
  still: (index: number) => boolean,
): number | null {
  for (let i = 0; i < Math.min(4, cells.length); i++) {
    const index = rng.pick(cells);
    if (still(index)) return index;
  }
  return null;
}

function at(kind: 'hammer' | 'shield', index: number | null, mirror: Mirror): Op | null {
  if (index === null) return null;
  const x = index % mirror.size;
  return { kind, x, y: (index - x) / mirror.size };
}

function wrongColor(rng: Rng, avoid: number): number {
  return avoid < 0 ? rng.int(PALETTE_SIZE) : (avoid + 1 + rng.int(PALETTE_SIZE - 1)) % PALETTE_SIZE;
}
