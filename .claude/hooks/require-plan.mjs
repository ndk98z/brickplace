#!/usr/bin/env node
// PreToolUse: the first edit to sensitive code in a session must follow a written plan.
//
// The loop is explore → plan → implement → verify → review → land. Without this gate nothing
// stops a session from rewriting the game rules or a deploy workflow from its first tool call,
// and a typo fix and a rule change travel the same road. It fires only on the paths in
// lib/sensitive-paths.mjs (PLAN_PATHS), never on the rest of the repo: a gate that fires on
// everything gets switched off.
//
// A plan is `.claude/state/plan-<session id>.md` with at least three non-empty lines: what
// changes, which rule or invariant it is near, how it will be verified. `.claude/state/` is
// gitignored, so the plan never makes a worktree dirty. Writing three junk lines passes; like
// every hook here this guards against accident, not intent.
//
// Exit 0 allows. Exit 2 blocks and tells the agent what to do.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  block,
  guard,
  isExempt,
  log,
  readInput,
  realPath,
  rootFor,
  treeInfo,
} from './lib/repo.mjs';
import { matches, PLAN_PATHS } from './lib/sensitive-paths.mjs';
import { bashWriteTargets } from './lib/shell.mjs';

guard('require-plan.mjs', () => {
  const input = readInput();
  if (!input?.tool_input) process.exit(0);
  const cwd = input.cwd || process.cwd();
  const info = treeInfo(cwd);
  if (!info) process.exit(0);

  const tool = input.tool_name;
  const ti = input.tool_input;
  const targets =
    tool === 'Bash'
      ? bashWriteTargets(String(ti.command ?? ''), cwd)
      : [ti.file_path ?? ti.notebook_path].filter(Boolean).map(String);

  const session = input.session_id ?? 'unknown';
  const hasPlan = (root) => {
    const file = join(root, '.claude', 'state', `plan-${session}.md`);
    if (!existsSync(file)) return false;
    return (
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim()).length >= 3
    );
  };

  for (const raw of targets) {
    const path = realPath(raw);
    if (isExempt(path, info.mainRoot)) continue;
    const root = rootFor(path, info.mainRoot);
    const rel = relative(root, path);
    if (!matches(PLAN_PATHS, rel)) continue;
    if (hasPlan(root) || hasPlan(info.top) || hasPlan(info.mainRoot)) continue;
    log(info.commonDir, {
      hook: 'require-plan',
      session,
      tool,
      decision: 'block',
      target: rel,
      reason: 'plan-missing',
    });
    block(
      `Blocked by .claude/hooks/require-plan.mjs: ${rel} is sensitive and this session has no plan.\n` +
        `Write ${join(relative(cwd, root) || '.', '.claude', 'state', `plan-${session}.md`)} first ` +
        '(at least 3 lines: what changes, which rule or invariant it touches, how you will verify it), ' +
        'then retry the edit.',
    );
  }
  process.exit(0);
});
