import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DEFAULT_MAP_SIZE, type Item, type Op } from '@brickplace/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { gunzip, prepareCheckpoint, storeCheckpoint } from '../src/checkpoints.ts';
import type { CanvasDO, Env, TeamStats } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';
import { logKey } from '../src/oplog.ts';
import { DAY_MS, PUBLISH_MS, parseWho, TEAM_CAP_KEY, type TeamLedger } from '../src/teams.ts';

const { CANVAS, OPLOG, MODERATION, STANDINGS } = env as unknown as Required<Env>;
type Stub = ReturnType<typeof CANVAS.get>;
const NEVER = 2 ** 50;

let nextOpId = 1;

function itemOf(op: Op): Item {
  return op.kind === 'brick' ? { kind: 'brick', shape: op.shape } : ({ kind: op.kind } as Item);
}

/** The private parts tests reach into. */
type Internals = { env: Env; teams: TeamLedger };
const inside = (instance: CanvasDO) => instance as unknown as Internals;

/**
 * Waits for the canvas's read of the daily cap. Ops never wait for it (ADR 0020), so a test
 * that wants the cap to apply from its first op waits here first.
 */
const warm = (instance: CanvasDO) =>
  inside(instance).teams.refreshCap(inside(instance).env.MODERATION, Date.now());

/**
 * Gives the player exactly the item for this op, waits for the cap, then applies the op as one
 * batch.
 */
async function act(stub: Stub, player: string, team: unknown, op: Op, at = 1_000) {
  await runInDurableObject(stub, async (instance: CanvasDO, state) => {
    await warm(instance);
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify([itemOf(op)]),
      NEVER,
    );
  });
  const { results } = await stub.applyBatch(
    [{ player, opId: nextOpId++, op, team: team as number }],
    at,
  );
  return results[0]!;
}

const o = (x: number, y: number, color = 3): Op => ({
  kind: 'brick',
  x,
  y,
  shape: 1,
  rotation: 0,
  color,
});
const hammer = (x: number, y: number): Op => ({ kind: 'hammer', x, y });
const shield = (x: number, y: number): Op => ({ kind: 'shield', x, y });
const single = (x: number, y: number): Op => ({ kind: 'single', x, y, color: 4 });

const ZERO: TeamStats = { cells: 0, built: 0, cleared: 0, shields: 0 };
const standing = async (stub: Stub, team: number) => (await stub.teamStandings()).get(team) ?? ZERO;

const tick = (stub: Stub, now: number) =>
  runInDurableObject(stub, (instance: CanvasDO) => instance.tick(now));

const sql = <T>(stub: Stub, query: string) =>
  runInDurableObject(stub, (_, state) => state.storage.sql.exec(query).toArray() as T[]);

describe('team counters on the canvas', () => {
  beforeEach(async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
  });

  it('counts cells standing per team at write time, through hammers and rebuilds', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-basic'));
    expect((await act(stub, 'alice', 7, o(600, 600))).ok).toBe(true);
    expect(await standing(stub, 7)).toEqual({ cells: 4, built: 4, cleared: 0, shields: 0 });
    expect(await stub.lastWriter(601, 601)).toEqual(['alice', 7]);

    // Another team's hammer empties one cell: it leaves team 7 and counts as cleared for 9.
    expect((await act(stub, 'bob', 9, hammer(601, 601))).ok).toBe(true);
    expect(await standing(stub, 7)).toEqual({ cells: 3, built: 4, cleared: 0, shields: 0 });
    expect(await standing(stub, 9)).toEqual({ cells: 0, built: 0, cleared: 1, shields: 0 });
    expect(await stub.lastWriter(601, 601)).toBeNull();

    // The emptied cell, filled again, belongs to its new writer.
    expect((await act(stub, 'alice', 7, hammer(600, 600))).ok).toBe(true);
    expect((await act(stub, 'alice', 7, hammer(601, 600))).ok).toBe(true);
    expect((await act(stub, 'alice', 7, hammer(600, 601))).ok).toBe(true);
    expect(await standing(stub, 7)).toEqual({ cells: 0, built: 4, cleared: 3, shields: 0 });
    expect((await act(stub, 'bob', 9, o(600, 600))).ok).toBe(true);
    expect(await stub.lastWriter(601, 601)).toEqual(['bob', 9]);
    expect(await standing(stub, 9)).toEqual({ cells: 4, built: 4, cleared: 1, shields: 0 });

    // Alice switches team: what she built before stays with the team it was built for.
    expect((await act(stub, 'alice', 11, o(700, 700))).ok).toBe(true);
    expect(await standing(stub, 11)).toMatchObject({ cells: 4, built: 4 });
    expect(await standing(stub, 7)).toMatchObject({ cells: 0, built: 4 });
  });

  it('keeps the writer of a shielded cell when a hammer only breaks a layer', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-shield'));
    await act(stub, 'alice', 7, o(600, 600));
    expect((await act(stub, 'carol', 5, shield(600, 600))).ok).toBe(true);
    expect(await standing(stub, 5)).toEqual({ cells: 0, built: 0, cleared: 0, shields: 1 });
    // The shield does not take the cell over.
    expect(await stub.lastWriter(600, 600)).toEqual(['alice', 7]);
    const broke = await act(stub, 'bob', 9, hammer(600, 600));
    expect(broke.ok && broke.diffs.at(-1)).toMatchObject({ shield: 0 });
    expect(await stub.lastWriter(600, 600)).toEqual(['alice', 7]);
    expect(await standing(stub, 7)).toMatchObject({ cells: 4 });
    expect(await standing(stub, 9)).toEqual(ZERO);
    // The next hammer empties it.
    await act(stub, 'bob', 9, hammer(600, 600));
    expect(await standing(stub, 7)).toMatchObject({ cells: 3 });
    expect(await standing(stub, 9)).toMatchObject({ cleared: 1 });
  });

  it('gives a single brick its one cell, and changes nothing on a discard or a refusal', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-single'));
    // A one-cell hole at (601, 601), walled in on all four sides.
    await act(stub, 'alice', 7, o(600, 600));
    await act(stub, 'alice', 7, o(602, 600));
    await act(stub, 'alice', 7, o(600, 602));
    await act(stub, 'alice', 7, hammer(601, 601));
    expect(await standing(stub, 7)).toEqual({ cells: 11, built: 12, cleared: 1, shields: 0 });
    expect((await act(stub, 'bob', 9, single(601, 601))).ok).toBe(true);
    expect(await standing(stub, 9)).toEqual({ cells: 1, built: 1, cleared: 0, shields: 0 });
    expect(await stub.lastWriter(601, 601)).toEqual(['bob', 9]);

    const before = await stub.teamStandings();
    // Refused ops (occupied, empty) and a discard leave the counters alone.
    expect((await act(stub, 'bob', 9, o(600, 600))).ok).toBe(false);
    expect((await act(stub, 'bob', 9, hammer(700, 700))).ok).toBe(false);
    // Refused, so bob keeps the shield; then throws it away.
    expect((await act(stub, 'bob', 9, shield(720, 720))).ok).toBe(false);
    expect((await stub.discard('bob', nextOpId++, { kind: 'shield' })).result.ok).toBe(true);
    expect(await stub.teamStandings()).toEqual(before);
    expect(await sql(stub, 'SELECT seq FROM op_log WHERE seq > 5')).toEqual([]);
  });

  it('counts players without a team, or with a malformed one, for nobody', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-none'));
    await act(stub, 'dana', undefined, o(400, 600));
    await act(stub, 'erin', -3, o(500, 600));
    await act(stub, 'finn', '12', o(600, 600));
    await act(stub, 'gail', 1.5, o(700, 600));
    expect(await stub.teamStandings()).toEqual(new Map());
    // The writer is still known, for moderation.
    expect(await stub.lastWriter(401, 601)).toEqual(['dana', 0]);
    expect(await stub.lastWriter(601, 601)).toEqual(['finn', 0]);
    // A hammer by someone without a team still takes the cell from its team.
    await act(stub, 'alice', 7, o(720, 720));
    await act(stub, 'dana', 0, hammer(720, 720));
    expect(await standing(stub, 7)).toMatchObject({ cells: 3, built: 4 });
  });

  it('logs who each op counted for beside it, and nothing beside an open-area change', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-log'));
    // A maintenance pass ahead of the wall clock first, so no real alarm trims the rows below
    // while the test reads them (see 'teams-persist').
    await tick(stub, (Math.floor(Date.now() / 3_600_000) + 2) * 3_600_000 - 1_800_000);
    await act(stub, 'alice', 7, o(600, 600));
    expect(await stub.setOpenArea({ x: 128, y: 128, w: 768, h: 768 })).toMatchObject({
      ok: true,
    });
    await act(stub, 'bob', undefined, o(200, 200));
    const rows = await sql<{ seq: number; who: string | null }>(
      stub,
      'SELECT seq, who FROM op_log ORDER BY seq',
    );
    expect(rows).toEqual([
      { seq: 1, who: '[["alice",7]]' },
      { seq: 2, who: null },
      { seq: 3, who: '[["bob",0]]' },
    ]);
  });
});

describe('the daily contribution cap', () => {
  it('stops counting placements past the cap until the next day, but keeps the cells', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '5');
    const stub = CANVAS.get(CANVAS.idFromName('teams-cap'));
    const day = 20_000 * DAY_MS;
    await act(stub, 'alice', 7, o(300, 600), day + 1);
    // 4 + 4 > 5: the second brick is placed but counts for no team.
    expect((await act(stub, 'alice', 7, o(400, 600), day + 2)).ok).toBe(true);
    expect(await stub.lastWriter(400, 600)).toEqual(['alice', 0]);
    expect(await standing(stub, 7)).toEqual({ cells: 4, built: 4, cleared: 0, shields: 0 });
    // Shields and hammers do not use the cap; a cell of nobody hammered is still cleared.
    await act(stub, 'alice', 7, shield(300, 600), day + 3);
    await act(stub, 'alice', 7, hammer(400, 600), day + 4);
    expect(await standing(stub, 7)).toEqual({ cells: 4, built: 4, cleared: 1, shields: 1 });
    // The cap is per account: another player of the team still counts.
    await act(stub, 'bob', 7, o(500, 600), day + 9);
    expect(await standing(stub, 7)).toMatchObject({ cells: 8, built: 8 });
    // The next UTC day of the op's own time starts from zero again.
    await act(stub, 'alice', 7, o(600, 600), day + DAY_MS);
    expect(await standing(stub, 7)).toMatchObject({ cells: 12, built: 12 });
    // Counts survive a restart.
    await evictDurableObject(stub);
    await act(stub, 'alice', 7, o(700, 600), day + DAY_MS + 1);
    expect(await stub.lastWriter(700, 600)).toEqual(['alice', 0]);
  });

  it('counts no placement toward any team when the cap is missing (fail closed)', async () => {
    await MODERATION.delete(TEAM_CAP_KEY);
    const stub = CANVAS.get(CANVAS.idFromName('teams-no-cap'));
    await act(stub, 'alice', 7, o(600, 600));
    expect(await stub.lastWriter(600, 600)).toEqual(['alice', 0]);
    await act(stub, 'alice', 7, shield(600, 600));
    expect(await stub.teamStandings()).toEqual(new Map([[7, { ...ZERO, shields: 1 }]]));
  });

  it('treats a malformed cap like a missing one', async () => {
    await MODERATION.put(TEAM_CAP_KEY, 'lots');
    const stub = CANVAS.get(CANVAS.idFromName('teams-bad-cap'));
    await act(stub, 'alice', 7, o(600, 600));
    expect(await standing(stub, 7)).toEqual(ZERO);
  });

  it('still counts a placement that reaches the cap exactly', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '8');
    const stub = CANVAS.get(CANVAS.idFromName('teams-cap-edge'));
    await act(stub, 'alice', 7, o(600, 600));
    // 4 + 4 = 8: counts.
    await act(stub, 'alice', 7, o(700, 600));
    expect(await stub.lastWriter(700, 600)).toEqual(['alice', 7]);
    // 8 + 4 > 8: does not.
    await act(stub, 'alice', 7, o(750, 600));
    expect(await stub.lastWriter(750, 600)).toEqual(['alice', 0]);
    expect(await standing(stub, 7)).toMatchObject({ cells: 8, built: 8 });
  });

  it('counts nothing until the first read of the cap has arrived, and never waits for it', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = CANVAS.get(CANVAS.idFromName('teams-cap-cold'));
    await runInDurableObject(stub, async (instance: CanvasDO, state) => {
      let release: () => void = () => {};
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The constructor already started a read: let it land, then forget it, as if the
      // canvas had just started and KV had not answered yet.
      await warm(instance);
      (inside(instance).teams as unknown as { cap: null }).cap = null;
      const real = inside(instance).env.MODERATION!;
      inside(instance).env = {
        ...inside(instance).env,
        MODERATION: {
          get: async (key: string) => {
            await slow;
            return real.get(key);
          },
        } as unknown as KVNamespace,
      };
      foldNow(instance, state.storage);
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
          "VALUES ('alice', ?, 0, ?, 1)",
        JSON.stringify([itemOf(o(0, 0)), itemOf(o(0, 0))]),
        NEVER,
      );
      // KV has not answered: the op goes through at once and counts for no team.
      const first = await instance.applyBatch([
        { player: 'alice', opId: 1, op: o(600, 600), team: 7 },
      ]);
      expect(first.results[0]!.ok).toBe(true);
      release();
      await warm(instance);
      await instance.applyBatch([{ player: 'alice', opId: 2, op: o(700, 600), team: 7 }]);
    });
    expect(await stub.lastWriter(600, 600)).toEqual(['alice', 0]);
    expect(await stub.lastWriter(700, 600)).toEqual(['alice', 7]);
  });

  it('takes a cell from its team when a hammer empties it after its shield expired', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const stub = CANVAS.get(CANVAS.idFromName('teams-expired-shield'));
    const hour = 3_600_000;
    await act(stub, 'alice', 7, o(600, 600), 1_000);
    await act(stub, 'alice', 7, shield(600, 600), 2_000);
    // Past the 48 h lifetime: the layer expires first (an earlier diff of the same cell), then
    // the hammer empties the cell.
    const result = await act(stub, 'bob', 9, hammer(600, 600), 2_000 + 48 * hour + 1);
    expect(
      result.ok && result.diffs.filter((d) => d.index === 600 * DEFAULT_MAP_SIZE + 600),
    ).toHaveLength(2);
    expect(await stub.lastWriter(600, 600)).toBeNull();
    expect(await standing(stub, 7)).toMatchObject({ cells: 3 });
    expect(await standing(stub, 9)).toMatchObject({ cleared: 1 });
  });
});

describe('team counters across checkpoints, trimming and restarts', () => {
  beforeEach(async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
  });

  it('restores the same counters and writers from a checkpoint plus the log tail', async () => {
    const name = 'teams-persist';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    // Maintenance ticks ahead of the wall clock, after one at START, as in season.test.ts.
    // Real alarms no longer fire during tests at all (test/setup.ts); before that, one ran
    // maintenance between these ticks under a loaded full run and trimmed rows unexpectedly.
    const T = (Math.floor(Date.now() / 3_600_000) + 2) * 3_600_000;
    await tick(stub, T - 1_800_000);
    await act(stub, 'alice', 7, o(600, 600), 1_000);
    await act(stub, 'bob', 9, hammer(601, 601), 2_000);
    await act(stub, 'carol', 9, shield(600, 600), 3_000);
    // Checkpoint, ship and trim: the rows above leave SQLite.
    await tick(stub, T);
    expect(await sql(stub, 'SELECT seq FROM op_log')).toEqual([]);
    const [meta] = await sql<{ value: string }>(
      stub,
      "SELECT value FROM meta WHERE key = 'team_checkpoint'",
    );
    expect(JSON.parse(meta!.value)).toMatchObject({ seq: 3 });
    // The shipped log carries who each op counted for.
    const object = await OPLOG.get(logKey(`c/${name}`, 1, 3));
    const text = new TextDecoder().decode(
      await gunzip(new Uint8Array(await object!.arrayBuffer())),
    );
    expect(text).toContain('"who":"[[\\"bob\\",9]]"');

    // A tail after the checkpoint, with an open-area row in it.
    await act(stub, 'bob', 9, o(700, 700), 4_000);
    expect(await stub.setOpenArea({ x: 128, y: 128, w: 768, h: 768 })).toMatchObject({
      ok: true,
    });
    await act(stub, 'dana', 7, hammer(700, 700), 5_000);
    await act(stub, 'dana', 7, o(200, 200), 6_000);
    const before = await stub.teamStandings();
    expect(before.get(7)).toEqual({ cells: 7, built: 8, cleared: 1, shields: 0 });
    expect(before.get(9)).toEqual({ cells: 3, built: 4, cleared: 1, shields: 1 });

    await evictDurableObject(stub);
    expect(await stub.teamStandings()).toEqual(before);
    expect(await stub.lastWriter(600, 600)).toEqual(['alice', 7]);
    expect(await stub.lastWriter(700, 700)).toBeNull();
    expect(await stub.lastWriter(701, 700)).toEqual(['bob', 9]);
    expect(await stub.lastWriter(200, 200)).toEqual(['dana', 7]);

    // A second checkpoint replaces the first; after another restart nothing has moved.
    // After the restart the object's pass clock starts over: one at START first, as above.
    await tick(stub, T - 1_800_000);
    await tick(stub, T + 100_000);
    expect(await sql(stub, 'SELECT seq FROM op_log')).toEqual([]);
    const parts = await sql<{ gen: number }>(
      stub,
      'SELECT DISTINCT gen FROM team_checkpoint_parts',
    );
    expect(parts).toHaveLength(1);
    await evictDurableObject(stub);
    expect(await stub.teamStandings()).toEqual(before);
    expect(await stub.lastWriter(601, 600)).toEqual(['alice', 7]);
    // About 3 s alone (two full-map checkpoints and three restores), all CPU: five game runs in
    // parallel on an 8-core machine took it past 15 s.
  }, 60_000);

  it('starts a canvas from before teams with its old cells counting for nobody', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-legacy'));
    await act(stub, 'alice', 7, o(600, 600));
    await act(stub, 'alice', 7, o(700, 600));
    // As if logged before the `who` column existed.
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('UPDATE op_log SET who = NULL');
    });
    await evictDurableObject(stub);
    expect(await stub.teamStandings()).toEqual(new Map());
    expect(await stub.lastWriter(600, 600)).toBeNull();
    // Hammering such a cell takes nothing from anyone; new cells count again.
    await act(stub, 'bob', 9, hammer(600, 600));
    await act(stub, 'bob', 9, o(750, 600));
    expect(await standing(stub, 9)).toEqual({ cells: 4, built: 4, cleared: 1, shields: 0 });
  });

  it('writes standings to D1 at most once a minute while they change', async () => {
    const name = 'teams-publish';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    await act(stub, 'alice', 7, o(600, 600));
    await act(stub, 'bob', 9, hammer(600, 600));
    const read = async () =>
      (
        await STANDINGS.prepare(
          'SELECT team_id, cells, built, cleared, shields, updated_at FROM team_standings ' +
            'WHERE canvas = ? ORDER BY team_id',
        )
          .bind(name)
          .all()
      ).results;
    const t0 = 20_000_000;
    await tick(stub, t0);
    expect(await read()).toEqual([
      { team_id: 7, cells: 3, built: 4, cleared: 0, shields: 0, updated_at: t0 },
      { team_id: 9, cells: 0, built: 0, cleared: 1, shields: 0, updated_at: t0 },
    ]);
    await act(stub, 'alice', 7, o(700, 600));
    await tick(stub, t0 + 30_000);
    expect((await read())[0]).toMatchObject({ cells: 3, updated_at: t0 });
    await tick(stub, t0 + PUBLISH_MS);
    expect(await read()).toEqual([
      { team_id: 7, cells: 7, built: 8, cleared: 0, shields: 0, updated_at: t0 + PUBLISH_MS },
      { team_id: 9, cells: 0, built: 0, cleared: 1, shields: 0, updated_at: t0 },
    ]);
  });

  it('starts the map with an empty ledger when the team checkpoint does not read back', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-corrupt'));
    await act(stub, 'alice', 7, o(600, 600), 1_000);
    await tick(stub, 30_000_000);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE team_checkpoint_parts SET data = x'00'");
    });
    await evictDurableObject(stub);
    // The canvas starts and plays; only the ranking's data is gone.
    expect(await stub.lastWriter(600, 600)).toBeNull();
    expect((await act(stub, 'bob', 9, o(700, 600), 2_000)).ok).toBe(true);
    expect(await stub.teamStandings()).toEqual(
      new Map([[9, { cells: 4, built: 4, cleared: 0, shields: 0 }]]),
    );
    expect((await stub.snapshot()).cells[600 * DEFAULT_MAP_SIZE + 600]).not.toBe(0);
  });

  it('keeps the current team checkpoint when the grid checkpoint fails its read-back', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-staged'));
    await act(stub, 'alice', 7, o(600, 600), 1_000);
    await tick(stub, 40_000_000);
    const metaOf = async () =>
      (
        await sql<{ value: string }>(stub, "SELECT value FROM meta WHERE key = 'team_checkpoint'")
      )[0]!.value;
    const before = await metaOf();
    await act(stub, 'alice', 7, o(700, 600), 2_000);
    const committed = await runInDurableObject(stub, async (instance: CanvasDO, state) => {
      const ledger = (instance as unknown as { teams: TeamLedger }).teams;
      const save = (body: () => void) => state.storage.transactionSync(body);
      let ran = false;
      const commit = await ledger.stage(2, ledger.encode(), save);
      const prepared = await prepareCheckpoint('wrong-hash', new Uint8Array(8), 2, 1);
      await expect(
        storeCheckpoint(state.storage.sql, prepared, save, undefined, () => {
          ran = true;
          commit();
        }),
      ).rejects.toThrow();
      return ran;
    });
    expect(committed).toBe(false);
    expect(await metaOf()).toBe(before);
    // The next real checkpoint replaces the staged parts and moves on.
    await tick(stub, 40_100_000);
    expect(JSON.parse(await metaOf())).toMatchObject({ seq: 2 });
    expect(await sql(stub, 'SELECT DISTINCT gen FROM team_checkpoint_parts')).toHaveLength(1);
    await evictDurableObject(stub);
    expect(await standing(stub, 7)).toMatchObject({ cells: 8, built: 8 });
  });

  it('reads the cap once per few minutes while KV fails, keeping the last value', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-kv-down'));
    await act(stub, 'alice', 7, o(600, 600), 1_000);
    let reads = 0;
    await runInDurableObject(stub, (instance: CanvasDO) => {
      // Ops never wait for the cap: `act` waits for each read itself, so this counts them.
      const target = instance as unknown as { env: Env; teams: { cap: { at: number } } };
      target.env = {
        ...target.env,
        MODERATION: {
          get: async () => {
            reads++;
            throw new Error('KV is down');
          },
        } as unknown as KVNamespace,
      };
      // As if the cached value had just gone stale.
      target.teams.cap.at = 0;
    });
    await act(stub, 'alice', 7, o(650, 600), 2_000);
    await act(stub, 'alice', 7, o(700, 600), 3_000);
    await act(stub, 'alice', 7, o(750, 600), 4_000);
    expect(reads).toBe(1);
    // The cap read before the outage still applies.
    expect(await standing(stub, 7)).toMatchObject({ cells: 16, built: 16 });
  });

  it('gives up on a KV read of the cap that never answers, and reads again later', async () => {
    const stub = CANVAS.get(CANVAS.idFromName('teams-kv-hangs'));
    await act(stub, 'alice', 7, o(600, 600), 1_000);
    const seen = await runInDurableObject(stub, async (instance: CanvasDO) => {
      const target = instance as unknown as {
        env: Env;
        teams: Pick<TeamLedger, 'refreshCap'> & { cap: { value: number | null; at: number } };
      };
      const real = target.env;
      let reads = 0;
      const hung = {
        get: () => {
          reads++;
          return new Promise<never>(() => {});
        },
      } as unknown as KVNamespace;
      target.teams.cap.at = 0;
      // Without a timeout this never settles, and every later refresh returns it again.
      await target.teams.refreshCap(hung, 10 * 60_000, 20);
      const kept = target.teams.cap.value;
      await MODERATION.put(TEAM_CAP_KEY, '4');
      // Fresh for a few minutes, then read again from a KV that answers.
      await target.teams.refreshCap(real.MODERATION, 11 * 60_000);
      const stillKept = target.teams.cap.value;
      await target.teams.refreshCap(real.MODERATION, 20 * 60_000);
      return { reads, kept, stillKept, now: target.teams.cap.value };
    });
    expect(seen).toEqual({ reads: 1, kept: 1000, stillKept: 1000, now: 4 });
  });

  it('marks the teams of a failed standings write to be sent again', async () => {
    const name = 'teams-publish-fails';
    const stub = CANVAS.get(CANVAS.idFromName(name));
    await act(stub, 'alice', 7, o(600, 600));
    const t0 = 50_000_000;
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      const real = inside(instance).env;
      inside(instance).env = {
        ...real,
        STANDINGS: {
          prepare: (query: string) => real.STANDINGS!.prepare(query),
          batch: async () => {
            throw new Error('D1 is down');
          },
        } as unknown as D1Database,
      };
      await instance.tick(t0);
      inside(instance).env = real;
      expect(inside(instance).teams.publishDueAt()).toBe(t0 + PUBLISH_MS);
    });
    const read = () =>
      STANDINGS.prepare('SELECT team_id, cells FROM team_standings WHERE canvas = ?')
        .bind(name)
        .all();
    expect((await read()).results).toEqual([]);
    await tick(stub, t0 + PUBLISH_MS);
    expect((await read()).results).toEqual([{ team_id: 7, cells: 4 }]);
  });
});

describe('parseWho', () => {
  it('reads [player, team] per entry, and a damaged value as nobody, never throwing', () => {
    expect(parseWho('[["a",7],null]', 2)).toEqual([['a', 7], null]);
    // JSON.parse would quote the id in its message; the row counts for nobody instead.
    expect(parseWho('[["zq7",3', 2)).toEqual([null, null]);
    expect(parseWho('{"x":1}', 1)).toEqual([null]);
    expect(parseWho(null, 1)).toEqual([null]);
  });

  it('tells its caller once when a value is damaged, never for an absent one', () => {
    const told = (value: unknown, entries: number) => {
      let n = 0;
      parseWho(value, entries, () => n++);
      return n;
    };
    // Readable: one pair (or an explicit nobody) per entry, or no column at all.
    expect(told('[["a",7],null]', 2)).toBe(0);
    expect(told(null, 3)).toBe(0);
    expect(told(undefined, 1)).toBe(0);
    // Damaged: not JSON, not a list, a list of another length, an item that is no pair.
    expect(told('[["zq7",3', 2)).toBe(1);
    expect(told('{"x":1}', 1)).toBe(1);
    expect(told('[["a",7]]', 2)).toBe(1);
    expect(told('[["a",7],["b",1],["c",2]]', 2)).toBe(1);
    expect(told('[["a",7],[5,1],"b"]', 3)).toBe(1);
    expect(told(42, 1)).toBe(1);
  });
});
