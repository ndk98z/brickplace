import type { CellDiff } from '@brickplace/core';

// The changes a CDN segment brings to tiles a page already shows, drawn a few at a time until
// the next poll instead of all at once (CdnFeed, SPREAD_MS): a watcher sees the map change
// steadily rather than in a burst every few seconds. Segments carry end values in cell order,
// with no timing, so the order here is random: it is not the order the moves were made in.
// Cells linked to each other (one brick placed, or one brick knocked out) go in one step, so
// no brick shows half drawn.

interface Entry {
  readonly index: number;
  readonly cell: number;
  readonly shield: number;
  readonly tile: number;
  due: number;
  /** Superseded by a newer value for the same cell, or dropped with its tile. */
  dead: boolean;
}

/**
 * Changes waiting to be drawn, by due time. A cell waits at most once: a newer value replaces
 * the one waiting (values are end values, so the older one would be overwritten anyway).
 */
export class Spread {
  /** Sorted by `due` from `head` on; entries before `head` are drawn. */
  private queue: Entry[] = [];
  private head = 0;
  /** The live entry of each waiting cell. */
  private readonly byCell = new Map<number, Entry>();
  /**
   * For each tile with changes waiting since the queue was last empty: the seq its cells in
   * the store were at before them, the seq the store is surely at if they are never drawn.
   */
  private readonly from = new Map<number, number>();
  /** Cells waiting per tile, so a tile's rollback seq is forgotten once its last is drawn. */
  private readonly perTile = new Map<number, number>();

  /** Cells waiting. */
  get size(): number {
    return this.byCell.size;
  }

  /** When the next change is due, or null when none waits. */
  get nextDue(): number | null {
    while (this.head < this.queue.length && this.queue[this.head]!.dead) this.head++;
    return this.queue[this.head]?.due ?? null;
  }

  /**
   * Queues `diffs` (in order: a later one for a cell wins), drawn in random order spread
   * evenly over `spreadMs` from `now`. `tileOf` places a cell; `seqOf` is the seq a tile is
   * at before these changes; `linked` names the cells a cell is linked to (by its new value or
   * its old one): those of the batch are drawn in the same step.
   */
  add(
    diffs: readonly CellDiff[],
    now: number,
    spreadMs: number,
    random: () => number,
    tileOf: (index: number) => number,
    seqOf: (tile: number) => number,
    linked: (index: number, cell: number) => readonly number[] = () => [],
  ): void {
    const batch: Entry[] = [];
    for (const { index, cell, shield } of diffs) {
      const waiting = this.byCell.get(index);
      const tile = tileOf(index);
      if (waiting) waiting.dead = true;
      else this.perTile.set(tile, (this.perTile.get(tile) ?? 0) + 1);
      if (!this.from.has(tile)) this.from.set(tile, seqOf(tile));
      const entry: Entry = { index, cell, shield, tile, due: 0, dead: false };
      this.byCell.set(index, entry);
      batch.push(entry);
    }
    const live = batch.filter((e) => !e.dead);
    // Linked cells of the batch form groups (union-find), each drawn in one step.
    const position = new Map<number, number>();
    live.forEach((entry, i) => {
      position.set(entry.index, i);
    });
    const parent = live.map((_, i) => i);
    const root = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };
    live.forEach((entry, i) => {
      for (const other of linked(entry.index, entry.cell)) {
        const j = position.get(other);
        if (j !== undefined) parent[root(i)] = root(j);
      }
    });
    const byRoot = new Map<number, Entry[]>();
    live.forEach((entry, i) => {
      const r = root(i);
      const group = byRoot.get(r);
      if (group) group.push(entry);
      else byRoot.set(r, [entry]);
    });
    const groups = [...byRoot.values()];
    for (let i = groups.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [groups[i], groups[j]] = [groups[j]!, groups[i]!];
    }
    groups.forEach((group, i) => {
      for (const entry of group) entry.due = now + (spreadMs * (i + 1)) / groups.length;
    });
    live.sort((a, b) => a.due - b.due);
    // Both lists are sorted by due: merge them, leaving out what is dead.
    const rest = this.queue.slice(this.head).filter((e) => !e.dead);
    const merged: Entry[] = [];
    let a = 0;
    let b = 0;
    while (a < rest.length || b < live.length) {
      if (b >= live.length || (a < rest.length && rest[a]!.due <= live[b]!.due)) {
        merged.push(rest[a++]!);
      } else {
        merged.push(live[b++]!);
      }
    }
    this.queue = merged;
    this.head = 0;
  }

  /** Takes the changes due by `now` (all of them by default), oldest first. */
  take(now = Number.POSITIVE_INFINITY): CellDiff[] {
    const out: CellDiff[] = [];
    while (this.head < this.queue.length && this.queue[this.head]!.due <= now) {
      const entry = this.queue[this.head++]!;
      if (entry.dead) continue;
      this.byCell.delete(entry.index);
      out.push({ index: entry.index, cell: entry.cell, shield: entry.shield });
      // The tile's last change drawn: the store is at the seq it counts as, no rollback left.
      const left = (this.perTile.get(entry.tile) ?? 1) - 1;
      if (left > 0) this.perTile.set(entry.tile, left);
      else {
        this.perTile.delete(entry.tile);
        this.from.delete(entry.tile);
      }
    }
    if (this.byCell.size === 0) this.clear();
    return out;
  }

  /**
   * Takes every change waiting for `tiles`, oldest first, whatever its due time: the caller
   * draws them now, before newer changes to those tiles drawn at once.
   */
  takeTiles(tiles: ReadonlySet<number>): CellDiff[] {
    const out: CellDiff[] = [];
    if (tiles.size === 0 || this.byCell.size === 0) return out;
    for (let i = this.head; i < this.queue.length; i++) {
      const entry = this.queue[i]!;
      if (entry.dead || !tiles.has(entry.tile)) continue;
      entry.dead = true;
      this.byCell.delete(entry.index);
      out.push({ index: entry.index, cell: entry.cell, shield: entry.shield });
    }
    for (const tile of tiles) {
      this.from.delete(tile);
      this.perTile.delete(tile);
    }
    if (this.byCell.size === 0) this.clear();
    return out;
  }

  /**
   * The seq tile `tile` of the store is surely at while changes for it still wait: what it was
   * at before them. Undefined when none waits.
   */
  baseOf(tile: number): number | undefined {
    return this.from.get(tile);
  }

  /** Forgets the changes waiting for `tiles` (they were reloaded whole, at a newer seq). */
  drop(tiles: ReadonlySet<number>): void {
    this.takeTiles(tiles);
  }

  /**
   * Forgets every change waiting and returns, per tile that had some, the seq the store is
   * surely at for it: the caller must not count those changes as drawn.
   */
  discard(): Map<number, number> {
    const from = new Map(this.from);
    this.clear();
    return from;
  }

  private clear(): void {
    this.queue = [];
    this.head = 0;
    this.byCell.clear();
    this.from.clear();
    this.perTile.clear();
  }
}
