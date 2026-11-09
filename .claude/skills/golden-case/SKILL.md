---

name: golden-case
description: Add or update a golden op-log fixture for the game core (packages/golden). Use when changing rules in packages/core or when a bug needs a regression case.
---

# Golden case

Golden fixtures pin the exact grid every implementation of the rules must produce.
1. Add `packages/golden/fixtures/<name>.json` with `config`, `ops`, an empty
   `expectedOutcomes: []` and `expectedHash: ""`. Keep maps small (16 to 64 cells).
2. Run `pnpm golden:update`, then open the fixture and check every outcome by hand
   against the rules in the design doc. The tool records what the code does, not what is right.
3. Run `pnpm verify`.
4. If an EXISTING fixture's hash or outcomes changed, the rules changed: stop and ask the
   user, and record it with `/new-adr` before committing.
