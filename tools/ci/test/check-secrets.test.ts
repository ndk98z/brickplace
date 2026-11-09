import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { missingSecrets, secretNames } from '../check-secrets.ts';

const LISTING = JSON.stringify([
  { name: 'ITEM_DRAW_KEY', type: 'secret_text' },
  { name: 'OTHER', type: 'secret_text' },
]);

describe('secretNames', () => {
  it('reads the names from wrangler JSON, skipping text around it', () => {
    expect(secretNames(LISTING)).toEqual(['ITEM_DRAW_KEY', 'OTHER']);
    expect(secretNames(` ⛅️ wrangler 4\n${LISTING}\n`)).toEqual(['ITEM_DRAW_KEY', 'OTHER']);
    expect(secretNames('[]')).toEqual([]);
  });

  it('throws on output it cannot read, so the check fails rather than passes', () => {
    expect(() => secretNames('')).toThrow(/no JSON array/);
    expect(() => secretNames('✘ [ERROR] This Worker does not exist')).toThrow(/no JSON array/);
    expect(() => secretNames('[{"type":"secret_text"}]')).toThrow(/no name/);
  });
});

describe('missingSecrets', () => {
  it('names the required secrets the listing lacks', () => {
    expect(missingSecrets(LISTING, ['ITEM_DRAW_KEY'])).toEqual([]);
    expect(missingSecrets('[]', ['ITEM_DRAW_KEY'])).toEqual(['ITEM_DRAW_KEY']);
    expect(missingSecrets(LISTING, ['ITEM_DRAW_KEY', 'SESSION_KEYS'])).toEqual(['SESSION_KEYS']);
  });
});

describe('check-secrets CLI', () => {
  const script = fileURLToPath(new URL('../check-secrets.ts', import.meta.url));
  const run = (input: string, ...names: string[]) => {
    try {
      const out = execFileSync(process.execPath, ['--experimental-strip-types', script, ...names], {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (error) {
      const e = error as { status: number; stderr: string };
      return { code: e.status, out: e.stderr };
    }
  };

  it('passes when every name is set, and fails naming each missing one', () => {
    expect(run(LISTING, 'ITEM_DRAW_KEY').code).toBe(0);
    const failed = run('[]', 'ITEM_DRAW_KEY');
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('::error::secret ITEM_DRAW_KEY is not set');
    expect(run('not json', 'ITEM_DRAW_KEY').code).toBe(1);
    expect(run(LISTING).code).toBe(2);
  });
});
