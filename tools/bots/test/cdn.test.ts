import { cdnKeys } from '@brickplace/protocol/cdn';
import { describe, expect, it } from 'vitest';
import { Cdn, type FetchBody, tilesOf } from '../src/cdn.ts';

const BASE = 'https://tiles.test/c/canvas';
const SIZE = 512;
const TILE = 256;

/** A manifest of a 2×2-tile map: tile versions, segments and the seq they reach. */
function manifest(tiles: number[], segments: [number, number][], seq: number): string {
  return JSON.stringify({
    format: 1,
    seq,
    size: SIZE,
    tileSize: TILE,
    open: { x: 0, y: 0, w: SIZE, h: SIZE },
    maxShield: 3,
    tiles,
    segments,
  });
}

/** A fake CDN: bodies by URL, every request logged; `slow` URLs answer only when told to. */
function fakeCdn(bodies: Record<string, string | number>) {
  const requests: string[] = [];
  const held: (() => void)[] = [];
  const fetch: FetchBody = async (url, signal) => {
    requests.push(url);
    const body = bodies[url];
    if (body === undefined) throw new Error('HTTP 404');
    if (body === -1) {
      await new Promise<void>((resolve, reject) => {
        held.push(resolve);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return new Uint8Array(10);
    }
    return typeof body === 'number' ? new Uint8Array(body) : new TextEncoder().encode(body);
  };
  return { fetch, requests, held };
}

describe('the map from the CDN before the first socket (ADR 0040)', () => {
  it('loads every written tile and the segments past the oldest, and resumes from the seq', async () => {
    const { fetch, requests } = fakeCdn({
      [cdnKeys.manifest(BASE)]: manifest(
        [10, 0, 30, 30],
        [
          [10, 20],
          [20, 30],
          [30, 35],
        ],
        35,
      ),
      [cdnKeys.tile(BASE, 0, 0, 10)]: 100,
      [cdnKeys.tile(BASE, 0, 1, 30)]: 200,
      [cdnKeys.tile(BASE, 1, 1, 30)]: 300,
      [cdnKeys.segment(BASE, 10, 20)]: 1,
      [cdnKeys.segment(BASE, 20, 30)]: 2,
      [cdnKeys.segment(BASE, 30, 35)]: 3,
    });
    const cdn = new Cdn(BASE, undefined, fetch);
    // A never-written tile (version 0) is empty: not fetched, and every segment counts.
    expect(await cdn.heldSeq()).toBe(35);
    expect(requests).toHaveLength(1 + 3 + 3);
    expect(cdn.stats).toMatchObject({ manifests: 1, objects: 6, bytes: 606, loaded: 1 });
    // A second bot reads the manifest again, the tiles and segments only once a run.
    expect(await cdn.heldSeq()).toBe(35);
    expect(requests).toHaveLength(7 + 1);
    expect(cdn.stats).toMatchObject({ manifests: 2, objects: 6, loaded: 2, fallbacks: 0 });
  });

  it('fetches no segment that every tile is already past', async () => {
    const { fetch, requests } = fakeCdn({
      [cdnKeys.manifest(BASE)]: manifest(
        [30, 30, 30, 30],
        [
          [10, 20],
          [20, 30],
          [30, 35],
        ],
        35,
      ),
      [cdnKeys.tile(BASE, 0, 0, 30)]: 1,
      [cdnKeys.tile(BASE, 1, 0, 30)]: 1,
      [cdnKeys.tile(BASE, 0, 1, 30)]: 1,
      [cdnKeys.tile(BASE, 1, 1, 30)]: 1,
      [cdnKeys.segment(BASE, 30, 35)]: 1,
    });
    expect(await new Cdn(BASE, undefined, fetch).heldSeq()).toBe(35);
    expect(requests.filter((url) => url.includes('/diffs/'))).toEqual([
      cdnKeys.segment(BASE, 30, 35),
    ]);
  });

  it('falls back to the whole map on a missing object, and fetches it again for the next bot', async () => {
    const bodies: Record<string, string | number> = {
      [cdnKeys.manifest(BASE)]: manifest([5, 0, 0, 0], [], 5),
    };
    const { fetch, requests } = fakeCdn(bodies);
    const cdn = new Cdn(BASE, undefined, fetch);
    expect(await cdn.heldSeq()).toBeNull();
    expect(cdn.stats).toMatchObject({ fallbacks: 1, loaded: 0, errors: { 'HTTP 404': 1 } });
    // Published meanwhile: the failed fetch was not kept.
    bodies[cdnKeys.tile(BASE, 0, 0, 5)] = 50;
    expect(await cdn.heldSeq()).toBe(5);
    expect(requests.filter((url) => url.includes('/tiles/'))).toHaveLength(2);
  });

  it('gives up past its wait without cancelling the fetch the other bots share', async () => {
    const tile = cdnKeys.tile(BASE, 0, 0, 5);
    const { fetch, requests, held } = fakeCdn({
      [cdnKeys.manifest(BASE)]: manifest([5, 0, 0, 0], [], 5),
      [tile]: -1,
    });
    const cdn = new Cdn(BASE, undefined, fetch, 20);
    expect(await cdn.heldSeq()).toBeNull();
    expect(cdn.stats.errors).toEqual({ timeout: 1 });
    // The slow fetch goes on; the next bot waits for it rather than start another.
    const next = cdn.heldSeq();
    for (let tries = 0; held.length === 0 && tries < 100; tries++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    held[0]!();
    expect(await next).toBe(5);
    expect(requests.filter((url) => url === tile)).toHaveLength(1);
  });

  it('reads the base from /api/me, absolute against the gateway', () => {
    const me = 'https://game.test/api/me';
    expect(tilesOf({ config: { tilesUrl: 'https://pub-x.r2.dev/c/canvas' } }, me)).toBe(
      'https://pub-x.r2.dev/c/canvas',
    );
    // Local dev serves the bucket on the gateway itself, as a path.
    expect(tilesOf({ config: { tilesUrl: '/api/dev/tiles/c/canvas' } }, me)).toBe(
      'https://game.test/api/dev/tiles/c/canvas',
    );
    expect(tilesOf({ config: { tilesUrl: null } }, me)).toBeNull();
    expect(tilesOf({ config: {} }, me)).toBeNull();
    expect(tilesOf(null, me)).toBeNull();
    expect(tilesOf({ config: { tilesUrl: 'javascript:alert(1)' } }, me)).toBeNull();
  });
});
