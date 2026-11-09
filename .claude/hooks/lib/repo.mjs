// Shared helpers for BrickPlace hooks: reading the hook payload, locating the main working
// tree and the session worktree, logging every decision, and blocking with a message.
//
// Hooks are guards against accident, not a sandbox: they read text, they do not understand
// intent. CLAUDE.md "Harness" says the same about every hook in this directory.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

export function git(cwd, ...args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Resolves symlinks (macOS /tmp → /private/tmp) on the nearest existing ancestor. */
export function realPath(path) {
  let head = resolve(path);
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(head.slice(parent.length + 1));
    head = parent;
  }
  try {
    head = realpathSync(head);
  } catch {}
  return tail.length ? join(head, ...tail) : head;
}

export function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The tree a directory belongs to. `mainRoot` is the main working tree (where the repo was
 * cloned); `top` is the tree the directory is in, which is a worktree under
 * `.claude/worktrees/` when a session has called EnterWorktree.
 */
export function treeInfo(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  if (!top) return null;
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const mainRoot = realPath(common ? dirname(common) : top);
  const realTop = realPath(top);
  return { top: realTop, mainRoot, commonDir: common, inWorktree: realTop !== mainRoot };
}

/** Root of the tree a path lives in: its worktree if it is under .claude/worktrees/<name>/. */
export function rootFor(path, mainRoot) {
  const worktrees = join(mainRoot, '.claude', 'worktrees');
  if (isInside(path, worktrees) && path !== worktrees) {
    const name = relative(worktrees, path).split(/[\\/]/)[0];
    return join(worktrees, name);
  }
  return mainRoot;
}

/** Paths that never need a worktree: outside the repo, session state, build output. */
export function isExempt(path, mainRoot) {
  if (!isInside(path, mainRoot)) return true;
  const rel = relative(mainRoot, path).split(/[\\/]/);
  if (rel.includes('state') && rel[rel.indexOf('state') - 1] === '.claude') return true;
  return rel.some((part) =>
    ['node_modules', 'dist', '.turbo', '.wrangler', 'coverage'].includes(part),
  );
}

/**
 * The branch the repository publishes from. origin/HEAD when known; otherwise an existing
 * `main` or `master`. Never `init.defaultBranch`: that is the user's preference for new repos,
 * and trusting it once let the Stop hook fast-forward straight onto main.
 */
export function defaultBranch(cwd) {
  const head = git(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head?.includes('/')) return head.slice(head.indexOf('/') + 1);
  for (const name of ['main', 'master']) {
    if (git(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`)) return name;
  }
  return 'main';
}

/**
 * Branches nothing automatic may update. deploy.yml triggers on `develop` (staging) and
 * release.yml on `main` by name, so `develop`, `main` and `master` are always protected
 * whatever origin/HEAD says; pointing origin/HEAD elsewhere once let the Stop hook land on main.
 */
export function protectedBranches(cwd) {
  return new Set(['develop', 'main', 'master', defaultBranch(cwd)]);
}

/** Runs a PreToolUse guard; any internal error blocks instead of silently allowing. */
export function guard(name, fn) {
  try {
    fn();
  } catch (error) {
    process.stderr.write(
      `Blocked: .claude/hooks/${name} failed internally (${error?.message ?? error}). ` +
        'Failing closed; fix the hook or ask the user.\n',
    );
    process.exit(2);
  }
}

export function currentBranch(cwd) {
  return git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
}

/** One JSONL line per decision, in the git dir so no worktree ever shows it as a change. */
export function log(commonDir, entry) {
  if (!commonDir) return;
  try {
    appendFileSync(
      join(commonDir, 'brickplace-hooks.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {}
}

export function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
