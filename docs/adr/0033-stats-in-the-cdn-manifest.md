# 0033. The canvas stats travel in the CDN manifest

- Status: accepted
- Date: 2026-10-26
- Relates to: 0009 (spectators read from the CDN), 0014 (manifest), 0018 (watching in the
  client), 0030 (live counts and drop rates)

## Context

ADR 0030 shows every page the players on the map, the phase, how full the open area is and the
drop rates, through `GET /api/stats`, polled once a minute. Its edge cache spares the canvas
but not the gateway Worker, so each open page costs one Worker request a minute, against ADR
0009's aim of spectators costing no Worker at all. At 100,000 watching pages that is about
1,700 requests per second, some 4.3 billion a month: about USD 1,300 a month in Workers
requests at USD 0.30 per million (owner's question, 2026-10-26). The same pages already read
the manifest every 2 s from the CDN, where a cache hit costs nothing per page.

## Decision

- **In the manifest.** The manifest gains an optional `stats` field, the same object
  `/api/stats` answers (`playing`, `phase`, `filled`, `rates`) plus `at`, the canvas time of
  the write. It is optional like `locks` and `overview`: no `CDN_FORMAT` bump, older readers
  ignore it. Counts only, as before.
  Amended 2026-11-02: `filled` is the share of the open area no brick can reach (filled cells
  and holes, ADR 0010's phase measure), not what the open area grows at, and on staging it read
  75-78% while bricks covered 66.6% and the area had not grown at 70% (ADR 0013), which looked
  like a broken growth. Both stats gain `built`, the percent (rounded down) of the open area
  with a brick in it, which growth reads, and `growsAt`, the `built` percent the open area
  grows at (the growth setting in force), null once the open area is the whole map. `filled`
  keeps its meaning for older pages. The phase pill's title gives both, and the admin
  overview shows `built` against `growsAt`. Two lags remain: a growth setting taking effect
  reaches the manifest's `growsAt` with the next tick for another reason (an op, a shard
  report; `/api/stats` has it at once), and the area grows only after a batch of ops, so a
  threshold lowered under `built` waits for the next accepted op.
- **Freshness.** Every manifest carries the canvas's current stats. When only the stats
  changed (a shard's report, a report going stale, an item config taking effect), the canvas
  writes a manifest for them at most every `STATS_MS` (15 s, the old edge cache), map changes
  or not: a shard's report and a scheduled item config arm a tick, and the canvas also wakes
  when a report that counts players goes stale, so the count falls back on an idle map with
  no call to say so. While anyone plays, unchanged stats are written again every
  `STATS_REFRESH_MS` (60 s), so `at` keeps moving. Kept in memory: a restarted canvas writes
  them on its first tick.
- **Client.** A page watching through the CDN takes the stats of each manifest it reads, and
  skips `/api/stats` while those are younger than its poll interval (60 s). It skips stats
  with an older `at` than those in hand (another edge's copy), and, while they count
  players, stats whose `at` has not moved for 150 s by its own clock (no skew to correct):
  the canvas stopped writing them, so the page polls again. A page with a socket stops the
  CDN feed, so it polls `/api/stats` as before (players are far fewer than spectators), and
  its Stats frames still carry the team count.

## Consequences

- Spectators cost no gateway Worker request after the page load; `/api/stats` scales with
  playing pages, not watchers.
- Counts reach watching pages within about 15 s plus their 2 s poll, sooner than the 60 s poll.
- An idle map with players on it writes one manifest per minute, and at most one per
  `STATS_MS` while the counts move (at most about 170,000 R2 writes a month, under USD 1); its
  canvas wakes on that cadence, plus up to about once a minute when the shard report it last
  saw would go stale, and a wake 10 s after the last one also runs the maintenance pass (a
  few SQLite rows). With nobody playing an idle canvas does not wake for stats.
- Deploy order is free: a canvas that predates this writes no `stats`, and pages keep polling.
  A rollback to such a canvas leaves the last stats in the manifest until the map changes:
  pages stop taking them within 150 s while they count players, and poll. Stats of nobody
  playing are not rewritten, so after a rollback they can stay shown until the map changes.
- An R2 outage (CDN backoff up to 5 minutes) sends watching pages back to polling the same
  way, once their stats stop moving; stats of nobody playing stay shown through it.
- `/api/stats` stays for playing pages and for watchers whose CDN is unusable.
