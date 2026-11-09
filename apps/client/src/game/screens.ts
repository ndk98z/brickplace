import type { SeasonInfo } from '../net/account.ts';
import { Observable } from '../ui/observable.ts';

// The screens over the map that are not account or team dialogs: the landing or the welcome
// card for a first visit, the first-time guide after the first nickname, and the share
// dialog. Whether the first-visit screen and the guide were seen is kept in this browser's
// localStorage only: no server state, so a guide skipped on one device may show once on
// another.

export type Screen = 'landing' | 'welcome' | 'guide' | 'share' | null;

/** The part of Storage this uses; reads and writes may throw (private mode, blocked). */
export interface FlagStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LANDING_KEY = 'brickplace.landing.seen';
const GUIDE_PREFIX = 'brickplace.guide.seen.';

/** The guide is per account; the nickname stands for it (one account per nickname). */
export function guideKey(nickname: string): string {
  return `${GUIDE_PREFIX}${nickname.toLowerCase()}`;
}

/** localStorage, or null where reading it throws (blocked cookies, some private modes). */
export function browserStorage(): FlagStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readFlag(store: FlagStore | null, key: string): boolean {
  if (!store) return false;
  try {
    return store.getItem(key) !== null;
  } catch {
    return false;
  }
}

export function writeFlag(store: FlagStore | null, key: string): void {
  if (!store) return;
  try {
    store.setItem(key, '1');
  } catch {
    // Full or blocked: the screen may show once more on the next visit, nothing worse.
  }
}

/**
 * Whether a game is under way: a live season between its start and end, or no season at all
 * (before the first one, the Stage 0 canvas plays).
 */
export function gameUnderWay(season: SeasonInfo | null | undefined, now: number): boolean {
  if (!season) return true;
  return season.state === 'live' && now >= season.startsAt && now < season.endsAt;
}

/**
 * What a first visit opens on: signed out, neither screen seen in this browser, and not
 * `directed` here by a link (a share link, a team invite, a return from sign-in), since that
 * visitor came for something on the map. While a game is `playing` the map comes first, with
 * a small welcome card over it; between seasons, the full landing.
 */
export function firstVisitScreen(input: {
  readonly signedIn: boolean;
  readonly directed: boolean;
  readonly playing: boolean;
  readonly seen: boolean;
}): 'landing' | 'welcome' | null {
  if (input.signedIn || input.directed || input.seen) return null;
  return input.playing ? 'welcome' : 'landing';
}

const GUIDE_PENDING_PREFIX = 'brickplace.guide.pending.';

/**
 * A guide held back: the account chose its first nickname while no game was under way (a
 * season over, or none started), so the guide waits for a page where one is.
 */
export function guidePendingKey(nickname: string): string {
  return `${GUIDE_PENDING_PREFIX}${nickname.toLowerCase()}`;
}

/** The guide shows once, when an account chooses its first nickname. */
export function showsGuide(before: string | null, after: string | null, seen: boolean): boolean {
  return before === null && after !== null && !seen;
}

export class Screens {
  readonly state = new Observable<{ readonly screen: Screen }>({ screen: null });

  constructor(private readonly store: FlagStore | null = browserStorage()) {}

  open(screen: Screen): void {
    this.state.update({ screen });
  }

  close(): void {
    this.state.update({ screen: null });
  }

  /** On page load: the landing or the welcome card for a first visit. */
  start(input: {
    readonly signedIn: boolean;
    readonly directed: boolean;
    readonly playing: boolean;
  }): void {
    const screen = firstVisitScreen({ ...input, seen: readFlag(this.store, LANDING_KEY) });
    if (screen) this.open(screen);
  }

  /**
   * Leaves the landing or the welcome card (watch, sign in, or close); neither opens again by
   * itself in this browser.
   */
  leaveLanding(): void {
    writeFlag(this.store, LANDING_KEY);
    const { screen } = this.state.get();
    if (screen === 'landing' || screen === 'welcome') this.close();
  }

  /**
   * The account's nickname changed: a first one opens the guide, once per account, while a
   * game is `playing`; otherwise the guide waits for a page where one is (pendingGuide).
   */
  nicknameChanged(before: string | null, after: string | null, playing = true): void {
    if (after === null || !showsGuide(before, after, readFlag(this.store, guideKey(after)))) {
      return;
    }
    if (!playing) {
      writeFlag(this.store, guidePendingKey(after));
      return;
    }
    this.openGuide(after);
  }

  /** On page load: the guide held back from a first nickname, now that a game is under way. */
  pendingGuide(nickname: string | null, playing: boolean): void {
    if (nickname === null || !playing) return;
    if (!readFlag(this.store, guidePendingKey(nickname))) return;
    if (readFlag(this.store, guideKey(nickname))) return;
    this.openGuide(nickname);
  }

  private openGuide(nickname: string): void {
    // Before showing it, so a reload halfway does not show it again.
    writeFlag(this.store, guideKey(nickname));
    this.open('guide');
  }
}
