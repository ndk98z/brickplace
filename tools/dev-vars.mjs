// Creates each Worker's local .dev.vars from its .dev.vars.example the first time
// `pnpm dev` runs. Never overwrites or reads an existing .dev.vars.
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

for (const dir of readdirSync('workers')) {
  const example = join('workers', dir, '.dev.vars.example');
  const target = join('workers', dir, '.dev.vars');
  if (existsSync(example) && !existsSync(target)) {
    copyFileSync(example, target);
    console.log(`created ${target} from .dev.vars.example`);
  }
}
