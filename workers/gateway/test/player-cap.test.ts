import { env } from 'cloudflare:workers';
import * as realtime from '@brickplace/realtime/player';
import { CAP_HEADER, MAP_FULL } from '@brickplace/realtime/player';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.ts';
import {
  capOf,
  capShare,
  DEFAULT_PLAYER_CAP,
  forgetPlayerCap,
  MAX_PLAYER_CAP,
  playerCap,
} from '../src/player-cap.ts';
import * as socket from '../src/socket.ts';
import { Browser, envIn } from './support.ts';

// The players-at-once cap (ADR 0039): a `site_settings` row the admin area writes, read here
// through a 30 s cache, and passed to each playing socket's shard as its share.

const db = (env as unknown as Env).ACCOUNTS;

async function setCap(value: number | null) {
  await db
    .prepare(
      "INSERT INTO site_settings (key, value, updated_at) VALUES ('player_cap', ?, 0) " +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .bind(value)
    .run();
  forgetPlayerCap();
}

afterEach(async () => {
  await db.prepare("DELETE FROM site_settings WHERE key = 'player_cap'").run();
  forgetPlayerCap();
});

describe('the player cap setting', () => {
  it('is 5,000 with no row, the row value with one, and null when switched off', async () => {
    expect(await playerCap(db, 1)).toBe(DEFAULT_PLAYER_CAP);
    expect(DEFAULT_PLAYER_CAP).toBe(5_000);
    await setCap(1200);
    expect(await playerCap(db, 1)).toBe(1200);
    await setCap(null);
    expect(await playerCap(db, 1)).toBeNull();
  });

  it('has the default and maximum the admin area shows', () => {
    expect(DEFAULT_PLAYER_CAP).toBe(realtime.DEFAULT_PLAYER_CAP);
    expect(MAX_PLAYER_CAP).toBe(realtime.MAX_PLAYER_CAP);
  });

  it('is read at most every 30 s per isolate', async () => {
    await setCap(10);
    expect(await playerCap(db, 1_000)).toBe(10);
    await db.prepare("UPDATE site_settings SET value = 20 WHERE key = 'player_cap'").run();
    expect(await playerCap(db, 30_999)).toBe(10);
    expect(await playerCap(db, 31_000)).toBe(20);
  });

  it('never makes a request wait on another request’s read', async () => {
    await setCap(30);
    // As when the request that started a read is cancelled and the read never settles.
    const stuck = {
      prepare: () => ({ first: () => new Promise(() => {}) }),
    } as unknown as D1Database;
    void playerCap(stuck, 1);
    expect(await playerCap(db, 1)).toBe(30);
  });

  it('keeps the last value, or the default, while D1 cannot answer', async () => {
    const broken = {
      prepare: () => {
        throw new Error('D1 down');
      },
    } as unknown as D1Database;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await playerCap(broken, 1)).toBe(DEFAULT_PLAYER_CAP);
      await setCap(null);
      expect(await playerCap(db, 1)).toBeNull();
      expect(await playerCap(broken, 40_000)).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it('takes a malformed value as the default, never as no cap', () => {
    expect(capOf(null)).toBeNull();
    expect(capOf(0)).toBe(0);
    expect(capOf(MAX_PLAYER_CAP)).toBe(MAX_PLAYER_CAP);
    for (const bad of [-1, 1.5, MAX_PLAYER_CAP + 1, '10', undefined]) {
      expect(capOf(bad), String(bad)).toBe(DEFAULT_PLAYER_CAP);
    }
  });

  it('splits into shard shares that add up to at least the cap', () => {
    expect(capShare(5000, 1)).toBe(5000);
    expect(capShare(5000, 3)).toBe(1667);
    expect(capShare(0, 4)).toBe(0);
  });
});

describe('the cap on sockets', () => {
  it('uses the header name FanoutDO reads', () => {
    expect(socket.CAP_HEADER).toBe(CAP_HEADER);
  });

  it('passes a player its share, a watcher none, and never one the client sent', () => {
    const request = new Request('https://brickplace.test/ws', {
      headers: { [CAP_HEADER]: '99999' },
    });
    const player = socket.withIdentity(
      request,
      { player: 'p-1', client: 'conn-p-0001' },
      'canvas',
      40,
    );
    expect(player.headers.get(CAP_HEADER)).toBe('40');
    const uncapped = socket.withIdentity(
      request,
      { player: 'p-1', client: 'conn-p-0001' },
      'canvas',
    );
    expect(uncapped.headers.get(CAP_HEADER)).toBeNull();
    const watcher = socket.withIdentity(
      request,
      { watch: true, client: 'conn-w-0001' },
      'canvas',
      40,
    );
    expect(watcher.headers.get(CAP_HEADER)).toBeNull();
  });

  it('turns a player away on a full map: the socket closes with MAP_FULL', async () => {
    await setCap(0);
    const request = new Request(
      'https://brickplace.test/ws?player=cap-zero-01&client=conn-cap-0001',
      {
        headers: { Upgrade: 'websocket' },
      },
    );
    const response = await worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      envIn('dev'),
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    ws.accept();
    expect(await closed).toBe(MAP_FULL);
  });

  it('tells every page the cap in /api/me', async () => {
    const browser = new Browser(envIn('dev'));
    expect((await browser.me()).config.playerCap).toBe(DEFAULT_PLAYER_CAP);
    await setCap(null);
    expect((await browser.me()).config.playerCap).toBeNull();
  });
});
