// Fails a deploy when a Worker lacks a secret it cannot work without, such as the game's
// ITEM_DRAW_KEY (without it no item is ever drawn: draws fail closed, ADR 0012). Reads what
// `wrangler secret list --format json` prints: secret names and types, never their values.
// Usage (from the repository root, Cloudflare credentials in the environment):
//   pnpm exec wrangler secret list -c workers/game/wrangler.jsonc --env <env> --format json \
//     | pnpm exec tsx tools/ci/check-secrets.ts ITEM_DRAW_KEY
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The secret names in wrangler's JSON listing (`[{ "name": ..., "type": ... }]`). Anything
 * printed around the array (a banner, a warning) is skipped; output with no array throws, so
 * an unreadable listing fails the check instead of passing it.
 */
export function secretNames(output: string): string[] {
  // An array of objects, or an empty one: not wrangler's `✘ [ERROR]` marker.
  const start = output.search(/\[\s*[{\]]/);
  const end = output.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('no JSON array in the secret listing');
  const parsed: unknown = JSON.parse(output.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('the secret listing is not an array');
  return parsed.map((entry) => {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') throw new Error('a secret listing entry has no name');
    return name;
  });
}

/** The required names the listing lacks, in the order asked. */
export function missingSecrets(output: string, required: readonly string[]): string[] {
  const present = new Set(secretNames(output));
  return required.filter((name) => !present.has(name));
}

function main(): void {
  const required = process.argv.slice(2);
  if (required.length === 0) {
    console.error('usage: check-secrets.ts NAME [NAME...] < listing.json');
    process.exit(2);
  }
  let missing: string[];
  try {
    missing = missingSecrets(readFileSync(0, 'utf8'), required);
  } catch (error) {
    console.error(`::error::could not read the secret listing: ${(error as Error).message}`);
    process.exit(1);
  }
  if (missing.length > 0) {
    for (const name of missing) {
      console.error(
        `::error::secret ${name} is not set on this Worker; set it with ` +
          '`wrangler secret put` for this environment, then re-run the deploy',
      );
    }
    process.exit(1);
  }
  console.log(`all required secrets are set: ${required.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
