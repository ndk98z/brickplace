# 0019. Nickname reports, data download, account deletion and rate limits

- Status: accepted
- Date: 2026-10-24 (proposed), 2026-10-25 (accepted)

## Context

ADR 0008 stores email and lets players choose nicknames, which brings duties: nicknames must
be reportable, and a player must be able to download and delete their data. `/auth` and
`/api` had no rate limits (ADR 0015). Limits and caps are abuse thresholds, which must not be
in this public repo (ADR 0002), and the D1 migrations were applied by hand.

## Decision

- **Reports** (`POST /api/reports {nickname, reason}`, D1 table `reports`, migration 0003):
  only an account with a nickname can report. There are four fixed reasons: `offensive`,
  `hateful`, `impersonation` and `personal_info`. The table keeps the nickname as it was
  reported, and a report is `open`, `actioned` or `dismissed`. A partial `UNIQUE` index allows
  **one open report per reporter and target**. A **rolling 24-hour cap** per reporter is a
  condition of the `INSERT` itself, so parallel requests cannot all get past it. The number
  is read from KV `MODERATION`, key `report-daily-limit` (a whole number, `0` closes
  reporting, cached per isolate for 5 minutes). If the value is **missing, unreadable or
  malformed, reports are refused outside dev (503 `unavailable`, fail closed)**, as with the
  nickname word list: an unconfigured cap is a setup error that shows at once, and refusing
  reports for a while costs less than taking unbounded writes. Dev without the key has no
  cap.
- **No Turnstile on reports.** The reporter's account already passed Turnstile at sign-up.
  The cap and the one-open-per-pair rule bound what one account can file. Reports only feed a
  queue that moderators read, and nothing acts on them automatically. A widget per report
  would also load Turnstile on the game page for little gain. "Turnstile on suspicious
  activity" stays in the abuse work.
- **Report entry point**: no screen shows other players' nicknames yet. The profile has a
  Report button that opens a dialog where you type a nickname. `Account.openReport(nickname)`
  pre-fills that dialog for the team and ranking screens to come.
- **Data download** (`POST /api/account/export`, with CSRF, so no other site can trigger
  it): a JSON file with:
  - the user row;
  - identities (provider, subject, email, name, times). No provider tokens are ever stored;
  - bans (reason and times, not which moderator);
  - reports the player filed (the nickname as reported, not the other account's id);
  - a note on nickname history (only the current one is kept).
- **Not in the download**: reports about the player, which protects reporters. **Op-log
  contributions get a note, not a count**: the log is stored per map (CanvasDO SQLite, then
  R2 segments), not per player, the gateway has no binding to CanvasDO, and counting would
  mean scanning a season's log. A per-player count can come with the team-stats counters
  (ADR 0008: D1, flushed from DOs).
- **Account deletion** (`POST /api/account/delete {confirm}`) needs a **sign-in from the last
  10 minutes** (the linking window of ADR 0015) and the **nickname typed again** in any letter
  case, or `delete` for an account that never chose one. One D1 batch (a transaction):
  - copies the account's bans to `bans_of_deleted_accounts` (reason, issuer, times) with no
    link to anyone;
  - deletes its bans, the reports it filed and received, its identities and the user row
    (which frees the nickname at once);
  - adds the id to `deleted_accounts`. A trigger refuses any later `INSERT` of that id into
    `users`, so a deleted account's player id never comes back, even though random UUIDs
    would not collide anyway;
  - stores each of its provider identities as a keyed hash (HMAC with the session signing
    key, all keys tried on lookup) in `deleted_identities`, and prunes rows older than an
    hour.
- **After a deletion**, sessions end because the row is gone: renewals fail, and open
  sockets stop playing when their token expires, within the hour (ADR 0015; since ADR 0023
  they are closed at once). **For that
  same hour no new account can be made from those provider identities**
  (`auth_error=recently_deleted`). Otherwise delete-and-sign-up-again would run several
  players from one provider account, each new one with a starting item (ADR 0012), and
  dodge the 30-day rename limit. After the hour, a new account with a new id. The hold-off
  is the token lifetime, not an abuse threshold, so it stays in code. Farming starting
  items this way then yields one item an hour, far less than the cooldown.
- **Rate limits on `/auth` and `/api`: Cloudflare WAF rate-limiting rules, set by the owner on
  the zone, with no code and no numbers in the repo.** Compared (Cloudflare docs, October
  2026):
  - _WAF rate-limiting rules_ run before the Worker, so blocked requests cost no
    invocation. They are configured in the dashboard or API. On the Free plan you get 1
    rule, matching on path, counting per IP, with a 10 s period, a 10 s block and the Block
    action. Pro gives 2 rules, longer periods and challenges. Counting is per data center
    and approximate. They apply only to the zone's hostnames.
  - _Workers Rate Limiting binding_: the limit and period (10 or 60 s) sit in
    `wrangler.jsonc` under `ratelimits[].simple`, which is committed. It could key by
    account, which is better than by IP, but it puts the number in the public repo, so it
    is not used. Hiding the number (a fixed "unit" scaled in code) would only obscure it.
  - _A limiter configured in KV_: the threshold can live in KV, but the counter cannot.
    - KV takes about one write per second per key and is eventually consistent.
    - D1 would cost a write per request.
    - Isolate memory is split across many isolates per location.
    - A Durable Object would add a hop per request, and the gateway holds no DOs.
  - _Where a KV-configured cap is used_: only where what it counts is already a D1 row
    (reports per day). Per-account limits on game ops belong in CanvasDO with the abuse
    work.
  - Because WAF rules see only the zone's hostnames, **the gateway now answers `/api` and
    `/auth` only on `PUBLIC_ORIGIN`'s host outside dev (421 `host` elsewhere)**. Otherwise
    `*.workers.dev` or a preview URL would skip the limits. Sign-in could not work there
    anyway (redirect URIs and cookies are tied to the origin). Without a `PUBLIC_ORIGIN`
    there is no host to compare: sign-in is closed then, and `/api/me` still answers so the
    page can say so.
- **D1 migrations in the deploy workflow**: `wrangler d1 migrations apply ACCOUNTS --remote
  --env <env>` runs through `wrangler-action` first, before any script deploys. It applies
  each file in `workers/gateway/migrations` not yet in the database's `d1_migrations` table.
  Migrations only add (never edit or drop), so the running gateway keeps working. A failure
  stops the run with nothing deployed, so a re-run does not redeploy realtime (dropping every
  socket again) for want of a `deployed/<env>/*` tag. Previews never run migrations: that
  would be unreviewed code against staging's database.

## Consequences

- Owner setup, per environment (staging, production):
  1. The deploy token (`CLOUDFLARE_API_TOKEN`) of staging and production also needs **D1
     Edit** on the account. The preview environment's token must not get it.
  2. Write the report cap from the private ops repo:
     `wrangler kv key put report-daily-limit <N> --binding MODERATION --env <env> --remote`.
     Without it, reports are refused (503) outside dev.
  3. In the dashboard: zone → Security → Security rules → Create rule → Rate limiting rule.
     - Name: `auth and api`.
     - When: URI Path starts with `/auth/` OR URI Path starts with `/api/` (the expression
       `starts_with(http.request.uri.path, "/auth/") or starts_with(http.request.uri.path,
       "/api/")`).
     - Characteristics: IP. Period: 10 s on Free. Requests: your number, recorded only in
       the private ops repo. Action: Block, for 10 s on Free.
       On Pro or above, split it into a stricter `/auth/` rule and an `/api/` rule, use longer
       periods and Managed Challenge.
  4. Leave room for normal play: every page load calls `/api/me`, and an open page calls it
     again every 20 minutes. A blocked `/api/me` makes the page start as a watcher (the
     client treats an unreadable answer as signed out). Players behind one NAT share an IP.
- `/ws` is not covered: one socket per account and per-account op limits are abuse work.
- A banned account cannot delete itself, since it cannot sign in while the ban applies.
  Erasure requests then go through the contact address, and the operator decides (legal
  claims may justify keeping the record).
- A deleted nickname is free at once; someone may take it to look like the old player.
  This is accepted, and a moderator reset handles abuse.
- Ban reasons outlive the account in `bans_of_deleted_accounts`, so moderators must not
  write a player's name, nickname or other personal data into a ban reason.
- Deletion also removes the reports the account filed and received, closed ones included:
  that moderation history goes with the account.
- `deleted_identities` keeps a keyed hash per identity, which is useless without the
  session key. Rows past the hour are pruned at the next deletion.
- After deletion, the op log still holds the old id until 90 days after the season
  (ADR 0008), but nothing maps it to a person. Its hold and dedupe rows in CanvasDO stay until
  the season clears holds (ADR 0012).
- The moderation queue, closing reports and the moderator nickname reset need the admin
  area behind Cloudflare Access (built since, ADR 0023).

## Decided by the owner (2026-10-25)

- **A missing cap fails closed**, as built: without a readable `report-daily-limit` reports
  are refused (503), and without `team-daily-cells` no placement counts toward a team (ADR
  0020). An unconfigured cap shows at once as a setup error.
- **A deleted account's nickname is free at once**, as built. Someone taking it to pass for
  the old player is handled by a report and a moderator reset (ADR 0023).

Still open (built as described above; the owner has not ruled on them):
- No Turnstile on reports.
- Rate limits on `/auth` and `/api` as owner-set WAF rules, with no code and no numbers in the
  repo.
- A banned account cannot delete itself; erasure then goes through the contact address.
