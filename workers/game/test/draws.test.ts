import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { drawWords, importDrawKey, newSalt, parseSalt } from '../src/draws.ts';

// Known answers computed outside the Workers runtime (Node's HMAC over the same bytes). If
// one changes, the message format changed: give it a new tag instead of breaking old audits.
describe('draw PRF', () => {
  const salt = Uint8Array.from({ length: 16 }, (_, i) => i);

  it('matches the known answers', async () => {
    const key = (await importDrawKey('known-answer-key'))!;
    expect(await drawWords(key, salt, 'player-1', 7)).toEqual([2642078613, 222309969]);
    expect(await drawWords(key, salt, 'Zoë', 0xffffffff)).toEqual([2329521613, 637948515]);
  });

  it('gives other words for another salt, player or index', async () => {
    const key = (await importDrawKey('known-answer-key'))!;
    const base = await drawWords(key, salt, 'player-1', 7);
    const otherSalt = salt.map((b) => b ^ 1);
    expect(await drawWords(key, otherSalt, 'player-1', 7)).not.toEqual(base);
    expect(await drawWords(key, salt, 'player-2', 7)).not.toEqual(base);
    expect(await drawWords(key, salt, 'player-1', 8)).not.toEqual(base);
  });

  it('refuses bad inputs and has no key without the secret', async () => {
    const key = (await importDrawKey('k'))!;
    await expect(drawWords(key, salt, 'p', -1)).rejects.toThrow(RangeError);
    await expect(drawWords(key, salt.subarray(1), 'p', 0)).rejects.toThrow(RangeError);
    expect(await importDrawKey(undefined)).toBeNull();
    expect(await importDrawKey('')).toBeNull();
  });

  it('stores salts as hex and reads them back', () => {
    const hex = newSalt();
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
    expect(newSalt()).not.toBe(hex);
    expect([...parseSalt('000102030405060708090a0b0c0d0e0f')]).toEqual([...salt]);
    expect(() => parseSalt('xyz')).toThrow(RangeError);
  });
});

describe('deploy config', () => {
  it('every env block requires ITEM_DRAW_KEY, and the top level declares no secrets', () => {
    const committed = (env as unknown as { COMMITTED_SECRETS: Record<string, string[] | null> })
      .COMMITTED_SECRETS;
    // At the top level a `secrets` block would also drop unlisted .dev.vars keys in local dev.
    expect(committed['']).toBeNull();
    expect(Object.keys(committed)).toEqual(expect.arrayContaining(['staging', 'production']));
    for (const [name, required] of Object.entries(committed)) {
      if (name !== '') expect(required, name).toContain('ITEM_DRAW_KEY');
    }
  });
});
