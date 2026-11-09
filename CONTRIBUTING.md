# Contributing to BrickPlace

Thanks for helping. This file covers how to set up, what a good change looks like, and
the sign-off every commit needs.

## Set up

```sh
pnpm install     # Node 24, pnpm 11
pnpm verify      # must pass before you open a PR
pnpm dev         # all Workers locally on http://localhost:8787
```

`AGENTS.md` explains the layout and the rules that are easy to break. Read it first; it is
also what AI coding agents read.

## Making a change

- One concern per PR. Open an issue first for anything bigger than a bug fix.
- Game rules live only in `packages/core`. A rule change needs a golden fixture update
  (`pnpm golden:update`, then review the result by hand) and an ADR in `docs/adr/`.
- Wire protocol changes must stay backward compatible or bump `PROTOCOL_VERSION`.
- Durable Object `migrations` changes go in their own PR; a maintainer adds the
  `do-lifecycle` label.
- Never commit secrets. Local values go in `.dev.vars` (gitignored); add the variable name to
  `.dev.vars.example`.
- Anti-cheat and moderation rules are not in this repository on purpose. Please report
  weaknesses privately (see SECURITY.md) instead of opening issues or PRs about them.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
`refactor:`, `test:`, `chore:`. The changelog and releases are generated from them.

## Developer Certificate of Origin

Every commit must be signed off, certifying you wrote it or have the right to submit it
under the project's license ([DCO 1.1](https://developercertificate.org/)):

```sh
git commit -s -m "fix: refund the item when a hammer hits an empty cell"
```

This adds `Signed-off-by: Your Name <you@example.com>`. CI rejects PRs with unsigned commits.
To sign off commits you already made: `git rebase --signoff develop`.

## License of contributions

Code you contribute is licensed under AGPL-3.0-or-later; art and sound under CC BY-SA 4.0
(see COPYING.md). Contributing does not grant rights to the BrickPlace name or logo.
