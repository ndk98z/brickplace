// Checkpoint copies in OPLOG (ADR 0014, 0024): hourly copies with retention, read back only when
// whole, and recovery from them when the canvas's own checkpoint is damaged or missing.
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createState, gridHash, type Item, type Op, type State } from '@brickplace/core';
import { describe, expect, it, vi } from 'vitest';
import { loadCheckpoint, readCheckpointMeta } from '../src/checkpoints.ts';
import {
  COPY_MS,
  type CopyInfo,
  copyCheckpoint,
  copyKey,
  DELETE_BATCH,
  KEEP_DAYS,
  KEEP_RECENT,
  listCopies,
  loadCopy,
  newestCopy,
  RECOVERY_COPY_ATTEMPTS,
  RECOVERY_SEGMENTS,
  staleCopies,
} from '../src/copies.ts';
import type { CanvasDO, Env } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';
import { logKey } from '../src/oplog.ts';
import { TEAM_CAP_KEY, type TeamLedger } from '../src/teams.ts';

const { CANVAS, MODERATION, OPLOG, TILES } = env as unknown as Required<Env>;
type Stub = ReturnType<typeof CANVAS.get>;
const NEVER = 2 ** 50;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SIZE = 1024;
/**
 * Maintenance ticks run on the wall clock and ahead of it, and each canvas is first ticked at
 * START, so a real alarm never runs maintenance in the middle of a test (as in season.test.ts).
 */
const T = (Math.floor(Date.now() / HOUR) + 2) * HOUR;
const START = T - HOUR / 2;
const prefix = (name: string) => `c/${name}`;

type Internals = { env: Env; teams: TeamLedger; grid: State };
const inside = (instance: CanvasDO) => instance as unknown as Internals;

const brick = (x: number, y: number, color = 3): Op => ({
  kind: 'brick',
  x,
  y,
  shape: 1,
  rotation: 0,
  color,
});

function itemOf(op: Op): Item {
  return op.kind === 'brick' ? { kind: 'brick', shape: op.shape } : ({ kind: op.kind } as Item);
}

const tick = (stub: Stub, now: number) =>
  runInDurableObject(stub, (instance: CanvasDO) => instance.tick(now));

async function canvas(name: string): Promise<Stub> {
  const stub = CANVAS.get(CANVAS.idFromName(name));
  await tick(stub, START);
  return stub;
}

let nextOpId = 1;

/** One op by `player` for `team`, with the item given and the team cap read first. */
async function act(stub: Stub, player: string, team: number, op: Op, at: number) {
  await runInDurableObject(stub, async (instance: CanvasDO, state) => {
    await inside(instance).teams.refreshCap(inside(instance).env.MODERATION, Date.now());
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify([itemOf(op)]),
      NEVER,
    );
  });
  const batch = await stub.applyBatch([{ player, opId: nextOpId++, op, team }], at);
  expect(batch.results[0]!.ok, JSON.stringify(op)).toBe(true);
}

/** `n` bricks in a row from (x0, y), alternating players a (team 1) and b (team 2). */
async function build(stub: Stub, n: number, x0: number, y: number, at: number) {
  for (let k = 0; k < n; k++) {
    await act(stub, k % 2 ? 'b' : 'a', (k % 2) + 1, brick(x0 + 2 * k, y, k % 32), at + k * 1_000);
  }
}

const sql = <T>(stub: Stub, query: string) =>
  runInDurableObject(stub, (_, state) => state.storage.sql.exec(query).toArray() as T[]);

const minSeq = async (stub: Stub) =>
  (await sql<{ m: number | null }>(stub, 'SELECT MIN(seq) AS m FROM op_log'))[0]!.m;

/** The live grid as a state, for its hash. */
async function liveHash(stub: Stub): Promise<string> {
  const snapshot = await stub.snapshot();
  const state = createState({ size: SIZE, open: { x: 0, y: 0, w: SIZE, h: SIZE }, maxShield: 5 });
  state.cells.set(snapshot.cells);
  state.shields.set(snapshot.shields);
  return gridHash(state);
}

describe('checkpoint copies', () => {
  it('copies the checkpoint to OPLOG at most hourly, with its seq, clock and checksums', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const name = 'copies-cadence';
    const stub = await canvas(name);
    await build(stub, 4, 600, 600, 10_000);
    await tick(stub, T);
    let copies = await listCopies(OPLOG, prefix(name));
    expect(copies).toEqual([
      { key: copyKey(prefix(name), 4), seq: 4, writtenAt: T, clock: 13_000, format: '1' },
    ]);
    const first = await loadCopy(OPLOG, copies[0]!, SIZE);
    expect(first.seq).toBe(4);
    expect(gridHash(first.state)).toBe(await liveHash(stub));
    expect(first.team).not.toBeNull();
    // Exactly the stored checkpoint: same grid hash and SHA-256 as SQLite's.
    const head = await OPLOG.head(copies[0]!.key);
    const meta = await runInDurableObject(stub, (_, state) =>
      readCheckpointMeta(state.storage.sql),
    );
    expect(head?.customMetadata).toMatchObject({
      format: '1',
      seq: '4',
      hash: meta!.hash,
      gridSha256: meta!.sha256,
    });

    // A newer checkpoint within the hour is not copied; nothing new, nothing copied either.
    await build(stub, 2, 600, 700, 20_000);
    await tick(stub, T + 120_000);
    expect((await listCopies(OPLOG, prefix(name))).map((c) => c.seq)).toEqual([4]);
    // The copy owed is due an hour after the last one, idle or not: the alarm waits for it.
    const dueAt = () =>
      runInDurableObject(stub, (instance: CanvasDO) =>
        (instance as unknown as { copyDueAt(): number | null }).copyDueAt(),
      );
    expect(await dueAt()).toBe(T + COPY_MS);
    // (Maintenance passes at least 10 s apart.)
    await tick(stub, T + COPY_MS - 10_000);
    expect((await listCopies(OPLOG, prefix(name))).map((c) => c.seq)).toEqual([4]);
    await tick(stub, T + COPY_MS);
    copies = await listCopies(OPLOG, prefix(name));
    expect(copies.map((c) => c.seq)).toEqual([6, 4]);
    expect(gridHash((await loadCopy(OPLOG, copies[0]!, SIZE)).state)).toBe(await liveHash(stub));
    expect(await dueAt()).toBeNull();
    await tick(stub, T + 3 * COPY_MS);
    expect((await listCopies(OPLOG, prefix(name))).map((c) => c.seq)).toEqual([6, 4]);
    // Several 1024² checkpoints and decodes: seconds alone, more under a full parallel run.
  }, 60_000);

  it('keeps the newest copies, then the newest of each day for a month', () => {
    const copies: CopyInfo[] = [];
    // One copy an hour for 40 days, newest first.
    for (let h = 40 * 24 - 1; h >= 0; h--) {
      copies.push({ key: `k${h}`, seq: h + 1, writtenAt: h * HOUR + 1 });
    }
    const stale = new Set(staleCopies(copies));
    const kept = copies.filter((c) => !stale.has(c.key));
    expect(kept.slice(0, KEEP_RECENT)).toEqual(copies.slice(0, KEEP_RECENT));
    const older = kept.slice(KEEP_RECENT);
    // The 48 newest cover days 39 and 38: one per day for days 37 back to 10.
    const newestDay = 39;
    expect(older.map((c) => Math.floor(c.writtenAt / DAY))).toEqual(
      Array.from({ length: KEEP_DAYS - 2 }, (_, i) => newestDay - 2 - i),
    );
    // Each the last copy of its day.
    for (const c of older) expect(c.writtenAt % DAY).toBe(23 * HOUR + 1);
    expect(kept.length).toBeLessThanOrEqual(KEEP_RECENT + KEEP_DAYS);
    // Fewer than KEEP_RECENT: nothing goes.
    expect(staleCopies(copies.slice(0, 10))).toEqual([]);
  });

  it('deletes copies retention no longer keeps when it writes one', async () => {
    const name = 'copies-retention';
    const stub = await canvas(name);
    const older = KEEP_RECENT + 5;
    await build(stub, older + 2, 520, 600, 10_000);
    // Earlier copies, as if written once an hour before (their content is never read here):
    // seqs 1..older, the newest an hour before T.
    for (let seq = 1; seq <= older; seq++) {
      await OPLOG.put(copyKey(prefix(name), seq), new Uint8Array([seq]), {
        customMetadata: { writtenAt: String(T - (older + 1 - seq) * HOUR) },
      });
    }
    const before = await listCopies(OPLOG, prefix(name));
    await tick(stub, T);
    const left = await listCopies(OPLOG, prefix(name));
    const own = older + 2;
    const all: CopyInfo[] = [
      { key: copyKey(prefix(name), own), seq: own, writtenAt: T },
      ...before,
    ];
    const stale = new Set(staleCopies(all));
    expect(stale.size).toBeGreaterThan(0);
    expect(left.map((c) => c.seq)).toEqual(all.filter((c) => !stale.has(c.key)).map((c) => c.seq));
    // The new copy and the KEEP_RECENT - 1 before it all stay.
    expect(left.slice(0, KEEP_RECENT).map((c) => c.seq)).toEqual([
      own,
      ...Array.from({ length: KEEP_RECENT - 1 }, (_, i) => older - i),
    ]);
  }, 60_000);

  it('deletes stale copies in batches R2 accepts', async () => {
    const deleted: number[] = [];
    const keys = Array.from({ length: KEEP_RECENT + 2_100 }, (_, i) => i + 1);
    // A bucket whose listing shows that many copies, all on the same day.
    const bucket = {
      put: async () => null,
      list: async () => ({
        objects: keys.map((seq) => ({
          key: copyKey('c/batch', seq),
          customMetadata: { writtenAt: String(T) },
        })),
        truncated: false,
      }),
      delete: async (batch: string[]) => {
        if (batch.length > DELETE_BATCH) throw new Error('too many keys');
        deleted.push(batch.length);
      },
    } as unknown as R2Bucket;
    await runInDurableObject(await canvas('copies-batch'), async (_, state) => {
      const { sql } = state.storage;
      sql.exec(
        "INSERT INTO meta (key, value) VALUES ('checkpoint', ?)",
        JSON.stringify({ seq: 9_999, format: 1, hash: 'h', sha256: 's', gen: 1, parts: 1 }),
      );
      sql.exec("INSERT INTO checkpoint_parts (gen, part, data) VALUES (1, 0, x'00')");
      await copyCheckpoint(sql, bucket, 'c/batch', T, (body) =>
        state.storage.transactionSync(body),
      );
    });
    // All on one day: everything past the KEEP_RECENT newest goes, 1,000 keys at most a call.
    expect(deleted).toEqual([1000, 1000, 100]);
  });

  it('refuses a copy that does not match its metadata or checksums, and falls back to an older one', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const name = 'copies-damaged';
    const stub = await canvas(name);
    await build(stub, 3, 600, 600, 10_000);
    await tick(stub, T);
    await build(stub, 3, 600, 700, 20_000);
    await tick(stub, T + COPY_MS);
    const [newest, older] = await listCopies(OPLOG, prefix(name));
    expect([newest!.seq, older!.seq]).toEqual([6, 3]);
    const original = await OPLOG.get(newest!.key);
    const body = new Uint8Array(await original!.arrayBuffer());
    const metadata = original!.customMetadata!;
    const put = (bytes: Uint8Array, meta: Record<string, string>) =>
      OPLOG.put(newest!.key, bytes, { customMetadata: meta });
    // Half written: shorter than its metadata says.
    await put(body.subarray(0, body.length - 10), metadata);
    await expect(loadCopy(OPLOG, newest!, SIZE)).rejects.toThrow(/does not match its metadata/);
    // A flipped byte in the grid part (gzip may catch it first; either way it is refused).
    const flipped = body.slice();
    flipped[Math.floor(Number(metadata.gridBytes) / 2)]! ^= 0xff;
    await put(flipped, metadata);
    await expect(loadCopy(OPLOG, newest!, SIZE)).rejects.toThrow();
    // A checksum that is not the body's.
    await put(body, { ...metadata, gridSha256: '0'.repeat(64) });
    await expect(loadCopy(OPLOG, newest!, SIZE)).rejects.toThrow(/checksum mismatch/);
    await put(body, { ...metadata, teamSha256: '0'.repeat(64) });
    await expect(loadCopy(OPLOG, newest!, SIZE)).rejects.toThrow(/team checksum mismatch/);
    // A listed clock that is not the state's: rollbacks pick copies by it.
    await put(body, { ...metadata, clock: '1' });
    const listed = (await listCopies(OPLOG, prefix(name)))[0]!;
    await expect(loadCopy(OPLOG, listed, SIZE)).rejects.toThrow(/clock differs/);
    // Another map size.
    await put(body, metadata);
    await expect(loadCopy(OPLOG, newest!, 2048)).rejects.toThrow(/map size differs/);
    expect((await loadCopy(OPLOG, newest!, SIZE)).seq).toBe(6);
    // The damaged newest is skipped for the one before it.
    await put(body, { ...metadata, gridSha256: '0'.repeat(64) });
    expect((await newestCopy(OPLOG, prefix(name), SIZE, () => true))?.seq).toBe(3);
  }, 60_000);

  it('passes over a copy of another format unread, and stops after the attempts it is given', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const name = 'copies-attempts';
    const stub = await canvas(name);
    await build(stub, 2, 600, 600, 10_000);
    await tick(stub, T);
    const [good] = await listCopies(OPLOG, prefix(name));
    const object = await OPLOG.get(good!.key);
    const meta = object!.customMetadata!;
    // Newer copies: one of a future format (its bytes are the good copy's), three damaged.
    await OPLOG.put(copyKey(prefix(name), 9), await object!.arrayBuffer(), {
      customMetadata: { ...meta, seq: '9', format: '2' },
    });
    for (const seq of [6, 7, 8]) {
      await OPLOG.put(copyKey(prefix(name), seq), new Uint8Array([1, 2, 3]), {
        customMetadata: { ...meta, seq: String(seq) },
      });
    }
    expect((await listCopies(OPLOG, prefix(name)))[0]).toMatchObject({ seq: 9, format: '2' });
    const gets: string[] = [];
    const counting = {
      list: (options?: R2ListOptions) => OPLOG.list(options),
      get: (key: string) => {
        gets.push(key);
        return OPLOG.get(key);
      },
    } as unknown as R2Bucket;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await newestCopy(counting, prefix(name), SIZE, () => true))?.seq).toBe(good!.seq);
      expect(gets).toEqual([8, 7, 6, good!.seq].map((s) => copyKey(prefix(name), s)));
      gets.length = 0;
      // Two downloads at most: both damaged, so none, and the good one is never read.
      expect(await newestCopy(counting, prefix(name), SIZE, () => true, undefined, 2)).toBeNull();
      expect(gets).toEqual([8, 7].map((s) => copyKey(prefix(name), s)));
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  }, 60_000);
});

describe('recovery from the copies', () => {
  /**
   * A canvas whose log is in three places: R2 only (seq 1..9, before and after its copy at 5),
   * then SQLite (10..12), with its own checkpoint at 9.
   */
  async function spread(name: string) {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = await canvas(name);
    await build(stub, 5, 400, 400, 10_000);
    await tick(stub, T);
    await build(stub, 4, 400, 500, 20_000);
    await tick(stub, T + 120_000);
    await build(stub, 3, 400, 600, 30_000);
    expect((await listCopies(OPLOG, prefix(name))).map((c) => c.seq)).toEqual([5]);
    expect(await minSeq(stub)).toBe(10);
    const meta = await runInDurableObject(stub, (_, state) =>
      readCheckpointMeta(state.storage.sql),
    );
    expect(meta!.seq).toBe(9);
    return {
      stub,
      snapshot: await stub.snapshot(),
      hash: await liveHash(stub),
      standings: await stub.teamStandings(),
    };
  }

  async function expectRecovered(stub: Stub, before: Awaited<ReturnType<typeof spread>>) {
    const after = await stub.snapshot();
    expect(after.seq).toBe(12);
    expect(await liveHash(stub)).toBe(before.hash);
    expect(await stub.teamStandings()).toEqual(before.standings);
    expect(await stub.lastWriter(400, 600)).toEqual(['a', 1]);
    // A good checkpoint is stored at once, so the next start is an ordinary one.
    const stored = await runInDurableObject(stub, async (_, state) => {
      const loaded = await loadCheckpoint(state.storage.sql);
      return { seq: loaded!.meta.seq, hash: gridHash(loaded!.state) };
    });
    expect(stored).toEqual({ seq: 12, hash: before.hash });
    await evictDurableObject(stub);
    expect(await liveHash(stub)).toBe(before.hash);
    expect(await stub.teamStandings()).toEqual(before.standings);
    // And it plays on from there.
    await act(stub, 'a', 1, brick(700, 700), 40_000);
    expect((await stub.status()).seq).toBe(13);
  }

  it('rebuilds a damaged checkpoint from the newest copy, the R2 log after it and SQLite', async () => {
    const before = await spread('recover-damaged');
    await runInDurableObject(before.stub, (_, state) => {
      state.storage.sql.exec('UPDATE checkpoint_parts SET data = ?', new Uint8Array(64).buffer);
    });
    await evictDurableObject(before.stub);
    await expectRecovered(before.stub, before);
  }, 60_000);

  it('rebuilds a missing checkpoint under a trimmed log the same way', async () => {
    const before = await spread('recover-missing');
    await runInDurableObject(before.stub, (_, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'checkpoint'");
    });
    await evictDurableObject(before.stub);
    await expectRecovered(before.stub, before);
  }, 60_000);

  it('replays the R2 log from seq 0 when no copy reads back', async () => {
    const before = await spread('recover-no-copy');
    const [copy] = await listCopies(OPLOG, prefix('recover-no-copy'));
    await OPLOG.put(copy!.key, new Uint8Array([1, 2, 3]), {
      customMetadata: (await OPLOG.head(copy!.key))!.customMetadata!,
    });
    await runInDurableObject(before.stub, (_, state) => {
      state.storage.sql.exec('DELETE FROM checkpoint_parts');
    });
    await evictDurableObject(before.stub);
    await expectRecovered(before.stub, before);
  }, 60_000);

  it('downloads at most RECOVERY_COPY_ATTEMPTS copies, then replays the R2 log from seq 0', async () => {
    const name = 'recover-attempts';
    const before = await spread(name);
    const [good] = await listCopies(OPLOG, prefix(name));
    const meta = (await OPLOG.head(good!.key))!.customMetadata!;
    // Damaged copies newer than the good one (at 5), all within the log's reach (12).
    const damaged = Array.from({ length: RECOVERY_COPY_ATTEMPTS }, (_, i) => 6 + i);
    for (const seq of damaged) {
      await OPLOG.put(copyKey(prefix(name), seq), new Uint8Array([1, 2, 3]), {
        customMetadata: { ...meta, seq: String(seq) },
      });
    }
    await runInDurableObject(before.stub, (_, state) => {
      state.storage.sql.exec('UPDATE checkpoint_parts SET data = ?', new Uint8Array(64).buffer);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await evictDurableObject(before.stub);
      await expectRecovered(before.stub, before);
      const lines = errors.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((l) => /checkpoint copy .* unusable/.test(l))).toHaveLength(
        RECOVERY_COPY_ATTEMPTS,
      );
      expect(lines.some((l) => l.includes('starting from the checkpoint copy'))).toBe(false);
      expect(lines.some((l) => l.includes('no usable checkpoint copy'))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  }, 60_000);

  it('starts the ledger empty from a copy without its team part, and says so by seq only', async () => {
    const name = 'recover-no-team-part';
    const before = await spread(name);
    const [copy] = await listCopies(OPLOG, prefix(name));
    const object = await OPLOG.get(copy!.key);
    const { teamSha256: _, ...meta } = object!.customMetadata!;
    const body = new Uint8Array(await object!.arrayBuffer());
    await OPLOG.put(copy!.key, body.subarray(0, Number(meta.gridBytes)), {
      customMetadata: { ...meta, teamBytes: '0' },
    });
    await runInDurableObject(before.stub, (_, state) => {
      state.storage.sql.exec('UPDATE checkpoint_parts SET data = ?', new Uint8Array(64).buffer);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await evictDurableObject(before.stub);
      expect((await before.stub.status()).seq).toBe(12);
      expect(await liveHash(before.stub)).toBe(before.hash);
      const events = errors.mock.calls
        .map((call) => call[1] as { event?: string } | undefined)
        .filter((fields) => fields?.event === 'ledger_empty');
      expect(events).toEqual([{ event: 'ledger_empty', seq: 5, reason: 'copy_without_team_part' }]);
    } finally {
      errors.mockRestore();
    }
    // Cells written up to the copy count for nobody; those after it for their writers.
    expect(await before.stub.lastWriter(400, 400)).toBeNull();
    expect(await before.stub.lastWriter(400, 600)).toEqual(['a', 1]);
  }, 60_000);

  it('drops the team checkpoint with a damaged grid one, so a later start finds them in step', async () => {
    const stub = await canvas('recover-local-team');
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    await build(stub, 3, 600, 600, 10_000);
    // A checkpoint (grid and team), but no shipping and so no trimming.
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const holder = instance as unknown as { env: Env };
      const real = holder.env;
      holder.env = { ...real, OPLOG: undefined };
      await instance.tick(T);
      holder.env = real;
    });
    const standings = await stub.teamStandings();
    const teamMeta = () =>
      sql<{ value: string }>(stub, "SELECT value FROM meta WHERE key = 'team_checkpoint'");
    expect(await teamMeta()).toHaveLength(1);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('UPDATE checkpoint_parts SET data = ?', new Uint8Array(64).buffer);
    });
    // The new checkpoint after the replay cannot be stored: the start ends with none.
    type Store = { storeRecovered(...args: unknown[]): Promise<void> };
    const proto = await runInDurableObject(
      stub,
      (instance: CanvasDO) => Object.getPrototypeOf(instance) as Store,
    );
    const original = proto.storeRecovered;
    proto.storeRecovered = async () => {
      throw new Error('store failed');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await evictDurableObject(stub);
      await runInDurableObject(stub, (instance: CanvasDO) => {
        (instance as unknown as { maintainedAt: number }).maintainedAt = T + HOUR;
      });
      // Neither checkpoint is left: the team one went in the grid one's transaction.
      expect(await sql(stub, "SELECT 1 FROM meta WHERE key = 'checkpoint'")).toEqual([]);
      expect(await teamMeta()).toEqual([]);
      expect(await sql(stub, 'SELECT 1 FROM team_checkpoint_parts')).toEqual([]);
      proto.storeRecovered = original;
      errors.mockClear();
      // The next start replays the whole log, grid and ledger alike, with nothing out of step.
      await evictDurableObject(stub);
      expect((await stub.status()).seq).toBe(3);
      expect(await stub.teamStandings()).toEqual(standings);
      const lines = errors.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((l) => /team checkpoint at seq/.test(l))).toEqual([]);
    } finally {
      proto.storeRecovered = original;
      errors.mockRestore();
    }
  }, 60_000);

  it('rebuilds a damaged checkpoint from SQLite alone while the whole log is there', async () => {
    const stub = await canvas('recover-local');
    await build(stub, 3, 600, 600, 10_000);
    // A checkpoint, but no shipping and so no trimming: as without a log bucket.
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const holder = instance as unknown as { env: Env };
      const real = holder.env;
      holder.env = { ...real, OPLOG: undefined };
      await instance.tick(T);
      holder.env = real;
    });
    expect(await minSeq(stub)).toBe(1);
    const hash = await liveHash(stub);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('UPDATE checkpoint_parts SET data = ?', new Uint8Array(64).buffer);
    });
    await evictDurableObject(stub);
    expect((await stub.status()).seq).toBe(3);
    expect(await liveHash(stub)).toBe(hash);
    const stored = await runInDurableObject(stub, (_, state) =>
      loadCheckpoint(state.storage.sql).then((c) => c!.meta.seq),
    );
    expect(stored).toBe(3);
  });

  it('never starts from a copy past what the log reaches', async () => {
    const before = await spread('recover-reach');
    const name = 'recover-reach';
    // A copy that claims seq 999, past the log's last seq (12) and shipped seq (9): its bytes
    // are the real copy's, so only the bound keeps it out.
    const [real] = await listCopies(OPLOG, prefix(name));
    const object = await OPLOG.get(real!.key);
    await OPLOG.put(copyKey(prefix(name), 999), await object!.arrayBuffer(), {
      customMetadata: { ...object!.customMetadata!, seq: '999' },
    });
    await runInDurableObject(before.stub, (_, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'checkpoint'");
    });
    await evictDurableObject(before.stub);
    await expectRecovered(before.stub, before);
  }, 60_000);

  it('counts no checkpoint when storing one after a recovery fails, and stores one next', async () => {
    const before = await spread('recover-store-fails');
    const { stub } = before;
    // The class's own method, so the next instance (after the restart) finds it replaced.
    type Store = { storeRecovered(...args: unknown[]): Promise<void> };
    const proto = await runInDurableObject(
      stub,
      (instance: CanvasDO) => Object.getPrototypeOf(instance) as Store,
    );
    const original = proto.storeRecovered;
    proto.storeRecovered = async () => {
      throw new Error('store failed');
    };
    try {
      await runInDurableObject(stub, (_, state) => {
        state.storage.sql.exec('UPDATE checkpoint_parts SET data = ?', new Uint8Array(64).buffer);
      });
      await evictDurableObject(stub);
      // The first call starts the object. In the same call, its maintenance clock moves ahead
      // of the real alarms (see T), so only this test's own tick runs maintenance.
      const started = await runInDurableObject(stub, (instance: CanvasDO, state) => {
        const i = instance as unknown as {
          seq: number;
          checkpointSeq: number;
          trimmedTo: number;
          maintainedAt: number;
        };
        i.maintainedAt = T + 120_000;
        const first = state.storage.sql
          .exec<{ m: number | null }>('SELECT MIN(seq) AS m FROM op_log')
          .one().m;
        return {
          seq: i.seq,
          checkpointSeq: i.checkpointSeq,
          trimmedTo: i.trimmedTo,
          stored: readCheckpointMeta(state.storage.sql),
          first,
        };
      });
      // No checkpoint is stored or counted, and SQLite keeps its rows.
      expect(started).toEqual({ seq: 12, checkpointSeq: 0, trimmedTo: 9, stored: null, first: 10 });
    } finally {
      proto.storeRecovered = original;
    }
    expect(await liveHash(stub)).toBe(before.hash);
    expect(await minSeq(stub)).toBe(10);
    await tick(stub, T + 200_000);
    const meta = await runInDurableObject(stub, (_, state) =>
      readCheckpointMeta(state.storage.sql),
    );
    expect(meta?.seq).toBe(12);
  }, 60_000);

  it('keeps its progress through a long R2 replay, so a start cut short resumes from it', async () => {
    const name = 'recover-progress';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    // A 64² map: a checkpoint per segment costs little.
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      const config = JSON.parse(
        sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'").one().value,
      );
      const small = { ...config, size: 64, open: { x: 0, y: 0, w: 64, h: 64 } };
      sql.exec("UPDATE meta SET value = ? WHERE key = 'config'", JSON.stringify(small));
    });
    await evictDurableObject(stub);
    await tick(stub, START);
    // One segment per op: each tick checkpoints, ships and trims its row.
    const segments = RECOVERY_SEGMENTS + 4;
    for (let i = 0; i < segments; i++) {
      await act(stub, 'a', 0, brick(2 * (i % 30), 2 * Math.floor(i / 30)), 10_000 + i * 1_000);
      await tick(stub, T + i * 60_000);
    }
    await act(stub, 'a', 0, brick(10, 40), 100_000);
    const last = segments + 1;
    expect(await minSeq(stub)).toBe(last);
    const hash = await runInDurableObject(stub, (instance: CanvasDO) =>
      gridHash(inside(instance).grid),
    );
    // No copy to start from and a damaged checkpoint: the start replays all of R2's log.
    for (const copy of await listCopies(OPLOG, prefix(name))) await OPLOG.delete(copy.key);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('UPDATE checkpoint_parts SET data = ?', new Uint8Array(64).buffer);
    });
    // As if the start ran out of time after its progress checkpoint: the store at the end
    // fails (a start cut short leaves the same storage behind). The stores are recorded.
    type Store = { storeRecovered(...args: unknown[]): Promise<void> };
    const proto = await runInDurableObject(
      stub,
      (instance: CanvasDO) => Object.getPrototypeOf(instance) as Store,
    );
    const original = proto.storeRecovered;
    const stores: number[] = [];
    /** Stores and flushes to disk, in order: each progress checkpoint must reach storage. */
    const steps: string[] = [];
    proto.storeRecovered = async function (this: unknown, ...args: unknown[]) {
      const storage = (this as { ctx: DurableObjectState }).ctx.storage;
      if (!steps.includes('watching')) {
        steps.push('watching');
        const sync = storage.sync.bind(storage);
        storage.sync = async () => {
          steps.push('sync');
          return sync();
        };
      }
      stores.push(args[1] as number);
      steps.push(`store ${args[1]}`);
      if (args[1] === last) throw new Error('out of time');
      return original.apply(this, args);
    };
    try {
      await evictDurableObject(stub);
      await runInDurableObject(stub, (instance: CanvasDO) => {
        // Ahead of the real alarms, so none stores a checkpoint before the restart below.
        (instance as unknown as { maintainedAt: number }).maintainedAt = T + 2 * HOUR;
      });
    } finally {
      proto.storeRecovered = original;
    }
    expect(stores).toEqual([RECOVERY_SEGMENTS, last]);
    expect(steps).toEqual(['watching', `store ${RECOVERY_SEGMENTS}`, 'sync', `store ${last}`]);
    expect(
      (await runInDurableObject(stub, (_, state) => readCheckpointMeta(state.storage.sql)))?.seq,
    ).toBe(RECOVERY_SEGMENTS);
    // Everything in R2 before that checkpoint is gone: only the progress it kept lets the next
    // start succeed, from there.
    for (let s = 1; s <= RECOVERY_SEGMENTS; s++) await OPLOG.delete(logKey(prefix(name), s, s));
    await evictDurableObject(stub);
    expect((await stub.status()).seq).toBe(last);
    expect(
      await runInDurableObject(stub, (instance: CanvasDO) => gridHash(inside(instance).grid)),
    ).toBe(hash);
    const meta = await runInDurableObject(stub, (_, state) =>
      readCheckpointMeta(state.storage.sql),
    );
    expect(meta?.seq).toBe(last);
  }, 60_000);
});

describe('a map that is not a whole number of tiles', () => {
  it('is played, checkpointed, shipped, copied and restored, but never published', async () => {
    const name = 'untileable';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    await runInDurableObject(stub, (_, state) => {
      const { sql } = state.storage;
      const config = JSON.parse(
        sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'").one().value,
      );
      const odd = { ...config, size: 300, open: { x: 100, y: 100, w: 100, h: 100 } };
      sql.exec("UPDATE meta SET value = ? WHERE key = 'config'", JSON.stringify(odd));
    });
    await evictDurableObject(stub);
    await tick(stub, START);
    const internals = await runInDurableObject(stub, (instance: CanvasDO) => {
      const i = instance as unknown as { cdn: unknown; keyframes: unknown };
      return { cdn: i.cdn, keyframes: i.keyframes };
    });
    expect(internals).toEqual({ cdn: null, keyframes: null });
    for (let k = 0; k < 3; k++) {
      await runInDurableObject(stub, (canvas, state) => {
        foldNow(canvas, state.storage);
        state.storage.sql.exec(
          'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
            'VALUES (?, ?, 0, ?, 1)',
          'p1',
          JSON.stringify([{ kind: 'brick', shape: 1 }]),
          NEVER,
        );
      });
      const batch = await stub.applyBatch(
        [{ player: 'p1', opId: 500 + k, op: brick(120 + 2 * k, 120) }],
        1_000 + k,
      );
      expect(batch.results[0]!.ok).toBe(true);
    }
    await tick(stub, T);
    expect(await minSeq(stub)).toBeNull();
    expect((await listCopies(OPLOG, prefix(name))).map((c) => c.seq)).toEqual([3]);
    expect((await TILES.list({ prefix: `${prefix(name)}/` })).objects).toEqual([]);
    const before = await stub.snapshot();
    await evictDurableObject(stub);
    const after = await stub.snapshot();
    expect(after.seq).toBe(3);
    expect(after.cells.length).toBe(300 * 300);
    let same = after.cells.length === before.cells.length;
    for (let i = 0; same && i < after.cells.length; i++) same = after.cells[i] === before.cells[i];
    expect(same).toBe(true);
    // The copy reads back at its own size.
    const [copy] = await listCopies(OPLOG, prefix(name));
    const loaded = await loadCopy(OPLOG, copy!, 300);
    expect(loaded.state.cells.length).toBe(300 * 300);
    expect(gridHash(loaded.state)).toBe(
      await runInDurableObject(stub, (instance: CanvasDO) => gridHash(inside(instance).grid)),
    );
  });
});
