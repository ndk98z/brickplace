import { describe, expect, it, vi } from 'vitest';
import { cdnStats } from '../src/cdn.ts';
import {
  canvasOf,
  describeCdn,
  describeJoins,
  joinGroups,
  meUrl,
  splitBots,
} from '../src/driver.ts';
import { Eye } from '../src/eye.ts';
import { Mirror } from '../src/mirror.ts';
import { FakeServer } from './fake.ts';

const mix = (builder: number, casual: number, griefer: number, repairer: number) => ({
  builder,
  casual,
  griefer,
  repairer,
});

describe('splitting bots by kind', () => {
  it('adds up to the number asked for, and gives a zero share none', () => {
    expect(splitBots(200, mix(40, 40, 10, 10))).toEqual(mix(80, 80, 20, 20));
    expect(splitBots(2, mix(1, 1, 1, 0))).toEqual(mix(1, 1, 0, 0));
    expect(splitBots(10, mix(1, 1, 1, 0))).toEqual(mix(4, 3, 3, 0));
    expect(splitBots(7, mix(100, 0, 0, 0))).toEqual(mix(7, 0, 0, 0));
    for (let bots = 1; bots <= 50; bots++) {
      const counts = splitBots(bots, mix(3, 5, 0, 2));
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(bots);
      expect(counts.griefer).toBe(0);
    }
  });
});

describe('the summary line for the CDN', () => {
  it('counts maps loaded and fallbacks, with why, and what was fetched once', () => {
    const quiet = cdnStats();
    expect(describeCdn(quiet)).toBe(
      '0 maps loaded, 0 fell back to the socket; 0 manifests, 0 tiles and segments (0 KB, once a run)',
    );
    const busy = {
      ...cdnStats(),
      manifests: 2000,
      objects: 19,
      bytes: 310 * 1024,
      loaded: 1990,
      fallbacks: 10,
      errors: { timeout: 7, 'HTTP 429': 3 },
    };
    expect(describeCdn(busy)).toBe(
      '1990 maps loaded, 10 fell back to the socket (timeout 7, HTTP 429 3); 2000 manifests, ' +
        '19 tiles and segments (310 KB, once a run)',
    );
  });
});

describe('resuming', () => {
  it('reads the canvas from /api/me next to the socket, as a page does', () => {
    expect(meUrl('wss://game.test/ws?x=1')).toBe('https://game.test/api/me');
    expect(meUrl('ws://localhost:8787/ws')).toBe('http://localhost:8787/api/me');
    expect(canvasOf({ config: { season: { canvas: 's-3' } } })).toBe('s-3');
    // Before any season, the Stage 0 canvas plays.
    expect(canvasOf({ config: { season: null } })).toBe('canvas');
    // A guess is not the season: no resume.
    expect(canvasOf({ config: { season: { canvas: 's-3' }, seasonGuessed: true } })).toBeNull();
    expect(canvasOf({})).toBeNull();
    expect(canvasOf(null)).toBeNull();
    expect(canvasOf({ config: { season: { canvas: 7 } } })).toBeNull();
  });

  it('sums joins up by kind, with times and sizes', () => {
    const joins = [
      { kind: 'first', resumed: false, ms: 400, bytes: 300 * 1024 },
      { kind: 'again', resumed: true, ms: 1800, bytes: 2048 },
      { kind: 'again', resumed: true, ms: 4600, bytes: 4096 },
      { kind: 'again', resumed: false, ms: 9000, bytes: 6 * 1024 * 1024 },
    ] as const;
    expect(joinGroups(joins).map(([name, group]) => [name, group.length])).toEqual([
      ['first', 1],
      ['again, resumed', 2],
      ['again, whole map', 1],
    ]);
    expect(describeJoins(joins.slice(1, 3))).toBe(
      '2 (2 resumed), ready p50 1.8 s, p95 4.6 s, max 4.6 s; 3 KB each, p95 4 KB',
    );
    expect(joinGroups([])).toEqual([]);
    // A resume of a quiet map is a few bytes, not 0 KB.
    expect(describeJoins([{ kind: 'again', resumed: true, ms: 50, bytes: 20 }])).toBe(
      '1 (1 resumed), ready p50 0.1 s, p95 0.1 s, max 0.1 s; 20 B each, p95 20 B',
    );
  });
});

describe('the eye on a map of another size', () => {
  it('reads the map again at the size the config frame says', async () => {
    vi.useFakeTimers();
    try {
      const mirror = new Mirror(64, { x: 0, y: 0, w: 64, h: 64 }, 3);
      const server = new FakeServer();
      const eye = new Eye('ws://localhost/ws', mirror, server.connect, () => 0);
      eye.start();
      const first = server.last;
      first.open();
      first.push({ type: 'diffs', seq: 1, diffs: [{ index: 70, cell: 0x80, shield: 0 }] });
      first.push({
        type: 'config',
        mapSize: 128,
        open: { x: 0, y: 0, w: 128, h: 128 },
        maxShield: 3,
      });
      // The grid was read at 64²: not used, and a fresh socket reads it at 128².
      expect(mirror.ready).toBe(false);
      expect(first.closed).not.toBeNull();
      const second = server.last;
      expect(second).not.toBe(first);
      second.open();
      second.push({ type: 'diffs', seq: 2, diffs: [{ index: 128 * 100, cell: 0x80, shield: 0 }] });
      second.push({
        type: 'config',
        mapSize: 128,
        open: { x: 0, y: 0, w: 128, h: 128 },
        maxShield: 3,
      });
      expect(mirror.ready).toBe(true);
      expect(mirror.cells[128 * 100]).toBe(0x80);
      // A size change once the map is in: the copy is not ready until read again.
      second.push({
        type: 'config',
        mapSize: 256,
        open: { x: 0, y: 0, w: 256, h: 256 },
        maxShield: 3,
      });
      expect(mirror.ready).toBe(false);
      expect(second.closed).not.toBeNull();
      expect(server.sockets).toHaveLength(3);
      eye.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
