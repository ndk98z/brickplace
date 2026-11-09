import {
  type CellDiff,
  colorOf,
  isFilled,
  type Phase,
  type Rates,
  type Rect,
} from '@brickplace/core';
import { ProtocolError } from './index.ts';

// Imported as `@brickplace/protocol/cdn`.
// What spectators read from the CDN without a socket (ADR 0009, layout in ADR 0014): a small
// mutable manifest, immutable tile snapshots and immutable diff segments. Anonymous: no player
// ids anywhere. Binary objects are stored gzip-compressed (`.gz`) as plain bytes, without a
// Content-Encoding header, so no cache or proxy can transcode them; readers decompress with
// DecompressionStream('gzip'). Little-endian, like the socket frames.

/** Bumped on any incompatible change to a format below; readers refuse unknown formats. */
export const CDN_FORMAT = 1;

/** Object keys under one canvas's prefix in the public bucket. */
export const cdnKeys = {
  /** Mutable; short cache lifetime. */
  manifest: (prefix: string) => `${prefix}/manifest.json`,
  /** Immutable: `version` is the log seq the tile was taken at. */
  tile: (prefix: string, tx: number, ty: number, version: number) =>
    `${prefix}/tiles/${tx}-${ty}/${version}.bin.gz`,
  /** Immutable: the cells changed by log seqs from + 1 .. to. */
  segment: (prefix: string, from: number, to: number) => `${prefix}/diffs/${from}-${to}.bin.gz`,
  /** Mutable: the keyframe index of the season (ADR 0021); a minute of cache. */
  keyframes: (prefix: string) => `${prefix}/keyframes.json`,
  /**
   * Immutable: one tile as it was at keyframe `version` (a log seq), in the tile format.
   * `revision` is the index's: a moderation removal rewrites the frames under a new one.
   */
  keyframeTile: (prefix: string, revision: number, tx: number, ty: number, version: number) =>
    `${prefix}/keyframes/${revision}/${tx}-${ty}/${version}.bin.gz`,
  /** Immutable: the whole map downscaled at log seq `version` (encodeOverview). */
  overview: (prefix: string, version: number) => `${prefix}/overview/${version}.bin.gz`,
  /** Immutable: the overview of keyframe `seq`, under the index's `revision`. */
  keyframeOverview: (prefix: string, revision: number, seq: number) =>
    `${prefix}/keyframes/${revision}/overview/${seq}.bin.gz`,
} as const;

/**
 * An overview has at most this many pixels a side: one pixel per `factor`² cells, where
 * `factor` is the smallest whole number that divides the map's size and leaves at most
 * OVERVIEW_SIDE pixels a side (overviewFactor: 4 at 2048², so 512²; 4 at 1792², so 448²).
 * Enough for the whole map on a screen and for a small timelapse, at a 32nd of the tiles' bytes.
 */
export const OVERVIEW_SIDE = 512;

/**
 * Cells per overview pixel along each side for a map of `size`²: the smallest that divides the
 * size and leaves at most OVERVIEW_SIDE pixels a side (4 at 2048², 4 at 1792², 6 at 2304²).
 */
export function overviewFactor(size: number): number {
  let factor = Math.max(1, Math.ceil(size / OVERVIEW_SIDE));
  while (size % factor !== 0) factor++;
  return factor;
}

/** Where a published overview is, as the manifest lists it (absent: none yet). */
export interface OverviewRef {
  /** Cells per overview pixel along each side. */
  readonly factor: number;
  /** Log seq it was cut at; also part of its key (cdnKeys.overview). */
  readonly version: number;
}

/**
 * The season's keyframes (ADR 0021): the whole map at fixed intervals, for the timelapse. A
 * frame lists each tile's version; a tile that did not change since an earlier frame keeps
 * that frame's version, so a frame costs one object per changed tile.
 */
export interface Keyframes {
  readonly format: number;
  readonly size: number;
  readonly tileSize: number;
  /** Part of every tile key (cdnKeys.keyframeTile); grows when the frames are rewritten. */
  readonly revision: number;
  /**
   * True once the season is over and its last frame is in: no frame is added after it. Until
   * `sealed`, a moderation removal may still rewrite frames (a new `revision`).
   */
  readonly final: boolean;
  /**
   * True once the season's archive is sealed (ADR 0021): no removal can come any more, so the
   * frames are the season's for good. Absent before (readers that predate it ignore it).
   */
  readonly sealed?: boolean;
  readonly frames: readonly KeyframeEntry[];
  /**
   * Frames from seq `from` on also have an overview (cdnKeys.keyframeOverview), for a small
   * timelapse; absent when none has. Readers that predate it ignore it.
   */
  readonly overviews?: { readonly factor: number; readonly from: number };
}

export interface KeyframeEntry {
  /** Log seq the frame shows. */
  readonly seq: number;
  /** When it was cut (ms since the epoch). */
  readonly at: number;
  readonly open: Rect;
  /** Version of each tile, row-major by tile; 0 when the tile was still empty. */
  readonly tiles: readonly number[];
}

export function parseKeyframes(text: string): Keyframes {
  const k = JSON.parse(text) as Keyframes;
  if (k.format !== CDN_FORMAT) throw new ProtocolError(`unknown keyframes format ${k.format}`);
  if (!Array.isArray(k.frames)) throw new ProtocolError('keyframes without frames');
  const perRow = k.size / k.tileSize;
  if (!Number.isInteger(perRow) || perRow < 1) throw new ProtocolError('bad keyframe geometry');
  if (k.frames.some((f) => !Array.isArray(f.tiles) || f.tiles.length !== perRow * perRow)) {
    throw new ProtocolError('a keyframe does not list every tile');
  }
  return k;
}

/**
 * The current map, as far as the CDN knows. A reader takes each tile at its listed version
 * (0: never written, so all empty), then applies every listed segment whose `to` is above that
 * version, oldest first: the result is the map at `seq`. Segments carry end values, so applying
 * one to a tile already past its start is harmless.
 */
export interface Manifest {
  readonly format: number;
  /** Every change up to this log seq is in the tiles plus the listed segments. */
  readonly seq: number;
  readonly size: number;
  readonly tileSize: number;
  readonly open: Rect;
  readonly maxShield: number;
  /** Version (log seq) of each tile, row-major by tile; 0 when the tile was never written. */
  readonly tiles: readonly number[];
  /**
   * [from, to] of each listed segment, oldest first. Not always contiguous: when the server
   * republishes every tile instead of writing a segment (a resync), the seqs it skipped are
   * covered by tile versions at or past them, so no reader needs a segment for them.
   */
  readonly segments: readonly (readonly [number, number])[];
  /**
   * Areas where moderators stopped play (ADR 0024); absent when there are none. Readers that
   * predate it ignore it.
   */
  readonly locks?: readonly Rect[];
  /**
   * The whole map downscaled (encodeOverview), for a page zoomed far out and the minimap, so
   * they need no tile; absent until one is published. Readers that predate it ignore it. Cut
   * at its own seq (`version`), like a tile: up to a tile's interval behind `seq`, or a little
   * ahead of it.
   */
  readonly overview?: OverviewRef;
  /**
   * What the game screen shows about the canvas as a whole (ADR 0030, 0033), so pages that
   * watch through the CDN need no call to the gateway; absent from canvases that predate it.
   * Readers that predate it ignore it, and readers check it before use: it is public input,
   * like the rest of the bucket.
   */
  readonly stats?: ManifestStats;
}

/** The canvas-wide numbers a manifest carries: the body GET /api/stats answers, and `at`. */
export interface ManifestStats {
  /**
   * When the manifest carrying them was written (ms, the canvas clock). Rewritten at least
   * once a minute while anyone plays, so a reader can tell counts that stopped coming (a
   * canvas that no longer writes them) from counts that did not change.
   */
  readonly at: number;
  /** Players with a socket open, as the fanout shards last reported. */
  readonly playing: number;
  /** The phase draws use now (ADR 0010). */
  readonly phase: Phase;
  /**
   * Percent (0-100, rounded down) of the open area no brick can reach (filled cells and holes
   * no brick fits): what sets the phase. Not what the open area grows at: that is `built`.
   */
  readonly filled: number;
  /**
   * Percent (0-100, rounded down) of the open area with a brick in it: what the open area
   * grows at. Absent from manifests a canvas wrote before 2026-11-02.
   */
  readonly built?: number;
  /** The `built` percent at which the open area grows; null once it is the whole map. */
  readonly growsAt?: number | null;
  /** Drop weights per phase, in ITEM_KINDS order (brick, single, hammer, shield). */
  readonly rates: Readonly<Record<Phase, Rates>>;
}

export function parseManifest(text: string): Manifest {
  const m = JSON.parse(text) as Manifest;
  if (m.format !== CDN_FORMAT) throw new ProtocolError(`unknown manifest format ${m.format}`);
  return m;
}

// Tile: [magic "BPTL" u32][format u16][edge u16][tx u16][ty u16][seq u32]
//       then edge² cell bytes and edge² shield bytes, row-major within the tile.
const TILE_MAGIC = 0x4c545042;
const TILE_HEADER = 16;

export interface Tile {
  readonly tx: number;
  readonly ty: number;
  /** Log seq the tile reflects; also its version. */
  readonly seq: number;
  readonly edge: number;
  readonly cells: Uint8Array;
  readonly shields: Uint8Array;
}

/** Cuts one tile out of a whole-map grid (row-major, edge `size`) and encodes it. */
export function encodeTile(
  grid: { readonly cells: Uint8Array; readonly shields: Uint8Array; readonly size: number },
  tx: number,
  ty: number,
  edge: number,
  seq: number,
): Uint8Array {
  const { cells, shields, size } = grid;
  if (size % edge !== 0) throw new ProtocolError('the map must be a whole number of tiles');
  checkU32('seq', seq);
  const bytes = new Uint8Array(TILE_HEADER + 2 * edge * edge);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, TILE_MAGIC, true);
  view.setUint16(4, CDN_FORMAT, true);
  view.setUint16(6, edge, true);
  view.setUint16(8, tx, true);
  view.setUint16(10, ty, true);
  view.setUint32(12, seq, true);
  const shieldsAt = TILE_HEADER + edge * edge;
  for (let row = 0; row < edge; row++) {
    const from = (ty * edge + row) * size + tx * edge;
    bytes.set(cells.subarray(from, from + edge), TILE_HEADER + row * edge);
    bytes.set(shields.subarray(from, from + edge), shieldsAt + row * edge);
  }
  return bytes;
}

export function decodeTile(bytes: Uint8Array): Tile {
  if (bytes.byteLength < TILE_HEADER) throw new ProtocolError('tile too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== TILE_MAGIC) throw new ProtocolError('not a tile');
  if (view.getUint16(4, true) !== CDN_FORMAT) throw new ProtocolError('unknown tile format');
  const edge = view.getUint16(6, true);
  if (bytes.byteLength !== TILE_HEADER + 2 * edge * edge) throw new ProtocolError('bad tile size');
  return {
    tx: view.getUint16(8, true),
    ty: view.getUint16(10, true),
    seq: view.getUint32(12, true),
    edge,
    cells: bytes.slice(TILE_HEADER, TILE_HEADER + edge * edge),
    shields: bytes.slice(TILE_HEADER + edge * edge),
  };
}

// Segment: [magic "BPDS" u32][format u16][reserved u16][from u32][to u32][count u32]
//          then count x [index u32][cell u8][shield u8], by increasing cell index.
const SEGMENT_MAGIC = 0x53445042;
const SEGMENT_HEADER = 20;

export interface Segment {
  /** Exclusive: the segment covers log seqs from + 1 .. to. */
  readonly from: number;
  readonly to: number;
  /** The value of every cell changed in the range, as it is at `to`. */
  readonly diffs: readonly CellDiff[];
}

export function encodeSegment({ from, to, diffs }: Segment): Uint8Array {
  checkU32('from', from);
  checkU32('to', to);
  if (to <= from) throw new ProtocolError('a segment must cover at least one seq');
  const bytes = new Uint8Array(SEGMENT_HEADER + diffs.length * 6);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, SEGMENT_MAGIC, true);
  view.setUint16(4, CDN_FORMAT, true);
  view.setUint32(8, from, true);
  view.setUint32(12, to, true);
  view.setUint32(16, diffs.length, true);
  let last = -1;
  diffs.forEach((d, i) => {
    if (d.index <= last) throw new ProtocolError('segment diffs must be by increasing index');
    last = d.index;
    const at = SEGMENT_HEADER + i * 6;
    view.setUint32(at, d.index, true);
    view.setUint8(at + 4, d.cell);
    view.setUint8(at + 5, d.shield);
  });
  return bytes;
}

export function decodeSegment(bytes: Uint8Array): Segment {
  if (bytes.byteLength < SEGMENT_HEADER) throw new ProtocolError('segment too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SEGMENT_MAGIC) throw new ProtocolError('not a segment');
  if (view.getUint16(4, true) !== CDN_FORMAT) throw new ProtocolError('unknown segment format');
  const count = view.getUint32(16, true);
  if (bytes.byteLength !== SEGMENT_HEADER + count * 6) throw new ProtocolError('bad segment size');
  const diffs: CellDiff[] = [];
  for (let i = 0; i < count; i++) {
    const at = SEGMENT_HEADER + i * 6;
    diffs.push({
      index: view.getUint32(at, true),
      cell: view.getUint8(at + 4),
      shield: view.getUint8(at + 5),
    });
  }
  return { from: view.getUint32(8, true), to: view.getUint32(12, true), diffs };
}

// Overview: [magic "BPOV" u32][format u16][factor u16][side u16][reserved u16][seq u32]
//           then side² colour bytes and side² cover bytes, row-major.
// One pixel per factor² block of cells: its colour byte is 0 when no cell of the block is
// filled, else 1 + the colour index most of its filled cells have (the lowest on a tie); its
// cover byte is how much of the block is filled, 0..255, rounded up so one cell never shows
// as none. A reader paints the colour over the background in proportion to the cover.
const OVERVIEW_MAGIC = 0x564f5042;
const OVERVIEW_HEADER = 16;
/** Colour indices a cell byte can hold (5 bits). */
const COLORS = 32;

export interface Overview {
  readonly factor: number;
  /** Pixels a side: the map's size / factor. */
  readonly side: number;
  /** Log seq the overview shows; also its version. */
  readonly seq: number;
  readonly colors: Uint8Array;
  readonly cover: Uint8Array;
}

/** Downscales a whole-map grid (row-major cells, edge `size`) and encodes it. */
export function encodeOverview(
  grid: { readonly cells: Uint8Array; readonly size: number },
  factor: number,
  seq: number,
): Uint8Array {
  const { cells, size } = grid;
  if (!Number.isInteger(factor) || factor < 1 || size % factor !== 0) {
    throw new ProtocolError('the map must be a whole number of overview blocks');
  }
  checkU32('seq', seq);
  const side = size / factor;
  const area = side * side;
  const bytes = new Uint8Array(OVERVIEW_HEADER + 2 * area);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, OVERVIEW_MAGIC, true);
  view.setUint16(4, CDN_FORMAT, true);
  view.setUint16(6, factor, true);
  view.setUint16(8, side, true);
  view.setUint32(12, seq, true);
  const block = factor * factor;
  const counts = new Uint16Array(COLORS);
  for (let py = 0; py < side; py++) {
    for (let px = 0; px < side; px++) {
      counts.fill(0);
      let filled = 0;
      for (let dy = 0; dy < factor; dy++) {
        let at = (py * factor + dy) * size + px * factor;
        for (let dx = 0; dx < factor; dx++, at++) {
          const cell = cells[at]!;
          if (!isFilled(cell)) continue;
          counts[colorOf(cell)]!++;
          filled++;
        }
      }
      if (filled === 0) continue;
      let best = 0;
      for (let c = 1; c < COLORS; c++) if (counts[c]! > counts[best]!) best = c;
      const pixel = py * side + px;
      bytes[OVERVIEW_HEADER + pixel] = best + 1;
      bytes[OVERVIEW_HEADER + area + pixel] = Math.ceil((filled * 255) / block);
    }
  }
  return bytes;
}

export function decodeOverview(bytes: Uint8Array): Overview {
  if (bytes.byteLength < OVERVIEW_HEADER) throw new ProtocolError('overview too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== OVERVIEW_MAGIC) throw new ProtocolError('not an overview');
  if (view.getUint16(4, true) !== CDN_FORMAT) throw new ProtocolError('unknown overview format');
  const factor = view.getUint16(6, true);
  const side = view.getUint16(8, true);
  const area = side * side;
  if (factor < 1 || bytes.byteLength !== OVERVIEW_HEADER + 2 * area) {
    throw new ProtocolError('bad overview size');
  }
  return {
    factor,
    side,
    seq: view.getUint32(12, true),
    colors: bytes.slice(OVERVIEW_HEADER, OVERVIEW_HEADER + area),
    cover: bytes.slice(OVERVIEW_HEADER + area),
  };
}

function checkU32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ProtocolError(`${name} ${value} out of range`);
  }
}
