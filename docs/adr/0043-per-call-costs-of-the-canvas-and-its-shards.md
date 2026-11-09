# 0043. Per-call costs of the canvas and its shards

- Status: proposed (items 1-3 built, 2026-10-28)
- Date: 2026-10-28
- Relates to: 0028 (ticks, watchdog), 0030 (live counts, Stats frames), 0032 (busy), 0041
  (batched relays), 0042 (journal, commit ticks); design doc, tab "Scale triệu CCU" (rows
  "CPU CanvasDO", "Tin nhắn vào CanvasDO")

## Context

The second shard measurement (PROGRESS.md, "Second run", 2026-10-28; 2,000 bots on one shard)
held: no ack timeouts, no `busy`. Its per-minute dashboard numbers (GraphQL analytics,
`durableObjectsPeriodicGroups`, `durableObjectsInvocationsAdaptiveGroups`), at the busiest
minute against the first run's: the CanvasDO took 1,448 requests (was ~5,300), wall p50
47 ms (was 125-236), 1.0 s of CPU for about 2,000 ops (~0.5 ms an op), 2,018 rows written
(8,654 over the run for 8,214 ops; ADR 0042 counted 8-10 an op before it); the FanoutDO used
14-15 s of CPU a minute (~25%) for ~7,800 frames a second. Read naively, 0.5 ms an op caps
one canvas near 2,000 ops a second, far under the design doc's ~10,000.

A local benchmark of CanvasDO, bundled by wrangler and profiled in workerd (not committed),
says the cost is per call, not per op:

| Per op                                                  | 1 op a call | 10 a call | 64 a call |
| ------------------------------------------------------- | ----------- | --------- | --------- |
| Core `apply()` (brick), µs                              | 6.9         | 6.9       | 6.9       |
| `applyBatch` inside the object, µs                      | 80-104      | 36-47     | 32        |
| Rows written at the call (`op_log` + journal, one each) | 2.0         | 0.2       | 0.03      |

The trim and the journal's delete (ADR 0042) later double the rows. Over RPC one op a call
took about 1 ms of wall time here (a disk commit each), and 16 calls in flight were no faster
than one: the object runs them one at a time. ADR 0041 keeps one call in flight per shard,
so a busy shard's batches grow and its cost per op falls; in the run they held about 1.4
ops. Staging's 0.5 ms of CPU an op is still 3-5x the local figure at that batch size; draws
(an HMAC per item, 40-90 µs a player a call here), team credit (the cap is set on staging,
not in the benchmark), presence and a larger database are the candidates, and only a run
at a higher op rate (below) can tell. What grows with load is calls a second: about 20 per
shard at most (one per call time), plus calls that do not depend on ops at all. From the
code:
- **The watchdog runs on every alarm.** `FanoutDO.alarm()` runs `watch()` after every hold
  delivery, not every `watchdogTiming.ms` (30 s) as `watchdog.ts` and ADR 0030 describe. With
  many players waiting for items, the hold alarm fires every 500 ms (`MIN_ALARM_DELAY`), so a
  shard may call `CanvasDO.cursor()` twice a second and send a Stats frame (ADR 0030, meant
  to be one per 30 s) to every socket twice a second: up to 4,000 frames a second at 2,000
  sockets, against at most 8,000 diff frames. In the run the bots drew for about four minutes,
  then sat on full holds (no item due, no alarm); the dashboard cannot tell `cursor()` calls
  from relays, so the share is unmeasured.
- **The hold alarm reads every socket's attachment** twice per alarm (due players, next due
  time), and `watch()` once more for the presence report: three structured-clone reads per
  socket.
- **Discards are one call each** (`CanvasDO.discard`), outside the relay batch (ADR 0041 left
  them out). The first run had 10,236 discards among 66,818 ops.
- Unmeasured, from code: `TeamLedger.save()` walks every credit entry it holds (up to
  10,000) on each write, and a player's rows are read from SQLite again after each 5-minute
  fold.

## Decision

1. **Watchdog on its own cadence.** `alarm()` runs `watch()` only when `watchdogTiming.ms`
   has passed since the last one (time kept in memory; after an eviction the first alarm
   runs it). Stats frames stay one per watchdog call, as ADR 0030 says: at 30 s that is 67 a
   second for 2,000 sockets, not worth a change-detection path.
2. **Hold alarm from memory.** FanoutDO keeps each socket's `nextAt` in a map (rebuilt from
   the attachments after an eviction, as `subscriptions` is) and reads attachments only to
   rebuild it. `MIN_ALARM_DELAY` goes from 500 ms to 1 s: the design doc's target is an item
   shown within a second of its time, and the page counts down on its own.
3. **Discards ride the relay.** A new canvas method, `applyMoves`, takes ops and discards in
   one call and one transaction, in arrival order, with a result per move (an accepted
   discard: `ok` with no diffs; `applyBatch` and `discard` are now wrappers of it); the shard
   sends discards through the same queue as ops, and calls `applyMoves` only for a batch that
   has one. Against a game script without it (deploy order, rollback) the shard, told so by
   the runtime once per lifetime, sends that batch's ops in one `applyBatch` call and each
   discard in a `discard()` call, as before.
4. **Canvas bookkeeping per change**, only if the next profile shows it: `TeamLedger.save()`
   keeps the players changed since the last save; folded rows stay in a bounded cache.

Commit ticks (ADR 0042 phase 2) and a slower flush under load (the design doc's 0.5-1 s) are
not built now. They bound calls and rows once there are many shards, each with small
batches; build them when the canvas takes over 500 calls a second or a shard's CPU passes
50%.

## Consequences

- Estimates, to be checked by the next run (players whose holds are not full): per shard,
  `cursor()` calls from up to 120 a minute to 2, `holds()` calls at most halved (each with
  more players), Stats frames from up to two a second per socket to one per 30 s; discards
  no longer a call each. The canvas's calls then come mostly from relays.
- An item may reach the page up to 1 s after its time instead of 0.5 s: the countdown shows
  0:00 that much longer.
- Code: `workers/realtime/src/index.ts` (alarm, hold delivery, relay), `watchdog.ts`,
  `workers/game/src/index.ts` (the new method). No wire format, core or golden change. The
  canvas method ships in the game script before realtime uses it.
- The next staging run lowers the cooldown (admin, game config) so 2,000 bots reach several
  hundred ops a second: it finds the canvas's real ceiling on production cores and explains
  the 3-5x above. It needs Workers Paid (100,000 rows written a day on Free).
- Not worth changing for scale: the rules (7 µs an op) and trace sampling (Cloudflare reports
  no measurable overhead).
