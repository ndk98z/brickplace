import { describe, expect, it } from 'vitest';
import { lifecycle, parseJsonc } from '../check-do-lifecycle.ts';

describe('parseJsonc', () => {
  it('keeps // inside strings and drops comments and trailing commas', () => {
    expect(parseJsonc('{ "a": "https://x", // c\n /* b */ "b": [1,], }')).toEqual({
      a: 'https://x',
      b: [1],
    });
  });

  it('rejects an unterminated block comment instead of looping', () => {
    expect(() => parseJsonc('{ /* oops ')).toThrow(SyntaxError);
  });
});

describe('lifecycle', () => {
  it('ignores bindings and vars, sees migrations', () => {
    const a = '{ "vars": { "A": "1" }, "migrations": [{ "tag": "v1" }] }';
    const b = '{ "vars": { "A": "2" }, "migrations": [{ "tag": "v1" }] }';
    const c = '{ "migrations": [{ "tag": "v1" }, { "tag": "v2" }] }';
    expect(lifecycle(a)).toBe(lifecycle(b));
    expect(lifecycle(a)).not.toBe(lifecycle(c));
  });

  it('treats a new worker without DOs as unchanged', () => {
    expect(lifecycle('{ "name": "new", "main": "src/index.ts" }')).toBe(lifecycle('{}'));
    // Env blocks with only vars and bindings (the admin Worker, ADR 0022) change nothing.
    const envs = '{ "env": { "staging": { "vars": { "A": "1" } }, "production": {} } }';
    expect(lifecycle(envs)).toBe(lifecycle('{}'));
  });

  it('sees migrations added to, changed in or removed from an env block', () => {
    const none = '{ "env": { "staging": {} } }';
    const one = '{ "env": { "staging": { "migrations": [{ "tag": "v1" }] } } }';
    const two = '{ "env": { "staging": { "migrations": [{ "tag": "v1" }, { "tag": "v2" }] } } }';
    expect(lifecycle(one)).not.toBe(lifecycle(none));
    expect(lifecycle(two)).not.toBe(lifecycle(one));
    expect(lifecycle('{}')).not.toBe(lifecycle(one));
  });

  it('sees env blocks added or renamed under top-level migrations, which they inherit', () => {
    const top = '"migrations": [{ "tag": "v1" }]';
    const staging = `{ ${top}, "env": { "staging": { "vars": { "A": "1" } } } }`;
    const renamed = `{ ${top}, "env": { "stage": { "vars": { "A": "1" } } } }`;
    const added = `{ ${top}, "env": { "staging": { "vars": { "A": "1" } }, "preview": {} } }`;
    expect(lifecycle(renamed)).not.toBe(lifecycle(staging));
    expect(lifecycle(added)).not.toBe(lifecycle(staging));
    // Vars and bindings inside an env still change nothing.
    const other = `{ ${top}, "env": { "staging": { "vars": { "A": "2" } } } }`;
    expect(lifecycle(other)).toBe(lifecycle(staging));
  });
});
