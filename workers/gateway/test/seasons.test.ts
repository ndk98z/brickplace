import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { ID_RETENTION_MS } from '@brickplace/game/season';
import {
  CANVAS_HEADER,
  fanoutName as realtimeFanoutName,
  shardCount as realtimeShardCount,
  shardOf as realtimeShardOf,
} from '@brickplace/realtime/player';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index.ts';
import { currentSeason, forgetSeasons, STALE_MS, stateOf } from '../src/seasons.ts';
import * as socket from '../src/socket.ts';
import { envIn } from './support.ts';

// The season registry and routing (ADR 0021).

const { ACCOUNTS } = env as unknown as Env;
const DAY = 24 * 60 * 60 * 1000;
/** Far ahead, so rows written here never become current for the other test files. */
const FUTURE = Date.UTC(2100, 0, 1);

type Row = { id: number; canvas: string; starts_at: number; ends_at: number };

/** A D1 stand-in that answers the registry's queries from `rows`, at any time. */
function registry(rows: readonly Row[]): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...bound: unknown[]) => statement(sql, bound),
    async all() {
      // Unbound (the full list): every row counts as started; the caller filters by time.
      const now = (args[0] as number | undefined) ?? Number.POSITIVE_INFINITY;
      const started = rows
        .filter((r) => r.starts_at <= now)
        .sort((a, b) => b.starts_at - a.starts_at);
      const upcoming = rows
        .filter((r) => r.starts_at > now)
        .sort((a, b) => a.starts_at - b.starts_at);
      const results = sql.includes('starts_at > ?')
        ? upcoming.slice(0, 1)
        : /LIMIT 1$/.test(sql)
          ? started.slice(0, 1)
          : started;
      return { results };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: (statements: ReturnType<typeof statement>[]) =>
      Promise.all(statements.map((s) => s.all())),
  } as unknown as D1Database;
}

function request(environment: Env['ENVIRONMENT'], path: string, db: D1Database, headers = {}) {
  const req = new Request(`https://brickplace.test${path}`, { headers });
  return worker.fetch(
    req as Parameters<typeof worker.fetch>[0],
    envIn(environment, { ACCOUNTS: db }),
  );
}

// The registry is cached per isolate: every case starts and ends without a cached answer.
beforeEach(() => forgetSeasons());
afterEach(() => forgetSeasons());

describe('season registry', () => {
  it('has a D1 table the gateway can read: the season whose start passed last is current', async () => {
    await ACCOUNTS.prepare(
      'INSERT INTO seasons (id, canvas, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, 0), (?, ?, ?, ?, 0)',
    )
      .bind(
        901,
        'reg-1',
        FUTURE,
        FUTURE + 7 * DAY,
        902,
        'reg-2',
        FUTURE + 8 * DAY,
        FUTURE + 15 * DAY,
      )
      .run();
    expect(await currentSeason(ACCOUNTS, FUTURE - 1)).toBeNull();
    expect((await currentSeason(ACCOUNTS, FUTURE + DAY))?.canvas).toBe('reg-1');
    // Over, and the next one not started yet: still the last one (read-only), finalizing
    // until its archive is sealed at the latest (ADR 0021), ended after.
    const between = await currentSeason(ACCOUNTS, FUTURE + 7 * DAY + 1);
    expect(between?.canvas).toBe('reg-1');
    expect(stateOf(between!, FUTURE + 7 * DAY - 1)).toBe('live');
    expect(stateOf(between!, FUTURE + 7 * DAY)).toBe('finalizing');
    expect(stateOf(between!, FUTURE + 7 * DAY + ID_RETENTION_MS - 1)).toBe('finalizing');
    expect(stateOf(between!, FUTURE + 7 * DAY + ID_RETENTION_MS)).toBe('ended');
    // The next season is cached with the current one: no stale minute at its start.
    expect((await currentSeason(ACCOUNTS, FUTURE + 8 * DAY))?.canvas).toBe('reg-2');
  });

  it('refuses names that cannot be a canvas', async () => {
    for (const canvas of ['Upper', 'with space', '-dash', 'x'.repeat(33), '']) {
      await expect(
        ACCOUNTS.prepare(
          'INSERT INTO seasons (canvas, starts_at, ends_at, created_at) VALUES (?, ?, ?, 0)',
        )
          .bind(canvas, FUTURE + 100 * DAY, FUTURE + 101 * DAY)
          .run(),
        canvas,
      ).rejects.toThrow();
    }
  });

  it('names fanouts and the canvas header as FanoutDO does', () => {
    expect(socket.CANVAS_HEADER).toBe(CANVAS_HEADER);
    for (const canvas of ['canvas', 's1', 'season-2']) {
      expect(socket.fanoutName(canvas)).toBe(realtimeFanoutName(canvas));
      expect(socket.fanoutName(canvas, 3)).toBe(realtimeFanoutName(canvas, 3));
    }
  });

  it('spreads sockets over shards as the realtime script and the admin Worker count them', () => {
    for (const value of [undefined, '', '0', '1', '4', '64', '65', '2.5', 'x']) {
      expect(socket.shardCount(value)).toBe(realtimeShardCount(value));
    }
    expect(socket.shardCount('4')).toBe(4);
    expect(socket.shardCount(undefined)).toBe(1);
    const used = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const key = `player-${i}`;
      expect(socket.shardOf(key, 8)).toBe(realtimeShardOf(key, 8));
      used.add(socket.shardOf(key, 8));
    }
    expect(used.size).toBe(8);
    // A player always lands on the same shard; a watcher by its connection id.
    const player = { player: 'p-7', client: 'page-1' } as const;
    expect(socket.fanoutFor('s1', player, 4)).toBe(
      socket.fanoutFor('s1', { ...player, client: 'page-2' }, 4),
    );
    expect(socket.fanoutFor('s1', { watch: true, client: 'page-1' }, 1)).toBe('s1:fanout-0');
  });
});

/**
 * The accounts database with the season registry answered from `rows`: queries on `seasons`
 * go to the stand-in, everything else (teams, users) to the real database.
 */
function withSeasons(rows: readonly Row[]): D1Database {
  const fake = registry(rows);
  return new Proxy(ACCOUNTS, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) =>
          sql.includes('FROM seasons') ? fake.prepare(sql) : target.prepare(sql);
      }
      if (prop === 'batch') {
        return (statements: object[]) =>
          statements.every((s) => 'args' in s)
            ? fake.batch(statements as never)
            : target.batch(statements as never);
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('season routing', () => {
  const now = Date.now();
  const live: Row = { id: 3, canvas: 'route-s3', starts_at: now - DAY, ends_at: now + DAY };

  it('ranks teams by the current season canvas standings (each canvas keeps its own)', async () => {
    const ranking = await request('dev', '/api/teams/ranking', withSeasons([live]));
    expect(ranking.status).toBe(200);
    expect(((await ranking.json()) as { canvas: string }).canvas).toBe('route-s3');
    forgetSeasons();
    const stage0 = await request('dev', '/api/teams/ranking', withSeasons([]));
    expect(((await stage0.json()) as { canvas: string }).canvas).toBe('canvas');
  });

  it('serves the current canvas stats, public and cached for 15 s (ADR 0030)', async () => {
    const response = await request('dev', '/api/stats', withSeasons([live]));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=15, s-maxage=15');
    expect(await response.json()).toMatchObject({
      playing: 0,
      phase: 'settling',
      filled: 0,
      rates: { settling: [84, 5, 1, 10], contested: [70, 10, 10, 10], saturated: [40, 10, 25, 25] },
    });
  });

  it('answers 503 while the canvas cannot say, and caches only a real answer', async () => {
    const own: Row = { id: 4, canvas: 'stats-s4', starts_at: now - DAY, ends_at: now + DAY };
    const failing = (stats: () => Promise<unknown>) =>
      ({
        idFromName: (name: string) => name,
        get: () => ({ stats }),
      }) as unknown as Env['FANOUT'];
    const ask = (fanout?: Env['FANOUT']) =>
      worker.fetch(
        new Request('https://brickplace.test/api/stats') as Parameters<typeof worker.fetch>[0],
        envIn('dev', { ACCOUNTS: withSeasons([own]), ...(fanout ? { FANOUT: fanout } : {}) }),
      );
    for (const fanout of [
      failing(async () => Promise.reject(new Error('canvas down'))),
      // A script that predates stats().
      failing(async () => null),
    ]) {
      const refused = await ask(fanout);
      expect(refused.status).toBe(503);
      expect(refused.headers.get('Cache-Control')).toBe('no-store');
    }
    // Nothing was cached: the next ask reaches the canvas.
    const answered = await ask();
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ phase: 'settling' });
  });

  it('sends sockets to the current season, whatever canvas the client names', async () => {
    const response = await request(
      'dev',
      '/ws?player=season-01&client=season-conn-01',
      registry([live]),
      {
        Upgrade: 'websocket',
        [CANVAS_HEADER]: 'someone-elses',
      },
    );
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    const { FANOUT } = env as unknown as Env;
    const fanout = FANOUT.get(FANOUT.idFromName(socket.fanoutName('route-s3')));
    const pinned = await runInDurableObject(fanout, (_, state) => state.storage.kv.get('canvas'));
    expect(pinned).toBe('route-s3');
    response.webSocket!.close();
  });

  it('tells pages the season and its tiles in /api/me, and lists seasons', async () => {
    const me = await (await request('dev', '/api/me', registry([live]))).json<{
      config: { tilesUrl: string; season: Record<string, unknown> };
    }>();
    expect(me.config.tilesUrl).toBe('/api/dev/tiles/c/route-s3');
    expect(me.config.season).toMatchObject({
      id: 3,
      canvas: 'route-s3',
      startsAt: live.starts_at,
      endsAt: live.ends_at,
      state: 'live',
      tilesUrl: '/api/dev/tiles/c/route-s3',
    });
    const listed = await request('dev', '/api/seasons', registry([live]));
    expect(listed.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await listed.json()).toMatchObject({
      current: { canvas: 'route-s3', tilesUrl: '/api/dev/tiles/c/route-s3' },
      seasons: [{ canvas: 'route-s3', state: 'live' }],
    });
  });

  it('names the next season in /api/me, so open pages ask again at its start', async () => {
    const next: Row = { id: 4, canvas: 'route-s4', starts_at: now + DAY, ends_at: now + 2 * DAY };
    const me = await (await request('dev', '/api/me', registry([live, next]))).json<{
      config: { season: { canvas: string }; nextSeason: unknown };
    }>();
    expect(me.config.season.canvas).toBe('route-s3');
    expect(me.config.nextSeason).toEqual({ canvas: 'route-s4', startsAt: next.starts_at });
    forgetSeasons();
    const alone = await (await request('dev', '/api/me', registry([live]))).json<{
      config: { nextSeason: unknown };
    }>();
    expect(alone.config.nextSeason).toBeNull();
  });

  it('lists only seasons that have started', async () => {
    const next: Row = { id: 4, canvas: 'route-s4', starts_at: now + DAY, ends_at: now + 2 * DAY };
    const listed = await (await request('dev', '/api/seasons', registry([live, next]))).json<{
      seasons: { canvas: string }[];
    }>();
    expect(listed.seasons.map((s) => s.canvas)).toEqual(['route-s3']);
  });

  it('keeps the Stage 0 canvas while the registry is empty', async () => {
    const listed = await request('dev', '/api/seasons', registry([]));
    expect(await listed.json()).toEqual({
      current: { canvas: 'canvas', tilesUrl: '/api/dev/tiles/c/canvas' },
      seasons: [],
    });
  });

  it('with D1 down and nothing cached, gives players no socket but lets watchers watch Stage 0', async () => {
    const played = await request('dev', '/ws?player=season-02', broken(), {
      Upgrade: 'websocket',
    });
    expect(played.status).toBe(503);
    const watched = await request('dev', '/ws?client=season-watch-01', broken(), {
      Upgrade: 'websocket',
    });
    expect(watched.status).toBe(101);
    watched.webSocket!.accept();
    watched.webSocket!.close();
    const me = await request('dev', '/api/me', broken());
    expect(me.status).toBe(200);
    // Marked as a guess, so open pages do not take it for a change of season.
    expect(
      ((await me.json()) as { config: { tilesUrl: string; season: unknown } }).config,
    ).toMatchObject({ tilesUrl: '/api/dev/tiles/c/canvas', season: null, seasonGuessed: true });
    forgetSeasons();
    const known = await (await request('dev', '/api/me', registry([]))).json<{
      config: Record<string, unknown>;
    }>();
    expect(known.config.season).toBeNull();
    expect('seasonGuessed' in known.config).toBe(false);
  });

  it('with D1 down, keeps serving the last answer for a while, then stops guessing', async () => {
    expect((await currentSeason(registry([live]), now))?.canvas).toBe('route-s3');
    // Within the stale window: the cached answer, for players too.
    const later = now + 10 * 60_000;
    expect((await currentSeason(broken(), later))?.canvas).toBe('route-s3');
    const played = await request('dev', '/ws?player=season-03&client=season-conn-03', broken(), {
      Upgrade: 'websocket',
    });
    expect(played.status).toBe(101);
    played.webSocket!.accept();
    played.webSocket!.close();
    const me = await request('dev', '/api/me', broken());
    expect(
      ((await me.json()) as { config: { season: { canvas: string } } }).config.season.canvas,
    ).toBe('route-s3');
    // Past it, the registry is unknown again.
    await expect(currentSeason(broken(), now + STALE_MS + 1)).rejects.toThrow('D1 down');
  });
});

/** A D1 stand-in that fails every read. */
function broken(): D1Database {
  const fail = async () => {
    throw new Error('D1 down');
  };
  return {
    prepare: () => ({ bind: () => ({ all: fail }), all: fail }),
    batch: fail,
  } as unknown as D1Database;
}
