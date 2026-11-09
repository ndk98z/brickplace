import type { FlagStore } from './screens.ts';

// The stored half of the player's preferences (prefs.ts), with no UI code, so a page that
// only needs one value (the timelapse's "reduce motion") does not load Preact for it.

export interface Prefs {
  /** Rings around empty cells when zoomed in. */
  readonly grid: boolean;
  /** x and y of the cell under the pointer in the coordinates pill. */
  readonly coords: boolean;
  /** A click when a move is accepted. */
  readonly sound: boolean;
  /** No eased zoom and no spinning loaders. */
  readonly reduceMotion: boolean;
}

export type PrefKey = keyof Prefs;

export const PREFS_KEY = 'brickplace.prefs';

const KEYS: readonly PrefKey[] = ['grid', 'coords', 'sound', 'reduceMotion'];

/** The system's "reduce motion" setting and its changes; a seam for tests. */
export interface MotionSetting {
  readonly reduce: boolean;
  watch(change: (reduce: boolean) => void): void;
}

/** The browser's setting; never reducing where it cannot be read (tests, old browsers). */
export function systemMotion(): MotionSetting {
  let query: MediaQueryList | null = null;
  try {
    query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  } catch {
    // As if the system asked for nothing.
  }
  return {
    reduce: query?.matches ?? false,
    watch: (change) => query?.addEventListener?.('change', (event) => change(event.matches)),
  };
}

export function defaultPrefs(reduceMotion: boolean): Prefs {
  return { grid: true, coords: true, sound: false, reduceMotion };
}

/** The choices stored in `text`: its boolean fields this page knows, nothing else. */
export function parseChoices(text: string | null): Partial<Prefs> {
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null) return {};
  const choices: Partial<Record<PrefKey, boolean>> = {};
  for (const key of KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'boolean') choices[key] = v;
  }
  return choices;
}

/** The choices kept in `store`; none where it cannot be read. */
export function readChoices(store: FlagStore | null): Partial<Prefs> {
  try {
    return parseChoices(store?.getItem(PREFS_KEY) ?? null);
  } catch {
    return {};
  }
}

/** localStorage, or null where reading it throws (blocked cookies, some private modes). */
export function localStore(): FlagStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether this browser's player wants less motion: their choice, else the system's. */
export function wantsLessMotion(
  store: FlagStore | null = localStore(),
  motion: MotionSetting = systemMotion(),
): boolean {
  return readChoices(store).reduceMotion ?? motion.reduce;
}
