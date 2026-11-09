# 0045. Staging's pages move to staging.brickplace.app; old addresses redirect

- Status: proposed (amended the same evening: no workers.dev address, no redirect, below)
- Date: 2026-11-03
- Relates to: 0015 (sign-in and `PUBLIC_ORIGIN`), 0019 (WAF rules per zone), 0029 and 0044
  (staging without a zone)

## Context

Staging ran on `brickplace-gateway-staging.brickplace.workers.dev` because the account had no
zone. Since 2026-11-03 `brickplace.app` is one, and staging's tiles are already on
`tiles-staging.brickplace.app` (ADR 0044). The pages follow to `staging.brickplace.app`, one
level under the zone so the free certificate covers it; production will use `brickplace.app`.

The gateway answers `/api` and `/auth` only on `PUBLIC_ORIGIN`'s host (421 elsewhere, so the
zone's WAF rules cannot be skipped through workers.dev), refuses a socket whose `Origin` is
another site (403), and keeps sessions in host-only `__Host-` cookies. Changing
`PUBLIC_ORIGIN` therefore ends every page on the old address: it loads, then cannot sign in
or play. Static assets were served without running the Worker, so nothing could send those
pages on.

## Decision

- Staging's gateway takes the custom domain (`routes`, `custom_domain: true`) and
  `PUBLIC_ORIGIN` = `https://staging.brickplace.app`. Deploys need Zone / Workers Routes / Edit
  on the zone in the deploy token; the owner added it first, with the OAuth redirect URIs and
  the Turnstile hostname.
- Outside dev and locked deploys, a page asked for on a host other than `PUBLIC_ORIGIN`'s gets
  a 302 to the same path and query there (`canonicalPage`, gateway `http.ts`). Temporary, not
  permanent: browsers cache a 301 or 308, which would outlive a move back. `/healthz`, `/ws`,
  `/api` and `/auth` keep their own answers.
- To let the Worker see page requests, `assets.run_worker_first` becomes `["/*",
  "!/assets/*", "!/fonts/*"]`: hashed bundles and fonts are still served without it.
- Staging keeps `workers_dev: true`, written out: wrangler turns it off by default once a
  Worker has routes, which would drop the old address before anyone is redirected.

## Consequences

- Each page load (HTML, icons, the manifest) now runs the gateway once, in every environment:
  a few requests per visit, billed as Worker requests; bundles and fonts stay free.
- Players on staging sign in again once. Bots and k6 use `wss://staging.brickplace.app/ws`;
  they read `/api/me` and so had to move anyway (421 on the old host).
- Production's `PUBLIC_ORIGIN` is empty, so it redirects nothing until it is set. It will get
  its `routes` at the same time, and wrangler then turns its workers.dev address off unless
  its env block also writes `workers_dev: true`; only then would that address redirect too.
- While `workers_dev` stays on, any non-browser client (no `Origin`, or a forged one) can
  still open `/ws` there, past a zone WAF rule on `/ws`. `/api` and `/auth` answer 421 there
  before any handler runs, so their WAF rules guard the handlers, but those requests, and now
  page requests, still run the Worker and are billed with no WAF limit. Turning `workers_dev`
  off (the owner's open decision) ends that and the redirect together. The tiles bucket's
  CORS dropped the workers.dev origin the evening of the deploy (2026-11-03).
- The deploy uploads the script, with the new `PUBLIC_ORIGIN`, before it attaches the custom
  domain, and in CI it replaces any DNS record already on `staging.brickplace.app`. If the
  domain is not live yet, workers.dev pages redirect to a host that does not answer: check
  `https://staging.brickplace.app/healthz` right after the deploy; reverting is the way back.

## Amended 2026-11-03 (evening): no workers.dev address, no redirect

The owner turned the staging gateway's workers.dev address off (the open decision on
`workers_dev`, for this Worker): every request then reaches the Worker through
`staging.brickplace.app` and passes the zone's WAF rules, and nobody can spend Worker
requests on an address the WAF does not see. Staging's testers are few, so losing the
redirect for old links costs little.
- `env.staging` writes `workers_dev: false` (wrangler's default with routes, written out so a
  removed route cannot reopen it); a gateway test checks it.
- With no other host reaching the Worker, the redirect cannot run: `canonicalPage` and its
  tests are gone, and `assets.run_worker_first` is back to `["/ws", "/healthz", "/api/*",
  "/auth/*"]`, so pages are served without a Worker invocation again.
- The `/api` and `/auth` host check of ADR 0019 stays (it also guards a future second host).
- Production writes nothing yet; when it gets its domain, it should write `workers_dev:
  false` the same way.
