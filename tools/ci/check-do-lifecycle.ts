// Guards Durable Object lifecycle changes (`migrations` / `exports` in wrangler.jsonc).
// Such changes cannot be rolled back across, and a class must be deployed by its owning
// script before any script binds to it. So a PR that touches them must:
//   1. carry the `do-lifecycle` label (CI passes DO_LIFECYCLE_LABEL=true), and
//   2. change nothing except wrangler configs, generated types and ADRs.
// Adding a new DO class therefore takes two PRs: first the class (exported, unbound),
// then the migration and bindings.
// Usage: tsx tools/ci/check-do-lifecycle.ts [base-ref]   (default origin/develop)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowedAlongside = [/wrangler\.jsonc$/, /worker-configuration\.d\.ts$/, /^docs\/adr\//];

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Removes // and /* *\/ comments and trailing commas, leaving string contents alone. */
export function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('unterminated block comment');
      i = end + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Canonical string of everything that affects Durable Object lifecycle in one config. */
export function lifecycle(text: string): string {
  const config = parseJsonc(text) as {
    migrations?: unknown;
    exports?: unknown;
    env?: Record<string, { migrations?: unknown; exports?: unknown }>;
  };
  // Top-level migrations and exports carry over into every env, so with them each env name
  // (which also names the deployed script) is part of the lifecycle: adding or renaming one
  // starts a fresh namespace. Only a worker with no top-level lifecycle may leave out envs
  // that declare none, so a new worker whose env blocks set only vars and bindings counts as
  // unchanged.
  const inherited = config.migrations !== undefined || config.exports !== undefined;
  const envs = Object.entries(config.env ?? {})
    .map(([name, env]) => [name, env.migrations ?? null, env.exports ?? null])
    .filter(([, migrations, exports]) => inherited || migrations !== null || exports !== null);
  return JSON.stringify([config.migrations ?? null, config.exports ?? null, envs]);
}

function main(base: string, labelled: boolean): void {
  try {
    git('rev-parse', '--verify', base);
  } catch {
    if (process.env.CI) {
      console.error(`base ref ${base} not found; fetch it (actions/checkout fetch-depth: 0)`);
      process.exit(1);
    }
    console.log(`base ref ${base} not found; skipping DO lifecycle check`);
    return;
  }

  const configs = readdirSync('workers')
    .map((dir) => join('workers', dir, 'wrangler.jsonc'))
    .filter((path) => existsSync(path));
  const changed = configs.filter((path) => {
    let before = '{}'; // a new worker counts as changed only if it declares DO lifecycle
    try {
      before = git('show', `${base}:${path}`);
    } catch {}
    return lifecycle(before) !== lifecycle(readFileSync(path, 'utf8'));
  });

  if (changed.length === 0) {
    console.log('no Durable Object lifecycle changes');
    return;
  }
  console.log(`Durable Object lifecycle changed in: ${changed.join(', ')}`);
  if (!labelled) {
    console.error('add the `do-lifecycle` label to this PR to confirm the change is intended');
    process.exit(1);
  }
  const others = git('diff', '--name-only', `${base}...HEAD`)
    .split('\n')
    .filter((file) => file && !allowedAlongside.some((pattern) => pattern.test(file)));
  if (others.length > 0) {
    console.error(`lifecycle PRs must not change other files; found:\n  ${others.join('\n  ')}`);
    process.exit(1);
  }
  console.log('lifecycle-only PR with label: ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? 'origin/develop', process.env.DO_LIFECYCLE_LABEL === 'true');
}
