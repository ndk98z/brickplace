# 0046. Open source before season 1, as a fresh repository

- Status: accepted (owner, 2026-11-09)
- Date: 2026-11-09
- Amends: 0002 (timing, key rotation)

## Context

ADR 0002 planned to publish the code after season 1 launches, as a fresh repository with a
squashed history. The owner wants it public now, before season 1.

A scan of the private repository on 2026-11-09 covered 595 commits (544 of them not merges)
on every branch and pull request ref, all 45 pull requests and the Deploy run logs. It found no secret and no abuse
threshold. It did find things that cannot be removed without rewriting history:
- The operator's postal address, hard-coded in the legal pages from 2026-10-25 until ADR 0037
  moved it to deploy variables.
- A DCO sign-off by Claude rather than a person on 136 of the 544 non-merge commits.
- `claude.ai` session and private design links in commit messages and pull request bodies.
- The Cloudflare account id in clear in every Deploy log, because it was an Actions variable.

Rewriting this repository's history in place does not remove them. GitHub keeps every pull
request's `refs/pull/N/head` (read-only, so the old commits stay reachable), commits left by a
force-push stay readable by SHA, and run logs stay until deleted one by one.

## Decision

- Publish now. The repository on GitHub is renamed `brickplace-archive`, stays private and
  is archived (read-only, Actions off, its Cloudflare secrets deleted). A new public
  repository takes the name `ndk98z/brickplace`. Its first commit is the tree of `develop`
  squashed into one commit, authored and signed off by the owner.
- All further work happens in the new repository. History before the squash is looked up in
  the archive.
- The design doc stays private. Links to it, and links to the old repository's pull
  requests, are not committed; an owner's own pointers go in `CLAUDE.local.md`.
- The Cloudflare account id is an Actions secret, so it is masked in public run logs. The
  repository variable `DEPLOY_ENABLED` (`true`) turns deploys on, because a job-level
  condition can read variables but not secrets.
- No Workers Secret is rotated: `ITEM_DRAW_KEY`, `SESSION_KEYS`, `TURNSTILE_SECRET_KEY` and
  the OAuth client secrets keep their staging values. They live only in Cloudflare and were
  never in the repository (the scan, and the owner's gitleaks run over 547 commits on
  2026-11-09, found no leak), and the old history is not published. Rotating `SESSION_KEYS`
  would also sign every staging player out for nothing. Production gets its own keys when it
  is set up.
- Only the GitHub secrets that move are replaced. The new repository gets a new
  `CLOUDFLARE_API_TOKEN` and the archive's token is revoked, so the archive holds no working
  credential; the same goes for `ANTHROPIC_API_KEY` if it is set.
- Everything else in ADR 0002 stands: AGPL-3.0, DCO, abuse thresholds and moderation lists
  outside the repository. Its "rotating every key" is replaced by the two points above.

## Consequences

- The public history starts at the squash. Pull request numbers restart, so docs cite the
  archive's pull requests by description, not by link.
- The owner sets up the new repository from scratch before its first deploy:
  - variables and secrets (docs/ops/setup.md, step 4);
  - environments, with a required reviewer on `production`;
  - rulesets on `develop` and `main`;
  - private vulnerability reporting, and secret scanning with push protection;
  - Renovate and the Claude GitHub App.

  Until `DEPLOY_ENABLED` is set, deploys are skipped.
- The `deployed/<env>/<script>` tags that tell a deploy what changed stay in the archive.
  Without them, the new repository's first deploy ships every script, so CanvasDO replays
  its log and staging sockets drop once. That is harmless before season 1. Never push the
  archive's tags: each one carries its commit and the whole old history with it. To avoid
  the redeploy, run `git diff --quiet deployed/<env>/<script> <squashed commit> -- <paths>`
  (the paths of deploy.yml's plan step) and, for each script with no change, create
  `deployed/<env>/<script>` on the squashed commit in the new repository.
- The season starts in public. Anyone can read the rules and the abuse code before season 1.
  The thresholds stay in KV, so knowing the code does not tell anyone the limits.
