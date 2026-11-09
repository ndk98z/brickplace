---

name: verify
description: Run BrickPlace's full check (Biome, typecheck, unit + Worker tests, golden fixtures, Worker bundles) and fix what fails. Use before saying work is done, before committing, and when CI is red.
---

# Verify

1. Run `pnpm verify` from the repo root. It is the same gate CI runs.
2. If Biome fails on formatting only, run `pnpm check` and re-run.
3. For any other failure, read the first error, fix the root cause, and re-run. Never:
   - weaken a test, add `// @ts-expect-error` or `biome-ignore` to get green;
   - regenerate golden hashes to make a rule change pass (that is `/golden-case` plus an ADR);
   - edit `worker-configuration.d.ts` by hand (run `pnpm types`).
4. Report the result plainly: which tasks ran, what failed, what you changed. If something
   cannot pass yet, say why instead of stopping silently.
