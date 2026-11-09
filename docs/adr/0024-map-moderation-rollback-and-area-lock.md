# 0024. Map moderation: rollback, area lock and the seal's removals

- Status: accepted
- Date: 2026-10-24 (proposed), 2026-10-25 (accepted; owner decisions at the end)
- Amends: 0013 (a third kind of log entry), 0014 (checkpoint copies in OPLOG, §10), 0020
  (restored cells and the ledger), 0021 (the seal's removals and how the archive replays them;
  the seal deletes the checkpoint copies)

## Context

PROGRESS.md asks for "rollback by area / time range / player" and an "area lock". A raid or a
griefer can wreck art or draw something offensive within minutes; moderators need to undo it
and to stop more of it while they look. Constraints: game rules live only in
`packages/core` and every grid change must replay from the op log (ADR 0013, 0014); the log
is trimmed from SQLite about once a minute and lives on in R2 segments; a SQLite row holds at
most 2 MB; a Durable Object has 128 MB; the team ledger (ADR 0020) and the CDN (ADR 0014)
follow the grid op by op; the sealed archive leaves `removals` out (ADR 0021).

## Decision

1. **A rollback means "as if those ops had never been accepted".** A rollback names any of:
   a player, an area (the op's anchor cell, as in the seal's removals) and a time range. The
   target map is a replay of the log that leaves out the matching player ops; every other
   entry replays as before, so a later op that no longer applies (a brick placed in a hole a
   griefer's hammer made, a hammer on a brick that is now gone) drops out too. Rejected: "the
   value before the first removed op touched the cell", which breaks bricks apart (a later
   brick in the hole keeps three cells linked to a cell that is art again) and has no answer
   for shield layers; replay-without gives a grid some real history produces, so every core
   invariant holds by construction, and it is what the seal already does with removals.
   - The time range is resolved to a seq window: from the first row of player ops at or after
     its start up to the row before the first one after its end (at most "now").
   - **Time still passes.** Every row of player ops moved the live clock when it was accepted,
     so a replay that leaves ops out moves its clock to the row's `at` even when none of its
     ops is kept (core `passTime`). Without that, shield expiry could differ after a removed
     op that was the latest. The archive's own replay follows the same rule (it did not).
2. **A `restore` log entry carries the result** (core, `packages/core/src/restore.ts`):
   `{"kind": "restore", "cells": [[index, cell, ...expiries], ...]}`, every cell whose byte,
   shield count or layer times differ between the live grid and the target, with the target's
   value. `applyEntry` is its only entry point; it checks the whole entry before changing
   anything (filled cells in the open area, empty cells zero, links landing on a filled cell
   of the same colour both from and into listed cells, at most `maxShield` layers each after
   the clock and no later than `clock + shieldLifetime`, sorted indices and times) and refuses
   it as `invalid` otherwise. Counters change through `fillCell`/`clearCell` only; restored
   layers enter the expiry queue at their place in time. It takes no time, like `open`. Its
   own log row (no `who` per op; see 4), so replay, checkpoints, log shipping, trimming and
   the CDN need nothing new. Golden fixture `restore`; core property tests show that after
   any two rollbacks the live grid equals the replay without, keeps behaving like it, and
   that a plain replay or checkpoint plus tail of the log with its restore rows gives the same
   bytes.
   - **The invariant that makes it compose:** the live map always equals a replay of the
     log's player ops and growth rows that leaves out the ops of every rollback applied so far
     and skips restore rows. So a replay that leaves ops out (a later rollback's preview, the
     sealed archive) leaves out every earlier rollback's ops and skips restore rows; a plain
     replay (restart, checkpoint, the seal's verifying pass) applies restore rows.
   - At most `MAX_RESTORE_CELLS` (65,536, a 256² tile) and `MAX_RESTORE_BYTES` (1.5 MB of
     entry plus `who`) per rollback: SQLite takes 2 MB a row, and a cell with five layers is
     about 84 bytes of JSON, so cells alone do not bound it. A larger one is refused before
     anything changes (the preview says `tooLarge`); narrow the area or time. `restoreEntry`
     stops one cell past the limit, so a huge difference is never held in memory.
3. **Where history comes from** (`workers/game/src/rollback.ts`). A job replays two maps: the
   baseline (every earlier rollback left out), which must equal the live map at the end or the
   job fails and nothing changes (as the seal's first pass), and the target (the new filter
   too). It starts from the SQLite checkpoint when the window starts after it and no rollback
   logged after the checkpoint reaches back before it; otherwise from the newest hourly R2 copy
   of a checkpoint (§10) that meets the same two conditions (its listed clock before the
   window's start, so older copies are never downloaded); otherwise from an empty map at seq 0.
   From there it reads the R2 segments (ADR 0014, rows with `who`) up to where SQLite takes
   over. A filter without a start time (a player's whole season) always starts at seq 0. While a
   job exists, or is being started, the canvas does not trim its log, so the rows after its
   start stay in SQLite. The job is driven by the preview calls (25 R2 segments, about a
   minute of a busy log each, and 20,000 SQLite rows per call), lives in memory only (a
   restart or deploy drops it; preview again), one at a time (a new preview replaces it, but
   a moderator's never replaces an owner's: `busy`), and is dropped 15 minutes after its last
   call (an alarm is set at that deadline).
   - Memory: two 2048² states (about 12 MiB each for cells, shields and counters) and a writer
     per cell (16 MiB) beside the live grid and ledger, about 70 MiB, plus each state's shield
     expiries: per live layer an array slot in its cell's list and a queue entry (about
     100 bytes with JS overhead), so a map with a million live layers (maxShield 5, 48 h)
     would add some 100 MiB per state. A job is therefore not started (`too_large`) when
     `rollbackMemory(live)`, that estimate for the live map and three states, passes
     `MAX_ROLLBACK_MEMORY` (100 MiB of the object's 128 MB). At 2048² the cells alone take
     about 68 MiB (3 × (3 × 4 Mi) + 8 × 4 Mi bytes), leaving room for about 110,000 live
     layers (300 bytes each, three states). A busy map can pass that during a raid, exactly
     when a rollback is wanted. The checkpoint copies (§10) could let a job keep one state
     instead of two by checking the baseline against a stored hash: about 200,000 then. Not
     built: the copies bound the replay's time, not its memory, and the baseline replay is what
     proves the log rebuilds the live map before anything is applied.
   - Starting from a checkpoint (SQLite's or a copy) also holds, for a moment, the copy's gzip
     bytes (1-2 MB) and the encoded checkpoint (2 bytes a cell plus 8 a layer and 12 a queued
     expiry, about 8 MiB at 2048²) while the two states are decoded; they fit in the 28 MB the
     budget leaves of the object's 128 MB and are dropped before the replay starts.
   - At most `MAX_ROLLBACKS` (1,000, as `MAX_REMOVALS`) rollbacks per canvas, so the seal's
     removals stay bounded (`full`).
   - CPU: each call replays its rows synchronously, twice; ops wait that long (a fraction of a
     second per call), as they do for a checkpoint. Apply replays only the rows since the last
     preview.
   - The window is not limited. A rollback whose window starts at a known time replays the log
     from the newest copy before it (§10): about an hour within the last two days of copies, up
     to a day further back, plus the window itself. One by player alone, or one after a later
     rollback that reaches back before every usable copy, still replays the season from seq 0.
4. **Team ledger: restored cells go back to the writer the replay gives them**, the player and
   the team they counted for when they were written; cells the rollback empties leave their
   team. Not "nobody": a raid that hammers a team's art would otherwise still cost that team
   its standing after moderators restored it. Totals (built, cleared, shields) are history and
   do not change. A filled cell the map already shows right but whose writer differs from the
   replay's (a hole refilled the same way by an op the rollback drops) is listed too, with its
   live value, so the ledger matches the replay exactly (`writersOnly` in the preview). The
   restore row's `who` is `[{"pairs": [[player, team], ...], "of": [n,
   ...]}]`: for each listed cell the 1-based pair, 0 for nobody (`parseWho` reads it as no
   per-op `who`). The live canvas and a replay feed it to `TeamLedger.restore`; the seal
   renames its players like any `who`.
5. **Dry run.** `CanvasDO.rollbackPreview(filter)` answers "running" (with progress) until the
   replay has caught up, then the restore it would log right now: cells set, filled, emptied,
   recoloured, with changed shields, the ops left out, the seq window, the bounding box, the
   tiles touched, the seq the replay started from and a sample of cells.
   `rollbackApply(job, filter)` (the job must be for that filter) catches up with what came in
   since, builds the entry against the live map at that moment and logs it, synchronously
   between two ops (not queued behind them); with no op in between it is exactly the
   preview (tested). A rollback whose window holds no op records nothing. Refused once the
   season is past its end (`ended`); allowed while the map is read-only.
6. **Area lock: worker-level, not logged.** Up to 16 rectangles in the canvas's meta, each with
   an optional end on the logical clock and a note. An op with any cell in a lock is refused
   with `locked` before its item is reserved (ack status 251, appended; nothing logged, so
   replay never needs locks). Unlock removes one; an expired one is dropped by maintenance.
   Players see locks through the config frame (bytes appended after `maxShield`: a count and
   `x, y, w, h` each; older clients ignore them) and spectators through the manifest's `locks`.
   The rules list the stored locks and carry `locksRev`, which grows with every change,
   expiry included (an alarm is set at each end), so FanoutDO sends a changed list even at
   the same seq and never takes an older list back.
   - **Sockets learn of a change at once.** After a rollback, a lock or an unlock, the admin
     Worker calls `FanoutDO.refresh()` on the canvas's FanoutDO (the binding lane J's kick
     uses; the game Worker binds no FanoutDO and needs no migration): it resyncs the sockets
     when the canvas logged a row and sends the new rules. If that call fails, the change
     reaches them with the next op reply or resync, like an admin growth; a paused map has
     none, which is why the call is made.
7. **Seal removals.** Each applied rollback is kept in meta `rollbacks` (written with its
   restore row): `{from, to, area?, player?}` plus its seq and cell count. The seal's removals
   are those plus the list `setRemovals` keeps (archive-only removals, e.g. after the end).
   `Removal` gains an optional `player`; `season.json` names it by its pseudonym. The archive
   leaves restore rows out (archived as `{seq, at, ops: [], restored: n}`, which takes no
   time, unlike a row whose ops were all removed; counted in `season.json`) and, with only
   rollback removals, its own replay reaches the live final map (tested; logged loudly, not
   blocking, if it ever does not). At the seal, `rollbacks`, the archive-only removals that
   name a player and restore rows' `who` get the same pseudonyms, and the locks go (their
   notes are a moderator's free text; a sealed canvas takes no op).
   - `ARCHIVE_FORMAT` stays 1: no season has been sealed yet, so no archive of the earlier
     shape exists, and readers of format 1 are told of `restored` rows and of time passing for
     emptied rows here and in ADR 0021. Once one exists, a change of this kind bumps it.
8. **Admin** (`workers/admin/src/map.ts`, its own route and page blocks): look up a cell's last
   writer, preview a rollback (polling), apply it, list rollbacks, list/lock/unlock areas.
   Changes go through `acting()` (audit rows before and after) with a reason. Moderators may
   do all of it except a rollback without a player: it undoes every player's ops in its area
   and time range, and an area may be the whole map, so it needs an owner (refusals are
   audited). Nicknames are resolved to account ids from the accounts database. Reasons and
   lock notes go through ADR 0023's `personalData` (no addresses, long numbers, or the names
   the rolled-back player holds or held); the audit rows may keep account ids, as ADR 0023's
   do. The report queue's "Roll back this player" fills the rollback form's account field.
9. **Tests and their reach.** Each check of a restore entry is refused on its own cell in the
   core tests and, for the main ones, in the golden fixture. Mutating `restore.ts` (31
   mutants from the review) fails the core tests for all but two equivalent ones: a link down
   from the last row reads past the grid and is refused as a link to an empty cell, and a
   one-item tuple is refused by the cell byte check. Behaviour mutants of the job (time
   passing, the baseline check, trimming, the idle deadline, the memory budget, the owner's
   job), the archive (time passing, renamed removals, dropped locks), FanoutDO (rules order,
   refresh) and the admin routes (owner rule and reasons on apply) each fail a test.
10. **Checkpoint copies in R2** (`workers/game/src/copies.ts`; question 3, built). They bound a
    rollback's replay (§3) and are ADR 0014's disaster-recovery copy.
    - **What and where.** The stored checkpoint as it is in SQLite, not re-encoded: the grid's
      gzip parts, then the team checkpoint's (ADR 0020) stored at the same seq, in one object
      `c/{canvas}/checkpoints/{seq:012}.ckpt` in OPLOG (private). `customMetadata` holds the
      copy format, seq, logical clock (stored with the checkpoint from now on), write time, the
      grid's gridHash and the SHA-256 of each part's body, and each part's byte length; the
      upload carries the SHA-256 of the whole object, which R2 checks.
    - **Never half read.** An R2 put is atomic (an object is whole or absent), and a reader
      takes a copy only when its length is the two parts' lengths, both bodies match their
      SHA-256, the decoded grid matches its gridHash and the map size, and the listed clock is
      the state's. Anything else is refused and the next older copy is tried.
    - **Cadence.** In maintenance, after log shipping: the stored checkpoint is copied when it
      is newer than the last copy and that copy is an hour old (wall clock; the first one at
      once), so at most one an hour of activity and none while idle (an alarm is set for the
      last checkpoint of a burst). While the season closes, the final checkpoint is copied at
      once and closing waits for it; once ended, none is taken. A failing copy backs off from
      10 s to hourly; it never holds up the checkpoint, shipping or trimming.
    - **Retention.** After each copy: the 48 newest (two days of activity), then the newest of
      each UTC day for 31 days back; at most 79 objects of 1-2 MB a canvas. R2 cost: a put, a
      list and a delete an hour (cents a season).
    - **The seal.** A copy names no player: the grid has none, and the team checkpoint holds
      writer ids and per-team counters. But writer ids resolve to account ids through the
      canvas's `writers` table until the seal renames them, and the team checkpoint counts per
      team, so the copies go with the season's ids: the seal deletes every copy once the
      archive is complete (also when it resumes after `season.json`), before the purge, and
      drops meta `checkpoint_copy`. A sealed canvas takes no op and keeps its own final
      checkpoint. Copies are under `c/`, never under the locked `archive/` prefix.
    - **Recovery.** A start whose stored checkpoint does not read back, or that has none while
      SQLite no longer holds the log from seq 1, takes the newest copy that reads back and that
      the surviving log reaches (never one past the log's last seq), replays the R2 segments
      between it and SQLite's first row, then SQLite; with no usable copy, the R2 log from seq
      0. The team ledger starts from the copy's team checkpoint (a copy without one starts it
      empty, logged as `ledger_empty` with the seq and no player id). The damaged checkpoint is
      dropped before the replay; at the end a new one is stored; failing that, none counts, so
      nothing is trimmed until the next maintenance pass stores one. Without OPLOG it refuses to
      start, as before. A damaged checkpoint with the whole log still in SQLite replays it from
      seq 0. All of this runs in the start's `blockConcurrencyWhile`: about an hour of log
      behind a copy is quick, the whole season without one may not fit its time limit, so the
      R2 replay also stores a checkpoint (grid and team ledger together) every 16 segments or
      10 s. A start cut short resets the object, and the next start takes that checkpoint as
      its base (a readable checkpoint below the trimmed log) and replays only the rest.
    - **Rollbacks.** A copy whose team part is missing or unreadable has no writers for the
      target; the job passes over it for the next older usable copy, not straight to seq 0.
    - **Tests.** Cadence, retention (and deletes in batches of 1,000), each refusal of a
      damaged copy, recovery (damaged, missing, no copy, the whole log local, a copy past the
      log's reach, a failed final store, progress kept across a cut-short start), the rollback
      base from a copy (and past one without a team part), the seal's deletion (also when it
      resumes) and closing waiting for the final copy. Mutating each of these guards fails a
      test.

## Consequences

- Players see a rollback at once through `FanoutDO.refresh` (one snapshot, as any resync),
  spectators within one segment. The CDN republishes as for any op.
- A rollback costs a replay: seconds for a quiet canvas or a window after the checkpoint,
  up to tens of minutes of polling for a busy week's log replayed from seq 0. Trimming waits
  meanwhile (SQLite grows by the rows logged during the job).
- An ended season cannot be rolled back live; moderators add archive-only removals instead,
  and the final CDN map keeps the content until the seal rewrites the keyframes.
- Player ids now also sit in meta `rollbacks`, in archive-only removals and in restore rows'
  `who`; the seal renames all three.
- A canvas with more than about 110,000 live shield layers cannot be rolled back until layers
  expire: the copies (§10) bound a replay's time, not its memory.
- A late rollback with a start time replays about an hour of log before its window instead of
  the season; a damaged checkpoint no longer stops the canvas from starting while OPLOG and a
  copy (or the whole R2 log) are there.
- OPLOG holds up to 79 checkpoint copies a canvas until its seal.

## Owner questions

Decided by the owner on 2026-10-25 (questions 1, 2, 4 and 5), each as built:
- **Rollback scope**: moderators apply one player's rollbacks and area locks; a rollback of
  every player's ops (by area and/or time) needs an owner (§8; a moderator's is refused 403 and
  audited, `workers/admin/test/map.test.ts`).
- **Restored cells count for their earlier writer's team** (§4; `workers/game/test/rollback.test.ts`,
  the artist's team gets its cells back).
- **Locks without an end are allowed** (§6: `until` null means until unlocked; the page
  suggests 24 h).
- **No notice to rolled-back players**: the map shows it; nothing is sent to them.

Questions 3 and 6 are still open (built as recommended). The questions as they were asked:
1. Moderators apply rollbacks of one player's ops and locks; a rollback of every player's ops
   (by area and/or time) needs an owner. _Recommended: yes (built); a looser rule, such as
   moderators for areas up to one tile, would let them handle a raid alone._ _Decided: as
   built._
2. Restored cells count for their earlier writer's team. _Recommended: yes (built); the
   alternative is nobody's._ _Decided: as built._
3. Bound the replay with hourly checkpoint copies in R2 (also ADR 0014's disaster-recovery
   copy)? _Built as recommended (§10: hourly, 48 recent and 31 daily kept, deleted at the seal);
   owner to confirm. Still open: letting a job keep one state instead of two (checking the
   baseline against a stored hash) to nearly double the shield layers a rollback allows;
   recommended before the first public season, as the memory budget (§3) can refuse a rollback
   on a heavily shielded map during a raid, when it is most needed._ _Open._
4. Locks without an end: allowed, or a maximum? _Recommended: allowed; the page suggests 24 h._
   _Decided: allowed._
5. Tell players their ops were rolled back? _Recommended: no; the map shows it._ _Decided:
   no notice._
6. Copy retention and recovery limits (§10): 48 hourly plus 31 daily copies, and a recovery
   without any usable copy replaying the whole R2 log over several starts (a checkpoint every
   16 segments or 10 s). _Recommended: keep these numbers; add the ops alert on `checkpoint
   copy failed`, `rebuilt the map` and `ledger_empty` log lines with the other ops alerts, and
   an off-site copy with the op-log backup follow-up._ _Open._
