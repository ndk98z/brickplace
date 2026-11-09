# 0042. Canvas writes per tick

- Status: proposed (phase 1 built, 2026-10-27)
- Date: 2026-10-27
- Relates to: 0003 (Stage 0), 0007 (logical time), 0012 (inventory), 0014 (op log and
  checkpoints), 0017 (dedupe), 0020 (team ledger), 0021 (season close, seal), 0024
  (rollback), 0028 (ticks), 0031 (season numbers), 0041 (batched relays); design doc, tab
  "Scale triệu CCU" (row "SQLite ghi")

## Context

The design doc prices SQLite writes at "1 row per tick" and names "1 row per op" as one of
the three mistakes that triple the bill ($0-1,000 a month at 1M CCU against $17k-86k). The
canvas wrote per op, about 10 rows written for each accepted op: its `op_log` row and the
later trim, the dedupe key in `accepted_ops` and the window's delete (with their index), the
player's `inventory` and `player_season` rows, and `team_credit` when the op counts for a
team (plus `writers` on a player's first op). Every item drawn wrote the hold again, and
every discard its dedupe key and hold. The first shard measurement (PROGRESS.md) saw 72,000
rows written by the CanvasDO in 10 minutes under 2,000 bots. At list prices (USD 1 per
million rows past 50 million a month on Workers Paid), 2,000 players online on average for
the 5 days a month the owner plans come to roughly USD 13 a month at 0.5 ops a minute (the
design doc's rate) and USD 71 at 1, USD 5 of it the plan and almost all the rest rows, with
ADR 0041 in. ADR 0041 batches calls and shares the `op_log` row and its trim per batch, about
8 rows per op left.

## Decision

**Phase 1 (built): a journal of the player state.** Holds, daily team credit, season numbers
and the dedupe window live in memory over their tables (`workers/game/src/journal.ts`). Each
write that changes any of them adds one row to `state_journal` (several when its rows pass
1 MB, `JOURNAL_ROW_BYTES`, below SQLite's 2 MB per row), in the transaction that logs its ops:
the dedupe keys it accepted (column `k`) and the end values of the player rows it changed
(`r`). Every 5 minutes (`STATE_FOLD_MS`, at maintenance), and at once while the season closes,
a fold writes each row changed since the last fold to its table, once, and deletes the journal
rows that held only rows; rows with dedupe keys stay until those keys leave the window, and a
row leaving the window is folded first, so under a high op rate a fold also runs inside the
write that moves the window (about every DEDUPE_WINDOW keys). A fold is a write: a failed one
restarts the object, and memory changes only after its last statement. A start reads the keys
of every keyed row and the rows of the journal rows after the fold, and keeps a hold the
table has at a later revision (a game script that ignored the journal wrote it). Because the
journal holds end values, nothing is replayed through the item rules and no core, log format
or golden fixture changes. `accepted_ops` keeps the keys from before, read until the window
first moves and deleted then; `state_journal` is one of the seal's player tables, and memory
forgets it once the seal's transaction went through. Replies still leave right after their own
write, as before: no latency is added.

**Phase 2 (not built): commit ticks.** CanvasDO would commit what was accepted at most every
100 ms (at once after a quiet spell) in one transaction, so several batches share one journal
row, reply only after their tick committed, and push its shards right after each commit
(still at most every `PUSH_MS`, ADR 0028). Whether it is worth its latency (an ack about 50 ms
later on average when busy) is decided on the measurement of phase 1.

The intervals are constants in the game script, like `PUSH_MS`; making them settings (config
versions, ADR 0022) is left for later.

## Consequences

- Rows, phase 1 (estimates, to be checked with the next 2,000-bot run against the 72,000 rows
  in 10 minutes): per write, the `op_log` row and its trim plus one journal row and its later
  delete; per player whose rows changed, at most one row per table every 5 minutes; a call
  to `holds()` that draws for many players is one journal row, not one per player. About
  4 rows per op when each call carries one op (a quiet map, one shard), about 1-2 when ADR
  0041's batches carry several, against about 8 before.
- Memory: the dedupe window as a Set (100,000 keys, about 10 MB) and the rows changed in the
  last 5 minutes. A start reads the keys of every keyed row (up to the window's) and the rows
  of every journal row after the fold (up to 5 minutes of writes); watch its time, and the
  fold's, in the 2,000-bot measurement.
- Rolling the game script back past this change loses up to 5 minutes of holds, credit and
  season numbers and every dedupe key since the deploy (the old code ignores the journal): a
  retried op whose ack was lost could apply twice. No call forces a fold, so such a rollback
  accepts that loss; rolling forward again keeps a table hold of a later revision, but credit
  and season numbers from the journal win over what the old code wrote meanwhile, and the
  first move of the window deletes the keys the old code wrote.
- Correctness: tests restart a canvas before and after a fold and check holds, season
  numbers, team credit and duplicate answers, split rows, the old keys and the revision rule
  (`workers/game/test/journal.test.ts`), the fold before a row leaves the window
  (`canvas.test.ts`), and that the seal leaves no journal row or key in memory. Code or tests
  that read or write the player tables directly fold first (`foldNow`), since the newest rows
  may still be in memory.
- A failed write restarts the object as before (`ctx.abort`): memory never keeps a change
  storage lost, and the journal row went in the same transaction as the ops.
- Out of scope: phase 2, the intervals as settings, sharding the canvas, and the client
  drawing a move before its ack.
