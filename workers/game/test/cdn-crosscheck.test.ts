import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { type CellDiff, type State, TILE_SIZE } from '@brickplace/core';
import { decodeOverview, encodeOverview } from '@brickplace/protocol/cdn';
import { describe, expect, it } from 'vitest';
// The spectator client, as the browser runs it (ADR 0018), against the real publisher.
import { MapStore } from '../../../apps/client/src/map/store.ts';
import { CdnFeed } from '../../../apps/client/src/net/cdn.ts';
import { gunzip } from '../src/checkpoints.ts';
import type { Env } from '../src/index.ts';
import { CdnPublisher } from '../src/publish.ts';

// Randomised cross-check of ADR 0014 against ADR 0018: the real CdnPublisher (DO SQLite and
// the local R2 bucket) runs through seeded histories of ops, segment ticks, tile cuts,
// oversized segments (resyncs) and restarts past the last segment (skipTo), while CdnFeed
// clients poll at random points. After every poll, each tile a client holds must equal the
// true grid at the seq the client says that tile is at.

const SIZE = 2 * TILE_SIZE;
const TILES = SIZE / TILE_SIZE;
const ORIGIN = 'https://tiles.test/';
const ENV = env as unknown as Env;

/** mulberry32: small, seeded, good enough to pick test actions. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every change by seq, so the true grid at any seq can be rebuilt. */
class History {
  readonly changes: { seq: number; diffs: CellDiff[] }[] = [];

  at(seq: number): { cells: Uint8Array; shields: Uint8Array } {
    const cells = new Uint8Array(SIZE * SIZE);
    const shields = new Uint8Array(SIZE * SIZE);
    for (const change of this.changes) {
      if (change.seq > seq) break;
      for (const d of change.diffs) {
        cells[d.index] = d.cell;
        shields[d.index] = d.shield;
      }
    }
    return { cells, shields };
  }
}

/** One spectator page: a CdnFeed over the local bucket, polled when the test says. */
class Client {
  readonly store = new MapStore(SIZE);
  readonly feed: CdnFeed;
  private timer: (() => void) | null = null;
  private done: (() => void) | null = null;
  failures = 0;
  /** Checks that found an overview in the store. */
  overviews = 0;

  constructor(prefix: string) {
    const object = async (url: string) => {
      const found = await ENV.TILES!.get(url.slice(ORIGIN.length));
      if (!found) throw new Error(`404 ${url}`);
      return found;
    };
    this.feed = new CdnFeed(
      `${ORIGIN}${prefix}`,
      this.store,
      { rules: () => {}, status: (ok) => void (ok || this.failures++) },
      {
        fetchText: async (url) => (await object(url)).text(),
        fetchGzip: async (url) => gunzip(new Uint8Array(await (await object(url)).arrayBuffer())),
        setTimer: (fn) => {
          this.timer = fn;
          this.done?.();
          return fn;
        },
        clearTimer: () => {
          this.timer = null;
        },
      },
    );
    this.feed.want(Array.from({ length: TILES * TILES }, (_, t) => t));
  }

  /** One poll: the manifest, then the tiles and segments it needs. */
  async poll(): Promise<void> {
    const finished = new Promise<void>((resolve) => {
      this.done = resolve;
    });
    if (!this.feed.isRunning) {
      this.feed.start();
    } else {
      const fn = this.timer!;
      this.timer = null;
      fn();
    }
    await finished;
  }

  /**
   * Every tile it holds equals the true grid at the seq it says the tile is at, and the
   * overview it holds, if any, is the true grid at its own seq, downscaled.
   */
  check(history: History, label: string): void {
    const overview = this.store.overview;
    if (overview) {
      this.overviews++;
      const truth = decodeOverview(
        encodeOverview({ cells: history.at(overview.seq).cells, size: SIZE }, overview.factor, 0),
      );
      // A byte loop: toEqual on arrays this size takes seconds.
      for (let p = 0; p < truth.colors.length; p++) {
        if (overview.colors[p] !== truth.colors[p] || overview.cover[p] !== truth.cover[p]) {
          expect.fail(`${label}: overview at ${overview.seq} differs at pixel ${p}`);
        }
      }
    }
    const truths = new Map<number, ReturnType<History['at']>>();
    for (let tile = 0; tile < TILES * TILES; tile++) {
      const seq = this.feed.tileSeq(tile);
      expect(seq, `${label}: tile ${tile} held`).toBeGreaterThanOrEqual(0);
      let truth = truths.get(seq);
      if (!truth) {
        truth = history.at(seq);
        truths.set(seq, truth);
      }
      const tx = tile % TILES;
      const ty = (tile - tx) / TILES;
      const cells = this.store.cells[tile]!;
      const shields = this.store.shields[tile]!;
      for (let y = 0; y < TILE_SIZE; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          const index = (ty * TILE_SIZE + y) * SIZE + tx * TILE_SIZE + x;
          const local = y * TILE_SIZE + x;
          if (cells[local] !== truth.cells[index] || shields[local] !== truth.shields[index]) {
            expect.fail(
              `${label}: tile ${tile} at seq ${seq}, cell (${tx * TILE_SIZE + x}, ` +
                `${ty * TILE_SIZE + y}) is ${cells[local]}/${shields[local]}, ` +
                `truth ${truth.cells[index]}/${truth.shields[index]}`,
            );
          }
        }
      }
    }
  }
}

interface RunStats {
  polls: number;
  resyncs: number;
  /** Ops that arrived while an upload was under way. */
  interleaved: number;
  /** Client checks that found an overview, checked against the true grid. */
  overviews: number;
}

async function run(seed: number, steps: number): Promise<RunStats> {
  const random = rng(seed);
  const prefix = `c/crosscheck-${seed}`;
  const stub = ENV.CANVAS.get(ENV.CANVAS.idFromName(`cdn-crosscheck-${seed}`));
  return runInDurableObject(stub, async (_, state) => {
    const sql = state.storage.sql;
    const save = (body: () => void) => state.storage.transactionSync(body);
    const cells = new Uint8Array(SIZE * SIZE);
    const shields = new Uint8Array(SIZE * SIZE);
    const grid = {
      cells,
      shields,
      config: { size: SIZE, open: { x: 0, y: 0, w: SIZE, h: SIZE }, maxShield: 5 },
    } as unknown as State;
    const history = new History();
    let seq = 0;
    let now = 1_000_000;
    let polls = 0;
    let resyncs = 0;
    let interleaved = 0;
    let overviews = 0;
    /** Set for the final catch-up: no more ops. */
    let quiet = false;
    /**
     * One accepted op: a few cells change at the next seq (now and then a burst). Most land
     * in a small hot area inside tile 0, so its cells change again and again and it gets a new
     * version on every pass, while the cold tiles keep older ones: the manifest then lists
     * segments that end before tile 0's version, and applying one to it would show an older
     * value.
     */
    const applyOp = () => {
      const count = random() < 0.05 ? 80 : 1 + Math.floor(random() * 10);
      const touched = new Map<number, CellDiff>();
      for (let i = 0; i < count; i++) {
        const hot = random() < 0.97;
        const x = hot ? 100 + Math.floor(random() * 12) : Math.floor(random() * SIZE);
        const y = hot ? 100 + Math.floor(random() * 12) : Math.floor(random() * SIZE);
        const index = y * SIZE + x;
        touched.set(index, {
          index,
          cell: Math.floor(random() * 256),
          shield: Math.floor(random() * 6),
        });
      }
      const diffs = [...touched.values()];
      seq += 1;
      for (const d of diffs) {
        cells[d.index] = d.cell;
        shields[d.index] = d.shield;
      }
      history.changes.push({ seq, diffs });
      cdn.note(diffs, seq);
    };
    // The bucket the publisher writes to: ops keep arriving while an upload is under way, as
    // they do in a CanvasDO (its input gate opens during the R2 call).
    const bucket = new Proxy(ENV.TILES!, {
      get(target, prop) {
        if (prop === 'put') {
          return async (...args: Parameters<R2Bucket['put']>) => {
            const result = await target.put(...args);
            while (!quiet && random() < 0.4) {
              applyOp();
              interleaved++;
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    // The publisher as a CanvasDO has it; a restart builds a new one on the same storage.
    const publisher = () => {
      const p = new CdnPublisher(sql, bucket, prefix, SIZE);
      // Low, so ordinary bursts of ops take the resync path too.
      p.maxDiffs = 60;
      // Short, so segments retire (with tiles still dirty) within the history.
      p.recentSegments = 4;
      return p;
    };
    let cdn = publisher();
    // A fast client, a slow one (segments retire under it), and one that joins late.
    const clients = [
      { client: new Client(prefix), rate: 0.6, from: 0 },
      { client: new Client(prefix), rate: 0.05, from: 0 },
      { client: new Client(prefix), rate: 0.3, from: Math.floor(steps / 2) },
    ];
    const manifestOut = async () => (await ENV.TILES!.head(`${prefix}/manifest.json`)) !== null;

    for (let step = 0; step < steps; step++) {
      now += Math.floor(random() * 4_000);
      const action = random();
      if (action < 0.5) {
        applyOp();
      } else if (action < 0.75) {
        // The segment tick, as CanvasDO.runTick.
        const segment = cdn.takeSegment(grid, seq);
        if (segment) {
          if (!segment.diffs) resyncs++;
          await cdn.writeSegment(segment, now, save);
        }
        if (cdn.resyncPending) await cdn.publishTiles(grid, () => seq, now, save);
        await cdn.writeManifest(grid, now, save);
      } else if (action < 0.85) {
        // The maintenance pass: tiles and the overview due, the manifest, garbage.
        await cdn.publishTiles(grid, () => seq, now, save);
        await cdn.publishOverview(grid, () => seq, now, save);
        await cdn.writeManifest(grid, now, save);
        await cdn.collect(now, save);
      } else if (action < 0.88) {
        // A restart: the checkpoint is somewhere past the last segment; rows after it replay.
        cdn = publisher();
        const checkpoint = cdn.segmentedTo + Math.floor(random() * (seq - cdn.segmentedTo + 1));
        if (cdn.segmentedTo < checkpoint) {
          resyncs++;
          cdn.skipTo(checkpoint, save);
        }
        for (const change of history.changes) {
          if (change.seq > cdn.segmentedTo) cdn.note(change.diffs, change.seq);
        }
        if (cdn.resyncPending) {
          await cdn.publishTiles(grid, () => seq, now, save);
          await cdn.writeManifest(grid, now, save);
        }
      } else if (await manifestOut()) {
        for (const [i, { client, rate, from }] of clients.entries()) {
          if (step < from || random() >= rate) continue;
          await client.poll();
          polls++;
          client.check(history, `seed ${seed} step ${step} client ${i}`);
        }
        // A new visitor: every tile loads fresh at its listed version, older segments listed
        // for other tiles included.
        const visitor = new Client(prefix);
        await visitor.poll();
        polls++;
        visitor.check(history, `seed ${seed} step ${step} new visitor`);
        overviews += visitor.overviews;
        visitor.feed.stop();
      }
    }

    // Everything published, then every client catches up to the final manifest.
    quiet = true;
    const last = cdn.takeSegment(grid, seq);
    if (last) await cdn.writeSegment(last, now, save);
    if (cdn.resyncPending) await cdn.publishTiles(grid, () => seq, now, save);
    await cdn.writeManifest(grid, now, save);
    for (const [i, { client }] of clients.entries()) {
      await client.poll();
      polls++;
      client.check(history, `seed ${seed} end client ${i}`);
      expect(client.feed.seq).toBe(seq);
      expect(client.failures, `seed ${seed} client ${i} failed reads`).toBe(0);
      client.feed.stop();
      overviews += client.overviews;
    }
    return { polls, resyncs, interleaved, overviews };
  });
}

describe('CDN publisher and spectator client, cross-checked', () => {
  it('rebuilds the true grid from tiles and segments over random histories', async () => {
    const total: RunStats = { polls: 0, resyncs: 0, interleaved: 0, overviews: 0 };
    for (const seed of [1, 2, 3]) {
      const result = await run(seed, 250);
      total.polls += result.polls;
      total.resyncs += result.resyncs;
      total.interleaved += result.interleaved;
      total.overviews += result.overviews;
    }
    // The histories did reach the paths under test.
    expect(total.polls).toBeGreaterThan(60);
    expect(total.resyncs).toBeGreaterThan(4);
    expect(total.interleaved).toBeGreaterThan(50);
    expect(total.overviews).toBeGreaterThan(20);
    // Seconds alone; a loaded full run (with the rollback suites beside it) took over 20 s.
  }, 60_000);
});
