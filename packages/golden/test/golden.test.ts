import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEntry,
  type CoreConfig,
  createState,
  gridHash,
  type LogEntry,
} from '@brickplace/core';
import { describe, expect, it } from 'vitest';

/**
 * A log entry (a player op, `"kind": "open"` growing the open area, or `"kind": "restore"`
 * setting cells back, ADR 0024) plus its logical time in ms; without `at` it happens at the
 * latest time so far.
 */
type TimedOp = LogEntry & { at?: number };

interface Fixture {
  name: string;
  description: string;
  config: CoreConfig;
  ops: TimedOp[];
  /** "ok" or the reject reason, one per entry. */
  expectedOutcomes: string[];
  expectedHash: string;
}

const dir = join(import.meta.dirname, '..', 'fixtures');
const update = process.env.UPDATE_GOLDEN === '1';

describe('golden op logs', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const path = join(dir, file);
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture;

    it(fixture.name, () => {
      const state = createState(fixture.config);
      const outcomes = fixture.ops.map(({ at, ...op }) => {
        const result = applyEntry(state, op as LogEntry, at);
        return result.ok ? 'ok' : result.reason;
      });
      const hash = gridHash(state);

      if (update) {
        writeFileSync(
          path,
          `${JSON.stringify({ ...fixture, expectedOutcomes: outcomes, expectedHash: hash }, null, 2)}\n`,
        );
        return;
      }
      expect(fixture.expectedHash, 'run `pnpm golden:update` to fill new fixtures').not.toBe('');
      expect(outcomes).toEqual(fixture.expectedOutcomes);
      expect(hash).toBe(fixture.expectedHash);
    });
  }
});
