import { encodeCell, TILE_SIZE } from '@brickplace/core';
import { describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../src/config.ts';
import { Game } from '../src/game/game.ts';
import { cooldownClock, cooldownSpan, countWord } from '../src/game/rules-copy.ts';
import {
  type FlagStore,
  firstVisitScreen,
  gameUnderWay,
  guideKey,
  LANDING_KEY,
  readFlag,
  Screens,
  showsGuide,
  writeFlag,
} from '../src/game/screens.ts';
import {
  arrivalPath,
  cameraFor,
  caption,
  discordText,
  formatZoom,
  linkFromAnotherSeason,
  parseViewPath,
  redditUrl,
  seasonParam,
  shareLink,
  snapshotFileName,
  viewOf,
  viewPath,
  xUrl,
} from '../src/game/share.ts';
import {
  backAround,
  followAccount,
  followConnection,
  initialStatus,
  type MeAnswer,
  maintenanceUntilOf,
  meStatusOf,
  nextSeasonText,
  type StateInputs,
  SystemStatus,
  seasonOver,
  systemState,
  timeLeft,
} from '../src/game/states.ts';
import {
  areaInView,
  captionLayout,
  cellSpan,
  dragSelects,
  MAX_CELL_PX,
  markLayout,
  pointOnImage,
  renderSnapshot,
  selectedArea,
  snapshotScale,
} from '../src/map/snapshot.ts';
import { MapStore } from '../src/map/store.ts';
import { fetchMeResult, returnNotice, type SeasonInfo } from '../src/net/account.ts';
import type { SocketLike } from '../src/net/connection.ts';
import { BUSY_NOTICE, discardNotice, noticeFor } from '../src/net/messages.ts';
import { CONTRIBUTORS } from '../src/pages/contributors-list.ts';
import {
  filtered,
  initialOf,
  kofiLink,
  personUrl,
  sponsorLink,
  sponsorsOf,
} from '../src/pages/support.ts';
import { hexToRgb, PALETTE } from '../src/palette.ts';
import { ModalStack, modalKey, restoreFocus } from '../src/ui/focus.ts';
import { once, startLoad } from '../src/ui/lazy.tsx';
import { Observable } from '../src/ui/observable.ts';

// Lane K: share links and images, the landing and guide gating, system states.

describe('share links', () => {
  it('reads /@x,y,zoomx and clamps the zoom', () => {
    expect(parseViewPath('/@1024,980,4x', 2048)).toEqual({ x: 1024, y: 980, zoom: 4 });
    expect(parseViewPath('/@0,0,0.5x', 2048)).toEqual({ x: 0, y: 0, zoom: 0.5 });
    expect(parseViewPath('/@10,20,999x', 2048)?.zoom).toBe(64);
    expect(parseViewPath('/@10,20,0.01x', 2048)?.zoom).toBe(0.25);
    expect(parseViewPath('/@10%2C20%2C2x', 2048)).toEqual({ x: 10, y: 20, zoom: 2 });
    expect(parseViewPath('/@10,20,2x/', 2048)).toEqual({ x: 10, y: 20, zoom: 2 });
  });

  it('ignores other paths and cells off the map', () => {
    for (const path of [
      '/',
      '/@',
      '/@1,2',
      '/@1,2,3',
      '/@-1,2,3x',
      '/@1,2,0x',
      '/@a,b,cx',
      '/@1,2,3x/extra',
      '/x/@1,2,3x',
      '/@%E0%A4%A,1,1x',
    ]) {
      expect(parseViewPath(path, 2048)).toBeNull();
    }
    expect(parseViewPath('/@2048,0,1x', 2048)).toBeNull();
    expect(parseViewPath('/@0,2048,1x', 2048)).toBeNull();
    expect(parseViewPath('/@2047,2047,1x', 2048)).not.toBeNull();
  });

  it('writes the view the coordinates pill shows, and reads it back', () => {
    const view = viewOf({ cx: 1024.7, cy: 980.2, zoom: 4 });
    expect(view).toEqual({ x: 1024, y: 980, zoom: 4 });
    expect(viewPath(view)).toBe('/@1024,980,4x');
    expect(shareLink('https://brickplace.io/', view)).toBe('https://brickplace.io/@1024,980,4x');
    expect(shareLink('https://brickplace.io', view, 2)).toBe(
      'https://brickplace.io/@1024,980,4x?season=2',
    );
    expect(formatZoom(2.3456)).toBe('2.35');
    expect(formatZoom(0.5)).toBe('0.5');
    for (const zoom of [0.25, 0.5, 1.5, 2.35, 4, 64]) {
      const path = viewPath({ x: 7, y: 9, zoom });
      expect(parseViewPath(path, 2048)).toEqual({ x: 7, y: 9, zoom });
      expect(viewOf(cameraFor({ x: 7, y: 9, zoom }))).toEqual({ x: 7, y: 9, zoom });
    }
  });

  it('tells a link from another season, and only when the season shown is known', () => {
    expect(seasonParam(new URLSearchParams('season=2'), 'season')).toBe(2);
    for (const value of ['0', '-1', '2.5', 'x', '']) {
      expect(seasonParam(new URLSearchParams({ season: value }), 'season'), value).toBeNull();
    }
    const now = { season: { id: 3 } };
    expect(linkFromAnotherSeason(2, now)).toBe(true);
    expect(linkFromAnotherSeason(3, now)).toBe(false);
    // An old link with no season, or a page on the Stage 0 map before seasons.
    expect(linkFromAnotherSeason(null, now)).toBe(false);
    expect(linkFromAnotherSeason(1, { season: null })).toBe(true);
    // The gateway guessed (registry unreadable): it cannot say the map changed.
    expect(linkFromAnotherSeason(2, { season: null, seasonGuessed: true })).toBe(false);
  });

  it('builds the post links and texts', () => {
    const view = { x: 1024, y: 980, zoom: 4 };
    const link = 'https://brickplace.io/@1024,980,4x';
    expect(caption(view, 1)).toEqual({ left: 'BrickPlace · Season 1', right: 'x 1,024 · y 980' });
    expect(caption(view, null).left).toBe('BrickPlace');
    const reddit = new URL(redditUrl(link, 'A title'));
    expect(reddit.origin).toBe('https://www.reddit.com');
    expect(reddit.searchParams.get('url')).toBe(link);
    expect(reddit.searchParams.get('title')).toBe('A title');
    const x = new URL(xUrl(link, 'Look'));
    expect(x.searchParams.get('url')).toBe(link);
    expect(x.searchParams.get('text')).toBe('Look');
    expect(discordText(link, 'T')).toBe(`T\n<${link}>`);
    expect(snapshotFileName(view)).toBe('brickplace-1024-980.png');
  });
});

describe('snapshot pixels', () => {
  const rgbAt = (data: Uint8ClampedArray, width: number, x: number, y: number) => [
    data[(y * width + x) * 4],
    data[(y * width + x) * 4 + 1],
    data[(y * width + x) * 4 + 2],
    data[(y * width + x) * 4 + 3],
  ];

  it('paints filled cells in their palette colour and empty cells white', () => {
    const store = new MapStore(TILE_SIZE);
    store.applyDiffs([
      { index: 1 * TILE_SIZE + 1, cell: encodeCell(0, false, false), shield: 0 },
      { index: 2 * TILE_SIZE + 3, cell: encodeCell(14, false, false), shield: 2 },
    ]);
    const image = renderSnapshot(store, { x: 0, y: 0, w: 4, h: 3 }, 2);
    expect(image.width).toBe(8);
    expect(image.height).toBe(6);
    expect(image.data).toHaveLength(8 * 6 * 4);
    // Too small for the mark: every pixel is a cell.
    expect(markLayout(8, 6)).toBeNull();
    const red = [...hexToRgb(PALETTE[0]!), 255];
    const blue = [...hexToRgb(PALETTE[14]!), 255];
    const white = [255, 255, 255, 255];
    for (const [px, py] of [
      [2, 2],
      [3, 3],
    ]) {
      expect(rgbAt(image.data, 8, px!, py!)).toEqual(red);
    }
    expect(rgbAt(image.data, 8, 6, 4)).toEqual(blue);
    expect(rgbAt(image.data, 8, 7, 5)).toEqual(blue);
    expect(rgbAt(image.data, 8, 0, 0)).toEqual(white);
    expect(rgbAt(image.data, 8, 4, 2)).toEqual(white);
  });

  it('reads the area at its place on the map, across tiles', () => {
    const store = new MapStore(TILE_SIZE * 2);
    const size = TILE_SIZE * 2;
    store.applyDiffs([{ index: 300 * size + 255, cell: encodeCell(8, false, false), shield: 0 }]);
    const image = renderSnapshot(store, { x: 254, y: 299, w: 3, h: 3 }, 1);
    expect(rgbAt(image.data, 3, 1, 1)).toEqual([...hexToRgb(PALETTE[8]!), 255]);
    expect(rgbAt(image.data, 3, 2, 1)).toEqual([255, 255, 255, 255]);
  });

  it('draws seams between bricks at 4 px per cell, not inside one', () => {
    const store = new MapStore(TILE_SIZE);
    // Two cells of one brick side by side (linked right), then a lone cell below.
    store.applyDiffs([
      { index: 0, cell: encodeCell(6, true, false), shield: 0 },
      { index: 1, cell: encodeCell(6, false, false), shield: 0 },
    ]);
    const image = renderSnapshot(store, { x: 0, y: 0, w: 2, h: 1 }, 4);
    const yellow = hexToRgb(PALETTE[6]!);
    // Right edge of the first cell is inside the brick: no seam.
    expect(rgbAt(image.data, 8, 3, 0).slice(0, 3)).toEqual(yellow);
    // Right edge of the second cell and bottom rows are seams: darker.
    const seam = rgbAt(image.data, 8, 7, 0);
    expect(seam[0]).toBeLessThan(yellow[0]);
    expect(rgbAt(image.data, 8, 0, 3)[1]).toBeLessThan(yellow[1]);
    // At 2 px per cell there are no seams.
    const small = renderSnapshot(store, { x: 0, y: 0, w: 2, h: 1 }, 2);
    expect(rgbAt(small.data, 4, 3, 1).slice(0, 3)).toEqual(yellow);
  });

  it('puts the BrickPlace mark in the bottom right corner', () => {
    const store = new MapStore(TILE_SIZE);
    const image = renderSnapshot(store, { x: 0, y: 0, w: 96, h: 96 }, 1);
    const layout = markLayout(96, 96)!;
    expect(layout).toEqual({ size: 3, gap: 1, x: 96 - 3 - 7, y: 96 - 3 - 7 });
    const [orange, blue, yellow, green] = ['#FF6B3D', '#3D7BFF', '#FFD23F', '#2BB673'].map(
      (hex) => [...hexToRgb(hex), 255],
    );
    expect(rgbAt(image.data, 96, layout.x, layout.y)).toEqual(orange);
    expect(rgbAt(image.data, 96, layout.x + 4, layout.y)).toEqual(blue);
    expect(rgbAt(image.data, 96, layout.x, layout.y + 4)).toEqual(yellow);
    expect(rgbAt(image.data, 96, layout.x + 6, layout.y + 6)).toEqual(green);
    // The gap between squares is the white plate.
    expect(rgbAt(image.data, 96, layout.x + 3, layout.y)).toEqual([255, 255, 255, 255]);
  });

  it('scales areas to at most 2048 px and 8 px per cell', () => {
    expect(snapshotScale({ x: 0, y: 0, w: 10, h: 5 })).toBe(MAX_CELL_PX);
    expect(snapshotScale({ x: 0, y: 0, w: 360, h: 200 })).toBe(5);
    expect(snapshotScale({ x: 0, y: 0, w: 2048, h: 2048 })).toBe(1);
    expect(captionLayout(2048).height).toBe(72);
    expect(captionLayout(100).height).toBe(28);
  });

  it('cuts the area in view to the map', () => {
    const viewport = { width: 800, height: 400 };
    expect(areaInView({ cx: 100, cy: 100, zoom: 4 }, viewport, 2048)).toEqual({
      x: 0,
      y: 50,
      w: 200,
      h: 100,
    });
    expect(areaInView({ cx: 2048, cy: 2048, zoom: 0.25 }, viewport, 2048)).toEqual({
      x: 448,
      y: 1248,
      w: 1600,
      h: 800,
    });
  });

  it('turns a drag across the image into whole cells of the area', () => {
    const area = { x: 100, y: 200, w: 50, h: 40 };
    // 4 px per cell: pixels 9..30 cover cells 2..7, either corner first.
    const span = { x: 102, y: 201, w: 6, h: 7 };
    expect(cellSpan(area, 4, { x: 9, y: 4 }, { x: 30, y: 31 })).toEqual(span);
    expect(cellSpan(area, 4, { x: 30, y: 31 }, { x: 9, y: 4 })).toEqual(span);
    // A drag past the image's edges stops at the area.
    expect(cellSpan(area, 4, { x: -20, y: -1 }, { x: 900, y: 900 })).toEqual(area);
    // A click is one cell.
    expect(cellSpan(area, 4, { x: 9, y: 9 }, { x: 9, y: 9 })).toEqual({
      x: 102,
      y: 202,
      w: 1,
      h: 1,
    });
  });

  it('keeps a selection only past a few cells on each side', () => {
    const area = { x: 0, y: 0, w: 50, h: 40 };
    expect(selectedArea(area, 4, { x: 0, y: 0 }, { x: 15, y: 15 })).toEqual({
      x: 0,
      y: 0,
      w: 4,
      h: 4,
    });
    expect(selectedArea(area, 4, { x: 0, y: 0 }, { x: 11, y: 40 })).toBeNull();
    expect(selectedArea(area, 4, { x: 0, y: 0 }, { x: 40, y: 11 })).toBeNull();
  });

  it('selects only after the pointer moved a few CSS px on both axes', () => {
    // Zoomed far out a cell is under a screen pixel: a wobbling tap spans many cells.
    expect(dragSelects({ x: 100, y: 100 }, { x: 103, y: 103 })).toBe(false);
    expect(dragSelects({ x: 100, y: 100 }, { x: 140, y: 104 })).toBe(false);
    expect(dragSelects({ x: 100, y: 100 }, { x: 92, y: 108 })).toBe(true);
  });

  it('maps a pointer on the shown canvas to image pixels, off the caption band', () => {
    // A 400 x 230 canvas (200 rows of image, a 30 px caption) shown at half size.
    const box = { left: 10, top: 20, width: 200, height: 115 };
    const canvas = { width: 400, height: 230 };
    const image = { width: 400, height: 200 };
    expect(pointOnImage({ x: 60, y: 45 }, box, canvas, image)).toEqual({ x: 100, y: 50 });
    // On the caption band, and past the edges: held to the image.
    expect(pointOnImage({ x: 60, y: 130 }, box, canvas, image)).toEqual({ x: 100, y: 199 });
    expect(pointOnImage({ x: -50, y: 0 }, box, canvas, image)).toEqual({ x: 0, y: 0 });
    expect(pointOnImage({ x: 900, y: 900 }, box, canvas, image)).toEqual({ x: 399, y: 199 });
  });
});

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

describe('landing and guide gating', () => {
  it('opens a plain first visit on the landing between seasons, on the welcome card during one', () => {
    const plain = { signedIn: false, directed: false, playing: false, seen: false };
    expect(firstVisitScreen(plain)).toBe('landing');
    expect(firstVisitScreen({ ...plain, playing: true })).toBe('welcome');
    for (const playing of [false, true]) {
      expect(firstVisitScreen({ ...plain, playing, signedIn: true })).toBeNull();
      expect(firstVisitScreen({ ...plain, playing, directed: true })).toBeNull();
      expect(firstVisitScreen({ ...plain, playing, seen: true })).toBeNull();
    }
  });

  it('counts a game under way only between a live season start and end, or with no season', () => {
    const season = { id: 1, canvas: 's1', startsAt: 1_000, endsAt: 2_000, state: 'live' as const };
    expect(gameUnderWay(null, 0)).toBe(true);
    expect(gameUnderWay(undefined, 0)).toBe(true);
    expect(gameUnderWay(season, 1_000)).toBe(true);
    expect(gameUnderWay(season, 1_999)).toBe(true);
    expect(gameUnderWay(season, 999)).toBe(false);
    expect(gameUnderWay(season, 2_000)).toBe(false);
    expect(gameUnderWay({ ...season, state: 'scheduled' }, 1_500)).toBe(false);
    expect(gameUnderWay({ ...season, state: 'ended' }, 1_500)).toBe(false);
  });

  it('rebuilds the link a page came through, for a sign-in to return to', () => {
    expect(arrivalPath(null, null)).toBeNull();
    expect(arrivalPath({ x: 12, y: 34, zoom: 8 }, null)).toBe('/@12,34,8x');
    expect(arrivalPath(null, 7)).toBe('/?team=7');
    expect(arrivalPath({ x: 1, y: 2, zoom: 0.5 }, 7)).toBe('/@1,2,0.5x?team=7');
    // A share link's season comes back with its spot, never alone.
    expect(arrivalPath({ x: 1, y: 2, zoom: 4 }, null, 3)).toBe('/@1,2,4x?season=3');
    expect(arrivalPath({ x: 1, y: 2, zoom: 4 }, 7, 3)).toBe('/@1,2,4x?season=3&team=7');
    expect(arrivalPath(null, 7, 3)).toBe('/?team=7');
  });

  it('goes straight to the map while a game is under way, welcome card on top, once', () => {
    const store = new MemoryStore();
    const screens = new Screens(store);
    screens.start({ signedIn: false, directed: false, playing: true });
    expect(screens.state.get().screen).toBe('welcome');
    screens.leaveLanding();
    expect(screens.state.get().screen).toBeNull();
    // Seen once, neither first-visit screen opens again, between seasons either.
    const later = new Screens(store);
    later.start({ signedIn: false, directed: false, playing: false });
    expect(later.state.get().screen).toBeNull();
  });

  it('shows the guide only on the first nickname', () => {
    expect(showsGuide(null, 'Alice', false)).toBe(true);
    expect(showsGuide(null, 'Alice', true)).toBe(false);
    expect(showsGuide('Alice', 'Bob', false)).toBe(false);
    expect(showsGuide(null, null, false)).toBe(false);
  });

  it('remembers the landing once left', () => {
    const store = new MemoryStore();
    const screens = new Screens(store);
    screens.start({ signedIn: false, directed: false, playing: false });
    expect(screens.state.get().screen).toBe('landing');
    screens.leaveLanding();
    expect(screens.state.get().screen).toBeNull();
    expect(store.getItem(LANDING_KEY)).not.toBeNull();
    const again = new Screens(store);
    again.start({ signedIn: false, directed: false, playing: false });
    expect(again.state.get().screen).toBeNull();
  });

  it('shows the guide once per account', () => {
    const store = new MemoryStore();
    const screens = new Screens(store);
    screens.nicknameChanged(null, 'Alice');
    expect(screens.state.get().screen).toBe('guide');
    screens.close();
    // Marked before showing, in any letter case, so a reload never shows it twice.
    expect(readFlag(store, guideKey('ALICE'))).toBe(true);
    const later = new Screens(store);
    later.nicknameChanged(null, 'Alice');
    expect(later.state.get().screen).toBeNull();
    // A rename is not a first nickname; another account on this browser gets its own guide.
    later.nicknameChanged('Alice', 'Alice2');
    expect(later.state.get().screen).toBeNull();
    later.nicknameChanged(null, 'Bob');
    expect(later.state.get().screen).toBe('guide');
  });

  it('holds the guide from a first nickname chosen while no game is under way', () => {
    const store = new MemoryStore();
    const screens = new Screens(store);
    // A season over (or none started): nothing to play, so no guide now.
    screens.nicknameChanged(null, 'Alice', false);
    expect(screens.state.get().screen).toBeNull();
    expect(readFlag(store, guideKey('Alice'))).toBe(false);
    // A later page, still between seasons: still held.
    const between = new Screens(store);
    between.pendingGuide('Alice', false);
    expect(between.state.get().screen).toBeNull();
    // The first page with a game under way shows it, once.
    const next = new Screens(store);
    next.pendingGuide('alice', true);
    expect(next.state.get().screen).toBe('guide');
    const after = new Screens(store);
    after.pendingGuide('Alice', true);
    expect(after.state.get().screen).toBeNull();
    // Nothing held back, nothing shown.
    after.pendingGuide('Bob', true);
    after.pendingGuide(null, true);
    expect(after.state.get().screen).toBeNull();
  });

  it('works without storage, and when storage throws', () => {
    expect(readFlag(null, LANDING_KEY)).toBe(false);
    expect(readFlag(throwing, LANDING_KEY)).toBe(false);
    expect(() => writeFlag(throwing, LANDING_KEY)).not.toThrow();
    expect(() => writeFlag(null, LANDING_KEY)).not.toThrow();
    const screens = new Screens(throwing);
    screens.start({ signedIn: false, directed: false, playing: false });
    expect(screens.state.get().screen).toBe('landing');
    expect(() => screens.leaveLanding()).not.toThrow();
    screens.nicknameChanged(null, 'Alice');
    expect(screens.state.get().screen).toBe('guide');
  });
});

describe('system states', () => {
  const season = (patch: Partial<SeasonInfo> = {}): SeasonInfo => ({
    id: 1,
    canvas: 's1',
    startsAt: 0,
    endsAt: 10_000,
    state: 'live',
    ...patch,
  });
  const base: StateInputs = {
    me: 'ok',
    maintenanceUntil: null,
    online: true,
    season: season(),
    now: 5_000,
    paused: false,
    ended: false,
    signedOut: false,
    newSeason: false,
  };

  it('asks for a reload when another season is on, before saying the old one ended', () => {
    const next = season({ id: 2, canvas: 's2' });
    expect(systemState({ ...base, season: next, newSeason: true })).toEqual({
      kind: 'new_season',
      season: next,
    });
    expect(systemState({ ...base, ended: true, newSeason: true })?.kind).toBe('new_season');
    // Offline, a reload would not get far.
    expect(systemState({ ...base, online: false, newSeason: true })?.kind).toBe('offline');
  });

  it('is quiet when the page plays normally', () => {
    expect(systemState(base)).toBeNull();
    expect(systemState({ ...base, season: null })).toBeNull();
  });

  it('names each state', () => {
    expect(systemState({ ...base, me: 'suspended' })).toEqual({ kind: 'suspended' });
    expect(systemState({ ...base, me: 'maintenance', maintenanceUntil: 9 })).toEqual({
      kind: 'maintenance',
      until: 9,
    });
    expect(systemState({ ...base, online: false })).toEqual({ kind: 'offline' });
    expect(systemState({ ...base, me: 'offline' })).toEqual({ kind: 'offline' });
    expect(systemState({ ...base, ended: true })?.kind).toBe('ended');
    expect(systemState({ ...base, season: season({ state: 'ended' }) })?.kind).toBe('ended');
    expect(systemState({ ...base, now: 10_000 })).toEqual({ kind: 'ended', season: season() });
    expect(systemState({ ...base, paused: true })).toEqual({ kind: 'paused' });
    expect(systemState({ ...base, me: 'unavailable' })).toEqual({ kind: 'accounts_down' });
    expect(systemState({ ...base, signedOut: true })).toEqual({ kind: 'signed_out' });
  });

  it('shows the most important one', () => {
    const all: StateInputs = {
      ...base,
      me: 'suspended',
      online: false,
      paused: true,
      ended: true,
      signedOut: true,
    };
    expect(systemState(all)?.kind).toBe('suspended');
    expect(systemState({ ...all, me: 'maintenance' })?.kind).toBe('maintenance');
    expect(systemState({ ...all, me: 'unavailable' })?.kind).toBe('offline');
    expect(systemState({ ...all, me: 'unavailable', online: true })?.kind).toBe('ended');
    expect(systemState({ ...all, me: 'unavailable', online: true, ended: false })?.kind).toBe(
      'paused',
    );
  });

  it('explains a watch-only page before a sign-out', () => {
    const both: StateInputs = { ...base, me: 'unavailable', signedOut: true };
    expect(systemState(both)?.kind).toBe('accounts_down');
    expect(systemState({ ...both, me: 'rate_limited' })?.kind).toBe('rate_limited');
    expect(systemState({ ...both, me: 'wrong_host' })?.kind).toBe('wrong_host');
    expect(systemState({ ...both, me: 'ok' })?.kind).toBe('signed_out');
  });

  it('reads the status of /api/me', () => {
    expect(meStatusOf(200, { signedIn: false })).toBe('ok');
    expect(meStatusOf(200, { suspended: true })).toBe('suspended');
    expect(meStatusOf(403, { error: 'banned' })).toBe('suspended');
    expect(meStatusOf(403, { error: 'csrf' })).toBe('unavailable');
    expect(meStatusOf(501, { error: 'locked' })).toBe('maintenance');
    expect(meStatusOf(503, { error: 'maintenance', until: 5 })).toBe('maintenance');
    expect(meStatusOf(503, { error: 'unavailable' })).toBe('unavailable');
    // Only a locked deployment's own answer means maintenance; a bare 501 does not.
    expect(meStatusOf(501, null)).toBe('unavailable');
    expect(meStatusOf(429, null)).toBe('rate_limited');
    expect(meStatusOf(421, { error: 'host' })).toBe('wrong_host');
    expect(maintenanceUntilOf({ until: 5 })).toBe(5);
    expect(maintenanceUntilOf({ until: 'soon' })).toBeNull();
    expect(maintenanceUntilOf(null)).toBeNull();
  });

  it('fetches /api/me with its status', async () => {
    const answer = (response: Response | Error) =>
      (() =>
        response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve(response)) as unknown as typeof fetch;
    const me = { signedIn: false, user: null, csrf: null, config: { providers: [] } };
    expect(await fetchMeResult(answer(Response.json(me)))).toEqual({
      me,
      status: 'ok',
      maintenanceUntil: null,
    });
    expect((await fetchMeResult(answer(new Error('offline')))).status).toBe('offline');
    expect(
      (await fetchMeResult(answer(Response.json({ error: 'unavailable' }, { status: 503 }))))
        .status,
    ).toBe('unavailable');
    expect(
      await fetchMeResult(answer(Response.json({ error: 'locked' }, { status: 501 }))),
    ).toEqual({ me: null, status: 'maintenance', maintenanceUntil: null });
    expect(
      (await fetchMeResult(answer(Response.json({ error: 'banned' }, { status: 403 })))).status,
    ).toBe('suspended');
    // The gateway's answer for a banned account: signed out, kept, and marked (ADR 0023).
    const banned = { ...me, suspended: true };
    expect(await fetchMeResult(answer(Response.json(banned)))).toEqual({
      me: banned,
      status: 'suspended',
      maintenanceUntil: null,
    });
    // A 200 that is not JSON is no answer.
    expect((await fetchMeResult(answer(new Response('<html>')))).status).toBe('unavailable');
  });

  it('words times', () => {
    expect(backAround(null, 0)).toBe('Back soon.');
    expect(backAround(5, 10)).toBe('Back soon.');
    expect(backAround(Date.UTC(2026, 0, 1, 14, 30), 0, 'en-GB')).toMatch(
      /^Back around \d\d:\d\d\.$/,
    );
    expect(timeLeft(3 * 86_400_000 + 4 * 3_600_000, 0)).toBe('3d 04h');
    expect(timeLeft(5 * 3_600_000 + 12 * 60_000, 0)).toBe('5h 12m');
    expect(timeLeft(12 * 60_000 + 59_000, 0)).toBe('12m');
    expect(timeLeft(0, 5)).toBe('0m');
  });

  it('says when a season is over and when the next one starts', () => {
    const season = { id: 2, canvas: 's2', startsAt: 0, endsAt: 1_000, state: 'live' as const };
    expect(seasonOver(null, 5_000)).toBe(false);
    expect(seasonOver(season, 999)).toBe(false);
    expect(seasonOver(season, 1_000)).toBe(true);
    expect(seasonOver({ ...season, state: 'ended' }, 0)).toBe(true);
    expect(seasonOver({ ...season, state: 'finalizing' }, 0)).toBe(true);
    expect(nextSeasonText(null, 0)).toBeNull();
    expect(nextSeasonText({ startsAt: 2 * 86_400_000 + 4 * 3_600_000 }, 0)).toBe(
      'Next season starts in 2d 04h',
    );
    expect(nextSeasonText({ startsAt: 10 }, 10)).toBe('Next season starts any moment');
  });

  it('keeps the design copy for the toasts', () => {
    expect(BUSY_NOTICE).toMatchObject({ title: 'The map is busy', tone: 'busy' });
    // A shed move or discard (ADR 0032): the busy toast, the item kept.
    expect(noticeFor('busy', 'hammer')).toBe(BUSY_NOTICE);
    expect(discardNotice('busy')).toBe(BUSY_NOTICE);
    expect(noticeFor('unavailable', 'brick')).toMatchObject({
      title: "Couldn't confirm that move",
      body: 'The server restarted mid-move. Check the map: the cell shows what really happened.',
    });
    expect(noticeFor('occupied', 'brick')).toMatchObject({
      title: 'Cell already taken',
      body: 'Someone got there first. Your brick is back in your hold.',
    });
  });
});

describe('halt from acks', () => {
  class Silent implements SocketLike {
    binaryType: BinaryType = 'blob';
    readyState = 0;
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  const config: ClientConfig = {
    socketUrl: 'ws://test/ws',
    mapSize: TILE_SIZE,
    open: { x: 0, y: 0, w: TILE_SIZE, h: TILE_SIZE },
    maxShield: 5,
    kofiUrl: null,
    sponsors: [],
    sponsorInfoUrl: null,
  };
  interface Internals {
    onAck(opId: number, ok: boolean, reason: string | null): void;
  }

  it('pauses on read_only until a move goes through, and stays ended', () => {
    vi.useFakeTimers();
    try {
      const game = new Game(config, 'player', () => 0, { createSocket: () => new Silent() });
      const acks = game as unknown as Internals;
      expect(game.ui.get().halt).toBeNull();
      acks.onAck(1, false, 'read_only');
      expect(game.ui.get().halt).toBe('read_only');
      acks.onAck(2, false, 'occupied');
      expect(game.ui.get().halt).toBe('read_only');
      acks.onAck(3, true, null);
      expect(game.ui.get().halt).toBeNull();
      acks.onAck(4, false, 'ended');
      acks.onAck(5, false, 'read_only');
      acks.onAck(6, true, null);
      expect(game.ui.get().halt).toBe('ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a share link at its spot and zoom', () => {
    const game = new Game(config, 'watcher', () => 0, { createSocket: () => new Silent() });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    try {
      game.showView(cameraFor({ x: 10, y: 20, zoom: 8 }));
      expect(viewOf(game.ui.get().camera)).toEqual({ x: 10, y: 20, zoom: 8 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says the whole open area is not held before any map arrived', () => {
    const area = { x: 0, y: 0, w: TILE_SIZE, h: TILE_SIZE };
    const socketOnly = new Game(config, 'player', () => 0, { createSocket: () => new Silent() });
    expect(socketOnly.holdsArea(area)).toBe(false);
    const cdn = new Game(
      { ...config, tilesUrl: 'https://tiles.test/c/canvas' },
      'watcher',
      () => 0,
      {
        createSocket: () => new Silent(),
        cdn: { fetchText: () => new Promise(() => {}), fetchGzip: () => new Promise(() => {}) },
      },
    );
    expect(cdn.holdsArea(area)).toBe(false);
    expect(cdn.holdsArea({ ...area, w: 0 })).toBe(false);
  });
});

describe('page status at load and from the map link', () => {
  const answer = { status: 'ok' as const, maintenanceUntil: null };

  it('trusts ?auth_error=banned only on a signed-out page', () => {
    const banned = new URLSearchParams('auth_error=banned');
    expect(initialStatus(banned, { signedIn: false }, answer).me).toBe('suspended');
    expect(initialStatus(banned, { signedIn: true }, answer).me).toBe('ok');
    expect(
      initialStatus(new URLSearchParams('auth_error=state'), { signedIn: false }, answer).me,
    ).toBe('ok');
    expect(
      initialStatus(
        new URLSearchParams(),
        { signedIn: false },
        { status: 'maintenance', maintenanceUntil: 7 },
      ),
    ).toEqual({ me: 'maintenance', maintenanceUntil: 7 });
  });

  it('shows no banned toast on a signed-in page', () => {
    const banned = new URLSearchParams('auth_error=banned');
    expect(returnNotice(banned, true)).toBeNull();
    expect(returnNotice(banned, false)?.body).toBe('This account is suspended.');
    expect(returnNotice(new URLSearchParams('auth_error=state'), true)).not.toBeNull();
  });

  it('turns a timed-out /api/me into "accounts down" once the map arrives, and asks again once', () => {
    const ui = new Observable<{ connection: { state: string; ok?: boolean } }>({
      connection: { state: 'connecting' },
    });
    const status = new SystemStatus('offline');
    let rechecks = 0;
    const stop = followConnection(ui, status, () => rechecks++);
    expect(status.state.get().me).toBe('offline');
    ui.update({ connection: { state: 'cdn', ok: false } });
    expect(status.state.get().me).toBe('offline');
    ui.update({ connection: { state: 'open' } });
    expect(status.state.get().me).toBe('unavailable');
    expect(rechecks).toBe(1);
    ui.update({ connection: { state: 'cdn', ok: true } });
    expect(rechecks).toBe(1);
    stop();
    // A recheck that fails puts `offline` back; panning then updates the link many times a
    // second. Still one request per page.
    const failing = new SystemStatus('offline');
    let failed = 0;
    followConnection(ui, failing, () => {
      failed++;
      failing.set({ me: 'offline' });
    });
    for (let i = 0; i < 60; i++) ui.update({ connection: { state: 'open' } });
    expect(failed).toBe(1);
    // Other statuses are left alone.
    const fine = new SystemStatus('maintenance');
    followConnection(ui, fine, () => rechecks++);
    expect(fine.state.get().me).toBe('maintenance');
    expect(rechecks).toBe(1);
  });
});

describe('page status follows the gateway', () => {
  type View = {
    signedIn: boolean;
    user: { nickname: string | null } | null;
    config?: { season?: SeasonInfo | null };
  };
  const signedOut: View = { signedIn: false, user: null };
  const player = (nickname: string | null): View => ({ signedIn: true, user: { nickname } });

  function setup(me: View, status: SystemStatus) {
    const account = new Observable<{ me: View }>({ me });
    const guides: [string | null, string | null, boolean][] = [];
    const stop = followAccount(account, status, {
      nicknameChanged: (before, after, playing) => guides.push([before, after, playing]),
    });
    return { account, guides, stop };
  }

  for (const failure of ['offline', 'unavailable', 'maintenance', 'rate_limited'] as const) {
    it(`clears "${failure}" once an account answer arrives`, () => {
      const status = new SystemStatus(failure, 5);
      const { account } = setup(signedOut, status);
      account.update({ me: { ...signedOut } });
      expect(status.state.get()).toMatchObject({ me: 'ok', maintenanceUntil: null });
    });
  }

  it('keeps a suspension through answers', () => {
    const status = new SystemStatus('suspended');
    const { account } = setup(signedOut, status);
    account.update({ me: { ...signedOut } });
    expect(status.state.get().me).toBe('suspended');
  });

  it('tells a sign-out and opens the guide on a first nickname', () => {
    const status = new SystemStatus('ok');
    const { account, guides, stop } = setup(player(null), status);
    account.update({ me: player('Alice') });
    // No season: the Stage 0 canvas plays, so a game is under way.
    expect(guides).toEqual([[null, 'Alice', true]]);
    account.update({ me: signedOut });
    expect(status.state.get().signedOut).toBe(true);
    account.update({ me: player('Alice') });
    expect(status.state.get().signedOut).toBe(false);
    stop();
    account.update({ me: signedOut });
    expect(status.state.get().signedOut).toBe(false);
  });

  it('tells the screens whether a game is under way when a nickname changes', () => {
    const over: SeasonInfo = { id: 1, canvas: 's1', startsAt: 0, endsAt: 1_000, state: 'live' };
    const account = new Observable<{ me: View }>({ me: player(null) });
    const guides: boolean[] = [];
    followAccount(
      account,
      new SystemStatus('ok'),
      { nicknameChanged: (_before, _after, playing) => guides.push(playing) },
      () => 2_000,
    );
    account.update({ me: { ...player('Alice'), config: { season: over } } });
    account.update({ me: { ...player('Alice'), config: { season: { ...over, endsAt: 5_000 } } } });
    expect(guides).toEqual([false, true]);
  });

  it('asks again and takes what the gateway says now', async () => {
    const status = new SystemStatus('offline');
    const adopted: string[] = [];
    const answer = (a: MeAnswer<string>) => () => Promise.resolve(a);
    await status.recheck(answer({ me: 'me', status: 'ok', maintenanceUntil: null }), (me) =>
      adopted.push(me),
    );
    expect(adopted).toEqual(['me']);
    expect(status.state.get().me).toBe('ok');
    await status.recheck(answer({ me: null, status: 'unavailable', maintenanceUntil: null }), () =>
      adopted.push('again'),
    );
    expect(adopted).toEqual(['me']);
    expect(status.state.get().me).toBe('unavailable');
    await status.recheck(
      answer({ me: null, status: 'maintenance', maintenanceUntil: 9 }),
      () => {},
    );
    expect(status.state.get()).toMatchObject({ me: 'maintenance', maintenanceUntil: 9 });
    const banned = new SystemStatus('suspended');
    await banned.recheck(answer({ me: null, status: 'offline', maintenanceUntil: null }), () => {});
    expect(banned.state.get().me).toBe('suspended');
  });
});

describe('modal focus', () => {
  const tab = { key: 'Tab', shiftKey: false };
  const back = { key: 'Tab', shiftKey: true };
  const items = ['first', 'middle', 'last'];

  it('closes on Escape and leaves other keys alone', () => {
    expect(modalKey({ key: 'Escape', shiftKey: false }, items, 'middle', true, 'box')).toEqual({
      kind: 'close',
    });
    expect(modalKey({ key: 'a', shiftKey: false }, items, 'middle', true, 'box')).toBeNull();
  });

  it('wraps Tab at both ends and lets it move inside', () => {
    expect(modalKey(tab, items, 'last', true, 'box')).toEqual({ kind: 'focus', target: 'first' });
    expect(modalKey(back, items, 'first', true, 'box')).toEqual({ kind: 'focus', target: 'last' });
    expect(modalKey(tab, items, 'first', true, 'box')).toBeNull();
    expect(modalKey(back, items, 'last', true, 'box')).toBeNull();
  });

  it('brings focus back in from outside, or to the box when it has no control', () => {
    expect(modalKey(tab, items, 'outside', false, 'box')).toEqual({
      kind: 'focus',
      target: 'first',
    });
    expect(modalKey(back, items, null, false, 'box')).toEqual({ kind: 'focus', target: 'last' });
    expect(modalKey(tab, [], null, false, 'box')).toEqual({ kind: 'focus', target: 'box' });
  });

  it('lets only the topmost modal answer keys', () => {
    const stack = new ModalStack<string>();
    expect(stack.isTop('landing')).toBe(false);
    stack.push('landing');
    stack.push('signin');
    expect(stack.isTop('signin')).toBe(true);
    expect(stack.isTop('landing')).toBe(false);
    stack.remove('signin');
    expect(stack.isTop('landing')).toBe(true);
    stack.remove('landing');
    expect(stack.isTop('landing')).toBe(false);
  });

  it('gives focus back only from the modal on top', () => {
    const stack = new ModalStack<string>();
    stack.push('landing');
    stack.push('signin');
    // The landing closes under the sign-in dialog: it must not pull focus out of it.
    expect(stack.remove('landing')).toBe(false);
    expect(stack.remove('signin')).toBe(true);
    expect(stack.remove('signin')).toBe(false);
  });

  it('gives focus back to the opener while it is on the page', () => {
    const focused: string[] = [];
    const opener = (isConnected: boolean, name: string) => ({
      isConnected,
      focus: () => focused.push(name),
    });
    expect(restoreFocus(opener(true, 'button'))).toBe(true);
    expect(restoreFocus(opener(false, 'gone'))).toBe(false);
    expect(restoreFocus(null)).toBe(false);
    expect(focused).toEqual(['button']);
  });

  it('waits for an opener under the inert page to come back before focusing it', () => {
    const focused: string[] = [];
    let inert = true;
    // The landing's opener (the header logo) is inert until the closing render finishes.
    const logo = {
      isConnected: true,
      focus: () => focused.push('logo'),
      closest: (selector: string) => (selector === '[inert]' && inert ? {} : null),
    };
    const queued: (() => void)[] = [];
    expect(restoreFocus(logo, (run) => queued.push(run))).toBe(true);
    expect(focused).toEqual([]);
    inert = false;
    for (const run of queued) run();
    expect(focused).toEqual(['logo']);
    // Still inert when the deferred try runs: no focus forced into an inert part.
    inert = true;
    restoreFocus(logo, (run) => run());
    expect(focused).toEqual(['logo']);
  });
});

describe('lazy screens', () => {
  it('keeps a loaded chunk and tries a failed one again', async () => {
    let calls = 0;
    let fail = true;
    const code = once(async () => {
      calls++;
      if (fail) throw new Error('chunk gone');
      return 'Share';
    });
    await expect(code.load()).rejects.toThrow('chunk gone');
    expect(code.loaded()).toBeNull();
    fail = false;
    expect(await code.load()).toBe('Share');
    expect(await code.load()).toBe('Share');
    expect(code.loaded()).toBe('Share');
    expect(calls).toBe(2);
  });

  it('reports a failed load to a mounted screen, and to nobody once it went away', async () => {
    const failing = { load: () => Promise.reject(new Error('chunk gone')) };
    const loaded: string[] = [];
    let failures = 0;
    startLoad(
      failing,
      (c: string) => loaded.push(c),
      () => failures++,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toBe(1);
    expect(loaded).toEqual([]);
    const cancel = startLoad(
      failing,
      (c: string) => loaded.push(c),
      () => failures++,
    );
    cancel();
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toBe(1);
    // No handler: a failure is swallowed, not thrown at the page.
    startLoad(failing, () => {}, undefined);
    const working = { load: () => Promise.resolve('Share') };
    startLoad(
      working,
      (c) => loaded.push(c),
      () => failures++,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toEqual(['Share']);
    expect(failures).toBe(1);
  });
});

describe('rule copy', () => {
  it('words the cooldown, the hold and the shield cap', () => {
    expect(cooldownSpan(60_000)).toBe('minute');
    expect(cooldownSpan(120_000)).toBe('2 minutes');
    expect(cooldownSpan(30_000)).toBe('30 seconds');
    expect(cooldownSpan(90_000)).toBe('90 seconds');
    expect(cooldownSpan(1)).toBe('second');
    expect(cooldownClock(60_000)).toBe('1:00');
    expect(cooldownClock(125_000)).toBe('2:05');
    expect(countWord(3)).toBe('three');
    expect(countWord(5)).toBe('five');
    expect(countWord(12)).toBe('12');
  });
});

describe('contributors page', () => {
  it('filters people by role', () => {
    const list = [
      { name: 'A', roles: ['code'] as const },
      { name: 'B', roles: ['art', 'moderation'] as const },
    ];
    expect(filtered(list, 'all')).toHaveLength(2);
    expect(filtered(list, 'art').map((p) => p.name)).toEqual(['B']);
    expect(filtered(list, 'translation')).toEqual([]);
    expect(CONTRIBUTORS.length).toBeGreaterThan(0);
  });

  it('links only the Ko-fi page and sponsor contact the build sets, over https', () => {
    expect(kofiLink({})).toBeNull();
    expect(kofiLink({ VITE_KOFI_URL: 'http://ko-fi.com/x' })).toBeNull();
    expect(kofiLink({ VITE_KOFI_URL: 'https://ko-fi.com/x' })).toBe('https://ko-fi.com/x');
    expect(sponsorLink({})).toBeNull();
    expect(sponsorLink({ VITE_CONTACT_EMAIL: 'hi@e.example' })).toBe('mailto:hi@e.example');
    expect(sponsorLink({ VITE_CONTACT_EMAIL: 'x" onclick="y@e.example' })).toBeNull();
    expect(
      sponsorLink({
        VITE_SPONSOR_INFO_URL: 'https://e.example/s',
        VITE_CONTACT_EMAIL: 'a@e.example',
      }),
    ).toBe('https://e.example/s');
  });

  it('splits the featured sponsor from the others, logos same-origin only', () => {
    const env = {
      VITE_SPONSORS: JSON.stringify([
        { name: 'A', href: 'https://a.example', logo: 'https://evil.example/a.svg' },
        { name: 'B', href: 'https://b.example', logo: '/sponsors/b.svg', featured: true },
      ]),
    };
    const { featured, others } = sponsorsOf(env);
    expect(featured).toMatchObject({ name: 'B', logo: '/sponsors/b.svg' });
    expect(others).toEqual([{ name: 'A', href: 'https://a.example' }]);
    expect(sponsorsOf({})).toEqual({ featured: null, others: [] });
    // The admin area's list replaces the build's; an empty one leaves the build's (ADR 0038).
    const site = { sponsors: [], kofiUrl: null, sponsorInfoUrl: 'https://s.example' };
    expect(sponsorsOf(env, site)).toEqual(sponsorsOf(env));
    const one = { ...site, sponsors: [{ name: 'Z', href: 'https://z.example' }] };
    expect(sponsorsOf(env, one)).toEqual({
      featured: null,
      others: [{ name: 'Z', href: 'https://z.example' }],
    });
    expect(sponsorLink({ VITE_SPONSOR_INFO_URL: 'https://build.example' }, site)).toBe(
      'https://s.example',
    );
    expect(kofiLink({ VITE_KOFI_URL: 'https://ko-fi.com/build' }, site)).toBe(
      'https://ko-fi.com/build',
    );
  });

  it('links people over https only and draws an initial', () => {
    expect(personUrl({ name: 'A', roles: [], url: 'javascript:alert(1)' })).toBeNull();
    expect(personUrl({ name: 'A', roles: [], url: 'https://a.example' })).toBe('https://a.example');
    expect(initialOf('[OWNER NAME]')).toBe('O');
    expect(initialOf('élise')).toBe('É');
    expect(initialOf('!!')).toBe('?');
  });
});
