import {
  cdnKeys,
  decodeOverview,
  decodeTile,
  type Keyframes,
  type Overview,
} from '@brickplace/protocol/cdn';
import type { Fetcher } from '../net/cdn.ts';

// The timelapse's reading of a season's keyframes (ADR 0021): the index lists, per frame, the
// version of every tile; moving from one frame to another loads only the tiles whose version
// differs. Platform-free, so tests run it against an in-memory bucket.

/** Tile cells kept in memory for going back and forth (64 KiB each at 256²): about 16 MiB. */
const CACHE_TILES = 256;
/** Frame overviews kept (512 KiB each at 512²): about 16 MiB. */
const CACHE_OVERVIEWS = 32;

/** One tile of the map as a frame shows it: its index and its cell bytes (row-major). */
export interface TileCells {
  readonly tile: number;
  readonly cells: Uint8Array;
}

export class Timelapse {
  readonly perRow: number;
  /** The version of each tile currently shown; -1 before the first frame. */
  private readonly shown: number[];
  private readonly cache = new Map<string, Uint8Array>();
  private readonly overviews = new Map<string, Overview>();
  private readonly empty: Uint8Array;

  /**
   * `base` is the canvas's URL in the tiles bucket (as /api/seasons gives it), `index` its
   * keyframe index, `fetchGzip` reads and decompresses one object.
   */
  constructor(
    private readonly base: string,
    readonly index: Keyframes,
    private readonly fetchGzip: Fetcher<Uint8Array>,
  ) {
    this.perRow = index.size / index.tileSize;
    this.shown = new Array<number>(this.perRow * this.perRow).fill(-1);
    this.empty = new Uint8Array(index.tileSize * index.tileSize);
  }

  get frames(): number {
    return this.index.frames.length;
  }

  /**
   * Pixels a side of the frames' overviews, when every frame has one (keyframes cut since
   * overviews exist); null otherwise. A timelapse shown small plays those instead of tiles.
   */
  get overviewSide(): number | null {
    const overviews = this.index.overviews;
    const first = this.index.frames[0];
    if (!overviews || !first || first.seq < overviews.from) return null;
    return this.index.size / overviews.factor;
  }

  /** Frame `i`'s overview (the whole map downscaled): one object, whatever changed. */
  async overview(i: number, signal: AbortSignal): Promise<Overview> {
    const frame = this.index.frames[i];
    if (!frame) throw new RangeError(`no frame ${i}`);
    const key = `overview:${frame.seq}`;
    const hit = this.overviews.get(key);
    if (hit) return hit;
    const url = cdnKeys.keyframeOverview(this.base, this.index.revision, frame.seq);
    const decoded = decodeOverview(await this.fetchGzip(url, signal));
    if (
      decoded.seq !== frame.seq ||
      decoded.factor !== this.index.overviews?.factor ||
      decoded.side * decoded.factor !== this.index.size
    ) {
      throw new Error(`keyframe overview ${url} is not the one asked for`);
    }
    this.overviews.set(key, decoded);
    while (this.overviews.size > CACHE_OVERVIEWS) {
      this.overviews.delete(this.overviews.keys().next().value as string);
    }
    return decoded;
  }

  /**
   * The tiles that change when frame `i` replaces the one shown, with their cells. Nothing is
   * marked shown until every tile is in hand, so an aborted load leaves the view as it was.
   */
  async load(i: number, signal: AbortSignal): Promise<TileCells[]> {
    const frame = this.index.frames[i];
    if (!frame) throw new RangeError(`no frame ${i}`);
    const changed = frame.tiles
      .map((version, tile) => ({ version, tile }))
      .filter(({ version, tile }) => this.shown[tile] !== version);
    const loaded = await Promise.all(
      changed.map(async ({ version, tile }) => ({
        tile,
        cells: await this.cells(tile, version, signal),
      })),
    );
    // Cancelled while loading (a newer frame was asked for): every tile may have arrived from
    // the cache anyway, but this frame must not count as shown.
    signal.throwIfAborted();
    for (const { version, tile } of changed) this.shown[tile] = version;
    return loaded;
  }

  private async cells(tile: number, version: number, signal: AbortSignal): Promise<Uint8Array> {
    if (version === 0) return this.empty;
    const key = `${tile}:${version}`;
    const hit = this.cache.get(key);
    if (hit) {
      // Most recently used goes last.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const tx = tile % this.perRow;
    const ty = (tile - tx) / this.perRow;
    // `base` is a URL, not a key prefix: the key helper only joins the path.
    const url = cdnKeys.keyframeTile(this.base, this.index.revision, tx, ty, version);
    const decoded = decodeTile(await this.fetchGzip(url, signal));
    if (decoded.tx !== tx || decoded.ty !== ty || decoded.seq !== version) {
      throw new Error(`keyframe tile ${url} is not the one asked for`);
    }
    this.cache.set(key, decoded.cells);
    while (this.cache.size > CACHE_TILES) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return decoded.cells;
  }
}
