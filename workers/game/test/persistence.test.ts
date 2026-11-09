import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  applyEntry,
  type CoreConfig,
  createState,
  DEFAULT_MAP_SIZE,
  encodeCheckpoint,
  gridHash,
  type Item,
  type LogEntry,
  type Op,
  type State,
  TILE_SIZE,
} from '@brickplace/core';
import {
  cdnKeys,
  decodeOverview,
  decodeSegment,
  decodeTile,
  encodeOverview,
  type Manifest,
  overviewFactor,
  parseKeyframes,
  parseManifest,
} from '@brickplace/protocol/cdn';
import { describe, expect, it } from 'vitest';
import {
  gunzip,
  loadCheckpoint,
  prepareCheckpoint,
  readCheckpointMeta,
  storeCheckpoint,
} from '../src/checkpoints.ts';
import type { CanvasDO, Env } from '../src/index.ts';
import { foldNow, STATE_FOLD_MS } from '../src/journal.ts';
import { KEYFRAME_MS } from '../src/keyframes.ts';
import { logKey } from '../src/oplog.ts';
import { type CdnPublisher, GARBAGE_GRACE, RECENT_SEGMENTS, SEGMENT_MS } from '../src/publish.ts';
import { ALARM_DEFERRAL, pendingAlarm } from './alarms.ts';

const { CANVAS, OPLOG, TILES } = env as unknown as Required<Env>;
type Stub = ReturnType<typeof CANVAS.get>;
const O: Item = { kind: 'brick', shape: 1 };
const SHIELD: Item = { kind: 'shield' };
const HAMMER: Item = { kind: 'hammer' };
const NEVER = 2 ** 50;
const HOUR = 3_600_000;
/** Tiles in a row of the default map; tile (tx, ty) is at ty * PER_ROW + tx in the manifest. */
const PER_ROW = DEFAULT_MAP_SIZE / TILE_SIZE;

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

/** Applies ops one batch each, player p1, opIds from `first`, at the given times. */
async function play(stub: Stub, ops: readonly { op: Op; at: number }[], first: number) {
  const items = ops.map(({ op }): Item => (op.kind === 'brick' ? O : ({ kind: op.kind } as Item)));
  await stock(stub, 'p1', items);
  for (const [i, { op, at }] of ops.entries()) {
    const { results } = await stub.applyBatch([{ player: 'p1', opId: first + i, op }], at);
    expect(results[0]!.ok, JSON.stringify(op)).toBe(true);
  }
}

const brick = (x: number, y: number, color = 3): Op => ({
  kind: 'brick',
  x,
  y,
  shape: 1,
  rotation: 0,
  color,
});

/** A few bricks in two tiles, shields that expire, and a hammer, over a few hours. */
const OPS: { op: Op; at: number }[] = [
  { op: brick(600, 600), at: 1_000 },
  { op: brick(700, 600, 5), at: 2_000 },
  { op: { kind: 'shield', x: 600, y: 600 }, at: 3_000 },
  { op: { kind: 'shield', x: 700, y: 600 }, at: HOUR },
  { op: brick(600, 400, 7), at: 2 * HOUR },
  { op: { kind: 'hammer', x: 601, y: 600 }, at: 3 * HOUR },
];

const tick = (stub: Stub, now: number) =>
  runInDurableObject(stub, (instance: CanvasDO) => instance.tick(now));

const sqlOne = <T>(stub: Stub, query: string) =>
  runInDurableObject(stub, (_, state) => state.storage.sql.exec(query).toArray() as T[]);

/** Byte equality of two grids or encoded objects; toEqual on large arrays takes seconds. */
function expectSame(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  let first = -1;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      first = i;
      break;
    }
  }
  expect(first, 'first differing cell').toBe(-1);
}

/** The private parts tests reach into. */
type Internals = { grid: State; seq: number; cdn: CdnPublisher; env: Env };
const inside = (instance: CanvasDO) => instance as unknown as Internals;

/** Makes the canvas's public bucket refuse every write until `restore` is called. */
function breakTiles(instance: CanvasDO): () => void {
  return swapTiles(instance, () => ({
    put: async () => {
      throw new Error('TILES is down');
    },
  }));
}

/**
 * Puts a stand-in in front of the canvas's public bucket until `restore` is called. What the
 * stand-in leaves out (get, list, delete) goes to the real bucket.
 */
function swapTiles(
  instance: CanvasDO,
  make: (real: R2Bucket) => Partial<Pick<R2Bucket, 'put' | 'delete'>>,
): () => void {
  const cdn = inside(instance).cdn as unknown as { bucket: R2Bucket };
  const real = cdn.bucket;
  cdn.bucket = {
    put: real.put.bind(real),
    delete: real.delete.bind(real),
    ...make(real),
  } as unknown as R2Bucket;
  return () => {
    cdn.bucket = real;
  };
}

const prefix = (name: string) => `c/${name}`;

/** Every op the canvas ever accepted, read back from R2 and the untrimmed log, in order. */
async function history(stub: Stub, name: string): Promise<{ op: LogEntry; at: number }[]> {
  type Row = { seq: number; ops: string; at: number };
  // SQLite first, then R2, merged by seq: a real alarm may ship and trim rows between the two
  // reads, and a row leaves SQLite only once it is in R2, so this order misses none.
  const bySeq = new Map<number, Row>();
  for (const row of await sqlOne<Row>(stub, 'SELECT * FROM op_log ORDER BY seq')) {
    bySeq.set(row.seq, row);
  }
  const listed = await OPLOG.list({ prefix: `${prefix(name)}/oplog/` });
  for (const object of listed.objects) {
    const body = await OPLOG.get(object.key);
    const text = new TextDecoder().decode(await gunzip(new Uint8Array(await body!.arrayBuffer())));
    const [header, ...lines] = text.trimEnd().split('\n');
    expect(JSON.parse(header!)).toMatchObject({ format: 1 });
    for (const line of lines) {
      const row = JSON.parse(line) as Row;
      bySeq.set(row.seq, row);
    }
  }
  const rows = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
  return rows.flatMap((row) =>
    (JSON.parse(row.ops) as LogEntry[]).map((op) => ({ op, at: row.at })),
  );
}

async function configOf(stub: Stub): Promise<CoreConfig> {
  const [row] = await sqlOne<{ value: string }>(
    stub,
    "SELECT value FROM meta WHERE key = 'config'",
  );
  return JSON.parse(row!.value) as CoreConfig;
}

/** What a spectator sees: the manifest's tiles, then its segments applied on top. */
async function spectate(
  name: string,
): Promise<{ manifest: Manifest; cells: Uint8Array; shields: Uint8Array }> {
  const manifest = parseManifest(await (await TILES.get(cdnKeys.manifest(prefix(name))))!.text());
  const { size, tileSize } = manifest;
  const perRow = size / tileSize;
  const cells = new Uint8Array(size * size);
  const shields = new Uint8Array(size * size);
  const versions = new Map<number, number>();
  for (const [tile, version] of manifest.tiles.entries()) {
    versions.set(tile, version);
    if (version === 0) continue;
    const tx = tile % perRow;
    const ty = (tile - tx) / perRow;
    const object = await TILES.get(cdnKeys.tile(prefix(name), tx, ty, version));
    expect(object?.httpMetadata?.cacheControl).toContain('immutable');
    const t = decodeTile(await gunzip(new Uint8Array(await object!.arrayBuffer())));
    expect(t).toMatchObject({ tx, ty, seq: version, edge: tileSize });
    for (let row = 0; row < tileSize; row++) {
      const at = (ty * tileSize + row) * size + tx * tileSize;
      cells.set(t.cells.subarray(row * tileSize, (row + 1) * tileSize), at);
      shields.set(t.shields.subarray(row * tileSize, (row + 1) * tileSize), at);
    }
  }
  let last: number | null = null;
  for (const [from, to] of manifest.segments) {
    // Oldest first; not always contiguous, since a resync republishes tiles instead.
    if (last !== null) expect(from).toBeGreaterThanOrEqual(last);
    last = to;
    const object = await TILES.get(cdnKeys.segment(prefix(name), from, to));
    const segment = decodeSegment(await gunzip(new Uint8Array(await object!.arrayBuffer())));
    for (const d of segment.diffs) {
      const x = d.index % size;
      const y = (d.index - x) / size;
      const tile = Math.floor(y / tileSize) * perRow + Math.floor(x / tileSize);
      if (to <= versions.get(tile)!) continue;
      cells[d.index] = d.cell;
      shields[d.index] = d.shield;
    }
  }
  return { manifest, cells, shields };
}

describe('CanvasDO persistence', () => {
  it('checkpoints, ships the log to R2, trims it, and restores to the same grid', async () => {
    const name = 'persist';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    await play(stub, OPS.slice(0, 4), 1);
    await tick(stub, 10_000_000);
    // The log up to the checkpoint is in R2 and gone from SQLite.
    expect(await sqlOne(stub, 'SELECT seq FROM op_log')).toEqual([]);
    const head = await OPLOG.head(logKey(prefix(name), 1, 4));
    expect(head?.customMetadata).toMatchObject({ from: '1', to: '4' });
    const [meta] = await sqlOne<{ value: string }>(
      stub,
      "SELECT value FROM meta WHERE key = 'checkpoint'",
    );
    expect(JSON.parse(meta!.value)).toMatchObject({ seq: 4, writtenAt: 10_000_000 });

    await play(stub, OPS.slice(4), 10);
    const before = await stub.snapshot();
    await evictDurableObject(stub);
    const after = await stub.snapshot();
    expect(after.seq).toBe(6);
    expectSame(after.cells, before.cells);
    expectSame(after.shields, before.shields);

    // A full replay of the shipped log plus the tail gives the same grid as the restore.
    const full = createState(await configOf(stub));
    for (const { op, at } of await history(stub, name)) {
      expect(applyEntry(full, op, at).ok).toBe(true);
    }
    const live = createState(await configOf(stub));
    live.cells.set(after.cells);
    live.shields.set(after.shields);
    expect(gridHash(live)).toBe(gridHash(full));

    // Shield decay carries on from the restored clock: the layer placed at 3 s is still there
    // 1 ms before 48 h, so this hammer breaks it instead of clearing the cell.
    await stock(stub, 'p1', [HAMMER, HAMMER]);
    const lifetime = 48 * HOUR;
    const hammer = { kind: 'hammer', x: 600, y: 600 } as const;
    const early = await stub.applyBatch(
      [{ player: 'p1', opId: 50, op: hammer }],
      3_000 + lifetime - 1,
    );
    expect(early.results[0]!.ok && early.results[0]!.diffs.at(-1)).toMatchObject({ shield: 0 });
    expect(early.results[0]!.ok && early.results[0]!.diffs.at(-1)!.cell).not.toBe(0);
    // About 1.5 s alone, but it restores a full-map checkpoint twice: under a full parallel run
    // it can pass the default 5 s.
  }, 30_000);

  it('still knows a retried op after its log row was shipped, trimmed and the object restarted', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('persist-dedupe'));
    await stock(stub, 'p1', [O, SHIELD, SHIELD]);
    const tab = (opId: number, op: Op) => ({ player: 'p1', client: 'tab-a', opId, op });
    const shield = { kind: 'shield', x: 600, y: 600 } as const;
    await stub.applyBatch([tab(1, brick(600, 600))], 1_000);
    const first = await stub.applyBatch([tab(2, shield)], 2_000);
    expect(first.results[0]!.ok).toBe(true);
    // Checkpoint, ship and trim: the rows carrying ops 1 and 2 leave SQLite.
    await tick(stub, 10_000_000);
    expect(await sqlOne(stub, 'SELECT seq FROM op_log')).toEqual([]);
    await evictDurableObject(stub);
    // The dedupe keys are pruned by their own window, not with the log.
    const retry = await stub.applyBatch([tab(2, shield)], 3_000);
    expect(retry.results[0]).toEqual({ ok: true, duplicate: true, diffs: [] });
    expect(retry.holds.get('p1')!.items).toEqual([SHIELD]);
    const index = 600 * DEFAULT_MAP_SIZE + 600;
    expect((await stub.snapshot()).shields[index]).toBe(1);
  });

  it('takes the next checkpoint only after 60 s of activity', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('cadence'));
    await play(stub, OPS.slice(0, 2), 1);
    await tick(stub, 1_000_000);
    await play(stub, OPS.slice(2, 3), 10);
    await tick(stub, 1_030_000);
    const seqOf = async () => {
      const [m] = await sqlOne<{ value: string }>(
        stub,
        "SELECT value FROM meta WHERE key = 'checkpoint'",
      );
      return JSON.parse(m!.value).seq as number;
    };
    expect(await seqOf()).toBe(2);
    await tick(stub, 1_060_000);
    expect(await seqOf()).toBe(3);
  });

  it('records a log segment that a crashed attempt already wrote, without a second object', async () => {
    const name = 'ship-retry';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    await play(stub, OPS.slice(0, 3), 1);
    // R2 takes the object, then the canvas fails before recording it.
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const real = (instance as unknown as { env: Env }).env;
      const crashing = {
        list: (...args: Parameters<R2Bucket['list']>) => OPLOG.list(...args),
        put: async (...args: Parameters<R2Bucket['put']>) => {
          await OPLOG.put(...args);
          throw new Error('crash after put');
        },
      } as unknown as R2Bucket;
      (instance as unknown as { env: Env }).env = { ...real, OPLOG: crashing };
      await instance.tick(5_000_000);
      (instance as unknown as { env: Env }).env = real;
    });
    expect((await sqlOne(stub, 'SELECT seq FROM op_log')).length).toBe(3);
    // Shipping backs off after a failure: a tick a second later does not try again.
    await tick(stub, 5_001_000);
    expect((await sqlOne(stub, 'SELECT seq FROM op_log')).length).toBe(3);
    await tick(stub, 5_000_000 + 30_000);
    const listed = await OPLOG.list({ prefix: `${prefix(name)}/oplog/` });
    expect(listed.objects.map((o) => o.key)).toEqual([logKey(prefix(name), 1, 3)]);
    expect(await sqlOne(stub, 'SELECT seq FROM op_log')).toEqual([]);
  });

  it('never trims rows when the object in R2 does not match them', async () => {
    const name = 'ship-mismatch';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    await play(stub, OPS.slice(0, 2), 1);
    await OPLOG.put(logKey(prefix(name), 1, 2), 'something else', {
      customMetadata: { from: '1', to: '2', sha256: 'f'.repeat(64) },
    });
    await tick(stub, 5_000_000);
    expect((await sqlOne(stub, 'SELECT seq FROM op_log')).length).toBe(2);
  });

  it('keeps the log when there is no log bucket', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('no-bucket'));
    await play(stub, OPS.slice(0, 2), 1);
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const holder = instance as unknown as { env: Env };
      const real = holder.env;
      holder.env = { ...real, OPLOG: undefined };
      await instance.tick(5_000_000);
      holder.env = real;
    });
    expect((await sqlOne(stub, 'SELECT seq FROM op_log')).length).toBe(2);
    expect(await sqlOne(stub, "SELECT key FROM meta WHERE key = 'checkpoint'")).toHaveLength(1);
    // The checkpoint alone still restores the grid.
    const before = await stub.snapshot();
    await evictDurableObject(stub);
    expectSame((await stub.snapshot()).cells, before.cells);
  });

  it('runs maintenance from the alarm an accepted op schedules', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('alarm'));
    await play(stub, OPS.slice(0, 1), 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await sqlOne(stub, "SELECT key FROM meta WHERE key = 'checkpoint'")).toHaveLength(1);
  });

  // What an alarm whose handler threw through all its retries leaves behind: a time that
  // getAlarm() still returns, in the past, and that never fires.
  const loseAlarm = async (stub: Stub) => {
    const lost = Date.now() - 10 * 60_000;
    await runInDurableObject(stub, (_, state) => state.storage.setAlarm(lost + ALARM_DEFERRAL));
    await evictDurableObject(stub);
    return lost;
  };

  it('sets a lost alarm again on start when work is due', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('lost-alarm-start'));
    await play(stub, OPS.slice(0, 1), 1);
    await loseAlarm(stub);
    const before = Date.now();
    await stub.snapshot();
    expect(await pendingAlarm(stub)).toBeGreaterThanOrEqual(before);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await sqlOne(stub, "SELECT key FROM meta WHERE key = 'checkpoint'")).toHaveLength(1);
  });

  it('sets a lost alarm again at the next accepted op', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('lost-alarm-op'));
    await play(stub, OPS.slice(0, 1), 1);
    await tick(stub, 30_000_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await pendingAlarm(stub)).toBeNull();
    const lost = await loseAlarm(stub);
    // Nothing is due, so starting leaves the lost alarm as it is.
    await stub.snapshot();
    expect(await pendingAlarm(stub)).toBe(lost);
    const before = Date.now();
    await play(stub, [{ op: brick(650, 650), at: 31_000_000 }], 2);
    expect(await pendingAlarm(stub)).toBeGreaterThanOrEqual(before);
  });

  it('publishes tiles, diff segments and a manifest that add up to the grid', async () => {
    const name = 'tiles';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 20_000_000;
    await play(stub, OPS.slice(0, 3), 1);
    await tick(stub, t0);
    let seen = await spectate(name);
    let grid = await stub.snapshot();
    expectSame(seen.cells, grid.cells);
    expectSame(seen.shields, grid.shields);
    expect(seen.manifest).toMatchObject({ seq: 3, size: DEFAULT_MAP_SIZE, tileSize: TILE_SIZE });
    const tileOf600 = Math.floor(600 / TILE_SIZE) * PER_ROW + Math.floor(600 / TILE_SIZE);
    expect(seen.manifest.tiles[tileOf600]).toBe(3);
    expect(seen.manifest.tiles.filter((v) => v > 0)).toHaveLength(1);
    // Anonymous: nothing in the manifest names a player.
    expect(JSON.stringify(seen.manifest)).not.toContain('p1');

    // 10 s later: the change goes out as a segment; the tile is too young for a new version.
    await play(stub, OPS.slice(3, 5), 10);
    await tick(stub, t0 + 10_000);
    seen = await spectate(name);
    grid = await stub.snapshot();
    expect(seen.manifest.seq).toBe(5);
    expect(seen.manifest.tiles[tileOf600]).toBe(3);
    expect(seen.manifest.segments.at(-1)).toEqual([3, 5]);
    expectSame(seen.cells, grid.cells);
    expectSame(seen.shields, grid.shields);

    // 45 s after its last version the tile is written again, at the current seq.
    await play(stub, OPS.slice(5), 20);
    await tick(stub, t0 + 46_000);
    seen = await spectate(name);
    grid = await stub.snapshot();
    expect(seen.manifest.tiles[tileOf600]).toBe(6);
    expectSame(seen.cells, grid.cells);

    // After a restart (the log trimmed by now), what is published stays consistent.
    await tick(stub, t0 + 120_000);
    await evictDurableObject(stub);
    await stock(stub, 'p1', [SHIELD]);
    await stub.applyBatch(
      [{ player: 'p1', opId: 99, op: { kind: 'shield', x: 700, y: 600 } }],
      4 * HOUR,
    );
    await tick(stub, t0 + 130_000);
    seen = await spectate(name);
    grid = await stub.snapshot();
    expect(seen.manifest.seq).toBe(7);
    expectSame(seen.cells, grid.cells);
    expectSame(seen.shields, grid.shields);
  });
  it('splits a checkpoint over parts, and refuses missing parts or a wrong checksum', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('parts'));
    await play(stub, OPS, 1);
    await runInDurableObject(stub, async (instance: CanvasDO, state) => {
      const { sql } = state.storage;
      const save = (body: () => void) => state.storage.transactionSync(body);
      const { grid, seq } = inside(instance);
      const prepared = await prepareCheckpoint(gridHash(grid), encodeCheckpoint(grid), seq, 1);
      const meta = await storeCheckpoint(sql, prepared, save, 1000);
      expect(meta.parts).toBeGreaterThan(1);
      expect(gridHash((await loadCheckpoint(sql))!.state)).toBe(gridHash(grid));

      // A checkpoint that does not read back is dropped; the current one stays.
      const bad = { ...prepared, seq: seq + 1, sha256: '0'.repeat(64) };
      await expect(storeCheckpoint(sql, bad, save, 1000)).rejects.toThrow(/checksum/);
      expect(readCheckpointMeta(sql)).toEqual(meta);
      expect(gridHash((await loadCheckpoint(sql))!.state)).toBe(gridHash(grid));

      sql.exec(
        "UPDATE meta SET value = ? WHERE key = 'checkpoint'",
        JSON.stringify({ ...meta, sha256: 'f'.repeat(64) }),
      );
      await expect(loadCheckpoint(sql)).rejects.toThrow(/checksum mismatch/);
      sql.exec("UPDATE meta SET value = ? WHERE key = 'checkpoint'", JSON.stringify(meta));
      sql.exec('DELETE FROM checkpoint_parts WHERE part = 1');
      await expect(loadCheckpoint(sql)).rejects.toThrow(/parts missing/);
    });
  });

  it('leaves no alarm once there is nothing left to do', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('idle'));
    await play(stub, OPS.slice(0, 1), 1);
    const alarm = () => pendingAlarm(stub);
    expect(await alarm()).not.toBeNull();
    // Checkpoint, ship, trim, publish: nothing is left for the pending alarm to do.
    await tick(stub, 30_000_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarm()).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it('checkpoints while the public bucket is down, and republishes every tile after a restart', async () => {
    const name = 'tiles-down';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    await play(stub, OPS.slice(0, 3), 1);
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const restore = breakTiles(instance);
      await instance.tick(40_000_000);
      restore();
    });
    const [meta] = await sqlOne<{ value: string }>(
      stub,
      "SELECT value FROM meta WHERE key = 'checkpoint'",
    );
    expect(JSON.parse(meta!.value).seq).toBe(3);
    expect(await sqlOne(stub, 'SELECT seq FROM op_log')).toEqual([]);
    expect(await TILES.head(cdnKeys.manifest(prefix(name)))).toBeNull();

    // The restart finds the checkpoint past the last segment: every tile is republished.
    await evictDurableObject(stub);
    await play(stub, OPS.slice(3, 4), 10);
    await tick(stub, 40_010_000);
    const seen = await spectate(name);
    const grid = await stub.snapshot();
    expect(seen.manifest.seq).toBe(4);
    expect(seen.manifest.tiles.every((v) => v >= 3)).toBe(true);
    expectSame(seen.cells, grid.cells);
    expectSame(seen.shields, grid.shields);
  });

  it('republishes tiles instead of writing an oversized segment', async () => {
    const name = 'resync';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    await play(stub, OPS.slice(0, 1), 1);
    await tick(stub, 50_000_000);
    await runInDurableObject(stub, (instance: CanvasDO) => {
      inside(instance).cdn.maxDiffs = 2;
    });
    await play(stub, OPS.slice(1, 2), 10);
    // A segment tick, not a maintenance pass: the tiles still go out before the manifest.
    await tick(stub, 50_000_000 + SEGMENT_MS);
    expect(await TILES.head(cdnKeys.segment(prefix(name), 1, 2))).toBeNull();
    const seen = await spectate(name);
    expect(seen.manifest.seq).toBe(2);
    expect(seen.manifest.tiles.every((v) => v === 2)).toBe(true);
    expectSame(seen.cells, (await stub.snapshot()).cells);
  });

  it('publishes an overview of the whole map with the tiles, replaced on their cadence', async () => {
    const name = 'overview';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 25_000_000;
    await play(stub, OPS.slice(0, 2), 1);
    await tick(stub, t0);
    // The encoded bytes, compared in a loop: toEqual on the 512 x 512 overview takes seconds.
    const stored = async (version: number) =>
      gunzip(
        new Uint8Array(
          await (await TILES.get(cdnKeys.overview(prefix(name), version)))!.arrayBuffer(),
        ),
      );
    let seen = await spectate(name);
    const factor = overviewFactor(DEFAULT_MAP_SIZE);
    expect(seen.manifest.overview).toEqual({ factor, version: 2 });
    // Exactly the live map, downscaled.
    const live = async () => {
      const grid = await stub.snapshot();
      return encodeOverview({ cells: grid.cells, size: DEFAULT_MAP_SIZE }, factor, grid.seq);
    };
    const bytes = await stored(2);
    expectSame(bytes, await live());
    // A block with a brick shows its colour; one without, nothing.
    const first = decodeOverview(bytes);
    const pixel = (x: number, y: number) => (y / factor) * first.side + x / factor;
    expect(first.colors[pixel(600, 600)]).toBe(3 + 1);
    expect(first.cover[pixel(600, 600)]).toBeGreaterThan(0);
    expect(first.colors[pixel(0, 0)]).toBe(0);

    // Too young to replace 10 s later; replaced once the tiles' interval has passed.
    await play(stub, OPS.slice(4, 5), 10);
    await tick(stub, t0 + 10_000);
    expect((await spectate(name)).manifest.overview?.version).toBe(2);
    await tick(stub, t0 + 46_000);
    seen = await spectate(name);
    expect(seen.manifest.overview?.version).toBe(3);
    expectSame(await stored(3), await live());
    // The one it replaced is garbage once a manifest without it is out, and goes after the
    // grace period; nothing new when the map does not change.
    await tick(stub, t0 + 100_000);
    expect((await spectate(name)).manifest.overview?.version).toBe(3);
    await tick(stub, t0 + 100_000 + GARBAGE_GRACE);
    expect(await TILES.head(cdnKeys.overview(prefix(name), 2))).toBeNull();
    expect(await TILES.head(cdnKeys.overview(prefix(name), 3))).not.toBeNull();
    // A restart remembers it: no new version without a change.
    await evictDurableObject(stub);
    await tick(stub, t0 + 200_000 + GARBAGE_GRACE);
    expect((await spectate(name)).manifest.overview?.version).toBe(3);
  });

  it('publishes an overview of a map whose size is not a multiple of 512', async () => {
    const name = 'overview-1792';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    // 7 x 7 tiles: 1792 / 512 is no whole number, so the factor must still divide the size.
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      const config = JSON.parse(
        sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'").one().value,
      );
      const resized = { ...config, size: 1792, open: { x: 0, y: 0, w: 1792, h: 1792 } };
      sql.exec("UPDATE meta SET value = ? WHERE key = 'config'", JSON.stringify(resized));
    });
    await evictDurableObject(stub);
    await play(stub, OPS.slice(0, 1), 1);
    await tick(stub, 26_000_000);
    const seen = await spectate(name);
    expect(seen.manifest).toMatchObject({
      seq: 1,
      size: 1792,
      overview: { factor: 4, version: 1 },
    });
    const object = await TILES.get(cdnKeys.overview(prefix(name), 1));
    const overview = decodeOverview(await gunzip(new Uint8Array(await object!.arrayBuffer())));
    expect(overview.side).toBe(448);
    expect(overview.colors[(600 / 4) * 448 + 600 / 4]).toBe(3 + 1);
  });

  it('deletes tile versions and segments the manifest stopped listing, after a grace period', async () => {
    const name = 'garbage';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 60_000_000;
    await play(stub, OPS.slice(0, 1), 1);
    await tick(stub, t0);
    const first = cdnKeys.tile(prefix(name), 2, 2, 1);
    expect(await TILES.head(first)).not.toBeNull();
    // A segment every SEGMENT_MS: once more than RECENT_SEGMENTS newer ones exist and the
    // tile was republished, the first segment is no longer listed.
    let t = t0;
    for (let i = 0; i <= RECENT_SEGMENTS; i++) {
      await stock(stub, 'p1', [O]);
      const op = brick(520 + 2 * (i % 50), 520 + 2 * Math.floor(i / 50));
      const { results } = await stub.applyBatch([{ player: 'p1', opId: 100 + i, op }], 1_000 + i);
      expect(results[0]!.ok).toBe(true);
      t += SEGMENT_MS;
      await tick(stub, t);
    }
    const seen = await spectate(name);
    expect(seen.manifest.tiles[2 * PER_ROW + 2]).toBeGreaterThan(1);
    expect(seen.manifest.segments.some(([from]) => from === 0)).toBe(false);
    // Still readable within the grace period, for spectators holding an older manifest.
    expect(await TILES.head(first)).not.toBeNull();
    expect(await TILES.head(cdnKeys.segment(prefix(name), 0, 1))).not.toBeNull();
    await tick(stub, t + GARBAGE_GRACE);
    expect(await TILES.head(first)).toBeNull();
    expect(await TILES.head(cdnKeys.segment(prefix(name), 0, 1))).toBeNull();
    // Everything the manifest lists is still there.
    const after = await spectate(name);
    expectSame(after.cells, (await stub.snapshot()).cells);
    // Only what this last pass retired is left, waiting for its own grace period.
    expect(await sqlOne(stub, `SELECT key FROM cdn_garbage WHERE since <= ${t}`)).toEqual([]);
  });
  it('cuts the first segment after a quiet spell at once, then at most one per SEGMENT_MS', async () => {
    const name = 'segment-at-once';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    await stock(stub, 'p1', [O, O]);
    const first = await stub.applyBatch([{ player: 'p1', opId: 1, op: brick(600, 600) }], 1_000);
    expect(first.results[0]!.ok).toBe(true);
    // Nothing was cut before: the op asks for a tick now, not SEGMENT_MS out.
    expect(await pendingAlarm(stub)).toBeLessThanOrEqual(Date.now());
    // An op accepted while that tick uploads its segment waits for the next interval.
    const { started, alarm } = await runInDurableObject(stub, async (instance: CanvasDO, state) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let uploading = false;
      const restore = swapTiles(instance, (real) => ({
        put: async (...args: Parameters<R2Bucket['put']>) => {
          uploading = true;
          await gate;
          return real.put(...args);
        },
      }));
      const started = Date.now();
      const ticking = instance.tick(80_000_000);
      const deadline = Date.now() + 10_000;
      while (!uploading && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(uploading).toBe(true);
      // Only what the next op asks for: the first op's alarm is still pending.
      (instance as unknown as { alarmAt: number | null }).alarmAt = null;
      await state.storage.deleteAlarm();
      const op = { player: 'p1', opId: 2, op: brick(700, 600) };
      expect((await instance.applyBatch([op], 2_000)).results[0]!.ok).toBe(true);
      const alarm = await state.storage.getAlarm();
      release();
      await ticking;
      restore();
      return { started, alarm };
    });
    expect(alarm).not.toBeNull();
    expect(alarm! - ALARM_DEFERRAL).toBeGreaterThanOrEqual(started + SEGMENT_MS);
    expect((await spectate(name)).manifest.segments).toEqual([[0, 1]]);
  });

  /** Forgets the pending alarm, so the next arm shows only what the next op asks for. */
  const forgetAlarm = (stub: Stub) =>
    runInDurableObject(stub, async (instance: CanvasDO, state) => {
      (instance as unknown as { alarmAt: number | null }).alarmAt = null;
      await state.storage.deleteAlarm();
    });

  it("keeps ops from calling segment ticks into a failing bucket's backoff", async () => {
    const stub = CANVAS.get(CANVAS.idFromName('segment-backoff'));
    await stock(stub, 'p1', [O, O]);
    const op = (opId: number, x: number) => ({ player: 'p1', opId, op: brick(x, 600) });
    expect((await stub.applyBatch([op(1, 600)], 1_000)).results[0]!.ok).toBe(true);
    // Two failures: the backoff grows to 4 s, past one segment interval.
    const before = await runInDurableObject(stub, async (instance: CanvasDO) => {
      const restore = breakTiles(instance);
      await instance.tick(90_000_000);
      const before = Date.now();
      await instance.tick(90_000_000 + SEGMENT_MS);
      restore();
      return before;
    });
    await forgetAlarm(stub);
    expect((await stub.applyBatch([op(2, 700)], 2_000)).results[0]!.ok).toBe(true);
    const alarm = await pendingAlarm(stub);
    expect(alarm! - before).toBeGreaterThanOrEqual(2 * SEGMENT_MS);
  });

  it('lets a tick with nothing to publish hold back no lone move', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('segment-idle-tick'));
    await stock(stub, 'p1', [O, O]);
    const op = (opId: number, x: number) => ({ player: 'p1', opId, op: brick(x, 600) });
    expect((await stub.applyBatch([op(1, 600)], 1_000)).results[0]!.ok).toBe(true);
    await tick(stub, 95_000_000);
    expect((await spectate('segment-idle-tick')).manifest.segments).toEqual([[0, 1]]);
    // As if that segment were long ago; then a tick for something else, with nothing to cut.
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      (instance as unknown as { segmentAfter: number }).segmentAfter = 0;
      await instance.tick(95_000_000 + SEGMENT_MS);
    });
    await forgetAlarm(stub);
    expect((await stub.applyBatch([op(2, 700)], 2_000)).results[0]!.ok).toBe(true);
    expect(await pendingAlarm(stub)).toBeLessThanOrEqual(Date.now());
  });

  it('sends a segment every SEGMENT_MS, and leaves maintenance to its own cadence', async () => {
    const name = 'live';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 70_000_000;
    await tick(stub, t0);
    await play(stub, OPS.slice(0, 1), 1);
    // The accepted op asks for a tick within one segment interval.
    const alarm = await pendingAlarm(stub);
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(SEGMENT_MS);
    await tick(stub, t0 + SEGMENT_MS);
    let seen = await spectate(name);
    expect(seen.manifest.seq).toBe(1);
    expect(seen.manifest.segments).toEqual([[0, 1]]);
    // A checkpoint is long due, but maintenance ran less than MAINTAIN_MS ago: not yet.
    expect(await sqlOne(stub, "SELECT key FROM meta WHERE key = 'checkpoint'")).toEqual([]);
    expect(seen.manifest.tiles.every((v) => v === 0)).toBe(true);

    await play(stub, OPS.slice(1, 2), 10);
    await tick(stub, t0 + 2 * SEGMENT_MS);
    seen = await spectate(name);
    expect(seen.manifest.segments).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expectSame(seen.cells, (await stub.snapshot()).cells);
    // Nothing new: no segment, no manifest write.
    const before = (await TILES.head(cdnKeys.manifest(prefix(name))))!.uploaded;
    await tick(stub, t0 + 3 * SEGMENT_MS);
    expect((await TILES.head(cdnKeys.manifest(prefix(name))))!.uploaded).toEqual(before);

    await tick(stub, t0 + 10_000);
    expect(await sqlOne(stub, "SELECT key FROM meta WHERE key = 'checkpoint'")).toHaveLength(1);
    seen = await spectate(name);
    expect(seen.manifest.tiles.filter((v) => v > 0)).toHaveLength(1);
  });

  it('never deletes a tile version the manifest in R2 still names', async () => {
    const name = 'owed';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 80_000_000;
    await play(stub, OPS.slice(0, 1), 1);
    await tick(stub, t0);
    const v1 = cdnKeys.tile(prefix(name), 2, 2, 1);
    await play(stub, OPS.slice(1, 2), 10);
    // The segment's manifest goes out (still naming v1); the one after v2 is refused.
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      let manifests = 0;
      swapTiles(instance, (real) => ({
        put: (async (key: string, value: never, options: never) => {
          if (key.endsWith('manifest.json') && ++manifests >= 2) throw new Error('refused');
          return real.put(key, value, options);
        }) as R2Bucket['put'],
      }));
      await instance.tick(t0 + 50_000);
    });
    let seen = await spectate(name);
    expect(seen.manifest.tiles[2 * PER_ROW + 2]).toBe(1);
    // A restart forgets nothing: the owed manifest goes out, and v1 waits its grace period.
    await evictDurableObject(stub);
    await tick(stub, t0 + 50_000 + GARBAGE_GRACE + 1);
    seen = await spectate(name);
    expect(seen.manifest.tiles[2 * PER_ROW + 2]).toBe(2);
    expectSame(seen.cells, (await stub.snapshot()).cells);
    expect(await TILES.head(v1)).not.toBeNull();
    await tick(stub, t0 + 50_000 + 2 * GARBAGE_GRACE + 20_000);
    expect(await TILES.head(v1)).toBeNull();
    expectSame((await spectate(name)).cells, (await stub.snapshot()).cells);
  });

  it('holds back log shipping that keeps failing, doubling the wait', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('ship-backoff'));
    await play(stub, OPS.slice(0, 2), 1);
    const t = 85_000_000;
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const holder = inside(instance);
      const real = holder.env;
      let calls = 0;
      const failing = {
        list: async () => {
          calls++;
          throw new Error('OPLOG is down');
        },
      } as unknown as R2Bucket;
      holder.env = { ...real, OPLOG: failing };
      await instance.tick(t);
      expect(calls).toBe(1);
      await instance.tick(t + 10_000);
      expect(calls).toBe(2);
      // Now waiting 20 s: the maintenance pass at +20 s leaves shipping alone.
      await instance.tick(t + 20_000);
      expect(calls).toBe(2);
      await instance.tick(t + 30_000);
      expect(calls).toBe(3);
      holder.env = real;
    });
    expect((await sqlOne(stub, 'SELECT seq FROM op_log')).length).toBe(2);
  });

  it('puts cells back when a segment upload fails, and sends them in the next one', async () => {
    const name = 'segment-retry';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t = 90_000_000;
    await play(stub, OPS.slice(0, 1), 1);
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const restore = breakTiles(instance);
      await instance.tick(t);
      restore();
    });
    await tick(stub, t + SEGMENT_MS);
    const seen = await spectate(name);
    // No tile is out yet: the segment alone carries the brick.
    expect(seen.manifest.tiles.every((v) => v === 0)).toBe(true);
    expect(seen.manifest.segments).toEqual([[0, 1]]);
    expectSame(seen.cells, (await stub.snapshot()).cells);
  });

  it('deletes an object that was uploaded but never recorded', async () => {
    const name = 'orphan';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 95_000_000;
    await play(stub, OPS.slice(0, 1), 1);
    // R2 stores the segment, but the reply is lost: the canvas never records it.
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const restore = swapTiles(instance, (real) => ({
        put: (async (key: string, value: never, options: never) => {
          await real.put(key, value, options);
          if (key.includes('/diffs/')) throw new Error('reply lost');
          return null;
        }) as unknown as R2Bucket['put'],
      }));
      await instance.tick(t0);
      restore();
    });
    const orphan = cdnKeys.segment(prefix(name), 0, 1);
    expect(await TILES.head(orphan)).not.toBeNull();
    await play(stub, OPS.slice(1, 2), 10);
    await tick(stub, t0 + SEGMENT_MS);
    let seen = await spectate(name);
    expect(seen.manifest.segments).toEqual([[0, 2]]);
    expectSame(seen.cells, (await stub.snapshot()).cells);
    await tick(stub, t0 + GARBAGE_GRACE + 20_000);
    expect(await TILES.head(orphan)).toBeNull();
    seen = await spectate(name);
    expectSame(seen.cells, (await stub.snapshot()).cells);
  });

  it('lists exactly the recent segments once every tile is current', async () => {
    const name = 'recent';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    let t = 100_000_000;
    const count = RECENT_SEGMENTS + 5;
    for (let i = 0; i < count; i++) {
      await stock(stub, 'p1', [O]);
      const op = brick(520 + 2 * (i % 50), 520 + 2 * Math.floor(i / 50));
      const { results } = await stub.applyBatch([{ player: 'p1', opId: i, op }], 1_000 + i);
      expect(results[0]!.ok).toBe(true);
      t += SEGMENT_MS;
      await tick(stub, t);
    }
    await tick(stub, t + 60_000);
    const seen = await spectate(name);
    expect(seen.manifest.tiles[2 * PER_ROW + 2]).toBe(count);
    expect(seen.manifest.segments).toHaveLength(RECENT_SEGMENTS);
    expect(seen.manifest.segments.at(-1)).toEqual([count - 1, count]);
    expectSame(seen.cells, (await stub.snapshot()).cells);
  });

  it('finishes a resync after a restart before any manifest goes out', async () => {
    const name = 'resync-restart';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 110_000_000;
    await play(stub, OPS.slice(0, 1), 1);
    await tick(stub, t0);
    await runInDurableObject(stub, (instance: CanvasDO) => {
      inside(instance).cdn.maxDiffs = 0;
    });
    await play(stub, OPS.slice(1, 2), 10);
    // The resync gets three tiles out, then the bucket fails and the canvas restarts.
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      let tiles = 0;
      const restore = swapTiles(instance, (real) => ({
        put: (async (key: string, value: never, options: never) => {
          if (key.includes('/tiles/') && ++tiles > 3) throw new Error('TILES is down');
          return real.put(key, value, options);
        }) as R2Bucket['put'],
      }));
      await instance.tick(t0 + SEGMENT_MS);
      restore();
    });
    await evictDurableObject(stub);
    const manifests: Manifest[] = [];
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const restore = swapTiles(instance, (real) => ({
        put: (async (key: string, value: string, options: never) => {
          if (key.endsWith('manifest.json')) manifests.push(parseManifest(value));
          return real.put(key, value, options);
        }) as unknown as R2Bucket['put'],
      }));
      await instance.tick(t0 + 2 * SEGMENT_MS);
      restore();
    });
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) expect(m.tiles.filter((v) => v < 2)).toEqual([]);
    expectSame((await spectate(name)).cells, (await stub.snapshot()).cells);
  });

  it('backs off a failing public bucket from 2 s up to 5 minutes', async () => {
    const name = 'cdn-backoff';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 120_000_000;
    await play(stub, OPS.slice(0, 1), 1);
    const attempts = await runInDurableObject(stub, async (instance: CanvasDO) => {
      const seen: number[] = [];
      let now = t0;
      const restore = swapTiles(instance, () => ({
        put: async () => {
          seen.push((now - t0) / 1000);
          throw new Error('TILES is down');
        },
      }));
      for (; now <= t0 + 900_000; now += SEGMENT_MS) await instance.tick(now);
      restore();
      return seen;
    });
    expect(attempts).toEqual([0, 2, 6, 14, 30, 62, 126, 254, 510, 810]);
    await tick(stub, t0 + 1_110_000);
    const seen = await spectate(name);
    expect(seen.manifest.seq).toBe(1);
    expectSame(seen.cells, (await stub.snapshot()).cells);
  });

  it('deletes a tile version that was uploaded but never recorded', async () => {
    const name = 'tile-orphan';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 130_000_000;
    await play(stub, OPS.slice(0, 1), 1);
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const restore = swapTiles(instance, (real) => ({
        put: (async (key: string, value: never, options: never) => {
          await real.put(key, value, options);
          if (key.includes('/tiles/')) throw new Error('reply lost');
          return null;
        }) as unknown as R2Bucket['put'],
      }));
      await instance.tick(t0);
      restore();
    });
    const orphan = cdnKeys.tile(prefix(name), 2, 2, 1);
    expect(await TILES.head(orphan)).not.toBeNull();
    // A later version replaces it before it was ever listed.
    await play(stub, OPS.slice(1, 2), 10);
    await tick(stub, t0 + 10_000);
    expect((await spectate(name)).manifest.tiles[2 * PER_ROW + 2]).toBe(2);
    await tick(stub, t0 + GARBAGE_GRACE + 20_000);
    expect(await TILES.head(orphan)).toBeNull();
    expectSame((await spectate(name)).cells, (await stub.snapshot()).cells);
  });

  it('writes the manifest a recorded segment owes, even after a restart', async () => {
    const name = 'owed-segment';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    const t0 = 140_000_000;
    await play(stub, OPS.slice(0, 1), 1);
    await tick(stub, t0);
    await play(stub, OPS.slice(1, 2), 10);
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const restore = swapTiles(instance, (real) => ({
        put: (async (key: string, value: never, options: never) => {
          if (key.endsWith('manifest.json')) throw new Error('refused');
          return real.put(key, value, options);
        }) as R2Bucket['put'],
      }));
      await instance.tick(t0 + SEGMENT_MS);
      restore();
    });
    expect((await spectate(name)).manifest.seq).toBe(1);
    await evictDurableObject(stub);
    await tick(stub, t0 + 2 * SEGMENT_MS);
    const seen = await spectate(name);
    expect(seen.manifest.seq).toBe(2);
    expectSame(seen.cells, (await stub.snapshot()).cells);
  });

  it('publishes, checkpoints, ships and restores open-area growth like any log row', async () => {
    const name = 'growth';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    // A 64² map (one tile) whose 16² open area grows by 8 a side at 70% filled.
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      const config = JSON.parse(
        sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'").one().value,
      );
      const small = {
        ...config,
        size: 64,
        open: { x: 24, y: 24, w: 16, h: 16 },
        growth: { atPercent: 70, step: 8 },
      };
      sql.exec("UPDATE meta SET value = ? WHERE key = 'config'", JSON.stringify(small));
    });
    await evictDurableObject(stub);
    const t0 = 150_000_000;
    const squares = (from: number, n: number) =>
      Array.from({ length: n }, (_, k) => {
        const i = from + k;
        const op = brick(24 + (i % 8) * 2, 24 + Math.floor(i / 8) * 2);
        return { player: 'p1', opId: i + 1, op };
      });
    await stock(
      stub,
      'p1',
      Array.from({ length: 64 }, () => O),
    );
    expect((await stub.applyBatch(squares(0, 44), 1_000)).seq).toBe(1);
    await tick(stub, t0);
    // The 45th square reaches 70%: batch at seq 2, growth row at seq 3.
    const grown = await stub.applyBatch(squares(44, 1), 2_000);
    expect(grown.grewAt).toBe(3);
    await tick(stub, t0 + SEGMENT_MS);
    let seen = await spectate(name);
    let grid = await stub.snapshot();
    expect(seen.manifest.seq).toBe(3);
    expect(seen.manifest.open).toEqual(grid.rules.open);
    expect(seen.manifest.open).toEqual({ x: 16, y: 16, w: 32, h: 32 });
    expectSame(seen.cells, grid.cells);

    // A restore now starts from the checkpoint at seq 1 and replays the growth row in the tail.
    await evictDurableObject(stub);
    expect(await stub.status()).toMatchObject({ seq: 3, rules: { open: grid.rules.open } });
    expectSame((await stub.snapshot()).cells, grid.cells);

    // The checkpoint covers the growth; the shipped log holds its row; a restore has both.
    await tick(stub, t0 + 70_000);
    const [meta] = await sqlOne<{ value: string }>(
      stub,
      "SELECT value FROM meta WHERE key = 'checkpoint'",
    );
    expect(JSON.parse(meta!.value).seq).toBe(3);
    expect(await sqlOne(stub, 'SELECT seq FROM op_log')).toEqual([]);
    const rows = await history(stub, name);
    expect(rows.at(-1)!.op).toEqual({ kind: 'open', x: 16, y: 16, w: 32, h: 32 });
    await evictDurableObject(stub);
    expect((await stub.status()).rules.open).toEqual({ x: 16, y: 16, w: 32, h: 32 });
    expectSame((await stub.snapshot()).cells, grid.cells);

    // An admin growth changes no cell: an empty segment still carries its seq and area.
    const wider = { x: 8, y: 8, w: 48, h: 48 };
    // No alarm pending beforehand, so the one after it is the growth's own.
    await runInDurableObject(stub, async (instance: CanvasDO, state) => {
      await state.storage.deleteAlarm();
      (instance as unknown as { alarmAt: number | null }).alarmAt = null;
    });
    expect(await stub.setOpenArea(wider, 3_000)).toMatchObject({ ok: true, seq: 4 });
    // ...and asks for a segment tick, as an accepted op does.
    const alarm = await pendingAlarm(stub);
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(SEGMENT_MS);
    await tick(stub, t0 + 70_000 + SEGMENT_MS);
    seen = await spectate(name);
    grid = await stub.snapshot();
    expect(seen.manifest.seq).toBe(4);
    expect(seen.manifest.open).toEqual(wider);
    expect(seen.manifest.segments.at(-1)).toEqual([3, 4]);
    expectSame(seen.cells, grid.cells);
  });

  it('keeps an alarm for garbage on an idle canvas, and collects it', async () => {
    const name = 'idle-garbage';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    // Wall-clock times, so the alarm's own tick (Date.now()) lines up with them.
    const t0 = Date.now();
    await play(stub, OPS.slice(0, 1), 1);
    await tick(stub, t0);
    await play(stub, OPS.slice(1, 2), 10);
    await tick(stub, t0 + 50_000);
    await tick(stub, t0 + 60_000);
    const v1 = cdnKeys.tile(prefix(name), 2, 2, 1);
    expect(await TILES.head(v1)).not.toBeNull();
    // The pending alarm finds nothing due but the garbage (and the next hourly keyframe, since
    // the map changed after the first one, and the next fold), and asks to come back for the
    // earliest of them.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const alarm = await pendingAlarm(stub);
    // The next keyframe is due at the hour after the last one, if the map changed since; read
    // from the canvas's own index, since a tick near the hour may already have cut it.
    const index = parseKeyframes(await (await TILES.get(cdnKeys.keyframes(prefix(name))))!.text());
    const last = index.frames.at(-1)!;
    const keyframeDue =
      last.seq < (await stub.status()).seq
        ? (Math.floor(last.at / KEYFRAME_MS) + 1) * KEYFRAME_MS
        : Number.POSITIVE_INFINITY;
    // And the fold of the second op's player rows (ADR 0042): the first tick folded the first.
    const foldDue = t0 + STATE_FOLD_MS;
    const expected = Math.min(t0 + 60_000 + GARBAGE_GRACE, keyframeDue, foldDue);
    expect(Math.abs(alarm! - expected)).toBeLessThan(70_000);
    await tick(stub, t0 + 60_000 + GARBAGE_GRACE);
    expect(await TILES.head(v1)).toBeNull();
  });
});
