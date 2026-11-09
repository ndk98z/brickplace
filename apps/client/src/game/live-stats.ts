import { ITEM_KINDS, type ItemKind, PHASES, type Phase, type Rates } from '@brickplace/core';
import { Observable } from '../ui/observable.ts';

// What the game screen shows about the canvas as a whole (ADR 0030): players with a socket
// open, the phase and how full the open area is, and the drop rates of each phase. A page
// watching through the CDN reads them from the manifest it polls anyway (ADR 0033); any other
// page polls GET /api/stats (edge-cached 15 s). A playing socket also gets Stats frames, which
// add its team's count and keep the playing count fresher. Counts only, never ids.

export interface CanvasStats {
  readonly playing: number;
  readonly phase: Phase;
  /** Percent (0-100) of the open area no brick can reach: what sets the phase. */
  readonly filled: number;
  /**
   * Percent (0-100) of the open area with a brick in it, and the one it grows at (null once it
   * is the whole map); both null from a canvas that predates them (ADR 0033 amended).
   */
  readonly built: number | null;
  readonly growsAt: number | null;
  readonly rates: Readonly<Record<Phase, Rates>>;
}

/**
 * How often a visible page asks for the stats (ms), unless the manifest brought them within
 * this long. Every ask runs the gateway Worker (the edge cache spares only the canvas), so
 * pages ask once a minute; a playing socket's Stats frames keep its playing count fresher.
 */
export const STATS_POLL_MS = 60_000;
/** Counts older than this (ms) are not shown: two missed polls, or a socket long gone. */
export const STATS_STALE_MS = 150_000;

const count = (n: unknown, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;

/** The /api/stats body, or null when it is not one this build can show. */
export function parseStats(body: unknown): CanvasStats | null {
  if (typeof body !== 'object' || body === null) return null;
  const { playing, phase, filled, built, growsAt, rates } = body as Record<string, unknown>;
  if (!count(playing, 0xffffffff) || !count(filled, 100)) return null;
  if (typeof phase !== 'string' || !(PHASES as readonly string[]).includes(phase)) return null;
  if (typeof rates !== 'object' || rates === null) return null;
  const table = {} as Record<Phase, Rates>;
  for (const name of PHASES) {
    const set = (rates as Record<string, unknown>)[name];
    if (!Array.isArray(set) || set.length !== ITEM_KINDS.length) return null;
    if (!set.every((n) => count(n, 2 ** 20))) return null;
    if (set.reduce((a: number, b: number) => a + b, 0) === 0) return null;
    table[name] = set as unknown as Rates;
  }
  // Optional: a value that is not a percent reads as absent, not as a broken body.
  return {
    playing,
    phase: phase as Phase,
    filled,
    built: count(built, 100) ? built : null,
    growsAt: count(growsAt, 100) ? growsAt : null,
    rates: table,
  };
}

/** Each kind's share of a phase's rates, in whole percent, in ITEM_KINDS order. */
export function dropShares(rates: Rates): readonly { kind: ItemKind; percent: number }[] {
  const total = rates.reduce((a, b) => a + b, 0);
  return ITEM_KINDS.map((kind, i) => ({
    kind,
    percent: total > 0 ? Math.round((rates[i]! * 100) / total) : 0,
  }));
}

export const PHASE_NAMES: Record<Phase, string> = {
  settling: 'Settling',
  contested: 'Contested',
  saturated: 'Saturated',
};

/** The latest of two counts that are still fresh at `now`, or null. */
export function latestCount(
  a: { readonly value: number; readonly at: number } | null,
  b: { readonly value: number; readonly at: number } | null,
  now: number,
): number | null {
  const fresh = [a, b].filter((x) => x !== null && now - x.at < STATS_STALE_MS) as {
    value: number;
    at: number;
  }[];
  if (fresh.length === 0) return null;
  return fresh.reduce((x, y) => (y.at > x.at ? y : x)).value;
}

/**
 * Whether the map holds as many players as its cap (ADR 0039), from the gateway's cap and the
 * stats in hand. Unknown (no cap given, none set, no fresh stats) reads as not full: the
 * server decides anyway, and turns the socket away if it is.
 */
export function mapIsFull(cap: number | null | undefined, stats: CanvasStats | null): boolean {
  return typeof cap === 'number' && stats !== null && stats.playing >= cap;
}

export async function fetchStats(): Promise<CanvasStats | null> {
  try {
    const response = await fetch('/api/stats', { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    return parseStats(await response.json());
  } catch {
    return null;
  }
}

/**
 * Polls the stats while the page is visible and the manifest does not bring them; the last
 * good value stays until it is stale.
 */
export class LiveStats {
  readonly state = new Observable<{ readonly stats: CanvasStats | null; readonly at: number }>({
    stats: null,
    at: 0,
  });
  /** The newest manifest stats' `at` taken (canvas clock), and when it last moved (page). */
  private manifestAt = Number.NEGATIVE_INFINITY;
  private manifestMovedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly fetcher: () => Promise<CanvasStats | null> = fetchStats,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Asks now, then every STATS_POLL_MS while the page is visible (and on coming back), each
   * time only when nothing newer than STATS_POLL_MS is in hand.
   */
  start(): void {
    void this.refresh();
    // For the page's lifetime: nothing stops it.
    setInterval(() => {
      if (document.visibilityState === 'visible') void this.refreshIfOld();
    }, STATS_POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refreshIfOld();
    });
  }

  async refresh(): Promise<void> {
    this.offer(await this.fetcher());
  }

  /** Asks the gateway unless the stats in hand are younger than STATS_POLL_MS. */
  async refreshIfOld(): Promise<void> {
    if (this.now() - this.state.get().at >= STATS_POLL_MS) await this.refresh();
  }

  /** Takes stats read elsewhere; null (unreadable) changes nothing. */
  offer(stats: CanvasStats | null): void {
    if (stats) this.state.update({ stats, at: this.now() });
  }

  /**
   * Takes the stats of a manifest the CDN feed read (ADR 0033), unchecked. Skipped when older
   * than those in hand (another edge's copy), or when their `at` (the canvas's write time) has
   * not moved for STATS_STALE_MS while someone plays: the canvas writes them at least once a
   * minute then, so it has stopped (rolled back, R2 down) and the poll takes over. Judged on
   * this page's clock, by when `at` last moved, so clock skew does not matter.
   */
  offerManifest(body: unknown): void {
    const stats = parseStats(body);
    if (!stats) return;
    const { at } = body as { at?: unknown };
    if (typeof at !== 'number' || !Number.isFinite(at) || at < this.manifestAt) return;
    const now = this.now();
    if (at > this.manifestAt) {
      this.manifestAt = at;
      this.manifestMovedAt = now;
    }
    if (stats.playing > 0 && now - this.manifestMovedAt >= STATS_STALE_MS) return;
    this.offer(stats);
  }

  /** The stats, or null once the last answer is stale. */
  current(now: number): CanvasStats | null {
    const { stats, at } = this.state.get();
    return stats && now - at < STATS_STALE_MS ? stats : null;
  }
}
