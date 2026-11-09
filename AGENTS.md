# BrickPlace

A long-running collaborative map game on Cloudflare: every player gets one item per
cooldown (brick, hammer or shield, hold of 3) and uses it on a shared 1024×1024 map.
The design doc is private to the owner; decisions that shape the code are in `docs/adr/`.
Current work and next steps are in `PROGRESS.md`.

## Commands

- `pnpm install` once; Node 24 and pnpm 11 (see `.node-version`, `packageManager`).
- `pnpm verify`: Biome + typecheck + all tests + Worker bundles. CI runs exactly this.
  Work is not done until it passes.
- `pnpm check`: auto-fix formatting and safe lint issues.
- `pnpm dev`: build the client, then run all three Workers in one `wrangler dev` on :8787.
- `pnpm types`: regenerate `worker-configuration.d.ts` after editing a `wrangler.jsonc`.
- `pnpm golden:update`: fill hashes for new golden fixtures (review them by hand).
- One package: `pnpm --filter @brickplace/core test`.

## Layout

- `packages/core`: the only home of game rules. Pure, deterministic, platform-free.
- `packages/protocol`: versioned binary wire format shared by client and Workers.
- `packages/golden`: op-log fixtures + expected grid hashes; any rules port must match them.
- `workers/gateway`: auth, routing, static client. `workers/game`: rule Durable Objects.
  `workers/realtime`: FanoutDO (WebSockets). Three scripts so game deploys keep sockets up.
- `apps/client`: Vite + WebGL2. `tools/ci`: CI guards. `tools/loadtest`: k6. `tools/sim`:
  season simulation on the core. `tools/bots`: bots that play a running game (ADR 0034).

## Rules that are easy to break

- Game rules change only in `packages/core`, with golden fixtures and an ADR.
- Each Durable Object class is declared in exactly one `wrangler.jsonc`; `migrations`
  changes ship alone in a PR labelled `do-lifecycle`.
- Never deploy from a laptop and never commit secrets, abuse thresholds or moderation lists:
  this repo is public (AGPL-3.0, ADR 0046). Those live in Workers Secrets, KV/D1 or the private ops repo.
- The client is untrusted: the server draws items, checks cooldowns and applies rules.
- Do not use Tetris naming or look-and-feel (no "tetromino", "-tris", Guideline colours).
- Tests must pass on a 2-CPU runner (the margin; CI's has 4), about 10x slower than a laptop
  under `pnpm verify`: every vitest package sets `testTimeout`; no `toEqual` on large typed arrays (compare them
  in a loop); never sleep a few hundred ms and then assert, or bound elapsed time from above.
  Poll for the condition in a loop up to a generous deadline, or drive time from the test.

## Commits and PRs

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`…), release-please builds the changelog.
- Every commit carries a DCO sign-off: `git commit -s`.
- Small PRs; one concern each. Fill in the PR template.
