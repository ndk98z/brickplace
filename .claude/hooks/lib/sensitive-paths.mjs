// The one list of paths the harness treats as sensitive. Three places ask about it:
//   - verify-before-stop: a committed change here needs a review receipt from the reviewer agent;
//   - require-plan: the first edit here in a session needs a written plan;
//   - check-invariants: shell writes here are refused, because their content cannot be checked.
// One list, so a path can never be guarded in one place and silently dropped from another.
// Directory patterns end in `(\/|$)` so a shell write whose target is the directory itself
// (`cp -t packages/core/src x.ts`) is caught too.

/**
 * Code where a wrong change breaks rules, durability or deploys, and the harness that guards
 * it (hooks, settings, agents and their tests): needs a plan before the first edit.
 */
export const PLAN_PATHS = [
  /^packages\/core\/src(\/|$)/,
  /^packages\/protocol\/src(\/|$)/,
  /^packages\/golden\/fixtures(\/|$)/,
  /^workers\/[^/]+\/src(\/|$)/,
  /^workers\/[^/]+\/wrangler\.jsonc$/,
  // D1 schemas: accounts, and the admin audit log whose triggers keep it append-only.
  /^workers\/[^/]+\/migrations(\/|$)/,
  /^\.github\/workflows(\/|$)/,
  /^\.claude\/(?!state(\/|$))/,
  /^tools\/ci(\/|$)/,
];

/**
 * Needs an independent review before it lands: the plan paths, plus what defines the gate
 * and the agents' instructions (the `verify` script, Turbo and Biome config, CLAUDE.md, ...).
 * Without these, a change that weakens the hooks or the gate could land itself.
 */
export const REVIEW_PATHS = [
  ...PLAN_PATHS,
  /^package\.json$/,
  // Each package's own scripts and test config are part of what `pnpm verify` runs. A
  // `vite.config` counts too: the client's doubles as its vitest config.
  /^(apps|packages|workers|tools)\/[^/]+\/(package\.json|tsconfig[^/]*\.json|vite(st)?\.config\.[cm]?[jt]s)$/,
  /^\.gitignore$/,
  /^turbo\.json$/,
  /^biome\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig\.base\.json$/,
  /^(CLAUDE|AGENTS)\.md$/,
  /^\.mcp\.json$/,
  // CI's secrets job reads these: an allowlist or ignored fingerprint opens the gate.
  /^\.gitleaks(\.toml|ignore)$/,
  /^\.github\//,
];

/** Files whose content invariants check-invariants reads; shell writes to them are refused. */
export const INVARIANT_FILES = [
  /^packages\/core\/src(\/|$)/,
  /^packages\/protocol\/src(\/|$)/,
  /^workers\/[^/]+\/wrangler\.jsonc$/,
];

export const matches = (list, rel) => list.some((re) => re.test(rel));
