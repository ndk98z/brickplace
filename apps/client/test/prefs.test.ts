import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../src/config.ts';
import { Game } from '../src/game/game.ts';
import type { ItemKind } from '../src/game/hold.ts';
import { Preferences } from '../src/game/prefs.ts';
import type { FlagStore } from '../src/game/screens.ts';
import {
  type MotionSetting,
  PREFS_KEY,
  parseChoices,
  wantsLessMotion,
} from '../src/game/stored-prefs.ts';

class MemoryStore implements FlagStore {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const throwing: FlagStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

/** A system setting the test can change, as the browser's media query would. */
function system(reduce: boolean): MotionSetting & { change(reduce: boolean): void } {
  const listeners: ((reduce: boolean) => void)[] = [];
  return {
    reduce,
    watch: (listener) => listeners.push(listener),
    change: (next) => {
      for (const listener of listeners) listener(next);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preferences', () => {
  it('starts with grid and coordinates on, sound off, motion as the system has it', () => {
    expect(new Preferences(new MemoryStore(), system(false)).state.get()).toEqual({
      grid: true,
      coords: true,
      sound: false,
      reduceMotion: false,
    });
    expect(new Preferences(new MemoryStore(), system(true)).state.get().reduceMotion).toBe(true);
  });

  it('stores only the choices made, so motion keeps following the system', () => {
    const store = new MemoryStore();
    new Preferences(store, system(false)).set('sound', true);
    expect(JSON.parse(store.items.get(PREFS_KEY)!)).toEqual({ sound: true });
    const later = new Preferences(store, system(true)).state.get();
    expect(later.sound).toBe(true);
    expect(later.reduceMotion).toBe(true);
    new Preferences(store, system(true)).set('reduceMotion', false);
    expect(new Preferences(store, system(true)).state.get().reduceMotion).toBe(false);
  });

  it('follows a change of the system setting until the player chose', () => {
    const setting = system(false);
    const prefs = new Preferences(new MemoryStore(), setting);
    setting.change(true);
    expect(prefs.state.get().reduceMotion).toBe(true);
    prefs.set('reduceMotion', false);
    setting.change(true);
    expect(prefs.state.get().reduceMotion).toBe(false);
  });

  it('reads only known boolean fields and ignores anything else', () => {
    expect(parseChoices(null)).toEqual({});
    expect(parseChoices('not json')).toEqual({});
    expect(parseChoices('[true]')).toEqual({});
    expect(parseChoices('{"grid":false,"coords":"no","sound":1,"other":true}')).toEqual({
      grid: false,
    });
  });

  it('works for the page when storage is blocked', () => {
    const prefs = new Preferences(throwing, system(false));
    prefs.set('grid', false);
    expect(prefs.state.get().grid).toBe(false);
    expect(wantsLessMotion(throwing, system(true))).toBe(true);
  });

  it('tells the timelapse the same motion choice without the UI', () => {
    const store = new MemoryStore();
    expect(wantsLessMotion(store, system(true))).toBe(true);
    new Preferences(store, system(true)).set('reduceMotion', false);
    expect(wantsLessMotion(store, system(true))).toBe(false);
  });
});

const config: ClientConfig = {
  socketUrl: 'ws://test/ws',
  mapSize: 2048,
  open: { x: 512, y: 512, w: 1024, h: 1024 },
  maxShield: 5,
  kofiUrl: null,
  sponsors: [],
  sponsorInfoUrl: null,
};

function page(choices: { sound?: boolean; reduceMotion?: boolean }) {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  const prefs = new Preferences(new MemoryStore(), system(false));
  for (const [key, value] of Object.entries(choices)) {
    prefs.set(key as 'sound' | 'reduceMotion', value);
  }
  const played: ItemKind[] = [];
  const unlocks = { count: 0 };
  const game = new Game(config, 'player', () => 0, {
    prefs,
    sound: { unlock: () => unlocks.count++, play: (kind) => played.push(kind) },
  });
  const internals = game as unknown as {
    connection: unknown;
    sent: Map<number, { itemId: number; kind: ItemKind; discard: boolean }>;
    onAck(opId: number, ok: boolean, reason: string | null): void;
  };
  return { game, internals, played, unlocks };
}

/** Holds one O brick, selected, on a page whose socket takes any op as id 7. */
function holdingBrick(game: Game, internals: { connection: unknown }): void {
  internals.connection = { send: () => 7 };
  game.ui.update({
    hold: { ...game.ui.get().hold, items: [{ kind: 'brick', shape: 1, id: 1 }] },
    selected: 1,
  });
}

describe('sound effects', () => {
  it('clicks for an accepted move only, never for a refusal or a discard', () => {
    const { internals, played } = page({ sound: true });
    internals.sent.set(1, { itemId: 1, kind: 'hammer', discard: false });
    internals.sent.set(2, { itemId: 2, kind: 'brick', discard: false });
    internals.sent.set(3, { itemId: 3, kind: 'shield', discard: true });
    internals.onAck(1, true, null);
    internals.onAck(2, false, 'empty');
    internals.onAck(3, true, null);
    expect(played).toEqual(['hammer']);
  });

  it('stays quiet while the preference is off', () => {
    const { internals, played } = page({ sound: false });
    internals.sent.set(1, { itemId: 1, kind: 'brick', discard: false });
    internals.onAck(1, true, null);
    expect(played).toEqual([]);
  });

  it('opens the audio in the click that sends a move, while sound is on', () => {
    const on = page({ sound: true });
    holdingBrick(on.game, on.internals);
    on.game.useAt({ x: 600, y: 600 });
    expect(on.internals.sent.get(7)?.kind).toBe('brick');
    expect(on.unlocks.count).toBe(1);
    const off = page({ sound: false });
    holdingBrick(off.game, off.internals);
    off.game.useAt({ x: 600, y: 600 });
    expect(off.internals.sent.has(7)).toBe(true);
    expect(off.unlocks.count).toBe(0);
  });

  it('opens the audio when the switch turns sound on, not off', () => {
    const { game, unlocks } = page({});
    game.setPreference('sound', true);
    expect(unlocks.count).toBe(1);
    expect(game.prefs.state.get().sound).toBe(true);
    game.setPreference('sound', false);
    game.setPreference('grid', false);
    expect(unlocks.count).toBe(1);
  });
});

describe('the season end on this page', () => {
  it('sends no new move once the end passed, until a role is set again', () => {
    const { game, internals } = page({});
    holdingBrick(game, internals);
    game.seasonOver();
    game.useAt({ x: 600, y: 600 });
    expect(internals.sent.size).toBe(0);
    expect(game.ui.get().notices.at(-1)?.notice.title).toBe('This season is over');
    game.discard();
    expect(internals.sent.size).toBe(0);
    // The end was moved later: the answer that says so sets the role again, play goes on.
    game.setRole('player');
    game.useAt({ x: 600, y: 600 });
    expect(internals.sent.get(7)?.kind).toBe('brick');
  });
});

describe('reduce motion', () => {
  it('zooms at once instead of easing when the player asked for less motion', () => {
    const { game } = page({ reduceMotion: true });
    const before = game.ui.get().camera.zoom;
    game.zoomBy(2);
    expect(game.ui.get().camera.zoom).toBe(before * 2);
  });

  it('eases the zoom over frames otherwise', () => {
    const { game } = page({ reduceMotion: false });
    const before = game.ui.get().camera.zoom;
    game.zoomBy(2);
    expect(game.ui.get().camera.zoom).toBe(before);
  });
});
