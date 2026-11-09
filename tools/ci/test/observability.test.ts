import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../check-do-lifecycle.ts';

// Observability, workers_dev and preview_urls are inheritable in wrangler: an env block that
// sets one replaces the top-level value whole. So an env that sets `observability` without
// `issues` would turn Issues off there with no other signal (docs/ops/alerts.md).
const root = join(import.meta.dirname, '..', '..', '..');
const SCRIPTS = ['admin', 'game', 'gateway', 'realtime'];
// Reached only through Durable Object bindings.
const BINDING_ONLY = new Set(['game', 'realtime']);

type Config = Record<string, unknown> & { env?: Record<string, Record<string, unknown>> };

function resolved(config: Config): [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = [['top level', config]];
  for (const [name, env] of Object.entries(config.env ?? {})) {
    const merged: Record<string, unknown> = { ...env };
    for (const key of ['observability', 'workers_dev', 'preview_urls']) {
      if (!(key in env)) merged[key] = config[key];
    }
    out.push([`env.${name}`, merged]);
  }
  return out;
}

describe('worker observability', () => {
  for (const script of SCRIPTS) {
    const config = parseJsonc(
      readFileSync(join(root, 'workers', script, 'wrangler.jsonc'), 'utf8'),
    ) as Config;
    for (const [where, env] of resolved(config)) {
      it(`${script} ${where}: logs unsampled, Issues on`, () => {
        const o = env.observability as {
          enabled?: boolean;
          issues?: { enabled?: boolean };
          logs?: { enabled?: boolean; head_sampling_rate?: number; persist?: boolean };
          head_sampling_rate?: number;
        };
        expect(o?.enabled).toBe(true);
        expect(o.issues?.enabled).toBe(true);
        // Alerts count events, so a sampled or unpersisted log loses them.
        expect(o.head_sampling_rate ?? 1).toBe(1);
        expect(o.logs?.enabled ?? true).toBe(true);
        expect(o.logs?.head_sampling_rate ?? 1).toBe(1);
        expect(o.logs?.persist ?? true).toBe(true);
      });
      if (BINDING_ONLY.has(script)) {
        it(`${script} ${where}: no workers.dev address or preview URLs`, () => {
          expect(env.workers_dev).toBe(false);
          expect(env.preview_urls).toBe(false);
        });
      }
    }
  }
});
