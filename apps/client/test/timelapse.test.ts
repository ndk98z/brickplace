import { encodeCell } from '@brickplace/core';
import {
  CDN_FORMAT,
  cdnKeys,
  encodeOverview,
  encodeTile,
  type Keyframes,
} from '@brickplace/protocol/cdn';
import { describe, expect, it } from 'vitest';
import { noticeFor } from '../src/net/messages.ts';
import { Timelapse } from '../src/timelapse/frames.ts';
import { cellColors, paintOverview, paintTile } from '../src/timelapse/paint.ts';

// The season timelapse (ADR 0021): frames load only the tiles that change, from the keys the
// game Worker writes.

const SIZE = 8;
const EDGE = 4;
const BASE = 'https://tiles.test/c/s1';

/** A map of SIZE² with one filled cell per given index. */
function grid(filled: readonly number[]) {
  const cells = new Uint8Array(SIZE * SIZE);
  for (const index of filled) cells[index] = encodeCell(5, false, false);
  return { cells, shields: new Uint8Array(SIZE * SIZE), size: SIZE };
}

function bucket(objects: Map<string, Uint8Array>) {
  const reads: string[] = [];
  const fetchGzip = async (url: string) => {
    reads.push(url);
    const object = objects.get(url);
    if (!object) throw new Error(`404 ${url}`);
    return object;
  };
  return { reads, fetchGzip };
}

describe('timelapse', () => {
  // Frame 1 (seq 3): one cell in tile 0. Frame 2 (seq 7): another in tile 3; tile 0 unchanged.
  const objects = new Map<string, Uint8Array>([
    [cdnKeys.keyframeTile(BASE, 0, 0, 0, 3), encodeTile(grid([0]), 0, 0, EDGE, 3)],
    [cdnKeys.keyframeTile(BASE, 0, 1, 1, 7), encodeTile(grid([0, 63]), 1, 1, EDGE, 7)],
  ]);
  const index: Keyframes = {
    format: CDN_FORMAT,
    size: SIZE,
    tileSize: EDGE,
    revision: 0,
    final: true,
    frames: [
      { seq: 3, at: 1_000, open: { x: 0, y: 0, w: SIZE, h: SIZE }, tiles: [3, 0, 0, 0] },
      { seq: 7, at: 2_000, open: { x: 0, y: 0, w: SIZE, h: SIZE }, tiles: [3, 0, 0, 7] },
    ],
  };
  const signal = new AbortController().signal;

  it('loads every tile for the first frame, then only what changed', async () => {
    const { reads, fetchGzip } = bucket(objects);
    const timelapse = new Timelapse(BASE, index, fetchGzip);
    const first = await timelapse.load(0, signal);
    expect(first.map((t) => t.tile)).toEqual([0, 1, 2, 3]);
    expect(first[0]!.cells[0]).toBe(encodeCell(5, false, false));
    // Empty tiles cost no request.
    expect(reads).toHaveLength(1);
    const second = await timelapse.load(1, signal);
    expect(second.map((t) => t.tile)).toEqual([3]);
    expect(second[0]!.cells[15]).toBe(encodeCell(5, false, false));
    // Going back reads nothing new: tile 0 is unchanged and tile 3 becomes empty again.
    const back = await timelapse.load(0, signal);
    expect(back.map((t) => t.tile)).toEqual([3]);
    expect(back[0]!.cells.every((c) => c === 0)).toBe(true);
    expect(reads).toHaveLength(2);
  });

  it('marks nothing shown when a load is cancelled, even if its tiles arrive afterwards', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchGzip } = bucket(objects);
    const slow = async (url: string) => {
      await held;
      return fetchGzip(url);
    };
    const timelapse = new Timelapse(BASE, index, slow);
    const controller = new AbortController();
    const first = timelapse.load(0, controller.signal);
    controller.abort();
    release();
    await expect(first).rejects.toThrow();
    // Frame 0 was never shown: loading it again returns every tile, not none.
    expect((await timelapse.load(0, signal)).map((t) => t.tile)).toEqual([0, 1, 2, 3]);
  });

  it('leaves the view as it was when a load fails', async () => {
    const { fetchGzip } = bucket(new Map());
    const timelapse = new Timelapse(BASE, index, fetchGzip);
    await expect(timelapse.load(0, signal)).rejects.toThrow('404');
    // Nothing was marked shown, so a retry asks for the same tiles again.
    const { fetchGzip: working } = bucket(objects);
    const retry = new Timelapse(BASE, index, working);
    expect((await retry.load(0, signal)).length).toBe(4);
  });

  it('paints a tile into the whole-map image at its place', () => {
    const colors = cellColors();
    const image = new Uint8ClampedArray(SIZE * SIZE * 4);
    const cells = new Uint8Array(EDGE * EDGE);
    cells[0] = encodeCell(0, false, false);
    paintTile(image, SIZE, EDGE, 3, cells, colors);
    // Tile 3 starts at map cell (4, 4).
    const at = (4 * SIZE + 4) * 4;
    expect([...image.subarray(at, at + 4)]).toEqual([0xe8, 0x38, 0x4f, 255]);
    expect(image[0]).toBe(0);
  });

  it('plays frame overviews instead of tiles when every frame has one', async () => {
    // Overviews at 2 cells a pixel: 4² pixels for the 8² map.
    const withOverviews: Keyframes = { ...index, overviews: { factor: 2, from: 3 } };
    const overviewObjects = new Map<string, Uint8Array>([
      [cdnKeys.keyframeOverview(BASE, 0, 3), encodeOverview(grid([0]), 2, 3)],
      [cdnKeys.keyframeOverview(BASE, 0, 7), encodeOverview(grid([0, 63]), 2, 7)],
    ]);
    const { reads, fetchGzip } = bucket(overviewObjects);
    const timelapse = new Timelapse(BASE, withOverviews, fetchGzip);
    expect(timelapse.overviewSide).toBe(4);
    const second = await timelapse.overview(1, signal);
    expect(second.seq).toBe(7);
    // One object a frame, whatever changed; a frame seen before costs nothing.
    await timelapse.overview(1, signal);
    expect(reads).toEqual([cdnKeys.keyframeOverview(BASE, 0, 7)]);
    // The pixel of cell 63 (bottom right) is a quarter filled: its colour, doubled in weight.
    const image = new Uint8ClampedArray(4 * 4 * 4);
    paintOverview(image, second, cellColors());
    const empty = [0xe4, 0xe8, 0xf0];
    expect([...image.subarray(4, 8)]).toEqual([...empty, 255]);
    const at = encodeCell(5, false, false) * 4;
    const five = [...cellColors().subarray(at, at + 3)];
    const half = five.map((c, k) =>
      Math.round((c * (2 * 64)) / 255 + empty[k]! * (1 - (2 * 64) / 255)),
    );
    expect([...image.subarray(15 * 4, 16 * 4)]).toEqual([...half, 255]);
    // Frames from before overviews existed: tiles only.
    expect(
      new Timelapse(BASE, { ...index, overviews: { factor: 2, from: 7 } }, fetchGzip).overviewSide,
    ).toBeNull();
    expect(new Timelapse(BASE, index, fetchGzip).overviewSide).toBeNull();
    // An object of another factor than the index names is refused, though it fits the map.
    const other = new Timelapse(BASE, { ...index, overviews: { factor: 4, from: 3 } }, fetchGzip);
    await expect(other.overview(1, signal)).rejects.toThrow('is not the one asked for');
  });

  it('says when the season is over or the map is paused', () => {
    expect(noticeFor('ended', 'brick').title).toBe('This season is over');
    expect(noticeFor('read_only', 'hammer').body).toContain('hammer');
  });
});
