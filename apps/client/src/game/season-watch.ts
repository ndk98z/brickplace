import type { Me, SeasonInfo } from '../net/account.ts';

// A season changing under an open page (ADR 0021). The page loads one canvas: its tiles come
// from that canvas's prefix in the CDN, and its socket plays there. When another season's
// canvas becomes current, the page must reload, or it keeps showing (and trying to play) a map
// that is over. The gateway's /api/me names the current season and the next one to start
// (`config.nextSeason`); this asks /api/me again just after that start, spread over a little
// time so open pages do not all ask at once, and also when a move is refused as `ended`
// (the season the page shows is over: another may have started). Any answer naming another
// canvas than the page's says so once. At the end of the season the page plays it stops
// playing at once (`over`: no move is sent only to be refused `ended`) and asks /api/me
// again, spread like a start, in case the end was moved.

/** The canvas pages play before any season is registered (gateway STAGE0_CANVAS). */
export const STAGE0_CANVAS = 'canvas';
/** Pages ask after a season's start within this much time (ms), at random. */
export const START_SPREAD_MS = 30_000;
/** A refused `ended` asks /api/me at most this often (ms). */
export const ENDED_CHECK_MS = 60_000;
/** Longest delay setTimeout takes (ms); a later start is planned again on the next answer. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The canvas an /api/me answer says pages use now. */
export function canvasOf(me: Me): string {
  return me.config.season?.canvas ?? STAGE0_CANVAS;
}

/** What the page is doing when another season's canvas turns current. */
export interface PageActivity {
  readonly hidden: boolean;
  /** A dialog or screen is open (account, team, ranking, share...): something may be typed. */
  readonly dialogOpen: boolean;
  /** Moves sent and not yet answered: a reload would lose whether they were taken. */
  readonly awaitingAck: boolean;
  /**
   * The page holds play back (ADR 0026): another page of the account plays (a reload would
   * forget that and take the socket from it when shown), or a Turnstile check is open.
   */
  readonly holding: boolean;
}

/**
 * Reload at once only a page nobody is looking at and that has nothing under way; otherwise
 * show the "new season" card and let the player reload.
 */
export function reloadAtOnce(page: PageActivity): boolean {
  return page.hidden && !page.dialogOpen && !page.awaitingAck && !page.holding;
}

/** How long a page past its season's end waits for moves still awaiting their answer (ms). */
export const OVER_WAIT_MS = 5_000;

/**
 * Runs `run` once no move awaits its answer, or after `waitMs` at most. At a season's end the
 * page stops playing this way: a move sent just before the end that the server took is shown
 * as taken, not `unavailable` from a socket closed under it.
 */
export function whenSettled(
  moves: { pending(): number; subscribe(listener: () => void): () => void },
  run: () => void,
  timers: Pick<SeasonWatchDeps, 'setTimeout' | 'clearTimeout'>,
  waitMs = OVER_WAIT_MS,
): void {
  if (moves.pending() === 0) {
    run();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    unsubscribe();
    timers.clearTimeout(timer);
    run();
  };
  const timer = timers.setTimeout(finish, waitMs);
  const unsubscribe = moves.subscribe(() => {
    if (moves.pending() === 0) finish();
  });
}

export interface SeasonWatchDeps {
  /** Asks /api/me again; its answer comes back through observe(). */
  refresh(): Promise<void>;
  /**
   * The season the page plays reached its end on this page's clock: stop playing (the last
   * answer, taken again now, makes the page a watcher).
   */
  over(): void;
  /** Another canvas is current: called once, with the current season (null: Stage 0). */
  changed(season: SeasonInfo | null): void;
  now(): number;
  random(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export class SeasonWatch {
  /**
   * The canvas this page loaded; null when /api/me gave no answer at load (the page then
   * found its map through the socket, which the gateway sends to the current canvas): the
   * first answer sets it.
   */
  private canvas: string | null;
  private timers: unknown[] = [];
  private done = false;
  private checkedAt = Number.NEGATIVE_INFINITY;
  /**
   * This page's place in the spread (ms), drawn once: a re-plan (any account change) must not
   * push its checks later, nor drop the one just after an end.
   */
  private readonly spread: number;

  constructor(
    me: Me | null,
    private readonly deps: SeasonWatchDeps,
  ) {
    this.spread = Math.floor(deps.random() * START_SPREAD_MS);
    this.canvas = me ? canvasOf(me) : null;
    if (me) this.plan(me);
  }

  /** Every /api/me answer the page takes (load, renewal, a team change, a retry). */
  observe(me: Me): void {
    if (this.done) return;
    // The gateway could not read the registry and guessed Stage 0: says nothing of a change.
    if (me.config.seasonGuessed === true) return;
    this.canvas ??= canvasOf(me);
    const canvas = canvasOf(me);
    // Seasons only follow one another: once a season's canvas, never Stage 0's again.
    if (canvas === STAGE0_CANVAS && this.canvas !== STAGE0_CANVAS) return;
    if (canvas !== this.canvas) {
      this.done = true;
      this.clear();
      this.deps.changed(me.config.season ?? null);
      return;
    }
    this.plan(me);
  }

  /** A move was refused `ended`: the season shown is over, and another may have started. */
  ended(): void {
    if (this.done) return;
    const now = this.deps.now();
    if (now - this.checkedAt < ENDED_CHECK_MS) return;
    this.checkedAt = now;
    void this.deps.refresh();
  }

  stop(): void {
    this.done = true;
    this.clear();
  }

  /**
   * The end of the season the answer says is live, and a check just after the next season's
   * start, if it names one. A start soon after the end asks for both. The check after the end
   * stays planned past the end itself, until it ran: an answer the page takes again in between
   * (a dialog opened) still says live.
   */
  private plan(me: Me): void {
    this.clear();
    const now = this.deps.now();
    const { spread } = this;
    const season = me.config.season ?? null;
    const next = me.config.nextSeason ?? null;
    if (season?.state === 'live') {
      if (season.endsAt > now) this.after(season.endsAt - now, () => this.deps.over());
      const check = season.endsAt + spread;
      const shared = next !== null && next.startsAt <= season.endsAt + START_SPREAD_MS;
      if (check > now && !shared) this.after(check - now, () => void this.deps.refresh());
    }
    if (next) {
      this.after(Math.max(0, next.startsAt - now) + spread, () => void this.deps.refresh());
    }
  }

  /** Runs `run` after `delay` ms; nothing past setTimeout's range (the next answer plans it). */
  private after(delay: number, run: () => void): void {
    if (delay > MAX_TIMER_MS) return;
    const timer = this.deps.setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== timer);
      run();
    }, delay);
    this.timers.push(timer);
  }

  private clear(): void {
    for (const timer of this.timers) this.deps.clearTimeout(timer);
    this.timers = [];
  }
}
