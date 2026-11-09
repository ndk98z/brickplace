import { env } from 'cloudflare:workers';
import { DEFAULT_PLAYER_CAP, MAX_PLAYER_CAP } from '@brickplace/realtime/player';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { ADMIN_JS } from '../src/ui/page.ts';
import { call, claims, envIn, type FakeAccess, fakeAccess, grant, serveKeys } from './support.ts';

// The players-at-once cap (ADR 0039): owners set it, moderators read it, every change is
// audited. The gateway reads the same row.

const testEnv = env as unknown as Env;
const accounts = testEnv.ACCOUNTS;
const OWNER = 'cap-owner@example.test';
const MOD = 'cap-mod@example.test';
let access: FakeAccess;

beforeAll(async () => {
  access = await fakeAccess('cap-key');
  await grant(OWNER, 'owner');
  await grant(MOD, 'moderator');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await accounts.prepare('DELETE FROM site_settings').run();
});

async function as(who: string, path: string, body?: unknown) {
  serveKeys(access.jwks);
  const token = await access.sign(claims(who, Date.now()));
  return call(envIn('staging'), path, { token, body });
}

const read = async (who = MOD) =>
  (await (await as(who, '/api/player-cap')).json()) as {
    cap: number | null;
    isDefault: boolean;
    updatedAt: number | null;
  };

describe('the player cap (ADR 0039)', () => {
  it('reads the default until an owner sets one, and no cap once switched off', async () => {
    expect(await read()).toEqual({ cap: DEFAULT_PLAYER_CAP, isDefault: true, updatedAt: null });
    const set = await as(OWNER, '/api/player-cap', { cap: 1200, reason: 'first week' });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ cap: 1200, isDefault: false });
    expect((await read()).cap).toBe(1200);
    expect((await as(OWNER, '/api/player-cap', { cap: null, reason: 'a sponsor' })).status).toBe(
      200,
    );
    expect(await read()).toMatchObject({ cap: null, isDefault: false });
    const { results } = await testEnv.ADMIN_DB.prepare(
      "SELECT before, after, outcome FROM audit_log WHERE action = 'player_cap.set' AND actor = ? ORDER BY id",
    )
      .bind(OWNER)
      .all<{ before: string | null; after: string | null; outcome: string }>();
    expect(results).toEqual([
      { before: '5000', after: '1200', outcome: 'requested' },
      { before: '5000', after: '1200', outcome: 'ok' },
      { before: '1200', after: 'null', outcome: 'requested' },
      { before: '1200', after: 'null', outcome: 'ok' },
    ]);
  });

  it('takes whole numbers from 0 to the maximum, and needs a reason', async () => {
    for (const cap of [-1, 1.5, MAX_PLAYER_CAP + 1, '100', undefined]) {
      const response = await as(OWNER, '/api/player-cap', { cap, reason: 'test' });
      expect(response.status, String(cap)).toBe(400);
    }
    expect((await as(OWNER, '/api/player-cap', { cap: 10 })).status).toBe(400);
    expect((await as(OWNER, '/api/player-cap', { cap: 0, reason: 'closed' })).status).toBe(200);
    expect((await read()).cap).toBe(0);
  });

  it('is an owner’s to change', async () => {
    const response = await as(MOD, '/api/player-cap', { cap: 10, reason: 'try' });
    expect(response.status).toBe(403);
    expect((await read()).isDefault).toBe(true);
  });

  it('is on the overview, with a change button for owners', () => {
    expect(ADMIN_JS).toContain("call('/api/player-cap')");
    expect(ADMIN_JS).toContain('function setPlayerCap(current)');
  });
});
