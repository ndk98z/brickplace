import { CDN_FORMAT, type Keyframes } from '@brickplace/protocol/cdn';
import { describe, expect, it } from 'vitest';
import { Latest, type Opened, openSeason, seasonHeading, winnerOf } from '../src/timelapse/load.ts';

// Opening a season's timelapse (ADR 0021): what the page shows for each answer, and that a
// season switched away from mid-load never overwrites the next one.

const PAGE = 'https://brickplace.test/timelapse.html';

function index(frames: number): Keyframes {
  return {
    format: CDN_FORMAT,
    size: 8,
    tileSize: 4,
    revision: 0,
    final: false,
    frames: Array.from({ length: frames }, (_, i) => ({
      seq: i + 1,
      at: 1_000 * (i + 1),
      open: { x: 0, y: 0, w: 8, h: 8 },
      tiles: [0, 0, 0, 0],
    })),
  };
}

const answering = (text: string) => async () => text;
const signal = () => new AbortController().signal;

describe('the season heading', () => {
  it('says "final map" only once the archive is sealed', () => {
    const season = (state: string) => ({ id: 2, state });
    expect(seasonHeading(season('live'), null)).toBe('Season 2 · so far');
    // Over, not sealed: moderators may still take content out (ADR 0021).
    expect(seasonHeading(season('finalizing'), null)).toBe('Season 2 · final map, under review');
    expect(seasonHeading(season('finalizing'), false)).toBe('Season 2 · final map, under review');
    // The index says sealed (an early seal), or the gateway is past the latest seal.
    expect(seasonHeading(season('finalizing'), true)).toBe('Season 2 · final map');
    expect(seasonHeading(season('ended'), null)).toBe('Season 2 · final map');
    expect(seasonHeading({ id: 0, state: 'live' }, null)).toBe('The map, frame by frame');
  });

  it('names the winning team from a ranking answer, with how many tie with it', () => {
    const team = (name: string, rank: number) => ({ id: rank, name, rank, cells: 1 });
    expect(winnerOf({ teams: [team('Owls', 1), team('Bees', 2)] })).toEqual({
      name: 'Owls',
      tied: 1,
    });
    expect(winnerOf({ teams: [team('Owls', 1), team('Bees', 1), team('Ants', 3)] })).toEqual({
      name: 'Owls',
      tied: 2,
    });
    // No team ranked, or not a ranking at all.
    expect(winnerOf({ teams: [] })).toBeNull();
    expect(winnerOf({ error: 'not_found' })).toBeNull();
    expect(winnerOf(null)).toBeNull();
    expect(winnerOf({ teams: [{ rank: 1 }] })).toBeNull();
  });
});

describe('opening a season', () => {
  it('needs a bucket', async () => {
    const opened = await openSeason(null, PAGE, answering('{}'), signal());
    expect(opened).toEqual({ kind: 'no_bucket' });
  });

  it('has no frames before the first keyframe, or with an empty index', async () => {
    const missing = async () => {
      throw new Error('404');
    };
    expect((await openSeason('/c/s1', PAGE, missing, signal())).kind).toBe('no_frames');
    const none = answering(JSON.stringify(index(0)));
    expect((await openSeason('/c/s1', PAGE, none, signal())).kind).toBe('no_frames');
  });

  it('is ready with the index and the bucket URL resolved against the page', async () => {
    const opened = await openSeason('/c/s1', PAGE, answering(JSON.stringify(index(3))), signal());
    expect(opened.kind).toBe('ready');
    if (opened.kind !== 'ready') return;
    expect(opened.base).toBe('https://brickplace.test/c/s1');
    expect(opened.index.frames).toHaveLength(3);
  });

  it('says it was cancelled rather than "no frames" when a newer open took over', async () => {
    const controller = new AbortController();
    const fetching = async (_url: string, s: AbortSignal) => {
      controller.abort();
      s.throwIfAborted();
      return '';
    };
    await expect(openSeason('/c/s1', PAGE, fetching, controller.signal)).rejects.toThrow();
  });

  it('lets only the latest of overlapping opens show anything', async () => {
    const opens = new Latest();
    const shown: string[] = [];
    let releaseSlow!: () => void;
    const slowAnswer = new Promise<string>((resolve) => {
      releaseSlow = () => resolve(JSON.stringify(index(5)));
    });
    // The page's open(): take a ticket, load, then act only while still current.
    const open = async (name: string, fetchText: (url: string) => Promise<string>) => {
      const ticket = opens.next();
      const opened: Opened = await openSeason(`/c/${name}`, PAGE, fetchText, signal());
      if (opens.isCurrent(ticket)) shown.push(`${name}:${opened.kind}`);
    };
    // Season 1 is slow; season 2 is picked meanwhile and answers first.
    const first = open('s1', () => slowAnswer);
    const second = open('s2', answering(JSON.stringify(index(0))));
    await second;
    releaseSlow();
    await first;
    expect(shown).toEqual(['s2:no_frames']);
  });
});
