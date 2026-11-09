import type { SeasonInfo } from '../net/account.ts';
import { Observable } from '../ui/observable.ts';
import { gameUnderWay } from './screens.ts';

// System states from the States design, beyond the per-move toasts (net/messages.ts) and the
// reconnecting toast (App): what the page says when it cannot play normally, and why. Pure
// inputs to one answer, so tests cover the order without a browser.

/**
 * How the gateway answered `/api/me` at load (or at the last check):
 * - `ok`: an answer, signed in or not;
 * - `offline`: no answer at all (network, timeout);
 * - `unavailable`: 503 or another failure, accounts (D1) cannot be read: the page only watches;
 * - `maintenance`: a locked deployment (`{error: "locked"}`) or an explicit `maintenance` error;
 * - `rate_limited`: 429, the owner's WAF rule on `/api` (ADR 0019): the page only watches;
 * - `wrong_host`: 421, the API answers only on the site's own address (ADR 0019);
 * - `suspended`: the account is banned (see meStatusOf).
 */
export type MeStatus =
  | 'ok'
  | 'offline'
  | 'unavailable'
  | 'maintenance'
  | 'rate_limited'
  | 'wrong_host'
  | 'suspended';

export interface StateInputs {
  readonly me: MeStatus;
  /** When maintenance should end (ms), if the gateway said. */
  readonly maintenanceUntil: number | null;
  /** navigator.onLine. */
  readonly online: boolean;
  readonly season: SeasonInfo | null;
  readonly now: number;
  /** The last move was refused `read_only`, and none was accepted since. */
  readonly paused: boolean;
  /** A move was refused `ended`. */
  readonly ended: boolean;
  /** The page was signed in and its session ended while open. */
  readonly signedOut: boolean;
  /**
   * Another season's canvas became current while the page was open (season-watch.ts): the
   * page still shows the one it loaded, so it must reload.
   */
  readonly newSeason: boolean;
}

export type SystemState =
  | { readonly kind: 'suspended' }
  | { readonly kind: 'maintenance'; readonly until: number | null }
  | { readonly kind: 'offline' }
  | { readonly kind: 'new_season'; readonly season: SeasonInfo | null }
  | { readonly kind: 'ended'; readonly season: SeasonInfo | null }
  | { readonly kind: 'paused' }
  | { readonly kind: 'accounts_down' }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'wrong_host' }
  | { readonly kind: 'signed_out' };

/** The one state to show, most important first; null when the page plays (or watches) normally. */
export function systemState(input: StateInputs): SystemState | null {
  if (input.me === 'suspended') return { kind: 'suspended' };
  if (input.me === 'maintenance') return { kind: 'maintenance', until: input.maintenanceUntil };
  if (!input.online || input.me === 'offline') return { kind: 'offline' };
  // Before "ended": the season the page shows may be over, but another one is on now.
  if (input.newSeason) return { kind: 'new_season', season: input.season };
  const season = input.season;
  if (input.ended || seasonOver(season, input.now)) return { kind: 'ended', season };
  if (input.paused) return { kind: 'paused' };
  // Watch-only causes come before "signed out": they explain why signing in will not help yet.
  if (input.me === 'unavailable') return { kind: 'accounts_down' };
  if (input.me === 'rate_limited') return { kind: 'rate_limited' };
  if (input.me === 'wrong_host') return { kind: 'wrong_host' };
  if (input.signedOut) return { kind: 'signed_out' };
  return null;
}

/**
 * The status of an `/api/me` response. The gateway answers a banned account's session with a
 * signed-out body marked `suspended: true` (ADR 0023); a refused sign-in says so with
 * `?auth_error=banned`. A 403 `{error: "banned"}` (or `"suspended"`) counts the same.
 */
export function meStatusOf(status: number, body: unknown): MeStatus {
  const error =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null;
  if (status === 403 && (error === 'banned' || error === 'suspended')) return 'suspended';
  if (status >= 200 && status < 300) {
    const suspended = typeof body === 'object' && body !== null && 'suspended' in body;
    return suspended && (body as { suspended?: unknown }).suspended === true ? 'suspended' : 'ok';
  }
  if (error === 'locked' || error === 'maintenance') return 'maintenance';
  if (status === 429) return 'rate_limited';
  if (status === 421) return 'wrong_host';
  return 'unavailable';
}

/** `until` (ms) from a maintenance answer, if it names one. */
export function maintenanceUntilOf(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const until = (body as { until?: unknown }).until;
  return typeof until === 'number' && Number.isFinite(until) ? until : null;
}

/** "Back around 14:30" when maintenance names an end; "Back soon" when it does not. */
export function backAround(until: number | null, now: number, locale?: string): string {
  if (until === null || until <= now) return 'Back soon.';
  const time = new Date(until).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return `Back around ${time}.`;
}

/** "3d 4h", "5h 12m", "12m": how long until `at`. */
/** The season the page shows is over: its map is read-only until the next one starts. */
export function seasonOver(season: SeasonInfo | null | undefined, now: number): boolean {
  return (
    !!season && (season.state === 'ended' || season.state === 'finalizing' || now >= season.endsAt)
  );
}

/** When the next season starts, if the gateway knows one: "Next season starts in 2d 04h". */
export function nextSeasonText(
  next: { readonly startsAt: number } | null | undefined,
  now: number,
): string | null {
  if (!next) return null;
  return next.startsAt > now
    ? `Next season starts in ${timeLeft(next.startsAt, now)}`
    : 'Next season starts any moment';
}

export function timeLeft(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((at - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${minutes % 60}m`;
}

/** The page-level facts that are not in the game's UI state. */
export interface PageStatus {
  readonly me: MeStatus;
  readonly maintenanceUntil: number | null;
  readonly signedOut: boolean;
  /** Another season's canvas is current: the page must reload (season-watch.ts). */
  readonly newSeason: boolean;
}

/**
 * The page's status at load. A banned account shows as suspended from `/api/me` itself
 * (`suspended: true`, ADR 0023) or after a refused sign-in (`?auth_error=banned`); anyone can
 * type that marker into an address, so it only counts on a page that is signed out.
 */
export function initialStatus(
  params: URLSearchParams,
  me: { readonly signedIn: boolean },
  answer: { readonly status: MeStatus; readonly maintenanceUntil: number | null },
): { me: MeStatus; maintenanceUntil: number | null } {
  const suspended = params.get('auth_error') === 'banned' && !me.signedIn;
  return { me: suspended ? 'suspended' : answer.status, maintenanceUntil: answer.maintenanceUntil };
}

/** The game's link state, as far as the page status cares (game.ts `LinkStatus`). */
interface LinkView {
  readonly state: string;
  readonly ok?: boolean;
}

/**
 * Follows the game's link. A page whose `/api/me` got no answer (a timeout) but whose map then
 * arrives (a socket opened, or the CDN answered) is not offline: it says accounts cannot be
 * read instead, and asks `/api/me` again through `recheck`. Once, not on every frame.
 */
export function followConnection(
  game: {
    get(): { readonly connection: LinkView };
    subscribe(listener: () => void): () => void;
  },
  status: SystemStatus,
  recheck: () => void,
): () => void {
  // Once per page: a recheck that fails sets `offline` again, and the map link updates many
  // times a second while panning. Later recoveries come from the `online` event and the
  // cards' retry buttons.
  let rechecked = false;
  const check = () => {
    if (rechecked) return;
    const { connection } = game.get();
    const reached = connection.state === 'open' || (connection.state === 'cdn' && connection.ok);
    if (!reached || status.state.get().me !== 'offline') return;
    rechecked = true;
    status.set({ me: 'unavailable' });
    recheck();
  };
  check();
  return game.subscribe(check);
}

/** The part of an account view (net/account.ts `Me`) the page status follows. */
interface MeView {
  readonly signedIn: boolean;
  readonly user: { readonly nickname: string | null } | null;
  readonly config?: { readonly season?: SeasonInfo | null };
}

/**
 * Follows the account's views (Account.state). Each one is a gateway answer, so it clears a
 * failure shown before (offline, accounts down, maintenance); a first nickname opens the
 * first-time guide while a game is under way (or holds it for one); a page that was signed in
 * and no longer is says so.
 */
export function followAccount(
  account: {
    get(): { readonly me: MeView };
    subscribe(listener: () => void): () => void;
  },
  status: SystemStatus,
  screens: {
    nicknameChanged(before: string | null, after: string | null, playing: boolean): void;
  },
  now: () => number = Date.now,
): () => void {
  let before = account.get().me;
  return account.subscribe(() => {
    const after = account.get().me;
    if (after === before) return;
    status.answered();
    screens.nicknameChanged(
      before.user?.nickname ?? null,
      after.user?.nickname ?? null,
      gameUnderWay(after.config?.season, now()),
    );
    if (before.signedIn && !after.signedIn) status.set({ signedOut: true });
    if (after.signedIn) status.set({ signedOut: false });
    before = after;
  });
}

/** What fetchMeResult (net/account.ts) gives: the answer, if any, and its status. */
export interface MeAnswer<M> {
  readonly me: M | null;
  readonly status: MeStatus;
  readonly maintenanceUntil: number | null;
}

export class SystemStatus {
  readonly state: Observable<PageStatus>;

  constructor(me: MeStatus, maintenanceUntil: number | null = null) {
    this.state = new Observable<PageStatus>({
      me,
      maintenanceUntil,
      signedOut: false,
      newSeason: false,
    });
  }

  set(patch: Partial<PageStatus>): void {
    this.state.update(patch);
  }

  /**
   * The gateway answered `/api/me` (the account's periodic renewal, a team change, a retry):
   * whatever stopped it before is over. A suspension stays: no answer lifts it.
   */
  answered(): void {
    if (this.state.get().me === 'suspended') return;
    this.set({ me: 'ok', maintenanceUntil: null });
  }

  /**
   * Asks `/api/me` again (back online, or a card's retry button). An answer goes to `adopt`
   * (Account.adopt); either way the status becomes what the gateway said now.
   */
  async recheck<M>(fetch: () => Promise<MeAnswer<M>>, adopt: (me: M) => void): Promise<void> {
    const answer = await fetch();
    if (answer.me !== null) adopt(answer.me);
    if (this.state.get().me === 'suspended') return;
    this.set({ me: answer.status, maintenanceUntil: answer.maintenanceUntil });
  }
}
