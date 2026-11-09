# 0036. `develop` deploys staging, `main` takes releases

- Status: accepted
- Date: 2026-10-26

## Context

Every merge to `main` deployed staging, and a release-please release on `main` would deploy
production. With staging in daily use and production not set up yet, the owner wants
staging to follow an integration branch and `main` to move only when a release is meant,
with production off for now.

## Decision

- `develop` is the repository's default branch. Feature PRs target it (squash or merge);
  every push to it runs `deploy.yml` for staging. The `staging` environment accepts
  deployments from `develop` only.
- `main` receives `develop` through PRs with merge commits only (a squash would leave the two
  histories apart and replay the same changes in the next PR). release-please targets `main`
  explicitly (`target-branch`), since the action otherwise follows the default branch. After
  a release, `main` is merged back into `develop` with a merge commit, never a squash.
- Production deploys only when the repository variable `PRODUCTION_ENABLED` is `true`, for a
  release and for a hand-dispatched deploy alike; until then a release only tags. The
  `production` environment accepts `main` only; the owner becomes its required reviewer once
  the repository is public (GitHub Free offers environment reviewers on public repositories
  only), so until then the variable is the lock.
- Each branch has its own ruleset naming it explicitly (PR, the CI checks, no force-push or
  deletion). The earlier ruleset targeted `~DEFAULT_BRANCH`, which would have moved its
  protection off `main` the moment the default changed.
- The harness treats `develop` like `main`: `guard-push` refuses pushes that update it, and
  the Stop hook lands on the branch checked out in the main tree, which is `develop`.

## Consequences

- A merge to `develop` is a staging deploy, so `develop` must stay green; CI runs on pushes
  to both branches.
- Two long-lived branches: `main` lags `develop` until a release is cut, and the back-merge
  after a release is a manual step.
- Durable Object lifecycle changes still ship alone, in their own labelled PR, into
  `develop` and so to staging. A `develop` → `main` PR carries whatever `develop` holds, so
  the `do-lifecycle` check skips that one PR (every other PR into `main` still runs it), and
  production may get a lifecycle change batched with other work; deploy.yml's order (the
  owning script first) keeps that safe. To ship one alone to production too, cut a release
  right after its PR.
- Turning production on is one variable plus the `production` environment's token, ids and
  secrets (docs/ops/setup.md).
