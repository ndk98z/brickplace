# 0020. Teams and the team ranking

- Status: accepted
- Date: 2026-10-24 (proposed), 2026-10-25 (accepted)

## Context

PROGRESS.md asks for teams (create every 7 days, switch every 3 days, the owner leaving closes
the team) and a ranking by cells standing, with a per-account daily contribution cap. ADR 0008
puts teams and rankings in D1, "fed by counters flushed from DOs every 60 s", and a "last writer
per cell" index in DO SQLite for moderation's rollback. The approved UI design has a team
screen and a ranking screen, and says "what you do counts for the team you are in at that
moment". Constraints: the op log is trimmed once a checkpoint and R2 hold it (ADR 0014); a
session token lives an hour (ADR 0015); abuse thresholds stay out of the repo (ADR 0002);
team tracking is not a game rule, so `packages/core` and the golden fixtures stay as they are.
Until now the op log did not record who sent an op at all.

## Decision

1. **Team at write time.** A cell counts for the team its last writer was in when writing
   it, never their current team: switching cannot carry thousands of cells to a winning team,
   and the count is a pure function of the log. A closed team's cells stay on the map and keep
   counting for it (no one else); the team drops out of the ranking.
2. **Who wrote what, beside the grid.** Every op_log row of player ops gets a `who` column:
   `[player, team]` per op, the team the op counted for (0: none). Open-area rows have none.
   The ops column, `LogEntry` and the core are unchanged, so no golden fixture changes. CanvasDO
   keeps a `TeamLedger` (`workers/game/src/teams.ts`): a writer id per cell (a `Uint32Array`,
   16 MiB at 2048²), `(player, team)` pairs in a SQLite `writers` table, and per team: cells
   standing, built, cleared and shields placed. It is updated per op from the core's diffs: a
   placement gives its cells to the writer, a hammer that empties a cell takes it from its
   team (a hammer that only breaks a shield layer changes no writer), a shield changes no cell;
   discards and growth rows change nothing. It is checkpointed beside the grid (run-length
   writer ids plus season totals, gzipped, own SQLite parts) and made current **in the same
   transaction** as the grid checkpoint, so the two always share a seq; restore loads it,
   recounts cells standing once, and replays the tail's `who` like the grid replays its ops.
   Rows without `who` (logged before this) count for nobody. The same index answers
   moderation's "last writer of this cell" (`CanvasDO.lastWriter`, internal only).
3. **The team reaches CanvasDO in the session token.** The token gains `t`, the team id; the
   gateway reissues it whenever the account's team differs (every team change answers with
   the new cookie, and `/api/me` checks it on every renewal). The gateway passes it to FanoutDO
   in `X-BrickPlace-Team` (client copies are stripped), FanoutDO keeps it on the socket and
   sends it with every op. No D1 read per op, no cache to invalidate. After a change the page
   moves play to a new socket. A page or copied token elsewhere keeps playing for the old team
   until its socket's token expires, at most an hour per change, bounded by the 3-day wait.
4. **Ranking from D1 snapshots, in a database of their own.** CanvasDO writes changed teams'
   absolute stats to `team_standings` at most once a minute, in the **standings** D1 database
   (binding `STANDINGS`, schema in `workers/game/migrations`). The game Worker never binds the
   accounts database (owner decision); the gateway binds both. `GET /api/teams/ranking`
   (public) reads standings 200 at a time (up to 10 pages), each page followed by the names and
   closed flags of its teams from accounts, drops closed teams and keeps the first 100 open
   ones: open teams by cells standing, ties sharing a
   rank, with built, cleared, shields, member count and `updatedAt`. It is cached at the edge
   for 60 s (Cache API) and in browsers for 30 s, and so is the unfiltered team list (the top
   of the ranking, topped up with the newest teams). Name searches and team detail are public
   and not cached; a team's rank is its place in the ranking (none outside the top 100), read
   from the standings ahead of it only, not by building the whole ranking. Only
   the season ranking exists; the design's "Today" and "This week" tabs are left out until after
   launch (owner decision, 2026-10-25).
5. **Daily contribution cap: cells placed per account per UTC day that count toward its
   team**, by the op's logical time. Past it, cells are placed and owned by the player but
   count for no team; hammers and shields always count (they add no cells). The number is
   KV `MODERATION`, key `team-daily-cells`. CanvasDO reads it at most every 5 minutes and
   **never makes an op wait for the read**: ops use the value already read, so a slow or
   failing KV cannot hold up the map (a failed read keeps the last value; a read with no
   answer within 5 s counts as failed, so a hung KV cannot stop later reads). **Until a value has
   arrived, and whenever the key is missing or malformed, no placement counts toward any team
   (fail closed)**, like the report cap: the ranking visibly stops moving instead of taking
   unbounded farming. Nothing in the game depends on `ENVIRONMENT`; `pnpm dev` writes a large
   value into local KV. Counts live in SQLite (`team_credit`), written with the ops.
6. **Lifecycle** (`workers/gateway/src/teams.ts`, migration 0004; rules are conditions of the
   statements that apply them, so racing requests cannot pass them):
   - Create (`POST /api/teams {name, color}`): a nickname is needed; name as a nickname
     (ASCII letters, digits, `_`, 3–20, word list in KV), unique case-insensitively among open
     teams and never any account's nickname (see "Team names and nicknames"); colour from the 32-colour palette; at most one creation per 7 days and one open
     team owned; creating joins it.
   - Join or switch (`POST /api/teams/:id/join`): at most one join per 3 days, counted from
     the last join (creating counts); free right after one's team closed. An owner must close
     their team (leave) before joining another.
   - Leave (`POST /api/teams/leave`) any time; the owner leaving closes the team: members
     leave it with a free next join, the row loses its owner and is kept (ids never reused).
   - Account deletion (ADR 0019) closes the team the account owns and drops its membership in
     the same D1 batch. Its cells keep counting for the team they were built for.
   - The data download includes the team and the times the rules count from.

## Consequences

- Owner setup per environment: create `brickplace-standings-{staging,production}` (`wrangler
  d1 create`) and put its id in both the game's and the gateway's `wrangler.jsonc` (binding
  `STANDINGS`); put the `MODERATION` KV id in the game's too; write the cap from the private
  ops repo: `wrangler kv key put team-daily-cells <N> --binding MODERATION --env <env>
  --remote`. Without it nothing counts toward teams. The deploy workflow applies accounts
  migration 0004 and the standings migrations before any script ships. Deploy order stays
  game, realtime, gateway: older FanoutDOs send no team.
- Memory and cost: +16 MiB per canvas at 2048² (grid state is about 12 MiB), plus 4 bytes per
  (player, team) pair (their team; names stay in SQLite behind a 10,000-entry cache), so a
  million pairs cost 4 MiB; one `writers` row per new pair and one `team_credit` row per
  counted placement. The team checkpoint adds a run-length pass and a gzip to the
  once-a-minute checkpoint; while it runs, its encoded body (up to about 4 bytes per cell in
  the worst case, 16 MiB at 2048², a few hundred KiB for a typical map) and its gzip are held
  beside the grid checkpoint's. D1 gets one upsert per changed team per minute.
- A segment written but not recorded right at the deploy that adds the `who` column would not
  match its rows (`"who":null` appears) and stops trimming until handled by hand; nothing is
  deployed yet.
- A KV outage only freezes the cap at its last value (read again every 5 minutes, so ops do
  not wait on it); an empty key freezes team credit. A team checkpoint that does not read
  back is logged and dropped at start-up: the map starts, the ranking loses what it held.
- Deleting an account (ADR 0019) leaves its id in the canvas's `writers` and `team_credit`
  rows, as in the op log, with nothing mapping it to a person.
- Closed teams near the top of the standings cost reads, not places: the ranking reads further
  pages until it has 100 open teams. Only with more than 1,900 closed teams among the top
  2,000 standings do fewer than 100 teams show.

## Stripping player ids after a season

ADR 0008 strips user ids from the op log 90 days after a season ends. Op-log rows now carry
`who`, and the canvas keeps ids beside it, so that job must also do the following. The
season seal implements all of it (ADR 0021, `workers/game/src/archive.ts`), with each player
replaced by a per-season pseudonym whose key is deleted, not dropped, so the stripped log
still replays the team ledger:
- rewrite `who` in every R2 log segment, writing the new objects under a new prefix and only
  then deleting the old ones (as ADR 0014 already plans for the ops);
- replace `writers.player` with a value unique per writer id (for example the id itself), so
  the ledger keeps its ids and counts but names no one;
- delete every `team_credit` row;
- rewrite `who` in the op_log rows still in SQLite.
  Team ids stay: teams are not personal data. Beside pseudonyms they can still point to a
  player, so the seal keeps a team in the archive only when at least 10 players played for it
  (ADR 0021, owner decision of 2026-10-25); the canvas's own ledger keeps every team.

## Team names and nicknames

Team names and nicknames share one shape. Neither may equal the other in any letter case
(owner decision, 2026-10-25), so no team is named after a player to pass for them, and no
player after a team:
- creating or renaming a team refuses a name that is any account's nickname, its owner's
  included (`taken`);
- choosing a nickname, first or renamed, refuses a name an open team holds (`taken`). A closed
  team's name is free, as it is for new teams;
- each check is a condition of the `INSERT` or `UPDATE` that writes the name
  (`workers/gateway/src/teams.ts`, `openTeamNamed` / `nicknameHeld`), so a team and a nickname
  written at the same moment cannot both take it. Both lookups use existing indexes
  (`users.nickname_key` is UNIQUE, `teams_open_name` covers open teams), so no migration;
- the moderator placeholders `player_<n>` and `team_<id>` stay refused as anyone's choice,
  for either (ADR 0023);
- anything short of an exact match (`Alice_` against `Alice`, look-alike letters) is left to
  reports: the reasons `impersonation` and `team_name`, and a moderator reset (ADR 0023).

## Decided by the owner

- 2026-10-24: the game Worker does not bind the accounts database; standings have their own D1
  database.
- 2026-10-25:
  - **Fail closed when the cap is missing**, as built (like reports, ADR 0019).
  - **Team names against nicknames**: exact matches in any letter case blocked both ways, the
    rest through reports (above).
  - **"Today" and "This week" rankings after launch**; only the season ranking until then
    (planned: rank by cells built in the window, per-day buckets).
  - Team-name reports: built in ADR 0023 (reason `team_name`, moderator name reset and team
    closing).

Still open (built as recommended; recommendations in brackets):
- Team at write time [yes, as the design copy says].
- The cap counts placed cells only [yes; hammers do not raise a team's standing].
- Team names follow nickname rules, so no spaces ("Pixel_Pioneers") [accept for now].
- Teams persist across seasons and standings are per canvas [yes; seasons pick the canvas].
