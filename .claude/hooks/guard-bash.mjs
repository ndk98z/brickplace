#!/usr/bin/env node
// PreToolUse(Bash): block commands that touch live Cloudflare resources, destroy local work,
// read local secrets or rewrite shared history. Deploys run in GitHub Actions only
// (.claude/skills/deploy). settings.json denies most of these by prefix; this catches them
// anywhere in a chain (`cd x && rm -rf y`, `pnpm --filter a exec wrangler deploy`).
//
// Reads the command through lib/shell.mjs: heredoc bodies written to files and quoted
// arguments are text, not commands, so a commit message that mentions `rm -rf` or
// `wrangler deploy` passes, while `bash <<EOF` still has its body checked.
//
// Exit 0 allows. Exit 2 blocks and shows stderr to Claude.

import { basename } from 'node:path';
import { block, guard, readInput } from './lib/repo.mjs';
import { gitCommand, head, interpreterCode, isDryRun, segments } from './lib/shell.mjs';

const RUNNERS = new Set(['pnpm', 'pnpx', 'npx', 'npm', 'bunx', 'yarn']);
const WRANGLER_VERBS = new Set([
  'deploy',
  'publish',
  'rollback',
  'delete',
  'secret',
  'versions',
  'triggers',
]);
const READERS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'cp',
  'mv',
  'source',
  '.',
  'grep',
  'sed',
  'awk',
  'bat',
]);
const SECRET_FILE = /^\.(dev\.vars|env)(\.(?!example\b)[a-z]+)?$/;
// File writes, moves and deletes through an interpreter's own API (Python, Node, Deno, Bun,
// Ruby, Perl, PHP). Printing to stdout is not here: a shell redirect is a write the other
// hooks can see.
const FILE_API = [
  // A mode argument that writes: open(p, 'w'), open(p, mode='a'), open(p, 'r+'), Path.open('w').
  /\bopen\s*\([^)]*?,\s*(mode\s*=\s*)?['"][rbt]*[wax+][bt+]*['"]/,
  /\.open\s*\(\s*(mode\s*=\s*)?['"][rbt]*[wax+][bt+]*['"]/,
  /\.(write_text|write_bytes|unlink|rename|rmdir|touch)(Sync)?\s*\(/,
  /\b(os|shutil)\.(copy\w*|move|replace|remove\w*|rmtree|truncate|makedirs|mkdir)\s*\(/,
  /\b(write|append)File(Sync)?\s*\(|\bcreateWriteStream\s*\(/,
  /\bopenSync\s*\([^)]*,\s*['"][wa]|\bwritev?Sync\s*\(/,
  /\.(copyFile|cp|rm|truncate)(Sync)?\s*\(/,
  /\bBun\.write\s*\(|\bDeno\.(write\w*|remove|rename|copyFile|truncate\w*)\s*\(/,
  /\b(File|IO)\.(write|binwrite|delete|rename)\b|\bFileUtils\./,
  /\bopen\s*\(?\s*(my\s+)?[\w$]+\s*,\s*['"]\+?>|\bunlink\s*[($]|\bunlink\s+['"]/,
  /\bfile_put_contents\s*\(|\bfopen\s*\([^)]*,\s*['"][wax]/,
];

const refuse = (reason) => block(`Blocked by .claude/hooks/guard-bash.mjs: ${reason}`);

guard('guard-bash.mjs', () => {
  const input = readInput();
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  if (interpreterCode(command).some((code) => FILE_API.some((api) => api.test(code)))) {
    refuse(
      'inline interpreter code that writes, moves or deletes files skips the edit hooks ' +
        '(worktree, plan, invariants, formatting). Use Edit/Write for files; for scratch ' +
        'output print to stdout and redirect to a literal path (`> /private/tmp/...`).',
    );
  }

  for (const { tokens } of segments(command)) {
    const { name, args, index } = head(tokens);
    const firstWord = tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));

    // wrangler, directly or through a package runner.
    const at = tokens.findIndex((t, i) => i >= index && basename(t) === 'wrangler');
    if (at !== -1 && (at === index || RUNNERS.has(name))) {
      const rest = tokens.slice(at + 1);
      const verb = rest.find((t) => WRANGLER_VERBS.has(t));
      if (verb && !(verb === 'deploy' && rest.includes('--dry-run'))) {
        refuse(
          verb === 'secret' || verb === 'versions'
            ? 'secrets and versions are managed by CI'
            : 'deploys and deletes run in GitHub Actions, not from a laptop (use the deploy skill)',
        );
      }
      if (rest.includes('--remote'))
        refuse('commands against remote Cloudflare resources need the owner');
    }

    if (name === 'rm') {
      const flags = args.filter((a) => a.startsWith('-') && !a.startsWith('--')).join('');
      const recursive = /r/i.test(flags) || args.includes('--recursive');
      const force = /f/.test(flags) || args.includes('--force');
      if (recursive && force)
        refuse('recursive force delete is not allowed; delete specific files, or ask the user');
    }

    if (name === 'git') {
      const { sub, rest } = gitCommand(args);
      if (sub === 'reset' && rest.includes('--hard'))
        refuse('git reset --hard destroys work; ask the user');
      if (sub === 'clean' && !isDryRun(rest)) {
        refuse('git clean deletes untracked files; ask the user');
      }
      if (sub === 'filter-branch' || sub === 'filter-repo')
        refuse('history rewrites need the user');
      // Work-discarding commands; the stash stack is shared by every worktree.
      const stashDiscard = sub === 'stash' && ['drop', 'clear'].includes(rest[0]);
      const checkoutDiscard = sub === 'checkout' && (rest.includes('--') || rest.includes('.'));
      if (stashDiscard || checkoutDiscard || sub === 'restore') {
        refuse(`git ${sub} ${rest[0] ?? ''} discards work; ask the user`.replace(/\s+;/, ';'));
      }
      const forceFlag = /^(--force(-with-lease|-if-includes)?(=.*)?|-[A-Za-z]*f[A-Za-z]*)$/;
      if (sub === 'push' && rest.some((a) => forceFlag.test(a) || /^\+/.test(a))) {
        refuse('force-push is not allowed');
      }
    }

    if (
      firstWord === 'sudo' ||
      ['killall', 'pkill', 'chown'].includes(name) ||
      (name === 'chmod' && args.includes('-R'))
    ) {
      refuse('system-level commands need the user');
    }

    // For cp/mv only the sources are read; creating .dev.vars from its example is fine.
    const read =
      name === 'cp' || name === 'mv' ? args.filter((a) => !a.startsWith('-')).slice(0, -1) : args;
    if (READERS.has(name) && read.some((a) => SECRET_FILE.test(basename(a)))) {
      refuse('.dev.vars and .env files hold secrets');
    }
  }
  process.exit(0);
});
