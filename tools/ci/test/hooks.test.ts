import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Every hook runs against a throwaway repository with one session worktree, the same layout
// EnterWorktree produces. A guard without a test is a guard nobody knows is still alive.
const repo = join(import.meta.dirname, '..', '..', '..');
const hooks = join(repo, '.claude', 'hooks');
const ALLOW = 0;
const BLOCK = 2;
// Built from parts so this file does not trip the very rules it tests.
const VIETNAMESE = 'xin chào';
const BANNED = `tetr${'omino'}`;

let root: string;
let wt: string;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function run(hook: string, input: object, env: Record<string, string> = {}) {
  const result = spawnSync('node', [join(hooks, hook)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const write = (file: string, content = 'x', cwd = root) =>
  run('auto-worktree.mjs', { tool_name: 'Write', cwd, tool_input: { file_path: file, content } })
    .status;
const bash = (hook: string, command: string, cwd = root, session = 's') =>
  run(hook, { tool_name: 'Bash', cwd, session_id: session, tool_input: { command } }).status;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bp-hooks-')));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, '.gitignore'), '.claude/state/\n.claude/worktrees/\n');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'init');
  mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
  wt = join(root, '.claude', 'worktrees', 'w1');
  sh(root, 'worktree', 'add', '-q', wt, '-b', 'w1');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('settings.json', () => {
  it('points every hook at a file that exists', () => {
    const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
    const commands: string[] = Object.values(
      settings.hooks as Record<string, { hooks: { command: string }[] }[]>,
    )
      .flat()
      .flatMap((group) => group.hooks.map((h) => h.command));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const file = command.match(/\.claude\/hooks\/[\w.-]+/)?.[0];
      expect(file, command).toBeDefined();
      expect(() => readFileSync(join(repo, file!)), file).not.toThrow();
    }
  });
});

describe('format-edited', () => {
  it('formats a file in the tree it lives in, worktree included', () => {
    const probe = join(repo, 'tools', 'ci', '.format-probe.json');
    writeFileSync(probe, '{"a":1}');
    try {
      const result = spawnSync(join(hooks, 'format-edited.sh'), {
        input: JSON.stringify({ tool_input: { file_path: probe } }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(ALLOW);
      expect(readFileSync(probe, 'utf8')).toBe('{ "a": 1 }\n');
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

describe('auto-worktree', () => {
  it('blocks edits in the main tree and allows them in a worktree', () => {
    expect(write(join(root, 'README.md'))).toBe(BLOCK);
    expect(write(join(wt, 'README.md'), 'x', wt)).toBe(ALLOW);
  });

  it('exempts session state, build output and paths outside the repo', () => {
    expect(write(join(root, '.claude', 'state', 'plan-s.md'))).toBe(ALLOW);
    expect(write(join(root, 'packages', 'x', 'node_modules', 'y.js'))).toBe(ALLOW);
    expect(write(join(tmpdir(), 'elsewhere.txt'))).toBe(ALLOW);
  });

  it('sees shell writes but not shell reads', () => {
    expect(bash('auto-worktree.mjs', 'echo hi > a.txt')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'cat > notes.md <<EOF\nhello\nEOF')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', "sed -i '' s/a/b/ README.md")).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'cp README.md copy.md')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'echo hi > a.txt', wt)).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'cd .claude/worktrees/w1 && echo x > a.txt')).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', "grep -rn 'tee -a' .")).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'pnpm verify 2>&1 | tail -5')).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'echo x > /dev/null')).toBe(ALLOW);
  });

  it('catches writes the first version missed', () => {
    expect(bash('auto-worktree.mjs', 'echo x > "$CLAUDE_PROJECT_DIR/README.md"', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', `(cd ${root} && echo x > README.md)`, wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', `git -C ${root} checkout -- README.md`, wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'perl -pi -e s/a/b/ README.md')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'ruby -pi -e \'gsub(/a/, "b")\' README.md')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'cp -t docs README.md')).toBe(BLOCK);
  });

  it('catches writes the second review found', () => {
    // A quoted `<<EOF` or a `<<<` here-string must not hide the commands after it.
    expect(bash('auto-worktree.mjs', "grep -n '<<EOF' notes.md\necho x > README.md")).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'tr a b <<< hello\necho x > README.md')).toBe(BLOCK);
    // `cd` into a place the text does not name makes later relative writes unreadable.
    expect(
      bash('auto-worktree.mjs', 'cd "$CLAUDE_PROJECT_DIR" && sed -i s/a/b/ README.md', wt),
    ).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'cd $PWD && echo y >> notes.txt', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', `git --work-tree=${root} checkout -- .`, wt)).toBe(BLOCK);
    // A real heredoc body is still text.
    expect(bash('auto-worktree.mjs', 'cat > notes.md <<EOF\necho x > README.md\nEOF', wt)).toBe(
      ALLOW,
    );
  });

  it('still allows read-only git and the reviewer receipt', () => {
    expect(bash('auto-worktree.mjs', 'git status --short')).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'git stash list')).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'git clean -nd')).toBe(ALLOW);
    // A commit in the main tree lands whatever is staged on main without review.
    expect(bash('auto-worktree.mjs', 'git commit -m "x"')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', `git -C ${root} commit -m "x"`, wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', `git -C ${root} read-tree w1`, wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git update-index --add README.md')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git commit -s -m "x"', wt)).toBe(ALLOW);
    // Landing reviewed work: a fast-forward is the one tree-moving git command allowed here.
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w1')).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'git merge -q --ff-only w1')).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', `git -C ${root} merge --ff-only w1`, wt)).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'git merge w1')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git merge --ff-only --no-verify w1')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w1 w2')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', `git --work-tree=${root} merge --ff-only w1`, wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', `GIT_WORK_TREE=${root} git merge --ff-only w1`, wt)).toBe(
      BLOCK,
    );
    expect(bash('auto-worktree.mjs', `git -c core.worktree=${root} checkout .`, wt)).toBe(BLOCK);
    expect(
      bash(
        'auto-worktree.mjs',
        `printf '{}' > ".claude/state/review-$(git rev-parse HEAD).json"`,
        wt,
      ),
    ).toBe(ALLOW);
  });

  it('lands a fast-forward of sensitive changes only with a ship receipt', () => {
    const w5 = join(root, '.claude', 'worktrees', 'w5');
    sh(root, 'worktree', 'add', '-q', w5, '-b', 'w5');
    const file = join(w5, 'packages', 'core', 'src', 'ff.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export const ff = 1;\n');
    sh(w5, 'add', '.');
    sh(w5, 'commit', '-q', '-m', 'ff rule');
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w5')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git merge --ff-only no-such-branch')).toBe(BLOCK);
    // An exempt subdirectory is still the main tree's work tree.
    mkdirSync(join(root, '.claude', 'state'), { recursive: true });
    expect(bash('auto-worktree.mjs', 'git -C .claude/state merge --ff-only w5')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'cd .claude/state && git merge --ff-only w5')).toBe(BLOCK);
    const head = sh(w5, 'rev-parse', 'HEAD');
    const state = join(w5, '.claude', 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, `review-${head}.json`),
      JSON.stringify({ head, verdict: 'fix first' }),
    );
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w5')).toBe(BLOCK);
    // A receipt without a valid base covers nothing.
    writeFileSync(join(state, `review-${head}.json`), JSON.stringify({ head, verdict: 'ship' }));
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w5')).toBe(BLOCK);
    const ship = (base: string) =>
      writeFileSync(
        join(state, `review-${head}.json`),
        JSON.stringify({ head, base, verdict: 'ship' }),
      );
    ship('not-a-commit');
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w5')).toBe(BLOCK);
    ship(sh(root, 'merge-base', 'main', head));
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w5')).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', `git -C ${root} merge --ff-only w5`, wt)).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', `cd ${root} && git merge --ff-only w5`, wt)).toBe(ALLOW);
    // The receipt covers the merge, not a redirect riding along with it.
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w5 > packages/core/src/x.ts')).toBe(
      BLOCK,
    );
    // Anything else in the same command could move the ref after the check.
    expect(bash('auto-worktree.mjs', 'git branch -f w5 w6 && git merge --ff-only w5')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w5 && echo done')).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git update-ref refs/heads/main w5')).toBe(BLOCK);
    // Branch refs are shared by every worktree: moving main from one is moving main.
    expect(bash('auto-worktree.mjs', 'git update-ref refs/heads/main w5', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git update-ref main w5', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git update-ref --stdin', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git fetch --update-head-ok . w5:main', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git fetch . w5:refs/heads/main', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git branch -f main w5', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git branch -M w5 main', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git switch --ignore-other-worktrees main', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git update-ref -m why refs/heads/main w5', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git update-ref main-worktree/HEAD w5', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git update-ref HEAD w5', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git branch -m main old', wt)).toBe(BLOCK);
    // develop deploys staging: protected by name, whatever origin/HEAD says.
    expect(bash('auto-worktree.mjs', 'git update-ref refs/heads/develop w5', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git branch -f develop w5', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git fetch . w5:develop', wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git branch -m scratch scratch2', wt)).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'git update-ref refs/heads/w1 HEAD', wt)).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'git branch -f scratch HEAD', wt)).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', 'git fetch origin', wt)).toBe(ALLOW);
    expect(bash('auto-worktree.mjs', `GIT_COMMON_DIR=${root}/.git git checkout .`, wt)).toBe(BLOCK);
    expect(bash('auto-worktree.mjs', 'git --config-env=core.worktree=WT checkout .', wt)).toBe(
      BLOCK,
    );
  }, 90_000); // dozens of hook runs, each a node process with several git calls

  it('refuses a fast-forward whose receipt does not cover all it brings in', () => {
    const w9 = join(root, '.claude', 'worktrees', 'w9');
    sh(root, 'worktree', 'add', '-q', w9, '-b', 'w9');
    const write = (name: string) => {
      const file = join(w9, 'packages', 'core', 'src', name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `export const ${name.replace('.ts', '')} = 1;\n`);
      sh(w9, 'add', '.');
      sh(w9, 'commit', '-q', '-m', name);
      return sh(w9, 'rev-parse', 'HEAD');
    };
    const first = write('early.ts');
    const head = write('late.ts');
    const state = join(w9, '.claude', 'state');
    mkdirSync(state, { recursive: true });
    const receipt = (base: string) =>
      writeFileSync(
        join(state, `review-${head}.json`),
        JSON.stringify({ head, base, verdict: 'ship' }),
      );
    receipt(first);
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w9')).toBe(BLOCK);
    receipt(sh(root, 'merge-base', 'main', head));
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w9')).toBe(ALLOW);
  });
});

describe('require-plan', () => {
  const edit = (file: string, session: string) =>
    run('require-plan.mjs', {
      tool_name: 'Write',
      cwd: wt,
      session_id: session,
      tool_input: { file_path: file, content: 'x' },
    }).status;

  it('asks for a plan before the first sensitive edit, and only then', () => {
    const core = join(wt, 'packages', 'core', 'src', 'a.ts');
    expect(edit(core, 'p1')).toBe(BLOCK);
    expect(edit(join(wt, 'README.md'), 'p1')).toBe(ALLOW);
    expect(edit(join(wt, '.claude', 'state', 'plan-p1.md'), 'p1')).toBe(ALLOW);
    mkdirSync(join(wt, '.claude', 'state'), { recursive: true });
    writeFileSync(
      join(wt, '.claude', 'state', 'plan-p1.md'),
      'change\nnear rule\nverify by test\n',
    );
    expect(edit(core, 'p1')).toBe(ALLOW);
  });

  it('does not accept a one-line plan', () => {
    writeFileSync(join(wt, '.claude', 'state', 'plan-p2.md'), 'just this\n');
    expect(edit(join(wt, '.claude', 'hooks', 'x.mjs'), 'p2')).toBe(BLOCK);
  });

  it('treats D1 migrations as sensitive (the audit log stays append-only through them)', () => {
    const migration = join(wt, 'workers', 'admin', 'migrations', '0002_x.sql');
    expect(edit(migration, 'p3')).toBe(BLOCK);
  });
});

describe('check-invariants', () => {
  const put = (rel: string, content: string) =>
    run('check-invariants.mjs', {
      tool_name: 'Write',
      cwd: wt,
      tool_input: { file_path: join(wt, rel), content },
    }).status;

  it('keeps the core deterministic', () => {
    expect(put('packages/core/src/a.ts', 'const t = Date.now();')).toBe(BLOCK);
    expect(put('packages/protocol/src/a.ts', 'const r = Math.random();')).toBe(BLOCK);
    expect(put('packages/core/src/a.ts', 'export const x = 1;')).toBe(ALLOW);
    const multi = run('check-invariants.mjs', {
      tool_name: 'MultiEdit',
      cwd: wt,
      tool_input: {
        file_path: join(wt, 'packages/core/src/a.ts'),
        edits: [{ old_string: 'a', new_string: 'performance.now()' }],
      },
    });
    expect(multi.status).toBe(BLOCK);
  });

  it('keeps the gateway locked and secrets out of wrangler.jsonc', () => {
    expect(put('workers/gateway/wrangler.jsonc', '"vars": { "ENVIRONMENT": "dev" }')).toBe(BLOCK);
    expect(put('workers/gateway/wrangler.jsonc', '"vars": { "ENVIRONMENT": "locked" }')).toBe(
      ALLOW,
    );
    // The admin Worker skips Cloudflare Access in dev (ADR 0022).
    expect(put('workers/admin/wrangler.jsonc', '"vars": { "ENVIRONMENT": "dev" }')).toBe(BLOCK);
    expect(put('workers/admin/wrangler.jsonc', '"vars": { "ENVIRONMENT": "staging" }')).toBe(ALLOW);
    expect(put('workers/game/wrangler.jsonc', '"vars": { "SESSION_SIGNING_KEY": "abc" }')).toBe(
      BLOCK,
    );
  });

  it('keeps code in English and free of banned names, but not docs', () => {
    expect(put('apps/client/src/a.ts', `const s = "${VIETNAMESE}";`)).toBe(BLOCK);
    expect(put('apps/client/src/a.ts', `const ${BANNED} = 1;`)).toBe(BLOCK);
    expect(put('docs/notes.md', VIETNAMESE)).toBe(ALLOW);
  });

  it('refuses shell writes to files whose content it must read', () => {
    expect(bash('check-invariants.mjs', "sed -i '' s/a/b/ packages/core/src/a.ts", wt)).toBe(BLOCK);
    expect(bash('check-invariants.mjs', 'echo x > notes.txt', wt)).toBe(ALLOW);
  });

  it('treats a shell write into the src directory itself as a write to its files', () => {
    expect(bash('check-invariants.mjs', 'cp -t packages/core/src evil.ts', wt)).toBe(BLOCK);
    expect(bash('check-invariants.mjs', 'cp evil.ts packages/core/src/', wt)).toBe(BLOCK);
  });

  it('lets content-free shell commands through', () => {
    expect(bash('check-invariants.mjs', 'rm packages/core/src/a.ts', wt)).toBe(ALLOW);
    expect(bash('check-invariants.mjs', 'mkdir -p packages/core/src/sub', wt)).toBe(ALLOW);
  });

  it('fails closed on malformed input instead of crashing open', () => {
    const result = run('check-invariants.mjs', {
      tool_name: 'Write',
      cwd: wt,
      tool_input: {
        file_path: join(wt, 'packages/core/src/a.ts'),
        edits: 'not-a-list',
        content: 'Date.now()',
      },
    });
    expect(result.status).toBe(BLOCK);
  });
});

describe('guard-push', () => {
  it('refuses every way of reaching the default branch', () => {
    for (const command of [
      'git push',
      'git push origin main',
      'git push origin HEAD:main',
      'git push origin +w1:refs/heads/main',
      'git push origin :main',
      'git push --all origin',
      'git push origin $BRANCH',
      'echo ok && git push origin main',
      '(git push origin main)',
      '{ git push origin main; }',
      'if true; then git push origin main; fi',
      '! git push origin main',
      'git --git-dir .git push origin main',
      'git --work-tree . push origin main',
      'git push origin @',
      'git --git-dir=./.git push origin HEAD',
      'git --work-tree . push',
    ]) {
      expect(bash('guard-push.mjs', command), command).toBe(BLOCK);
    }
  });

  it('keeps main protected even when origin/HEAD points elsewhere', () => {
    sh(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    try {
      expect(bash('guard-push.mjs', 'git push origin main')).toBe(BLOCK);
      expect(bash('guard-push.mjs', 'git push origin develop')).toBe(BLOCK);
    } finally {
      sh(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    }
  });

  it('keeps develop protected without origin/HEAD, since pushing it deploys staging', () => {
    expect(bash('guard-push.mjs', 'git push origin develop')).toBe(BLOCK);
    expect(bash('guard-push.mjs', 'git push origin HEAD:develop')).toBe(BLOCK);
    expect(bash('guard-push.mjs', 'git push origin w1:refs/heads/develop')).toBe(BLOCK);
  });

  it('allows other branches and dry runs', () => {
    expect(bash('guard-push.mjs', 'git push --dry-run origin main')).toBe(ALLOW);
    expect(bash('guard-push.mjs', 'git push origin w1')).toBe(ALLOW);
    expect(bash('guard-push.mjs', 'git push -u origin feature')).toBe(ALLOW);
    expect(bash('guard-push.mjs', 'git push', wt)).toBe(ALLOW);
    expect(bash('guard-push.mjs', 'git push origin HEAD', wt)).toBe(ALLOW);
    expect(bash('guard-push.mjs', 'git -C .claude/worktrees/w1 push')).toBe(ALLOW);
  });
});

describe('verify-before-stop', () => {
  const stop = (cwd: string, session: string, gate = 'true', install = 'true') =>
    run(
      'verify-before-stop.mjs',
      { cwd, session_id: session },
      { BRICKPLACE_GATE_CMD: gate, BRICKPLACE_INSTALL_CMD: install },
    );

  it('lets a clean tree stop', () => {
    expect(stop(root, 'clean').status).toBe(ALLOW);
  });

  it('requires committed work, then fast-forwards main locally without pushing', () => {
    writeFileSync(join(wt, 'feature.txt'), 'x\n');
    expect(stop(wt, 'land').status).toBe(BLOCK);
    sh(wt, 'add', 'feature.txt');
    sh(wt, 'commit', '-q', '-m', 'feature');
    const result = stop(wt, 'land');
    expect(result.status).toBe(ALLOW);
    expect(result.stdout).toContain('fast-forwarded onto main locally. Not pushed');
    expect(sh(root, 'log', '--oneline', 'main')).toContain('feature');
  });

  it('blocks a red gate, then releases loudly on the third strike', () => {
    // w1 already landed on main above; an uncommitted file gives the gate something to check.
    writeFileSync(join(wt, 'pending.txt'), 'x\n');
    expect(stop(wt, 'red', 'false').status).toBe(BLOCK);
    expect(stop(wt, 'red', 'false').status).toBe(BLOCK);
    const third = stop(wt, 'red', 'false');
    expect(third.status).toBe(ALLOW);
    expect(third.stdout).toContain('GATES ARE STILL FAILING');
    // After a release the count starts over: the next red gate blocks again.
    expect(stop(wt, 'red', 'false').status).toBe(BLOCK);
  });

  it('survives a corrupt strike file', () => {
    mkdirSync(join(root, '.claude', 'state'), { recursive: true });
    writeFileSync(join(root, '.claude', 'state', 'stop-corrupt.json'), '{not json');
    expect(stop(wt, 'corrupt', 'false').status).toBe(BLOCK);
  });

  it('needs a passing review receipt for this exact commit', () => {
    const file = join(wt, 'packages', 'core', 'src', 'rule.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export const rule = 1;\n');
    sh(wt, 'add', '.');
    sh(wt, 'commit', '-q', '-m', 'rule');
    expect(stop(wt, 'review').status).toBe(BLOCK);
    expect(sh(root, 'log', '--oneline', 'main')).not.toContain('rule');
    const head = sh(wt, 'rev-parse', 'HEAD');
    const receipt = join(wt, '.claude', 'state', `review-${head}.json`);
    writeFileSync(receipt, JSON.stringify({ head, verdict: 'fix first' }));
    expect(stop(wt, 'review2').status).toBe(BLOCK);
    writeFileSync(receipt, JSON.stringify({ head: 'someothersha', verdict: 'ship' }));
    expect(stop(wt, 'review3').status).toBe(BLOCK);
    // Without a base the receipt covers nothing.
    writeFileSync(receipt, JSON.stringify({ head, verdict: 'ship' }));
    expect(stop(wt, 'review4').status).toBe(BLOCK);
    const base = sh(root, 'merge-base', 'main', head);
    writeFileSync(receipt, JSON.stringify({ head, base, verdict: 'ship' }));
    expect(stop(wt, 'review5').status).toBe(ALLOW);
    expect(sh(root, 'log', '--oneline', 'main')).toContain('rule');
  });

  it('refuses to land when the receipt starts after unreviewed sensitive commits', () => {
    const w10 = join(root, '.claude', 'worktrees', 'w10');
    sh(root, 'worktree', 'add', '-q', w10, '-b', 'w10');
    const commit = (name: string) => {
      const file = join(w10, 'packages', 'core', 'src', name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'export {};\n');
      sh(w10, 'add', '.');
      sh(w10, 'commit', '-q', '-m', name);
      return sh(w10, 'rev-parse', 'HEAD');
    };
    const first = commit('hidden.ts');
    const head = commit('shown.ts');
    const receipt = join(w10, '.claude', 'state', `review-${head}.json`);
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(receipt, JSON.stringify({ head, base: first, verdict: 'ship' }));
    const result = stop(w10, 'partial');
    expect(result.status).toBe(BLOCK);
    expect(result.stderr).toContain('hidden.ts');
    expect(sh(root, 'log', '--oneline', 'main')).not.toContain('hidden.ts');
    const base = sh(root, 'merge-base', 'main', head);
    writeFileSync(receipt, JSON.stringify({ head, base, verdict: 'ship' }));
    expect(stop(w10, 'whole').status).toBe(ALLOW);
    expect(sh(root, 'log', '--oneline', 'main')).toContain('hidden.ts');
  });

  it('still runs the gate with a detached main tree, and lands nothing', () => {
    const branch = sh(root, 'branch', '--show-current');
    const before = sh(root, 'rev-parse', branch);
    sh(root, 'checkout', '-q', '--detach');
    try {
      const w14 = join(root, '.claude', 'worktrees', 'w14');
      sh(root, 'worktree', 'add', '-q', w14, '-b', 'w14');
      writeFileSync(join(w14, 'detached.txt'), 'x\n');
      sh(w14, 'add', '.');
      sh(w14, 'commit', '-q', '-m', 'while detached');
      expect(stop(w14, 'detached-red', 'false').status).toBe(BLOCK);
      const green = stop(w14, 'detached-green');
      expect(green.status).toBe(ALLOW);
      expect(green.stdout).toContain('no branch checked out');
      expect(sh(root, 'rev-parse', branch)).toBe(before);
      // The review check runs too, measured against the main tree's commit.
      const mainCommit = sh(root, 'rev-parse', 'HEAD');
      const file = join(w14, 'packages', 'core', 'src', 'detached.ts');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'export {};\n');
      sh(w14, 'add', '.');
      sh(w14, 'commit', '-q', '-m', 'core change while detached');
      const head = sh(w14, 'rev-parse', 'HEAD');
      const unreviewed = stop(w14, 'detached-review');
      expect(unreviewed.status).toBe(BLOCK);
      expect(unreviewed.stderr).not.toContain('null');
      const receipt = join(w14, '.claude', 'state', `review-${head}.json`);
      mkdirSync(dirname(receipt), { recursive: true });
      writeFileSync(receipt, JSON.stringify({ head, base: head, verdict: 'ship' }));
      expect(stop(w14, 'detached-partial').status).toBe(BLOCK);
      writeFileSync(receipt, JSON.stringify({ head, base: mainCommit, verdict: 'ship' }));
      expect(stop(w14, 'detached-whole').status).toBe(ALLOW);
      expect(sh(root, 'rev-parse', branch)).toBe(before);
    } finally {
      sh(root, 'checkout', '-q', branch);
    }
  });

  it('still sees a sensitive file that a rename moves away', () => {
    mkdirSync(join(root, 'packages', 'core', 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'src', 'moved.ts'), 'export const moved = 1;\n');
    sh(root, 'add', '.');
    sh(root, 'commit', '-q', '-m', 'core file to move');
    const w12 = join(root, '.claude', 'worktrees', 'w12');
    sh(root, 'worktree', 'add', '-q', w12, '-b', 'w12');
    mkdirSync(join(w12, 'elsewhere'), { recursive: true });
    sh(w12, 'mv', 'packages/core/src/moved.ts', 'elsewhere/moved.ts');
    sh(w12, 'commit', '-q', '-m', 'move it out');
    const result = stop(w12, 'rename');
    expect(result.status).toBe(BLOCK);
    expect(result.stderr).toContain('packages/core/src/moved.ts');
    expect(sh(root, 'log', '--oneline', 'main')).not.toContain('move it out');
    // A hand-run fast-forward of the same branch is refused too.
    expect(bash('auto-worktree.mjs', 'git merge --ff-only w12')).toBe(BLOCK);
  });

  it('needs a review for a package test script', () => {
    const w13 = join(root, '.claude', 'worktrees', 'w13');
    sh(root, 'worktree', 'add', '-q', w13, '-b', 'w13');
    mkdirSync(join(w13, 'packages', 'core'), { recursive: true });
    writeFileSync(join(w13, 'packages', 'core', 'package.json'), '{"scripts":{"test":"true"}}\n');
    sh(w13, 'add', '.');
    sh(w13, 'commit', '-q', '-m', 'skip core tests');
    expect(stop(w13, 'pkg').status).toBe(BLOCK);
    expect(sh(root, 'log', '--oneline', 'main')).not.toContain('skip core tests');
  });

  it('needs a review for a vite config that doubles as the test config', () => {
    const w15 = join(root, '.claude', 'worktrees', 'w15');
    sh(root, 'worktree', 'add', '-q', w15, '-b', 'w15');
    mkdirSync(join(w15, 'apps', 'client'), { recursive: true });
    writeFileSync(join(w15, 'apps', 'client', 'vite.config.ts'), 'export default {};\n');
    sh(w15, 'add', '.');
    sh(w15, 'commit', '-q', '-m', 'drop client tests');
    expect(stop(w15, 'vite').status).toBe(BLOCK);
    expect(sh(root, 'log', '--oneline', 'main')).not.toContain('drop client tests');
  });

  it('needs a review for the gate definition too', () => {
    const w11 = join(root, '.claude', 'worktrees', 'w11');
    sh(root, 'worktree', 'add', '-q', w11, '-b', 'w11');
    writeFileSync(join(w11, 'turbo.json'), '{}\n');
    sh(w11, 'add', '.');
    sh(w11, 'commit', '-q', '-m', 'weaker gate');
    expect(stop(w11, 'gate-def').status).toBe(BLOCK);
    expect(sh(root, 'log', '--oneline', 'main')).not.toContain('weaker gate');
  });

  it('needs a review for the secret scanner config', () => {
    for (const [name, file] of [
      ['w16', '.gitleaks.toml'],
      ['w17', '.gitleaksignore'],
    ] as const) {
      const wt = join(root, '.claude', 'worktrees', name);
      sh(root, 'worktree', 'add', '-q', wt, '-b', name);
      writeFileSync(join(wt, file), '[allowlist]\nregexes = [".*"]\n');
      sh(wt, 'add', '.');
      sh(wt, 'commit', '-q', '-m', `open the secrets gate in ${file}`);
      const result = stop(wt, `gitleaks-${name}`);
      expect(result.status, file).toBe(BLOCK);
      expect(result.stderr, file).toContain(file);
      expect(sh(root, 'log', '--oneline', 'main')).not.toContain(
        `open the secrets gate in ${file}`,
      );
    }
  });

  it('treats a harness change as needing review, so it cannot land itself', () => {
    const w8 = join(root, '.claude', 'worktrees', 'w8');
    sh(root, 'worktree', 'add', '-q', w8, '-b', 'w8');
    const file = join(w8, '.claude', 'hooks', 'weaker.mjs');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'process.exit(0);\n');
    sh(w8, 'add', '.');
    sh(w8, 'commit', '-q', '-m', 'weaker hook');
    const result = stop(w8, 'harness');
    expect(result.status).toBe(BLOCK);
    expect(result.stderr).toContain('.claude/hooks/weaker.mjs');
    expect(sh(root, 'log', '--oneline', 'main')).not.toContain('weaker hook');
  });

  it('releases an unreviewed branch loudly without landing it', () => {
    const w6 = join(root, '.claude', 'worktrees', 'w6');
    sh(root, 'worktree', 'add', '-q', w6, '-b', 'w6');
    const file = join(w6, 'packages', 'core', 'src', 'unreviewed.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export const unreviewed = 1;\n');
    sh(w6, 'add', '.');
    sh(w6, 'commit', '-q', '-m', 'unreviewed rule');
    expect(stop(w6, 'rv').status).toBe(BLOCK);
    expect(stop(w6, 'rv').status).toBe(BLOCK);
    const third = stop(w6, 'rv');
    expect(third.status).toBe(ALLOW);
    expect(third.stdout).toContain('NO PASSING INDEPENDENT REVIEW');
    expect(sh(root, 'log', '--oneline', 'main')).not.toContain('unreviewed rule');
  });

  it('refuses symlinked node_modules and reports a failed install', () => {
    const w7 = join(root, '.claude', 'worktrees', 'w7');
    sh(root, 'worktree', 'add', '-q', w7, '-b', 'w7');
    writeFileSync(join(w7, 'package.json'), '{}\n');
    sh(w7, 'add', '.');
    sh(w7, 'commit', '-q', '-m', 'package');
    symlinkSync(root, join(w7, 'node_modules'));
    const linked = stop(w7, 'deps');
    expect(linked.status).toBe(BLOCK);
    expect(linked.stderr).toContain('symlinked from the main tree');
    rmSync(join(w7, 'node_modules'));
    const broken = stop(w7, 'deps2', 'true', 'echo boom >&2; false');
    expect(broken.status).toBe(BLOCK);
    expect(broken.stderr).toContain('boom');
    // A working install lets the stop go on to the gate and, package.json being part of the
    // gate's definition, to the review check and the landing.
    const head = sh(w7, 'rev-parse', 'HEAD');
    const receipt = join(w7, '.claude', 'state', `review-${head}.json`);
    mkdirSync(dirname(receipt), { recursive: true });
    const base = sh(root, 'merge-base', 'main', head);
    writeFileSync(receipt, JSON.stringify({ head, base, verdict: 'ship' }));
    expect(stop(w7, 'deps3').status).toBe(ALLOW);
    rmSync(join(root, 'package.json'));
    sh(root, 'commit', '-q', '-am', 'drop package.json again');
  });

  it('still calls main protected when origin/HEAD points elsewhere', () => {
    sh(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    try {
      const w3 = join(root, '.claude', 'worktrees', 'w3');
      sh(root, 'worktree', 'add', '-q', w3, '-b', 'w3');
      writeFileSync(join(w3, 'other.txt'), 'x\n');
      sh(w3, 'add', '.');
      sh(w3, 'commit', '-q', '-m', 'lands locally');
      const result = stop(w3, 'origin-head');
      expect(result.status).toBe(ALLOW);
      expect(result.stdout).toContain('Not pushed');
      expect(sh(root, 'log', '--oneline', 'main')).toContain('lands locally');
    } finally {
      sh(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    }
  });

  it('fast-forwards onto a non-default target branch', () => {
    sh(root, 'checkout', '-q', '-b', 'dev');
    const w2 = join(root, '.claude', 'worktrees', 'w2');
    sh(root, 'worktree', 'add', '-q', w2, '-b', 'w2');
    writeFileSync(join(w2, 'docs.txt'), 'x\n');
    sh(w2, 'add', '.');
    sh(w2, 'commit', '-q', '-m', 'docs on dev');
    const result = stop(w2, 'ff');
    expect(result.status).toBe(ALLOW);
    expect(sh(root, 'log', '--oneline', 'dev')).toContain('docs on dev');
  });
});
