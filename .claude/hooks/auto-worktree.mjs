#!/usr/bin/env node
// PreToolUse: blocks file changes in the main working tree; work happens in a worktree.
//
// Edits made straight on the checked-out branch skip every barrier the harness puts between a
// change and `main`: no branch to review, no gate before merge. EnterWorktree (built into
// Claude Code) moves the session to `.claude/worktrees/<name>` on its own branch; the Stop hook
// runs the gates there and fast-forwards the branch back. `git merge --ff-only <ref>` is the one
// write allowed in the main tree: it only moves the branch to commits that already exist, and
// only when the commits it brings in that touch REVIEW_PATHS have a "ship" review receipt.
//
// Covers Edit, Write, MultiEdit, NotebookEdit and Bash commands that write files (`>`, `tee`,
// `sed -i`, `perl -i`, `cp`, `mv`, `rm`, git commands that rewrite the working tree, ...).
// Session state (.claude/state/), build output and anything outside the repo are exempt.
// A shell target that depends on `$VAR` or a backtick is refused unless the literal part
// before the expansion is already exempt: its real destination is not in the text.
//
// Exit 0 allows. Exit 2 blocks and tells the agent what to do.

import { join, relative, resolve } from 'node:path';
import { receiptFor, sensitiveChanges, uncoveredChanges } from './lib/receipts.mjs';
import {
  block,
  currentBranch,
  git,
  guard,
  isExempt,
  isInside,
  log,
  protectedBranches,
  readInput,
  realPath,
  treeInfo,
} from './lib/repo.mjs';
import { bashWrites, branchMoves, expands, head, literalPrefix, segments } from './lib/shell.mjs';

guard('auto-worktree.mjs', () => {
  const input = readInput();
  if (!input?.tool_input) process.exit(0);
  const cwd = input.cwd || process.cwd();
  const info = treeInfo(cwd);
  if (!info) process.exit(0);

  const tool = input.tool_name;
  const ti = input.tool_input;
  const writes =
    tool === 'Bash'
      ? bashWrites(String(ti.command ?? ''), cwd)
      : [ti.file_path ?? ti.notebook_path]
          .filter(Boolean)
          .map((p) => ({ path: String(p), raw: String(p) }));

  const worktrees = join(info.mainRoot, '.claude', 'worktrees');
  const refuse = (rel, reason, message) => {
    log(info.commonDir, {
      hook: 'auto-worktree',
      session: input.session_id,
      tool,
      decision: 'block',
      target: rel,
      reason,
    });
    block(`Blocked by .claude/hooks/auto-worktree.mjs: ${message}`);
  };

  // A fast-forward may land on the main tree once the commits it brings in have passed review:
  // the same rule the Stop hook applies before it lands a branch itself.
  const landing = (ref) => {
    const sha = git(info.mainRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    if (!sha) return `\`${ref}\` is not a commit in this repository.`;
    const target = currentBranch(info.mainRoot);
    if (!target || target === 'HEAD') return 'the main tree has no branch checked out.';
    const sensitive = sensitiveChanges(info.mainRoot, target, sha);
    if (sensitive.length === 0) return null;
    const receipt = receiptFor(info.mainRoot, sha);
    const unreviewed =
      receipt?.verdict === 'ship' ? uncoveredChanges(info.mainRoot, target, receipt) : [];
    if (receipt?.verdict === 'ship' && unreviewed.length === 0) return null;
    if (receipt?.verdict === 'ship') {
      return `${ref} (${sha.slice(0, 12)}) was reviewed from ${String(receipt.base ?? 'an unknown base').slice(0, 12)}, but it also brings in unreviewed changes to ${unreviewed.slice(0, 3).join(', ')}.`;
    }
    return (
      `${ref} (${sha.slice(0, 12)}) changes sensitive files (${sensitive.slice(0, 3).join(', ')}) ` +
      `and ${receipt ? `its review says "${receipt.verdict ?? 'no verdict'}"` : 'has no review receipt'}. ` +
      'Run the reviewer agent on it first; it writes .claude/state/review-<sha>.json.'
    );
  };

  // Branch refs are shared by every worktree, so `git update-ref refs/heads/main <sha>` run in
  // a session worktree moves main as surely as a merge in the main tree: refuse it anywhere.
  if (tool === 'Bash') {
    const guarded = protectedBranches(info.mainRoot);
    const mainBranch = currentBranch(info.mainRoot);
    if (mainBranch && mainBranch !== 'HEAD') guarded.add(mainBranch);
    for (const moved of branchMoves(String(ti.command ?? ''))) {
      if (moved === '*' || guarded.has(moved)) {
        refuse(
          moved,
          'protected-branch-move',
          `this command may move ${moved === '*' ? 'a protected branch' : `\`${moved}\``} without a review. Land work with \`git merge --ff-only <branch>\` in the main tree, or let the Stop hook land it.`,
        );
      }
    }
  }

  // The ref is resolved now, before the command runs: anything else in the same command
  // (`git branch -f x <other> && git merge --ff-only x`) could move it after the check.
  const steps =
    tool === 'Bash'
      ? segments(String(ti.command ?? '')).filter(
          ({ tokens }) => !['cd', 'pushd', 'popd'].includes(head(tokens).name),
        )
      : [];

  for (const { path: raw, raw: written, command: cmd, ffRef } of writes) {
    if (expands(written)) {
      const prefix = literalPrefix(written);
      if (prefix && isExempt(realPath(resolve(cwd, prefix)), info.mainRoot)) continue;
      refuse(
        written,
        'unreadable-target',
        `the write target \`${written}\` depends on an expansion, so it cannot be shown to be outside the main tree. Write it with a literal path.`,
      );
    }
    // A git command rewrites the work tree it runs in, wherever inside it the -C/cd directory
    // points: judge the repository root, not the directory (`git -C .claude/state ...`).
    const top = cmd === 'git' ? git(realPath(raw), 'rev-parse', '--show-toplevel') : null;
    const path = top ? realPath(top) : realPath(raw);
    if (isExempt(path, info.mainRoot)) continue;
    if (isInside(path, worktrees) && path !== worktrees) continue;
    const rel = relative(info.mainRoot, path) || '.';
    if (ffRef) {
      if (steps.length > 1) {
        refuse(
          rel,
          'ff-not-alone',
          'a fast-forward of the main tree must be the only command: run `git merge --ff-only <ref>` on its own.',
        );
      }
      const why = landing(ffRef);
      if (!why) continue;
      refuse(rel, 'unreviewed-landing', `fast-forwarding the main tree to ${why}`);
    }
    refuse(
      rel,
      'main-tree-edit',
      `${rel} is in the main working tree.\nCall the EnterWorktree tool first, then make the change inside the worktree. ` +
        'The Stop hook verifies and lands it; see CLAUDE.md "Harness".',
    );
  }
  process.exit(0);
});
