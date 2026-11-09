---

name: deploy
description: Deploy BrickPlace to staging or production through GitHub Actions. Only when the user explicitly asks to deploy.
disable-model-invocation: true
---

# Deploy

Deploys never run from a laptop; the guard hook blocks local `wrangler` deploys.
- Staging: every push to `develop` (the default branch) deploys automatically. To redeploy by
  hand: `gh workflow run deploy.yml --ref develop -f env=staging` (the `staging` environment
  accepts `develop` only).
- Production: off until the repository variable `PRODUCTION_ENABLED` is `true`. Then: PR
  `develop` → `main` (merge commit), merge the release-please PR on `main`; the release
  workflow calls `deploy.yml` with `env=production` (the `production` environment accepts
  `main` only). Merge `main` back into `develop` afterwards with a merge commit, never squash.
  A dispatch with `-f env=production` also waits for `PRODUCTION_ENABLED`.
- `game` and `realtime` ship only when their code changed since the tag
  `deployed/<env>/<script>` (or when that tag does not exist yet); `gateway` always ships.
  A realtime deploy drops every player's socket. Force one with `-f realtime=true`.
  Each script's tag is pushed right after its own deploy, so a run that fails later never
  redeploys realtime on the re-run.
- The gateway's D1 migrations (`workers/gateway/migrations`) are applied to that
  environment's accounts database first, before any script deploys; a failed migration
  stops the run with nothing deployed. Migrations only add: never edit or drop in one.
- The admin Worker (ADR 0022) and its D1 migrations (`workers/admin/migrations`) run only
  in a GitHub environment whose own variable `ADMIN_ENABLED` is `true` (set per environment,
  never on the repository), which the owner sets once that environment's admin database,
  hostname and Access application exist. Its migrations run with the gateway's,
  and it deploys last (it calls CanvasDO methods the game deploy brings).
- Durable Object lifecycle changes (`migrations` in a wrangler.jsonc) ship alone, in a PR
  labelled `do-lifecycle`, and deploy the owning script before scripts that bind to it.

After triggering, watch with `gh run watch` and report the run URL and outcome.
