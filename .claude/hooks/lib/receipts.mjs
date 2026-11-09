// Review receipts: `.claude/state/review-<sha>.json`, written by the reviewer agent as
// { head, base, verdict }. Shared by the Stop hook and by auto-worktree, which lets a
// fast-forward land on the main tree only when the commits it brings in have passed review.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './repo.mjs';
import { matches, REVIEW_PATHS } from './sensitive-paths.mjs';

/** State directories a receipt may sit in: the main tree's and every session worktree's. */
function stateDirs(mainRoot, extra = []) {
  const dirs = [...extra, join(mainRoot, '.claude', 'state')];
  const worktrees = join(mainRoot, '.claude', 'worktrees');
  if (existsSync(worktrees)) {
    for (const name of readdirSync(worktrees)) dirs.push(join(worktrees, name, '.claude', 'state'));
  }
  return dirs;
}

/** The receipt for `sha`, or null. Only one naming this exact commit counts. */
export function receiptFor(mainRoot, sha, extraDirs = []) {
  for (const dir of stateDirs(mainRoot, extraDirs)) {
    const file = join(dir, `review-${sha}.json`);
    if (!existsSync(file)) continue;
    try {
      const content = JSON.parse(readFileSync(file, 'utf8'));
      if (content?.head === sha) return content;
    } catch {
      // A corrupt receipt is no receipt.
    }
  }
  return null;
}

/**
 * Files between `base` and `head` that need an independent review before they land. Throws
 * when git cannot answer: an empty list would read as "nothing sensitive" and let it land.
 */
export function sensitiveChanges(cwd, base, head) {
  // --no-renames: a rename would list only its new path, so moving a hook out of
  // .claude/hooks/ would hide that a sensitive file changed.
  const out = git(cwd, 'diff', '--name-only', '--no-renames', `${base}...${head}`);
  if (out === null) throw new Error(`cannot diff ${base}...${head}`);
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => matches(REVIEW_PATHS, f));
}

/**
 * Sensitive changes a ship receipt does not cover when its commit lands on `target`. The
 * reviewer records `base`, the commit its diff started from; commits reachable from `base`
 * but not from `target` were never in the reviewed diff. A receipt without a valid `base`
 * covers nothing.
 */
export function uncoveredChanges(cwd, target, receipt) {
  const base = receipt?.base
    ? git(cwd, 'rev-parse', '--verify', '--quiet', `${receipt.base}^{commit}`)
    : null;
  if (!base) return sensitiveChanges(cwd, target, receipt.head);
  return sensitiveChanges(cwd, target, base);
}
