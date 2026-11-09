import { DurableObject } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.ts';

describe('Worker entry', () => {
  // workerd refuses to start a script whose main module exports anything else
  // ("Incorrect type for map entry"), which the test runner does not catch on its own.
  it('exports only the default handler and Durable Object classes', () => {
    for (const [name, value] of Object.entries(entry as Record<string, unknown>)) {
      const allowed =
        name === 'default'
          ? typeof value === 'object' && value !== null && 'fetch' in value
          : typeof value === 'function' && value.prototype instanceof DurableObject;
      expect(allowed, `export ${name}`).toBe(true);
    }
  });
});
