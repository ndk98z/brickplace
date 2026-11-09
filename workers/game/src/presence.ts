// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.
//
// Who is playing on a canvas right now (ADR 0030), as counts only. Every FanoutDO shard that
// follows the canvas reports, with its tick watchdog's cursor() call, how many of its sockets
// play and how many of those play for each team; the canvas sums the reports that are still
// fresh. Advisory and kept in memory: a restarted canvas counts again within one watchdog
// interval, and a shard that stops reporting (no sockets left, evicted) drops out once its
// report is stale. No player id ever reaches this module.

import type { Phase, Rates } from '@brickplace/core';

/** What GET /api/stats shows about a canvas (CanvasDO.stats()). */
export interface CanvasStats {
  /** Players with a socket open, over every shard's last fresh report. */
  readonly playing: number;
  /** The phase draws use now (ADR 0010). */
  readonly phase: Phase;
  /**
   * Percent (0-100, rounded down) of the open area no brick can reach (filled cells and holes
   * no brick fits): what sets the phase. Not what the open area grows at: that is `built`.
   */
  readonly filled: number;
  /** Percent (0-100, rounded down) of the open area with a brick in it (ADR 0033). */
  readonly built: number;
  /** The `built` percent at which the open area grows; null once it is the whole map. */
  readonly growsAt: number | null;
  /** Drop weights per phase, in ITEM_KINDS order (brick, single, hammer, shield). */
  readonly rates: Readonly<Record<Phase, Rates>>;
}

/** A report older than this (ms) no longer counts: two and a half watchdog intervals. */
export const PRESENCE_TTL_MS = 75_000;
/** Most teams one report may name; a shard holds far fewer sockets than this. */
export const MAX_REPORT_TEAMS = 10_000;
/** Most players one report may count. */
export const MAX_REPORT_PLAYERS = 1_000_000;

/** One shard's sockets as it reported them: players, and players per team id. */
export interface PresenceReport {
  readonly players: number;
  readonly teams: readonly (readonly [team: number, players: number])[];
}

/** The canvas-wide totals a shard gets back: everyone playing, and its own teams' totals. */
export interface PresenceTotals {
  readonly playing: number;
  readonly teams: readonly (readonly [team: number, players: number])[];
}

const count = (n: unknown, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;

/**
 * A report as it came over RPC, or null when it is not one: counts must be whole and
 * bounded, team ids positive integers named once, no team counting more than the players.
 */
export function readReport(value: unknown): PresenceReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const { players, teams } = value as { players?: unknown; teams?: unknown };
  if (!count(players, MAX_REPORT_PLAYERS)) return null;
  if (!Array.isArray(teams) || teams.length > MAX_REPORT_TEAMS) return null;
  const seen = new Set<number>();
  const out: (readonly [number, number])[] = [];
  for (const entry of teams) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [team, n] = entry as [unknown, unknown];
    if (!count(team, 0xffffffff) || team === 0 || seen.has(team)) return null;
    if (!count(n, players)) return null;
    seen.add(team);
    out.push([team, n]);
  }
  return { players, teams: out };
}

export class Presence {
  private readonly reports = new Map<
    string,
    { readonly at: number; readonly players: number; readonly teams: Map<number, number> }
  >();

  /** Takes `shard`'s report at `now`, in place of its last one. */
  report(shard: string, report: PresenceReport, now: number): void {
    this.reports.set(shard, { at: now, players: report.players, teams: new Map(report.teams) });
  }

  /** Everyone playing at `now`, from the fresh reports; stale ones are dropped. */
  playing(now: number): number {
    let total = 0;
    for (const [shard, report] of this.reports) {
      if (now - report.at >= PRESENCE_TTL_MS) this.reports.delete(shard);
      else total += report.players;
    }
    return total;
  }

  /**
   * When the next report that counts players goes stale (ms), or null when none does: the
   * playing count drops then, with no call to say so (ADR 0033).
   */
  staleAt(): number | null {
    let at: number | null = null;
    for (const report of this.reports.values()) {
      if (report.players === 0) continue;
      at = Math.min(at ?? Number.POSITIVE_INFINITY, report.at + PRESENCE_TTL_MS);
    }
    return at;
  }

  /** The totals for a shard: everyone playing, and the teams it named, over fresh reports. */
  totals(teams: readonly number[], now: number): PresenceTotals {
    const playing = this.playing(now);
    const sums = new Map<number, number>(teams.map((team) => [team, 0]));
    for (const report of this.reports.values()) {
      for (const team of teams) {
        const n = report.teams.get(team);
        if (n) sums.set(team, sums.get(team)! + n);
      }
    }
    return { playing, teams: [...sums] };
  }
}
