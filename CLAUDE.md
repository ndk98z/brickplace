@AGENTS.md

## Claude Code

- Skills: `/verify`, `/new-adr`, `/golden-case`, `/promo-video`, `/deploy` (manual only).
- Rules in `.claude/rules/`: `tools.md` loads in every session; the others load when you
  touch core, workers or the client.
- Long-running work: bare `/loop` follows `.claude/loop.md` and keeps state in `PROGRESS.md`.
- `cloudflare-docs` MCP (`.mcp.json`) has current Workers and Durable Objects docs; prefer it
  over memory for platform limits, pricing and APIs.
- Personal notes go in `CLAUDE.local.md` (gitignored).

## Harness

The loop is explore → plan → implement → verify → review → land, and hooks enforce it rather
than trusting each session to remember. They guard against accident, not intent: they read
text, not meaning. When a hook blocks you, do what it says or ask the user; never route
around it. Every decision is logged to `$(git rev-parse --git-common-dir)/brickplace-hooks.jsonl`.
1. **Work in a worktree.** `auto-worktree` refuses edits in the main tree (Edit, Write and
   shell writes such as `>`, `tee`, `sed -i`, `cp`). Call EnterWorktree first, then run
   `pnpm install --frozen-lockfile --prefer-offline` in it (a few seconds from the store; a
   worktree must not share the main tree's node_modules, or workspace packages resolve to the
   main tree's code). Session state in `.claude/state/`, build output and paths outside the
   repo are exempt. `git merge --ff-only <branch>` is allowed in the main tree, run on its
   own, when the commits it brings in that touch sensitive files have a "ship" review receipt
   for the branch head whose `base` covers them: it is how reviewed work lands.
2. **Plan before sensitive edits.** `require-plan` refuses the first edit in a session to
   `packages/core|protocol/src`, `packages/golden/fixtures`, `workers/*/src`,
   `workers/*/wrangler.jsonc`, `.github/workflows`, `.claude/` or `tools/ci/` until
   `.claude/state/plan-<session>.md` has 3+ lines. A wider list needs a review before it
   lands: those paths plus what defines the gate (root and package `package.json`,
   `tsconfig*`, `vitest.config.*`, `vite.config.*`, `turbo.json`, `biome.json`, `.gitignore`, `CLAUDE.md`,
   `AGENTS.md`, `.github/`, `.gitleaks.toml`, `.gitleaksignore`), so a change that weakens the hooks or the gate cannot land
   itself. Both lists live in `.claude/hooks/lib/sensitive-paths.mjs`.
3. **Invariants visible in text.** `check-invariants` refuses: clock or randomness in
   core/protocol, `ENVIRONMENT: "dev"` in the gateway config, secrets in `wrangler.jsonc`,
   Tetris names in code, Vietnamese in code. Shell writes to core, protocol and
   `wrangler.jsonc` are refused so their content can be checked.
4. **Dangerous commands.** `settings.json` denies irreversible commands by prefix
   (deploys, `wrangler` deletes, `rm -rf`, `git reset --hard`, `git clean`, history rewrites,
   `sudo`, Docker prunes, reading `.env`). `guard-bash` catches the same anywhere in a chain,
   plus `--remote` wrangler calls, force-push, reading `.dev.vars` and inline interpreter
   code that writes files (`python3 -c "open(p, 'w')..."`, `node -e`, `pnpm exec tsx -e`, a
   heredoc fed to one), whatever the path, scratch included: change files with Edit/Write
   (`.claude/rules/tools.md`) and send scratch output to stdout with a redirect.
5. **Pushes.** Any branch may be pushed; `guard-push` refuses anything that would update
   `develop` (the default branch; it deploys staging) or `main` (releases), including
   `HEAD:develop`, `--all` and destinations hidden in `$VAR`. Hand those to the user.
6. **Stop.** `verify-before-stop` runs `pnpm verify` on what the session changed. In a
   worktree it also requires the work to be committed, requires a reviewer receipt
   (`.claude/state/review-<HEAD>.json`, written by the `reviewer` agent) when sensitive files
   changed, and then fast-forwards the branch onto the branch checked out in the main tree
   (keep `develop` checked out there). Landing is local; pushing `develop` stays with the user.
   Each failing step
   blocks up to 3 times, then releases with a loud warning and without landing; after
   `GATES ARE STILL FAILING` or `NO PASSING INDEPENDENT REVIEW`, never report the work as
   done, tested or reviewed.
7. **Formatting.** `format-edited` runs Biome on every edited file.

Hooks have tests: `pnpm --filter @brickplace/ci-tools test` (part of `pnpm verify`; turbo
re-runs it whenever `.claude/` changes). Change a hook, add the case that would have caught
the bug.

Known limits, accepted on purpose (guards read text, they are not a sandbox): writes made
by a script file run by path, by inline code piped in from another command
(`echo ... | python3`), inside a quoted `"$(...)"`, after a flag whose value looks like a
script (`node --require ./x.cjs -e ...`), or through an API missing from
guard-bash's `FILE_API` list (`subprocess.run(['sed', '-i', ...])`), `sh -c "..."`, `>|`,
`rsync`, `patch`, `cp --target-directory=`, and wrappers such as `timeout` or `nice` around
a shell write are not seen.
A `$VAR` write target with no literal prefix is refused even when it points outside the
repo (`> $TMPDIR/x`); write the path literally. Review receipts sit in the exempt
`.claude/state/`, so a session could write its own: the reviewer agent is the only thing
meant to. With the main tree on a detached HEAD, `develop` is checked out nowhere and git's
own refusals (`checkout -B develop`, `branch -D develop`) no longer apply; keep `develop`
checked out.
Deliberate multi-step routes are not covered either: `git symbolic-ref HEAD refs/heads/main`
in a worktree followed by a commit, git aliases (`-c alias.x=...`) that hide the subcommand,
and combined short flags such as `branch -fM`.
