import { DEFAULT_ITEM_CONFIG, encodeCell, TILE_SIZE } from '@brickplace/core';
import {
  CDN_FORMAT,
  encodeOverview,
  encodeSegment,
  encodeTile,
  type Manifest,
  type Segment,
} from '@brickplace/protocol/cdn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawMinimapTile } from '../src/map/minimap.ts';
import { MapStore } from '../src/map/store.ts';
import {
  CdnFeed,
  type CdnRules,
  type ChangedCell,
  diffsToApply,
  GIVE_UP_FAILURES,
  MAX_SPREAD,
  POLL_MS,
  planSync,
  segmentsCover,
} from '../src/net/cdn.ts';
import { fetchGzip, fetchText } from '../src/net/cdn-fetch.ts';

// Fixtures are built with the protocol's own encoders, as CanvasDO publishes them (ADR 0014).

const SIZE = 512; // 2 × 2 tiles
const BASE = 'https://tiles.test/c/canvas';
const OPEN = { x: 0, y: 0, w: SIZE, h: SIZE };

/** A whole-map grid to cut tiles from. */
function grid() {
  return {
    size: SIZE,
    cells: new Uint8Array(SIZE * SIZE),
    shields: new Uint8Array(SIZE * SIZE),
  };
}

const index = (x: number, y: number) => y * SIZE + x;

function manifest(
  seq: number,
  tiles: number[],
  segments: [number, number][],
  extra: Partial<Manifest> = {},
): Manifest {
  return {
    format: CDN_FORMAT,
    seq,
    size: SIZE,
    tileSize: TILE_SIZE,
    open: OPEN,
    maxShield: 5,
    tiles,
    segments,
    ...extra,
  };
}

/** A fake bucket: the manifest and objects by URL, with every read recorded. */
class Bucket {
  readonly objects = new Map<string, Uint8Array>();
  manifestText = '';
  readonly reads: string[] = [];
  failManifest = false;
  /** Reads of these URLs wait until the promise settles (to hold a fetch open). */
  readonly gates = new Map<string, Promise<void>>();
  /** The abort signal of each object read, by URL. */
  readonly signals = new Map<string, AbortSignal>();

  /** Holds reads of `url` open until the returned function is called. */
  hold(url: string): () => void {
    let release = () => {};
    this.gates.set(
      url,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  setManifest(m: Manifest): void {
    this.manifestText = JSON.stringify(m);
  }
  putTile(g: ReturnType<typeof grid>, tx: number, ty: number, version: number): void {
    this.objects.set(
      `${BASE}/tiles/${tx}-${ty}/${version}.bin.gz`,
      encodeTile(g, tx, ty, TILE_SIZE, version),
    );
  }
  putSegment(segment: Segment): void {
    this.objects.set(`${BASE}/diffs/${segment.from}-${segment.to}.bin.gz`, encodeSegment(segment));
  }
  objectReads(): string[] {
    return this.reads.filter((url) => !url.endsWith('manifest.json'));
  }
}

/** Spread over this long in the spreading tests: below POLL_MS, so steps and polls differ. */
const TEST_SPREAD_MS = 1_000;

function feedOn(bucket: Bucket, store = new MapStore(SIZE), spreadMs = 0) {
  const timers: { fn: () => void; ms: number; at: number; live: boolean }[] = [];
  const rules: CdnRules[] = [];
  const statuses: boolean[] = [];
  const spread: ChangedCell[][] = [];
  const clock = { now: 0 };
  const stats: unknown[] = [];
  const feed = new CdnFeed(
    BASE,
    store,
    {
      rules: (r) => rules.push(r),
      status: (ok) => statuses.push(ok),
      stats: (s) => stats.push(s),
      unusable: () => statuses.push(false),
      spread: (cells) => spread.push([...cells]),
    },
    {
      spreadMs,
      now: () => clock.now,
      random: () => 0,
      fetchText: async (url) => {
        bucket.reads.push(url);
        if (bucket.failManifest) throw new Error('offline');
        return bucket.manifestText;
      },
      // Bytes as stored before gzip: the gzip step has its own test below.
      fetchGzip: async (url, signal) => {
        bucket.reads.push(url);
        bucket.signals.set(url, signal);
        await bucket.gates.get(url);
        const bytes = bucket.objects.get(url);
        if (!bytes) throw new Error(`404 ${url}`);
        return bytes;
      },
      setTimer: (fn, ms) => {
        const timer = { fn, ms, at: clock.now + ms, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimer: (t) => {
        (t as { live: boolean }).live = false;
      },
    },
  );
  // Polls wait at least POLL_MS; spread steps at most TEST_SPREAD_MS.
  const isPoll = (t: { ms: number }) => t.ms >= POLL_MS;
  /** Runs the next poll, as its timer would, and waits for it to finish. */
  const tick = async () => {
    const timer = timers.filter((t) => t.live && isPoll(t)).at(-1);
    if (!timer) throw new Error('no poll scheduled');
    timer.live = false;
    timer.fn();
    await settle();
  };
  /** Moves the clock on by `ms`, running the spread steps that come due on the way. */
  const advance = (ms: number) => {
    const end = clock.now + ms;
    for (;;) {
      const next = timers
        .filter((t) => t.live && !isPoll(t) && t.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      clock.now = Math.max(clock.now, next.at);
      next.live = false;
      next.fn();
    }
    clock.now = end;
  };
  const pending = () => timers.filter((t) => t.live);
  return { feed, store, rules, statuses, stats, tick, pending, spread, advance };
}

/** Lets every queued fetch and its follow-ups run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('segmentsCover', () => {
  it('follows contiguous segments from a seq to the manifest', () => {
    expect(
      segmentsCover(
        [
          [4, 6],
          [6, 9],
        ],
        5,
        9,
      ),
    ).toBe(true);
    expect(segmentsCover([[6, 9]], 6, 9)).toBe(true);
    expect(segmentsCover([], 9, 9)).toBe(true);
  });

  it('fails across skipped seqs, retired segments, or a manifest past the last segment', () => {
    // Seqs 6..8 skipped by a resync.
    expect(
      segmentsCover(
        [
          [2, 5],
          [8, 9],
        ],
        3,
        9,
      ),
    ).toBe(false);
    // The segment covering 3..5 is no longer listed.
    expect(segmentsCover([[5, 9]], 3, 9)).toBe(false);
    // A resync moved the manifest's seq with tiles only.
    expect(segmentsCover([[2, 5]], 3, 9)).toBe(false);
    // One skipped seq (6) is a gap too: a restart can skip a single seq (skipTo).
    expect(
      segmentsCover(
        [
          [2, 5],
          [6, 9],
        ],
        3,
        9,
      ),
    ).toBe(false);
  });
});

describe('planSync', () => {
  it('loads wanted tiles at their versions and skips the others', () => {
    const plan = planSync(manifest(9, [7, 0, 3, 9], [[7, 9]]), [-1, -1, -1, -1], (t) => t < 2);
    expect(plan.tiles).toEqual([
      { tile: 0, version: 7 },
      { tile: 1, version: 0 },
    ]);
    expect([...plan.base]).toEqual([
      [0, 7],
      [1, 0],
    ]);
    // Tile 1 (version 0) is empty and needs every listed segment after 0.
    expect(plan.segments).toEqual([[7, 9]]);
  });

  it('brings a held tile forward by segments, without fetching it again', () => {
    const plan = planSync(
      manifest(
        12,
        [10, 10, 10, 10],
        [
          [8, 10],
          [10, 12],
        ],
      ),
      [9, 9, 9, 9],
      () => true,
    );
    expect(plan.tiles).toEqual([]);
    expect(plan.segments).toEqual([
      [8, 10],
      [10, 12],
    ]);
  });

  it('reloads a held tile that a gap separates from its listed version', () => {
    // Seqs 6..9 skipped (a resync republished every tile at 10).
    const plan = planSync(
      manifest(
        12,
        [10, 10, 4, 10],
        [
          [3, 5],
          [10, 12],
        ],
      ),
      [4, 4, 4, 11],
      (tile) => tile !== 1,
    );
    // Tile 0 reloads; tile 1 would too, but is not wanted now, so it stops counting as held;
    // tile 2 is at its version already; tile 3 is past it.
    expect(plan.tiles).toEqual([{ tile: 0, version: 10 }]);
    expect(plan.dropped).toEqual([1]);
    expect(plan.base.has(1)).toBe(false);
    expect(plan.base.get(2)).toBe(4);
    expect(plan.base.get(3)).toBe(11);
    // Tile 2 still needs seq 5 from the first segment.
    expect(plan.segments).toEqual([
      [3, 5],
      [10, 12],
    ]);
  });
});

describe('diffsToApply', () => {
  it('skips a segment for a tile already past its end', () => {
    const segments: Segment[] = [
      { from: 4, to: 6, diffs: [{ index: index(1, 1), cell: 1, shield: 0 }] },
      {
        from: 6,
        to: 8,
        diffs: [
          { index: index(1, 1), cell: 2, shield: 0 },
          { index: index(300, 1), cell: 3, shield: 1 },
        ],
      },
    ];
    // Tile 0 at 6 needs only the second segment; tile 1 at 8 needs neither.
    const base = new Map([
      [0, 6],
      [1, 8],
    ]);
    expect(diffsToApply(segments, base, SIZE)).toEqual([
      { index: index(1, 1), cell: 2, shield: 0 },
    ]);
  });
});

describe('CdnFeed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the tiles at their versions and applies the segments after them', async () => {
    const bucket = new Bucket();
    const g = grid();
    g.cells[index(5, 5)] = 10;
    bucket.putTile(g, 0, 0, 4);
    // Seqs 5..6 change a cell in tile 0 and one in tile 3 (never written as a tile).
    bucket.putSegment({
      from: 4,
      to: 6,
      diffs: [
        { index: index(6, 5), cell: 11, shield: 2 },
        { index: index(400, 400), cell: 12, shield: 0 },
      ],
    });
    bucket.setManifest(manifest(6, [4, 0, 0, 0], [[4, 6]]));
    const { feed, store, rules, pending } = feedOn(bucket);
    feed.want([0]);
    feed.start();
    await settle();

    expect(store.cell(5, 5)).toBe(10);
    expect(store.cell(6, 5)).toBe(11);
    expect(store.shield(6, 5)).toBe(2);
    expect(store.cell(400, 400)).toBe(12);
    // A manifest that lists no lock (ADR 0024) means none.
    expect(rules).toEqual([{ open: OPEN, maxShield: 5, locks: [] }]);
    // Only the written tile and the segment were read: empty tiles cost nothing.
    expect(bucket.objectReads()).toEqual([
      `${BASE}/tiles/0-0/4.bin.gz`,
      `${BASE}/diffs/4-6.bin.gz`,
    ]);
    expect(pending().map((t) => t.ms)).toEqual([POLL_MS]);
    expect([0, 1, 2, 3].map((t) => feed.tileSeq(t))).toEqual([6, 6, 6, 6]);
  });

  it('never steps a tile back with a segment older than its version', async () => {
    const bucket = new Bucket();
    const g = grid();
    // The tile was cut at seq 9, after the cell changed again at seq 9.
    g.cells[index(3, 3)] = 30;
    bucket.putTile(g, 0, 0, 9);
    bucket.putTile(grid(), 1, 0, 6);
    bucket.putSegment({ from: 6, to: 8, diffs: [{ index: index(3, 3), cell: 20, shield: 0 }] });
    bucket.putSegment({ from: 8, to: 10, diffs: [{ index: index(4, 3), cell: 21, shield: 0 }] });
    // Tile 1 still needs the first segment (its version is 6).
    bucket.setManifest(
      manifest(
        10,
        [9, 6, 0, 0],
        [
          [6, 8],
          [8, 10],
        ],
      ),
    );
    const { feed, store } = feedOn(bucket);
    feed.start();
    await settle();
    expect(store.cell(3, 3)).toBe(30);
    expect(store.cell(4, 3)).toBe(21);
    expect(feed.tileSeq(0)).toBe(10);
  });

  it('keeps a tile cut past the manifest seq at its own version', async () => {
    const bucket = new Bucket();
    const g = grid();
    g.cells[index(7, 7)] = 40;
    // Tiles are cut at the canvas's current seq, which can be past the last segment.
    bucket.putTile(g, 0, 0, 13);
    bucket.putSegment({ from: 10, to: 12, diffs: [{ index: index(7, 7), cell: 39, shield: 0 }] });
    bucket.setManifest(manifest(12, [13, 0, 0, 0], [[10, 12]]));
    const { feed, store, tick } = feedOn(bucket);
    feed.start();
    await settle();
    expect(store.cell(7, 7)).toBe(40);
    expect(feed.tileSeq(0)).toBe(13);
    // The next segment covers 13 too; it applies.
    bucket.putSegment({ from: 12, to: 14, diffs: [{ index: index(7, 7), cell: 41, shield: 0 }] });
    bucket.setManifest(
      manifest(
        14,
        [13, 0, 0, 0],
        [
          [10, 12],
          [12, 14],
        ],
      ),
    );
    await tick();
    expect(store.cell(7, 7)).toBe(41);
  });

  it('follows new manifests with segments only, then reloads tiles across a resync', async () => {
    const bucket = new Bucket();
    const g = grid();
    g.cells[index(1, 1)] = 1;
    bucket.putTile(g, 0, 0, 2);
    bucket.setManifest(manifest(2, [2, 0, 0, 0], []));
    const { feed, store, tick } = feedOn(bucket);
    feed.start();
    await settle();
    expect(store.cell(1, 1)).toBe(1);

    bucket.putSegment({ from: 2, to: 4, diffs: [{ index: index(2, 1), cell: 2, shield: 0 }] });
    bucket.setManifest(manifest(4, [2, 0, 0, 0], [[2, 4]]));
    bucket.reads.length = 0;
    await tick();
    expect(store.cell(2, 1)).toBe(2);
    expect(bucket.objectReads()).toEqual([`${BASE}/diffs/2-4.bin.gz`]);

    // A resync: seqs 5..20 skipped, every tile republished at 20; one more segment after.
    g.cells[index(2, 1)] = 2;
    g.cells[index(9, 9)] = 9;
    g.cells[index(300, 300)] = 3;
    for (const [tx, ty] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      bucket.putTile(g, tx, ty, 20);
    }
    bucket.putSegment({ from: 20, to: 21, diffs: [{ index: index(9, 10), cell: 5, shield: 0 }] });
    bucket.setManifest(manifest(21, [20, 20, 20, 20], [[20, 21]]));
    bucket.reads.length = 0;
    await tick();
    expect(store.cell(9, 9)).toBe(9);
    expect(store.cell(300, 300)).toBe(3);
    expect(store.cell(9, 10)).toBe(5);
    expect(bucket.objectReads().sort()).toEqual(
      [
        `${BASE}/diffs/20-21.bin.gz`,
        `${BASE}/tiles/0-0/20.bin.gz`,
        `${BASE}/tiles/0-1/20.bin.gz`,
        `${BASE}/tiles/1-0/20.bin.gz`,
        `${BASE}/tiles/1-1/20.bin.gz`,
      ].sort(),
    );
  });

  it('ignores a manifest older than the one it follows', async () => {
    const bucket = new Bucket();
    bucket.putSegment({ from: 0, to: 5, diffs: [{ index: index(1, 1), cell: 7, shield: 0 }] });
    bucket.setManifest(manifest(5, [0, 0, 0, 0], [[0, 5]]));
    const { feed, store, tick } = feedOn(bucket);
    feed.start();
    await settle();
    // Another edge still serves the manifest from a second ago.
    bucket.setManifest(manifest(3, [0, 0, 0, 0], [[0, 3]]));
    await tick();
    expect(feed.seq).toBe(5);
    expect(store.cell(1, 1)).toBe(7);
  });

  it('passes on the stats of the manifest it follows, at every read (ADR 0033)', async () => {
    const bucket = new Bucket();
    // A canvas that predates stats: nothing to pass on.
    bucket.setManifest(manifest(0, [0, 0, 0, 0], []));
    const { feed, stats, tick } = feedOn(bucket);
    feed.start();
    await settle();
    expect(stats).toEqual([]);
    const counts = (playing: number, at: number) =>
      ({ at, playing, phase: 'settling', filled: 0, rates: DEFAULT_ITEM_CONFIG.rates }) as const;
    bucket.setManifest(manifest(1, [0, 0, 0, 0], [], { stats: counts(4, 10) }));
    await tick();
    // Each read passes them on, unchanged or not: LiveStats judges their `at`.
    await tick();
    expect(stats).toEqual([counts(4, 10), counts(4, 10)]);
    // A manifest of a lower seq from another edge: the newer one's stats stand.
    bucket.setManifest(manifest(0, [0, 0, 0, 0], [], { stats: counts(9, 20) }));
    await tick();
    expect(stats.at(-1)).toEqual(counts(4, 10));
  });

  it('carries on from a socket grid it adopts, without reloading tiles', async () => {
    const bucket = new Bucket();
    const store = new MapStore(SIZE);
    // The socket's grid at seq 30, already in the store.
    store.applyDiffs([{ index: index(1, 1), cell: 8, shield: 0 }]);
    const { feed, tick } = feedOn(bucket, store);
    feed.adopt(30);
    // The CDN is behind the socket: nothing to do yet.
    bucket.setManifest(
      manifest(
        29,
        [25, 25, 0, 0],
        [
          [25, 27],
          [27, 29],
        ],
      ),
    );
    feed.start();
    await settle();
    expect(bucket.objectReads()).toEqual([]);
    expect(store.cell(1, 1)).toBe(8);
    // Then it moves past the socket's seq.
    bucket.putSegment({ from: 29, to: 31, diffs: [{ index: index(2, 2), cell: 6, shield: 0 }] });
    bucket.setManifest(
      manifest(
        31,
        [25, 25, 0, 0],
        [
          [25, 27],
          [27, 29],
          [29, 31],
        ],
      ),
    );
    await tick();
    expect(bucket.objectReads()).toEqual([`${BASE}/diffs/29-31.bin.gz`]);
    expect(store.cell(2, 2)).toBe(6);
    expect(store.cell(1, 1)).toBe(8);
  });

  it('loads tiles in view first, the rest after', async () => {
    const bucket = new Bucket();
    const g = grid();
    for (const [tx, ty] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      bucket.putTile(g, tx, ty, 3);
    }
    bucket.setManifest(manifest(3, [3, 3, 3, 3], []));
    const { feed } = feedOn(bucket);
    feed.want([3]);
    feed.start();
    await settle();
    expect(bucket.objectReads()[0]).toBe(`${BASE}/tiles/1-1/3.bin.gz`);
    expect(bucket.objectReads()).toHaveLength(4);
  });

  it('backs off after failures and while hidden', async () => {
    const bucket = new Bucket();
    bucket.setManifest(manifest(1, [0, 0, 0, 0], []));
    bucket.failManifest = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { feed, tick, pending, statuses } = feedOn(bucket);
    feed.start();
    await settle();
    expect(statuses).toEqual([false]);
    expect(pending().map((t) => t.ms)).toEqual([2 * POLL_MS]);
    await tick();
    expect(pending().map((t) => t.ms)).toEqual([4 * POLL_MS]);
    bucket.failManifest = false;
    await tick();
    expect(statuses.at(-1)).toBe(true);
    expect(pending().map((t) => t.ms)).toEqual([POLL_MS]);
    feed.setHidden(true);
    await tick();
    await tick();
    await tick();
    expect(pending().map((t) => t.ms)).toEqual([4 * POLL_MS]);
    // Shown again: reads at once, then the normal pace.
    feed.setHidden(false);
    await settle();
    expect(pending().map((t) => t.ms)).toEqual([POLL_MS]);
  });

  it('stops for good on a map of another size', async () => {
    const bucket = new Bucket();
    bucket.setManifest(manifest(1, [0], [], { size: 256 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { feed, pending, rules } = feedOn(bucket);
    feed.start();
    await settle();
    expect(feed.isRunning).toBe(false);
    expect(pending()).toEqual([]);
    expect(rules).toEqual([]);
  });

  it('drops what a stopped feed was fetching', async () => {
    const bucket = new Bucket();
    const g = grid();
    g.cells[index(1, 1)] = 5;
    bucket.putTile(g, 0, 0, 2);
    bucket.setManifest(manifest(2, [2, 0, 0, 0], []));
    const { feed, store } = feedOn(bucket);
    feed.start();
    feed.stop();
    await settle();
    expect(store.cell(1, 1)).toBe(0);
  });

  /** A feed whose read of tile 0-0 is held open after the manifest arrived. */
  async function heldTileFeed() {
    const bucket = new Bucket();
    const g = grid();
    g.cells[index(1, 1)] = 5;
    bucket.putTile(g, 0, 0, 2);
    // No segments: the held tile is the sync's last read, so only the check after the reads
    // can keep its result out of the store.
    bucket.setManifest(manifest(2, [2, 0, 0, 0], []));
    const url = `${BASE}/tiles/0-0/2.bin.gz`;
    const release = bucket.hold(url);
    const fed = feedOn(bucket);
    fed.feed.start();
    await settle();
    expect(bucket.reads).toContain(url);
    expect(fed.store.cell(1, 1)).toBe(0);
    return { ...fed, bucket, release, signal: bucket.signals.get(url)! };
  }

  it('applies nothing a sync fetched after the feed stopped, and aborts its reads', async () => {
    const { feed, store, release, signal, pending } = await heldTileFeed();
    feed.stop();
    expect(signal.aborted).toBe(true);
    release();
    await settle();
    expect(store.cell(1, 1)).toBe(0);
    expect([0, 1, 2, 3].map((t) => feed.tileSeq(t))).toEqual([-1, -1, -1, -1]);
    expect(pending()).toEqual([]);
  });

  it('applies nothing a sync fetched before an adopt, and keeps polling', async () => {
    const { feed, store, release, signal, pending, bucket } = await heldTileFeed();
    // The store now holds a socket's grid at seq 7.
    store.applyDiffs([{ index: index(2, 2), cell: 9, shield: 0 }]);
    bucket.reads.length = 0;
    feed.adopt(7);
    expect(signal.aborted).toBe(true);
    release();
    await settle();
    expect(store.cell(1, 1)).toBe(0);
    expect(store.cell(2, 2)).toBe(9);
    expect([0, 1, 2, 3].map((t) => feed.tileSeq(t))).toEqual([7, 7, 7, 7]);
    // The manifest was read again at once, found behind seq 7, and a next poll is due.
    expect(bucket.reads).toEqual([`${BASE}/manifest.json`]);
    expect(pending().map((t) => t.ms)).toEqual([POLL_MS]);
  });

  it('gives up, and says so, when no manifest can ever be read', async () => {
    const bucket = new Bucket();
    bucket.failManifest = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { feed, tick, pending, statuses } = feedOn(bucket);
    feed.start();
    await settle();
    for (let i = 1; i < GIVE_UP_FAILURES; i++) await tick();
    expect(feed.usable).toBe(false);
    expect(feed.isRunning).toBe(false);
    expect(pending()).toEqual([]);
    expect(statuses.every((ok) => !ok)).toBe(true);
    // Started again, it stays stopped.
    feed.start();
    expect(feed.isRunning).toBe(false);
  });

  it('takes the overview instead of the tiles out of view, and draws them from it', async () => {
    const bucket = new Bucket();
    const g = grid();
    // A red block in tile 3 (bottom right), a blue cell in tile 0.
    for (let y = 300; y < 304; y++) for (let x = 300; x < 304; x++) g.cells[index(x, y)] = 0x8c;
    g.cells[index(10, 10)] = encodeCell(9, false, false);
    for (const [tx, ty] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      bucket.putTile(g, tx, ty, 3);
    }
    const factor = 4;
    bucket.objects.set(`${BASE}/overview/3.bin.gz`, encodeOverview(g, factor, 3));
    bucket.setManifest(manifest(3, [3, 3, 3, 3], [], { overview: { factor, version: 3 } }));
    const { feed, store, tick } = feedOn(bucket);
    feed.want([0]);
    feed.start();
    await settle();
    // The overview, then the one tile in view: nothing else.
    expect(bucket.objectReads()).toEqual([
      `${BASE}/overview/3.bin.gz`,
      `${BASE}/tiles/0-0/3.bin.gz`,
    ]);
    expect(store.overview?.seq).toBe(3);
    expect(store.isHeld(0)).toBe(true);
    expect(store.isHeld(3)).toBe(false);
    // Tile 3 is drawn from the overview as its cells would draw it (whole blocks of a colour).
    const side = TILE_SIZE / factor;
    const fromOverview = new Uint8Array(side * side * 4);
    drawMinimapTile(store, 3, factor, OPEN, fromOverview, side, { atOrigin: true });
    const real = new MapStore(SIZE);
    const cells = encodeTile(g, 1, 1, TILE_SIZE, 3).subarray(16, 16 + TILE_SIZE * TILE_SIZE);
    real.setTile(3, cells.slice(), new Uint8Array(TILE_SIZE * TILE_SIZE), false);
    const fromCells = new Uint8Array(side * side * 4);
    drawMinimapTile(real, 3, factor, OPEN, fromCells, side, { atOrigin: true });
    expect([...fromOverview]).toEqual([...fromCells]);
    expect(fromOverview.some((v, i) => i % 4 !== 3 && v !== 255)).toBe(true);
    // Zoomed far out the page wants no tile: a new manifest brings only its overview and the
    // segment the held tile needs.
    feed.want([]);
    bucket.reads.length = 0;
    bucket.objects.set(`${BASE}/overview/4.bin.gz`, encodeOverview(g, factor, 4));
    bucket.putSegment({ from: 3, to: 4, diffs: [] });
    bucket.setManifest(manifest(4, [4, 4, 4, 4], [[3, 4]], { overview: { factor, version: 4 } }));
    await tick();
    expect(bucket.objectReads()).toEqual([`${BASE}/overview/4.bin.gz`, `${BASE}/diffs/3-4.bin.gz`]);
    expect(store.overview?.seq).toBe(4);
  });

  it('draws a tile it dropped past a gap from the newer overview, not its stale cells', async () => {
    const bucket = new Bucket();
    const g = grid();
    for (const [tx, ty] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      bucket.putTile(g, tx, ty, 3);
    }
    const factor = 4;
    bucket.objects.set(`${BASE}/overview/3.bin.gz`, encodeOverview(g, factor, 3));
    bucket.setManifest(manifest(3, [3, 3, 3, 3], [], { overview: { factor, version: 3 } }));
    const { feed, store, tick } = feedOn(bucket);
    feed.want([0]);
    feed.start();
    await settle();
    expect(store.isHeld(0)).toBe(true);
    // Later: a red block in tile 0, tiles republished at 9, and the segments retired (a gap
    // after 3). Zoomed far out, the page wants no tile.
    const later = grid();
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) later.cells[index(x, y)] = 0x8c;
    bucket.objects.set(`${BASE}/overview/9.bin.gz`, encodeOverview(later, factor, 9));
    bucket.setManifest(manifest(9, [9, 9, 9, 9], [[7, 9]], { overview: { factor, version: 9 } }));
    feed.want([]);
    await tick();
    expect(feed.tileSeq(0)).toBe(-1);
    expect(store.isHeld(0)).toBe(false);
    expect(store.overview?.seq).toBe(9);
    // The minimap shows the block from the overview, as the new cells would.
    const side = TILE_SIZE / factor;
    const drawn = new Uint8Array(side * side * 4);
    drawMinimapTile(store, 0, factor, OPEN, drawn, side, { atOrigin: true });
    const truth = new MapStore(SIZE);
    const cells = encodeTile(later, 0, 0, TILE_SIZE, 9).subarray(16, 16 + TILE_SIZE * TILE_SIZE);
    truth.setTile(0, cells.slice(), new Uint8Array(TILE_SIZE * TILE_SIZE), false);
    const expected = new Uint8Array(side * side * 4);
    drawMinimapTile(truth, 0, factor, OPEN, expected, side, { atOrigin: true });
    expect([...drawn]).toEqual([...expected]);
  });

  it('loads every tile as before when the manifest lists no overview, or it cannot be read', async () => {
    const bucket = new Bucket();
    const g = grid();
    for (const [tx, ty] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      bucket.putTile(g, tx, ty, 3);
    }
    // Listed, but missing from the bucket.
    bucket.setManifest(manifest(3, [3, 3, 3, 3], [], { overview: { factor: 4, version: 3 } }));
    const { feed, store } = feedOn(bucket);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    feed.want([0]);
    feed.start();
    await settle();
    expect(bucket.objectReads()).toHaveLength(5);
    expect(store.overview).toBeNull();
    expect([0, 1, 2, 3].every((t) => store.isHeld(t))).toBe(true);
  });

  it('loads only the tiles in view while limited to the view', async () => {
    const bucket = new Bucket();
    const g = grid();
    for (const [tx, ty] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      bucket.putTile(g, tx, ty, 3);
    }
    bucket.setManifest(manifest(3, [3, 3, 3, 3], []));
    const { feed } = feedOn(bucket);
    feed.setViewOnly(true);
    feed.want([2]);
    feed.start();
    await settle();
    expect(bucket.objectReads()).toEqual([`${BASE}/tiles/0-1/3.bin.gz`]);
    expect(feed.tileSeq(0)).toBe(-1);
    // Lifting the limit loads the rest.
    feed.setViewOnly(false);
    await settle();
    expect(bucket.objectReads()).toHaveLength(4);
  });

  it('reads gzipped objects through fetch, without cookies', async () => {
    const g = grid();
    g.cells[index(2, 2)] = 4;
    const gzip = async (bytes: Uint8Array) =>
      new Uint8Array(
        await new Response(
          new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream('gzip')),
        ).arrayBuffer(),
      );
    const tile = await gzip(encodeTile(g, 0, 0, TILE_SIZE, 1));
    const credentials: (RequestCredentials | undefined)[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      credentials.push(init?.credentials);
      if (url.endsWith('manifest.json')) {
        return new Response(JSON.stringify(manifest(1, [1, 0, 0, 0], [])));
      }
      if (url === `${BASE}/tiles/0-0/1.bin.gz`) return new Response(tile);
      return new Response('missing', { status: 404 });
    });
    const store = new MapStore(SIZE);
    const feed = new CdnFeed(
      BASE,
      store,
      { rules: () => {} },
      { fetchText, fetchGzip, setTimer: () => 0 },
    );
    feed.start();
    await vi.waitFor(() => expect(store.cell(2, 2)).toBe(4));
    expect(credentials).toEqual(['omit', 'omit']);
    feed.stop();
    vi.unstubAllGlobals();
  });
});

describe('CdnFeed spreading changes', () => {
  /**
   * A feed showing tile 0 at seq 4: loaded at version 2 with cell (1, 1) = 1, plus a segment
   * 2..4 drawn with it. Then a manifest at 6 brings `next` (in tile 0) as one segment.
   */
  async function shown(next: { index: number; cell: number; shield: number }[]) {
    const bucket = new Bucket();
    const g = grid();
    g.cells[index(1, 1)] = 1;
    bucket.putTile(g, 0, 0, 2);
    bucket.putSegment({ from: 2, to: 4, diffs: [{ index: index(2, 1), cell: 2, shield: 0 }] });
    bucket.setManifest(manifest(4, [2, 0, 0, 0], [[2, 4]]));
    const fed = feedOn(bucket, new MapStore(SIZE), TEST_SPREAD_MS);
    fed.feed.want([0]);
    fed.feed.start();
    await settle();
    bucket.putSegment({ from: 4, to: 6, diffs: next });
    bucket.setManifest(
      manifest(
        6,
        [2, 0, 0, 0],
        [
          [2, 4],
          [4, 6],
        ],
      ),
    );
    return { ...fed, bucket, g };
  }

  const four = [
    { index: index(1, 1), cell: 3, shield: 0 },
    { index: index(3, 1), cell: 4, shield: 0 },
    { index: index(4, 1), cell: 5, shield: 0 },
    { index: index(5, 1), cell: 6, shield: 1 },
  ];
  const cellsOf = (store: MapStore) => [1, 3, 4, 5].map((x) => store.cell(x, 1));

  it('draws a tile it loads at once, with its segments', async () => {
    const { store, spread } = await shown(four);
    expect([store.cell(1, 1), store.cell(2, 1)]).toEqual([1, 2]);
    expect(spread).toEqual([]);
  });

  it('spreads the changes to a tile already shown over the interval, and says what they replaced', async () => {
    const { feed, store, tick, advance, spread } = await shown(four);
    await tick();
    // Counted as there, but not drawn yet.
    expect(feed.tileSeq(0)).toBe(6);
    expect(cellsOf(store)).toEqual([1, 0, 0, 0]);
    advance(TEST_SPREAD_MS / 4);
    expect(cellsOf(store).filter((c, i) => c !== [1, 0, 0, 0][i])).toHaveLength(1);
    advance(TEST_SPREAD_MS / 2);
    expect(cellsOf(store).filter((c, i) => c !== [1, 0, 0, 0][i])).toHaveLength(3);
    advance(TEST_SPREAD_MS / 4);
    expect(cellsOf(store)).toEqual([3, 4, 5, 6]);
    expect(store.shield(5, 1)).toBe(1);
    const reported = spread.flat().sort((a, b) => a.index - b.index);
    expect(reported).toEqual([
      { index: index(1, 1), before: 1 },
      { index: index(3, 1), before: 0 },
      { index: index(4, 1), before: 0 },
      { index: index(5, 1), before: 0 },
    ]);
  });

  it('vouches for a resume only from the seq the store surely holds (ADR 0040)', async () => {
    const { feed, tick, advance } = await shown(four);
    const before = feed.heldSeq();
    expect(before).not.toBeNull();
    await tick();
    // Tile 0 counts as at 6, but its changes still spread: a socket must resume from before.
    expect(feed.tileSeq(0)).toBe(6);
    expect(feed.heldSeq()).toBe(before);
    advance(TEST_SPREAD_MS);
    expect(feed.heldSeq()).toBe(Math.min(...[0, 1, 2, 3].map((t) => feed.tileSeq(t))));
  });

  it('draws what waits at once when the page is hidden, and spreads nothing while hidden', async () => {
    const { feed, store, tick, bucket } = await shown(four);
    await tick();
    feed.setHidden(true);
    expect(cellsOf(store)).toEqual([3, 4, 5, 6]);
    bucket.putSegment({ from: 6, to: 7, diffs: [{ index: index(6, 1), cell: 7, shield: 0 }] });
    bucket.setManifest(
      manifest(
        7,
        [2, 0, 0, 0],
        [
          [2, 4],
          [4, 6],
          [6, 7],
        ],
      ),
    );
    await tick();
    expect(store.cell(6, 1)).toBe(7);
  });

  it('draws a burst past MAX_SPREAD at once, after what still waited', async () => {
    const burst = Array.from({ length: MAX_SPREAD + 1 }, (_, i) => ({
      index: index(i % TILE_SIZE, 10 + Math.floor(i / TILE_SIZE)),
      cell: 9,
      shield: 0,
    }));
    const { store, tick } = await shown(burst);
    await tick();
    expect(store.cell(0, 10)).toBe(9);
    const last = burst.at(-1)!.index;
    expect(store.cell(last % SIZE, Math.floor(last / SIZE))).toBe(9);
  });

  it('on stop, drops what still waits and goes back to the seq drawn, so a restart brings it again', async () => {
    const { feed, store, tick, advance } = await shown(four);
    await tick();
    advance(TEST_SPREAD_MS / 4);
    feed.stop();
    advance(TEST_SPREAD_MS);
    // Only the one change drawn before the stop.
    expect(cellsOf(store).filter((c, i) => c !== [1, 0, 0, 0][i])).toHaveLength(1);
    expect(feed.tileSeq(0)).toBe(4);
    feed.start();
    await settle();
    advance(TEST_SPREAD_MS);
    expect(cellsOf(store)).toEqual([3, 4, 5, 6]);
  });

  /** Publishes seq 7 with one more segment 6..7 (cells in tile 0). */
  function publish7(bucket: Bucket, diffs: { index: number; cell: number; shield: number }[]) {
    bucket.putSegment({ from: 6, to: 7, diffs });
    bucket.setManifest(
      manifest(
        7,
        [2, 0, 0, 0],
        [
          [2, 4],
          [4, 6],
          [6, 7],
        ],
      ),
    );
  }

  it('draws a newer value at once over an older one still waiting, never under it', async () => {
    for (const how of ['hidden', 'burst', 'out of view'] as const) {
      const { feed, store, tick, advance, bucket } = await shown(four);
      await tick();
      // (3, 1) waits with 4; seq 7 sets it to 10.
      const newer = [{ index: index(3, 1), cell: 10, shield: 0 }];
      if (how === 'burst') {
        for (let i = 0; i <= MAX_SPREAD; i++) {
          newer.push({
            index: index(i % TILE_SIZE, 10 + Math.floor(i / TILE_SIZE)),
            cell: 9,
            shield: 0,
          });
        }
        newer.sort((a, b) => a.index - b.index);
      }
      publish7(bucket, newer);
      if (how === 'hidden') feed.setHidden(true);
      if (how === 'out of view') feed.want([]);
      await tick();
      expect(store.cell(3, 1), how).toBe(10);
      advance(TEST_SPREAD_MS);
      expect(store.cell(3, 1), how).toBe(10);
      // The other waiting changes were drawn too, nothing lost.
      expect(cellsOf(store), how).toEqual([3, 10, 5, 6]);
    }
  });

  it('draws changes to tiles out of view at once', async () => {
    const { feed, store, tick, spread } = await shown(four);
    feed.want([]);
    await tick();
    expect(cellsOf(store)).toEqual([3, 4, 5, 6]);
    expect(spread).toEqual([]);
  });

  it('spreads nothing while turned off, and draws what waited when turned off', async () => {
    const { feed, store, tick, bucket } = await shown(four);
    await tick();
    feed.setSpreading(false);
    expect(cellsOf(store)).toEqual([3, 4, 5, 6]);
    publish7(bucket, [{ index: index(6, 1), cell: 7, shield: 0 }]);
    await tick();
    expect(store.cell(6, 1)).toBe(7);
  });

  it('draws the cells of one brick in one step', async () => {
    // A brick over (10, 1), (11, 1) and (11, 2): linked right, then down.
    const brick = [
      { index: index(10, 1), cell: encodeCell(3, true, false), shield: 0 },
      { index: index(11, 1), cell: encodeCell(3, false, true), shield: 0 },
      { index: index(11, 2), cell: encodeCell(3, false, false), shield: 0 },
    ];
    const { store, tick, advance } = await shown(
      [...four, ...brick].sort((a, b) => a.index - b.index),
    );
    await tick();
    const drawn = () =>
      brick.filter(({ index: i }) => store.cell(i % SIZE, Math.floor(i / SIZE)) !== 0);
    for (let step = 0; step < 5; step++) {
      advance(TEST_SPREAD_MS / 5);
      expect([0, 3]).toContain(drawn().length);
    }
    expect(drawn()).toHaveLength(3);
  });

  it('on adopt, never draws over the store what waited', async () => {
    const { feed, store, tick, advance } = await shown(four);
    await tick();
    // A socket's grid at seq 9 replaced the store: cell (3, 1) is 8 there.
    store.applyDiffs([{ index: index(3, 1), cell: 8, shield: 0 }]);
    feed.adopt(9);
    advance(TEST_SPREAD_MS);
    expect(store.cell(3, 1)).toBe(8);
    expect(feed.tileSeq(0)).toBe(9);
  });

  it('forgets what waits for a tile it reloads across a gap', async () => {
    const { store, tick, advance, bucket, g } = await shown(four);
    await tick();
    // A resync: tile 0 republished at 20, where cell (3, 1) is empty again.
    g.cells[index(1, 1)] = 3;
    bucket.putTile(g, 0, 0, 20);
    bucket.setManifest(manifest(20, [20, 0, 0, 0], []));
    await tick();
    expect(store.cell(1, 1)).toBe(3);
    advance(TEST_SPREAD_MS);
    expect(store.cell(3, 1)).toBe(0);
  });
});
