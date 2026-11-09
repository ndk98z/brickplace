# 0031. Per-player season numbers for the profile

- Status: accepted
- Date: 2026-10-26
- Relates to: 0006 (UI design), 0008 (where data lives), 0019 (data download, deletion),
  0020 (teams, the per-writer ledger), 0021 (seasons, the seal's id strip)

## Context

The approved Profile design has a "Your season" card: bricks placed, hammers used, shields
placed and days played, with "Only you can see these numbers." Nothing computes them today.
The canvas keeps, per player, only its hold (`inventory`), dedupe keys (`accepted_ops`), the
daily team credit and the last writer of each cell (`writers`, for team standings). The op log
names the player of each op (`who`), so the numbers could be derived, but the live log is
trimmed after each checkpoint and the full one is in R2: counting it per request is out of the
question. The gateway binds no CanvasDO; it reaches a canvas through FanoutDO (as
`/api/stats` does, ADR 0030).

## Decision

- **Counters in the canvas.** A table `player_season (player, bricks, hammers, shields, days,
  last_day)` in CanvasDO's SQLite, updated in the same transaction as each accepted op: a
  brick or single brick adds to `bricks`, a hammer to `hammers`, a shield to `shields`;
  `days` grows when the op's logical day (UTC, from `at`) is later than `last_day`. Refused
  ops and discards count nothing. Counts are moves made: a moderator rollback (ADR 0024)
  changes the map, not these numbers.
- **Reading them.** `POST /api/me/season`, signed in, same-site with the CSRF token (as the
  data download), never cached: the gateway asks shard 0's FanoutDO, which asks the current
  canvas for that one player (`playerSeason(player)`). Zeros for a player with no row; 503
  while the season registry is unreadable (the canvas would be a guess) or while realtime or
  game predates it, as `/api/stats`.
- **Showing them.** The profile's "Your season" card reads them each time it opens, also
  while the season is `finalizing`, until the seal empties them. They are not in the data
  download (ADR 0019): the profile shows them to the account itself.
- **Lifetime.** The table joins the seal's player tables (`PLAYER_TABLES`), so it is emptied
  with the hold and dedupe keys when the archive is sealed (ADR 0021). A deleted account's row
  stays until then, like its hold: its id is retired and only a session of that account could
  read it (ADR 0019). A new season's canvas starts with an empty table.
- **Not rebuilt.** The numbers are for display, not game state: a canvas that recovers its map
  from R2 (ADR 0024 §10) keeps the table if SQLite survived and otherwise starts it again
  from zero. No checkpoint part, no replay.

## Consequences

- One small upsert per accepted op, in a transaction that already writes the log row and the
  hold; no new Durable Object, binding or migration of `wrangler.jsonc`.
- The Privacy page gains a sentence: per-season move counts per account, shown only to that
  account, deleted at the seal. They add no new kind of data: the op log already names who
  made each move.
- The owner's answers (2026-10-26): counts are moves made, a rollback does not lower them;
  the card shows while a season is `finalizing`; the data download leaves them out.
