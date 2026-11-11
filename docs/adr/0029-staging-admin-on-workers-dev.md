# 0029. Staging admin area on workers.dev behind one-click Access

- Status: accepted; amended 2026-11-03 (staging admin on its own custom domain, below)
- Date: 2026-10-25
- Amends: 0022 (hostname of the admin area, staging only)

## Context

ADR 0022 puts the admin Worker on its own custom domain behind a Cloudflare Access
self-hosted application, with `workers_dev` and `preview_urls` off, because Access did not
cover workers.dev addresses. The owner wants the admin area on staging now, and the account
has no zone yet: staging runs entirely on `*.brickplace.workers.dev`.

Since October 2025 Cloudflare can put Access on a Worker's workers.dev route with one click
(Workers & Pages → the Worker → Settings → Domains & Routes → workers.dev → Enable Cloudflare
Access). That creates an Access application for exactly that hostname, with its own AUD tag
and a reusable policy named `<worker> - Production` (Cloudflare changelog, 2025-10-03 and
2025-12-03).

## Decision

On staging only, `brickplace-admin-staging` is reached at
`https://brickplace-admin-staging.brickplace.workers.dev`:
- `env.staging` sets `workers_dev: true` and keeps `preview_urls: false`, so the one
  workers.dev address is the only way in. The top level and production keep both off and
  still need a custom domain (ADR 0022, step 2).
- Access is enabled on that route in the dashboard. The generated application starts from
  Cloudflare's defaults, not ADR 0022's, so the owner then edits it in Zero Trust → Access →
  Applications: the policy admits the admins' identities only and requires the identity
  provider's MFA (an `mfa` authentication-method rule), and the session lasts 8 hours. Its
  AUD tag and the team domain go into the staging `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`.
- The Worker is unchanged: it still verifies `Cf-Access-Jwt-Assertion` itself (signature,
  `iss`, `aud`, times, `type`), so a request that reaches the script without passing Access
  is refused, and the area answers 503 until both vars are set.

## Consequences

- No zone is needed for staging admin; production still waits for a domain.
- The first deploy with `ADMIN_ENABLED=true` publishes the address before Access is on. It
  answers only `/healthz` and 503 until the Access vars land, so nothing is exposed meanwhile.
- Turning Access off for the route in the dashboard leaves the Worker refusing every request
  without a valid token, but the owner must keep the route's Access on: the policy, not the
  code, decides who gets a token.
- When staging gets a domain, move it to a custom domain like production and set
  `workers_dev: false` again.

## Amended 2026-11-03: admin-staging.brickplace.app

Staging has a zone now (`brickplace.app`, ADR 0045), so its admin area moves the way the last
consequence above says: `env.staging` takes the custom domain `admin-staging.brickplace.app`
(one level under the zone, like staging's other names) and writes `workers_dev: false`, as
the top level and production do (ADR 0022). Before the change the owner created a self-hosted
Access application for that hostname with the same policy (admins only, the identity
provider's MFA, 8-hour session); its AUD tag replaces the workers.dev application's in
`ACCESS_AUD`. The admin tests now require no workers.dev address and no preview URLs in every
environment, and staging's only route to be that domain. After the deploy the owner deletes
the one-click workers.dev application. Until the new hostname answers (a few seconds after the
deploy), staging's admin area is unreachable; nothing is exposed meanwhile, since the Worker
refuses any request without a token for the new AUD.

The session lengths above (8 hours) are superseded: both admin applications keep 24 hours
(ADR 0022, amended 2026-11-11), and the new hostname's application was created at 24 hours.
