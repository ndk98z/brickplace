#!/usr/bin/env node
// Stop: a session may only finish when what it changed passes the gates.
//
// Steps, in order, for the tree the session is in:
//   1. Nothing changed (vs the branch the worktree was cut from, plus uncommitted files): done.
//   2. In a worktree: node_modules must be its own. Symlinked ones block the stop; missing ones
//      are installed from the store (BRICKPLACE_INSTALL_CMD overrides the command in tests).
//   3. Run the gate (`pnpm verify`, the exact command CI runs). Red blocks the stop.
//   4. In a worktree: uncommitted work blocks the stop (only committed work can land).
//   5. In a worktree: a committed change to a REVIEW_PATHS file needs a review receipt,
//      `.claude/state/review-<HEAD sha>.json`, written by the reviewer agent. A commit after the
//      review is a different diff and needs a new receipt.
//   6. In a worktree: fast-forward the branch onto the branch checked out in the main tree,
//      `develop` included. That is local only: pushing `develop` deploys staging (and `main`
//      releases), and guard-push keeps that with the user.
//
// Every block counts a strike per session and step. After 3 strikes the stop is released with
// a loud warning so an unfixable failure reaches the human instead of looping; after
// "GATES ARE STILL FAILING" the agent must not report the work as done or tested.
//
// BRICKPLACE_GATE_CMD overrides the gate command (used by the hook tests).
// Exit 0 lets the stop proceed. Exit 2 blocks it and feeds stderr back.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { receiptFor, uncoveredChanges } from './lib/receipts.mjs';
import { currentBranch, git, log, protectedBranches, readInput, treeInfo } from './lib/repo.mjs';
import { matches, REVIEW_PATHS } from './lib/sensitive-paths.mjs';

// A crash must not look like a pass, and must not trap the session either: report it loudly
// and let the stop through so a person sees it.
process.on('uncaughtException', (error) => {
  process.stdout.write(
    `${JSON.stringify({ systemMessage: `verify-before-stop CRASHED (${error?.message ?? error}); gates did NOT run. Do not report this work as verified.` })}\n`,
  );
  process.exit(0);
});

const MAX_STRIKES = 3;
const input = readInput() ?? {};
const session = String(input.session_id ?? 'unknown').replace(/[^\w-]/g, '_');
const info = treeInfo(input.cwd || process.cwd());
if (!info) process.exit(0);

const stateDir = join(info.mainRoot, '.claude', 'state');
mkdirSync(stateDir, { recursive: true });
const strikesFile = join(stateDir, `stop-${session}.json`);
const readJson = (file) => {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
};
const strikes = existsSync(strikesFile) ? readJson(strikesFile) : {};

/** node_modules directories in the tree (root and one level of packages) that are symlinks. */
const symlinkedModules = (top) => {
  const candidates = [join(top, 'node_modules')];
  for (const group of ['apps', 'packages', 'workers', 'tools']) {
    const dir = join(top, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) candidates.push(join(dir, name, 'node_modules'));
  }
  return candidates
    .filter((path) => {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    })
    .map((path) => path.slice(top.length + 1));
};
const save = () => writeFileSync(strikesFile, JSON.stringify(strikes));
const record = (decision, reason, target = '') =>
  log(info.commonDir, {
    hook: 'verify-before-stop',
    session,
    tool: 'Stop',
    decision,
    target,
    reason,
  });

const tell = (message) => {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
  process.exit(0);
};

/** Blocks, or after MAX_STRIKES of the same step releases with a loud warning. */
const fail = (step, message, released) => {
  strikes[step] = (strikes[step] ?? 0) + 1;
  save();
  if (strikes[step] >= MAX_STRIKES) {
    record('release', `${step}-released`, git(info.top, 'rev-parse', 'HEAD') ?? '');
    // The next problem in this session starts from zero, not from an old release.
    strikes[step] = 0;
    save();
    tell(released);
  }
  record('block', step);
  process.stderr.write(
    `${message}\n(${strikes[step]}/${MAX_STRIKES} before the stop is released anyway)\n`,
  );
  process.exit(2);
};

// A detached main tree has no branch to land on (currentBranch reports 'HEAD').
const mainHead = currentBranch(info.mainRoot);
const target = mainHead === 'HEAD' ? null : mainHead;
// What the branch is measured against: the main tree's branch, or its commit when detached,
// so a detached main tree still runs the gate and the review check (it only skips landing).
const diffBase = target ?? git(info.mainRoot, 'rev-parse', 'HEAD');
const guarded = protectedBranches(info.mainRoot);
const dirty = (git(info.top, 'status', '--porcelain') ?? '')
  .split('\n')
  .filter(Boolean)
  .map((line) => line.slice(3).split(' -> ').at(-1));
let committed = [];
if (info.inWorktree && diffBase) {
  const base = git(info.top, 'merge-base', diffBase, 'HEAD');
  if (base)
    // --no-renames: a rename lists both paths, so moving a sensitive file away still counts.
    committed = (git(info.top, 'diff', '--name-only', '--no-renames', base, 'HEAD') ?? '')
      .split('\n')
      .filter(Boolean);
}
if (dirty.length === 0 && committed.length === 0) {
  record('allow', 'nothing-changed');
  process.exit(0);
}

// 2. Dependencies. A worktree needs node_modules of its own: one symlinked from the main tree
// resolves workspace packages to the main tree's code, so the gate would test the wrong code.
// A fresh worktree has none; installing from the store takes a few seconds.
if (info.inWorktree && existsSync(join(info.top, 'package.json'))) {
  const linked = symlinkedModules(info.top);
  if (linked.length > 0) {
    fail(
      'install',
      `node_modules in this worktree is symlinked from the main tree (${linked.slice(0, 3).join(', ')}), so the gate would test the main tree's code. Remove each link with a plain \`rm <path>\` (no -r, no trailing slash), run \`pnpm install --frozen-lockfile --prefer-offline\`, then stop again.`,
      `THE GATE DID NOT TEST THIS WORKTREE'S CODE (symlinked node_modules) after ${MAX_STRIKES} attempts. Do not report the work as tested.`,
    );
  }
  if (!existsSync(join(info.top, 'node_modules'))) {
    const install =
      process.env.BRICKPLACE_INSTALL_CMD ?? 'pnpm install --frozen-lockfile --prefer-offline';
    const done = spawnSync(install, {
      cwd: info.top,
      shell: true,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
    });
    if (done.status !== 0) {
      const tail = `${done.stdout ?? ''}${done.stderr ?? ''}`.split('\n').slice(-30).join('\n');
      fail(
        'install',
        `\`${install}\` failed in ${info.top}:\n${tail}`,
        `DEPENDENCIES DID NOT INSTALL after ${MAX_STRIKES} attempts (\`${install}\`). Do not report this work as tested.`,
      );
    }
  }
}
strikes.install = 0;

// 3. Gate.
const gate = process.env.BRICKPLACE_GATE_CMD ?? 'pnpm verify';
const run = spawnSync(gate, {
  cwd: info.top,
  shell: true,
  encoding: 'utf8',
  timeout: 15 * 60 * 1000,
});
if (run.status !== 0) {
  const tail = `${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n').slice(-60).join('\n');
  fail(
    'gate',
    `\`${gate}\` failed in ${info.top}. Fix it before finishing:\n${tail}`,
    `GATES ARE STILL FAILING after ${MAX_STRIKES} attempts (\`${gate}\`). Do not report this work as done or tested; say which gate is red and what was tried.`,
  );
}
strikes.gate = 0;
save();
if (!info.inWorktree) {
  record('allow', 'gate-green-main-tree');
  process.exit(0);
}

// 4. Only committed work can land.
if (dirty.length > 0) {
  fail(
    'uncommitted',
    `Uncommitted changes in the worktree (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}). Commit them on this branch with \`git commit -s\`, then stop.`,
    `THE WORK IS NOT COMMITTED in ${info.top}. Do not report it as landed; tell the user which files are uncommitted.`,
  );
}

// 5. Review receipt for sensitive changes.
const headSha = git(info.top, 'rev-parse', 'HEAD');
const sensitive = committed.filter((f) => matches(REVIEW_PATHS, f));
if (sensitive.length > 0) {
  const receipt = `review-${headSha}.json`;
  const content = receiptFor(info.mainRoot, headSha, [join(info.top, '.claude', 'state')]);
  // The receipt must be for this exact commit and must say ship; "fix first" is not a pass.
  // It must also cover everything this branch brings onto the target, not just a tail of it.
  const unreviewed =
    content?.verdict === 'ship' && diffBase ? uncoveredChanges(info.top, diffBase, content) : [];
  if (content?.verdict !== 'ship' || unreviewed.length > 0) {
    const why = !content
      ? `Run the reviewer agent on \`git diff ${diffBase}...HEAD\`; it writes .claude/state/${receipt}.`
      : unreviewed.length > 0
        ? `The review of ${headSha} started at ${content.base}, so it did not see changes to ${unreviewed.slice(0, 3).join(', ')}. Review \`git diff ${diffBase}...HEAD\`.`
        : `The review of ${headSha} says "${content.verdict ?? 'no verdict'}". Fix what it found, commit, and review the new HEAD.`;
    fail(
      'review',
      `This branch changes sensitive files (${sensitive.slice(0, 5).join(', ')}). ${why}`,
      `NO PASSING INDEPENDENT REVIEW for ${headSha} after ${MAX_STRIKES} attempts. Do not report the change as reviewed.`,
    );
  }
}
strikes.uncommitted = 0;
strikes.review = 0;
save();

// 6. Land.
const branch = currentBranch(info.top);
if (!branch || branch === 'HEAD' || branch === target) process.exit(0);
if (!target) {
  record('allow', 'landing-needs-user', branch);
  tell(
    `Gates green. The work is committed on branch \`${branch}\` (${info.top}), but the main tree has no branch checked out to land it on.`,
  );
}
const merge = spawnSync('git', ['-C', info.mainRoot, 'merge', '--ff-only', branch], {
  encoding: 'utf8',
});
if (merge.status !== 0) {
  fail(
    'merge',
    `Fast-forward of ${branch} onto ${target} failed (main tree dirty, or ${target} moved). Rebase this branch onto ${target} and stop again.\n${merge.stderr ?? ''}`,
    `THE WORK IS NOT ON ${target}. Tell the user: git -C ${info.mainRoot} merge --ff-only ${branch}`,
  );
}
strikes.merge = 0;
save();
record('allow', 'merged', `${branch}->${target}`);
tell(
  guarded.has(target)
    ? `Gates green; ${branch} fast-forwarded onto ${target} locally. Not pushed: pushing ${target} triggers a deploy or a release, so that stays with the user.`
    : `Gates green; ${branch} fast-forwarded onto ${target}.`,
);
