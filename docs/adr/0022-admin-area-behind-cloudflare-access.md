# 0022. Admin area behind Cloudflare Access: config versions, audit log, emergency switches

- Status: accepted; on staging, `admin-staging.brickplace.app` since 2026-11-03 (its
  workers.dev address before that, 0029 amended); production configured for
  `admin.brickplace.app` (2026-11-11, not deployed yet); amended 2026-11-11 (24-hour session)
- Date: 2026-10-24 (proposed), 2026-10-25 (accepted)
- Amends: 0008 (admin config and audit log live in D1, the canvas keeps a delivered copy)

## Context

ADR 0007 has admins change the cooldown by hand, ADR 0011 makes drop rates admin-configurable
"without a deploy (versioned config, `effectiveAt`)", and moderation (report queue, nickname
reset, bans) needs somewhere to run. ADR 0002 keeps admin lists, thresholds and moderation
lists out of this public repo; the admin code itself can be public. ADR 0014 pins the core's
rules in each checkpoint, so a rule a replay reads can change only through a logged op.

## Decision

1. **A separate Worker, `workers/admin` (`brickplace-admin`), on its own hostname behind a
   Cloudflare Access self-hosted application**, not `/admin` routes in the gateway:
   - An Access application on a whole hostname leaves no path rule to get wrong. The public
     gateway gains no route, binding or code path to admin actions, and its deploys stay
     separate from admin ones.
   - `workers_dev` and `preview_urls` are off, so the custom domain is the only way in.
   - Access is not trusted as a header. Every request but `/healthz` must carry
     `Cf-Access-Jwt-Assertion`, an RS256 token whose signature checks against the team's keys
     (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached per isolate for 10
     minutes and refetched when stale or for an unknown `kid`, at most once per 30 s counted
     from the last attempt, failed or not; known keys survive a certs outage for 6 hours).
     Then `iss` must be the team domain, `aud` the application's AUD tag,
     `exp`/`nbf`/`iat` within 30 s, `type` exactly `app`, and an email and `sub` present.
     Service tokens are refused: admins are people. WebCrypto only, no JWT library.
   - Team domain and AUD are plain vars per environment (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
     empty in the repo). Neither is a secret: the AUD only names the application. Until both
     are set the area answers 503. The top-level `ENVIRONMENT` is `locked` (501). As with the
     fake OAuth provider, `ENVIRONMENT=dev` (from `.dev.vars` only) replaces Access with a
     fixed local owner, `dev-admin@localhost`. Tests and the invariant hook keep every
     committed environment off `dev`.
   - Identity is the Access email, lower case, with `sub` kept in the audit log. Roles come
     from D1 (`admin_roles`: `owner`, `moderator`), never from committed lists. Owners change
     config, seasons and roles. Moderators may pull the emergency switches (cooldown ×2 and
     read-only on; only an owner reopens a read-only map) and read config, seasons and the
     audit log, but not the role list. Role changes do show in the audit log
     they read, as who granted what to whom. Nobody changes their own role.
2. **Its own D1 database, `brickplace-admin-{env}`** (`workers/admin/migrations`), not the
   accounts database. D1 has no per-table grants, so a shared database would let the
   internet-facing gateway write roles and the audit log.
   - The admin Worker also binds the **accounts database** (`ACCOUNTS`) for the season
     registry, `seasons` (ADR 0021, gateway migration 0005). Admin code touches only that
     table (`workers/admin/src/seasons.ts` and `currentCanvas` in `ports.ts`). Moderation
     will use the same binding for bans, reports and nickname resets.
   - _Blast radius_: the binding reaches every table, not only `seasons`. A bug in admin
     code, or anyone able to run code in the admin Worker, could read or change accounts,
     emails, identities and bans. The guards are around the Worker: Access, the role table,
     review of admin code (which stays small), and the audit log. The schema stays the
     gateway's: the admin Worker never applies migrations to it remotely.
3. **Config versions with `effectiveAt`, outside the op log.** Two scopes:
   - `items`: hold, cooldown, starting items and drop rates, validated by the core's
     `checkItemConfig`;
   - `growth`: the open-area growth rule, validated by `checkGrowth`.

   Neither is read by a replay. Holds are their own table, and a growth is logged as an
   `open` row (ADR 0013). So no new op-log entry, golden fixture or core change is needed.
   - D1 `config_versions` keeps each version: canvas, scope, version, JSON, effective time,
     author, time and note. Triggers keep that content fixed, refuse deletes and REPLACE,
     and let delivery and cancellation be recorded once, never undone.
   - `CanvasDO.scheduleConfig` stores its own copy in SQLite (`config_schedule`) before it
     replies. It answers a retry of the same version as already stored and refuses a stale
     or conflicting number.
   - Every batch, hold view and draw uses the version in force at its own time `at`: the
     latest effective time not after `at`, then the higher version.
   - A past effective time becomes the time the canvas stores it, so no version rewrites a
     moment that already happened. A version can be cancelled only before it takes effect.
   - Holds (`advance` and `restamp` in `workers/game/src/inventory.ts`): a hold last written
     under an older items version is brought through every version since, at each one's
     effective time, when it is next looked at. First it draws what was due under the old
     version up to that time. Then:
     - A hold that was full (under the old or the new size) starts counting at the effective
       time. Raising `hold` or shortening the cooldown gives no burst for the time spent full.
     - A cooldown under way keeps the share of the old cooldown it had run, and runs the rest
       at the new length from the effective time. Halfway through 60 s, a switch to 120 s
       brings the item 60 s after the switch. Integer arithmetic.
     - Draws use the drop rates of the version they fall under.
   - Delivery: the admin Worker records the version in D1, sends it to the canvas, then
     marks it delivered in the same batch as its audit row. A failed delivery stays listed as
     "not delivered" until an owner retries (with a reason) or cancels it.
   - A stored version the canvas cannot read is logged loudly on every start, listed in
     `configState().unreadable` and on the page, and keeps its number taken. The canvas does
     not refuse to start over it: that would stop the whole game for one config row. A hold
     stamped with such a version carries on under the config in force and is stamped with
     it, instead of stopping. Only a version that takes effect later than a call (a call out
     of time order) leaves the hold as it is.
   - Shield lifetime, the shield cap and the map size are core rules pinned in the
     checkpoint. They stay out of this until a logged entry exists for them (ADR 0014).
4. **Audit log**: D1 `audit_log`, one row per change that passed sign-in and validation,
   refused ones included (outcome `not_available`, `stale`, `not_found`, ...). A change
   refused for want of a role, by an admin or by someone Access let in with no role at all,
   is recorded as `access.refused` with outcome `forbidden`; refused reads are not. A
   person with no role gets at most one such row per hour, and only for a request from our
   own page, so they cannot fill the log by scripting requests. Another site cannot write
   rows in their name either. Each row
   has who (email and `sub`), action, target, before and after (JSON), reason and time.
   Triggers refuse UPDATE, DELETE and REPLACE, which deletes without firing DELETE
   triggers. No route offers any of them. Every change needs a typed reason, retrying a
   delivery included.
5. **Emergency switches.**
   - _Cooldown ×2_ writes a new `items` version, effective now, with the cooldown in force
     doubled (capped at the u32 the wire allows). Versions already scheduled for later still
     take over at their time, so the reply and the page list them.
   - _Read-only_ calls `CanvasDO.setSchedule({readOnly})` (ADR 0021) on the current canvas.
     The canvas then refuses ops and discards with `read_only` until it is reopened. It keeps
     the first 64 characters of the reason as its note; the audit log keeps the whole reason.
   - Every action that acts on the game through these ports gets two audit rows: one before
     the call (outcome `requested`) and one after it (`ok`, or why not). Config cancels that
     reach the canvas get the same. A failure after the call therefore cannot leave the
     action unrecorded.
6. **Seasons** (`/api/seasons`: list, create, schedule, end) keep the registry and each
   canvas in agreement:
   - _The current canvas_ is the one whose start passed last, read from the registry on
     every request, as the gateway resolves it. With no season it is the Stage 0 `canvas`.
     Config versions, read-only and cooldown ×2 act on it. A registry that cannot be read
     answers 503; the canvas is never guessed for a write.
   - _Create_ follows ADR 0021: insert the row, then set the same end on its canvas with
     `setSchedule({endsAt})`. If that fails, the create cleans up: an unreachable canvas may
     have taken the end, so its end is cleared while the row still holds the name (another
     create of that canvas cannot slip in and lose its end to the clearing; a lost call is
     assumed to reach the canvas before the next one, as schedule's undo assumes); then the
     row is deleted if it still has the times this create wrote; if the deletion fails, the
     end is set again so a row left in place keeps its end. The reply is then read, not
     inferred: both sides are read back. No row and no end is `undone`; a row and the same
     end on its canvas, still open, is the season as it stands (`ok`, the audit row noting
     how); anything else is `inconsistent`, naming the values read and a repair the admin can
     run, chosen from the row when the canvas cannot be read (no route reads a canvas's end):
     create the season again (no row), schedule it with an end different from the row's (a
     row), list the seasons first (the row cannot be read), or use another name (a canvas no
     longer open: closing, ended or sealed, whatever end it shows), and remove a row left in
     place by hand (no route deletes one). The two reads are not atomic: the answer is what
     each side held when it was read.
   - _Stage 0_: after every create or schedule, the Stage 0 canvas's end is set to the
     earliest registered start (ADR 0021: it ends when the first season starts). Moving the
     first season's start, or adding an earlier season, moves it too, so Stage 0 never
     closes before players have a season to go to. If Stage 0 cannot take the end, the reply
     says `inconsistent`. Scheduling the season again repairs it, but only until that start
     passes: after that, an end at the start would lie before ops Stage 0 has logged since.
     Within that window (at least 5 minutes, see below) an owner schedules again. After it,
     "End the Stage 0 canvas now" (`POST /api/stage0/end`, owner, audited like the rest)
     ends Stage 0 the way "End now" ends a season.
   - Seasons never overlap (back to back is fine). The check is repeated inside the insert or
     update itself, so two admins cannot write overlapping seasons at once. A start, new or
     moved, lies at least 5 minutes ahead (`MIN_START_LEAD_MS`). So while no season has
     started, Stage 0 is still open and always takes the new end: its last op, and a clock
     slightly ahead of the admin Worker's, both lie before it.
   - _Schedule_ (a new end, or a new start while the season has not started): the canvas
     first, since it enforces the end, then the row. If the row cannot be written, or the
     canvas cannot be reached (the new end may have landed), the canvas gets its old end back
     (`undone`; `inconsistent` with both values when that fails too). A row deleted meanwhile
     is not put back: `not_found` if the end did not move, else `inconsistent` (the canvas
     may hold the new end; creating the season again repairs it).
   - _End_ sets the canvas's end to `END_LEAD_MS` (10 s) after the moment of the call, with
     the time read right before it. An active canvas logs ops with times later than the
     admin's request, and it refuses an end at or before its last op. If it still refuses
     (`invalid`), the call is tried once more with a fresh time. Then the canvas's end is
     copied into the row. An end already due within the lead stands, and is copied as it is.
     If the row cannot be written the canvas is not put back, because it may already be
     closing. The reply says `inconsistent`, and ending again copies the canvas's end into the
     row and repairs it. An end sent to a canvas that cannot be reached may have landed or
     not, so it is answered `inconsistent` too (ending the Stage 0 canvas alike), and ending
     again repairs it. A canvas whose status cannot be read before the end is sent answers
     `unreachable`: nothing changed.
   - When an undo fails too, the reply says `inconsistent` with both values, and the audit
     log keeps it.
   - The canvas name is the season's name: 1–32 lower-case letters, digits or `-`, never
     `canvas`.
   - _Config versions belong to a canvas_, and the settings in force carry over (owner
     decision, 2026-10-25). When a season is created, the item config and the
     growth rule in force on the canvas players are on (read before the create) are compared
     with the new canvas's own; each scope that differs becomes one version on the new canvas,
     effective at once (so in force from its first op), recorded, delivered and audited as
     `config.carry` like any other (`workers/admin/src/config.ts`, `carryConfig`). Versions the
     old canvas has scheduled for later stay there: they belong to its season. Holds start
     fresh, stamped with the version in force on the new canvas. A carry that fails (a canvas
     that cannot be read, a delivery refused) leaves the season standing; the reply and the
     page list each scope's outcome. The copy is a snapshot: a change to the current canvas
     after the create does not reach the new one. So the config routes (read, new version,
     cancel, retry; same roles and audit rows) also take a `canvas`: the current one, or a
     registered season that has not started yet; any other name is refused before a canvas is
     reached. The page shows the next season's settings beside the ones in force, says when
     they differ, and its form can target that season until it starts (a failed carry is
     repaired there). Emergency cooldown ×2 stays on the current canvas.
   - _Archive_ (`workers/admin/src/archive.ts`; ADR 0021, 0024): a registered season's (or
     Stage 0's) archive-only removals, read with its phase, and the "seal now" request. A name
     no season has is answered 404 before any canvas is reached, so no empty canvas is made
     under it. A removal names an area (anchor cells), a seq window (by default the whole
     season once it has closed, and never past its last seq then; while it is open, up to the
     latest seq unless a later `to` is given) and optionally a player by nickname; it is added or
     dropped against the list read, through `CanvasDO.setRemovals(list, expected)`, which
     refuses with `stale` when another admin changed it in between. Moderators add and drop
     removals limited to a player; one of every player's ops in an area needs an owner (as a
     rollback, ADR 0024 §8; refusals audited). "Seal now" (`CanvasDO.requestSeal`) is the
     owner's alone and only once the season has ended: it closes the window for removals and
     drops the season's player ids. Both are audited before and after the call; reasons name
     no one (ADR 0023's `personalData`). Removals are by seq, not time: after the end the log
     lives in R2 segments that do not index time.
7. **Page**: plain HTML, one script and one stylesheet served by the Worker. CSP is
   `script-src 'self'`, with no framing. Every element is built with `textContent`. Changes
   are JSON POSTs with a custom header from our own origin, so another site cannot forge one.

## Consequences

- Owner setup, per environment (staging, production):
  1. `wrangler d1 create brickplace-admin-<env>` and put the id in
     `workers/admin/wrangler.jsonc`. The deploy workflow applies its migrations before any
     script ships, so the staging and production tokens' D1 Edit covers it. The admin
     migrations and deploy run only when that GitHub environment's own variable
     `ADMIN_ENABLED` is `true`. Set it on the environment (not the repository, which every
     environment would see) once steps 1–3 are done there. Until then an unconfigured
     admin area never blocks that environment's game and gateway deploys: staging can have
     it before production does.
  2. A DNS name for the admin area (e.g. `admin.<domain>`), added as a custom domain of
     `brickplace-admin-<env>` (`routes` with `custom_domain: true` in the env block).
  3. Zero Trust → Access → Applications → self-hosted application on that hostname, with an
     Allow policy for the admins' identities, kept in the dashboard or the private ops repo.
     The policy requires the identity provider's **MFA** (an Access authentication-method
     rule, e.g. `mfa`, or an identity provider that enforces it), and the application's
     **session duration is 24 hours** (owner decision, 2026-11-11; 8 hours before, below).
     Copy its AUD tag into `ACCESS_AUD` and
     the team domain into `ACCESS_TEAM_DOMAIN`.
  4. The first owner, from a terminal:
     `wrangler d1 execute brickplace-admin-<env> --remote --command "INSERT INTO admin_roles
     (email, role, granted_by, granted_at) VALUES ('<email>', 'owner', 'bootstrap', 0)"`.
     Everyone else is added from the page.
  5. Bind the accounts database too: put the ids of `brickplace-accounts-<env>` (the
     gateway's) in the admin Worker's `ACCOUNTS` entries.
- `pnpm dev:admin` runs the admin Worker on :8788 beside `pnpm dev`. It reaches its CanvasDO
  through the local dev registry and shares the gateway's local state, so it sees the same
  season registry.
- Clients learn a new cooldown from their next hold frame, not at the switch.
- Checking an old draw now also needs the item config in force at that time. Both the canvas
  and D1 keep every version.
- Access decides who reaches the hostname, D1 what they may do there. Removing someone takes
  both: the Access policy for sessions, the role row for the API.

## Decided by the owner (2026-10-25)

- **Moderators may pull the emergency switches** (cooldown ×2 and read-only on), as
  recommended; **only owners reopen a read-only map** (`POST /api/emergency/read-only` with
  `readOnly: false` from a moderator is refused 403 and audited as `access.refused`; the page
  hides Reopen from moderators). A cooldown ×2 is undone by a new items version, which only
  owners make. These switches are why the next point holds for every admin.
- **The admin area requires the identity provider's MFA and an 8-hour Access session** for
  every admin, owners and moderators alike (the session is 24 hours since 2026-11-11, amended
  below). This is Access configuration, owner-set (step 3 of
  the owner setup above), not code.
- **A new season's canvas starts with the item config and growth rule in force** on the
  canvas players are on, copied when the season is created (built, §6, `config.carry`).

Still open (with a recommendation):
- Should a scheduled version be refused when another one is pending for the same scope?
  _Recommended: no; list pending versions (done) and let the owner cancel._
- Shield lifetime and the shield cap as admin settings (ADR 0007 calls the lifetime
  admin-configurable): each needs a logged entry, so a core change, golden fixtures and an ADR.
  _Recommended: only when real season data asks for it._

## Amended 2026-11-11: 24-hour Access sessions

The owner keeps both admin applications, `brickplace-admin-staging` and
`brickplace-admin-production`, at a **24-hour session** instead of 8 hours. Each environment
has its own Access application, so its own AUD tag in `ACCESS_AUD`: a token for one is refused
by the other's Worker. Both use the same reusable "admins" policy, so an admin is added or
removed in one place; roles stay per environment in each admin database.

What it trades: a lost or shared device holds an admin session for up to a day instead of
up to 8 hours. Removing someone still takes both: the role row, which shuts the API at once,
and the policy, which stops new sessions; to end an open one early, revoke it in Zero Trust.

The identity provider's MFA, decided above, is not in place yet: the account's only login
method is Cloudflare's one-time PIN by email. It stays the target, with an identity provider
that enforces MFA added before the production admin area opens.
