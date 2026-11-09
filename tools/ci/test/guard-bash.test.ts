import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The PreToolUse guard is the only thing stopping an agent from deploying or reading
// secrets from a laptop, so every bypass anyone finds becomes a case here.
const hook = join(import.meta.dirname, '..', '..', '..', '.claude', 'hooks', 'guard-bash.mjs');

const ALLOW = 0;
const BLOCK = 2;

const cases: [command: string, expected: number][] = [
  ['pnpm verify', ALLOW],
  ['pnpm --filter @brickplace/game test', ALLOW],
  ['wrangler deploy --dry-run --outdir dist', ALLOW],
  ['wrangler types --include-env=false', ALLOW],
  ['wrangler dev -c workers/gateway/wrangler.jsonc', ALLOW],
  ['git push origin main', ALLOW],
  ['git push -u origin main', ALLOW],
  ['git status --short', ALLOW],
  ['git commit -s -m "docs: explain the deploy flow"', ALLOW],
  ['cp workers/gateway/.dev.vars.example workers/gateway/.dev.vars', ALLOW],
  [
    'cat > a.md <<EOF\nthe hook blocks `wrangler deploy`.\nwrangler deploy --env production\nEOF',
    ALLOW,
  ],

  ['pnpm exec wrangler deploy --env production', BLOCK],
  ['cd workers/game && wrangler deploy', BLOCK],
  ['wrangler deploy --dry-run && wrangler deploy', BLOCK],
  ['pnpm --filter @brickplace/game exec wrangler deploy --env production', BLOCK],
  ['CLOUDFLARE_ENV=x wrangler deploy', BLOCK],
  ['npm exec wrangler deploy', BLOCK],
  ['pnpm dlx wrangler deploy', BLOCK],
  ['pnpm -C workers/game exec wrangler deploy', BLOCK],
  ['./node_modules/.bin/wrangler deploy', BLOCK],
  ['wrangler triggers deploy', BLOCK],
  ['pnpm --filter x exec wrangler secret put KEY', BLOCK],
  ['npx wrangler secret put X', BLOCK],
  ['echo hi && wrangler versions upload', BLOCK],
  ['wrangler d1 execute DB --remote --command "select 1"', BLOCK],
  ['git push --force origin main', BLOCK],
  ['git push -f', BLOCK],
  ['git push origin +main', BLOCK],
  ['cat workers/gateway/.dev.vars', BLOCK],
  ['grep KEY .env', BLOCK],
  ["cat > b.md <<'EOF'\nwrangler secret put X\nEOF\nwrangler deploy", BLOCK],
  ['bash <<EOF\nwrangler deploy\nEOF', BLOCK],

  // Irreversible local commands, anywhere in a chain, but only when they are the command.
  ['rm -rf dist', BLOCK],
  ['rm -Rf foo', BLOCK],
  ['cd x && rm -R -f foo', BLOCK],
  ['rm --recursive --force foo', BLOCK],
  ['rm foo.txt', ALLOW],
  ['git reset --hard HEAD~1', BLOCK],
  ['git clean -fd', BLOCK],
  ['git clean -nd', ALLOW],
  ['git filter-branch --all', BLOCK],
  ['sudo ls', BLOCK],
  ['chmod -R 777 .', BLOCK],
  ['git commit -m "block rm -rf in chains"', ALLOW],
  ['git commit -m "fix wrangler deploy docs"', ALLOW],
  ['printf \'{"note":"run sudo later"}\'', ALLOW],
  ['git push --force-with-lease origin w1', BLOCK],
  ['git push --force-with-lease=w1 origin w1', BLOCK],
  ['git push -fu origin w1', BLOCK],
  ['git push -uf origin w1', BLOCK],
  ['git push -u origin w1', ALLOW],
  ['git status && git restore .', BLOCK],
  ['git status && git stash drop', BLOCK],
  ['git stash clear', BLOCK],
  ['git checkout -- src/a.ts', BLOCK],
  ['git checkout .', BLOCK],
  ['git checkout -b feature', ALLOW],
  ['git stash list', ALLOW],

  // Files written through an interpreter's own API skip every edit hook.
  ["python3 -c \"open('packages/core/src/a.ts', 'w').write(x)\"", BLOCK],
  ["python3 -c \"import pathlib; pathlib.Path('a.md').write_text('x')\"", BLOCK],
  ['python3 - <<\'EOF\'\nwith open("a.ts", "w") as f:\n    f.write("x")\nEOF', BLOCK],
  ['cat <<EOF | python3\nimport shutil\nshutil.copy("a", "b")\nEOF', BLOCK],
  ['/usr/bin/python3.12 -c "import os; os.remove(\'a\')"', BLOCK],
  ["node -e \"require('fs').writeFileSync('a.ts', s)\"", BLOCK],
  ['node -e "fs.rmSync(\'dist\', {recursive: true})"', BLOCK],
  ['cd x && node --eval "fs.appendFileSync(\'a\', s)"', BLOCK],
  ["node <<'EOF'\nconst fs = require('node:fs');\nfs.writeFileSync('a.ts', 'x');\nEOF", BLOCK],
  ['bun -e "await Bun.write(\'a\', s)"', BLOCK],
  ['deno eval "Deno.writeTextFileSync(\'a\', s)"', BLOCK],
  ['ruby -e "File.write(\'a\', s)"', BLOCK],
  ['perl -e \'open(my $fh, ">", "a") or die\'', BLOCK],
  ["php -r \"file_put_contents('a', 'x');\"", BLOCK],
  ["node -e \"require('fs').renameSync('a', 'b')\"", BLOCK],
  ["node -e \"require('fs').unlinkSync('a')\"", BLOCK],
  ["node -e \"require('fs').rmdirSync('a')\"", BLOCK],
  ["node -e \"const fs = require('fs'); fs.writeSync(fs.openSync('a', 'w'), 'x')\"", BLOCK],
  ["python3 -c \"f = open('data.txt', 'r+'); f.write('1')\"", BLOCK],
  ["python3 -c \"import pathlib; pathlib.Path('a').open('w').write('x')\"", BLOCK],
  ['python3 -c "open(p, mode=\'a\').write(x)"', BLOCK],
  ["pnpm exec node -e \"require('fs').writeFileSync('a', 'x')\"", BLOCK],
  ["pnpm --filter x exec tsx -e \"require('fs').writeFileSync('a', 'x')\"", BLOCK],
  ["npx tsx -e \"require('fs').writeFileSync('a', 'x')\"", BLOCK],
  ["uv run python -c \"open('a', 'w')\"", BLOCK],
  ["echo x | xargs node -e \"require('fs').writeFileSync('a', 'x')\"", BLOCK],
  ["timeout 5 node -e \"require('fs').writeFileSync('a', 'x')\"", BLOCK],
  ['perl -e \'unlink "a"\'', BLOCK],
  ['python3 -c "import json; print(json.load(open(\'a.json\')))"', ALLOW],
  ['python3 -c "print(open(\'a\').read())"', ALLOW],
  ["python3 -c \"print(open('a.bin', 'rb').read(4))\"", ALLOW],
  ["node -e \"const fs = require('fs'); console.log(fs.readSync(fs.openSync('a', 'r')))\"", ALLOW],
  [
    "node -e \"console.log(Object.keys(require('fs')).filter((k) => k.includes('unlink')))\"",
    ALLOW,
  ],
  ["php -r \"echo fread(fopen('assets.json', 'r'), 10);\"", ALLOW],
  ['pnpm exec vitest run', ALLOW],
  ["npm exec -- tsx -e \"require('fs').writeFileSync('a', 'x')\"", BLOCK],
  ["node --input-type=module -e \"import fs from 'node:fs'; fs.rmSync('a')\"", BLOCK],
  ["python3 -c\"open('a', 'w').write('x')\"", BLOCK],
  ["python3 -I -c \"open('a', 'w')\"", BLOCK],
  ["node --import tsx -e \"require('fs').writeFileSync('a', 'x')\"", BLOCK],
  ["python3 -W ignore -c \"open('a.ts', 'w')\"", BLOCK],
  ["ruby -I lib -e \"File.write('a', 'x')\"", BLOCK],
  ["node --eval=\"require('fs').writeFileSync('a', 'x')\"", BLOCK],
  ['ruby -pe\'File.write("a", $_)\'', BLOCK],
  ['node tools/gen.mjs -e --label "writeFile(x)"', ALLOW],
  ['pnpm exec node tools/gen.mjs --label "writeFile(x)"', ALLOW],
  ['node tools/gen.mjs --label "writeFile(x)"', ALLOW],
  ['printf x | xargs grep -l python "open(p, \'w\')"', ALLOW],
  ['pnpm exec vitest run -t python "open(p, \'w\')"', ALLOW],
  ['python3 -m json.tool a.json', ALLOW],
  [
    "git commit -s -F - <<'EOF'\nfix: refuse python3 - <<PY writes\n\nopen(p, 'w') in the body is caught.\nPY\nEOF",
    ALLOW,
  ],
  [
    "cat > /private/tmp/notes.md <<'EOF'\nExample:\n  python3 - <<'PY'\n  open('a', 'w').write('x')\n  PY\nEOF",
    ALLOW,
  ],
  [
    "gh issue create --title \"fix node crash\" --body-file - <<'EOF'\nfs.writeFileSync('a', x) fails\nEOF",
    ALLOW,
  ],
  ['python3 -c "print(1)" > /private/tmp/out.txt', ALLOW],
  ['node -e "console.log(require(\'./package.json\').version)"', ALLOW],
  ['node tools/sim/run.mjs --out /private/tmp/sim.json', ALLOW],
  ['git commit -m "refuse open(path, \'w\') in python3 -c"', ALLOW],
  ["git commit -F - <<'EOF'\nnode -e writeFileSync is refused\nEOF", ALLOW],
  ["cat > notes.md <<'EOF'\npython3 -c \"open('a', 'w')\"\nEOF", ALLOW],
];

describe('guard-bash hook', () => {
  it.each(cases)('%j exits %i', (command, expected) => {
    const result = spawnSync('node', [hook], {
      input: JSON.stringify({ tool_input: { command } }),
    });
    expect(result.status).toBe(expected);
  });
});
