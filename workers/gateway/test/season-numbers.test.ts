import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { CanvasDO } from '@brickplace/game';
import { foldNow } from '@brickplace/game/journal';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/index.ts';
import { Browser, devSignIn, envIn, ORIGIN } from './support.ts';

// POST /api/me/season (ADR 0031): the signed-in account's own moves on the current canvas.

const testEnv = env as unknown as Env & { CANVAS: DurableObjectNamespace<CanvasDO> };

describe('season numbers', () => {
  it('answers only the signed-in account, with its own numbers from the current canvas', async () => {
    const browser = new Browser(envIn('dev'));
    // Signed out: nothing to show, and a GET is not the way in.
    expect((await browser.postJson('/api/me/season', {}, { Origin: ORIGIN })).status).toBe(401);
    expect((await browser.get('/api/me/season')).status).toBe(405);
    await devSignIn(browser, 'numbers-gw', 'Numbers Person');
    const { csrf } = await browser.me();
    const { id } = (await testEnv.ACCOUNTS.prepare('SELECT id FROM users WHERE email = ?')
      .bind('numbers-gw@example.test')
      .first<{ id: string }>())!;
    // No season registered: the Stage 0 canvas plays.
    await runInDurableObject(
      testEnv.CANVAS.get(testEnv.CANVAS.idFromName('canvas')),
      (instance, state) => {
        foldNow(instance, state.storage);
        state.storage.sql.exec(
          'INSERT OR REPLACE INTO player_season (player, bricks, hammers, shields, days, last_day) ' +
            'VALUES (?, 7, 3, 2, 4, 0)',
          id,
        );
      },
    );
    // Without the CSRF token: refused.
    expect((await browser.postJson('/api/me/season', {}, { Origin: ORIGIN })).status).toBe(403);
    const response = await browser.postJson(
      '/api/me/season',
      {},
      { 'X-CSRF-Token': csrf!, Origin: ORIGIN },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      season: null,
      bricks: 7,
      hammers: 3,
      shields: 2,
      days: 4,
    });
  });
});
