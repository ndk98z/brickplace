#!/usr/bin/env node
// PreToolUse(Bash): `git push` is allowed, except when it would update a protected branch.
//
// A push to `develop` runs deploy.yml (staging) and one to `main` runs release.yml; a push of
// any other branch only runs CI. So the line sits where the consequence is. A deny rule cannot
// express that, because "updates main" is not a command prefix: `git push` with main checked out,
// `git push origin HEAD:main`, `+x:refs/heads/main`, `@`, `--all`, and the same inside
// `( )`, `{ }`, `if` or after `!` all reach it. This reads the command the way git would:
// global options, refspecs, the branch checked out where it runs and its push destination.
// Protected = develop, main, master and origin/HEAD's branch (lib/repo.mjs protectedBranches).
//
// Fails closed: a push whose remote or refspec comes from `$VAR` or command substitution is
// refused, because its destination is not in the text. `--dry-run` is always allowed. Aliases,
// scripts and `gh api` writing refs walk past it; server-side branch protection is the real lock.
//
// Exit 0 allows. Exit 2 blocks and asks the agent to hand the push to the user.

import { resolve } from 'node:path';
import {
  block,
  currentBranch,
  git,
  guard,
  log,
  protectedBranches,
  readInput,
  treeInfo,
} from './lib/repo.mjs';
import { gitCommand, head, segments } from './lib/shell.mjs';

const normal = (ref) =>
  ref
    .replace(/^\+/, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '');

guard('guard-push.mjs', () => {
  const input = readInput();
  const command = input?.tool_input?.command;
  if (input?.tool_name !== 'Bash' || typeof command !== 'string') process.exit(0);
  const baseCwd = input.cwd || process.cwd();

  const refuse = (reason, message) => {
    log(treeInfo(baseCwd)?.commonDir, {
      hook: 'guard-push',
      session: input.session_id,
      tool: 'Bash',
      decision: 'block',
      target: command.slice(0, 120),
      reason,
    });
    block(
      `Blocked by .claude/hooks/guard-push.mjs (${reason}): ${message}\n` +
        'Pushing other branches is fine. Hand pushes to protected branches to the user.',
    );
  };

  for (const segment of segments(command)) {
    const { name, args } = head(segment.tokens);
    if (name !== 'git') continue;
    const { dir, sub, rest, opaque } = gitCommand(args);
    if (sub !== 'push') continue;
    const cwd = resolve(baseCwd, dir);
    if (rest.includes('--dry-run') || rest.includes('-n')) continue;
    if (opaque) {
      refuse(
        'unreadable',
        '--git-dir/--work-tree point git at a repository whose checked-out branch is not the one in view.',
      );
    }
    if (segment.expands) {
      refuse(
        'unreadable',
        'the push destination comes from an expansion, so it cannot be shown to be safe.',
      );
    }
    if (rest.some((a) => a === '--all' || a === '--mirror')) {
      refuse('all-branches', '--all/--mirror would update protected branches too.');
    }

    const positional = [];
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j];
      if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(a)) j++;
      else if (!a.startsWith('-')) positional.push(a);
    }
    const guarded = protectedBranches(cwd);
    const branch = currentBranch(cwd);
    const refspecs = positional.slice(1);

    if (refspecs.length === 0) {
      const upstream = branch
        ? git(cwd, 'for-each-ref', '--format=%(push:short)', `refs/heads/${branch}`)
        : '';
      const upstreamBranch = upstream?.includes('/')
        ? upstream.slice(upstream.indexOf('/') + 1)
        : '';
      if (guarded.has(branch) || guarded.has(upstreamBranch)) {
        refuse(
          'protected-branch',
          `\`${segment.tokens.join(' ')}\` pushes ${branch}, which lands on a protected branch.`,
        );
      }
      continue;
    }
    for (const spec of refspecs) {
      const colon = spec.indexOf(':');
      let dst = normal(colon === -1 ? spec : spec.slice(colon + 1));
      if (dst === 'HEAD' || dst === '@') dst = branch ?? 'HEAD';
      if (guarded.has(dst) || dst === 'HEAD') {
        refuse('protected-branch', `refspec \`${spec}\` updates ${dst}.`);
      }
    }
  }
  process.exit(0);
});
