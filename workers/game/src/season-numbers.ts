import type { Op } from '@brickplace/core';
import type { RowStore, SeasonRow } from './journal.ts';

// The profile's "Your season" numbers (ADR 0031): per player, the moves this canvas accepted
// from them, by kind, and the days they made one. Counted in the transaction that logs the
// ops, never lowered (a rollback changes the map, not the moves made), emptied with the other
// player tables when the archive is sealed (archive.ts PLAYER_TABLES). For display only: not
// in checkpoints, not rebuilt by a replay. Kept out of the Worker entry (index.ts), which may
// export only handlers and Durable Object classes.

/** What a player sees on the card. */
export interface SeasonNumbers {
  /** Bricks and single bricks placed. */
  readonly bricks: number;
  readonly hammers: number;
  readonly shields: number;
  /** Days (UTC, the ops' logical time) with at least one move. */
  readonly days: number;
}

export const NO_NUMBERS: SeasonNumbers = { bricks: 0, hammers: 0, shields: 0, days: 0 };

const DAY_MS = 24 * 60 * 60 * 1000;

export function createSeasonNumbersTable(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS player_season (player TEXT PRIMARY KEY, ' +
      'bricks INTEGER NOT NULL, hammers INTEGER NOT NULL, shields INTEGER NOT NULL, ' +
      'days INTEGER NOT NULL, last_day INTEGER NOT NULL)',
  );
}

/**
 * Counts accepted moves made at `at` (one batch: one logical time). Call inside the
 * transaction that logs them. The rows go through the canvas's player state (journal.ts,
 * ADR 0042), not straight to the table.
 */
export function countMoves(
  rows: RowStore<SeasonRow>,
  moves: readonly { readonly player: string; readonly op: Op }[],
  at: number,
): void {
  const day = Math.floor(at / DAY_MS);
  const byPlayer = new Map<string, { bricks: number; hammers: number; shields: number }>();
  for (const { player, op } of moves) {
    const counts = byPlayer.get(player) ?? { bricks: 0, hammers: 0, shields: 0 };
    if (op.kind === 'brick' || op.kind === 'single') counts.bricks += 1;
    else if (op.kind === 'hammer') counts.hammers += 1;
    else if (op.kind === 'shield') counts.shields += 1;
    byPlayer.set(player, counts);
  }
  for (const [player, counts] of byPlayer) {
    const old = rows.get(player);
    rows.put(
      player,
      old
        ? {
            bricks: old.bricks + counts.bricks,
            hammers: old.hammers + counts.hammers,
            shields: old.shields + counts.shields,
            // Only a later day counts: a clock that steps back over midnight counts none twice.
            days: old.days + (day > old.last_day ? 1 : 0),
            last_day: Math.max(old.last_day, day),
          }
        : { ...counts, days: 1, last_day: day },
    );
  }
}

/** A player's numbers; zeros when this canvas accepted no move from them (or was sealed). */
export function readSeasonNumbers(rows: RowStore<SeasonRow>, player: string): SeasonNumbers {
  const row = rows.get(player);
  return row
    ? { bricks: row.bricks, hammers: row.hammers, shields: row.shields, days: row.days }
    : NO_NUMBERS;
}
