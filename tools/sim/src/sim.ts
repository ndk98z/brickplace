import {
  addItems,
  blockedCells,
  cellsOf,
  colorOf,
  drawContext,
  drawFrom,
  type Hold,
  holeCount,
  ITEM_KINDS,
  type Item,
  type ItemKind,
  isFilled,
  itemsDue,
  newHold,
  ORIENTATION_OF,
  PALETTE_SIZE,
  PHASE_THRESHOLDS,
  PHASES,
  type Phase,
  phaseOf,
  type Rates,
  type Rect,
  type Rotation,
  rollKind,
  SHAPE_NAMES,
  type ShapeId,
  type State,
  takeItem,
} from '@brickplace/core';
import { checkConfig, PLAYER_KINDS, type PlayerKind, type SimConfig } from './config.ts';
import { Rng } from './rng.ts';
import { TICK_MS, World } from './world.ts';

const TICKS_PER_HOUR = (60 * 60 * 1000) / TICK_MS;

/** A picture builders try to draw: one target colour per cell of its rectangle. */
interface Art {
  readonly rect: Rect;
  readonly target: Uint8Array;
  view: ArtView | null;
}

/** What an artwork looks like this tick (computed once per tick, re-checked before use). */
interface ArtView {
  readonly tick: number;
  readonly empty: number[];
  readonly holes: number[];
  readonly wrong: number[];
  readonly correct: number[];
}

interface Player {
  readonly kind: PlayerKind;
  /** Artwork a builder draws, or the one a griefer or repairer is working on. */
  art: number;
  /** The core's hold: items arrive per cooldown, a full hold banks no time (ADR 0012). */
  hold: Hold;
}

export interface Snapshot {
  readonly hour: number;
  readonly openEdge: number;
  readonly phase: Phase;
  /** Filled share of the open area. */
  readonly fill: number;
  /** Share of the open area no brick can reach, filled cells plus holes (ADR 0010). */
  readonly blocked: number;
  /** Shapes that count as fitting for the draw: with at least `fitMin` valid placements. */
  readonly shapesFit: number;
  readonly empty: number;
  /** Empty open cells no brick can cover. */
  readonly holes: number;
  /** Share of filled cells that hold a single brick. */
  readonly singleShare: number;
  /** Mean share of artwork cells showing their target colour. */
  readonly artAccuracy: number;
  /** Artworks with at least 90% of cells correct. */
  readonly artsIntact: number;
  readonly artHoles: number;
  readonly shieldedCells: number;
  /** Items so far, cumulative. */
  readonly drawn: Counts;
  readonly used: Counts;
  readonly discarded: Counts;
}

type Counts = Record<ItemKind, number>;
type PlayerCounts = { drawn: Counts; used: Counts; discarded: Counts };

export interface Report {
  readonly config: SimConfig;
  readonly snapshots: readonly Snapshot[];
  readonly growth: readonly { readonly hour: number; readonly edge: number }[];
  readonly drawn: Counts;
  readonly used: Counts;
  /** Items thrown away because the hold was full and nothing useful could be done. */
  readonly discarded: Counts;
  /**
   * Draws, uses and discards by player kind. Every player who cannot use a brick or a single
   * brick on its own target tries it anywhere, so a discarded brick or single brick is one
   * nobody could use at that moment, whoever held it. Builders and repairers hammer and
   * shield only their artwork (all their hammers clear wrong cells), so their hammer and
   * shield discards are items they did not want; casual players play hammers and shields
   * anywhere and discard none.
   */
  readonly byPlayer: Readonly<Record<PlayerKind, PlayerCounts>>;
  /** Single bricks drawn while the map had no hole, handed out as bricks instead. */
  readonly convertedSingles: number;
  /** Bricks drawn while no shape had a valid placement, handed out as shields (ADR 0010). */
  readonly bricksAsShields: number;
  /** Bricks re-drawn as another item by `noFit: 'redraw'` or `roomScale`. */
  readonly bricksRedrawn: number;
  /** Bricks drawn of each shape, by shape id. */
  readonly drawnShapes: readonly number[];
  readonly final: Snapshot;
}

const zero = (): Counts => ({ brick: 0, single: 0, hammer: 0, shield: 0 });

/**
 * Experiment (the ADR 0005 rule): the phase by the filled share of the open area, at the
 * core's thresholds and with the same integer comparisons as the core's `phaseOf`.
 */
export function fillPhase(state: State): Phase {
  const { w, h } = state.config.open;
  const filled = state.counters.filled * 100;
  const area = w * h;
  if (filled < PHASE_THRESHOLDS[0] * area) return 'settling';
  if (filled < PHASE_THRESHOLDS[1] * area) return 'contested';
  return 'saturated';
}

export function run(config: SimConfig): Report {
  return new Season(config).run();
}

/** The figures the README tables quote, taken from a report. */
export interface Summary {
  readonly artAccuracy: number;
  readonly artsIntact: number;
  /** Share of filled cells held by single bricks at 24, 72 and 168 h (null past the run). */
  readonly singleShareAt: readonly (number | null)[];
  /** Bricks placed by 24, 72 and 168 h. */
  readonly bricksUsedAt: readonly (number | null)[];
  /** Items thrown away over the run, as a share of items drawn. */
  readonly discardShare: number;
  readonly brickDiscardShare: number;
  /** Discards of casual players, who play any item anywhere it fits, as a share of their draws. */
  readonly casualDiscardShare: number;
  /** Hours whose last tick was in each phase. */
  readonly phaseHours: Readonly<Record<Phase, number>>;
}

const SUMMARY_HOURS = [24, 72, 168];

export function summarize(report: Report): Summary {
  const at = (hour: number) => report.snapshots.find((s) => s.hour === hour) ?? null;
  const total = (counts: Counts) => ITEM_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  const phaseHours = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
  for (const s of report.snapshots) phaseHours[s.phase]++;
  return {
    artAccuracy: report.final.artAccuracy,
    artsIntact: report.final.artsIntact,
    singleShareAt: SUMMARY_HOURS.map((h) => at(h)?.singleShare ?? null),
    bricksUsedAt: SUMMARY_HOURS.map((h) => at(h)?.used.brick ?? null),
    discardShare: total(report.discarded) / Math.max(1, total(report.drawn)),
    brickDiscardShare: report.discarded.brick / Math.max(1, report.drawn.brick),
    casualDiscardShare:
      total(report.byPlayer.casual.discarded) / Math.max(1, total(report.byPlayer.casual.drawn)),
    phaseHours,
  };
}

class Season {
  private readonly rng: Rng;
  private readonly world: World;
  private readonly arts: Art[] = [];
  private readonly players: Player[] = [];
  /**
   * Empty cells a brick can still cover, and holes, as lists players aim at; rescanned every
   * `refreshTicks` ticks and after growth. Draws read the core's live counters instead.
   */
  private coverable: number[] = [];
  private holes: number[] = [];
  private readonly snapshots: Snapshot[] = [];
  private readonly growth: { hour: number; edge: number }[] = [];
  private readonly drawn = zero();
  private readonly used = zero();
  private readonly discarded = zero();
  private readonly byPlayer = Object.fromEntries(
    PLAYER_KINDS.map((kind) => [kind, { drawn: zero(), used: zero(), discarded: zero() }]),
  ) as Record<PlayerKind, PlayerCounts>;
  private convertedSingles = 0;
  private bricksAsShields = 0;
  private bricksRedrawn = 0;
  private readonly drawnShapes = new Array<number>(SHAPE_NAMES.length).fill(0);

  constructor(private readonly config: SimConfig) {
    checkConfig(config, TICK_MS);
    this.rng = new Rng(config.seed);
    const start = Math.floor((config.mapSize - config.openSize) / 2);
    this.world = new World(
      config.mapSize,
      { x: start, y: start, w: config.openSize, h: config.openSize },
      config.maxShield,
      config.shieldLifetime,
      config.hammerMode,
    );
    this.placeArts();
    this.createPlayers();
  }

  run(): Report {
    const ticks = this.config.hours * TICKS_PER_HOUR;
    for (let t = 0; t < ticks; t++) {
      // Shield layers expire in the core, swept by the first accepted op at or after their time.
      this.world.tick = t;
      if (t % this.config.refreshTicks === 0) this.refresh();
      if (t % TICKS_PER_HOUR === 0) this.retarget();
      this.step();
      // The server checks growth after every batch of ops; the sim only after a whole tick
      // (500 players' moves), so growth can come up to a tick later than on the server.
      if (this.world.growIfFull(this.config.growth)) {
        this.growth.push({ hour: (t + 1) / TICKS_PER_HOUR, edge: this.world.open.w });
        this.refresh();
      }
      if ((t + 1) % TICKS_PER_HOUR === 0) {
        this.snapshots.push(this.snapshot((t + 1) / TICKS_PER_HOUR));
      }
    }
    return {
      config: this.config,
      snapshots: this.snapshots,
      growth: this.growth,
      drawn: this.drawn,
      used: this.used,
      discarded: this.discarded,
      byPlayer: this.byPlayer,
      convertedSingles: this.convertedSingles,
      bricksAsShields: this.bricksAsShields,
      bricksRedrawn: this.bricksRedrawn,
      drawnShapes: this.drawnShapes,
      final: this.snapshots.at(-1) ?? this.snapshot(0),
    };
  }

  /** Rescans the open area into the lists players aim at: coverable cells and holes. */
  private refresh(): void {
    const { coverable, holes } = this.world.empties();
    this.coverable = coverable;
    this.holes = holes;
  }

  /** The phase now: the core's `phaseOf` (ADR 0010), or by fill as an experiment. */
  private phase(): Phase {
    const { state } = this.world;
    return this.config.phaseBy === 'room' ? phaseOf(state) : fillPhase(state);
  }

  /**
   * One cooldown. Each player in turn looks at its hold as the server does when an op
   * arrives: the items whose cooldowns have passed are drawn from the map as it is at that
   * moment, then the player plays what it can, and throws the oldest item away (the discard
   * op, ADR 0012) when the hold is full and nothing in it was useful. The hold arithmetic is
   * the core's (`newHold`, `itemsDue`, `addItems`, `takeItem`).
   */
  private step(): void {
    const { items } = this.config;
    const now = this.world.now;
    const n = this.players.length;
    // Rotate who goes first so no player always wins the races for a cell.
    const first = this.rng.int(n);
    for (let i = 0; i < n; i++) {
      const player = this.players[(first + i) % n]!;
      const due = itemsDue(player.hold, now, items);
      if (due > 0) {
        const drawn = Array.from({ length: due }, () => this.draw(player.kind));
        player.hold = addItems(player.hold, drawn, items);
      }
      let played = 0;
      for (let k = 0; k < player.hold.items.length; ) {
        const item = player.hold.items[k]!;
        if (this.play(player, item)) {
          this.used[item.kind]++;
          this.byPlayer[player.kind].used[item.kind]++;
          player.hold = takeItem(player.hold, k, now, items);
          played++;
        } else k++;
      }
      if (played === 0 && player.hold.items.length >= items.hold) {
        const { kind } = player.hold.items[0]!;
        player.hold = takeItem(player.hold, 0, now, items);
        this.discarded[kind]++;
        this.byPlayer[player.kind].discarded[kind]++;
      }
    }
  }

  private draw(by: PlayerKind): Item {
    const { state } = this.world;
    const drawn = drawFor(state, this.config.items.rates[this.phase()], this.config, this.rng);
    if (drawn.singleAsBrick) this.convertedSingles++;
    if (drawn.brickAsShield) this.bricksAsShields++;
    if (drawn.brickRedrawn) this.bricksRedrawn++;
    const { item } = drawn;
    this.drawn[item.kind]++;
    this.byPlayer[by].drawn[item.kind]++;
    if (item.kind === 'brick') this.drawnShapes[item.shape]!++;
    return item;
  }

  private play(player: Player, item: Item): boolean {
    switch (player.kind) {
      case 'builder':
      case 'repairer':
        return this.maintain(this.arts[player.art]!, item);
      case 'griefer':
        return this.grief(player, item);
      case 'casual':
        return this.casual(item);
    }
  }

  /** Builders and repairers: draw the artwork, fill its holes, remove wrong cells, guard it. */
  private maintain(art: Art, item: Item): boolean {
    const view = this.view(art);
    switch (item.kind) {
      case 'brick':
        // A finished artwork leaves bricks free for the rest of the map.
        return this.artBrick(art, view, item.shape, true) || this.casual(item);
      case 'single':
        // No hole in the artwork: fill one elsewhere rather than throw the item away.
        return (
          this.tryCells(view.holes, 3, (x, y) =>
            this.world.placeSingle(x, y, targetAt(art, x, y)),
          ) || this.casual(item)
        );
      case 'hammer':
        return this.hitWeakest(
          view.wrong,
          (x, y) => colorAt(this.world, x, y) !== targetAt(art, x, y),
        );
      case 'shield':
        return this.guardWeakest(
          view.correct,
          (x, y) => colorAt(this.world, x, y) === targetAt(art, x, y),
        );
    }
  }

  /** Griefers: hammer correct cells, add wrong colours, shield the damage. */
  private grief(player: Player, item: Item): boolean {
    const art = this.arts[player.art]!;
    const view = this.view(art);
    switch (item.kind) {
      case 'brick':
        return this.artBrick(art, view, item.shape, false) || this.casual(item);
      case 'single':
        return (
          this.tryCells(view.holes, 3, (x, y) =>
            this.world.placeSingle(x, y, wrongColor(this.rng, targetAt(art, x, y))),
          ) || this.casual(item)
        );
      case 'hammer': {
        const hit = this.hitWeakest(
          view.correct,
          (x, y) => colorAt(this.world, x, y) === targetAt(art, x, y),
        );
        // Nothing left to break here: move on to another artwork.
        if (!hit && view.correct.length === 0) player.art = this.rng.int(this.arts.length);
        return hit;
      }
      case 'shield':
        return this.guardWeakest(
          view.wrong,
          (x, y) => colorAt(this.world, x, y) !== targetAt(art, x, y),
        );
    }
  }

  /** Casual players: anything, anywhere, any colour. */
  private casual(item: Item): boolean {
    const { world, rng } = this;
    const { open } = world;
    const randomCell = () => [open.x + rng.int(open.w), open.y + rng.int(open.h)] as const;
    switch (item.kind) {
      case 'brick': {
        // Players look for room and tidy up: of a few spots that fit, take the one touching
        // the most filled cells.
        if (this.coverable.length === 0) return false;
        let best: { x: number; y: number; rotation: Rotation; contact: number } | null = null;
        for (let i = 0; i < this.config.search; i++) {
          const index = rng.pick(this.coverable);
          const rotation = rng.int(4) as Rotation;
          const offsets = cellsOf(item.shape, rotation);
          const [ax, ay] = offsets[rng.int(4)]!;
          const x = (index % world.size) - ax;
          const y = Math.floor(index / world.size) - ay;
          const contact = this.contact(x, y, offsets);
          if (contact >= 0 && (!best || contact > best.contact)) best = { x, y, rotation, contact };
        }
        return (
          !!best && world.brick(best.x, best.y, item.shape, best.rotation, rng.int(PALETTE_SIZE))
        );
      }
      case 'single':
        return this.tryCells(this.holes, 3, (x, y) =>
          world.placeSingle(x, y, rng.int(PALETTE_SIZE)),
        );
      case 'hammer':
        for (let i = 0; i < 8; i++) {
          const [x, y] = randomCell();
          if (isFilled(world.state.cells[y * world.size + x]!) && world.hammer(x, y)) return true;
        }
        return false;
      case 'shield':
        for (let i = 0; i < 8; i++) {
          const [x, y] = randomCell();
          if (isFilled(world.state.cells[y * world.size + x]!) && world.shield(x, y)) return true;
        }
        return false;
    }
  }

  /**
   * Places a brick on empty artwork cells. Honest players pick the colour most of its cells
   * want and accept at most one cell off; griefers pick any other colour.
   */
  private artBrick(art: Art, view: ArtView, shape: ShapeId, honest: boolean): boolean {
    if (view.empty.length === 0) return false;
    const { world, rng } = this;
    let best: { x: number; y: number; rotation: Rotation; color: number; score: number } | null =
      null;
    for (let attempt = 0; attempt < 16; attempt++) {
      const index = rng.pick(view.empty);
      const rotation = rng.int(4) as Rotation;
      const offsets = cellsOf(shape, rotation);
      const [ax, ay] = offsets[rng.int(4)]!;
      const ox = (index % world.size) - ax;
      const oy = Math.floor(index / world.size) - ay;
      const wanted = new Map<number, number>();
      let outside = 0;
      let free = true;
      for (const [dx, dy] of offsets) {
        if (!world.isEmptyOpen(ox + dx, oy + dy)) {
          free = false;
          break;
        }
        const target = targetAt(art, ox + dx, oy + dy);
        if (target < 0) outside++;
        else wanted.set(target, (wanted.get(target) ?? 0) + 1);
      }
      if (!free) continue;
      let majority = 0;
      let votes = -1;
      for (const [color, count] of wanted) {
        if (count > votes) [majority, votes] = [color, count];
      }
      const color = honest ? majority : wrongColor(rng, majority);
      const score = honest ? outside + votes : 4;
      if (!best || score > best.score) best = { x: ox, y: oy, rotation, color, score };
      if (score === 4) break;
    }
    if (!best || best.score < 3) return false;
    return world.brick(best.x, best.y, shape, best.rotation, best.color);
  }

  /**
   * Sides of a brick at (x, y) that touch a filled cell or the edge of the open area, or -1
   * when the brick does not fit.
   */
  private contact(x: number, y: number, offsets: readonly (readonly [number, number])[]): number {
    const { world } = this;
    const inBrick = (cx: number, cy: number) =>
      offsets.some(([dx, dy]) => x + dx === cx && y + dy === cy);
    let contact = 0;
    for (const [dx, dy] of offsets) {
      if (!world.isEmptyOpen(x + dx, y + dy)) return -1;
      for (const [nx, ny] of [
        [x + dx + 1, y + dy],
        [x + dx - 1, y + dy],
        [x + dx, y + dy + 1],
        [x + dx, y + dy - 1],
      ] as const) {
        if (!inBrick(nx, ny) && !world.isEmptyOpen(nx, ny)) contact++;
      }
    }
    return contact;
  }

  /** Hammers the least shielded of a few cells that still pass `still`. */
  private hitWeakest(cells: readonly number[], still: (x: number, y: number) => boolean): boolean {
    const index = this.weakest(cells, still, Number.POSITIVE_INFINITY);
    if (index < 0) return false;
    return this.world.hammer(index % this.world.size, Math.floor(index / this.world.size));
  }

  /** Shields the least shielded of a few cells that still pass `still` and have room. */
  private guardWeakest(
    cells: readonly number[],
    still: (x: number, y: number) => boolean,
  ): boolean {
    const index = this.weakest(cells, still, this.config.maxShield);
    if (index < 0) return false;
    return this.world.shield(index % this.world.size, Math.floor(index / this.world.size));
  }

  private weakest(
    cells: readonly number[],
    still: (x: number, y: number) => boolean,
    below: number,
  ): number {
    const { world } = this;
    let best = -1;
    let bestShield = below;
    for (let i = 0; i < Math.min(6, cells.length); i++) {
      const index = this.rng.pick(cells);
      const x = index % world.size;
      const y = Math.floor(index / world.size);
      const shield = world.state.shields[index]!;
      if (isFilled(world.state.cells[index]!) && still(x, y) && shield < bestShield) {
        best = index;
        bestShield = shield;
      }
    }
    return best;
  }

  private tryCells(
    cells: readonly number[],
    tries: number,
    place: (x: number, y: number) => boolean,
  ) {
    for (let i = 0; i < Math.min(tries, cells.length); i++) {
      const index = this.rng.pick(cells);
      if (place(index % this.world.size, Math.floor(index / this.world.size))) return true;
    }
    return false;
  }

  private view(art: Art): ArtView {
    const { world } = this;
    if (art.view?.tick === world.tick) return art.view;
    const view: ArtView = { tick: world.tick, empty: [], holes: [], wrong: [], correct: [] };
    const { rect } = art;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const index = y * world.size + x;
        const cell = world.state.cells[index]!;
        if (isFilled(cell)) {
          (colorOf(cell) === targetAt(art, x, y) ? view.correct : view.wrong).push(index);
        } else if (world.inOpen(x, y)) {
          view.empty.push(index);
          if (!world.canCover(x, y)) view.holes.push(index);
        }
      }
    }
    art.view = view;
    return view;
  }

  /** Repairers move to the most damaged artwork; griefers sometimes switch target. */
  private retarget(): void {
    let worst = 0;
    let worstAccuracy = Number.POSITIVE_INFINITY;
    this.arts.forEach((art, i) => {
      const accuracy = this.view(art).correct.length / (art.rect.w * art.rect.h);
      if (accuracy < worstAccuracy) [worst, worstAccuracy] = [i, accuracy];
    });
    for (const player of this.players) {
      if (player.kind === 'repairer') player.art = worst;
      else if (player.kind === 'griefer' && this.rng.chance(0.25)) {
        player.art = this.rng.int(this.arts.length);
      }
    }
  }

  private snapshot(hour: number): Snapshot {
    const { world } = this;
    const openCells = world.open.w * world.open.h;
    let accuracy = 0;
    let intact = 0;
    let artHoles = 0;
    for (const art of this.arts) {
      art.view = null; // the cached view is from before this tick's moves
      const view = this.view(art);
      const share = view.correct.length / (art.rect.w * art.rect.h);
      accuracy += share;
      if (share >= 0.9) intact++;
      artHoles += view.holes.length;
    }
    const { state } = world;
    return {
      hour,
      openEdge: world.open.w,
      phase: this.phase(),
      fill: world.fillRatio(),
      blocked: blockedCells(state) / openCells,
      shapesFit: fitting(state, this.config.fitMin).length,
      empty: openCells - world.filled,
      holes: holeCount(state),
      singleShare: world.filled ? world.singles / world.filled : 0,
      artAccuracy: this.arts.length ? accuracy / this.arts.length : 0,
      artsIntact: intact,
      artHoles,
      shieldedCells: world.layers.size,
      drawn: { ...this.drawn },
      used: { ...this.used },
      discarded: { ...this.discarded },
    };
  }

  /** Artworks go inside the starting open area, without overlapping when there is room. */
  private placeArts(): void {
    const { config, rng, world } = this;
    const { open } = world;
    const size = Math.min(config.artSize, open.w, open.h);
    for (let i = 0; i < config.arts; i++) {
      let rect: Rect = { x: open.x, y: open.y, w: size, h: size };
      for (let attempt = 0; attempt < 200; attempt++) {
        rect = {
          x: open.x + rng.int(open.w - size + 1),
          y: open.y + rng.int(open.h - size + 1),
          w: size,
          h: size,
        };
        if (!this.arts.some((a) => overlaps(a.rect, rect))) break;
      }
      this.arts.push({ rect, target: paint(rng, size), view: null });
    }
  }

  private createPlayers(): void {
    const { config } = this;
    const total = PLAYER_KINDS.reduce((sum, kind) => sum + config.mix[kind], 0);
    let made = 0;
    PLAYER_KINDS.forEach((kind, k) => {
      const count =
        k === PLAYER_KINDS.length - 1
          ? config.players - made
          : Math.round((config.players * config.mix[kind]) / total);
      for (let i = 0; i < count; i++) {
        // Without artworks only casual play makes sense.
        this.players.push({
          kind: this.arts.length ? kind : 'casual',
          art: (made + i) % Math.max(1, this.arts.length),
          // Every player is first seen at the start, with the core's starting items due.
          hold: newHold(this.world.now, config.items),
        });
      }
      made += count;
    });
  }
}

const ALL_SHAPES: readonly ShapeId[] = SHAPE_NAMES.map((_, shape) => shape as ShapeId);

/** SHAPE_ORIENTATIONS[shape]: the core's orientation indices of its distinct rotations. */
export const SHAPE_ORIENTATIONS: readonly (readonly number[])[] = ORIENTATION_OF.map((o) => [
  ...new Set(o),
]);

/**
 * Shapes, in id order, with at least `min` valid placements over their orientations, read
 * from the core's counters. For `min` 1 this is the core's own list (`drawContext`); higher
 * values are the `--fit-min` experiment.
 */
export function fittingShapes(placements: ArrayLike<number>, min = 1): ShapeId[] {
  return ALL_SHAPES.filter(
    (shape) => SHAPE_ORIENTATIONS[shape]!.reduce((sum, o) => sum + placements[o]!, 0) >= min,
  );
}

/** The shapes the sim's draw counts as fitting: the core's, unless `fitMin` raises the bar. */
function fitting(state: State, fitMin: number): readonly ShapeId[] {
  return fitMin > 1 ? fittingShapes(state.counters.placements, fitMin) : drawContext(state).fitting;
}

/** The parts of the config that decide a draw besides the rates. */
export type DrawRules = Pick<SimConfig, 'shapeDraw' | 'fitMin' | 'noFit' | 'roomScale'>;

/** The ADR 0010 rules, which the core implements: every experiment off. */
export const CORE_DRAW_RULES: DrawRules = {
  shapeDraw: 'fit',
  fitMin: 1,
  noFit: 'shield',
  roomScale: 0,
};

export interface Drawn {
  readonly item: Item;
  /** A single brick drawn while the map had no hole, handed out as a brick or a shield. */
  readonly singleAsBrick: boolean;
  /** A brick (or converted single brick) handed out as a shield since no shape fit. */
  readonly brickAsShield: boolean;
  /** A brick re-drawn as another item by `noFit: 'redraw'` or `roomScale`. */
  readonly brickRedrawn: boolean;
}

/**
 * Draws one item for the map as it is now, with two 32-bit words from `rng` (kind, shape),
 * as the server does. With `CORE_DRAW_RULES` this is exactly the core's `drawFrom` on the
 * core's `drawContext`, that is `drawItem` when `rates` are those of `phaseOf(state)`. The
 * experiments only change the shapes that count as fitting (`shapeDraw: 'any'`, `fitMin`)
 * or re-draw a brick afterwards, among single brick, hammer and shield by their rates, with
 * extra random numbers: a brick no shape fits (`noFit: 'redraw'`), or a brick dropped with
 * probability 1 - min(1, placements / roomScale). A single brick is left out of the re-draw
 * while the map has no hole, and a re-draw with nothing left to draw gives a shield.
 */
export function drawFor(state: State, rates: Rates, rules: DrawRules, rng: Rng): Drawn {
  const kindWord = rng.word();
  const shapeWord = rng.word();
  const context = drawContext(state);
  const shapes = rules.shapeDraw === 'any' ? ALL_SHAPES : fitting(state, rules.fitMin);
  let item = drawFrom({ holes: context.holes, fitting: shapes }, rates, kindWord, shapeWord);
  const rolled = rollKind(rates, kindWord);
  const singleAsBrick = rolled === 'single' && !context.holes;
  let brickAsShield = (rolled === 'brick' || singleAsBrick) && item.kind === 'shield';
  let redraw = brickAsShield && rules.noFit === 'redraw';
  if (item.kind === 'brick' && rules.roomScale > 0) {
    let placements = 0;
    for (const count of state.counters.placements) placements += count;
    const keep = Math.min(1, placements / rules.roomScale);
    if (keep <= 0 && rules.noFit === 'shield') {
      // No room at all (possible with `shapeDraw: 'any'`): a shield, as when nothing fits.
      return { item: { kind: 'shield' }, singleAsBrick, brickAsShield: true, brickRedrawn: false };
    }
    if (keep <= 0 || (keep < 1 && rng.next() >= keep)) redraw = true;
  }
  if (!redraw) return { item, singleAsBrick, brickAsShield, brickRedrawn: false };
  brickAsShield = false;
  const [, single, hammer, shield] = rates;
  const others: Rates = [0, context.holes ? single : 0, hammer, shield];
  const kind: ItemKind = others.some((w) => w > 0) ? rollKind(others, rng.word()) : 'shield';
  item = { kind: kind === 'brick' ? 'shield' : kind };
  return { item, singleAsBrick, brickAsShield, brickRedrawn: true };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A few colour regions with irregular borders (nearest of a handful of seeds). */
function paint(rng: Rng, size: number): Uint8Array {
  const colors = Array.from({ length: 3 + rng.int(3) }, () => rng.int(PALETTE_SIZE));
  const seeds = Array.from({ length: 4 + rng.int(4) }, () => ({
    x: rng.int(size),
    y: rng.int(size),
    color: rng.pick(colors),
  }));
  const target = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let best = seeds[0]!;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const seed of seeds) {
        const distance = (seed.x - x) ** 2 + (seed.y - y) ** 2;
        if (distance < bestDistance) [best, bestDistance] = [seed, distance];
      }
      target[y * size + x] = best.color;
    }
  }
  return target;
}

function targetAt(art: Art, x: number, y: number): number {
  const { rect } = art;
  if (x < rect.x || y < rect.y || x >= rect.x + rect.w || y >= rect.y + rect.h) return -1;
  return art.target[(y - rect.y) * rect.w + (x - rect.x)]!;
}

function colorAt(world: World, x: number, y: number): number {
  return colorOf(world.state.cells[y * world.size + x]!);
}

function wrongColor(rng: Rng, avoid: number): number {
  return (avoid + 1 + rng.int(PALETTE_SIZE - 1)) % PALETTE_SIZE;
}
