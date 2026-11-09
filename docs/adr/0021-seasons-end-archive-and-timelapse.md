# 0021. Seasons: a canvas each, the end, the archive and the timelapse

- Status: accepted
- Date: 2026-10-24 (proposed), 2026-10-25 (accepted; owner decisions at the end)
- Amends: 0008 (where the season schedule lives), 0014 (archive layout in OPLOG)

## Context

Seasons last about a week (ADR 0010). At the end the map must stop taking moves, the season
must be archived (ADR 0008: anonymised, moderation removals applied, bucket-locked; player ids
kept 90 days after the end, then stripped), holds cleared for the next one (ADR 0012), and a
timelapse shown. Stage 0 has one CanvasDO named `canvas`, one FanoutDO `fanout-0`, the R2
prefix `c/canvas` (ADR 0014) and a gateway that hard-codes that prefix (ADR 0018).

## Decision

**One canvas per season.** A season is a CanvasDO of its own (name such as `s1`, lower-case
letters, digits and `-`), so its R2 prefix `c/{canvas}` in OPLOG and TILES, its holds, dedupe
keys, draw salt, open area and counters all start fresh, and the old canvas simply stops. No
reset has to be logged, no core rule or log format changes, CDN readers never see seqs restart
under one prefix. One canvas with season boundaries was rejected: it needs reset entries in
the log (a core change), and the CDN, checkpoints and dedupe would all have to know about them.
- **Registry in D1** (`seasons`: id, canvas, starts_at, ends_at; gateway migration 0005).
  The current season is the one whose start passed last (an ended one stays current, read-only,
  until the next starts); no row means the Stage 0 `canvas`. The gateway reads it per isolate at
  most every 30 s, caching the next season too, so a start is exact. Phases follow from times;
  whether the archive is sealed lives in the CanvasDO. D1 rather than CanvasDO meta (no single
  object would know every season) or ADR 0008's later CoordinatorDO (a new DO class needs its
  own `do-lifecycle` PR; lane I may still move the write path there).
- **Resolution.** `/ws`: the gateway picks the canvas and sends the socket to FanoutDO
  `{canvas}:fanout-0` (Stage 0 keeps `fanout-0`) with the canvas in `X-BrickPlace-Canvas`
  (client copies stripped). FanoutDO pins it on its first socket and relays only to that
  CanvasDO. `/api/me` gives `config.season` and the season's `tilesUrl`; `GET /api/seasons`
  lists started seasons (cached 60 s).
- **A season changing under an open page.** A page loads one canvas (its tiles, its socket).
  `/api/me` also names the next season to start (`config.nextSeason`: canvas and start, from
  the registry cache). An open page asks `/api/me` again at that start plus up to 30 s at
  random (so pages do not all ask in the same second), after its first move refused as `ended`,
  and with its 20-minute renewal. When an answer names another canvas than the page's, a hidden
  page reloads at once and a page in view shows a "new season" card with a Reload button
  (`apps/client/src/game/season-watch.ts`). Nothing is pushed over sockets: a season change is
  rare, and `/api/me` already carries the registry. An answer given with the registry
  unreadable and nothing cached (the Stage 0 guess for watching) says so
  (`config.seasonGuessed: true`) and is never taken for a change; nor is a season's canvas
  followed by Stage 0's, which the registry never does.
- **D1 down.** The last answer serves for up to an hour (it includes the next season, so a
  start stays exact), with D1 asked again every 5 s. With nothing cached, signed-out `/api/me`
  and watching sockets fall back to Stage 0's `canvas`, a guess good enough to watch; a
  playing socket gets 503, never a guessed canvas.

**The end and the read-only switch** live in the canvas (meta `season`), which enforces them:
- `endsAt` is one timestamp on the canvas's logical clock, the `at` a batch is applied and
  logged with. Ops at or after it, and discards, are refused with `ended`; an op that arrives
  late but carries an earlier `at` is still taken until closing starts (checked again after
  the batch's only await, so nothing is logged after the last seq). Refused ops are never
  logged, so replay never consults the schedule and stays deterministic across the end. An
  end at or before the last logged op's time is refused. A retry of an op or discard accepted
  before the end is still answered as a duplicate.
- `readOnly` (a short note) refuses ops and discards with `read_only` until cleared.
- `CanvasDO.setSchedule({endsAt?, readOnly?})` is the call lane I's admin area and emergency
  switch make; `requestSeal()` and `setRemovals()` complete the admin surface. The end moves
  freely while the season is open, never once it closes. The D1 row's `ends_at` must be set to
  the same value (admin: canvas first, then D1).
- Protocol: ack statuses 253 `ended` and 252 `read_only` appended (no version bump). Older
  clients skip the ack and see the op as unconfirmed.
- A random end within a window stays an owner decision; it would be one `setSchedule` call by
  the admin tool, with only the window shown to players.

**Closing and phases** (`open → closing → ended → sealed`). The first maintenance pass past
`endsAt` (wall clock, so an idle canvas closes too) fixes `finalSeq`; then a checkpoint is taken
at once, the log is shipped to OPLOG up to it, the CDN catches up (segments, tiles at their
45 s pace) and a final keyframe marks the index final. Then the season is `ended`: read-only,
holds no longer handed out. A restart at any point resumes from meta.

**Finalizing, for pages** (2026-10-26). Pages see a season over but not sealed as
`finalizing` (`/api/me`, `/api/seasons`): moderators may still remove content from its
timelapse frames until the seal. The gateway binds no canvas, so it goes by times: `finalizing`
from `endsAt` until `endsAt` + 90 days (the latest seal), `ended` after. An earlier seal
(`requestSeal()`) shows in the keyframe index instead: the seal's last transaction marks it
(`sealed: true`, appended to the JSON, older readers ignore it) and the next pass rewrites it.
The timelapse says "final map" once either says so, "final map, under review" before.

**Holds at season start**: automatic, since a new canvas has an empty inventory and a new draw
salt; each player gets one starting item at first look and the cooldown runs from then.

**The sealed archive** is written once player ids must go: `endsAt` + 90 days, or earlier
on `requestSeal()`. Until then the raw log in OPLOG (unlocked) is the record, and moderators
can still add removals; once sealing has started (its key is in meta) the list is fixed,
since a locked copy could not be replaced afterwards. Sealing reads the raw segments twice, 25
per maintenance pass (a busy week in about two hours; a restart starts over, keeping what it
already wrote). The first pass writes nothing: it replays every op and requires the live final
grid hash, so a damaged or tampered log stops the seal before any object reaches the locked
`archive/` prefix (the ids are kept, and a repaired log seals on the next attempt). The second
pass checks that each segment is still the bytes the first pass verified, and writes:
- `archive/c/{canvas}/oplog/{from}-{to}.ndjson.gz`: rows `{seq, at, ops, who}` with only the
  op fields. `who` (ADR 0020: [player, team] per op) replaces each player by a pseudonym, the
  first 16 hex digits of HMAC-SHA-256 under a random per-season key held in meta only while
  sealing, then deleted, so no one can link a pseudonym to an account (a player id inside an
  entry, should a format ever put one there, becomes `p` the same way). It keeps a team only
  when at least 10 distinct players made ops for it that the archive keeps
  (`ARCHIVE_TEAM_MIN_PLAYERS`, counted by the first pass with the removals applied); any other
  team is written as 0, no team (owner decision, question 6 below).
  `season.json` says `teams: {minPlayers, kept, dropped}`.
- Removals (`{from, to, area}`, empty until moderation exists): player ops of those seqs whose
  anchor cell lies in the area are left out; later ops replay against that, so the archive
  records its own `archiveGridHash` (the first pass has already checked the whole log).
  ADR 0024 adds a removal per rollback (with an optional `player`, named by pseudonym in
  `season.json`), leaves restore rows out (archived as `{seq, at, ops: [], restored: n}`,
  which takes no time) and moves the clock for every row of player ops, even one whose ops
  were all removed. `ARCHIVE_FORMAT` stays 1 for this: no season has been sealed yet, so no
  archive of the earlier shape exists; once one does, such a change bumps it.
- With removals, the keyframes are cut again from that replay under a new revision (kept out
  of garbage collection until the new index names them); the old revision's tiles become
  garbage an hour after the new index.
- `archive/c/{canvas}/season.json` last (its presence means complete: a seal that stopped
  after it only deletes the replaced raw segments and purges).
- Raw segments that carry ids (every segment with a `who`) get a stripped copy
  (`c/{canvas}/oplog-stripped/`, the raw row shape with `who` renamed the same way, small
  teams dropped as in the archive, nothing removed) and are then deleted (ADR 0014's retention); a segment without ids stays.
- The checkpoint copies (`c/{canvas}/checkpoints/`, ADR 0024 §10) are deleted too: their
  writer ids resolve to players until the purge below. So a sealed canvas whose own checkpoint
  is later damaged cannot recover (no copies, no raw segments); the sealed archive remains.
- The canvas then strips what it keeps itself, in one transaction (this is ADR 0020's
  "Stripping player ids"): it empties `PLAYER_TABLES` (`inventory`, `accepted_ops`,
  `team_credit`), renames every writer to `#{id}` (still unique per (player, team), so the
  team ledger keeps its ids and counts), deletes the op_log rows already shipped and gives
  any row left the same pseudonyms. The grid and team checkpoints name no player: the team
  checkpoint holds writer ids and team counters only, and the ids now resolve to `#{id}`.
  Archive objects are put with `If-None-Match: *`, so R2 itself refuses an overwrite: a retry
  finds them by checksum, a different object stops the seal (backoff up to hourly) and keeps
  the ids.
- Team standings stay per canvas (ADR 0020): a new season's canvas starts with none, and the
  gateway ranks teams by the current season's canvas (the last one until the next starts).

**Keyframes and timelapse.** Every hour of wall clock with changes (the first frame at the
first pass), the canvas writes the tiles that changed since the last frame to TILES at
`c/{canvas}/keyframes/{revision}/{tx}-{ty}/{seq}.bin.gz` (tile format, immutable) and the index
`c/{canvas}/keyframes.json` (max-age 60): per frame its seq, time, open area and each tile's
version. Cost: at most 65 Class A writes an hour, about 11k a week (cents), nothing while idle.
Diff segments between frames are not kept (they are collected a minute after they retire).
`timelapse.html` (its own 4.5 kB bundle) plays a season's frames on a 2D canvas, loading only
tiles whose version changes; the dev tiles route serves the keyframe keys. Each frame also
gets an overview (`c/{canvas}/keyframes/{revision}/overview/{seq}.bin.gz`, the whole map
downscaled as in ADR 0014; the index says from which frame on: `overviews: {factor, from}`),
one more write a frame. A timelapse shown at most two device pixels per overview pixel, when
every frame has one, plays those instead of tiles: one object a frame. A moderation rewrite
writes them again under the new revision, like the tiles.

## Consequences

- Owner setup: the deploy workflow applies D1 migration 0005. A season is registered with
  `INSERT INTO seasons (canvas, starts_at, ends_at, created_at)` and its end set on the canvas
  by `setSchedule`; until lane I ships the admin area nothing calls it, so a registered season
  routes players but does not end. Deploy realtime (which bundles the new ack statuses) before
  any end or read-only switch is set.
- First season: also call `setSchedule({endsAt: s1.startsAt})` on the Stage 0 canvas
  `canvas`. Otherwise pages still open on `fanout-0` keep playing the old map after s1
  starts, and its keyframe index keeps growing. It then closes like any season.
- Bucket lock (owner config, not in the repo): on each OPLOG bucket, one rule on prefix
  `archive/`, e.g. `wrangler r2 bucket lock add brickplace-oplog-production archive-forever
  archive/ --retention-indefinite`. Locks block overwrites and deletes (not new objects), win
  over lifecycle rules, and stop the bucket from being emptied; an account admin can still
  remove the rule, so the off-site backup stays a follow-up. Do not lock `c/` (raw segments
  must be deletable for stripping) or anything in TILES (keyframe rewrites and garbage).
- No new buckets, bindings, secrets or DO classes; no DO migration.
- `/api/me` and `/ws` now read the registry (cached per isolate). A long D1 outage with nothing
  cached shows signed-out visitors the Stage 0 map and refuses players a socket.
- A seal that keeps failing only logs and backs off (up to hourly), while player ids stay past
  90 days: an alert on it belongs with the ops alerts (ADR 0008 compliance).
- Durable Object SQLite keeps 30 days of point-in-time recovery: the purged player rows and the
  pseudonym key stay recoverable by the account owner that long after a seal.
- Sealing progress is not stored: frequent deploys during a very large seal delay it. Storing
  the replay position (with a checkpoint of the replay) is a follow-up if that shows up.
- An ended canvas costs one alarm a day until sealed; a sealed one costs nothing.
- Admin read-only and the end share one path, so lane I gets both from one call.

## Owner questions

Decided by the owner on 2026-10-25 (questions 1, 2 and 6):
- **Pseudonyms** in the archive, with the key thrown away (as built).
- **`archive/` locked indefinitely**, that prefix only (owner config, see Consequences).
- **Teams beside pseudonyms: option (a) with k = 10.** A team stays in the archive only when at
  least 10 distinct players in the season's log made ops for it that the archive keeps; the
  same rule for every team, the owner's included. Built in the seal (above): counted in its
  first pass, applied to the archive and the stripped copy, recorded in `season.json`. The
  canvas's own team ledger and the standings database keep every team (aggregates per team,
  not per pseudonym).

Questions 3, 4 and 5 are still open (built as recommended until the owner rules). The
questions as they were asked:
1. Pseudonyms or no ids at all in the archive? Recommended: pseudonyms with the key thrown away
   (as built): useful structure, no link to accounts. _Decided: pseudonyms._
2. Lock retention: indefinite or a fixed term? Recommended: indefinite on `archive/` only.
   _Decided: indefinite on `archive/`._
3. Publish the sealed archive (op log, not just keyframes) as a public dataset? Recommended:
   later, from a copy in TILES, once moderation has run a season. _Open._
4. Seal at 90 days, or sooner when no report is open? Recommended: 90 days by default;
   `requestSeal` for exceptions. _Open._
5. Keyframe interval: hourly, or 15 minutes for a smoother timelapse (about 4× the writes and
   reads)? Recommended: hourly at launch. _Open._
6. Teams beside pseudonyms can re-identify players. The archive keeps each op's team, and the
   accounts database (`team_players`, `teams.owner_id`) says who was in which team. A
   pseudonym that played for a one-person team, or for a team of a few, points back to an
   account; so may the owner's ops, if the owner played alone at first. Options:
   - (a) keep a team in the archive only where it hides each player among at least k others:
     teams with at least k distinct pseudonyms in the season's own log (the seal can count
     them in its first pass, with no lookup in the accounts database), otherwise team 0;
   - (b) drop teams from the archive (team standings are already in the standings database,
     per canvas);
   - (c) drop pseudonyms instead and keep teams: the archive loses "same player" but keeps the
     team history.
     Recommended: (a) with k = 10, the same rule for every team, the owner included. It keeps the
     team history of real teams and needs nothing outside the log. _Decided: (a) with k = 10,
     built._
