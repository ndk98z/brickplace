// Shared shell reading for hooks: split a Bash command into segments of tokens, find the files
// it would write, and tell whether its meaning depends on expansion.
//
// Deliberately syntactic. It cannot resolve `$VAR`, command substitution, `sh -c "..."` or a
// script file writing through its interpreter's API; inline code (`python3 -c`, a heredoc fed
// to `node`) is only handed to callers as text (interpreterCode). Callers fail closed where
// the text is not enough (a write target or push destination containing `$`). It closes the
// easy door, the one taken by accident; it is not a sandbox. Three rules keep it from blocking
// real work:
//   1. Heredoc bodies are dropped (they are text), unless the heredoc feeds a shell.
//   2. Quotes are honoured: an argument is never mistaken for syntax.
//   3. A command's rule fires only when that command heads its segment.

import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';

const SHELLS = /(^|[\s;&|(])((ba|z|da)?sh|node|python3?|perl|eval|xargs)(\s|$)/;

/** Removes heredoc bodies unless the heredoc is piped into a shell or interpreter. */
export function dropHeredocBodies(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const at = heredocStart(line);
    if (!at || SHELLS.test(line.slice(0, at.index))) continue;
    // Drop the body only when its terminator exists; otherwise keep every line so an
    // unterminated `<<` (or one inside a string we misread) cannot hide later commands.
    let end = i + 1;
    while (end < lines.length && lines[end].replace(/^\t+/, '') !== at.delimiter) end++;
    if (end < lines.length) i = end;
  }
  return out.join('\n');
}

/** First `<<WORD` outside quotes (not the `<<<` here-string): { index, delimiter }. */
function heredocStart(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === '\\') i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<' && line[i - 1] !== '<') {
      const match = line.slice(i + 2).match(/^-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (match) return { index: i, delimiter: match[2] };
    }
  }
  return null;
}

/**
 * Splits into segments on ; && || | & newlines, subshell parentheses and `{ }` groups, all
 * outside quotes. Each segment is { tokens, expands }: tokens have quotes removed, and
 * `expands` says whether `$` or a backtick appeared outside single quotes.
 */
export function segments(command) {
  const text = dropHeredocBodies(command);
  const result = [];
  let tokens = [];
  let token = null;
  let expands = false;
  let quote = null;
  const flushToken = () => {
    if (token !== null) tokens.push(token);
    token = null;
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length) result.push({ tokens, expands });
    tokens = [];
    expands = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === '\\' && next !== undefined) token += text[++i];
      else {
        if (quote === '"' && (c === '$' || c === '`')) expands = true;
        token += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      token ??= '';
      continue;
    }
    if (c === '\\' && next !== undefined) {
      token = (token ?? '') + next;
      i++;
      continue;
    }
    if (c === '$' || c === '`') expands = true;
    if (c === '\n' || c === ';' || c === '(' || c === ')') {
      flushSegment();
      continue;
    }
    if ((c === '{' || c === '}') && token === null && (next === undefined || /[\s;]/.test(next))) {
      flushSegment();
      continue;
    }
    if (c === '|') {
      if (next === '|') i++;
      flushSegment();
      continue;
    }
    if (c === '&') {
      if (next === '>') {
        flushToken();
        const double = text[i + 2] === '>';
        tokens.push(double ? '&>>' : '&>');
        i += double ? 2 : 1;
        continue;
      }
      if (next === '&') i++;
      flushSegment();
      continue;
    }
    if (c === '>' || c === '<') {
      const fd = token !== null && /^\d+$/.test(token) ? token : '';
      if (!fd) flushToken();
      else token = null;
      let op = fd + c;
      if (next === c) {
        op += c;
        i++;
      }
      if (text[i + 1] === '&') {
        op += '&';
        i++;
      }
      tokens.push(op);
      continue;
    }
    if (/\s/.test(c)) {
      flushToken();
      continue;
    }
    token = (token ?? '') + c;
  }
  flushSegment();
  return result;
}

const PREFIXES = new Set([
  'sudo',
  'env',
  'command',
  'nohup',
  'time',
  'exec',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
]);

/** The command a segment runs, skipping `VAR=value` assignments and wrappers like `env`. */
export function head(tokens) {
  let i = 0;
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (i < tokens.length && PREFIXES.has(tokens[i])) i++;
    else break;
  }
  return { name: tokens[i] ? basename(tokens[i]) : '', args: tokens.slice(i + 1), index: i };
}

const REDIRECT = /^(\d*[<>]{1,2}&?|&>>?)$/;
const WRITE_REDIRECT = /^(\d*>>?|&>>?)$/;
const GIT_WRITES = new Set([
  'checkout',
  'switch',
  'restore',
  'reset',
  'merge',
  'rebase',
  'pull',
  'cherry-pick',
  'revert',
  'am',
  'apply',
  'stash',
  'clean',
  'mv',
  'rm',
  // Moves a branch with no merge at all, `main` included.
  'update-ref',
  // Record whatever is staged as a new commit on the checked-out branch: in the main tree
  // that is landing unreviewed work on main.
  'commit',
  'read-tree',
  'update-index',
]);

/** `-n` / `--dry-run`, including combined short flags such as `-nd`. */
export const isDryRun = (args) =>
  args.some((a) => a === '--dry-run' || /^-[A-Za-z]*n[A-Za-z]*$/.test(a));

/**
 * Splits git's global options from its subcommand: { dir, sub, rest, opaque }. `opaque` is
 * true when --git-dir or --work-tree point git somewhere the cwd does not say; callers must
 * fail closed, because the repository and branch git will touch are not the ones in view.
 */
export function gitCommand(args) {
  let dir = '.';
  let opaque = false;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') dir = args[++i] ?? '.';
    else if (a === '--git-dir' || a === '--work-tree') {
      opaque = true;
      i++;
    } else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) opaque = true;
    else if (a === '-c' && /^core\.worktree=/i.test(args[i + 1] ?? '')) {
      opaque = true;
      i++;
    } else if (a === '--config-env' || a.startsWith('--config-env=')) {
      // Its value comes from the environment, so what it sets is not in the text.
      opaque = true;
      if (a === '--config-env') i++;
    } else if (['-c', '--namespace', '--exec-path'].includes(a)) i++;
    i++;
  }
  return { dir, sub: args[i] ?? '', rest: args.slice(i + 1), opaque };
}

/**
 * The ref of `git merge --ff-only <ref>` (optionally `-q`), or null for any other git command.
 * A fast-forward only moves the branch to commits that already exist, and git refuses it when
 * local changes are in the way; auto-worktree lets it land on the main tree once those commits
 * have passed review. Any other flag, several refs or an opaque work tree is not one.
 */
export function fastForwardRef(args) {
  const { sub, rest, opaque } = gitCommand(args);
  if (sub !== 'merge' || opaque || !rest.includes('--ff-only')) return null;
  const refs = rest.filter((a) => !['--ff-only', '-q', '--quiet'].includes(a));
  return refs.length === 1 && !refs[0].startsWith('-') ? refs[0] : null;
}

const branchName = (ref) => ref.replace(/^\+/, '').replace(/^refs\/heads\//, '');

/**
 * Branches a command moves without merging, from any worktree (branch refs are shared by all
 * of them): `update-ref`, `fetch` into a branch, `branch -f/-M/-C`, and checking out a branch
 * another worktree has. `*` means "cannot tell which". Callers refuse these for `main`.
 */
export function branchMoves(command) {
  const moves = [];
  for (const { tokens } of segments(command)) {
    const { name, args } = head(tokens);
    if (name !== 'git') continue;
    const { sub, rest } = gitCommand(args);
    const positional = rest.filter((a) => !a.startsWith('-'));
    if (sub === 'update-ref') {
      // Drop the value of -m <reason>; then the first operand is the ref. A HEAD symref
      // (HEAD, main-worktree/HEAD, worktrees/<name>/HEAD) moves whatever branch it points at.
      const operands = rest.filter(
        (a, i) => !a.startsWith('-') && !(i > 0 && rest[i - 1] === '-m'),
      );
      const ref = operands[0];
      if (rest.includes('--stdin') || !ref) moves.push('*');
      else if (/(^|\/)HEAD$/.test(ref) || /^(main-worktree|worktrees\/[^/]+)\//.test(ref)) {
        moves.push('*');
      } else moves.push(branchName(ref));
    } else if (sub === 'fetch' || sub === 'pull') {
      if (rest.includes('--update-head-ok') || rest.includes('-u')) moves.push('*');
      for (const spec of positional.slice(1)) {
        if (spec.includes(':')) moves.push(branchName(spec.split(':').at(-1)));
      }
    } else if (sub === 'branch') {
      const forced = rest.some((a) => ['-f', '--force'].includes(a));
      const renames = rest.some((a) => ['-C', '-M', '-m', '-c', '--move', '--copy'].includes(a));
      // A rename or copy touches both names (renaming main away frees the name); a forced
      // create moves the named branch.
      if (renames) moves.push(...positional.map(branchName));
      else if (forced && positional.length > 0) moves.push(branchName(positional[0]));
    } else if (
      (sub === 'checkout' || sub === 'switch') &&
      rest.includes('--ignore-other-worktrees')
    ) {
      moves.push('*');
    }
  }
  return moves;
}

/**
 * Files one segment writes, as written: { target, command, ffRef? }. `ffRef` marks a
 * fast-forward merge (see fastForwardRef) so callers can treat it apart from other writes.
 */
export function segmentWrites(tokens) {
  const writes = [];
  for (let i = 0; i < tokens.length; i++) {
    if (WRITE_REDIRECT.test(tokens[i]) && tokens[i + 1] !== undefined) {
      if (!tokens[i + 1].startsWith('/dev/')) writes.push(tokens[i + 1]);
      i++;
    }
  }
  const words = tokens.filter((t, i) => !REDIRECT.test(t) && !REDIRECT.test(tokens[i - 1] ?? ''));
  const { name, args, index } = head(words);
  // GIT_DIR=/GIT_WORK_TREE= before the command point git elsewhere just like the flags.
  const envOpaque = words
    .slice(0, index)
    .some((t) => /^GIT_(DIR|WORK_TREE|COMMON_DIR|CONFIG_PARAMETERS|CONFIG_COUNT)=/.test(t));
  const ffRef = name === 'git' && !envOpaque ? fastForwardRef(args) : null;
  const files = args.filter((a) => !a.startsWith('-'));
  const targetDir = args.indexOf('-t');
  switch (name) {
    case 'tee':
    case 'rm':
    case 'rmdir':
    case 'touch':
    case 'mkdir':
    case 'truncate':
      writes.push(...files);
      break;
    case 'cp':
    case 'mv':
    case 'install':
    case 'ln':
      if (targetDir !== -1 && args[targetDir + 1]) writes.push(args[targetDir + 1]);
      else if (files.length >= 2) writes.push(files.at(-1));
      break;
    case 'sed':
      if (args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')) {
        writes.push(...files.slice(args.includes('-e') ? 0 : 1));
      }
      break;
    case 'perl':
    case 'ruby':
      if (args.some((a) => /^-\w*i/.test(a)))
        writes.push(...files.slice(args.includes('-e') ? 1 : 0));
      break;
    case 'dd':
      for (const a of args) if (a.startsWith('of=')) writes.push(a.slice(3));
      break;
    case 'git': {
      const { dir, sub, rest, opaque } = gitCommand(args);
      const readOnlyStash = sub === 'stash' && ['list', 'show'].includes(rest[0]);
      const dryClean = sub === 'clean' && isDryRun(rest);
      // An opaque work tree is reported as an expanded target, so callers fail closed.
      if (GIT_WRITES.has(sub) && !readOnlyStash && !dryClean) {
        writes.push(opaque || envOpaque ? '$GIT_WORK_TREE' : dir);
      }
      break;
    }
  }
  // Only the git work tree is the fast-forward; a redirect in the same segment is a plain write.
  const last = writes.length - 1;
  return writes.map((target, i) => ({
    target,
    command: name,
    ...(ffRef && name === 'git' && i === last ? { ffRef } : {}),
  }));
}

/**
 * Every write a command makes: { path, raw, command, ffRef? }, following `cd` between segments.
 * `raw` is the target as written; when it contains `$` or a backtick the path is a guess and
 * callers should fail closed.
 */
export function bashWrites(command, cwd) {
  let dir = cwd;
  // Once a `cd` target cannot be read (`cd "$X"`, `popd`), every later relative write is
  // reported as expanded so callers fail closed instead of guessing the directory.
  let dirKnown = true;
  const writes = [];
  for (const { tokens } of segments(command)) {
    const { name, args } = head(tokens);
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const target = args.find((a) => !a.startsWith('-'));
      if (name === 'popd' || (target && expands(target)) || target === '-') dirKnown = false;
      else if (!target || target === '~') dir = homedir();
      else if (target.startsWith('~/')) dir = resolve(homedir(), target.slice(2));
      else dir = resolve(dir, target);
      continue;
    }
    for (const { target, command: cmd, ffRef } of segmentWrites(tokens)) {
      const absolute = isAbsolute(target) || target.startsWith('~');
      const home =
        target === '~' || target.startsWith('~/') ? resolve(homedir(), target.slice(2)) : null;
      const ff = ffRef ? { ffRef } : {};
      if (!dirKnown && !absolute) {
        writes.push({ path: null, raw: `$PWD/${target}`, command: cmd, ...ff });
      } else {
        writes.push({ path: home ?? resolve(dir, target), raw: target, command: cmd, ...ff });
      }
    }
  }
  return writes;
}

/** Resolved write targets; unknown ones (after an unreadable `cd`) are left out. */
export const bashWriteTargets = (command, cwd) =>
  bashWrites(command, cwd)
    .map((w) => w.path)
    .filter((p) => p !== null);

const INTERPRETER = /^(python[0-9.]*|node(js)?|tsx|deno|bun|ruby|perl|php)$/;
const INTERPRETER_WORD =
  /(^|[\s;&|(])(\S*\/)?(python[0-9.]*|node(js)?|tsx|deno|bun|ruby|perl|php)(\s|$)/;
// Commands that run another command from their arguments (`pnpm exec node -e`, `uv run python`).
const RUNNERS = new Set([
  'pnpm',
  'pnpx',
  'npm',
  'npx',
  'bunx',
  'yarn',
  'uv',
  'xargs',
  'timeout',
  'nice',
]);
// Flags that make the next argument code (`-c`, `-e`, `-pe`, `--eval`, `deno eval`).
const INLINE = /^(-[A-Za-z]*[ceEpr]|--eval|--print|eval)$|^--(eval|print)=/;
// An argument naming a script: before any inline flag, the rest are that script's arguments.
const SCRIPT = /\/|\.(py|[cm]?[jt]s|rb|pl|php)$/;

// A short flag with its code attached: `-c"open(...)"` reaches us as `-copen(...)`.
const attached = (a) => /^-[A-Za-z]/.test(a) && /[^\w=.,:/-]/.test(a);
// Every reading of where the flag ends (`-pe'File...'` is `-pe` + code, `-c'...'` is `-c`).
function split(a) {
  const letters = a.match(/^-[A-Za-z]*/)[0];
  const readings = [];
  for (let i = 1; i < letters.length; i++) {
    if ('ceEpr'.includes(letters[i])) readings.push(`${a.slice(0, i + 1)} ${a.slice(i + 1)}`);
  }
  return readings.join(' ');
}

/**
 * The code an interpreter's arguments carry, or null when they run a script instead. A flag
 * value (`-W ignore`, `--import tsx`) is not a script, so a later `-c`/`-e` is still read.
 */
function inlineCode(args) {
  const at = args.findIndex((a) => INLINE.test(a) || attached(a));
  if (at === -1) return null;
  const script = args.findIndex((a) => !a.startsWith('-') && SCRIPT.test(a));
  if (script !== -1 && script < at) return null;
  return args.map((a) => (attached(a) ? split(a) : a)).join(' ');
}

/**
 * Code an interpreter runs from the command text itself: the arguments of a segment headed by
 * one (`python3 -c ...`, `node -e ...`) or by a runner that starts one (`pnpm exec node -e`),
 * and heredoc bodies on a line that names one outside quotes (`python3 - <<EOF`,
 * `cat <<EOF | node`). A script run by path is not seen.
 */
export function interpreterCode(command) {
  const code = [];
  for (const { tokens } of segments(command)) {
    const { name, args } = head(tokens);
    if (INTERPRETER.test(name)) code.push(inlineCode(args) ?? '');
    else if (RUNNERS.has(name)) {
      for (let at = 0; at < args.length; at++) {
        if (INTERPRETER.test(basename(args[at]))) code.push(inlineCode(args.slice(at + 1)) ?? '');
      }
    }
  }
  const lines = command.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const at = heredocStart(lines[i]);
    if (!at) continue;
    const unquoted = lines[i].replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '');
    const feeds = INTERPRETER_WORD.test(unquoted);
    let end = i + 1;
    while (end < lines.length && lines[end].replace(/^\t+/, '') !== at.delimiter) end++;
    if (feeds) code.push(lines.slice(i + 1, end).join('\n'));
    // A text heredoc's body is skipped too, so an example inside it is not read as code.
    if (feeds || end < lines.length) i = end;
  }
  return code;
}

/** True when a raw target's value depends on expansion. */
export const expands = (raw) => /[$`]/.test(raw);

/** The part of a raw target before its first expansion. */
export const literalPrefix = (raw) => raw.split(/[$`]/)[0];
