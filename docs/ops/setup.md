# Setting up an environment

How the owner brings up `staging` or `production` from an empty Cloudflare account, in the
order it was done for staging (2026-10-25). Decisions behind each step are in the ADRs linked
inline; open items for the project as a whole are in `PROGRESS.md`.

What never goes in this repo (it is public, AGPL-3.0, ADR 0046): secret values, the account id,
admins' email addresses, abuse thresholds and moderation lists. Those live in Workers
Secrets, KV, GitHub settings and the private ops folder (`ops-private/`, gitignored, until a
private ops repo exists). Ids of databases and namespaces, bucket names, OAuth client ids,
Turnstile site keys and the Access team domain and AUD tag are public and go in each
`wrangler.jsonc`.

Every `wrangler` command below runs from the repository root with
`export CLOUDFLARE_ACCOUNT_ID=<account id>` in the shell (the value is in
`ops-private/<env>.conf`), so it can never reach another account the CLI is logged in to.

## Where each environment stands

| Step                                 | Staging                                      | Production                                                                         |
| ------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1. Account and workers.dev subdomain | done (`brickplace.workers.dev`)              | same account                                                                       |
| 2. R2, D1, KV and the archive lock   | done                                         | done (2026-11-11, APAC like staging; ids in)                                       |
| 3. KV values                         | done (all five keys, 2026-10-26)             | not yet                                                                            |
| 4. GitHub secrets, variable, env.    | done on the new public repo (2026-11-09)     | not yet: token in `production`; `PRODUCTION_ENABLED` last                          |
| 5. Required secrets, first deploy    | done                                         | secrets set (2026-11-11); first deploy not yet                                     |
| 6. Sign-in: origin, Turnstile, OAuth | Discord and Google done; Reddit not set up   | Discord and Google in config; Google consent in Testing                            |
| 7. Admin area                        | done (`admin-staging.brickplace.app`)        | Access app and config (`admin.brickplace.app`); `ADMIN_ENABLED`, owner row not yet |
| 8. Alerts                            | skipped: production only (owner, 2026-10-26) | not yet; needed before public traffic                                              |
| Tiles custom domain                  | done (`tiles-staging.brickplace.app`)        | done (`tiles.brickplace.app`, 2026-11-11; CORS `brickplace.app` only)              |
| Pages on the zone                    | done (`staging.brickplace.app`, 2026-11-03)  | in config; apex and `www` records deleted, Redirect Rule off (2026-11-11)          |
| WAF rate limit on `/auth/`, `/api/`  | done (2026-11-03; number in `ops-private/`)  | covered by the same zone-wide rule                                                 |

Production: before it opens to the public, raise `abuse-policy`'s
`opens.address` well above staging's (mobile carriers share one IPv4 among many players
behind CGNAT; the per-account limits are the main bound).

## 1. Account and workers.dev subdomain

1. Log the CLI in to the right account: `npx wrangler logout`, `npx wrangler login`, then
   `npx wrangler whoami` shows it.
2. Workers & Pages → choose the account's workers.dev subdomain (here `brickplace`, so
   staging is `brickplace-gateway-staging.brickplace.workers.dev`). Workers Paid is
   recommended for Durable Object and D1 quotas.

## 2. Storage

```bash
npx wrangler r2 bucket create brickplace-oplog-<env>     # private: never a public domain
npx wrangler r2 bucket create brickplace-tiles-<env>     # public behind the CDN (ADR 0009)
npx wrangler r2 bucket create brickplace-sponsors-<env>  # private: logos, served by the gateway (ADR 0038)
npx wrangler r2 bucket lock add brickplace-oplog-<env> archive-forever archive/ --retention-indefinite
npx wrangler d1 create brickplace-accounts-<env>
npx wrangler d1 create brickplace-standings-<env>
npx wrangler kv namespace create brickplace-moderation-<env>
```

- The bucket lock covers `archive/` only (ADR 0021): never `c/`, never the tiles bucket.
- Put each printed id in the env block of every `wrangler.jsonc` that binds it: accounts
  (gateway, admin `ACCOUNTS`), standings (game, gateway), the KV namespace (gateway, game,
  realtime). Bucket names already follow `brickplace-*-<env>`.
- The deploy workflow applies D1 migrations itself; never apply them by hand.
- Later, with a zone: a custom domain on the tiles bucket with caching, CORS for the game's
  origin and tiered cache, then its https origin in the gateway's `TILES_ORIGIN` (empty keeps
  watchers on sockets).
- Staging reads `https://tiles-staging.brickplace.app`, a custom domain on the
  `brickplace.app` zone (ADR 0044; since 2026-11-03, after a day on the bucket's r2.dev URL,
  rate-limited and uncached, and a few on the stand-in `bp-cdn-staging.dropto.site`, removed
  with its Cache Rule the same evening).
  Production reads `https://tiles.brickplace.app` (custom domain since 2026-11-11, CORS
  `https://brickplace.app` only). Tiles and segments are edge-cached; Cloudflare
  does not cache `.json`, so the zone has a Cache Rule for the manifest: Caching → Cache
  Rules, expression `(http.host in {"tiles.brickplace.app" "tiles-staging.brickplace.app"} and
  ends_with(http.request.uri.path, "/manifest.json"))`, eligible for cache, edge TTL "use
  cache-control header if present, bypass cache if not", browser TTL "respect origin". The
  edge then keeps it for its `max-age=1`, one copy per `Origin` (CORS stays right). 30 reads
  2 s apart: p50 0.53 s, max 0.79 s (0.86 s and 1.8 s before the rule). A Cache Rule only
  matches hostnames of its own zone. To set up such a domain again, in this order, as ADR 0018
  asks: in the dashboard, R2 → `brickplace-tiles-<env>` → Settings → Custom Domains → Add (a
  zone in the same account; a few minutes to activate, error 1014 until then), and CORS
  policy (staging's, the page origin only since 2026-11-03) →
  `[{"AllowedOrigins": ["https://staging.brickplace.app"], "AllowedMethods": ["GET",
  "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600}]`, no trailing slash, never `*`;
  while pages move between origins, list both until the old one has no open pages. **After any change to the
  CORS policy, purge the zone's cache** (Caching → Configuration → Purge Cache): the edge keeps
  a copy per `Origin`, R2 answers its revalidations of an unchanged manifest with a 304, and
  the copy keeps the old headers (on 2026-11-03 a copy cached a minute before the change had
  no `Access-Control-Allow-Origin` for the new origin until the purge). Check that the
  manifest answers 200 with `Access-Control-Allow-Origin` for each allowed origin and none for
  another one (R2 sends it only to a request with an `Origin` header): `curl -sI -H 'Origin:
  https://staging.brickplace.app' '{origin}/c/canvas/manifest.json'`; only then set the
  gateway's `TILES_ORIGIN`. Before an environment's first deploy there is no manifest yet:
  R2 sends the same header on its 404, so the check still holds (production's, 2026-11-11). A
  page given an origin it cannot read gives up only after three failed manifest reads: watchers
  see no map for about 12 s, and a player's socket opens 3 s late.
- A bucket that stopped moving passes every check above. After a deploy, and before a measured
  run, play a move and look at the manifest's `Last-Modified` (the same curl): it changes within
  a few seconds of the move. One stuck for minutes means the canvas's alarm stopped (staging's
  stood still from 27 to 28 October 2026, ADR 0044); CanvasDO invocations of type `alarm` in the
  analytics say whether it runs. To move or undo: set `TILES_ORIGIN` to the new origin (or
  empty it) and deploy the gateway, wait for open pages to reload, then turn the old address
  off (r2.dev access: R2 → the bucket → Settings → Public access → r2.dev subdomain → Disallow).
  Nothing reloads an open page, and one that already read the old address freezes when it goes
  off: wait until the bucket's metrics show no more reads there, or a day.
- **Staging's tiles on brickplace.app** (done 2026-11-03, ADR 0044). The same evening, after
  the deploy, `bp-cdn-staging.dropto.site` came off the bucket and its Cache Rule off
  `dropto.site` (pages still open from before the deploy could no longer play anyway). Names
  stay one level under the zone (the free certificate covers `*.brickplace.app`, not
  `*.staging.brickplace.app`): pages `staging.brickplace.app` and `brickplace.app`, tiles
  `tiles-staging.brickplace.app` and `tiles.brickplace.app`.
- **Staging's pages on `staging.brickplace.app`** (2026-11-03). Done first, in the dashboard:
  the deploy token got Zone / Workers Routes / Edit on `brickplace.app` (step 4), each OAuth
  application the redirect `https://staging.brickplace.app/auth/{discord,google}/callback`,
  the Turnstile widget the hostname. Then the staging gateway took the custom domain
  (`routes` with `custom_domain: true`) and `PUBLIC_ORIGIN`. `/api`, `/auth` and a browser's
  `/ws` answer only on `PUBLIC_ORIGIN`'s host (421, 403), and sessions are cookies of a host:
  a page on the old workers.dev address stops working and players sign in again once. For a
  few hours the gateway redirected pages there to `PUBLIC_ORIGIN`; the same evening the
  owner turned the address off (`workers_dev: false`, ADR 0045 amended), so every request
  passes the zone's WAF rules and the redirect is gone. Bots and k6 use
  `wss://staging.brickplace.app/ws`. The workers.dev origin left the tiles bucket's CORS
  policy the same evening, followed by a purge. Production writes `workers_dev: false` too
  when it gets its domain.

## 3. KV values (moderation and abuse thresholds)

Written from `ops-private/` with `./ops-private/push-kv.sh <env>`, never from the repo:

| Key                  | What                                                           | Without it                                                     |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `nickname-words`     | nickname and team-name word list                               | nicknames and team names are refused                           |
| `report-daily-limit` | reports per reporter per rolling 24 h (ADR 0019)               | reports are refused                                            |
| `team-daily-cells`   | cells per account per UTC day that count for a team (ADR 0020) | no cell counts toward a team                                   |
| `abuse-policy`       | socket and op limits, trust tiers (ADR 0026)                   | every abuse limit is off, realtime logs `abuse_policy_missing` |
| `trust-weights`      | trust score weights (ADR 0026)                                 | tokens carry no score                                          |

## 4. GitHub

1. Repository **secret** `CLOUDFLARE_ACCOUNT_ID` (Settings → Secrets and variables →
   Actions → Secrets), so it is masked in the public run logs (ADR 0046). Then, once the
   rest of this step is done, the repository **variable** `DEPLOY_ENABLED` = `true`
   (Actions → Variables): deploy jobs are skipped until it is set, because a job-level
   condition can read variables but not secrets.
2. Cloudflare → My Profile → API Tokens → Create Token → Custom token: Account / Workers
   Scripts / Edit and Account / D1 / Edit, account resources limited to this account, and
   Zone / Workers Routes / Edit on `brickplace.app` only (a deploy that adds or changes a
   custom domain needs it, 2026-11-03).
3. **Secret** `CLOUDFLARE_API_TOKEN`, on the repository (Settings → Secrets and variables →
   Actions) or on an environment (Settings → Environments → `<env>`), where it overrides the
   repository's. Trade-off: a repository secret is readable by a workflow run on any pushed
   branch, so an edited workflow on a feature branch could use it; an environment secret
   only by jobs that pass that environment's branch policy. There are no PR previews: test a
   change on staging after it merges.
4. Branches: `develop` is the default branch and every push to it deploys staging; `main`
   takes releases. Each has a ruleset (PR, the CI checks, no force-push or deletion);
   `main` accepts merge commits only, so `develop` → `main` PRs never rewrite history.
   Environments: `staging` deploys from `develop` only; `production` from `main` only. Add
   the owner as `production`'s required reviewer once the repository is public (GitHub Free
   offers environment reviewers on public repositories only).
5. Production stays off until the repository **variable** `PRODUCTION_ENABLED` is `true`:
   until then merging the release-please PR only tags a release.
6. Who runs the game (ADR 0037): repository **variables** (Settings → Secrets and variables →
   Actions → Variables), shared by staging and production. An environment needing another
   value sets a variable of the same name on itself (Settings → Environments → `<env>`), which
   overrides the repository's. The client build reads them; the code and pages carry none.
   The deploy fails until the first three exist. They are public values (the site shows
   them), so the repository level, readable by a workflow on any branch, is fine.

   | Variable                | Example                       | Where it shows                     |
   | ----------------------- | ----------------------------- | ---------------------------------- |
   | `VITE_OPERATOR_NAME`    | `Example Co`                  | terms, privacy, trademarks         |
   | `VITE_OPERATOR_ADDRESS` | `1 Main St, City, Country`    | terms, privacy                     |
   | `VITE_CONTACT_EMAIL`    | `contact@example.org`         | legal pages; "Become a sponsor"    |
   | `VITE_KOFI_URL`         | `https://ko-fi.com/<page>`    | Donate buttons (off when unset)    |
   | `VITE_SPONSOR_INFO_URL` | `https://example.org/sponsor` | "Become a sponsor", over the email |
   | `VITE_SPONSORS`         | `[{"name":"…","href":"…"}]`   | sponsor logos (`src/env.d.ts`)     |
   | `VITE_SOURCE_URL`       | defaults to this repository   | "Source code" links (AGPL §13)     |

   Sponsors and the two links are normally set in the admin area, under Sponsors & links
   (ADR 0038). `VITE_SPONSORS`, `VITE_KOFI_URL` and `VITE_SPONSOR_INFO_URL` are then only
   fallbacks, used while `/api/sponsors` cannot be reached or lists no sponsor, and for a
   link the admin area leaves empty.

## 5. Required secrets, then the first deploy

Every name in an env block's `secrets.required` (game and gateway `wrangler.jsonc`) must be
set before that Worker's first deploy: `wrangler deploy` refuses to ship while one is
missing, and refuses outright for a Worker that does not exist yet. On a missing Worker,
`secret put` offers to create it: accept.
1. Turnstile widget (Cloudflare → Turnstile → add a widget) for the gateway's hostname,
   its custom domain (staging: `staging.brickplace.app`, production: `brickplace.app`) or,
   without one, `brickplace-gateway-<env>.<subdomain>.workers.dev`: it is known before
   anything is deployed. Keep the site key for step 6.
2. The secrets:

   ```bash
   openssl rand -base64 32 | npx wrangler secret put ITEM_DRAW_KEY -c workers/game/wrangler.jsonc --env <env>
   echo "k1:$(openssl rand -hex 32)" | npx wrangler secret put SESSION_KEYS -c workers/gateway/wrangler.jsonc --env <env>
   npx wrangler secret put TURNSTILE_SECRET_KEY -c workers/gateway/wrangler.jsonc --env <env>   # paste the widget's secret key
   ```

   Plus each `*_CLIENT_SECRET` the gateway's env block lists (step 6). `SESSION_KEYS` holds
   `kid:secret` entries; the first signs and all verify. To rotate, put `k2:<new> k1:<old>`,
   then drop `k1` after 30 days.
3. Push to `develop` (staging) or run the Deploy workflow from `main` (production, once
   `PRODUCTION_ENABLED` is `true`). It applies the accounts
   and standings migrations, then deploys game, realtime, gateway (and admin, step 7) and tags
   each `deployed/<env>/<script>`. Production, first: delete the zone's "Apex to staging"
   Redirect Rule (or narrow it to `www` → `https://brickplace.app`) and the apex's placeholder
   `AAAA 100::` record. Redirect Rules run before Workers, so a rule left on the apex keeps
   sending every request to staging; the deploy would not catch it, since wrangler in CI
   replaces a DNS record already on the custom domain's name. Done 2026-11-11: both records
   deleted and the rule disabled (not deleted). Never re-enable it while it matches the apex;
   to send `www` to the apex later, change both its host list and its target first.
4. Check: `<PUBLIC_ORIGIN>/healthz` (before there is one, the workers.dev address) answers
   `ok` and the page loads in watch-only mode. The first page opened creates the canvas, so ship map
   changes before anyone opens it.

## 6. Sign-in (ADR 0015)

Values in the gateway's env block of `wrangler.jsonc`, secrets with `secret put` on
`-c workers/gateway/wrangler.jsonc --env <env>`.
1. **`PUBLIC_ORIGIN`**: the gateway's https origin, no path (staging:
   `https://staging.brickplace.app` since 2026-11-03, before that its workers.dev address).
   Sign-in stays closed outside dev without it, and every OAuth redirect URI below is built
   from it.
2. **Turnstile**: the widget's site key (step 5) into `TURNSTILE_SITE_KEY`.
3. **OAuth providers**, each optional, on when both its id and secret are set:
   - Discord: Developer Portal → New Application → OAuth2: Application ID into
     `DISCORD_CLIENT_ID`, Reset Secret → `DISCORD_CLIENT_SECRET`, redirect
     `<PUBLIC_ORIGIN>/auth/discord/callback`.
   - Google and Reddit the same way, with `GOOGLE_*` / `REDDIT_*` and
     `/auth/google/callback` / `/auth/reddit/callback`.
   - Each environment has its own credentials, so a leaked staging secret never signs in to
     production. Google: one Cloud project (one consent screen) with a Web application client
     per environment; the project stays in Testing (listed test users only) until production
     publishes it, which opens staging too. Discord and Reddit hold one id and one secret per
     application (Reddit also one redirect URI), so each environment gets its own application;
     production's carries the public name and icon players see when they consent.
   - Put the secret first, then add the provider's `*_CLIENT_SECRET` to that env block's
     `secrets.required` in the same commit as its client id (the gateway tests check the two
     agree).
4. Push, then check: sign in from the page, place one brick.

## 7. Admin area (ADR 0022, 0029)

1. `npx wrangler d1 create brickplace-admin-<env>`; id into `ADMIN_DB` in
   `workers/admin/wrangler.jsonc`.
2. GitHub → Environments → `<env>` → **variable** `ADMIN_ENABLED` = `true` (on the
   environment, not the repository), then push. The deploy applies the admin migrations and
   deploys `brickplace-admin-<env>`, which answers 503 `access_not_configured` for now.
3. Access: a self-hosted Access application (Zero Trust → Access → Applications) on the admin
   hostname, one level under the zone (staging: `admin-staging.brickplace.app` since
   2026-11-03, ADR 0029 amended; production: `admin.brickplace.app`), created before the
   PR that gives the admin Worker that custom domain (`routes` with `custom_domain: true`,
   `workers_dev: false`): a policy allowing the admins' identities only, the identity
   provider's MFA, session 24 hours (ADR 0022, amended 2026-11-11). The admins policy is a
   reusable one shared by both environments' applications. (Staging first ran on its workers.dev address with
   one-click Access; that application goes once the domain answers.)
4. Team domain (`https://<team>.cloudflareaccess.com`) and the application's AUD tag
   (Additional settings → AUD tag, 64 hex characters: paste it, do not retype it) into
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`; push.
5. First owner, with the email the Access login uses, in lower case:

   ```bash
   npx wrangler d1 execute brickplace-admin-<env> --remote -c workers/admin/wrangler.jsonc --env <env> \
     --command "INSERT INTO admin_roles (email, role, granted_by, granted_at) VALUES ('<email>', 'owner', 'bootstrap', 0)"
   ```

   Everyone else is added from the admin page.
6. Check, in a private window: the Access login comes first, then the admin page.

## 8. Alerts and the rest

- Alerts before public traffic: [alerts.md](alerts.md).
- With a zone: WAF rate-limiting rules on `/auth/` and `/api/` (numbers in the ops repo, ADR
  0019), optionally `/ws`. One rule covers the whole `brickplace.app` zone, so staging's
  (2026-11-03: Free plan, per IP, 10 s period, Block for 10 s) will cover production too.
  To check one: send more than the limit to `/api/me` within 10 s over one connection (one
  `curl` with the URL repeated): the requests past it get 429 (`error code: 1015`), and the
  path answers again 10 s later. Separate `curl` runs may leave through different addresses
  behind a proxy and not add up.
- Before the first deploy of moderation to an environment that already has accounts, record
  a D1 Time Travel bookmark (`PROGRESS.md`, "Blocked / needs the owner").
- Bots on staging (ADR 0034), staging only, when wanted: put a key on the gateway and keep a
  copy for the laptop that runs the bots; delete it to stop new bot sockets.

  ```bash
  (umask 077; openssl rand -base64 32 | tee ~/.brickplace-bot-key | npx wrangler secret put BOT_KEY -c workers/gateway/wrangler.jsonc --env staging)
  npx wrangler secret delete BOT_KEY -c workers/gateway/wrangler.jsonc --env staging   # off
  ```

  The file keeps a trailing newline; the driver trims it. Each bot socket closes after an
  hour (4401) and reconnects with the key, so deleting it stops every bot within the hour.
  Bots have no per-address limit; the `unscored` trust tier and the bot signal weights of
  staging's `abuse-policy` (step 3) decide how many hammers and shields they may use. Running
  them: [tools/bots/README.md](../../tools/bots/README.md).
