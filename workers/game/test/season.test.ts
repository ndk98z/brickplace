import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  applyEntry,
  type CoreConfig,
  createState,
  DEFAULT_MAP_SIZE,
  gridHash,
  type Item,
  type LogEntry,
  type Op,
  TILE_SIZE,
} from '@brickplace/core';
import {
  cdnKeys,
  decodeOverview,
  decodeTile,
  overviewFactor,
  parseKeyframes,
} from '@brickplace/protocol/cdn';
import { describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_TEAM_MIN_PLAYERS,
  archiveKeys,
  Pseudonyms,
  purgePlayerData,
  putIfAbsent,
  renamedLogTail,
  SEAL_SEGMENTS_PER_STEP,
  type SeasonArchive,
} from '../src/archive.ts';
import { gunzip, gzip } from '../src/checkpoints.ts';
import { listCopies } from '../src/copies.ts';
import type { CanvasDO, Env } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';
import { KEYFRAME_MS } from '../src/keyframes.ts';
import { ID_RETENTION_MS } from '../src/season.ts';
import { TEAM_CAP_KEY } from '../src/teams.ts';
import { pendingAlarm } from './alarms.ts';

// Seasons (ADR 0021): the end and the read-only switch, closing, keyframes and the sealed archive.
//
// Times: every tick here is on the wall clock and ahead of it (from T, one to two hours from now,
// on an hour boundary), and each canvas is first ticked once at START. That kept real alarms,
// which tick at Date.now(), from running maintenance in the middle of a test; they no longer
// fire during tests at all (test/setup.ts), so the tests see only their own ticks either way.

const { CANVAS, OPLOG, TILES, MODERATION } = env as unknown as Required<Env>;
/** Tiles in a row of the default map; tile (tx, ty) is at ty * PER_ROW + tx in an index. */
const PER_ROW = DEFAULT_MAP_SIZE / TILE_SIZE;
type Stub = ReturnType<typeof CANVAS.get>;
const O: Item = { kind: 'brick', shape: 1 };
const NEVER = 2 ** 50;
const HOUR = KEYFRAME_MS;
const T = (Math.floor(Date.now() / HOUR) + 2) * HOUR;
const START = T - HOUR / 2;
const prefix = (name: string) => `c/${name}`;

const brick = (x: number, y: number, color = 3): Op => ({
  kind: 'brick',
  x,
  y,
  shape: 1,
  rotation: 0,
  color,
});

const tick = (stub: Stub, now: number) =>
  runInDurableObject(stub, (instance: CanvasDO) => instance.tick(now));

/** A canvas whose maintenance clock is already ahead of the real alarms (see above). */
async function canvas(name: string): Promise<Stub> {
  const stub = CANVAS.get(CANVAS.idFromName(name));
  await tick(stub, START);
  return stub;
}

async function stock(stub: Stub, player: string, items: readonly Item[]) {
  await runInDurableObject(stub, (canvas, state) => {
    foldNow(canvas, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify(items),
      NEVER,
    );
  });
}

/** Places a brick for p1 at logical time `at` and returns the batch's first result. */
async function place(stub: Stub, op: Op, opId: number, at: number) {
  await stock(stub, 'p1', [O]);
  const batch = await stub.applyBatch([{ player: 'p1', opId, op }], at);
  return batch.results[0]!;
}

const sql = <T>(stub: Stub, query: string) =>
  runInDurableObject(stub, (_, state) => state.storage.sql.exec(query).toArray() as T[]);

async function ndjson(bucket: R2Bucket, key: string): Promise<Record<string, unknown>[]> {
  const object = await bucket.get(key);
  expect(object, key).not.toBeNull();
  const text = new TextDecoder().decode(await gunzip(new Uint8Array(await object!.arrayBuffer())));
  return text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Replays the raw op log in OPLOG from the canvas's stored config. */
async function replayRaw(stub: Stub, name: string) {
  const [config] = await sql<{ value: string }>(
    stub,
    "SELECT value FROM meta WHERE key = 'config'",
  );
  const state = createState(JSON.parse(config!.value) as CoreConfig);
  const listed = await OPLOG.list({ prefix: `${prefix(name)}/oplog/` });
  for (const object of listed.objects) {
    const [, ...rows] = await ndjson(OPLOG, object.key);
    for (const row of rows) {
      for (const entry of JSON.parse(row.ops as string) as LogEntry[]) {
        applyEntry(state, entry, row.at as number);
      }
    }
  }
  return state;
}

/** Ticks until the season reaches `phase`, a few maintenance passes apart. */
async function tickUntil(stub: Stub, from: number, phase: string) {
  for (let i = 0; i < 20; i++) {
    await tick(stub, from + i * 60_000);
    if ((await stub.seasonStatus()).phase === phase) return from + i * 60_000;
  }
  throw new Error(`never reached ${phase}: ${JSON.stringify(await stub.seasonStatus())}`);
}

/**
 * Runs `body` inside the canvas with OPLOG replaced by a bucket whose `method` throws for keys
 * under `c/{canvas}/checkpoints/` (the checkpoint copies) and works for every other key.
 */
async function withoutCopies(
  stub: Stub,
  method: 'put' | 'delete',
  body: (instance: CanvasDO) => Promise<void>,
): Promise<void> {
  await runInDurableObject(stub, async (instance: CanvasDO) => {
    const target = instance as unknown as { env: Env };
    const real = target.env;
    const bucket = Object.create(OPLOG) as R2Bucket;
    bucket.list = OPLOG.list.bind(OPLOG);
    bucket.get = OPLOG.get.bind(OPLOG);
    bucket.head = OPLOG.head.bind(OPLOG);
    bucket.put = OPLOG.put.bind(OPLOG);
    bucket.delete = OPLOG.delete.bind(OPLOG);
    const copies = (keys: string | string[]) =>
      ([] as string[]).concat(keys).some((k) => k.includes('/checkpoints/'));
    if (method === 'put') {
      bucket.put = ((key: string, ...rest: unknown[]) => {
        if (copies(key)) return Promise.reject(new Error('copy put failed'));
        return (OPLOG.put as (...a: unknown[]) => Promise<R2Object>)(key, ...rest);
      }) as R2Bucket['put'];
    } else {
      bucket.delete = async (keys: string | string[]) => {
        if (copies(keys)) throw new Error('copy delete failed');
        await OPLOG.delete(keys);
      };
    }
    target.env = { ...real, OPLOG: bucket };
    try {
      await body(instance);
    } finally {
      target.env = real;
    }
  });
}

function readSeasonRow(sql: SqlStorage): Record<string, unknown> {
  return JSON.parse(
    sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'season'").one().value,
  ) as Record<string, unknown>;
}

/** Player ids distinctive enough to search for in any table or object. */
const ALICE = 'player-alice-2f9c';
const BOB = 'player-bob-77d1';

/**
 * Plays one op as `player` in `team` (ADR 0020), after the canvas has read the team cap, so
 * the op is logged with its `who` and counted for the team.
 */
async function act(stub: Stub, player: string, team: number, op: Op, opId: number, at: number) {
  await runInDurableObject(stub, async (instance: CanvasDO, state) => {
    const inner = instance as unknown as {
      env: Env;
      teams: { refreshCap(kv: KVNamespace | undefined, now: number): Promise<void> };
    };
    await inner.teams.refreshCap(inner.env.MODERATION, Date.now());
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify([O]),
      NEVER,
    );
  });
  const batch = await stub.applyBatch([{ player, opId, op, team }], at);
  return batch.results[0]!;
}

async function textOf(bytes: Uint8Array, gzipped: boolean): Promise<string> {
  let plain = bytes;
  if (gzipped) {
    try {
      plain = await gunzip(bytes);
    } catch {
      // Not a whole gzip stream: search the bytes as they are.
    }
  }
  return new TextDecoder('latin1').decode(plain);
}

/**
 * Where ALICE or BOB still appear: every SQLite table (checkpoint parts reassembled and
 * decompressed), and every object under the canvas's `c/` prefix in both buckets.
 */
async function idsLeft(stub: Stub, name: string): Promise<string[]> {
  const found: string[] = [];
  const names = (text: string) => text.includes(ALICE) || text.includes(BOB);
  const tables = await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    const list = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
          "AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      )
      .toArray();
    return list.map(({ name: table }) => ({
      table,
      rows: sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM "${table}"`).toArray(),
    }));
  });
  for (const { table, rows } of tables) {
    if (table.endsWith('checkpoint_parts')) {
      const gens = new Map<number, Uint8Array[]>();
      for (const row of [...rows].sort((a, b) => Number(a.part) - Number(b.part))) {
        const parts = gens.get(Number(row.gen)) ?? [];
        parts.push(new Uint8Array(row.data as ArrayBuffer));
        gens.set(Number(row.gen), parts);
      }
      for (const [gen, parts] of gens) {
        const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
          whole.set(p, at);
          at += p.length;
        }
        if (names(await textOf(whole, true))) found.push(`${table} gen ${gen}`);
      }
      continue;
    }
    if (names(JSON.stringify(rows))) found.push(table);
  }
  for (const [label, bucket] of [
    ['OPLOG', OPLOG],
    ['TILES', TILES],
  ] as const) {
    const listed = await bucket.list({ prefix: `${prefix(name)}/` });
    for (const object of listed.objects) {
      const body = new Uint8Array(await (await bucket.get(object.key))!.arrayBuffer());
      if (names(await textOf(body, object.key.endsWith('.gz'))))
        found.push(`${label} ${object.key}`);
    }
  }
  return found;
}

/** Byte equality; toEqual on 4 MiB arrays takes seconds. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function keyframesOf(name: string) {
  return parseKeyframes(await (await TILES.get(cdnKeys.keyframes(prefix(name))))!.text());
}

/**
 * Runs `body` inside the canvas while its draw-word computation is held, so the season can be
 * moved on (ticked to its end) while a call waits in that await; then lets the call finish.
 */
async function whileDrawing<R>(
  stub: Stub,
  start: (instance: CanvasDO) => Promise<R>,
  meanwhile: (instance: CanvasDO) => Promise<void>,
): Promise<R> {
  return runInDurableObject(stub, async (instance: CanvasDO) => {
    const target = instance as unknown as {
      prepareDraws: (players: string[], at: number) => Promise<boolean>;
    };
    const real = target.prepareDraws.bind(instance);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    target.prepareDraws = async (players, at) => {
      await gate;
      return real(players, at);
    };
    const call = start(instance);
    await meanwhile(instance);
    release();
    const result = await call;
    target.prepareDraws = real;
    return result;
  });
}

describe('season end and read-only', () => {
  it('refuses ops at or after the end with `ended`, by the logical time they would be logged at', async () => {
    const stub = await canvas('season-end');
    expect(await place(stub, brick(600, 600), 1, T)).toMatchObject({ ok: true });
    const set = await stub.setSchedule({ endsAt: T + 5 * HOUR });
    expect(set).toMatchObject({ ok: true, season: { endsAt: T + 5 * HOUR, phase: 'open' } });
    expect(await place(stub, brick(700, 600), 2, T + 5 * HOUR)).toEqual({
      ok: false,
      reason: 'ended',
    });
    // The refused op was never logged, and its item was never taken.
    expect(await sql(stub, 'SELECT seq FROM op_log')).toHaveLength(1);
    const [inventory] = await sql<{ items: string }>(
      stub,
      "SELECT items FROM inventory WHERE player = 'p1'",
    );
    expect(JSON.parse(inventory!.items)).toEqual([O]);
    // Still before the end on its own clock: accepted, even if it arrives late.
    expect(await place(stub, brick(750, 600), 3, T + 5 * HOUR - 1)).toMatchObject({ ok: true });
    expect((await stub.status()).seq).toBe(2);
    const discard = await stub.discard('p1', 4, O, T + 6 * HOUR);
    expect(discard).toEqual({ result: { ok: false, reason: 'ended' }, hold: null });
    expect((await stub.holds(['p1'], T + 6 * HOUR)).size).toBe(0);
  });

  it('answers a retry of an op or discard accepted before the end as a duplicate, not ended', async () => {
    const stub = await canvas('season-retry');
    expect(await place(stub, brick(600, 600), 1, T)).toMatchObject({ ok: true });
    await stock(stub, 'p1', [O]);
    expect((await stub.discard('p1', 2, O, T + 1)).result).toEqual({ ok: true });
    await stub.setSchedule({ endsAt: T + HOUR });
    const retry = await stub.applyBatch(
      [
        { player: 'p1', opId: 1, op: brick(600, 600) },
        { player: 'p1', opId: 3, op: brick(700, 600) },
      ],
      T + HOUR,
    );
    expect(retry.results).toEqual([
      { ok: true, duplicate: true, diffs: [] },
      { ok: false, reason: 'ended' },
    ]);
    expect((await stub.discard('p1', 2, O, T + HOUR)).result).toEqual({
      ok: true,
      duplicate: true,
    });
    expect((await stub.discard('p1', 4, O, T + HOUR)).result).toEqual({
      ok: false,
      reason: 'ended',
    });
  });

  it('logs nothing after the last seq when closing starts while a batch waits for its draws', async () => {
    const stub = await canvas('season-race');
    expect(await place(stub, brick(600, 600), 1, T)).toMatchObject({ ok: true });
    await stub.setSchedule({ endsAt: T + HOUR });
    await stock(stub, 'p1', [O]);
    const result = await whileDrawing(
      stub,
      (instance) =>
        instance.applyBatch([{ player: 'p1', opId: 2, op: brick(700, 600) }], T + HOUR - 1),
      // The end passes and maintenance starts closing while the batch waits.
      (instance) => instance.tick(T + HOUR),
    );
    expect(result.results[0]).toEqual({ ok: false, reason: 'ended' });
    expect((await stub.seasonStatus()).finalSeq).toBe(1);
    expect((await stub.status()).seq).toBe(1);
  });

  it('refuses a discard and hands out no hold when closing starts during their draws', async () => {
    const stub = await canvas('season-race-holds');
    expect(await place(stub, brick(600, 600), 1, T)).toMatchObject({ ok: true });
    await stub.setSchedule({ endsAt: T + HOUR });
    await stock(stub, 'p1', [O]);
    const discard = await whileDrawing(
      stub,
      (instance) => instance.discard('p1', 5, O, T + HOUR - 1),
      (instance) => instance.tick(T + HOUR),
    );
    expect(discard).toEqual({ result: { ok: false, reason: 'ended' }, hold: null });
    const [held] = await sql<{ items: string }>(
      stub,
      "SELECT items FROM inventory WHERE player = 'p1'",
    );
    expect(JSON.parse(held!.items)).toEqual([O]);
    // A new player asking for a hold just before the end gets none, and no row.
    const stub2 = await canvas('season-race-holds-2');
    await place(stub2, brick(600, 600), 1, T);
    await stub2.setSchedule({ endsAt: T + HOUR });
    const holds = await whileDrawing(
      stub2,
      (instance) => instance.holds(['newcomer'], T + HOUR - 1),
      (instance) => instance.tick(T + HOUR),
    );
    expect(holds.size).toBe(0);
    expect(await sql(stub2, "SELECT player FROM inventory WHERE player = 'newcomer'")).toHaveLength(
      0,
    );
  });

  it('refuses an end at or before the last logged op', async () => {
    const stub = await canvas('season-end-early');
    await place(stub, brick(600, 600), 1, T);
    expect(await stub.setSchedule({ endsAt: T })).toEqual({ ok: false, reason: 'invalid' });
    expect(await stub.setSchedule({ endsAt: T + 1 })).toMatchObject({ ok: true });
  });

  it('pauses and resumes the map with the read-only switch', async () => {
    const stub = await canvas('season-read-only');
    expect(await stub.setSchedule({ readOnly: 'emergency' })).toMatchObject({ ok: true });
    expect(await place(stub, brick(600, 600), 1, T)).toEqual({ ok: false, reason: 'read_only' });
    expect((await stub.discard('p1', 2, O, T)).result).toEqual({
      ok: false,
      reason: 'read_only',
    });
    // A paused map still shows holds; it just takes no moves.
    expect((await stub.holds(['p1'], T)).size).toBe(1);
    expect(await stub.setSchedule({ readOnly: null })).toMatchObject({ ok: true });
    expect(await place(stub, brick(600, 600), 3, T + 1)).toMatchObject({ ok: true });
  });

  it('validates schedule changes and refuses moving the end once closed', async () => {
    const stub = await canvas('season-validate');
    expect(await stub.setSchedule({ endsAt: 1.5 })).toEqual({ ok: false, reason: 'invalid' });
    expect(await stub.setSchedule({ readOnly: '' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await stub.setSchedule({ readOnly: 'x'.repeat(65) })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await stub.requestSeal()).toEqual({ ok: false, reason: 'invalid' });
    expect(await stub.setSchedule({ endsAt: T + HOUR })).toMatchObject({ ok: true });
    // Past the end but not closed yet: admin growth is refused already.
    expect(await stub.setOpenArea({ x: 0, y: 0, w: 1024, h: 1024 }, T + HOUR)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    await tickUntil(stub, T + HOUR, 'ended');
    expect(await stub.setSchedule({ endsAt: T + 9 * HOUR })).toEqual({
      ok: false,
      reason: 'closed',
    });
    // An ended season logs nothing more, admin growth included.
    expect(await stub.setOpenArea({ x: 0, y: 0, w: 1024, h: 1024 })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await stub.setRemovals([{ from: 0, to: 1, area: { x: 0, y: 0, w: 1, h: 1 } }])).toEqual({
      ok: false,
      reason: 'invalid',
    });
    // With the list it was read from: refused once another change landed in between.
    const one = { from: 1, to: 1, area: { x: 0, y: 0, w: 1, h: 1 } };
    const two = { from: 1, to: 1, area: { x: 5, y: 5, w: 1, h: 1 }, player: 'p1' };
    expect(await stub.setRemovals([one], [])).toEqual({ ok: true });
    expect(await stub.setRemovals([two], [])).toEqual({ ok: false, reason: 'stale' });
    expect(await stub.setRemovals([one, two], [one])).toEqual({ ok: true });
    expect((await stub.seasonStatus()).removals).toEqual([one, two]);
  });

  it('gives a player of a new season a fresh hold: one starting item, a full cooldown', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const old = await canvas('season-holds-1');
    expect(await act(old, 'p9', 4, brick(600, 600), 1, T)).toMatchObject({ ok: true });
    await stock(old, 'p9', [O, O, O]);
    expect((await old.teamStandings()).get(4)).toMatchObject({ cells: 4 });
    const fresh = await canvas('season-holds-2');
    const hold = (await fresh.holds(['p9'], T)).get('p9')!;
    expect(hold.items).toHaveLength(1);
    expect(hold.nextAt).toBe(T + hold.cooldown);
    // Team counters are per canvas (ADR 0020): a new season starts with none.
    expect((await fresh.teamStandings()).size).toBe(0);
    expect(await fresh.lastWriter(600, 600)).toBeNull();
  });
});

describe('season close and archive', () => {
  it('ends a season left closing with its work done, after a restart and without an admin call', async () => {
    const stub = await canvas('season-stuck-closing');
    await place(stub, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    // As if the write that ended closing failed: every closing task is done, the phase is not,
    // and no alarm is pending.
    await runInDurableObject(stub, async (_, state) => {
      const season = readSeasonRow(state.storage.sql);
      state.storage.sql.exec(
        "UPDATE meta SET value = ? WHERE key = 'season'",
        JSON.stringify({ ...season, phase: 'closing', endedAt: null }),
      );
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    const status = await stub.seasonStatus();
    expect(status.phase).toBe('ended');
    // Ended, it now waits for its seal: an alarm is set again.
    const alarm = await pendingAlarm(stub);
    expect(alarm).not.toBeNull();
  });

  it('closes after the end: final checkpoint, log, tiles and keyframe; survives a restart and replays the same', async () => {
    const name = 'season-close';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await place(stub, brick(700, 600, 5), 2, T + 1_000);
    await tick(stub, T);
    await place(stub, brick(600, 400, 7), 3, T + 2 * HOUR);
    await stub.setSchedule({ endsAt: T + 3 * HOUR });
    const endedAt = await tickUntil(stub, T + 3 * HOUR, 'ended');
    const status = await stub.seasonStatus();
    expect(status).toMatchObject({ phase: 'ended', finalSeq: 3, endsAt: T + 3 * HOUR, endedAt });
    // Final checkpoint at the last seq, the whole log in OPLOG, nothing left in SQLite.
    const [checkpoint] = await sql<{ value: string }>(
      stub,
      "SELECT value FROM meta WHERE key = 'checkpoint'",
    );
    expect(JSON.parse(checkpoint!.value).seq).toBe(3);
    expect(await sql(stub, 'SELECT seq FROM op_log')).toHaveLength(0);
    // Its copy in OPLOG too: closing waits for it, and none is taken once ended.
    expect((await listCopies(OPLOG, prefix(name)))[0]?.seq).toBe(3);
    const before = await stub.snapshot();
    const replayed = await replayRaw(stub, name);
    expect(gridHash(replayed)).toBe(JSON.parse(checkpoint!.value).hash);
    // The CDN and the keyframes reach the last seq; the index is final.
    const manifest = JSON.parse(await (await TILES.get(cdnKeys.manifest(prefix(name))))!.text());
    expect(manifest.seq).toBe(3);
    const index = await keyframesOf(name);
    expect(index.final).toBe(true);
    // Final, not sealed: a moderation removal may still rewrite the frames (ADR 0021).
    expect(index.sealed).toBeUndefined();
    expect(index.frames.at(-1)!.seq).toBe(3);

    // A restart after the end: same map, still ended, still refusing.
    await evictDurableObject(stub);
    const after = await stub.snapshot();
    expect(after.seq).toBe(3);
    expect(same(after.cells, before.cells) && same(after.shields, before.shields)).toBe(true);
    expect(same(after.cells, replayed.cells)).toBe(true);
    expect((await stub.seasonStatus()).phase).toBe('ended');
    expect(await place(stub, brick(700, 700), 9, T)).toEqual({ ok: false, reason: 'ended' });
  });

  it('seals after the retention period and leaves no player id in any table, checkpoint or c/ object', async () => {
    const name = 'season-seal';
    // Before the canvas starts: it reads the cap at start-up and keeps it for minutes.
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = await canvas(name);
    // Two players in teams: `who`, writers and team credit all hold their ids.
    expect(await act(stub, ALICE, 7, brick(600, 600), 1, T)).toMatchObject({ ok: true });
    expect(await act(stub, BOB, 9, brick(750, 750, 9), 2, T + 2_000)).toMatchObject({ ok: true });
    expect(await act(stub, ALICE, 7, brick(700, 600, 5), 3, T + 3_000)).toMatchObject({ ok: true });
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    // Not yet: player ids are kept for 90 days after the end (ADR 0008).
    await tick(stub, T + HOUR + ID_RETENTION_MS - 60_000);
    expect((await stub.seasonStatus()).phase).toBe('ended');
    expect(await idsLeft(stub, name)).not.toEqual([]);
    // Checkpoint copies (writer ids that resolve to players until the purge) are there...
    expect(await listCopies(OPLOG, prefix(name))).not.toEqual([]);
    const standingsBefore = await stub.teamStandings();
    const sealedAt = await tickUntil(stub, T + HOUR + ID_RETENTION_MS, 'sealed');
    // The seal left the keyframe index owed: an alarm is set for the pass that rewrites it,
    // and that pass (no restart in between) says the frames are the season's for good.
    expect((await keyframesOf(name)).sealed).toBeUndefined();
    // What schedule() arms the alarm for once nothing else is due on a sealed canvas.
    const owed = await runInDurableObject(
      stub,
      (instance: CanvasDO) =>
        (instance as unknown as { keyframes: { indexOwed: boolean } }).keyframes.indexOwed,
    );
    expect(owed).toBe(true);
    expect(await pendingAlarm(stub)).not.toBeNull();
    await tick(stub, sealedAt + 60_000);
    expect(await keyframesOf(name)).toMatchObject({ final: true, sealed: true });
    // ...and go with the seal, as does the canvas's record of them.
    expect(await listCopies(OPLOG, prefix(name))).toEqual([]);
    expect(await sql(stub, "SELECT key FROM meta WHERE key = 'checkpoint_copy'")).toEqual([]);

    const archive = JSON.parse(
      await (await OPLOG.get(archiveKeys.season(prefix(name))))!.text(),
    ) as SeasonArchive;
    const finalSeq = (await stub.status()).seq;
    expect(archive).toMatchObject({ format: 1, finalSeq, removedOps: 0, players: 'pseudonym-v1' });
    expect(archive.archiveGridHash).toBe(archive.gridHash);
    // The archive's `who`: one 16-hex name per player, the same for both of Alice's ops; teams
    // of one player each are left out (ARCHIVE_TEAM_MIN_PLAYERS).
    const rows: Record<string, unknown>[] = [];
    for (const segment of archive.segments) {
      const lines = await ndjson(OPLOG, segment.key);
      expect(lines[0]).toMatchObject({ anonymised: true });
      rows.push(...lines.slice(1));
    }
    expect(rows.map((l) => l.seq)).toEqual(Array.from({ length: finalSeq }, (_, i) => i + 1));
    const who = rows.map((r) => (r.who as [string, number][])[0]!);
    expect(who.map(([, team]) => team)).toEqual([0, 0, 0]);
    expect(archive.teams).toEqual({ minPlayers: ARCHIVE_TEAM_MIN_PLAYERS, kept: 0, dropped: 2 });
    expect(who[0]![0]).toMatch(/^[0-9a-f]{16}$/);
    expect(who[0]![0]).toBe(who[2]![0]);
    expect(who[0]![0]).not.toBe(who[1]![0]);
    // Nothing left that names a player: SQLite tables, both checkpoints, R2 under c/.
    expect(await idsLeft(stub, name)).toEqual([]);
    expect(await sql(stub, 'SELECT player FROM inventory')).toHaveLength(0);
    expect(await sql(stub, 'SELECT player FROM team_credit')).toHaveLength(0);
    // The journal held dedupe keys and rows by player (ADR 0042), and memory forgot them too.
    expect(await sql(stub, 'SELECT n FROM state_journal')).toHaveLength(0);
    const kept = await runInDurableObject(
      stub,
      (instance: CanvasDO) =>
        (instance as unknown as { state: { keyTotal: number } }).state.keyTotal,
    );
    expect(kept).toBe(0);
    const writers = await sql<{ id: number; player: string }>(
      stub,
      'SELECT id, player FROM writers',
    );
    expect(writers.length).toBeGreaterThan(0);
    for (const w of writers) expect(w.player).toBe(`#${w.id}`);
    expect(await sql(stub, "SELECT key FROM meta WHERE key = 'seal_key'")).toHaveLength(0);
    // The ledger still counts the same: renaming writers changes no standing.
    expect(await stub.teamStandings()).toEqual(standingsBefore);
    await evictDurableObject(stub);
    expect(await stub.teamStandings()).toEqual(standingsBefore);
    // A sealed canvas never stores a player id again.
    await stub.holds([ALICE]);
    expect(await idsLeft(stub, name)).toEqual([]);
    // Sealing again is a no-op.
    await tick(stub, T + HOUR + ID_RETENTION_MS + HOUR);
    expect((await stub.seasonStatus()).phase).toBe('sealed');
  });

  it('deletes the checkpoint copies when a seal resumes after its archive is complete', async () => {
    const name = 'season-seal-copies';
    const stub = await canvas(name);
    expect(await place(stub, brick(600, 600), 1, T)).toMatchObject({ ok: true });
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    // An older copy too, as retention would have kept.
    const [final] = await listCopies(OPLOG, prefix(name));
    expect(final?.seq).toBe(1);
    const older = `${prefix(name)}/checkpoints/000000000000.ckpt`;
    await OPLOG.put(older, new Uint8Array([1]), { customMetadata: { writtenAt: '1' } });
    await stub.requestSeal();
    // The archive is written in full, then deleting the copies fails: not sealed yet.
    await withoutCopies(stub, 'delete', (instance) => instance.tick(T + HOUR + 600_000));
    expect((await stub.seasonStatus()).phase).toBe('ended');
    expect(await OPLOG.head(archiveKeys.season(prefix(name)))).not.toBeNull();
    expect((await listCopies(OPLOG, prefix(name))).length).toBe(2);
    // A restart: the seal resumes from the complete archive and deletes them then.
    await evictDurableObject(stub);
    await tickUntil(stub, T + HOUR + 1_200_000, 'sealed');
    expect(await listCopies(OPLOG, prefix(name))).toEqual([]);
    expect(await sql(stub, "SELECT key FROM meta WHERE key = 'checkpoint_copy'")).toEqual([]);
  });

  it('stays closing until the final checkpoint is copied', async () => {
    const name = 'season-close-copy';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await tick(stub, T);
    expect((await listCopies(OPLOG, prefix(name))).map((c) => c.seq)).toEqual([1]);
    await place(stub, brick(700, 600), 2, T + 1_000);
    await stub.setSchedule({ endsAt: T + HOUR });
    // Every other closing task succeeds; the copy of the final checkpoint keeps failing.
    await withoutCopies(stub, 'put', async (instance) => {
      for (let i = 0; i < 8; i++) await instance.tick(T + HOUR + i * 60_000);
    });
    const closing = await stub.seasonStatus();
    expect(closing).toMatchObject({ phase: 'closing', finalSeq: 2 });
    const [checkpoint] = await sql<{ value: string }>(
      stub,
      "SELECT value FROM meta WHERE key = 'checkpoint'",
    );
    expect(JSON.parse(checkpoint!.value).seq).toBe(2);
    expect((await listCopies(OPLOG, prefix(name))).map((c) => c.seq)).toEqual([1]);
    // Once a put goes through (after its backoff), closing ends with the copy at the last seq.
    await tickUntil(stub, T + 2 * HOUR, 'ended');
    expect((await listCopies(OPLOG, prefix(name)))[0]?.seq).toBe(2);
  });

  it('renames the players in op_log rows still in SQLite, teams kept', async () => {
    const stub = await canvas('season-tail');
    const tail = await runInDurableObject(stub, async (_, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO op_log (seq, ops, at, who) VALUES (90, '[{},{}]', 0, ?), (91, '[{}]', 0, NULL)",
        JSON.stringify([
          [ALICE, 7],
          [BOB, 0],
        ]),
      );
      const renamed = await renamedLogTail(sql, new Pseudonyms('11'.repeat(32)));
      purgePlayerData(sql, renamed);
      return sql.exec<{ seq: number; who: string | null }>('SELECT seq, who FROM op_log').toArray();
    });
    const who = JSON.parse(tail.find((r) => r.seq === 90)!.who!) as [string, number][];
    expect(who.map(([, team]) => team)).toEqual([7, 0]);
    expect(JSON.stringify(who)).not.toContain(ALICE);
    expect(who[0]![0]).toMatch(/^[0-9a-f]{16}$/);
    expect(tail.find((r) => r.seq === 91)!.who).toBeNull();
  });

  it('stops the seal, keeping player ids, when the raw log does not rebuild the final map', async () => {
    const name = 'season-tampered';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    // Someone rewrote the raw segment (its brick has another colour).
    const [raw] = (await OPLOG.list({ prefix: `${prefix(name)}/oplog/` })).objects;
    const original = await (await OPLOG.get(raw!.key))!.arrayBuffer();
    const lines = await ndjson(OPLOG, raw!.key);
    const row = lines[1]!;
    row.ops = (row.ops as string).replace('"color":3', '"color":4');
    const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
    await OPLOG.put(raw!.key, await gzip(new TextEncoder().encode(text)));
    await stub.requestSeal();
    await tick(stub, T + HOUR + 600_000);
    expect((await stub.seasonStatus()).phase).toBe('ended');
    // Nothing reached the locked prefix: it is checked before anything is written there.
    expect((await OPLOG.list({ prefix: `archive/${prefix(name)}/` })).objects).toHaveLength(0);
    expect(await sql(stub, 'SELECT player FROM inventory')).not.toHaveLength(0);
    // With the raw data repaired, the next attempt seals.
    await OPLOG.put(raw!.key, original);
    await tickUntil(stub, T + 2 * HOUR, 'sealed');
    expect(await OPLOG.head(archiveKeys.season(prefix(name)))).not.toBeNull();
  });

  it('replaces player ids in the archive by pseudonyms and strips the raw log', async () => {
    const name = 'season-ids';
    // Before the canvas starts: it reads the cap at start-up and keeps it for minutes.
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = await canvas(name);
    // Rows log `who`, [player, team] per op (ADR 0020).
    await act(stub, ALICE, 3, brick(600, 600), 1, T);
    await act(stub, BOB, 0, brick(700, 600), 2, T + 1_000);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    await stub.requestSeal();
    // The seal writes season.json, then fails deleting the raw segments it replaced, and the
    // object restarts: the retry must finish from the archive, not stall on the half-deleted log.
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const target = instance as unknown as { env: Env };
      const real = target.env;
      const failing = Object.create(OPLOG) as R2Bucket;
      failing.list = OPLOG.list.bind(OPLOG);
      failing.get = OPLOG.get.bind(OPLOG);
      failing.head = OPLOG.head.bind(OPLOG);
      failing.put = OPLOG.put.bind(OPLOG);
      failing.delete = async (keys: string | string[]) => {
        // Half of it goes through before the failure.
        await OPLOG.delete(([] as string[]).concat(keys).slice(0, 1));
        throw new Error('delete failed');
      };
      target.env = { ...real, OPLOG: failing };
      await instance.tick(T + HOUR + 600_000);
      target.env = real;
    });
    expect((await stub.seasonStatus()).phase).toBe('ended');
    expect(await OPLOG.head(archiveKeys.season(prefix(name)))).not.toBeNull();
    await evictDurableObject(stub);
    await tickUntil(stub, T + HOUR + 1_200_000, 'sealed');
    const archive = JSON.parse(
      await (await OPLOG.get(archiveKeys.season(prefix(name))))!.text(),
    ) as SeasonArchive;
    expect(archive.players).toBe('pseudonym-v1');
    const rows = (await ndjson(OPLOG, archive.segments[0]!.key)).slice(1);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(ALICE);
    expect(text).not.toContain(BOB);
    const who = rows.map((r) => (r.who as [string, number][])[0]!);
    expect(who[0]![0]).toMatch(/^[0-9a-f]{16}$/);
    expect(who[0]![0]).not.toBe(who[1]![0]);
    // Bob's team is 0: he is in none. Alice played alone for team 3, which would name her:
    // it is left out too (ARCHIVE_TEAM_MIN_PLAYERS).
    expect(who.map(([, team]) => team)).toEqual([0, 0]);
    expect(archive.teams).toEqual({ minPlayers: ARCHIVE_TEAM_MIN_PLAYERS, kept: 0, dropped: 1 });
    // The raw segments were replaced by a stripped copy with the same names, nothing removed.
    expect((await OPLOG.list({ prefix: `${prefix(name)}/oplog/` })).objects).toHaveLength(0);
    const stripped = await OPLOG.list({ prefix: `${prefix(name)}/oplog-stripped/` });
    expect(stripped.objects).toHaveLength(1);
    const [, ...plain] = await ndjson(OPLOG, stripped.objects[0]!.key);
    expect(JSON.stringify(plain)).not.toContain(ALICE);
    expect(plain.map((r) => JSON.parse(r.ops as string)[0].kind)).toEqual(['brick', 'brick']);
    expect(plain.map((r) => JSON.parse(r.who as string)[0])).toEqual(who);
    expect(await idsLeft(stub, name)).toEqual([]);
  });

  it('keeps a team beside the pseudonyms only with ten players among the ops it keeps', async () => {
    const name = 'season-small-teams';
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = await canvas(name);
    const BIG = 5;
    const SMALL = 6;
    let opId = 0;
    // Ten players for the big team; ten for the small one too, but a moderator removes the
    // only op of its last player, so the archive would show nine of them.
    for (let i = 0; i < ARCHIVE_TEAM_MIN_PLAYERS; i++) {
      opId += 1;
      const big = await act(stub, `big-${i}`, BIG, brick(520 + 4 * i, 600), opId, T + opId);
      expect(big).toMatchObject({ ok: true });
      opId += 1;
      const small = await act(stub, `small-${i}`, SMALL, brick(520 + 4 * i, 700), opId, T + opId);
      expect(small).toMatchObject({ ok: true });
    }
    // Players count, not ops: one of the big team's players playing again adds nobody.
    opId += 1;
    expect(await act(stub, 'big-0', BIG, brick(520, 640), opId, T + opId)).toMatchObject({
      ok: true,
    });
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    const { finalSeq } = await stub.seasonStatus();
    const last = 520 + 4 * (ARCHIVE_TEAM_MIN_PLAYERS - 1);
    const area = { x: last, y: 700, w: 2, h: 2 };
    expect(await stub.setRemovals([{ from: 1, to: finalSeq!, area }])).toEqual({ ok: true });
    await stub.requestSeal();
    await tickUntil(stub, T + HOUR + 600_000, 'sealed');
    const archive = JSON.parse(
      await (await OPLOG.get(archiveKeys.season(prefix(name))))!.text(),
    ) as SeasonArchive;
    expect(archive.removedOps).toBe(1);
    expect(archive.teams).toEqual({ minPlayers: ARCHIVE_TEAM_MIN_PLAYERS, kept: 1, dropped: 1 });
    const rows: Record<string, unknown>[] = [];
    for (const segment of archive.segments)
      rows.push(...(await ndjson(OPLOG, segment.key)).slice(1));
    const archived = rows.flatMap((r) => (r.who as [string, number][] | undefined) ?? []);
    // 21 ops, one removed: the big team's 11 keep their team, the small team's 9 have none.
    expect(archived).toHaveLength(2 * ARCHIVE_TEAM_MIN_PLAYERS);
    expect(archived.filter(([, team]) => team === BIG)).toHaveLength(ARCHIVE_TEAM_MIN_PLAYERS + 1);
    expect(archived.filter(([, team]) => team === 0)).toHaveLength(ARCHIVE_TEAM_MIN_PLAYERS - 1);
    // The stripped copy (nothing removed) names the small team nowhere either.
    const stripped = await OPLOG.list({ prefix: `${prefix(name)}/oplog-stripped/` });
    const plain: [string, number][] = [];
    for (const object of stripped.objects) {
      for (const row of (await ndjson(OPLOG, object.key)).slice(1)) {
        if (typeof row.who === 'string') plain.push(...(JSON.parse(row.who) as [string, number][]));
      }
    }
    expect(plain).toHaveLength(2 * ARCHIVE_TEAM_MIN_PLAYERS + 1);
    expect(new Set(plain.map(([, team]) => team))).toEqual(new Set([BIG, 0]));
  });

  it('never overwrites an archive object: one with other content stops the seal, the same content is kept', async () => {
    const name = 'season-locked';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    const key = archiveKeys.segment(prefix(name), 1, 1);
    await OPLOG.put(key, 'something else', { customMetadata: { sha256: 'not-this-one' } });
    await stub.requestSeal();
    await tick(stub, T + HOUR + 600_000);
    expect((await stub.seasonStatus()).phase).toBe('ended');
    expect(await (await OPLOG.get(key))!.text()).toBe('something else');
    // Player ids stay until the archive is really sealed.
    expect(await sql(stub, 'SELECT player FROM inventory')).not.toHaveLength(0);
    // Sealing has begun, so the removals are fixed, even after a restart forgets the job.
    await evictDurableObject(stub);
    const area = { x: 0, y: 0, w: 1, h: 1 };
    expect(await stub.setRemovals([{ from: 1, to: 1, area }])).toEqual({
      ok: false,
      reason: 'sealed',
    });
    // Once the object is the one the seal would write, the seal goes through and keeps it.
    await OPLOG.delete(key);
    await tickUntil(stub, T + HOUR + 1_200_000, 'sealed');
    const written = await OPLOG.head(key);
    await stub.setRemovals([]).then((r) => expect(r).toEqual({ ok: false, reason: 'sealed' }));
    expect(written).not.toBeNull();
    // About 2 s alone, all CPU (each seal attempt replays the season): five game runs in
    // parallel on an 8-core machine took it past 15 s.
  }, 60_000);

  it('logs every failed seal, and a distinct event once failures persist, keeping the backoff across a restart', async () => {
    const name = 'season-seal-alert';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    // An object with other content where the archive's segment goes: every attempt fails.
    const key = archiveKeys.segment(prefix(name), 1, 1);
    await OPLOG.put(key, 'something else', { customMetadata: { sha256: 'not-this-one' } });
    await stub.requestSeal();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const events = (spy: typeof errors, event: string) =>
      spy.mock.calls
        .map(([line]) => line as { event?: string } & Record<string, unknown>)
        .filter((line) => line?.event === event);
    // Every attempt replays the whole season: "stuck" from the third failure here, not the fifth.
    const stuckAfter = () =>
      runInDurableObject(stub, (instance: CanvasDO) => {
        (instance as unknown as { sealStuckAfter: number }).sealStuckAfter = 3;
      });
    await stuckAfter();
    try {
      // The wait doubles from MAINTAIN_MS (10 s): attempts at +0, +10, +30 and +70 s.
      // Maintenance itself runs at most every 10 s, so ticks stay at least that far apart.
      let at = T + HOUR + 600_000;
      for (let attempt = 1; attempt <= 3; attempt++) {
        // A pass before the wait is over tries nothing.
        if (attempt === 3) await tick(stub, at - 10_000);
        expect(events(errors, 'archive_seal_failed')).toHaveLength(attempt - 1);
        await tick(stub, at);
        expect(events(errors, 'archive_seal_failed')).toHaveLength(attempt);
        at += 10_000 * 2 ** (attempt - 1);
      }
      const last = events(errors, 'archive_seal_failed').at(-1)!;
      expect(last).toMatchObject({
        canvas: name,
        attempt: 3,
        failingForMs: 30_000,
        // Asked for early: the 90 days have not run out.
        overdueMs: 0,
        retryInMs: 40_000,
      });
      expect(last.error).toContain('other content');
      // Only the third failure in a row is "stuck"; no event names a player.
      expect(events(errors, 'archive_seal_stuck')).toEqual([
        { ...last, event: 'archive_seal_stuck' },
      ]);
      expect(JSON.stringify(errors.mock.calls.map(([line]) => line))).not.toContain('p1');

      // A restart keeps the count and the wait.
      await evictDurableObject(stub);
      await stuckAfter();
      await tick(stub, at - 20_000);
      expect(events(errors, 'archive_seal_failed')).toHaveLength(3);
      await tick(stub, at);
      expect(events(errors, 'archive_seal_stuck').at(-1)).toMatchObject({ attempt: 4 });

      // Repaired, the next attempt seals, says so, and the count is gone.
      await OPLOG.delete(key);
      await tickUntil(stub, at + 80_000, 'sealed');
      expect(events(logs, 'archive_sealed')).toEqual([expect.objectContaining({ canvas: name })]);
      expect(await sql(stub, "SELECT key FROM meta WHERE key = 'seal_failures'")).toEqual([]);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
    // About 4 s alone, all CPU (five seal attempts, each replaying a full-map season).
  }, 60_000);

  it('keeps counting failures across good steps when a seal of several steps fails late', async () => {
    const name = 'season-seal-late';
    const stub = await canvas(name);
    // Two raw segments: one shipped with the first checkpoint, one when the season closes.
    await place(stub, brick(600, 600), 1, T);
    await tick(stub, T);
    await place(stub, brick(700, 600, 5), 2, T + 1_000);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    const raws = (await OPLOG.list({ prefix: `${prefix(name)}/oplog/` })).objects;
    expect(raws).toHaveLength(2);
    // The last segment's brick has another colour: its replay misses the final map, which only
    // the last step finds out. Every attempt is then a good step, then a failing one.
    const last = raws.at(-1)!.key;
    const lines = await ndjson(OPLOG, last);
    lines[1]!.ops = (lines[1]!.ops as string).replace('"color":5', '"color":6');
    const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
    await OPLOG.put(last, await gzip(new TextEncoder().encode(text)));
    // One segment per step (25 by default), "stuck" from the third failure (5 by default).
    await runInDurableObject(stub, (instance: CanvasDO) => {
      Object.assign(instance, { sealSegmentsPerStep: 1, sealStuckAfter: 3 });
    });
    await stub.requestSeal();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Passes 10 s apart (MAINTAIN_MS): long enough for the backoff of 10, 20, then 40 s.
      for (let i = 0; i < 20; i++) await tick(stub, T + HOUR + 600_000 + i * 10_000);
      const lines = errors.mock.calls.map(([line]) => line as Record<string, unknown>);
      const failed = lines.filter((l) => l?.event === 'archive_seal_failed');
      // The count climbs (it went back to 1 after every good step before) and the wait grows.
      expect(failed.slice(0, 3).map((l) => l.attempt)).toEqual([1, 2, 3]);
      expect(failed.slice(0, 3).map((l) => l.retryInMs)).toEqual([10_000, 20_000, 40_000]);
      expect(failed[0]!.error).toContain('does not reach the final map');
      const stuck = lines.filter((l) => l?.event === 'archive_seal_stuck');
      expect(stuck.length).toBe(failed.length - 2);
      expect(stuck[0]).toMatchObject({ attempt: 3 });
      expect((await stub.seasonStatus()).phase).toBe('ended');
    } finally {
      errors.mockRestore();
    }
  }, 60_000);

  it('never logs the text of a damaged raw row, which may hold player ids', async () => {
    const name = 'season-seal-garbled';
    // Short, so the few characters JSON.parse quotes around its error take all of it.
    const PLAYER = 'zq9';
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = await canvas(name);
    await act(stub, PLAYER, 3, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    const [raw] = (await OPLOG.list({ prefix: `${prefix(name)}/oplog/` })).objects;
    const plain = new TextDecoder().decode(
      await gunzip(new Uint8Array(await (await OPLOG.get(raw!.key))!.arrayBuffer())),
    );
    // A stray character before the row's `who`: JSON.parse's message quotes the id next to it.
    const garbled = plain.replace('"who":"', '"who":x"');
    expect(garbled).not.toBe(plain);
    const row = garbled.split('\n')[1]!;
    expect(() => JSON.parse(row)).toThrow(PLAYER);
    await OPLOG.put(raw!.key, await gzip(new TextEncoder().encode(garbled)));
    await stub.requestSeal();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await tick(stub, T + HOUR + 600_000);
      const lines = errors.mock.calls.map(([line]) => line as Record<string, unknown>);
      expect(lines.find((l) => l?.event === 'archive_seal_failed')).toMatchObject({
        error: expect.stringContaining('SyntaxError'),
      });
      const logged = errors.mock.calls
        .flat()
        .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg)))
        .join('\n');
      expect(logged).not.toContain(PLAYER);
    } finally {
      errors.mockRestore();
    }
  });

  it('logs archive_seal_no_bucket, naming only the canvas, for a seal without the log bucket', async () => {
    const name = 'season-seal-no-bucket';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    await stub.requestSeal();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance: CanvasDO) => {
        const target = instance as unknown as { env: Env };
        const real = target.env;
        target.env = { ...real, OPLOG: undefined };
        await instance.tick(T + HOUR + 600_000);
        target.env = real;
      });
      const events = errors.mock.calls
        .map(([line]) => line as Record<string, unknown>)
        .filter((l) => l?.event === 'archive_seal_no_bucket');
      expect(events).toEqual([{ event: 'archive_seal_no_bucket', canvas: name }]);
      expect((await stub.seasonStatus()).phase).toBe('sealed');
    } finally {
      errors.mockRestore();
    }
  });

  it('counts a purge that throws after the archive as a seal failure, quoting no id', async () => {
    const name = 'season-purge-fails';
    const PLAYER = 'zq8';
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = await canvas(name);
    await act(stub, PLAYER, 3, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    await stub.requestSeal();
    // A damaged row left in SQLite: the purge reads every row's ops, and JSON.parse's message
    // would quote the id beside the damage.
    const ops = `[{"kind":x"${PLAYER}"}]`;
    expect(() => JSON.parse(ops)).toThrow(PLAYER);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        'INSERT INTO op_log (seq, ops, at, who) VALUES (0, ?, 0, ?)',
        ops,
        `[["${PLAYER}",3]]`,
      );
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await tick(stub, T + HOUR + 600_000);
      // The archive is written; the purge failed, was counted and will be retried.
      expect(await OPLOG.head(archiveKeys.season(prefix(name)))).not.toBeNull();
      expect((await stub.seasonStatus()).phase).toBe('ended');
      const lines = errors.mock.calls.map(([line]) => line as Record<string, unknown>);
      expect(lines.find((l) => l?.event === 'archive_seal_failed')).toMatchObject({
        canvas: name,
        attempt: 1,
        error: expect.stringContaining('SyntaxError'),
      });
      const logged = errors.mock.calls
        .flat()
        .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg)))
        .join('\n');
      expect(logged).not.toContain(PLAYER);
      // Repaired, the next pass finds the archive complete, purges and seals.
      await runInDurableObject(stub, (_, state) => {
        state.storage.sql.exec('DELETE FROM op_log WHERE seq = 0');
      });
      await tick(stub, T + HOUR + 610_000);
      expect((await stub.seasonStatus()).phase).toBe('sealed');
      expect(
        logs.mock.calls.some(([l]) => (l as { event?: string })?.event === 'archive_sealed'),
      ).toBe(true);
      expect(await sql(stub, "SELECT key FROM meta WHERE key = 'seal_failures'")).toEqual([]);
      expect(await idsLeft(stub, name)).toEqual([]);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it('starts, and keeps counting, with a damaged seal failure count', async () => {
    const name = 'season-seal-count-damaged';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    const key = archiveKeys.segment(prefix(name), 1, 1);
    await OPLOG.put(key, 'something else', { customMetadata: { sha256: 'not-this-one' } });
    await stub.requestSeal();
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('seal_failures', '{not json')",
      );
    });
    // A restart reads it: the canvas still starts, and takes it as one failure so far.
    await evictDurableObject(stub);
    expect((await stub.seasonStatus()).phase).toBe('ended');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await tick(stub, T + HOUR + 600_000);
      const failed = errors.mock.calls
        .map(([line]) => line as Record<string, unknown>)
        .filter((l) => l?.event === 'archive_seal_failed');
      // As docs/ops/alerts.md says: the backoff starts over, and `failingForMs` counts from
      // this failure, not from the first one.
      expect(failed).toEqual([
        expect.objectContaining({ attempt: 2, retryInMs: 20_000, failingForMs: 0 }),
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it('puts archive objects only where none is, enforced by R2', async () => {
    const key = 'archive/c/put-if-absent/season.json';
    const first = new TextEncoder().encode('first');
    expect(await putIfAbsent(OPLOG, key, first, {})).toBe(true);
    expect(await putIfAbsent(OPLOG, key, new TextEncoder().encode('second'), {})).toBe(false);
    expect(await (await OPLOG.get(key))!.text()).toBe('first');
  });

  it("records a removal made while open as never reaching past the season's last seq", async () => {
    const name = 'season-removal-clamp';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await place(stub, brick(700, 600, 5), 2, T + 1_000);
    // While open, an admin may name later seqs than there are so far.
    const area = { x: 590, y: 590, w: 20, h: 20 };
    // One that starts past where the season will end covers nothing and is left out.
    const beyond = { from: 10, to: 50, area: { x: 0, y: 0, w: 1024, h: 1024 } };
    expect(await stub.setRemovals([{ from: 1, to: 50, area }, beyond])).toEqual({ ok: true });
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    await stub.requestSeal();
    await tickUntil(stub, T + HOUR + 600_000, 'sealed');
    const archive = JSON.parse(
      await (await OPLOG.get(archiveKeys.season(prefix(name))))!.text(),
    ) as SeasonArchive;
    expect(archive.finalSeq).toBe(2);
    expect(archive.removals).toEqual([{ from: 1, to: 2, area }]);
    expect(archive.removedOps).toBe(1);
  });

  it('applies moderation removals to the archive and rewrites the keyframes under a new revision', async () => {
    const name = 'season-removals';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await tick(stub, T + 1_000);
    await place(stub, brick(600, 400, 7), 2, T + HOUR);
    await tick(stub, T + HOUR);
    await place(stub, brick(700, 600, 5), 3, T + 2 * HOUR);
    await stub.setSchedule({ endsAt: T + 3 * HOUR });
    await tickUntil(stub, T + 3 * HOUR, 'ended');
    const before = await keyframesOf(name);
    expect(before.revision).toBe(0);
    expect(before.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    // The brick at (600, 400) is removed by a moderator.
    const area = { x: 590, y: 390, w: 20, h: 20 };
    expect(await stub.setRemovals([{ from: 2, to: 2, area }])).toEqual({ ok: true });
    await stub.requestSeal();
    await tickUntil(stub, T + 3 * HOUR + 600_000, 'sealed');
    const archive = JSON.parse(
      await (await OPLOG.get(archiveKeys.season(prefix(name))))!.text(),
    ) as SeasonArchive;
    expect(archive.removedOps).toBe(1);
    expect(archive.archiveGridHash).not.toBe(archive.gridHash);
    const rows: Record<string, unknown>[] = [];
    for (const segment of archive.segments)
      rows.push(...(await ndjson(OPLOG, segment.key)).slice(1));
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.find((r) => r.seq === 2)!.ops).toEqual([]);
    // The keyframes no longer show the removed brick.
    const after = await keyframesOf(name);
    expect(after.revision).toBe(1);
    // Tile (2, 1) held only the removed brick: never written in the new revision.
    expect(before.frames.at(-1)!.tiles[1 * PER_ROW + 2]).toBe(2);
    expect(after.frames.map((f) => f.tiles[1 * PER_ROW + 2])).toEqual([0, 0, 0]);
    // Tile (2, 2) is rewritten under revision 1 with the bricks that stay.
    const version = after.frames.at(-1)!.tiles[2 * PER_ROW + 2]!;
    const key = cdnKeys.keyframeTile(prefix(name), 1, 2, 2, version);
    const decoded = decodeTile(
      await gunzip(new Uint8Array(await (await TILES.get(key))!.arrayBuffer())),
    );
    expect(decoded.cells[(600 % 256) * 256 + (600 % 256)]).not.toBe(0);
    // Every tile of the old revision is garbage now, or already collected.
    const garbage = new Set(
      (await sql<{ key: string }>(stub, 'SELECT key FROM cdn_garbage')).map((g) => g.key),
    );
    for (const frame of before.frames) {
      for (const [tile, v] of frame.tiles.entries()) {
        if (v !== frame.seq) continue;
        const tx = tile % PER_ROW;
        const old = cdnKeys.keyframeTile(prefix(name), 0, tx, (tile - tx) / PER_ROW, v);
        expect(garbage.has(old) || (await TILES.head(old)) === null, old).toBe(true);
      }
    }
    // Every frame has an overview, in each revision; the new ones leave the brick out too.
    const factor = overviewFactor(DEFAULT_MAP_SIZE);
    expect(before.overviews).toEqual({ factor, from: 1 });
    expect(after.overviews).toEqual({ factor, from: 1 });
    const overviewAt = async (revision: number, seq: number) =>
      decodeOverview(
        await gunzip(
          new Uint8Array(
            await (await TILES.get(
              cdnKeys.keyframeOverview(prefix(name), revision, seq),
            ))!.arrayBuffer(),
          ),
        ),
      );
    const last = after.frames.at(-1)!.seq;
    const rewritten = await overviewAt(1, last);
    const pixel = (x: number, y: number) => (y / factor) * rewritten.side + x / factor;
    expect(rewritten.colors[pixel(600, 400)]).toBe(0);
    expect(rewritten.colors[pixel(600, 600)]).not.toBe(0);
    for (const frame of before.frames) {
      const old = cdnKeys.keyframeOverview(prefix(name), 0, frame.seq);
      expect(garbage.has(old) || (await TILES.head(old)) === null, old).toBe(true);
    }
  });

  it("leaves a rollback's ops out of the archive, names its player by pseudonym, and reaches the live map", async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const name = 'season-rollback';
    const stub = await canvas(name);
    expect(await act(stub, ALICE, 7, brick(600, 600), 1, T)).toMatchObject({ ok: true });
    expect(await act(stub, ALICE, 7, brick(602, 600, 5), 2, T + 1_000)).toMatchObject({ ok: true });
    await tick(stub, T + 2_000);
    // Bob hammers Alice's brick, then builds elsewhere; both are rolled back.
    await stock(stub, BOB, [{ kind: 'hammer' }]);
    const hit = await stub.applyBatch(
      [{ player: BOB, opId: 3, op: { kind: 'hammer', x: 601, y: 601 }, team: 9 }],
      T + 3_000,
    );
    expect(hit.results[0]!.ok).toBe(true);
    expect(await act(stub, BOB, 9, brick(750, 750, 9), 4, T + 4_000)).toMatchObject({ ok: true });
    expect(await act(stub, ALICE, 7, brick(700, 600, 5), 5, T + 5_000)).toMatchObject({ ok: true });
    let status = await stub.rollbackPreview({ player: BOB });
    for (let i = 0; status.state === 'running' && i < 50; i++) {
      status = await stub.rollbackPreview({ player: BOB });
    }
    if (status.state !== 'ready') throw new Error(JSON.stringify(status));
    expect(status.preview).toMatchObject({ removedOps: 2, cells: 7 });
    expect(await stub.rollbackApply(status.preview.job)).toMatchObject({ ok: true });
    // An archive-only removal and a lock that name a player in moderators' own fields: the
    // seal renames the one and drops the other.
    const corner = { x: 0, y: 0, w: 1, h: 1 };
    expect(await stub.setRemovals([{ from: 1, to: 1, area: corner, player: ALICE }])).toEqual({
      ok: true,
    });
    expect(await stub.lockArea({ area: corner, note: `raid by ${ALICE}` })).toMatchObject({
      ok: true,
    });
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    await stub.requestSeal();
    await tickUntil(stub, T + HOUR + 600_000, 'sealed');

    const archive = JSON.parse(
      await (await OPLOG.get(archiveKeys.season(prefix(name))))!.text(),
    ) as SeasonArchive;
    // The archive without Bob's ops is the live map: the restore row did the same live.
    expect(archive.archiveGridHash).toBe(archive.gridHash);
    expect(archive).toMatchObject({ removedOps: 2, restoresLeftOut: 1 });
    expect(archive.removals).toHaveLength(2);
    const [removal, manual] = archive.removals;
    expect(manual!.player).toMatch(/^[0-9a-f]{16}$/);
    const after = await stub.seasonStatus();
    expect(after.removals[0]!.player).toBe(manual!.player);
    expect((await stub.areaLocks()).locks).toEqual([]);
    expect(removal).toMatchObject({
      from: 1,
      to: 5,
      area: { x: 0, y: 0, w: DEFAULT_MAP_SIZE, h: DEFAULT_MAP_SIZE },
    });
    expect(removal!.player).toMatch(/^[0-9a-f]{16}$/);
    const rows: Record<string, unknown>[] = [];
    for (const segment of archive.segments)
      rows.push(...(await ndjson(OPLOG, segment.key)).slice(1));
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.find((r) => r.seq === 3)!.ops).toEqual([]);
    expect(rows.find((r) => r.seq === 6)).toMatchObject({ ops: [], restored: 7 });
    // The canvas's record of the rollback names Bob by the same pseudonym, and no id is left
    // anywhere, the restore row's writers included.
    expect((await stub.seasonStatus()).rollbacks[0]!.player).toBe(removal!.player);
    expect(await idsLeft(stub, name)).toEqual([]);
  });

  it("moves the archive's clock for a removed op, so it still reaches the live map", async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const name = 'season-rollback-time';
    const stub = await canvas(name);
    const LIFE = 48 * HOUR;
    expect(await act(stub, ALICE, 7, brick(600, 600), 1, T)).toMatchObject({ ok: true });
    // Bob's brick is the latest op; Alice's shield after it is logged a second earlier, so the
    // live map placed its layer at Bob's time, and it outlives a sweep one layer-life after
    // the logged time.
    expect(await act(stub, BOB, 9, brick(750, 750, 9), 2, T + 2_000)).toMatchObject({ ok: true });
    await stock(stub, ALICE, [{ kind: 'shield' }]);
    const shielded = await stub.applyBatch(
      [{ player: ALICE, opId: 3, op: { kind: 'shield', x: 600, y: 600 }, team: 7 }],
      T + 1_000,
    );
    expect(shielded.results[0]!.ok).toBe(true);
    let status = await stub.rollbackPreview({ player: BOB });
    for (let i = 0; status.state === 'running' && i < 50; i++) {
      status = await stub.rollbackPreview({ player: BOB });
    }
    if (status.state !== 'ready') throw new Error(JSON.stringify(status));
    expect(await stub.rollbackApply(status.preview.job)).toMatchObject({ ok: true });
    expect(await act(stub, ALICE, 7, brick(700, 600, 5), 4, T + 1_000 + LIFE + 500)).toMatchObject({
      ok: true,
    });
    expect((await stub.snapshot()).shields[600 * DEFAULT_MAP_SIZE + 600]).toBe(1);
    await stub.setSchedule({ endsAt: T + LIFE + 10_000 });
    await tickUntil(stub, T + LIFE + 10_000, 'ended');
    await stub.requestSeal();
    await tickUntil(stub, T + LIFE + 610_000, 'sealed');
    const archive = JSON.parse(
      await (await OPLOG.get(archiveKeys.season(prefix(name))))!.text(),
    ) as SeasonArchive;
    expect(archive).toMatchObject({ removedOps: 1, restoresLeftOut: 1 });
    expect(archive.archiveGridHash).toBe(archive.gridHash);
  });

  it('stops a seal with removals when the full replay does not rebuild the final map', async () => {
    const name = 'season-removals-tampered';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await place(stub, brick(700, 600), 2, T + 1_000);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    const [raw] = (await OPLOG.list({ prefix: `${prefix(name)}/oplog/` })).objects;
    const lines = await ndjson(OPLOG, raw!.key);
    const row = lines[2]!;
    row.ops = (row.ops as string).replace('"color":3', '"color":4');
    await OPLOG.put(
      raw!.key,
      await gzip(new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)),
    );
    await stub.setRemovals([{ from: 1, to: 1, area: { x: 600, y: 600, w: 1, h: 1 } }]);
    await stub.requestSeal();
    await tick(stub, T + HOUR + 600_000);
    expect((await stub.seasonStatus()).phase).toBe('ended');
    expect((await OPLOG.list({ prefix: `archive/${prefix(name)}/` })).objects).toHaveLength(0);
  });

  it('deletes op_log rows already shipped when it seals', async () => {
    const name = 'season-shipped-rows';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    // A shipped row still in SQLite (trimming had not run yet when the seal came).
    const [raw] = (await OPLOG.list({ prefix: `${prefix(name)}/oplog/` })).objects;
    const [, row] = await ndjson(OPLOG, raw!.key);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        'INSERT INTO op_log (seq, ops, at, who) VALUES (?, ?, ?, ?)',
        row!.seq as number,
        row!.ops as string,
        row!.at as number,
        (row!.who as string | null) ?? null,
      );
    });
    expect(await sql(stub, 'SELECT seq FROM op_log')).toHaveLength(1);
    await stub.requestSeal();
    await tickUntil(stub, T + HOUR + 600_000, 'sealed');
    expect(await sql(stub, 'SELECT seq FROM op_log')).toHaveLength(0);
  });

  it('holds one replay of the map at a time while sealing: the copy starts its own after the check', async () => {
    const name = 'season-one-replay';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    await stub.requestSeal();
    const seen = await runInDurableObject(stub, async (instance: CanvasDO) => {
      type Job = { verifying: unknown; state: unknown };
      const target = instance as unknown as { env: Env; sealJob: Job | null };
      const real = target.env;
      // Which replays exist each time the job reads a raw segment: once to check, once to copy.
      const replays: [boolean, boolean][] = [];
      const watching = Object.create(OPLOG) as R2Bucket;
      watching.list = OPLOG.list.bind(OPLOG);
      watching.head = OPLOG.head.bind(OPLOG);
      watching.put = OPLOG.put.bind(OPLOG);
      watching.delete = OPLOG.delete.bind(OPLOG);
      watching.get = (async (key: string) => {
        const job = target.sealJob;
        if (job && key.includes('/oplog/')) replays.push([job.verifying !== null, !!job.state]);
        return OPLOG.get(key);
      }) as R2Bucket['get'];
      target.env = { ...real, OPLOG: watching };
      await instance.tick(T + HOUR + 600_000);
      target.env = real;
      return replays;
    });
    // Checking: only the check's replay. Copying: the check's is gone.
    expect(seen).toEqual([
      [true, false],
      [false, false],
    ]);
    expect((await stub.seasonStatus()).phase).toBe('sealed');
  });

  it('stops the copy when a raw segment changes after it was verified', async () => {
    const name = 'season-changed-midway';
    const stub = await canvas(name);
    await place(stub, brick(600, 600), 1, T);
    await stub.setSchedule({ endsAt: T + HOUR });
    await tickUntil(stub, T + HOUR, 'ended');
    const [raw] = (await OPLOG.list({ prefix: `${prefix(name)}/oplog/` })).objects;
    // Same rows, other bytes: what a swap between the two passes looks like to the copy.
    const lines = await ndjson(OPLOG, raw!.key);
    const swapped = await gzip(
      new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n\n`),
    );
    await stub.requestSeal();
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const target = instance as unknown as { env: Env };
      const real = target.env;
      let reads = 0;
      const swapping = Object.create(OPLOG) as R2Bucket;
      swapping.list = OPLOG.list.bind(OPLOG);
      swapping.head = OPLOG.head.bind(OPLOG);
      swapping.put = OPLOG.put.bind(OPLOG);
      swapping.delete = OPLOG.delete.bind(OPLOG);
      swapping.get = (async (key: string) => {
        // The first read (verification) sees the stored bytes, the second (copy) others.
        if (key === raw!.key && reads++ > 0) await OPLOG.put(key, swapped);
        return OPLOG.get(key);
      }) as R2Bucket['get'];
      target.env = { ...real, OPLOG: swapping };
      await instance.tick(T + HOUR + 600_000);
      target.env = real;
    });
    expect((await stub.seasonStatus()).phase).toBe('ended');
    expect((await OPLOG.list({ prefix: `archive/${prefix(name)}/` })).objects).toHaveLength(0);
  });
});

describe('long seals', () => {
  it('keeps rewritten keyframe tiles through a seal that spans hours of garbage collection', async () => {
    const name = 'season-long-seal';
    const stub = await canvas(name);
    // One raw segment per op: a checkpoint (and a shipment) every 61 s of activity.
    const ops = SEAL_SEGMENTS_PER_STEP + 2;
    for (let i = 0; i < ops; i++) {
      expect(await place(stub, brick(520 + 4 * i, 600), i + 1, T + i)).toMatchObject({
        ok: true,
      });
      await tick(stub, T + i * 61_000);
    }
    await stub.setSchedule({ endsAt: T + HOUR - 1 });
    const ended = await tickUntil(stub, T + HOUR, 'ended');
    expect((await OPLOG.list({ prefix: `${prefix(name)}/oplog/` })).objects.length).toBe(ops);
    await stub.setRemovals([{ from: 2, to: 2, area: { x: 524, y: 600, w: 1, h: 1 } }]);
    await stub.requestSeal();
    // Two seal steps, hours apart: collection runs in between.
    let at = ended + 60_000;
    for (let i = 0; i < 5 && (await stub.seasonStatus()).phase !== 'sealed'; i++) {
      await tick(stub, at);
      at += 2 * HOUR;
    }
    expect((await stub.seasonStatus()).phase).toBe('sealed');
    await tick(stub, at + 2 * HOUR);
    const index = await keyframesOf(name);
    expect(index.revision).toBe(1);
    const perRow = index.size / index.tileSize;
    for (const frame of index.frames) {
      for (const [tile, version] of frame.tiles.entries()) {
        if (version !== frame.seq) continue;
        const tx = tile % perRow;
        const key = cdnKeys.keyframeTile(prefix(name), 1, tx, (tile - tx) / perRow, version);
        expect(await TILES.head(key), key).not.toBeNull();
      }
    }
  }, 60_000);
});

describe('keyframes', () => {
  it('cuts a frame per hour of activity, writing only the tiles that changed', async () => {
    const name = 'keyframes';
    const stub = await canvas(name);
    const t0 = T + 10 * HOUR;
    await place(stub, brick(600, 600), 1, T);
    await tick(stub, t0);
    const first = await keyframesOf(name);
    expect(first).toMatchObject({
      revision: 0,
      final: false,
      size: DEFAULT_MAP_SIZE,
      tileSize: TILE_SIZE,
    });
    expect(first.frames).toHaveLength(1);
    const tile = 2 * PER_ROW + 2;
    expect(first.frames[0]!.tiles[tile]).toBe(1);
    expect(first.frames[0]!.tiles.filter((v) => v > 0)).toHaveLength(1);
    // Another change in another tile within the hour: no frame until the next hour starts.
    await place(stub, brick(400, 600), 2, T + 1_000);
    await tick(stub, t0 + 20 * 60_000);
    expect((await keyframesOf(name)).frames).toHaveLength(1);
    await tick(stub, t0 + HOUR);
    const second = await keyframesOf(name);
    expect(second.frames).toHaveLength(2);
    const frame = second.frames[1]!;
    expect(frame.seq).toBe(2);
    // The unchanged tile keeps its first version; only the new one was written.
    expect(frame.tiles[tile]).toBe(1);
    expect(frame.tiles[2 * PER_ROW + 1]).toBe(2);
    const object = await TILES.get(cdnKeys.keyframeTile(prefix(name), 0, 1, 2, 2));
    expect(object?.httpMetadata?.cacheControl).toContain('immutable');
    expect(await TILES.head(cdnKeys.keyframeTile(prefix(name), 0, 2, 2, 2))).toBeNull();
    // Idle: no frame, no alarm for one.
    await tick(stub, t0 + 3 * HOUR);
    expect((await keyframesOf(name)).frames).toHaveLength(2);
  });
});
