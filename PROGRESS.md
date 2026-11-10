# Progress

Working state for humans and agents. Keep it short: what is done, what is next, what is blocked.
The design doc (private to the owner) and `docs/adr/` explain why; this file only tracks
where we are.

## Done

- [x] Monorepo scaffold: pnpm + Turborepo, Biome, TypeScript 7, Vitest + Workers runtime tests.
- [x] `packages/core`: bricks (7 shapes, 4 rotations), hammer, shield, link bits, grid hash.
- [x] `packages/protocol` v1: client ops, ack, diff frames.
- [x] `packages/golden`: two fixtures.
- [x] Stage 0 Workers: gateway → FanoutDO → CanvasDO with SQLite op log and replay.
- [x] CI/CD workflows, Claude Code harness (loop with independent review), open-source docs.
- [x] Decisions recorded: ADR 0002 (name, AGPL, DCO, open-source timing), 0003 (Cloudflare,
  Stage 0), 0004 (map 2048², tiles 256, regions 1024; map 1024² since ADR 0027), 0005 (single brick), 0006 (UI design,
  Preact, sponsors, Ko-fi donations).

## Now: playable local build (Stage 0)

- [x] Season simulation in `tools/sim` (builders, casual players, griefers, repairers on the
  real core). Results and the questions they raise: `tools/sim/README.md`.
- [x] `tools/sim` under ADR 0010 (phases by brick room, fitting shape draws, per-tick scans)
  and drop rates for a one-week season, plus threshold/gradual brick-room experiments
  (`tools/sim/README.md`).
- [x] Worktree tests resolved `@brickplace/core` from the main tree (symlinked
  node_modules). Worktrees now get a real `pnpm install`; the Stop hook installs one if it is
  missing, and lands reviewed branches on local `develop` (never pushes).
- [x] Single brick in `packages/core` + protocol opcode 0x04 + reject reason `coverable` +
  golden fixtures (ADR 0005).
- [x] Shield decay in `packages/core` (ADR 0007): logical time from the op log (`at` column),
  sparse expiry, newest layer first (ADR 0010), lifetime pinned in the stored canvas config.
- [x] Anti-stuck counters in `packages/core` (placements per orientation, reachable cells),
  maintained per op. The phase by brick room and the shape draw use them in the inventory item.
- [x] Initial map state on connect (whole grid as Diffs frames, then live), 1012 close when
  FanoutDO cannot tell what open sockets missed.
- [x] Dev-only identity (`?player=` per page load, `ENVIRONMENT=dev` only).
- [x] Player identity on sockets + dedupe by (player, opId) in CanvasDO (last 100k accepted
  ops, in SQLite), so `unavailable` acks can be retried safely.
- [x] Inventory and cooldown in CanvasDO (ADR 0010–0012): hold of 3, one item per cooldown,
  salted HMAC draws (`ITEM_DRAW_KEY`), phase by brick room, reserve/commit/refund in the op
  transaction, discard op, hold frames (0x83) pushed by FanoutDO, client shows the server
  hold. Note for the first deploy: game goes before realtime, and until realtime is out the
  old FanoutDO acks a `no_item` refusal as accepted.
- [x] Single brick end to end: the client sends it, realtime passes it through, the core
  decides (checked live with `pnpm dev`).
- [x] Open area in the op log and grown automatically (ADR 0013: 70% full → +256 per side,
  golden fixture `open-area-growth`); config frame 0x84 sends size, open area and `maxShield`
  to clients.
- [x] FanoutDO: "behind" marker cached in memory; initial-grid sends capped (8 at a time,
  30 s wait, 503 past 300 waiting).
- [x] Grid checkpoints, op-log segments to R2 and CDN tiles (ADR 0014): checkpoint every
  60 s of activity, log trimmed once in both checkpoint and the private `OPLOG` bucket, diff
  segments every 2 s and tiles every 45 s to the public `TILES` bucket with a manifest,
  garbage collected by the canvas (no R2 lifecycle rule on tiles or diffs).
- [x] `tools/sim` on the core's own single brick, shield decay and counters, and since on the
  core's draw, phase, hold arithmetic, item config and growth defaults (experiments stay
  sim-side on top). k1 re-run: unusable draws 7.6% (was 10.0%), single bricks 55% after a
  week (was 56%), 72% art at 30% griefers (71% in the earlier table, not re-run on the
  previous code); `tools/sim/README.md`.
- [x] Client renderer: R8UI tile textures, palette shader, pan/zoom; Preact UI per the design
  (tool column, numbered palette, sponsors, Ko-fi, minimap); dev player id, resend with the
  same opId, single brick; self-hosted Fredoka and Inter (OFL). Stubbed: hold/cooldown
  (local), team, snapshot, report.
- [x] Client follow-ups: `shouldSend` test, same-origin sponsor logos, holes a single brick
  can fill highlighted, mipmaps for far zoom-out.
- [x] Harness follow-ups: review check tested with a detached main tree; its message names
  the main tree's commit instead of `null`.

## Next: before public launch

- [x] Auth (ADR 0015–0017): Google, Reddit and Discord OAuth (state + PKCE, each flow
  accepted once), a fake provider in dev, signed session tokens with key rotation,
  Turnstile at sign-up, accounts and bans in D1, linking from a signed-in session only,
  nicknames chosen at first sign-in (ASCII letters, digits, `_`, word list in KV, one
  change per 30 days), watch-only sockets when signed out (`signed_out` ack), playing
  sockets renewed before the token expires, op dedupe by (player, connection, opId).
- [x] Account follow-ups (ADR 0019): reporting a nickname (profile → Report; one open
  report per pair, daily cap from KV), data download (JSON, op-log contributions as a
  note), account deletion (recent sign-in + nickname typed; bans kept without a link, id
  retired, nickname freed), rate limits on `/auth` and `/api` as owner-set WAF rules (the
  gateway answers them only on `PUBLIC_ORIGIN`'s host), D1 migrations in the deploy workflow.
- [x] Account follow-ups: Turnstile on suspicious activity (ADR 0026, below). (Moderator
  nickname reset and the report queue: done in the admin area, ADR 0023.)
- [x] Spectators without a socket (ADR 0009, 0018): watchers, and players zoomed out (below
  2 px per cell) or hidden for 60 s, read tiles and segments from the CDN, polling the
  manifest every 2 s while visible (backing off to 60 s while hidden); a socket opens only to
  play, its grid swapped in off screen. Checked against the real publisher by a seeded
  cross-check in the game Worker's tests. The bucket's
  address is the gateway var `TILES_ORIGIN` (empty until the owner sets the domain: pages keep
  sockets), served to pages in `/api/me`; local dev reads `/api/dev/tiles/` (dev only).
- [x] Overview images for zoomed-out spectators (ADR 0009, 0014): the canvas publishes the
  whole map downscaled (512² at most, main colour and fill per pixel) with the tiles, named in
  the manifest; a watcher loads it and only the tiles in view, and the minimap and a page
  zoomed out below a device pixel per cell draw the rest from it. Cross-checked against the
  real publisher in the game Worker's tests.
- [x] Diff ticks and per-tile views (ADR 0028, proposed): CanvasDO cuts changed cells into a
  tick every 250 ms and pushes each following FanoutDO shard one push from its own cursor (end
  values; one in flight per shard, 32 in all, backoff to 30 s, a bounded ring to catch up, a
  resync past it; shards stored, ring seeded from the log tail after a restart); `follow()`
  hands a shard its snapshot plus what its sockets missed, so an eviction repairs sockets
  instead of closing them. `FANOUT_SHARDS` on the gateway (default 1) spreads sockets by player
  (watchers by connection), kicks reach every shard. Protocol: a `subscribe` flag byte appended
  to the view frame (0x06, the cells shown; shared with the bot signal of ADR 0026, lane A),
  Tile (0x85) and a `views` feature byte in the config frame; the tiles followed are the view's
  plus one around (`viewTiles`); filtered frames shared per tile set and split at
  `MAX_DIFFS_PER_FRAME`; views rate-limited and Tile frames byte-limited per socket; the client
  subscribes (one sender with lane A's view signal: the plain view always, the flag once the
  server says `views`) and hands tiles it stopped following to the CDN at their own seq. Lane
  A's per-account state rides on the shard the account is pinned to: challenges are lifted
  there, and the admin area merges bot signals from every shard. A tick watchdog (alarm every
  30 s while sockets are open, `CanvasDO.cursor()`) follows again when the canvas lost a shard
  or stopped pushing to it, and does nothing against a rolled-back game or a canvas that
  cannot register shards (no FANOUT binding): run one shard then.
  A seeded fault-injection test checks convergence in three mixes (push faults only: no
  socket closes; all faults; one shard with a rollback). k6 `diff-latency.js`: 4
  shards p50 125 / p95 255 ms, 0 bytes for watchers not viewing the busy tile
  (`tools/loadtest/README.md`).
- [ ] Bots on staging (ADR 0034, proposed; owner 2026-10-26: no per-address limit, no team,
  200 bots from a laptop). Done: the gateway's `bot-<n>` players behind the `BOT_KEY` secret,
  staging only, no address key, an hour per socket; `tools/bots`, a Node driver with the
  player kinds of `tools/sim` (builders, casual, griefers, repairers) and builders that draw a
  PNG, local through `?player=` and staging through the key (checked against `pnpm dev`: 80
  builders drew a 40×24 picture to 88% in 8 minutes, no op refused). Next: the owner puts
  `BOT_KEY` on staging (docs/ops/setup.md, step 8) and runs 200 bots; `diff-latency.js`
  sends the bot identity too (2026-10-27).
- [ ] Scale follow-ups (ADR 0028): set `FANOUT_SHARDS` on the gateway only once realtime runs
  this version everywhere (the game ↔ realtime binding deployed fine on staging from its first
  deploy, 2026-10-25, and on every deploy since; staging set to 3 on 2026-11-02, production
  still open), and weigh lane A's per-address limits becoming per shard (how the
  `abuse-policy` KV allows for it is set in the private ops repo); a resync past
  262,144 changed cells streaming its records in chunks instead of closing the sockets
  (1012); the per-client budget that stretches the tick past 250 KB/min; a diff-latency run
  on staging; the Merger tier past ~250 shards.
- [x] Checkpoint copies in R2 (ADR 0024 §10, ADR 0014's disaster-recovery copy): the stored
  checkpoint (grid and team parts as stored) copied hourly while active to
  `c/{canvas}/checkpoints/{seq}.ckpt` in OPLOG, one atomic put with lengths, checksums, grid
  hash and clock in its metadata, refused unless all match; 48 recent plus the newest of each
  day for 31 days kept; the final checkpoint copied before closing ends; all deleted at the
  seal. A damaged checkpoint, or none under a trimmed log, recovers at start from the newest
  copy plus the R2 log and SQLite (or the R2 log from seq 0, storing a checkpoint every 16
  segments or 10 s so a start cut short resumes) and stores a new one. Rollbacks with a start
  time begin from the newest copy with writers before their window. Tests for the untileable
  map (played, checkpointed, shipped, copied, restored, never published) and `rollbackMemory`.
  A sealed canvas has no copies left: its own checkpoint is its only map (ADR 0021).
- [ ] Persistence follow-ups: read the manifest's open area from the segment, not at write
  time; an alert on `checkpoint copy failed` / `rebuilt the map` / `ledger_empty` log lines
  (ops alerts).
- [x] Teams and team ranking (ADR 0020, accepted): D1 migration 0004; create (7 days, one
  owned), join/switch (3 days, free after a closure), leave (owner closes the team), search,
  detail, ranking by cells standing (edge-cached 60 s); the team rides in the session token
  and FanoutDO passes it with each op; CanvasDO keeps the last writer per cell and per-team
  counters (team at write time), logged per op (`who`), checkpointed with the grid, flushed
  each minute to a standings D1 of its own (the game never binds accounts); daily cap on
  counted cells from KV, never awaited by ops (fail closed); deleting an account closes its
  team; client team and ranking screens.
- [x] Owner decisions of 2026-10-25 (lane D): the seal keeps a team beside the pseudonyms only
  with at least 10 players among the ops the archive keeps, else team 0, in the archive and
  the stripped copy (`ARCHIVE_TEAM_MIN_PLAYERS`, `season.json` `teams`); team names and
  nicknames never equal each other in any letter case, both ways, as conditions of the
  statements that write them (existing indexes, no migration); moderators pull the emergency
  switches but only owners reopen a read-only map; ADRs 0019–0024 accepted, ADR 0011's
  numbers re-run; the legal pages' operator, address, contact, date, sponsor address and
  archive team policy filled in.
- [ ] Team follow-ups: "Today" and "This week" rankings (after launch, owner decision); a per-player contribution count in
  the data download (the ledger has it per writer); the 90-day id strip must also rewrite
  `who`, `writers.player` and drop `team_credit` (ADR 0020, with the seasons work).
- [x] Follow-ups of ADR 0020–0023 (lane N): the team cap's KV read times out (5 s) so a hung
  read cannot stop later ones; the ranking pages past closed teams (200 standings a page, up
  to 10) and a team's rank reads only the standings ahead of it; the seal makes its copy
  replay only after the check dropped its own (one map in memory at a time); "End now" on a
  canvas that cannot be reached after the end was sent answers `inconsistent` (`unreachable`
  when nothing was sent); the owner's rename prompt after a moderator reset the team name;
  "sign out everywhere" kicks open sockets; `/api/me` says `suspended` only to a session not
  already ended; dismissing reports closes only those the queue row showed (`upTo`).
- [x] Screens from the design: landing (first visit while no game is under way, over the map), sign-in, first-time guide
  (after the first nickname, once per account in localStorage), share (`/@x,y,zoomx` links,
  PNG drawn from the map store, Reddit / X / Discord), ranking, team, profile, contributors and
  sponsors (static page and list), system states (offline, maintenance, paused, season ended,
  accounts down, signed out, suspended), Terms / Privacy / Trademarks drafts, dialog focus
  and reduced motion. A drag across the share preview keeps the cells under it (at least 4 a
  side), drawn again at their own scale. Profile preferences (grid lines, coordinates, sound
  effects, reduce motion) kept in this browser only; reduce motion follows the system until
  switched, and the timelapse page reads it too.
- [x] The profile's "Your season" numbers (ADR 0031, 2026-10-26): per-player counters in the
  canvas (`player_season`, one upsert per accepted batch), emptied at the seal, read through
  `POST /api/me/season` (signed in, CSRF, never cached) via FanoutDO; the card also shows
  while finalizing; not in the data download; one sentence more on the Privacy page.
- [x] A server signal for the "busy" toast (ADR 0032, 2026-10-26): CanvasDO refuses new ops
  and discards `busy` without queueing them while 256 calls wait (duplicates still answered
  as such; holds, ticks and admin calls never shed), sampled `canvas_shedding`; ack status
  0xf9; the page shows "The map is busy", keeps the item and does not resend.
- [x] A cap on players at once, to bound cost before sponsors (ADR 0039, 2026-10-27): owners
  set it in the admin area (Overview → Players at once; default 5,000, or no cap), stored in
  `site_settings` (gateway migration 0008); the gateway passes each playing socket's shard
  `ceil(cap / FANOUT_SHARDS)`; FanoutDO counts its `*playing`-tagged sockets, turns a newcomer
  away with close 4503 (no grid, sampled `fanout_full`) or frees the place of a player idle 10
  minutes (close 4408). The page checks `/api/me`'s `playerCap` against the manifest's count
  before opening a socket, retries after 45-90 s, and after 4408 waits for "Play again".
- [x] Ticks leave at once after a quiet spell (ADR 0028, amended 2026-10-27): the canvas cuts
  a change with no pump in the 250 ms before it at once, the rest at most every 250 ms, so
  players on other shards see a move sooner on a quiet map. The peak stays 4 pushes/s per
  shard; on a sparse map pushes can rise by up to 2x on average. Not measured again with k6
  yet (`tools/loadtest/diff-latency.js`).
- [x] A socket resumes from the map the page holds (ADR 0040, 2026-10-27): the page opens it
  with `?since=S&canvas=C` when it holds every tile; FanoutDO answers a Resume frame (0x87)
  and every cell touched since the step holding S from a per-mirror change list (262,144
  cells, resync steps inexact, seeded tick by tick from the canvas's ring through
  `follow()`), else the whole map. A page about to play loads
  every tile from the CDN first (3 s at most); the first retry after a drop waits 1-5 s
  (later ones their step times 0.5-1.5, and 4-12 s after a 1013, since 2026-11-02).
  Minutely `fanout_joins` counts resumed and whole-map joins.
- [ ] Measure a shard (next): bots on staging at 1,000 / 2,000 / 5,000 sockets, CPU, memory,
  join and diff latency, and a realtime deploy's reconnect time with resumes; then set
  `FANOUT_SHARDS` (probably 3-4; staging 3 from 2026-11-02, below). Tools ready
  (2026-10-27): `tools/bots` resumes like a page (`--whole-map` to compare), retries after
  1-5 s as the client does, and prints each join's time and bytes, first / resumed / whole;
  it now also retries when a connection fails outright
  (Node 22 fires no close then, so bots used to wait for good after a server restart).
  `reconnect-storm.js` resumes the same way; `diff-latency.js` takes `BOT_KEY` for staging
  senders. How to run: `tools/bots/README.md` ("Measuring a shard"). Checked on `pnpm dev`:
  10 bots, dev server stopped for about a minute and restarted, 10 of 10 resumed.
  - First run, 2026-10-27 12:01-12:31 UTC: one shard, 2,000 bots, `--rate 25`, mix 90/0/0/10,
    the lotus 192×144 (27,648 cells) at 576,600, 30 min, from a cloud container (Node 22,
    through an HTTPS proxy, US). **One shard does not hold 2,000 players all playing in one
    area**, and staging on Workers Free cannot take a second run the same day.
    - Joins: first 2,000, ready p50 1.7 s, p95 13.9 s, max 19.9 s, 23 KB each (p95 37 KB); all
      in after about 1.6 min (expected 80 s): the first 1,400 at p50 ≤ 2 s, the last ~600 at
      p50 3-11 s. Resumed reconnects 316, p50 8.2 s, p95 16.9 s, max 17.8 s, 14 KB (p95 33 KB);
      no whole-map reconnects. Closes: 1006 × 5,264 (failed opens included), 2,316 connects;
      no 4503 / 4408 / 4428 / 4409, no bot gone.
    - Ops: sent 66,818 (brick 44,648, discard 10,236, shield 4,896, single 4,144, hammer
      3,172), accepted 1,973, refused 1,328 (brick:occupied 902, discard:unavailable 234,
      hammer:empty 123, single:occupied 102), 126,645 ack timeouts; no `busy`, no `limited`.
      Acks stopped reaching the bots at about 2.5 min (accepted flat at ~1,520 from 8 to
      20 min) while the map kept changing: ops applied, acked after the bots' 40 s. They came
      back from 21 min as the lotus filled and bots mostly threw items away (to 1,973), and
      stopped for good at 25.9 min, when the daily limit below was reached.
    - Lotus: 11% at 2.3 min, 26% at 5, 51% at 10, 67% at 15, 80% at 20, 86% from 25 on
      (expected: most of it in 10-15 min).
    - FanoutDO (dashboard, first 10 min): memory peak ~40 MB, CPU p50 0.5 ms / p99 42 ms /
      p999 104 ms, wall p50 175 ms / p99 796 ms, ~7 M WebSocket frames out (~13 k/s: every
      applied op's diff to every socket viewing the lotus), 40 k in, 253 errors around the join.
      CanvasDO: ~90 RPC/s, 0 errors, wall p50 275 ms / p99 787 ms, CPU p50 2.7 ms, memory peak
      ~35 MB, 240 k rows read, 72 k written.
    - Issues: gateway 268 × "Durable Object is overloaded. Too many requests queued." on
      `GET /ws` (the FanoutDO fetch), last at 12:08; game 5 × "Requests queued for too long"
      (CanvasDO calling `FanoutDO.tick`). The limit is FanoutDO's request queue, not its memory
      or CPU: broadcasts, one canvas RPC per op and new `/ws` joins share one serial queue.
    - Workers Free: at 12:27 the account passed the Durable Objects daily limit of 100,000
      **rows written** (Cloudflare's notice and Issues: "Exceeded allowed rows written"), not
      the request limit. From then every DO call that writes failed: the last minutes'
      canvas calls (`discard:unavailable`), FanoutDO's hold alarm (it re-armed more than 10
      times a minute, `RecurringDurableObjectAlarmWarning`) and staging's `/ws` (1101), until
      about 00:36 UTC the next day (the notice says 00:00). Observability was sampled to 1%
      (over 200 k events a day), so the ops events (`fanout_joins`,
      `fanout_canvas_call_failed`) were next to absent; Issues still counted.
  - Second run, 2026-10-28 00:51-01:01 UTC, after ADR 0041 (paced frames, batched relays) and
    ADR 0042 phase 1 (player-state journal) reached staging: same command but 10 minutes and
    the lotus at an empty spot (`--at 264,312`; at 576,600 it stood at 86% from the first run,
    and a 10-minute run there at 00:37 only threw items away: 2,107 ops, 1,744 discards).
    |               | First run (30 min)                                                           | Second run (10 min)                                                                                             |
    | ------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
    | First joins   | 2,000; p50 1.7 s, p95 13.9 s, max 19.9 s                                     | 2,000; p50 1.1 s, p95 2.3 s, max 6.4 s (181 KB each, the map fuller)                                            |
    | Resumed joins | 316; p50 8.2 s, p95 16.9 s                                                   | 650; p50 3.7 s, p95 5.6 s, max 6.7 s; 413 B each                                                                |
    | Ops           | 66,818 sent, 1,973 accepted; acks stalled from 2.5 min; 126,645 ack timeouts | 8,214 sent, 7,105 accepted, 1,109 refused (`hammer:empty` 890, `brick:occupied` 217); 0 ack timeouts, no `busy` |
    | Lotus         | 26% at 5 min, 51% at 10, 86% from 25                                         | 42% at 1.3 min, 55% at 1.5, 80% at 3.5, 82% at 5, 84% from 6.6                                                  |
    | Closes        | 1006 × 5,264                                                                 | 1006 × 650, in waves about a minute apart from 2.3 min; no 4503 / 4408 / 4428, no bot gone                      |
    - Acks no longer stall and the picture fills about six times faster (80% at 3.5 min
      against about 20); the bots' 40 s ack
      timeout never fired. The 1006 waves are not explained yet (the cloud container's proxy
      or the shard): to look at with the shard's logs. `hammer:empty` (a hammer on a cell
      already cleared) rose with the faster drawing; whether pacing's 250 ms adds to it is
      open.
    - Dashboard, 00:45-01:10 UTC (the run plus the last two minutes of the 00:37 one).
      CanvasDO: 6 k requests (all RPC; the first run had 44 k in 10 min), 9 k rows written
      (72 k), so at most about 1.3 rows per accepted op against about 8 before ADR 0042;
      279 k rows read; CPU p50 2.6 ms / p99 168 ms, wall p50 135 ms / p99 448 ms, memory p50
      ~21 MB, 45 GB-s, 0 errors. FanoutDO: 0 rows written, 8 k read; 3 k HTTP (the 2,650
      joins), 1 k RPC, 16 k WebSocket messages in, 2 M out (peak ~470 k a minute, about
      4 frames a second per socket: the 250 ms pacing cap; the first run sent ~13 k a
      second); CPU p50 0.6 ms / p99 38 ms, memory p50 ~18 MB, peak ~35 MB, 48 GB-s; 656
      errors, 654 of them "client disconnected", counted on the sockets opened at the
      start: the 650 1006 closes were seen as the client side going away, not closed by the
      shard, which points at the bots' side (the cloud container's proxy) more than at the
      shard. Not proven: a run from outside that container settles it.
    - Phase 2 of ADR 0042 is not needed at this rate. Rough monthly bill on Workers Paid for
      2,000 players around the clock on 5 days, if they play like these bots: about 6.5 M
      rows written (50 M included), about 8 M requests (WebSocket messages in at 1 in 20;
      1 M included, about USD 1 past it), about 70 k GB-s (400 k included): about USD 6
      with the plan's USD 5.
    - Next: the 1,000 and 5,000 runs and a realtime deploy mid-run need Workers Paid
      (100,000 rows written a day on Free); `FANOUT_SHARDS` 2-4 at 2,000; a backoff on the
      FanoutDO hold alarm when its write fails.
  - Third run, 2026-10-28 06:38-06:48 UTC, after ADR 0043's watchdog, hold and discard changes
    reached staging: 2,000 bots, `--rate 25`, mix 90/0/0/10, the sun 192×128 at 300,560,
    10 min, same container. Staging pages and bots still took the whole map from the shard
    (`TILES_ORIGIN` empty), and the map was fuller than ever.
    - Joins: first 2,000, ready p50 4.6 s, p95 42.9 s, max 44.0 s, **314 KB each** (181 KB in
      the second run); resumed 625, p50 18.1 s, p95 30.2 s, 15 KB. Closes: 1006 × 1,191,
      1013 × 63; no bot gone.
    - Ops: sent 10,420, accepted 6,669, refused 3,157 (`brick:occupied` 2,068, `hammer:empty`
      963), 3,165 ack timeouts (none in the second run), almost all in the joins' minutes.
      The sun reached 85% and stayed there.
    - FanoutDO at 51% CPU in the first minute (the whole-map frames); CanvasDO about 3 times
      fewer requests than the second run for the same ops (discards in the relay batch),
      about 2,200 rows written; CanvasDO wall p99 33.5 s at 06:40, not explained.
    - Found afterwards: **CanvasDO's alarm had not run successfully since 27 Oct 12:26.** Its
      handler threw 7 times at 12:27-12:29 (the rows-written limit), Cloudflare stopped
      retrying, and `getAlarm()` still read back 12:26:48; `arm()` took it as pending
      and never set another, through three deploys and some 12 k calls. So the second and
      third runs had no segments, manifest, checkpoint, log shipping or trim (fewer rows
      written than a healthy canvas), and the staging bucket stood at seq 8786. Fixed with
      ADR 0044: an alarm more than a minute overdue is set again. **The shard's alarm was
      stuck the same way**: 7 throws at 12:27-12:29, none run after, every `getAlarm()` of
      the third run reading back 27 Oct 12:27:05, so `ensureAlarm` never set one. In the
      second and third runs no hold alarm and no 30 s watchdog ran: an item that came due
      after a cooldown reached a bot only with its next join or move reply. How much that
      held the runs back is not measured. Fixed the same way (PR after 32).
    - Next: the same run with pages and bots on the CDN (ADR 0044), whose joins should carry
      only what changed since the tiles. Done: the fourth run, below.
  - Watchers on staging's CDN (2026-10-28): the owner saw a move reach a watcher's screen
    after more than 5 s. By design about 5 s for a lone move (up to 2 s to the next segment,
    the uploads, up to 2 s to the next poll, the reads, up to 2 s of spreading), plus r2.dev:
    30 manifest reads 2 s apart from the cloud container, p50 0.5 s, p90 4.5 s, max 13 s, 13
    over 1 s, where the R2 API read the same object in at most 0.8 s (the bucket is in APAC).
    Built: the first segment after a quiet spell is cut at once (ADR 0014, amended), and
    staging moved to the custom domain `bp-cdn-staging.dropto.site` (ADR 0044, amended):
    tiles and segments edge-cached, the manifest not (p50 0.86 s, p90 1.1 s, max 1.8 s over
    30 reads). Left: turn r2.dev off once pages reload; a Cache Rule for the manifest; a
    shorter spread (1 s). The Cache Rule went on 2026-10-29 (p50 0.53 s, max 0.79 s). On
    2026-11-03 staging moved to `tiles-staging.brickplace.app` (ADR 0044, amended); r2.dev
    was off by then (401).
  - Fourth run, 2026-10-29 01:26-01:36 UTC, the first on production's join path: pages and
    bots load the map from the CDN (`bp-cdn-staging.dropto.site`, manifest cached) and resume,
    CanvasDO and FanoutDO alarms running again, the first segment after a quiet
    spell cut at once. Same command as the third run, the lotus 192×144 at 544,304 (an
    empty spot), same container.
    |              | Third run                                   | Fourth run                                                    |
    | ------------ | ------------------------------------------- | ------------------------------------------------------------- |
    | First joins  | p50 4.6 s, p95 42.9 s, max 44.0 s; 314 KB   | all 2,000 resumed: p50 0.5 s, p95 1.2 s, max 2.0 s; 2 KB      |
    | Map from CDN | none                                        | 2,000 of 2,000 bots, none fell back; 75 objects, 234 KB a run |
    | Joins again  | 625; p50 18.1 s, p95 30.2 s                 | 76; p50 3.3 s, p95 5.3 s; 136 B                               |
    | Closes       | 1006 × 1,191, 1013 × 63                     | 1006 × 76; no 1013, no bot gone                               |
    | Ops          | 10,420 sent, 6,669 accepted, 3,165 timeouts | 17,527 sent, 16,387 accepted, 0 ack timeouts                  |
    | Art          | 85%                                         | 27% at 1 min, 74% at 2.1, 84% at 3.1, 87% at the end          |
    | FanoutDO CPU | 51% in the first minute                     | 30% in the first full minute, then 26, 22, 22, then 19%       |
    - From about 4 min the lotus stood at 85-87% and bots mostly threw items away (7,594
      discards accepted; `hammer:empty` 813, `brick:occupied` 288): the rest of the picture is
      hard to reach with this mix, as in the earlier runs, not a server limit.
    - Analytics, 01:24-01:40 UTC: CanvasDO 7,813 RPC and 289 alarms (none in the second and
      third runs), wall p50 47 ms / p99 381 ms for RPC, 22,282 rows written (checkpoints, log
      shipping and the trim of the day's backlog included; about 1.5-2.8 k a minute, 6.7 k at
      01:30), CPU at most 3% a minute. FanoutDO 475 alarms (hold and watchdog; 3 more ended
      `clientDisconnected`), 1,970 RPC, up to 2,065 sockets, 3.2 M frames out (about 330-480 k
      a minute), 0 rows written. No errors. Day total after the run: about 23.8 k rows written
      and 33.8 k requests of Workers Free's 100 k each.
    - Next: the 1,000 and 5,000 runs and a realtime deploy mid-run need Workers Paid;
      `FANOUT_SHARDS` 2-4 at 2,000 still to decide from them.
  - 4,900 bots on one shard, twice (the players-at-once cap is 5,000 with 50 spare numbers):
    - 2026-10-31 03:45-03:53 UTC, the sun over an old picture, one bot process: FanoutDO CPU
      45-47% while joining, 37-39% after (about 2.3 frames a second a socket); first joins p50
      1.3 s, p95 4.4 s; 1,106 ack timeouts, 1006 × 400, 1013 × 67; the gateway logged "Durable
      Object is overloaded. Requests queued for too long" 60 times at 03:51 on a wave of
      reconnects, CanvasDO 3 times. The bot process ran past one core from minute 5, so part
      of the late numbers is the client.
    - 2026-11-02 02:05-02:20 UTC, random artworks, three bot processes (none past 0.9 cores):
      first joins p50 0.7-0.8 s; FanoutDO CPU 35-37% at 4,903 sockets, about 900 k frames a
      minute. At 02:10:04 Cloudflare moved the FanoutDO to another machine ("object has moved
      to a different machine"): every socket dropped, the reconnects queued past its limit
      (120 "Requests queued for too long", 503s) and from 02:15 none reached the gateway any
      more (likely the edge throttling one address opening thousands of sockets; real players
      come from many). It did not recover in the 10 minutes left.
    - So one shard is near its edge at 5,000 sockets, and a move or a realtime deploy drops
      all of them at once. Staging goes to three shards (`FANOUT_SHARDS` 3, owner, 2026-11-02;
      live once that commit deploys): 1,667 sockets a shard at the default cap of 5,000 (ADR
      0039), with room to about 2,500-3,000 a shard if the cap is raised to 7,500-9,000.
      Production's count is set before launch from the expected peak. The gateway alone
      deploys it: sockets already on shard 0 stay there until they reconnect, and shard 0's
      share drops to 1,667 at once (new players that hash to it may get 4503, or the seat of
      one idle for 10 minutes, until its count falls under 1,667). A Deploy with realtime
      ticked after the gateway is live moves everyone to their shard.
  - Open-area growth checked on staging, 2026-11-02 02:22-02:36 UTC: the open area grew from
    512² at 256,256 to 768² at 128,128 when filled cells reached 70% (66.6% by the tiles at
    02:28, past 70% by 02:31). The manifest's `stats.filled` is the share of blocked cells
    (filled plus holes no brick fits, ADR 0010's measure), so it read 75-78% before the growth:
    not the number growth uses. 1,500 bots playing through it: 0 ack timeouts, no close.
  - A local profile of the bundled CanvasDO, with the per-minute numbers above: ADR 0043
    (2026-10-28). The rules cost 7 µs an op; the rest is per call (80-104 µs at one op a
    call, 32 at 64) and two rows a call. Built from it in realtime: the watchdog runs from the
    alarm every 30 s as ADR 0028 and 0030 say (it ran on every hold alarm: a `cursor()` call
    and a Stats frame per socket as often as twice a second), the hold alarm reads an
    in-memory copy of the sockets' next-item times, `MIN_ALARM_DELAY` 1 s; discards ride the
    relay batch (`CanvasDO.applyMoves`, with a fallback to `discard()` per call against an
    older game script: deploy game before realtime). Next from the ADR: the lowered-cooldown
    run on Paid, then item 4 (canvas bookkeeping) only if its profile shows it.
- [ ] Screens follow-ups: a status page link on the maintenance card (waits on the status
  page, below);
  "Today" / "This week" rankings (after launch). (Not wanted, owner 2026-10-26: a keyboard way to pick a share
  part, preferences for signed-out watchers, a "follow the system" reset for reduce motion.)
- [x] Page flow by season phase (client, 2026-10-25): a first visit opens on the map with a
  welcome card while a game is under way, on the landing between seasons, and on neither
  through a link or while `/api/me` failed or says suspended; a season that is over makes every
  page a watcher (no socket, no hold, no "sign in to play"); the next season's start on the
  header chip, the landing chip and the "season ended" card; sign-in returns to the share link
  or team invite the page came through; the header chip hides while the season is unknown.
  At `endsAt` (page clock) a playing page turns watcher at once and asks `/api/me` again within
  30 s; a first nickname chosen while no game is under way holds the guide for the first page
  with one. A season over but not sealed is `finalizing` in `/api/me` (until the latest seal,
  90 days) and the keyframe index says `sealed` once it is; the timelapse says "final map,
  under review" until then (ADR 0021).
  `GET /api/teams/ranking?season=<id>` ranks any season that has started from its own
  canvas's standings; one that is over keeps teams closed since in their place, named "A
  closed team" (owner decision 2026-10-26: no report or reset reaches a closed team's name).
  The timelapse shows a season's winning team, linking to `/?ranking=<id>`, which opens that
  ranking on the map page. Share links carry their season (`/@x,y,zoomx?season=N`, owner
  decision 2026-10-26); one opened in another season still goes to its spot and says the map
  has changed, with a button to that season in the timelapse (`?season=N`).
- [x] Live counts and drop rates (ADR 0030): shards report playing sockets per team with the
  watchdog's `cursor()`, the canvas sums fresh reports in memory; Stats frame (0x86) with the
  canvas total and the socket's team total; `GET /api/stats` (playing, phase, filled %, rates
  per phase) through shard 0, edge-cached 15 s, answering 503 (nothing cached) while realtime
  or game predates stats; header pills, team pill count and "Drops now". Shield layers drawn
  as pips with a hover count. Design artifact v22.
- [x] Stats in the CDN manifest (ADR 0033, 2026-10-26): the manifest carries `stats` (the
  `/api/stats` body and `at`); a count change alone rewrites it at most every 15 s, also on an
  idle map, unchanged counts every minute while anyone plays, and the count falls back when a
  shard's report goes stale. Pages watching through the CDN read them there and skip
  `/api/stats` while they are fresh and still moving, so spectators no longer cost a gateway
  Worker request a minute each; pages with a socket still poll.
- [ ] Live counts follow-ups: spectators without a socket are not counted ("playing now").
- [x] Seasons (ADR 0021, accepted): a canvas per season, registry in D1 (`seasons`, migration
  0005) read by the gateway (sockets to `{canvas}:fanout-0`, `config.season` in `/api/me`,
  `/api/seasons`, the team ranking of the current season's canvas); the end and a read-only
  switch in CanvasDO (`setSchedule`, acks `ended` / `read_only`, checked on the logical
  clock); closing (final checkpoint, log, CDN, final keyframe); sealed archive 90 days after
  the end (`archive/c/{canvas}/` in OPLOG, `who` pseudonymised with a discarded key, teams
  kept only with 10+ players, removals list) and the canvas's own ids stripped (holds, dedupe, team credit, writer
  names, op_log tail: ADR 0020's id strip); hourly keyframes of changed tiles and
  `timelapse.html`; holds and team counters start fresh with each canvas.
- [x] Seasons follow-ups (lane M): `/api/me` names the next season; an open page asks again
  just after its start (spread over 30 s) or after a move refused `ended`, and a hidden page
  reloads while a visible one shows a "new season" card with Reload; archive-only removals
  from the admin page (Season → Archive); each keyframe has an overview, which a timelapse
  shown small plays instead of tiles.
- [x] Deploy check for `ITEM_DRAW_KEY` (ADR 0025, proposed): after the game deploy, every run
  lists the game script's secret names and fails before realtime and the gateway ship when the
  key is missing (`tools/ci/check-secrets.ts`); a CanvasDO starting without it logs
  `item_draw_key_missing`. No health route: the game script has no public one.
- [x] Admin behind Cloudflare Access (ADR 0022, accepted): `workers/admin` on its own
  hostname, Access JWT checked against the team's keys, roles in its own D1, config versions
  (items, growth) with `effectiveAt` picked up by CanvasDO, append-only audit log, emergency
  cooldown ×2 and read-only (moderators too; only owners reopen), a plain HTML page,
  `pnpm dev:admin` locally.
- [x] Admin on seasons (ADR 0021, 0022): the read-only switch and season create, schedule
  and end call CanvasDO.setSchedule and the D1 registry together (undone or reported as
  `inconsistent` when one side fails), audit rows before and after each call, the current
  canvas from the registry; the Stage 0 canvas always ends at the earliest season's start;
  seasons never overlap, and every start lies at least 5 minutes ahead.
  - [x] Player moderation in the admin area (ADR 0023, accepted): report queue grouped by
    target (dismiss, or act and close), team-name reports (reason `team_name`, accounts
    migration 0006, a client entry on the team screens), nickname and team-name resets to
    `player_<n>` / `team_<id>` (the next choice skips the 30-day limit; placeholders reserved),
    bans with a reason and optional expiry (permanent ones lifted by owners only), moderators
    closing teams, no acting on an account with the admin's own email, and `FanoutDO.kick`
    closing a player's sockets at once on ban, nickname reset and account deletion.
- [x] Admin follow-ups (lane M): archive-only removals (`setRemovals`, added or dropped against
  the list read, `stale` otherwise; one of every player's ops needs an owner) and an owner's
  "seal now" (`requestSeal`, once ended), audited before and after; a new season's canvas
  takes the item config and growth rule in force (`config.carry`, ADR 0022, owner decision).
- [x] Review leftovers (lane M): a damaged `who` logs `who_unreadable` (canvas, seq) and the
  rollback preview counts `unattributedOps`; recovery skips copies of another format unread
  and downloads at most 4; a dropped damaged checkpoint takes its team checkpoint with it;
  recovery progress checkpoints are flushed (`storage.sync()`); a failed season create counts
  as standing only on an open canvas; `docs/ops/alerts.md` on a damaged `seal_failures`.
- [x] Map moderation (ADR 0024, accepted): rollback by player / area / time range as a core
  `restore` log entry (golden fixture `restore`): a dry run replays the log without those ops
  (from the checkpoint, or from seq 0 through R2) and must rebuild the live map first, then
  apply logs the cells that differ; restored cells go back to their earlier writer's team;
  each rollback becomes a seal removal (by pseudonym), the archive leaving restore rows out;
  area locks refused with `locked` (ack 251), sent in the config frame and the manifest,
  striped on the map; admin routes (`map.ts`) and the page's Areas and locks view, audited
  before and after.
- [x] Admin page rebuilt from scratch after the "Admin & moderation" artboard: a sidebar with
  one view at a time (Overview, Reports, Areas and locks, Season, Game config, Players, Admins,
  Audit log), live counts on the overview (`GET /api/stats`), one confirm dialog that takes the
  reason (no more `prompt`/`confirm` chains), toasts, `workers/admin/src/ui/`. Not in it from
  the artboard: moves per second and apply-time p99 (no source in the admin Worker yet) and a
  Sponsors section (no backend).
- [ ] Map moderation follow-ups (ADR 0024 questions): one replayed state instead of two (the
  baseline checked against a stored hash) to raise the ~110,000-layer memory limit; a rollback
  after the season's end (today removals only, the final CDN map keeps the content until the
  seal). (Hourly checkpoint copies bounding the replay: done, ADR 0024 §10.)
- [ ] Moderation: bulk ban-and-revert of linked accounts.
- [x] Abuse (ADR 0026, proposed; every number in KV `abuse-policy` / `trust-weights`, none in
  the repo): one playing socket per account (an older one closes with 4409; the page watches
  through the CDN until its player taps "Play here"); socket opens per account, per address
  key (IPv4, IPv6 /64) and per IPv6 /48 refused 429, ops per account `unavailable`, 8 ops in
  flight per account
  always; a trust score (0..100) from D1 facts at every token issue, carried in the token,
  limiting hammers and shields per window (new ack `limited`, item kept); view frames from
  playing pages (client opcode 0x06) and three bot signals (outside the view, no view,
  exact-cooldown timing) feeding a decaying suspicion that lowers trust and, past a threshold,
  requires a fresh Turnstile (close 4428, the move held and resent after `POST
  /api/challenge`); flagged accounts listed read-only in the admin area; `abuse_policy_missing`
  and minutely `fanout_abuse` events. Fails open without a policy (error event).
- [ ] Abuse follow-ups (ADR 0026 questions): signals and suspicion are memory only (a realtime
  deploy forgets them), durable per-account history in D1 if data shows a need; per-shard
  routing by account once a canvas has more than one fanout; a local `abuse-policy` for
  `pnpm dev` if the limits should be tried by hand (dev runs without one, limits off).
- [x] Ops events (ADR 0025, proposed; list and runbook in `docs/ops/alerts.md`): structured
  logs with stable `event` names and no player ids. Seal: `archive_seal_failed` on every failed
  attempt, `archive_seal_stuck` from the fifth, `archive_sealed`; the failure count lives in
  meta `seal_failures`, so the backoff survives evictions, and only a completed seal clears
  it; a SyntaxError is logged by name only (it may quote ids). Overload, sampled to one
  per minute: `canvas_queue_deep`, `canvas_tick_slow`, `fanout_join_refused`,
  `fanout_sockets_high`, `fanout_canvas_call_failed`. Workers Issues on in game, realtime and
  gateway, so error events and 5xx reach the owner's automations.
- [x] k6 reconnect storm (`tools/loadtest/reconnect-storm.js`): the client's real backoff and
  jitter; first local run, 1,000 clients all back, p95 4.3 s, every op after it acked.
- [x] Game tests no longer race real alarms (a test-only deferral, `workers/game/src/alarms.ts`):
  five game runs in parallel went from 4-7 failures each to none (the four CPU-bound tests
  that still passed 15 s under that load now have 60 s). The realtime, gateway and admin tests
  that host CanvasDO defer its alarms the same way. The realtime tests that waited on the wall
  clock (an item due in 5 s, behind checks 3-4 s out) now make the item due and run the
  alarm or the check themselves: 3-5 s each down to under 0.2 s, five parallel runs clean.
  `ws-smoke.js` plays as fresh dev identities and discards the item it holds (every ack ok).
- [ ] Ops follow-ups: the owner wires the alerts (below); a reconnect storm on staging
  (watchers only, `MODE=server` with a realtime deploy) late enough in a season for full-size
  grids; a status page (deferred by the owner, 2026-10-26; see below).
- [ ] Status page, later (owner, 2026-10-26: noted, not now). Option discussed: its own Worker
  script on `status.<domain>` that binds no ACCOUNTS or CanvasDO, so our own failures (a bad
  game or gateway deploy, an overloaded canvas, slow D1 or R2) do not take it down. A Cron
  Trigger checks gateway `/healthz`, `/api/stats` and how fresh the CDN `manifest.json` is
  (where `TILES_ORIGIN` is set; keyframes are hourly and only after changes, so not those),
  and keeps the results in KV. Operators write incident notes from the admin area into the
  same KV, with an optional "back around" time that the maintenance answer would then send
  as `until` (new work: today nothing sends one, so the card says "Back soon"). The page
  itself is static, briefly cached, and links cloudflarestatus.com plus an outside channel
  for a Cloudflare-wide outage, which would take it down too. The client gets the URL from
  config; the maintenance card shows "See status page" only when it is set. Needs an ADR (a
  fifth script, a deploy step), a KV namespace and a route set up by the owner. Lighter
  alternative: Upptime on GitHub Actions and Pages, or a hosted free tier, fully off
  Cloudflare.
- [ ] Off-site backup of op-log segments and season archives (S3 or B2) before season 1 ends.

## Going open source (ADR 0046: now, before season 1, as a fresh repository)

- [x] Reporting address in CODE_OF_CONDUCT.md and SECURITY.md contact (`ndk98z.tech@gmail.com`).
- [x] Scan of the private repository (2026-11-09): 595 commits on every branch and PR ref, 45
  PRs, Deploy logs. No secret, no abuse threshold; what history keeps is in ADR 0046.
- [x] Content cleanup: no private design links or old PR links; account id as a secret.
- [x] Owner: gitleaks over the full history (2026-11-09, 547 commits, default rules): no
  leaks. Workers Secrets stay as they are (ADR 0046).
- [x] Owner (2026-11-09): `develop` squashed into one signed-off commit; the old GitHub
  repository renamed `brickplace-archive` (private, Actions off); the new `ndk98z/brickplace`
  created and public, the commit pushed as `develop` and `main`. Game and realtime had not
  changed since their last staging deploy, so `deployed/staging/{game,realtime}` were tagged
  fresh on the squashed commit (never the archive's tags: they carry the old history).
- [x] Owner, on the new repository (2026-11-09): variables, `CLOUDFLARE_ACCOUNT_ID` as a
  secret, a new `CLOUDFLARE_API_TOKEN` in `staging`, environments (`production` with a
  required reviewer), rulesets, labels, an allow-list of actions pinned by SHA, private
  vulnerability reporting, secret scanning with push protection, Renovate, the Claude
  GitHub App.
- [x] Owner (2026-11-10): `DEPLOY_ENABLED=true`. The first deploy from the new repository
  (dispatched on `develop`) skipped game and realtime, shipped gateway and admin, and masked
  the account id in the log. Staging answers `/healthz`. The rulesets' required checks now
  come from GitHub Actions. The first pushes had ended in `startup_failure` because of a
  billing setting, since fixed.
- [x] Owner (2026-11-10), on the archive: its `CLOUDFLARE_API_TOKEN` deleted and revoked in
  Cloudflare; `brickplace-archive` archived (private, read-only).
- [x] README links staging (<https://staging.brickplace.app>) for anyone who wants to try it.
- [ ] Trademark search for "BrickPlace" (USPTO, WIPO, Vietnam); buy brickplace.io / .gg.
- [ ] Legal: Decree 147/2024 (G1 licence) and EU DSA obligations for the operator.

## Open decisions (owner)

Proposed in the scale review (design doc, tab "Scale triệu CCU"), not decided yet. None of
them blocks the "Now" list:
- Open-area growth driven by fill rate instead of a 70% threshold.
- Staggered starting items at season start; a random end within a window (or a slower
  hammer in the final hour) against last-minute sniping.
- An automatic Claude review workflow on every PR (needs `ANTHROPIC_API_KEY`).
- `workers_dev` on the Workers' `wrangler.jsonc`: deferred by the owner (2026-10-25). Since
  2026-11-03 off for the staging gateway (ADR 0045, amended; it already was for game and
  realtime); production's gateway to write it off when it gets its domain.
- ADR 0021 (accepted), still open: publishing the sealed archive, seal timing (90 days or
  sooner), keyframe interval (recommendations in the ADR, built as recommended).
- ADR 0019 (accepted), still open: no Turnstile on reports; `/auth` and `/api` limited by
  owner-set WAF rules, not code; a banned account cannot delete itself.
- ADR 0024 (accepted), still open: one replayed state instead of two before the first public
  season; checkpoint copy retention (48 hourly + 31 daily) and recovery limits
  (recommendations in the ADR; the copies themselves are built, §10).
- ADR 0020 (accepted), still open: cells count for the team at write time; the cap counts
  placed cells only; team names follow nickname rules (no spaces); teams persist across
  seasons with standings per canvas (all built as recommended).
- ADR 0022 (accepted), still open: refusing a scheduled version while another is pending for
  the same scope; shield lifetime and cap as admin settings.
- ADR 0023 (accepted), still open: a banned owner's open team; "owner gone" by judgment or a
  rule (recommendations in the ADR).
- Legal pages (`apps/client` Terms, Privacy, Trademarks): filled on 2026-10-25 (accounts
  from 13, a parent's agreement under 16; law of Viet Nam, courts of Ha Noi, consumers keep
  their own mandatory law; logs 7 days, backups 31 days; contract, legitimate interests,
  legal obligation and Vietnamese consent as legal bases; A05 or the EU/UK authority; the
  Cloudflare DPA with SCCs and the DPF). On 2026-10-26 the owner moved the date to
  31 December 2027 and dropped the "Draft" banner; an outside legal review stays optional.
- ADR 0025 (proposed): ops alerts from structured log events and Workers Issues (no paid
  service); a deploy-time secret check instead of a health route; default thresholds (64
  queued calls, 2 s ticks, 5 seal failures, 80% of a FanoutDO's sockets).
- ADR 0026 (proposed): fail open without `abuse-policy` (with an error event); closing an
  older tab rather than demoting it; the `noView` weight while cached pages send no views;
  suspicion kept in memory only (recommendations in the ADR).
- ADR 0028 (proposed): a 250 ms tick (players on another shard see a move 0-250 ms later), the
  shard count (`FANOUT_SHARDS`, 1 until set), views of the screen plus one tile, and the limits
  (views every 250 ms, Tile frames 4 MiB burst then 1 MiB/s per socket, a ring of 2M cells);
  lane A's per-address open limits count per shard, so N shards make them N times weaker; a
  game rollback to a version from before it needs `FANOUT_SHARDS` set to 1 first.

Decided on 2026-10-23: ADR 0007 (no extra hammer limit, shield layers expire after 48 h,
fixed cooldown changed by admins, first op to arrive wins a conflict) and ADR 0008 (where
data lives; email is stored; op-log user ids kept until 90 days after a season, then
stripped; deleting an account keeps the cells and drops the link; players choose their own
nickname), ADR 0009 (spectators read the map from the CDN without a socket) and ADR 0010
(one-week seasons, a single-brick late game accepted, phases by brick room, bricks drawn
only in a shape that fits, otherwise a shield, one-cell hammer kept, a hammer removes the
newest shield layer). Decided on 2026-10-24: ADR 0011 (starting drop rates k1, no
brick-room threshold), ADR 0012 (discard stays, one starting item, holds cleared each
season, salted HMAC item draws), ADR 0013 (the open area grows automatically) and ADR 0014
(two R2 buckets: private op log, public map; spectators about 2-4 s behind), ADR 0015–0017
(sessions as signed tokens, accounts in D1, dedupe by connection). Also on
2026-10-24: nicknames use ASCII letters, digits and `_` only; a ban or sign-out-everywhere
may take up to about an hour to reach an open socket (closing sockets on ban is moderation
work).

Decided on 2026-10-25 (all as recommended; ADRs 0019–0024 accepted): KV caps missing
(`report-daily-limit`, `team-daily-cells`) fail closed and a deleted account's nickname is
free at once (ADR 0019); team names and nicknames never equal each other in any letter case,
both ways, the rest through reports, and "Today" / "This week" rankings after launch (ADR
0020); archive pseudonyms, `archive/` locked indefinitely, and a team kept beside them only
with at least 10 players in the season's log (ADR 0021, built); moderators may pull the
emergency switches (cooldown ×2, read-only on; only owners reopen) with the identity
provider's MFA and an 8-hour Access session for every admin (owner config), and a new season's
canvas copies the config versions in force (ADR 0022); moderators may ban permanently, only
owners lift, and "sign out everywhere" kicks open sockets (ADR 0023); moderators roll back one
player and lock areas while a rollback of every player's ops needs an owner, restored cells
count for the earlier writer's team, locks may have no end, and rolled-back players get no
notice (ADR 0024); about 72% of art kept with 30% griefers is accepted (ADR 0011, numbers
re-run). The legal pages name the operator, its address and contact address from the deploy's
`VITE_*` variables (ADR 0037, GitHub repository variables), the effective date (2 November 2026; 31 December 2027 since 2026-10-26), sponsor address and the archive team policy.

Decided on 2026-10-26 (as recommended): per-player season numbers count moves made (a
rollback does not lower them), show while a season is finalizing and stay out of the data
download (ADR 0031, built); the canvas sheds moves past 256 waiting calls, for the whole
map, with no client back-off (ADR 0032, built).

## Blocked / needs the owner

Step by step, with commands and where staging stands: [docs/ops/setup.md](docs/ops/setup.md).
Staging is up (first deploy 2026-10-25; every merge to `develop` deploys it, ADR 0036). Still open there: the
`abuse-policy` and `trust-weights` KV keys, Google and Reddit sign-in, the admin area's first
owner row, and alerts.
Production: none of it yet. The list below is what each environment needs.
- **`brickplace.app` is a zone (owner, 2026-11-03).** Staging's tiles moved to
  `tiles-staging.brickplace.app` (ADR 0044, amended; custom domain, manifest Cache Rule for
  both tiles names, CORS for the workers.dev origin and `staging.brickplace.app`, cache
  purged, all checked before the PR). The bucket's r2.dev address is off (401 on
  2026-11-03). Staging's pages moved to `staging.brickplace.app` (ADR 0045: custom domain,
  `PUBLIC_ORIGIN`; the token, OAuth redirects and Turnstile hostname were set first; the
  workers.dev address, kept a few hours to redirect old pages, then went off with the
  redirect, ADR 0045 amended). Deployed 16:07 UTC;
  sign-in (Discord, Google) and a move checked by the owner. The same evening
  `bp-cdn-staging.dropto.site` and its Cache Rule were removed and the bucket's CORS allows
  `staging.brickplace.app` only (checked: no header for the workers.dev origin). The WAF
  rate-limiting rule on `/auth/` and `/api/` is on the zone (ADR 0019; Free plan, per IP,
  10 s; the number in `ops-private/`), checked: the requests past the limit got 429 on both
  paths and the API answered again 10 s later. With the workers.dev address off it cannot be
  skipped, and it will cover production's hostnames too. Production will use `brickplace.app`
  and `tiles.brickplace.app`.
- Cloudflare account, then in GitHub repo settings:
  - repository **secret** `CLOUDFLARE_ACCOUNT_ID` and **variable** `DEPLOY_ENABLED=true`
    (ADR 0046; deploy jobs are skipped until the variable is set; job conditions cannot see
    secrets or environment variables);
  - the **secret** `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit and D1 Edit for migrations,
    account-scoped), on the repository or per environment (docs/ops/setup.md); environments
    `staging` (deployable from `develop` only) and `production` (from `main` only; owner as
    required reviewer once the repo is public); repository variable `PRODUCTION_ENABLED`
    turns production on. PR previews were removed.
- Cloudflare resources before the first staging deploy (names go in each `wrangler.jsonc`,
  values never in the repo):
  - R2: an op-log bucket per environment with no public access, and a tiles bucket per
    environment on a custom domain with caching, CORS for the game's origin and tiered
    cache. No lifecycle rule on `tiles/` or `diffs/` (the canvas deletes what it stops
    listing; an unchanged tile keeps its version for days).
  - D1 `brickplace-accounts-{staging,production}`, ids in the gateway's `wrangler.jsonc`,
    then the deploy workflow applies `workers/gateway/migrations/` first in each deploy
    (staging and production tokens need D1 Edit, see above).
  - D1 `brickplace-standings-{staging,production}` (team standings, ADR 0020), ids in both
    the game's and the gateway's `wrangler.jsonc` (binding `STANDINGS`); the deploy workflow
    applies `workers/game/migrations/` right after the accounts ones.
  - The admin area (steps in ADR 0022), whenever wanted: D1
    `brickplace-admin-{staging,production}` with ids in `workers/admin/wrangler.jsonc` (plus
    the accounts database's ids in its `ACCOUNTS` entries, for the season registry), a
    hostname as the admin script's custom domain (staging: `admin-staging.brickplace.app`
    since 2026-11-03, before that its workers.dev address, ADR 0029 amended), a self-hosted
    Access application on it whose policy requires the identity provider's MFA, with an 8-hour session (its AUD tag and the team domain into `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`), then the
    **environment variable** `ADMIN_ENABLED=true` on that GitHub environment, not the
    repository (until then the deploy workflow skips, in that environment only, the
    admin migrations and deploy), and the first owner row inserted with `wrangler d1 execute`.
  - KV namespace `MODERATION` per environment, written from the private ops repo: the
    nickname word list (key `nickname-words`; without it nicknames and team names are
    refused), the daily report cap (key `report-daily-limit`, a whole number; without it
    reports are refused) and the daily team cap (key `team-daily-cells`, a whole number of
    cells; without it no cell counts toward a team; `pnpm dev` writes a local one), the abuse
    policy (key `abuse-policy`, JSON: socket-open and op limits, trust tiers, bot-signal
    weights and the Turnstile threshold, shape in ADR 0026; without it every abuse limit is
    off and realtime logs `abuse_policy_missing`) and the trust score weights (key
    `trust-weights`, JSON, ADR 0026; without them tokens carry no score and the policy's
    `unscored` applies). Its id goes in the gateway's, the game's and the realtime
    `wrangler.jsonc`.
  - R2 bucket lock on each OPLOG bucket, prefix `archive/` only (ADR 0021):
    `wrangler r2 bucket lock add brickplace-oplog-<env> archive-forever archive/
    --retention-indefinite`. Never on `c/` or on the tiles buckets.
  - A WAF rate-limiting rule on `/auth/` and `/api/` per zone, numbers kept in the private
    ops repo (steps in ADR 0019; on `brickplace.app` since 2026-11-03, shared by staging and
    production); optionally `/ws` too, for per-IP socket opens before the
    Worker runs (realtime then counts per account and per address, ADR 0026).
  - Turnstile widget per environment: site key in `wrangler.jsonc`, secret below. The same
    widget serves sign-up (action `signin`) and the "quick check" on suspicious activity
    (action `challenge`, ADR 0026).
  - `PUBLIC_ORIGIN` and the three OAuth client ids in the gateway's `wrangler.jsonc`.
  - Secrets: `ITEM_DRAW_KEY` on the game Worker (nothing is drawn without it);
    `SESSION_KEYS` (`kid:secret`, first one signs), `TURNSTILE_SECRET_KEY`,
    `GOOGLE_CLIENT_SECRET`, `REDDIT_CLIENT_SECRET`, `DISCORD_CLIENT_SECRET` on the gateway.
- Alerts, with production and before public traffic (`docs/ops/alerts.md`; staging goes
  without, owner decision 2026-10-26): a Workers Issues automation for game, realtime and
  gateway to somewhere the owner reads (Discord), and Cloudflare usage notifications. Saved
  queries and a trial alert are optional: Issues reports real errors on its own.
- First season (ADR 0021): deploy realtime (new ack statuses) before any end or read-only
  switch is set; then create the season from the admin area (Season → New season), which
  writes the D1 row, sets the same end on its canvas and sets the Stage 0 canvas `canvas` to
  end at its start (so pages still open on `fanout-0` stop playing it). Without the admin area
  this is done by hand: the row, `setSchedule({endsAt})` on the season's canvas, and
  `setSchedule({endsAt: s1.startsAt})` on `canvas`.
- First deploy of moderation (ADR 0023): record a D1 Time Travel bookmark of the accounts
  database before migration 0006 applies (`wrangler d1 time-travel info
  brickplace-accounts-<env>`; 0006 rebuilds `reports`). Shipping it redeploys realtime (new
  `kick`), which drops every open socket once.
- First deploy of the inventory: game goes before realtime; until realtime is out, the old
  FanoutDO acks a `no_item` refusal as accepted.
- OAuth apps: Google Cloud Console, Reddit (reddit.com/prefs/apps), Discord Developer Portal,
  each with the redirect URI `${PUBLIC_ORIGIN}/auth/{google|reddit|discord}/callback`, with
  credentials per environment (`docs/ops/setup.md`, step 6). Staging: Discord and Google done;
  Reddit on hold until a Reddit post has gauged interest (owner, 2026-10-26); production: none
  yet.
- Operator variables on the GitHub repository (ADR 0037, `docs/ops/setup.md` step 4.6):
  `VITE_OPERATOR_NAME`, `VITE_OPERATOR_ADDRESS`, `VITE_CONTACT_EMAIL` (deploys fail without
  them), `VITE_KOFI_URL` (Donate stays off without it).
- GitHub Sponsors sign-up for `ndk98z` (the repo's FUNDING.yml already points at it).
- `ANTHROPIC_API_KEY` repository secret if the `@claude` workflow should run.
- Done 2026-10-26: Ko-fi test donation arrived and can be withdrawn in Vietnam; Renovate
  installed through Mend (Renovate Only, interactive, this repository only).
