import { encodeCell } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import {
  CDN_FORMAT,
  cdnKeys,
  decodeOverview,
  decodeSegment,
  decodeTile,
  encodeOverview,
  encodeSegment,
  encodeTile,
  OVERVIEW_SIDE,
  overviewFactor,
  parseKeyframes,
  parseManifest,
} from '../src/cdn.ts';
import { ProtocolError } from '../src/index.ts';

describe('keyframes', () => {
  it('names keyframe objects under the canvas and reads an index', () => {
    expect(cdnKeys.keyframes('c/s1')).toBe('c/s1/keyframes.json');
    expect(cdnKeys.keyframeTile('c/s1', 0, 2, 3, 40)).toBe('c/s1/keyframes/0/2-3/40.bin.gz');
    const index = parseKeyframes(
      JSON.stringify({
        format: CDN_FORMAT,
        size: 8,
        tileSize: 4,
        revision: 0,
        final: false,
        frames: [],
      }),
    );
    expect(index.frames).toEqual([]);
    // Every frame lists every tile: (8 / 4)² = 4 here.
    const frame = (tiles: number[]) =>
      JSON.stringify({
        format: CDN_FORMAT,
        size: 8,
        tileSize: 4,
        revision: 0,
        final: false,
        frames: [{ seq: 1, at: 0, open: { x: 0, y: 0, w: 8, h: 8 }, tiles }],
      });
    expect(parseKeyframes(frame([1, 0, 0, 0])).frames).toHaveLength(1);
    expect(() => parseKeyframes(frame([1, 0, 0]))).toThrow(ProtocolError);
    expect(() => parseKeyframes('{"format":99,"frames":[]}')).toThrow(ProtocolError);
    expect(() => parseKeyframes(`{"format":${CDN_FORMAT}}`)).toThrow(ProtocolError);
  });
});

describe('CDN formats', () => {
  it('cut a tile out of the grid and read it back', () => {
    const size = 8;
    const cells = Uint8Array.from({ length: size * size }, (_, i) => i);
    const shields = Uint8Array.from({ length: size * size }, (_, i) => i % 3);
    const bytes = encodeTile({ cells, shields, size }, 1, 0, 4, 77);
    const tile = decodeTile(bytes);
    expect(tile).toMatchObject({ tx: 1, ty: 0, seq: 77, edge: 4 });
    // Row 1 of tile (1, 0) starts at map cell (4, 1).
    expect([...tile.cells.subarray(4, 8)]).toEqual([12, 13, 14, 15]);
    expect(tile.shields[5]).toBe(13 % 3);
    expect(() => decodeTile(bytes.subarray(0, bytes.length - 1))).toThrow(ProtocolError);
    expect(() => encodeTile({ cells, shields, size }, 0, 0, 3, 1)).toThrow(ProtocolError);
  });

  it('round-trip a diff segment, and refuse unsorted or empty ranges', () => {
    const diffs = [
      { index: 3, cell: 0x80, shield: 0 },
      { index: 4_000_000, cell: 0x8c, shield: 2 },
    ];
    expect(decodeSegment(encodeSegment({ from: 10, to: 12, diffs }))).toEqual({
      from: 10,
      to: 12,
      diffs,
    });
    expect(() => encodeSegment({ from: 1, to: 2, diffs: [...diffs].reverse() })).toThrow(
      ProtocolError,
    );
    expect(() => encodeSegment({ from: 2, to: 2, diffs: [] })).toThrow(ProtocolError);
  });

  it('name objects by version, and refuse a manifest of another format', () => {
    expect(cdnKeys.tile('c/canvas', 3, 4, 99)).toBe('c/canvas/tiles/3-4/99.bin.gz');
    expect(cdnKeys.segment('c/canvas', 5, 9)).toBe('c/canvas/diffs/5-9.bin.gz');
    expect(cdnKeys.manifest('c/canvas')).toBe('c/canvas/manifest.json');
    expect(() => parseManifest(JSON.stringify({ format: CDN_FORMAT + 1 }))).toThrow(ProtocolError);
  });
});

describe('overviews', () => {
  const SIZE = 8;
  const red = encodeCell(3, false, false);
  const blue = encodeCell(9, true, false);

  it('keeps per block the colour most of its filled cells have, and how much is filled', () => {
    const cells = new Uint8Array(SIZE * SIZE);
    // Block (0, 0) of 4x4: three red, one blue. Block (1, 0): one blue. Block (1, 1): full red.
    for (const at of [0, 1, SIZE]) cells[at] = red;
    cells[SIZE + 1] = blue;
    cells[2 * SIZE + 6] = blue;
    for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) cells[y * SIZE + x] = red;
    const overview = decodeOverview(encodeOverview({ cells, size: SIZE }, 4, 77));
    expect(overview).toMatchObject({ factor: 4, side: 2, seq: 77 });
    expect([...overview.colors]).toEqual([4, 10, 0, 4]);
    // 4 of 16 cells, 1 of 16 (rounded up, never 0), none, all.
    expect([...overview.cover]).toEqual([64, 16, 0, 255]);
  });

  it('breaks a tie towards the lower colour index, and refuses what does not divide', () => {
    const cells = new Uint8Array(SIZE * SIZE);
    cells[0] = blue;
    cells[1] = red;
    const overview = decodeOverview(encodeOverview({ cells, size: SIZE }, 8, 1));
    expect([...overview.colors]).toEqual([4]);
    expect(() => encodeOverview({ cells, size: SIZE }, 3, 1)).toThrow(ProtocolError);
    expect(() => decodeOverview(new Uint8Array(15))).toThrow(ProtocolError);
    const bytes = encodeOverview({ cells, size: SIZE }, 2, 1);
    expect(() => decodeOverview(bytes.subarray(0, bytes.length - 1))).toThrow(ProtocolError);
  });

  it('names overview objects, and sizes them to at most OVERVIEW_SIDE a side', () => {
    expect(cdnKeys.overview('c/s1', 40)).toBe('c/s1/overview/40.bin.gz');
    expect(cdnKeys.keyframeOverview('c/s1', 2, 40)).toBe('c/s1/keyframes/2/overview/40.bin.gz');
    expect(overviewFactor(2048)).toBe(2048 / OVERVIEW_SIDE);
    expect(overviewFactor(256)).toBe(1);
    // Always a divisor of the size, so encoding never throws for a map of whole tiles.
    for (let size = 256; size <= 8192; size += 256) {
      const factor = overviewFactor(size);
      expect(size % factor, `size ${size}`).toBe(0);
      expect(size / factor, `size ${size}`).toBeLessThanOrEqual(OVERVIEW_SIDE);
    }
    expect(overviewFactor(1792)).toBe(4);
    expect(overviewFactor(2304)).toBe(6);
  });
});
