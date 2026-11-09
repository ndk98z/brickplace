// Map moderation (ADR 0024): rollbacks by player, area and time range, checked against an
// independent replay with the core; area locks.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  applyEntry,
  type CoreConfig,
  createState,
  gridHash,
  type Item,
  isFilled,
  type Op,
  passTime,
  type Rect,
  type State,
} from '@brickplace/core';
import { cdnKeys, decodeSegment, decodeTile, parseManifest } from '@brickplace/protocol/cdn';
import { describe, expect, it, vi } from 'vitest';
import { gunzip } from '../src/checkpoints.ts';
import { COPY_MS, listCopies } from '../src/copies.ts';
import type { CanvasDO, Env, RollbackFilter, RollbackPreview } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';
import { MAX_LOCKS } from '../src/locks.ts';
import {
  JOB_IDLE_MS,
  MAX_ROLLBACK_MEMORY,
  MAX_ROLLBACKS,
  ROLLBACK_LIMITS,
  rollbackMemory,
} from '../src/rollback.ts';
import { TEAM_CAP_KEY, type TeamLedger } from '../src/teams.ts';
import { pendingAlarm } from './alarms.ts';

const { CANVAS, MODERATION, OPLOG, TILES } = env as unknown as Required<Env>;
type Stub = ReturnType<typeof CANVAS.get>;
const NEVER = 2 ** 50;
const HOUR = 3_600_000;
const SIZE = 1024;
/**
 * Maintenance ticks run on the wall clock and ahead of it (from T, one to two hours from now):
 * a canvas is first ticked at START, so a real alarm never runs maintenance in the middle of a
 * test (its `now` is behind the last pass), as in season.test.ts.
 */
const T = (Math.floor(Date.now() / HOUR) + 2) * HOUR;
const START = T - HOUR / 2;

let nextOpId = 1;

function itemOf(op: Op): Item {
  return op.kind === 'brick' ? { kind: 'brick', shape: op.shape } : ({ kind: op.kind } as Item);
}

type Internals = { env: Env; teams: TeamLedger; grid: State };
const inside = (instance: CanvasDO) => instance as unknown as Internals;

/** One accepted op as the test remembers it, for the independent replay. */
interface Played {
  readonly seq: number;
  readonly at: number;
  readonly op: Op;
  readonly player: string;
}

/** A canvas and what was accepted on it, in log order. */
class Game {
  readonly stub: Stub;
  readonly log: Played[] = [];
  /** Seqs of restore rows: plain entries with no op of their own. */
  readonly restores: number[] = [];

  constructor(readonly name: string) {
    this.stub = CANVAS.get(CANVAS.idFromName(name));
  }

  /** A canvas whose maintenance clock is already ahead of the real alarms (see T). */
  static async open(name: string): Promise<Game> {
    const game = new Game(name);
    await game.tick(START);
    return game;
  }

  /** Gives the player the item, waits for the team cap, applies the op as one batch. */
  async act(player: string, team: number, op: Op, at: number) {
    await runInDurableObject(this.stub, async (instance: CanvasDO, state) => {
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
    const batch = await this.stub.applyBatch([{ player, opId: nextOpId++, op, team }], at);
    const result = batch.results[0]!;
    if (result.ok && !('duplicate' in result)) this.log.push({ seq: batch.seq, at, op, player });
    return result;
  }

  /** Previews until ready, then returns the preview. */
  async preview(filter: RollbackFilter): Promise<RollbackPreview> {
    for (let i = 0; i < 200; i++) {
      const status = await this.stub.rollbackPreview(filter);
      if (status.state === 'ready') return status.preview;
      if (status.state === 'failed') throw new Error(`rollback failed: ${status.error}`);
    }
    throw new Error('rollback never caught up');
  }

  /** Previews and applies; checks the apply did what the preview said. */
  async rollback(filter: RollbackFilter): Promise<RollbackPreview> {
    const preview = await this.preview(filter);
    const applied = await this.stub.rollbackApply(preview.job);
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    if (!applied.ok) throw new Error('not applied');
    // Nothing came in between, so the apply is exactly the dry run.
    expect(applied.preview).toEqual(preview);
    if (preview.cells > 0) this.restores.push(applied.record.seq);
    return preview;
  }

  async tick(now: number) {
    await runInDurableObject(this.stub, (instance: CanvasDO) => instance.tick(now));
  }
}

async function configOf(stub: Stub): Promise<CoreConfig> {
  return runInDurableObject(stub, (_, state) => {
    const row = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'")
      .one();
    return JSON.parse(row.value) as CoreConfig;
  });
}

/** What a filter leaves out, as the ADR defines it: player, anchor in area, seq window. */
function matches(
  filter: { player?: string; area?: Rect },
  window: { from: number; to: number },
  played: Played,
) {
  const { op } = played;
  if (played.seq < window.from || played.seq > window.to) return false;
  if (filter.player !== undefined && filter.player !== played.player) return false;
  const a = filter.area;
  return !a || (op.x >= a.x && op.y >= a.y && op.x < a.x + a.w && op.y < a.y + a.h);
}

/**
 * The independent model: the core replays every accepted op except those of the rollbacks,
 * each op's time passing either way (ADR 0024).
 */
function replayWithout(
  config: CoreConfig,
  log: readonly Played[],
  rollbacks: readonly { filter: RollbackFilter; window: { from: number; to: number } }[],
): State {
  const state = createState(config);
  for (const played of log) {
    passTime(state, played.at);
    if (rollbacks.some((r) => matches(r.filter, r.window, played))) continue;
    applyEntry(state, played.op, played.at);
  }
  return state;
}

/** Byte equality of the canvas's grid with a model state; toEqual on 4 MiB takes seconds. */
async function expectGrid(stub: Stub, model: State) {
  const snapshot = await stub.snapshot();
  const live = createState(model.config);
  live.cells.set(snapshot.cells);
  live.shields.set(snapshot.shields);
  expect(gridHash(live)).toBe(gridHash(model));
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

describe('rollback', () => {
  it("undoes a player's hammers and what was built in their holes; the dry run is the apply", async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const game = await Game.open('rollback-player');
    // The artist (team 1) builds three O bricks and shields one cell.
    await game.act('artist', 1, o(600, 600), 1_000);
    await game.act('artist', 1, o(602, 600, 5), 2_000);
    await game.act('artist', 1, o(604, 600, 7), 3_000);
    await game.act('artist', 1, shield(600, 600), 3_500);
    // The griefer (team 2) breaks the layer, clears the cell, and clears a cell of the second.
    for (const [op, at] of [
      [hammer(600, 600), 4_000],
      [hammer(600, 600), 4_100],
      [hammer(603, 601), 4_200],
    ] as const) {
      expect((await game.act('griefer', 2, op, at)).ok).toBe(true);
    }
    // Someone else (team 3) builds into the hole; the artist keeps building elsewhere.
    expect((await game.act('other', 3, o(599, 599, 9), 5_000)).ok).toBe(true);
    await game.act('artist', 1, o(610, 600, 2), 6_000);

    const preview = await game.preview({ player: 'griefer' });
    // No time range: the window is the whole log up to the preview's start.
    expect(preview).toMatchObject({
      window: { from: 1, to: game.log.at(-1)!.seq },
      removedOps: 3,
      removedByKind: { hammer: 3 },
      // The hammered cells and the links into them, and the other player's brick, which no
      // longer fits: (600, 600) is art again.
      cells: 7,
      filled: 1,
      emptied: 3,
      recolored: 3,
      shields: 1,
      bounds: { x: 599, y: 599, w: 5, h: 3 },
      tiles: 1,
      tooLarge: false,
    });
    // A dry run changes nothing.
    const config = await configOf(game.stub);
    const before = createState(config);
    for (const played of game.log) applyEntry(before, played.op, played.at);
    await expectGrid(game.stub, before);

    await game.rollback({ player: 'griefer' });
    const window = { from: 1, to: game.log.at(-1)!.seq };
    const model = replayWithout(config, game.log, [{ filter: { player: 'griefer' }, window }]);
    await expectGrid(game.stub, model);
    // The restored cell has its layer back, with its own expiry.
    const snapshot = await game.stub.snapshot();
    expect(snapshot.shields[600 * SIZE + 600]).toBe(1);
    expect(snapshot.seq).toBe(game.log.at(-1)!.seq + 1);

    // The ledger: restored cells are the artist's again, the other player's brick is gone.
    const standings = await game.stub.teamStandings();
    expect(standings.get(1)?.cells).toBe(16);
    expect(standings.get(3)?.cells ?? 0).toBe(0);
    // Totals are history: the griefer's clears and the other's build still count.
    expect(standings.get(2)).toMatchObject({ cleared: 2 });
    expect(standings.get(3)).toMatchObject({ built: 4 });
    expect(await game.stub.lastWriter(600, 600)).toEqual(['artist', 1]);
    expect(await game.stub.lastWriter(599, 599)).toBeNull();

    // The seal will leave the griefer's ops out too.
    const status = await game.stub.seasonStatus();
    expect(status.rollbacks).toEqual([
      {
        seq: snapshot.seq,
        from: 1,
        to: window.to,
        player: 'griefer',
        cells: 7,
        appliedAt: expect.any(Number),
      },
    ]);
    expect(status.removals).toEqual([]);

    // A restart replays the restore row (log or checkpoint) to the same map and ledger.
    await evictDurableObject(game.stub);
    await expectGrid(game.stub, model);
    expect((await game.stub.teamStandings()).get(1)?.cells).toBe(16);
    expect(await game.stub.lastWriter(601, 600)).toEqual(['artist', 1]);
    // Play goes on from the restored map: the hole is filled again, so this is refused.
    expect((await game.act('other', 3, o(599, 599, 9), 7_000)).ok).toBe(false);
  }, 30_000);

  it('rolls back an area and a time range read from R2 after checkpoints and trimming', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const game = await Game.open('rollback-history');
    const config = await configOf(game.stub);
    const players = ['a', 'b', 'c'];
    let at = 10_000;
    let n = 0;
    /** Cells bricks were placed at: hammers and shields aim at them, so most ops land. */
    const placed: [number, number][] = [];
    const play = async (count: number) => {
      for (let k = 0; k < count; k++, n++) {
        at += 1_000;
        let op: Op;
        if (n % 4 === 3 && placed.length > 0) {
          const [x, y] = placed[(n * 5) % placed.length]!;
          op = hammer(x + (n % 2), y);
        } else if (n % 7 === 5 && placed.length > 0) {
          const [x, y] = placed[(n * 3) % placed.length]!;
          op = shield(x, y + 1);
        } else {
          const x = 500 + 2 * ((n * 7) % 30);
          const y = 500 + 2 * ((n * 3) % 20);
          placed.push([x, y]);
          op = o(x, y, n % 32);
        }
        await game.act(players[n % 3]!, (n % 3) + 1, op, at);
      }
    };
    await play(40);
    const t1 = at;
    const seqAtT1 = game.log.at(-1)!.seq;
    await play(40);
    // Checkpoint, ship and trim: the log so far leaves SQLite.
    await game.tick(T);
    await play(30);
    const t2 = at;
    await play(20);
    await game.tick(T + 200_000);
    const trimmed = await runInDurableObject(game.stub, (_, state) =>
      state.storage.sql.exec<{ m: number | null }>('SELECT MIN(seq) AS m FROM op_log').one(),
    );
    expect(trimmed.m === null || trimmed.m > seqAtT1).toBe(true);
    expect(game.log.length).toBeGreaterThan(60);

    // Everything in an area from t1 to t2, whoever did it: starts before the checkpoint, so
    // the job replays from seq 0 through the R2 segments.
    const area = { x: 505, y: 500, w: 10, h: 12 };
    const filter = { area, from: t1 + 1, to: t2 };
    const preview = await game.rollback(filter);
    const window = {
      from: game.log.find((p) => p.at >= t1 + 1)!.seq,
      to: [...game.log].reverse().find((p) => p.at <= t2)!.seq,
    };
    expect(preview.window).toEqual(window);
    // Replayed from the start of the season: the window starts before the checkpoint.
    expect(preview.base).toBe(0);
    const rollbacks: { filter: RollbackFilter; window: { from: number; to: number } }[] = [
      { filter, window },
    ];
    expect(preview.removedOps).toBe(game.log.filter((p) => matches(filter, window, p)).length);
    expect(preview.cells).toBeGreaterThan(0);
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));

    // Restarts before and after the restore row is checkpointed and trimmed.
    await evictDurableObject(game.stub);
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
    await play(10);
    await game.tick(T + 400_000);
    await evictDurableObject(game.stub);
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));

    // A second rollback, by player, over the whole season: the first one's ops stay out.
    const second = { player: 'b' };
    const preview2 = await game.rollback(second);
    const window2 = { from: game.log[0]!.seq, to: game.log.at(-1)!.seq };
    expect(preview2.window).toEqual(window2);
    rollbacks.push({ filter: second, window: window2 });
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
    await evictDurableObject(game.stub);
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));

    // One after the checkpoint starts from it (window after its clock).
    await game.tick(T + 600_000);
    const checkpointed = (await game.stub.status()).seq;
    await play(12);
    const third = { player: 'c', from: at - 5_000 };
    const preview3 = await game.rollback(third);
    const window3 = {
      from: game.log.find((p) => p.at >= third.from)!.seq,
      to: game.log.at(-1)!.seq,
    };
    expect(preview3.window).toEqual(window3);
    expect(preview3.base).toBe(checkpointed);
    rollbacks.push({ filter: third, window: window3 });
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
    // The ledger keeps standing cells equal to a recount of its own writers.
    await runInDurableObject(game.stub, (instance: CanvasDO) => {
      const { grid, teams } = inside(instance) as unknown as {
        grid: State;
        teams: { cells: Uint32Array };
      };
      let mismatched = 0;
      for (let c = 0; c < grid.cells.length; c++) {
        if (isFilled(grid.cells[c]!) !== (teams.cells[c] !== 0)) mismatched++;
      }
      expect(mismatched).toBe(0);
    });
  }, 120_000);

  it('publishes the restored cells to the CDN', async () => {
    const game = await Game.open('rollback-cdn');
    await game.act('artist', 0, o(600, 600), 1_000);
    await game.act('griefer', 0, hammer(600, 600), 2_000);
    await game.tick(T);
    await game.rollback({ player: 'griefer', area: { x: 590, y: 590, w: 20, h: 20 } });
    await game.tick(T + 10_000);
    const prefix = `c/${game.name}`;
    const manifest = parseManifest(await (await TILES.get(cdnKeys.manifest(prefix)))!.text());
    expect(manifest.seq).toBe(3);
    const [from, to] = manifest.segments.at(-1)!;
    expect(to).toBe(3);
    const segment = decodeSegment(
      await gunzip(
        new Uint8Array(await (await TILES.get(cdnKeys.segment(prefix, from, to)))!.arrayBuffer()),
      ),
    );
    const snapshot = await game.stub.snapshot();
    const restored = segment.diffs.find((d) => d.index === 600 * SIZE + 600);
    expect(restored).toEqual({
      index: 600 * SIZE + 600,
      cell: snapshot.cells[600 * SIZE + 600],
      shield: 0,
    });
    expect(isFilled(restored!.cell)).toBe(true);
    // Once the tile's 45 s have passed it is republished with the cell back.
    await game.tick(T + 100_000);
    const again = parseManifest(await (await TILES.get(cdnKeys.manifest(prefix)))!.text());
    const tile = Math.floor(600 / 256) * (SIZE / 256) + Math.floor(600 / 256);
    expect(again.tiles[tile]).toBe(3);
    const t = decodeTile(
      await gunzip(
        new Uint8Array(await (await TILES.get(cdnKeys.tile(prefix, 2, 2, 3)))!.arrayBuffer()),
      ),
    );
    expect(t.cells[(600 % 256) * 256 + (600 % 256)]).toBe(snapshot.cells[600 * SIZE + 600]);
  });

  it('refuses a rollback over its cell or row-size limit, changing nothing', async () => {
    const game = await Game.open('rollback-limits');
    await game.act('artist', 0, o(600, 600), 1_000);
    await game.act('artist', 0, shield(600, 600), 1_100);
    await game.act('artist', 0, shield(600, 600), 1_200);
    await game.act('griefer', 0, hammer(600, 600), 2_000);
    await game.act('griefer', 0, hammer(600, 600), 2_100);
    await game.act('griefer', 0, hammer(600, 600), 2_200);
    const before = await game.stub.snapshot();
    const limit = (limits: { cells: number; bytes: number }) =>
      runInDurableObject(game.stub, (instance: CanvasDO) => {
        (instance as unknown as { rollbackLimits: typeof limits }).rollbackLimits = limits;
      });
    // The row with its two layers' times is about a hundred bytes: over a 60-byte cap.
    await limit({ cells: 100, bytes: 60 });
    const big = await game.preview({ player: 'griefer' });
    expect(big).toMatchObject({ cells: 1, shields: 1, tooLarge: true });
    expect(await game.stub.rollbackApply(big.job)).toEqual({ ok: false, reason: 'too_large' });
    // And over a cell limit: the scan stops one cell past it.
    await limit({ cells: 0, bytes: 1_000_000 });
    const many = await game.preview({ player: 'griefer' });
    expect(many).toMatchObject({ cells: 1, tooLarge: true });
    expect(await game.stub.rollbackApply(many.job)).toEqual({ ok: false, reason: 'too_large' });
    const after = await game.stub.snapshot();
    expect(after.seq).toBe(before.seq);
    expect(after.cells[600 * SIZE + 600]).toBe(before.cells[600 * SIZE + 600]);
    // With room, it goes through.
    await limit({ cells: 100, bytes: 1_000_000 });
    await game.rollback({ player: 'griefer' });
    expect((await game.stub.snapshot()).shields[600 * SIZE + 600]).toBe(2);
  });

  it('gives a cell refilled the same way back to its earlier writer (ledger only)', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const game = await Game.open('rollback-writers');
    // A hole at the open area's corner (256, 256): its two neighbours inside are filled, so no
    // brick can cover it and a single brick may fill it.
    await game.act('artist', 1, o(257, 256), 1_000);
    await game.act(
      'artist',
      1,
      { kind: 'brick', x: 256, y: 257, shape: 0, rotation: 1, color: 3 },
      1_100,
    );
    expect(
      (await game.act('artist', 1, { kind: 'single', x: 256, y: 256, color: 5 }, 1_200)).ok,
    ).toBe(true);
    expect((await game.act('griefer', 2, hammer(256, 256), 2_000)).ok).toBe(true);
    // Someone else fills it again with the same colour: the cell byte is the artist's again.
    expect(
      (await game.act('other', 3, { kind: 'single', x: 256, y: 256, color: 5 }, 3_000)).ok,
    ).toBe(true);
    expect(await game.stub.lastWriter(256, 256)).toEqual(['other', 3]);
    const preview = await game.rollback({ player: 'griefer' });
    expect(preview).toMatchObject({ cells: 1, writersOnly: 1, filled: 0, recolored: 0 });
    expect(await game.stub.lastWriter(256, 256)).toEqual(['artist', 1]);
    const standings = await game.stub.teamStandings();
    expect(standings.get(1)?.cells).toBe(9);
    expect(standings.get(3)?.cells ?? 0).toBe(0);
    await evictDurableObject(game.stub);
    expect(await game.stub.lastWriter(256, 256)).toEqual(['artist', 1]);
  });

  it('starts from the checkpoint only when no later rollback reaches back before it', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const game = await Game.open('rollback-bases');
    const config = await configOf(game.stub);
    const rollbacks: { filter: RollbackFilter; window: { from: number; to: number } }[] = [];
    let at = 10_000;
    const play = async (n: number, player: string, x0: number) => {
      for (let k = 0; k < n; k++) {
        at += 1_000;
        await game.act(
          player,
          1,
          k % 3 === 2 ? hammer(x0 + 2 * (k - 1), 500) : o(x0 + 2 * k, 500),
          at,
        );
      }
    };
    await play(9, 'a', 500);
    await play(9, 'b', 540);
    await game.tick(T);
    const checkpointed = (await game.stub.status()).seq;
    // After the checkpoint, from after its clock: starts from it.
    await play(6, 'a', 580);
    const late = { player: 'a', from: at - 3_500 };
    const first = await game.rollback(late);
    expect(first.base).toBe(checkpointed);
    rollbacks.push({ filter: late, window: first.window! });
    await play(6, 'b', 620);
    // Another from after the checkpoint: the first is logged after it but reaches back no
    // further, so this one starts from it too and leaves the first one's ops out.
    const second = { player: 'b', from: at - 3_500 };
    const two = await game.rollback(second);
    expect(two.base).toBe(checkpointed);
    rollbacks.push({ filter: second, window: two.window! });
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
    // A rollback over everything of 'b', logged after the checkpoint and reaching before it...
    const all = { player: 'b' };
    const three = await game.rollback(all);
    rollbacks.push({ filter: all, window: three.window! });
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
    // ...makes the next one start from seq 0, though its window is after the checkpoint.
    await play(3, 'a', 660);
    const fourth = { player: 'a', from: at - 1_500 };
    const four = await game.rollback(fourth);
    expect(four.base).toBe(0);
    rollbacks.push({ filter: fourth, window: four.window! });
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
    // Several full-map checkpoint decodes: seconds alone, more under a full parallel run.
  }, 60_000);

  it('starts from the newest checkpoint copy in R2 that the window starts after, when the checkpoint is newer', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const game = await Game.open('rollback-copy');
    const config = await configOf(game.stub);
    const rollbacks: { filter: RollbackFilter; window: { from: number; to: number } }[] = [];
    let at = 10_000;
    const play = async (n: number, player: string, team: number, x0: number, y: number) => {
      for (let k = 0; k < n; k++) {
        at += 1_000;
        const op = k % 3 === 2 ? hammer(x0 + 2 * (k - 1), y) : o(x0 + 2 * k, y);
        await game.act(player, team, op, at);
      }
    };
    await play(6, 'a', 1, 500, 500);
    await play(6, 'b', 2, 500, 540);
    // The first checkpoint is copied at once.
    await game.tick(T);
    const copied = (await game.stub.status()).seq;
    const copyClock = at;
    expect((await listCopies(OPLOG, `c/${game.name}`)).map((c) => c.seq)).toEqual([copied]);
    await play(6, 'a', 1, 540, 500);
    await play(6, 'b', 2, 540, 540);
    await play(6, 'c', 3, 540, 580);
    // A newer checkpoint, not copied within the hour; the log up to it leaves SQLite.
    await game.tick(T + 120_000);
    const checkpointed = (await game.stub.status()).seq;
    const first = await runInDurableObject(game.stub, (_, state) =>
      state.storage.sql.exec<{ m: number | null }>('SELECT MIN(seq) AS m FROM op_log').one(),
    );
    expect(first.m === null || first.m > checkpointed).toBe(true);
    expect((await listCopies(OPLOG, `c/${game.name}`)).map((c) => c.seq)).toEqual([copied]);
    await play(3, 'a', 1, 580, 500);
    // a breaks a cell of b's first brick, placed before the copy.
    at += 1_000;
    expect((await game.act('a', 1, hammer(500, 540), at)).ok).toBe(true);
    expect(await game.stub.lastWriter(500, 540)).toBeNull();

    // From after the copy's clock, before the checkpoint's: the copy, then R2, then SQLite.
    const late = { player: 'a', from: copyClock + 1 };
    const one = await game.rollback(late);
    expect(one.base).toBe(copied);
    expect(one.window!.from).toBe(copied + 1);
    expect(one.removedOps).toBeGreaterThan(0);
    rollbacks.push({ filter: late, window: one.window! });
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
    // The writers came with the copy: the restored cell goes back to b and b's team.
    expect(await game.stub.lastWriter(500, 540)).toEqual(['b', 2]);

    // A rollback logged after the copy that reaches back before it (all of b's ops) ...
    const all = { player: 'b' };
    const two = await game.rollback(all);
    expect(two.base).toBe(0);
    rollbacks.push({ filter: all, window: two.window! });
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
    // ... makes the copy no base for the next one, though its window starts after it.
    const third = { player: 'c', from: copyClock + 1 };
    const three = await game.rollback(third);
    expect(three.base).toBe(0);
    rollbacks.push({ filter: third, window: three.window! });
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
    await evictDurableObject(game.stub);
    await expectGrid(game.stub, replayWithout(config, game.log, rollbacks));
  }, 60_000);

  it('passes over a copy without its team part for an older one, not for seq 0', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const game = await Game.open('rollback-copy-no-team');
    const config = await configOf(game.stub);
    let at = 10_000;
    const play = async (n: number, player: string, x0: number, y: number) => {
      for (let k = 0; k < n; k++) {
        at += 1_000;
        await game.act(player, 1, o(x0 + 2 * k, y), at);
      }
    };
    await play(4, 'a', 500, 500);
    await game.tick(T);
    const older = (await game.stub.status()).seq;
    await play(4, 'b', 500, 540);
    await game.tick(T + COPY_MS);
    const newer = (await game.stub.status()).seq;
    const newerClock = at;
    // A newer checkpoint again, not copied: too new for the window below.
    await play(4, 'a', 540, 500);
    await game.tick(T + COPY_MS + 120_000);
    const copies = await listCopies(OPLOG, `c/${game.name}`);
    expect(copies.map((c) => c.seq)).toEqual([newer, older]);
    // The newer copy loses its team part (as a copy of a checkpoint without one would be).
    const object = await OPLOG.get(copies[0]!.key);
    const meta = { ...object!.customMetadata! };
    const grid = new Uint8Array(await object!.arrayBuffer()).subarray(0, Number(meta.gridBytes));
    delete meta.teamSha256;
    await OPLOG.put(copies[0]!.key, grid, { customMetadata: { ...meta, teamBytes: '0' } });
    await play(3, 'a', 580, 500);
    const filter = { player: 'a', from: newerClock + 1 };
    const preview = await game.rollback(filter);
    expect(preview.base).toBe(older);
    await expectGrid(
      game.stub,
      replayWithout(config, game.log, [{ filter, window: preview.window! }]),
    );
  }, 60_000);

  it('refuses malformed filters, a stale job, and rollbacks past the end; works while read-only', async () => {
    const game = await Game.open('rollback-refusals');
    await game.act('artist', 0, o(600, 600), 1_000);
    await game.act('griefer', 0, hammer(600, 600), 2_000);
    for (const filter of [
      {},
      { player: '' },
      { area: { x: 0, y: 0, w: 0, h: 1 } },
      { area: { x: 1016, y: 0, w: 16, h: 1 } },
      { from: 10, to: 5 },
      { from: -1 },
      // Only a time range ending somewhere: still needs a start, a player or an area.
      { to: 5 },
    ]) {
      expect(await game.stub.rollbackPreview(filter as RollbackFilter)).toEqual({
        state: 'failed',
        job: null,
        error: 'invalid',
      });
    }
    const first = await game.preview({ player: 'griefer' });
    // Another filter replaces the job: the first can no longer be applied.
    const other = await game.preview({ player: 'artist' });
    expect(await game.stub.rollbackApply(first.job)).toEqual({ ok: false, reason: 'no_job' });
    await game.stub.rollbackCancel();
    expect(await game.stub.rollbackApply(other.job)).toEqual({ ok: false, reason: 'no_job' });
    // Read-only stops players, not moderators.
    await game.stub.setSchedule({ readOnly: 'raid' });
    await game.rollback({ player: 'griefer' });
    await game.stub.setSchedule({ readOnly: null });
    // Past the end nothing more is logged.
    await game.stub.setSchedule({ endsAt: 3_000 });
    expect(await game.stub.rollbackPreview({ player: 'artist' }, 3_000)).toEqual({
      state: 'failed',
      job: null,
      error: 'ended',
    });
  });
});

/** The grid hash, seq and standings: what a refused rollback must leave as it was. */
async function stateOf(game: Game) {
  const snapshot = await game.stub.snapshot();
  const state = createState(await configOf(game.stub));
  state.cells.set(snapshot.cells);
  state.shields.set(snapshot.shields);
  return {
    seq: snapshot.seq,
    hash: gridHash(state),
    standings: [...(await game.stub.teamStandings())],
  };
}

describe('rollback guards', () => {
  it('fails, changing nothing, when the log no longer rebuilds the live map', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    for (const tamper of ['record', 'row'] as const) {
      const game = await Game.open(`rollback-tampered-${tamper}`);
      await game.act('artist', 1, o(600, 600), 1_000);
      await game.act('griefer', 2, hammer(600, 600), 2_000);
      await game.act('artist', 1, o(700, 600), 3_000);
      await game.rollback({ player: 'griefer' });
      await runInDurableObject(game.stub, (_, state) => {
        const sql = state.storage.sql;
        // Lose the record of the rollback: the baseline replay brings the griefer's hammer
        // back, which the live map does not show. Or change a logged op behind its back.
        if (tamper === 'record') sql.exec("DELETE FROM meta WHERE key = 'rollbacks'");
        else
          sql.exec(
            'UPDATE op_log SET ops = replace(ops, \'"color":3\', \'"color":4\') WHERE seq = 3',
          );
      });
      const before = await stateOf(game);
      const status = await game.stub.rollbackPreview({ player: 'artist' });
      expect(status).toMatchObject({ state: 'failed', error: /does not rebuild the live map/ });
      const job = status.state === 'failed' ? status.job! : '';
      expect(await game.stub.rollbackApply(job)).toEqual({ ok: false, reason: 'not_ready' });
      expect(await stateOf(game)).toEqual(before);
    }
  });

  it('counts the ops of a damaged `who` as unattributed, and logs the row by seq only', async () => {
    await MODERATION.put(TEAM_CAP_KEY, '1000');
    const game = await Game.open('rollback-who-unreadable');
    await game.act('artist', 1, o(600, 600), 1_000);
    await game.act('griefer', 2, hammer(600, 600), 2_000);
    await game.act('griefer', 2, o(700, 600), 3_000);
    // The griefer's first row loses its `who`: cut short mid-id.
    await runInDurableObject(game.stub, (_, state) => {
      state.storage.sql.exec(`UPDATE op_log SET who = '[["grief' WHERE seq = 2`);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const preview = await game.preview({ player: 'griefer' });
      // Only the brick names the griefer; the hammer names nobody and stays.
      expect(preview).toMatchObject({ removedOps: 1, unattributedOps: 1 });
      const events = () =>
        errors.mock.calls
          .map(([line]) => line as { event?: string })
          .filter((line) => line?.event === 'who_unreadable');
      expect(events()).toEqual([
        { event: 'who_unreadable', canvas: 'rollback-who-unreadable', seq: 2, suppressed: 0 },
      ]);
      // No id, nor any part of the value, in any line logged.
      expect(JSON.stringify(errors.mock.calls)).not.toContain('grief');
      // A start replays the row too, and says so.
      errors.mockClear();
      await evictDurableObject(game.stub);
      expect((await game.stub.status()).seq).toBe(3);
      expect(events()).toEqual([
        { event: 'who_unreadable', canvas: 'rollback-who-unreadable', seq: 2, suppressed: 0 },
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it("moves a replay's clock for a left-out op, as the live map did when it took it", async () => {
    const game = await Game.open('rollback-time');
    await game.act('artist', 0, o(600, 600), 1_000);
    // The griefer's brick is the latest op (5 s); the shield after it is logged at 4 s, so the
    // live map placed its layer at 5 s. Without the griefer's time, a replay would place it at
    // 4 s and list the cell for a different expiry.
    await game.act('griefer', 0, o(700, 700), 5_000);
    expect((await game.act('artist', 0, shield(600, 600), 4_000)).ok).toBe(true);
    const preview = await game.rollback({ player: 'griefer' });
    expect(preview).toMatchObject({ cells: 4, emptied: 4, shields: 0 });
  });

  it('holds trimming while a job exists or starts, and drops an idle job at its deadline', async () => {
    const game = await Game.open('rollback-trim');
    for (let k = 0; k < 4; k++) await game.act('p', 0, o(600 + 2 * k, 600), 1_000 + k);
    const minSeq = () =>
      runInDurableObject(
        game.stub,
        (_, state) =>
          state.storage.sql.exec<{ m: number | null }>('SELECT MIN(seq) AS m FROM op_log').one().m,
      );
    const preview = await game.stub.rollbackPreview({ player: 'p' }, T);
    expect(preview.state).toBe('ready');
    // Checkpointed and shipped, but kept while the job may read it.
    await game.tick(T);
    expect(await minSeq()).toBe(1);
    // An idle job goes at its deadline, and the alarm is set for it.
    const alarm = await pendingAlarm(game.stub);
    expect(alarm).not.toBeNull();
    await game.tick(T + JOB_IDLE_MS - 20_000);
    expect(await minSeq()).toBe(1);
    await game.tick(T + JOB_IDLE_MS);
    expect(await minSeq()).toBeNull();
    const job = preview.state === 'ready' ? preview.preview.job : '';
    expect(await game.stub.rollbackApply(job)).toEqual({ ok: false, reason: 'no_job' });
    // A job being started holds it too.
    for (let k = 0; k < 2; k++) await game.act('p', 0, o(640 + 2 * k, 600), 2_000 + k);
    await runInDurableObject(game.stub, (instance: CanvasDO) => {
      (instance as unknown as { rollbackStarting: number }).rollbackStarting = 1;
    });
    await game.tick(T + JOB_IDLE_MS + 120_000);
    expect(await minSeq()).not.toBeNull();
    await runInDurableObject(game.stub, (instance: CanvasDO) => {
      (instance as unknown as { rollbackStarting: number }).rollbackStarting = 0;
    });
    await game.tick(T + JOB_IDLE_MS + 240_000);
    expect(await minSeq()).toBeNull();
  }, 30_000);

  it("sets an alarm at an idle job's deadline when nothing else is due", async () => {
    const game = await Game.open('rollback-idle-alarm');
    // No log bucket: nothing waits to be shipped or trimmed, so only the job keeps an alarm.
    await runInDurableObject(game.stub, (instance: CanvasDO) => {
      const inner = instance as unknown as { env: Env };
      inner.env = { ...inner.env, OPLOG: undefined } as unknown as Env;
    });
    await game.act('p', 0, o(600, 600), 1_000);
    await game.tick(T);
    expect((await game.stub.rollbackPreview({ player: 'p' }, T + 20_000)).state).toBe('ready');
    await game.tick(T + 30_000);
    // Let the alarms the ops and the ticks asked for run out; the next one is the deadline.
    for (let i = 0; i < 5; i++) await runDurableObjectAlarm(game.stub);
    const alarm = await pendingAlarm(game.stub);
    expect(alarm).not.toBeNull();
    // Ticks run on the clock the preview's time is on (T here), alarms on the wall clock.
    const deadline = T + 20_000 + JOB_IDLE_MS;
    expect(Math.abs(alarm! - deadline)).toBeLessThan(5_000);
  });

  it('keeps at most MAX_ROLLBACKS records, refusing on preview and on apply', async () => {
    const game = await Game.open('rollback-full');
    await game.act('p', 0, o(600, 600), 1_000);
    const records = (n: number) =>
      runInDurableObject(game.stub, (_, state) => {
        // Records whose windows match no op here: only their number matters.
        const record = { seq: 1, from: 1, to: 1, area: { x: 0, y: 0, w: 1, h: 1 }, cells: 0 };
        state.storage.sql.exec(
          "INSERT INTO meta (key, value) VALUES ('rollbacks', ?) " +
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
          JSON.stringify(Array.from({ length: n }, () => ({ ...record, appliedAt: 0 }))),
        );
      });
    // One short of the cap: a preview starts; then the cap is reached before it is applied.
    await records(MAX_ROLLBACKS - 1);
    const preview = await game.preview({ player: 'p' });
    await records(MAX_ROLLBACKS);
    expect(await game.stub.rollbackApply(preview.job)).toEqual({ ok: false, reason: 'full' });
    await game.stub.rollbackCancel();
    expect(await game.stub.rollbackPreview({ player: 'p' })).toEqual({
      state: 'failed',
      job: null,
      error: 'full',
    });
    expect((await game.stub.snapshot()).seq).toBe(1);
  });

  it('budgets three states and two writer ids a cell, and each live shield layer per state', () => {
    // At 2048², the next size a later season may grow to (ADR 0027), where ADR 0024's numbers
    // were worked out.
    const big = 2048;
    const state = createState({ size: big, open: { x: 0, y: 0, w: big, h: big }, maxShield: 5 });
    const area = big * big;
    // Cells, shields and cover for the live map, the baseline and the target (3 bytes each),
    // plus the live ledger's and the job's writer per cell (4 bytes each): 68 MiB at 2048².
    expect(rollbackMemory(state)).toBe(3 * 3 * area + 8 * area);
    expect(rollbackMemory(state)).toBe(68 * 2 ** 20);
    // Each live layer costs about 100 bytes in each of the three states, wherever it is.
    state.shieldExpiry.set(0, [1, 2, 3]);
    state.shieldExpiry.set(area - 1, [4]);
    expect(rollbackMemory(state)).toBe(68 * 2 ** 20 + 4 * 300);
    // The room left at 2048²: about 110,000 layers (ADR 0024), the last one in and one over.
    const room = Math.floor((MAX_ROLLBACK_MEMORY - 68 * 2 ** 20) / 300);
    expect(room).toBeGreaterThan(110_000);
    expect(room).toBeLessThan(112_000);
    state.shieldExpiry.clear();
    for (let i = 0; i < room; i++) state.shieldExpiry.set(i, [i]);
    expect(rollbackMemory(state)).toBeLessThanOrEqual(MAX_ROLLBACK_MEMORY);
    state.shieldExpiry.set(room, [room]);
    expect(rollbackMemory(state)).toBeGreaterThan(MAX_ROLLBACK_MEMORY);
    // A smaller map leaves room in proportion: 64² takes 17 bytes a cell.
    const small = createState({ size: 64, open: { x: 0, y: 0, w: 64, h: 64 }, maxShield: 5 });
    expect(rollbackMemory(small)).toBe(17 * 64 * 64);
  });

  it("refuses a job over the memory budget, and a moderator's that would replace an owner's", async () => {
    const game = await Game.open('rollback-budget');
    await game.act('p', 0, o(600, 600), 1_000);
    await game.act('q', 0, o(700, 600), 1_000);
    await runInDurableObject(game.stub, (instance: CanvasDO) => {
      const limits = (instance as unknown as { rollbackLimits: Record<string, number> })
        .rollbackLimits;
      (instance as unknown as { rollbackLimits: unknown }).rollbackLimits = {
        ...limits,
        memory: 1_000,
      };
    });
    expect(await game.stub.rollbackPreview({ player: 'p' })).toEqual({
      state: 'failed',
      job: null,
      error: 'too_large',
    });
    await runInDurableObject(game.stub, (instance: CanvasDO) => {
      (instance as unknown as { rollbackLimits: unknown }).rollbackLimits = ROLLBACK_LIMITS;
    });
    const owners = await game.stub.rollbackPreview({ player: 'p' }, Date.now(), 'owner');
    expect(owners.state).toBe('ready');
    expect(await game.stub.rollbackPreview({ player: 'q' }, Date.now(), 'moderator')).toEqual({
      state: 'failed',
      job: null,
      error: 'busy',
    });
    // The owner's own filter is still the owner's job, for anyone to look at.
    const same = await game.stub.rollbackPreview({ player: 'p' }, Date.now(), 'moderator');
    expect(same.state === 'ready' && owners.state === 'ready' && same.preview.job).toBe(
      owners.state === 'ready' ? owners.preview.job : null,
    );
    // An owner may replace any job; a moderator may replace a moderator's.
    expect((await game.stub.rollbackPreview({ player: 'q' }, Date.now(), 'moderator')).state).toBe(
      'failed',
    );
    await game.stub.rollbackCancel();
    await game.stub.rollbackPreview({ player: 'q' }, Date.now(), 'moderator');
    expect((await game.stub.rollbackPreview({ player: 'p' }, Date.now(), 'moderator')).state).toBe(
      'ready',
    );
  });
});

describe('area locks', () => {
  it('refuse ops that touch a lock, keep the item, and reach the rules and the manifest', async () => {
    const game = await Game.open('locks');
    const area = { x: 600, y: 600, w: 4, h: 4 };
    // Ends after the maintenance ticks below, which drop locks whose end has passed.
    const until = T + 10 * HOUR;
    const locked = await game.stub.lockArea({ area, until, note: 'raid' }, 1_000);
    expect(locked).toMatchObject({ ok: true, lock: { id: 1, area, until, note: 'raid' } });
    // A brick with one cell in the area is refused, its item kept.
    const refused = await game.act('p1', 0, o(599, 599), 2_000);
    expect(refused).toEqual({ ok: false, reason: 'locked' });
    const hold = await game.stub.holds(['p1'], 2_000);
    expect(hold.get('p1')!.items).toEqual([{ kind: 'brick', shape: 1 }]);
    expect((await game.act('p1', 0, o(604, 600), 2_100)).ok).toBe(true);
    // The rules carry the lock and a revision.
    const { rules } = await game.stub.status();
    expect(rules.locks).toEqual([area]);
    expect(rules.locksRev).toBe(1);
    // Spectators see it in the manifest.
    await game.tick(T);
    const manifest = parseManifest(
      await (await TILES.get(cdnKeys.manifest(`c/${game.name}`)))!.text(),
    );
    expect(manifest.locks).toEqual([area]);
    // A restart keeps it; at its end (logical time) ops pass again.
    await evictDurableObject(game.stub);
    expect(await game.act('p1', 0, o(600, 600), until - 1)).toEqual({
      ok: false,
      reason: 'locked',
    });
    expect((await game.act('p1', 0, o(600, 600), until)).ok).toBe(true);

    // Unlock, and the limits.
    const second = await game.stub.lockArea({ area: { x: 0, y: 0, w: 1, h: 1 } }, 60_000);
    expect(second.ok && second.lock.id).toBe(2);
    expect(await game.stub.unlockArea(2)).toMatchObject({ ok: true });
    expect(await game.stub.unlockArea(2)).toEqual({ ok: false, reason: 'not_found' });
    for (const bad of [
      { area: { x: 0, y: 0, w: 0, h: 1 } },
      { area: { x: 2047, y: 0, w: 2, h: 1 } },
      { area: { x: 0, y: 0, w: 1, h: 1 }, until: 60_000 },
      { area: null },
    ]) {
      expect(await game.stub.lockArea(bad as never, 60_000)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    for (let i = 0; i < MAX_LOCKS; i++) {
      await game.stub.lockArea({ area: { x: i, y: 0, w: 1, h: 1 } }, 60_000);
    }
    expect(await game.stub.lockArea({ area: { x: 100, y: 0, w: 1, h: 1 } }, 60_000)).toEqual({
      ok: false,
      reason: 'full',
    });
  });
});
