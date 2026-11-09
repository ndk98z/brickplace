# 0023. Player moderation in the admin area: reports, bans, resets, kicks

- Status: accepted
- Date: 2026-10-24 (proposed), 2026-10-25 (accepted; owner decisions at the end)
- Amends: 0015 (closing sockets on a ban), 0019 (team-name reports; sockets on deletion),
  0020 (team names reportable)

## Context

Reports pile up in D1 with nothing to read them (ADR 0019). Nicknames and team names are user
content that needs a moderator reset (ADR 0008). Bans exist only as rows nobody can write.
Session tokens are checked in D1 only when renewed, so a banned or deleted account kept its
open sockets for up to an hour (ADR 0015). The admin area (ADR 0022) has Access, roles, an
append-only audit log and an `ACCOUNTS` binding; admin lists, thresholds and moderation lists
stay out of this repo (ADR 0002).

## Decision

1. **Report queue** (`/api/moderation/reports`): open reports grouped by target, most reported
   first, with the names as reported, the name now, account (or team) age, prior bans, the
   count and the reasons. Reporters are never shown. _Dismiss_ closes the open reports on the
   target that the row showed (filed up to its newest, `upTo`) as `dismissed`: a report filed
   or renewed since stays open, and a reporter whose report was dismissed may report again (one
   open report per pair, not one ever); an action taken from the queue (ban, resets, close
   team) closes them as `actioned` in the same D1 batch, and only if the action took. Each row
   has a "Roll back this player" button for lane R's map rollback: it fills an input
   `#rollback-player` when the page has one (the account id is the op log's player id).
2. **Team-name reports**: reason `team_name`, a team as target (`POST /api/reports {team,
   reason}`). Gateway migration 0006 rebuilds `reports` (SQLite cannot change a CHECK) with its
   rows and indexes: exactly one target, `team_name` if and only if a team, and a partial
   UNIQUE index per kind of target. An owner cannot report their own team; members can. The
   client has "Report team name" (two clicks) on team rows and the team card.
3. **Resets** to a neutral placeholder: `player_<row number>` / `team_<id>`. The patterns
   `player_<digit>…` and `team_<digit>…` are refused as a player's choice (answered `blocked`),
   so a reset never meets a taken name; one taken before this falls back to a random suffix. A
   reset nickname reads as none (`users.nickname_reset_at`): the account watches until it
   chooses again, and that choice skips the 30-day limit (a condition of the `UPDATE`), which
   resumes from it. A reset team (`teams.name_reset_at`) keeps playing; its owner may rename it
   once (`POST /api/teams/rename`, team names are otherwise fixed); the client opens the team
   screen with a name field for it, on load or when a renewal says so (`nameReset` in
   `/api/me`), once per page. Both choices pass the KV
   word list, and neither may be the name the reset removed, which is kept beside it
   (`nickname_reset_key`, which is in the account's data download, and `name_reset_key`;
   team names are not personal data). The removed name stays refused to that account or team
   until its next reset replaces it. Another account may take it: a name that must go for
   everyone belongs in the word list. A placeholder names nobody, so neither a reset nickname
   nor a reset team name can be reported, and the client offers no report on one.
4. **Bans**: a reason is required (at most 200 characters), an optional expiry up to 5 years
   ahead, one ban in
   force at a time (a condition of the `INSERT`). `created_by` is the admin's Access id
   (`access:<sub>`), never an email. Owners and moderators ban and lift temporary bans; only
   owners lift a permanent one (a moderator's attempt is refused and audited as
   `access.refused`). `/api/me` answers a banned account's session signed out with
   `suspended: true` and clears the cookie; the page shows its suspended state. A session
   already ended by "sign out everywhere" (or a deletion) gets a plain sign-out instead, even
   when the account is banned: an ended session, perhaps a copied cookie, learns nothing more.
5. **Kicks**: `FanoutDO.kick(player)` closes the player's sockets (code 4403) and records the
   player, in FanoutDO storage, until a token's lifetime from now. Until then a socket of that
   player opened with a token expiring before that time, so issued before the kick, only
   watches: its next op is refused `signed_out` and the page renews through `/api/me`, which
   reads D1 and finds the ban, the reset or the deletion. A token issued after the kick plays.
   The token's time is the gateway's clock and the kick's the fanout's; a skew larger than the
   D1 write plus the call between them would let a renewal that read D1 before the change play
   on until its expiry. No margin is added: `/api/me` reissues a token only after ten minutes,
   so a margin would keep a freshly renewed page watching for that long.
   The admin Worker kicks after a ban and a nickname reset, the gateway after an account
   deletion and after "sign out everywhere" (once the sessions are revoked), each on the
   current season's fanout (`fanoutName`): sockets on an older canvas cannot play it. The
   admin Worker gains a `FANOUT` binding (`script_name` `brickplace-realtime[-env]`); no
   Durable Object class, no `migrations` change. No protocol change: 4403 is a close code,
   and the client reconnects after any close. A failed kick leaves the change made, says so
   (`kicked: false`, audit outcome `ok_not_kicked`) and falls back to the hour.
6. **Closing a team** (owner gone, or an offensive name), optionally resetting its name first:
   what the owner leaving does (ADR 0020). Members leave it with a free next join, the owner
   leaves it, the row loses its owner. Its cells stay and keep counting for it; it drops out
   of the ranking. Members are not kicked: their tokens carry the team for at most an hour,
   crediting a team the ranking no longer shows.
7. **No acting on yourself**: every action, dismissing included, is refused (409 `self`, an
   audit row with outcome `self`) when the target account's email, or an email one of its
   provider identities gave, is the admin's Access email, in any letter case; for a team, its
   owner's. This catches the honest case only. It does not see an account under another
   address, one with no email (Reddit gives none), or one admin acting for another; the audit
   log, read by owners, is the check on those.
8. **Audit and page**: every change goes through `acting()` (rows before and after). Audit rows
   name players by account id only, never nickname or email, since the log is append-only
   and outlives a deleted account; team names may appear (not personal data, ADR 0020).
   Every moderation reason (ban, unban, resets, dismiss, close) is refused when it holds `@`,
   seven or more digits in a row, or a name the target holds or held: the player's nickname
   or removed name; the team's name, removed name or owner's nickname. A ban reason also
   reaches the player's data download. The page asks for "what happened, never who" and
   builds every element with `textContent` under the same CSP.

## Consequences

- Owner setup: none beyond ADR 0022. The deploy workflow applies accounts migration 0006
  before the gateway ships; deploy realtime (with `kick`) before the admin Worker and the
  gateway, or their kicks fail and fall back to the hour.
- Moderators write reasons as "what happened", never "who": the checks catch slips, not
  intent (a name split by spaces, or someone else's name, passes).
- Before applying 0006 in production, record a D1 Time Travel bookmark of the accounts
  database: it rebuilds `reports`. Shipping this redeploys realtime, which drops every socket.
- The client renews its session at once when its socket closes with 4403, so a reset player
  sees the nickname prompt without first trying a move.
- Not kicked: team closure. ("Sign out everywhere" kicks too, as decided below.)
- A kick reaches one canvas. Sockets opened on the next season's canvas within the hour after a
  kick (a season starting meanwhile) are not covered; their renewal still is.
- Left for later: rollback by player (lane R), bulk ban of linked accounts.

## Decided by the owner (2026-10-25)

- **Permanent bans: moderators may issue them, only owners lift them**, as built (§4; a
  moderator's lift is refused 403 and audited as `access.refused`; tested in
  `workers/admin/test/moderation.test.ts`).
- **"Sign out everywhere" kicks open sockets**, as built (§5; the gateway kicks after revoking
  the sessions).

Still open (recommendations in brackets):
- A banned team owner keeps an open team they cannot use [moderators close it; ownership
  transfer later].
- "Owner gone": a fixed inactivity rule, or moderator judgment [judgment until data shows a
  need].
