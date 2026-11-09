// A seeded cross-check of the team ledger (ADR 0020) against an independent model: random
// placements, hammers and shields by players who switch teams, under a daily cap, across UTC
// days, shield expiry, checkpoints, log shipping and trimming, and restarts.
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  applyEntry,
  type CoreConfig,
  cellsOf,
  createState,
  type Item,
  isFilled,
  type Op,
  passTime,
  type Rotation,
  type ShapeId,
} from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import type { CanvasDO, Env, TeamStats } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';
import { DAY_MS, TEAM_CAP_KEY, type TeamLedger } from '../src/teams.ts';

const { CANVAS, MODERATION } = env as unknown as Required<Env>;
type Stub = ReturnType<typeof CANVAS.get>;
const NEVER = 2 ** 50;
const SIZE = 1024;
/** A small square, so ops keep meeting each other's cells. */
const X0 = 600;
const Y0 = 600;
const W = 14;
const CAP = 13;
const TEAMS = [1, 2, 3];

/** What the ledger keeps inside; the cross-check recounts it. */
type Internals = {
  env: Env;
  grid: { cells: Uint8Array };
  teams: Pick<TeamLedger, 'refreshCap'> & {
    cells: Uint32Array;
    teams: Int32Array;
    stats: Map<number, TeamStats>;
  };
};
const inside = (instance: CanvasDO) => instance as unknown as Internals;

let nextOpId = 1;

function itemOf(op: Op): Item {
  return op.kind === 'brick' ? { kind: 'brick', shape: op.shape } : ({ kind: op.kind } as Item);
}

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
  const reply = await stub.applyBatch([{ player, opId: nextOpId++, op, team }], at);
  return reply.results[0]!;
}

/** A small seeded generator (LCG), so a failure replays. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

for (const seed of [1, 2, 3]) {
  describe(`team ledger cross-check, seed ${seed}`, () => {
    it('keeps counters equal to an independent model and to a recount of the cells', async () => {
      await MODERATION.put(TEAM_CAP_KEY, String(CAP));
      const r = random(seed);
      const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
      const stub = CANVAS.get(CANVAS.idFromName(`teams-crosscheck-${seed}`));
      const players = ['p1', 'p2', 'p3', 'p4', 'p5'];
      // Team 0 is no team.
      const teamOf = new Map(players.map((p) => [p, Math.floor(r() * 4)]));
      /** The model: who each live cell counts for, totals per team, credit per player. */
      const owner = new Map<number, number>();
      const totals = new Map<number, { built: number; cleared: number; shields: number }>();
      const total = (team: number) => {
        let t = totals.get(team);
        if (!t) {
          t = { built: 0, cleared: 0, shields: 0 };
          totals.set(team, t);
        }
        return t;
      };
      const credit = new Map<string, { day: number; cells: number }>();
      let at = 5 * DAY_MS;
      let now = 100_000_000;
      let accepted = 0;
      for (let n = 0; n < 400; n++) {
        // About three ops an hour of op time: days turn and shield layers expire.
        at += Math.floor((r() * DAY_MS) / 8);
        const player = pick(players);
        if (r() < 0.05) teamOf.set(player, Math.floor(r() * 4));
        const team = teamOf.get(player)!;
        const x = X0 + Math.floor(r() * W);
        const y = Y0 + Math.floor(r() * W);
        const k = r();
        const op: Op =
          k < 0.45
            ? {
                kind: 'brick',
                x,
                y,
                shape: Math.floor(r() * 7) as ShapeId,
                rotation: Math.floor(r() * 4) as Rotation,
                color: 3,
              }
            : k < 0.55
              ? { kind: 'single', x, y, color: 4 }
              : k < 0.85
                ? { kind: 'hammer', x, y }
                : { kind: 'shield', x, y };
        const result = await act(stub, player, team, op, at);
        if (!result.ok || 'duplicate' in result) continue;
        accepted++;
        if (op.kind === 'brick' || op.kind === 'single') {
          const cells =
            op.kind === 'brick'
              ? cellsOf(op.shape, op.rotation).map(([dx, dy]) => (op.y + dy) * SIZE + op.x + dx)
              : [y * SIZE + x];
          let counted = 0;
          if (team !== 0) {
            const day = Math.floor(at / DAY_MS);
            const c = credit.get(player) ?? { day, cells: 0 };
            if (day > c.day) {
              c.day = day;
              c.cells = 0;
            }
            if (c.cells + cells.length <= CAP) {
              c.cells += cells.length;
              counted = team;
            }
            credit.set(player, c);
          }
          for (const i of cells) owner.set(i, counted);
          if (counted) total(counted).built += cells.length;
        } else if (op.kind === 'shield') {
          if (team) total(team).shields++;
        } else {
          const i = y * SIZE + x;
          let last: number | undefined;
          for (const d of result.diffs) if (d.index === i) last = d.cell;
          if (last !== undefined && !isFilled(last)) {
            owner.delete(i);
            if (team) total(team).cleared++;
          }
        }
        if (r() < 0.05) {
          now += 200_000;
          await runInDurableObject(stub, (instance: CanvasDO) => instance.tick(now));
        }
        if (r() < 0.03) await evictDurableObject(stub);
      }
      expect(accepted).toBeGreaterThan(50);

      const check = async () => {
        const standings = await stub.teamStandings();
        const cells = new Map<number, number>();
        for (const t of owner.values()) if (t) cells.set(t, (cells.get(t) ?? 0) + 1);
        for (const t of TEAMS) {
          const got = standings.get(t) ?? { cells: 0, built: 0, cleared: 0, shields: 0 };
          const want = totals.get(t) ?? { built: 0, cleared: 0, shields: 0 };
          expect({ team: t, ...got }).toEqual({ team: t, cells: cells.get(t) ?? 0, ...want });
        }
        await runInDurableObject(stub, (instance: CanvasDO) => {
          const { grid, teams } = inside(instance);
          const recount = new Map<number, number>();
          let mismatched = 0;
          for (let c = 0; c < grid.cells.length; c++) {
            const writer = teams.cells[c]!;
            // A filled cell has a writer here (all were placed after teams existed), an empty
            // one has none.
            if (isFilled(grid.cells[c]!) !== (writer !== 0)) mismatched++;
            const t = teams.teams[writer]!;
            if (t) recount.set(t, (recount.get(t) ?? 0) + 1);
          }
          expect(mismatched).toBe(0);
          for (const [t, s] of teams.stats) expect(s.cells).toBe(recount.get(t) ?? 0);
        });
      };
      await check();
      now += 200_000;
      await runInDurableObject(stub, (instance: CanvasDO) => instance.tick(now));
      await evictDurableObject(stub);
      await check();
    }, 120_000);
  });
}

/** One accepted op as the model keeps it: enough to replay it without the canvas. */
interface Accepted {
  readonly seq: number;
  readonly at: number;
  readonly op: Op;
  readonly player: string;
  /** The team it counted for (0: none), as the canvas logged it. */
  readonly counted: number;
}

/**
 * Rollbacks (ADR 0024) against the same kind of model: after each one, the owner of every cell
 * is what an independent replay with the core gives when it leaves out the rolled-back ops
 * (time still passing), and the season totals do not move.
 */
for (const seed of [11, 12]) {
  describe(`team ledger cross-check with rollbacks, seed ${seed}`, () => {
    it('gives restored cells back to their writers and keeps counters equal to a recount', async () => {
      await MODERATION.put(TEAM_CAP_KEY, String(CAP));
      const r = random(seed);
      const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
      const name = `teams-crosscheck-rollback-${seed}`;
      const stub = CANVAS.get(CANVAS.idFromName(name));
      const config = await runInDurableObject(stub, (_, state) => {
        const row = state.storage.sql
          .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'config'")
          .one();
        return JSON.parse(row.value) as CoreConfig;
      });
      const players = ['p1', 'p2', 'p3', 'p4'];
      const teamOf = new Map(players.map((p, i) => [p, (i % 3) + 1]));
      const log: Accepted[] = [];
      const rollbacks: { player: string; from: number; to: number }[] = [];
      const totals = new Map<number, { built: number; cleared: number; shields: number }>();
      const total = (team: number) => {
        let t = totals.get(team);
        if (!t) {
          t = { built: 0, cleared: 0, shields: 0 };
          totals.set(team, t);
        }
        return t;
      };
      /** Who each cell counts for, from a core replay of the log without the rollbacks. */
      const owners = () => {
        const state = createState(config);
        const owner = new Map<number, number>();
        for (const a of log) {
          passTime(state, a.at);
          if (rollbacks.some((b) => a.player === b.player && a.seq >= b.from && a.seq <= b.to)) {
            continue;
          }
          const result = applyEntry(state, a.op, a.at);
          if (!result.ok) continue;
          if (a.op.kind === 'brick' || a.op.kind === 'single') {
            const { op } = a;
            const cells =
              op.kind === 'brick'
                ? cellsOf(op.shape, op.rotation).map(([dx, dy]) => (op.y + dy) * SIZE + op.x + dx)
                : [op.y * SIZE + op.x];
            for (const i of cells) owner.set(i, a.counted);
          } else if (a.op.kind === 'hammer') {
            const i = a.op.y * SIZE + a.op.x;
            let last: number | undefined;
            for (const d of result.diffs) if (d.index === i) last = d.cell;
            if (last !== undefined && !isFilled(last)) owner.delete(i);
          }
        }
        return owner;
      };
      const credit = new Map<string, { day: number; cells: number }>();
      let at = 5 * DAY_MS;
      let now = 100_000_000;
      let rolled = 0;
      for (let n = 0; n < 300; n++) {
        at += Math.floor((r() * DAY_MS) / 8);
        const player = pick(players);
        const team = teamOf.get(player)!;
        const x = X0 + Math.floor(r() * W);
        const y = Y0 + Math.floor(r() * W);
        const k = r();
        const op: Op =
          k < 0.45
            ? {
                kind: 'brick',
                x,
                y,
                shape: Math.floor(r() * 7) as ShapeId,
                rotation: Math.floor(r() * 4) as Rotation,
                color: 3,
              }
            : k < 0.55
              ? { kind: 'single', x, y, color: 4 }
              : k < 0.85
                ? { kind: 'hammer', x, y }
                : { kind: 'shield', x, y };
        const result = await act(stub, player, team, op, at);
        if (!result.ok || 'duplicate' in result) continue;
        const { seq } = await stub.status();
        let counted = 0;
        if (op.kind === 'brick' || op.kind === 'single') {
          const placed = op.kind === 'brick' ? 4 : 1;
          const day = Math.floor(at / DAY_MS);
          const c = credit.get(player) ?? { day, cells: 0 };
          if (day > c.day) {
            c.day = day;
            c.cells = 0;
          }
          if (c.cells + placed <= CAP) {
            c.cells += placed;
            counted = team;
          }
          credit.set(player, c);
          if (counted) total(counted).built += placed;
        } else if (op.kind === 'shield') {
          counted = team;
          total(team).shields++;
        } else {
          counted = team;
          const i = y * SIZE + x;
          let last: number | undefined;
          for (const d of result.diffs) if (d.index === i) last = d.cell;
          if (last !== undefined && !isFilled(last)) total(team).cleared++;
        }
        log.push({ seq, at, op, player, counted });
        if (r() < 0.08 && log.length > 10) {
          // Roll back one player's ops over the log so far.
          const target = pick(players);
          let status = await stub.rollbackPreview({ player: target });
          for (let i = 0; status.state === 'running' && i < 100; i++) {
            status = await stub.rollbackPreview({ player: target });
          }
          expect(status.state, JSON.stringify(status)).toBe('ready');
          if (status.state !== 'ready') return;
          const applied = await stub.rollbackApply(status.preview.job);
          expect(applied.ok).toBe(true);
          if (applied.ok && status.preview.window) {
            rollbacks.push({ player: target, ...status.preview.window });
            rolled += status.preview.cells > 0 ? 1 : 0;
          }
        }
        if (r() < 0.05) {
          now += 200_000;
          await runInDurableObject(stub, (instance: CanvasDO) => instance.tick(now));
        }
        if (r() < 0.03) await evictDurableObject(stub);
      }
      expect(rolled).toBeGreaterThan(2);

      const check = async () => {
        const standings = await stub.teamStandings();
        const cells = new Map<number, number>();
        for (const t of owners().values()) if (t) cells.set(t, (cells.get(t) ?? 0) + 1);
        for (const t of TEAMS) {
          const got = standings.get(t) ?? { cells: 0, built: 0, cleared: 0, shields: 0 };
          const want = totals.get(t) ?? { built: 0, cleared: 0, shields: 0 };
          expect({ team: t, ...got }).toEqual({ team: t, cells: cells.get(t) ?? 0, ...want });
        }
        await runInDurableObject(stub, (instance: CanvasDO) => {
          const { grid, teams } = inside(instance);
          const recount = new Map<number, number>();
          let mismatched = 0;
          for (let c = 0; c < grid.cells.length; c++) {
            const writer = teams.cells[c]!;
            if (isFilled(grid.cells[c]!) !== (writer !== 0)) mismatched++;
            const t = teams.teams[writer]!;
            if (t) recount.set(t, (recount.get(t) ?? 0) + 1);
          }
          expect(mismatched).toBe(0);
          for (const [t, s] of teams.stats) expect(s.cells).toBe(recount.get(t) ?? 0);
        });
      };
      await check();
      now += 200_000;
      await runInDurableObject(stub, (instance: CanvasDO) => instance.tick(now));
      await evictDurableObject(stub);
      await check();
    }, 180_000);
  });
}
