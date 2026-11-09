import {
  addItems,
  drawItem,
  findItem,
  type Hold,
  type Item,
  type ItemConfig,
  itemsDue,
  newHold,
  nextItemAt,
  type State,
  takeItem,
} from '@brickplace/core';
import type { ItemSegment } from './config.ts';
import type { DrawWords } from './draws.ts';
import type { InventoryRow, RowStore } from './journal.ts';

// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.

/** What a player sees of their hold. */
export interface HoldView {
  readonly items: readonly Item[];
  readonly capacity: number;
  /** Length of one cooldown (ms). */
  readonly cooldown: number;
  /** When the next item arrives (ms, the canvas's clock), or null when none is coming. */
  readonly nextAt: number | null;
  /**
   * Bumped by every write of this hold, so a reader that gets two views out of order keeps
   * the newer one. Equal revisions show the same hold.
   */
  readonly revision: number;
}

/** An item taken out of a hold for an op whose outcome is not known yet. */
export interface Reservation {
  readonly player: string;
  readonly before: Hold;
}

/**
 * The inventory interface ADR 0003 asks for: reserve an item when an op arrives, then commit
 * it if the op is accepted or refund it if not. Today it is one SQLite table in CanvasDO;
 * once the map is split, a SessionDO can implement it across objects.
 */
export interface Inventory {
  reserve(player: string, item: Item, at: number): Reservation | null;
  commit(reservation: Reservation): void;
  refund(reservation: Reservation): void;
}

/** Looks up the PRF words of one draw; undefined when they are not available (no key). */
export type WordSource = (player: string, index: number) => DrawWords | undefined;

/**
 * The item configs a hold stamped with `version` has lived under since, up to the batch's
 * time, oldest first (ConfigSchedule.itemsHistory). The last one is the config in force.
 * Null when `version` takes effect only after that time.
 */
export type ItemHistory = (version: number) => readonly ItemSegment[] | null;

interface Entry {
  hold: Hold;
  /** Draws made for this player so far; the next draw uses this index. */
  drawIndex: number;
  /** Revision as stored; one more once a dirty entry is flushed. */
  revision: number;
  /** The item config version the hold is counted under (ADR 0022). */
  version: number;
  dirty: boolean;
}

/**
 * A hold moved from one item config to the next at `at` (ADR 0022), after it has drawn
 * everything due under the old one up to then:
 * - full under the old config (or the new one): the count starts again at `at`, so a larger
 *   hold or a shorter cooldown gives no burst of items for the time spent full;
 * - a cooldown under way keeps the share of the old cooldown it had run, and runs the rest
 *   at the new length from `at`: halfway through 60 s, then 120 s, the item arrives 60 s
 *   after `at`. Integer arithmetic (BigInt: two u32 lengths), so every port agrees.
 */
export function restamp(hold: Hold, from: ItemConfig, to: ItemConfig, at: number): Hold {
  if (hold.since >= at) return hold;
  const full = hold.items.length >= from.hold || hold.items.length >= to.hold;
  if (full) return { items: hold.items, since: at };
  const elapsed = Math.min(at - hold.since, from.cooldown);
  const share = Number((BigInt(elapsed) * BigInt(to.cooldown)) / BigInt(from.cooldown));
  return { items: hold.items, since: at - share };
}

/**
 * Brings a hold stamped under the first segment's config up to `at`: draws what each config
 * made due before the next took over, then restamps. Stops where `draw` runs out of words,
 * at that segment's version, so the rest is done when words are there again.
 */
export function advance(
  hold: Hold,
  segments: readonly ItemSegment[],
  at: number,
  draw: (config: ItemConfig) => Item | undefined,
): { hold: Hold; drawn: number; version: number } {
  let current = hold;
  let drawn = 0;
  for (let i = 0; i < segments.length; i++) {
    const { config } = segments[i]!;
    const next = segments[i + 1];
    const due = itemsDue(current, next ? next.since : at, config);
    const items: Item[] = [];
    for (let k = 0; k < due; k++) {
      const item = draw(config);
      if (!item) break;
      items.push(item);
    }
    if (items.length > 0) current = addItems(current, items, config);
    drawn += items.length;
    if (!next || items.length < due) return { hold: current, drawn, version: config.version };
    current = restamp(current, config, next.config, next.since);
  }
  return { hold: current, drawn, version: segments.at(-1)?.config.version ?? 0 };
}

/** Creates the inventory table. No released version had another layout, so no upgrade. */
export function createInventoryTable(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS inventory (player TEXT PRIMARY KEY, items TEXT NOT NULL, ' +
      'draw_index INTEGER NOT NULL, since INTEGER NOT NULL, config_version INTEGER NOT NULL, ' +
      'revision INTEGER NOT NULL DEFAULT 0)',
  );
}

/**
 * The holds touched by one batch, read on first use and written back by `flush`, which the
 * caller runs inside the transaction that logs the batch's ops: a consumed item and the op's
 * dedupe key become durable together, so a retried op never consumes twice. The rows go
 * through the canvas's player state (journal.ts, ADR 0042), not straight to the table.
 *
 * Items arrive lazily: the first look at a hold draws every item whose cooldown has passed,
 * with the map as it is at that moment (phase, holes, fitting shapes).
 */
export class InventoryBatch implements Inventory {
  private readonly entries = new Map<string, Entry>();

  /**
   * `config` is the item config in force at the batch's time; `history` names the ones a
   * hold stamped with an older version went through since (no history: only `config`).
   */
  constructor(
    private readonly rows: RowStore<InventoryRow>,
    private readonly config: ItemConfig,
    private readonly grid: State,
    private readonly words: WordSource,
    private readonly history: ItemHistory = () => [{ config, since: Number.NEGATIVE_INFINITY }],
  ) {}

  /** Draw indices `player` needs words for at `at`, without changing anything. */
  static needed(
    rows: RowStore<InventoryRow>,
    config: ItemConfig,
    player: string,
    at: number,
    history: ItemHistory = () => [{ config, since: Number.NEGATIVE_INFINITY }],
  ): number[] {
    const { hold, drawIndex, version } = read(rows, config, player, at);
    // Counting only: which items come out does not change how many are due.
    const placeholder: Item = { kind: 'shield' };
    const { segments, known } = segmentsFor(config, history, version);
    // A call before the hold's version took effect draws nothing (see accrue).
    if (!known) return [];
    const { drawn } = advance(hold, segments, at, () => placeholder);
    return Array.from({ length: drawn }, (_, i) => drawIndex + i);
  }

  reserve(player: string, item: Item, at: number): Reservation | null {
    const entry = this.load(player, at);
    const index = findItem(entry.hold, item);
    if (index < 0) return null;
    const before = entry.hold;
    entry.hold = takeItem(entry.hold, index, at, this.config);
    entry.dirty = true;
    return { player, before };
  }

  commit(_reservation: Reservation): void {
    // The item already left the hold in reserve; flush makes that durable.
  }

  refund(reservation: Reservation): void {
    const entry = this.entries.get(reservation.player);
    if (!entry) throw new Error('refund without a reservation');
    // Back as it was, cooldown included: a refused op costs nothing.
    entry.hold = reservation.before;
  }

  /** The player's hold at `at`, after drawing the items that have arrived. */
  view(player: string, at: number, drawing: boolean): HoldView {
    const entry = this.load(player, at);
    const { hold } = entry;
    const nextAt = nextItemAt(hold, this.config);
    return {
      items: hold.items,
      capacity: this.config.hold,
      cooldown: this.config.cooldown,
      // Without the draw key nothing will arrive: show no countdown that never ends.
      nextAt: drawing ? nextAt : null,
      // A dirty entry is flushed in the same synchronous step, before this view leaves.
      revision: entry.revision + (entry.dirty ? 1 : 0),
    };
  }

  get dirty(): boolean {
    for (const entry of this.entries.values()) if (entry.dirty) return true;
    return false;
  }

  /** Writes every changed hold. Call inside the batch's transaction. */
  flush(): void {
    for (const [player, entry] of this.entries) {
      if (!entry.dirty) continue;
      this.rows.put(player, {
        items: JSON.stringify(entry.hold.items),
        draw_index: entry.drawIndex,
        since: entry.hold.since,
        config_version: entry.version,
        revision: entry.revision + 1,
      });
      entry.revision += 1;
      entry.dirty = false;
    }
  }

  private load(player: string, at: number): Entry {
    let entry = this.entries.get(player);
    if (!entry) {
      const { hold, drawIndex, revision, version, isNew } = read(
        this.rows,
        this.config,
        player,
        at,
      );
      entry = { hold, drawIndex, revision, version, dirty: isNew };
      this.entries.set(player, entry);
    }
    this.accrue(player, entry, at);
    return entry;
  }

  /**
   * Draws the items whose cooldowns have passed, in draw index order, while words last,
   * living through every item config that took over since the hold was last written.
   */
  private accrue(player: string, entry: Entry, at: number): void {
    const { segments, known } = segmentsFor(this.config, this.history, entry.version);
    // A call whose time comes before the version the hold is counted in: its `since` is in
    // that version's units, so counting it under an earlier config would hand out items from
    // nothing. The hold stays as it is until a call at or after that version.
    if (!known) return;
    let index = entry.drawIndex;
    const result = advance(entry.hold, segments, at, (config) => {
      const words = this.words(player, index);
      if (!words) return undefined;
      index += 1;
      return drawItem(this.grid, config, words[0], words[1]);
    });
    if (result.hold === entry.hold && result.version === entry.version) return;
    entry.hold = result.hold;
    entry.drawIndex += result.drawn;
    entry.version = result.version;
    entry.dirty = true;
  }
}

/** The configs a hold stamped with `version` goes through; just `config` when current. */
function segmentsFor(
  config: ItemConfig,
  history: ItemHistory,
  version: number,
): { segments: readonly ItemSegment[]; known: boolean } {
  const only = [{ config, since: Number.NEGATIVE_INFINITY }];
  if (version === config.version) return { segments: only, known: true };
  const segments = history(version);
  // The version the hold was stamped with takes effect after the batch's time: a call out of
  // time order. It neither draws nor restamps (accrue, needed), so the hold is never counted
  // in the wrong units and never restamped twice later.
  if (!segments || segments.length === 0) return { segments: only, known: false };
  return { segments, known: true };
}

function read(rows: RowStore<InventoryRow>, config: ItemConfig, player: string, at: number) {
  const row = rows.get(player);
  if (!row) {
    const hold = newHold(at, config);
    return { hold, drawIndex: 0, revision: 0, version: config.version, isNew: true };
  }
  // A hold stored under an older config is brought through each newer one (advance) the
  // first time it is looked at, and stamped with the one in force on the next write.
  return {
    hold: { items: JSON.parse(row.items) as Item[], since: row.since },
    drawIndex: row.draw_index,
    revision: row.revision,
    version: row.config_version,
    isNew: false,
  };
}
