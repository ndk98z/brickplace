import type { State } from '@brickplace/core';
import { describe, expect, it } from 'vitest';
import {
  MAX_SHARD_BACKOFF,
  mergeAll,
  PUSH_MS,
  RECORD_BYTES,
  SHARD_GIVE_UP_MS,
  SHARD_SLOW_RETRY_MS,
  type TickPush,
  TickPusher,
  type TickReply,
} from '../src/push.ts';

// TickPusher on its own (ADR 0028): limits, backoff, cursors, with a fake clock, fake timers,
// fake storage and sends the test answers itself.

interface Sent {
  readonly shard: string;
  readonly push: TickPush<string>;
  resolve(reply: TickReply): void;
  reject(error: unknown): void;
}

function harness(options: { rows?: { name: string; acked: number | null }[]; seq?: number } = {}) {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const sent: Sent[] = [];
  const writes: unknown[][] = [];
  const size = 64;
  const grid = { cells: new Uint8Array(size * size), shields: new Uint8Array(size * size) };
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      if (query.startsWith('SELECT')) return options.rows ?? [];
      writes.push([query, ...args]);
      return [];
    },
  } as unknown as SqlStorage;
  const pusher = new TickPusher<string>(sql, options.seq ?? 0, {
    send: (shard, push) =>
      new Promise<TickReply>((resolve, reject) => sent.push({ shard, push, resolve, reject })),
    grid: () => grid as unknown as State,
    rules: () => 'rules',
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  });
  pusher.pushMs = Number.POSITIVE_INFINITY;
  let seq = options.seq ?? 0;
  /** One op changing these cells, as the next log row. */
  const op = (...cells: number[]) => {
    seq++;
    for (const c of cells) grid.cells[c] = (grid.cells[c]! % 200) + 1;
    pusher.note(
      cells.map((index) => ({ index, cell: grid.cells[index]!, shield: 0 })),
      seq,
    );
  };
  /** Moves the clock, firing due timers (timeouts and the like). */
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
    await settle();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Answers every push in flight as delivered (or with `sockets`). */
  const answerAll = async (sockets = 1) => {
    for (const s of sent.splice(0)) s.resolve({ seq: s.push.to, sockets });
    await settle();
  };
  return { pusher, sent, writes, op, advance, settle, answerAll, grid, now: () => now };
}

const cellsOf = (records: Uint8Array | null) => {
  if (records === null) return null;
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  const out: number[] = [];
  for (let at = 0; at < records.byteLength; at += RECORD_BYTES) out.push(view.getUint32(at, true));
  return out;
};

describe('TickPusher', () => {
  it('merges sorted cell lists without repeats', () => {
    const lists = [Uint32Array.of(1, 4, 9), Uint32Array.of(2, 4), Uint32Array.of(9, 10)];
    expect([...mergeAll(lists)]).toEqual([1, 2, 4, 9, 10]);
    expect([...mergeAll([])]).toEqual([]);
  });

  it('cuts the first change after a quiet spell at once, then at most one tick per interval', async () => {
    const h = harness();
    h.pusher.pushMs = PUSH_MS;
    h.pusher.follow('a', null, 0);
    // Two changes in the same turn share the tick, which leaves at once.
    h.op(1);
    h.op(2);
    expect(h.sent).toHaveLength(0);
    await h.advance(0);
    expect(h.sent.map((s) => cellsOf(s.push.records))).toEqual([[1, 2]]);
    await h.answerAll();
    // Within PUSH_MS of that tick, a change waits for the rest of the interval.
    await h.advance(100);
    h.op(3);
    await h.advance(PUSH_MS - 101);
    expect(h.sent).toHaveLength(0);
    await h.advance(1);
    expect(h.sent.map((s) => cellsOf(s.push.records))).toEqual([[3]]);
    await h.answerAll();
    // Quiet for longer than PUSH_MS: the next change leaves at once again.
    await h.advance(PUSH_MS);
    h.op(4);
    await h.advance(0);
    expect(h.sent.map((s) => cellsOf(s.push.records))).toEqual([[4]]);
  });

  it('waits out the interval for a shard a pump left behind for a limit', async () => {
    const h = harness();
    h.pusher.pushMs = PUSH_MS;
    h.pusher.maxInFlight = 1;
    h.pusher.follow('a', null, 0);
    h.pusher.follow('b', null, 0);
    h.op(1);
    await h.advance(0);
    expect(h.sent).toHaveLength(1);
    const first = h.sent[0]!.shard;
    await h.answerAll();
    // The other shard is still behind, but the next pump is PUSH_MS after the last one.
    await h.advance(PUSH_MS - 1);
    expect(h.sent).toHaveLength(0);
    await h.advance(1);
    expect(h.sent.map((s) => s.shard)).toEqual([first === 'a' ? 'b' : 'a']);
  });

  it('pumps for a reply that leaves its shard behind no sooner than PUSH_MS after the last pump', async () => {
    const h = harness();
    h.pusher.pushMs = PUSH_MS;
    h.pusher.follow('a', null, 0);
    h.op(1);
    await h.advance(0);
    // Answered within the interval with less than it was sent: it waits for the interval.
    await h.advance(100);
    h.sent.splice(0)[0]!.resolve({ seq: 0, sockets: 1 });
    await h.settle();
    await h.advance(PUSH_MS - 101);
    expect(h.sent).toHaveLength(0);
    await h.advance(1);
    expect(h.sent).toHaveLength(1);
    // Answered the same way well after the interval: it goes at once.
    await h.advance(2 * PUSH_MS);
    h.sent.splice(0)[0]!.resolve({ seq: 0, sockets: 1 });
    await h.settle();
    await h.advance(0);
    expect(h.sent).toHaveLength(1);
  });

  it('never pumps more often than once per PUSH_MS under a steady stream of changes', async () => {
    const h = harness();
    h.pusher.pushMs = PUSH_MS;
    h.pusher.follow('a', null, 0);
    const pumps: number[] = [];
    // About 165 real timer turns in all: kept small for CI's slow runner.
    for (let t = 0; t < 3000; t += 20) {
      h.op((t / 20) % 64);
      await h.advance(20);
      if (h.sent.length > 0) {
        pumps.push(h.now());
        await h.answerAll();
      }
    }
    for (let i = 1; i < pumps.length; i++) {
      expect(pumps[i]! - pumps[i - 1]!, `pump ${i}`).toBeGreaterThanOrEqual(PUSH_MS);
    }
    expect(pumps.length).toBeGreaterThan(5);
    expect(pumps.length).toBeLessThanOrEqual(3000 / PUSH_MS + 1);
  });

  it('pushes new rules and stored shards at once after a quiet spell', async () => {
    const h = harness({ rows: [{ name: 'stored', acked: null }] });
    h.pusher.pushMs = PUSH_MS;
    // A restarted canvas: the stored shard's cursor is unknown, so it gets a push at once.
    h.pusher.start();
    await h.advance(0);
    expect(h.sent.map((s) => [s.shard, s.push.known])).toEqual([['stored', false]]);
    await h.answerAll();
    await h.advance(PUSH_MS);
    h.pusher.rulesChanged();
    await h.advance(0);
    expect(h.sent.map((s) => s.shard)).toEqual(['stored']);
  });

  it('serves a lagging shard from the ring, then tells it to resync once the ring is past it', async () => {
    const h = harness();
    h.pusher.ringTicks = 2;
    h.pusher.follow('a', null, 0);
    h.pusher.follow('b', null, 0);
    h.op(1);
    h.pusher.pump();
    // b fails: it keeps its cursor (0) and backs off.
    for (const s of h.sent.splice(0)) {
      if (s.shard === 'a') s.resolve({ seq: s.push.to, sockets: 1 });
      else s.reject(new Error('down'));
    }
    await h.settle();
    h.op(2);
    h.pusher.pump();
    await h.answerAll();
    await h.advance(MAX_SHARD_BACKOFF);
    h.pusher.pump();
    // The ring holds ticks 0..1 and 1..2: b's cursor (0) is its start, so b gets both cells.
    const caughtUp = h.sent.find((s) => s.shard === 'b')!;
    expect(caughtUp.push.from).toBe(0);
    expect(cellsOf(caughtUp.push.records)).toEqual([1, 2]);
    caughtUp.reject(new Error('down again'));
    await h.settle();
    h.op(3);
    h.pusher.pump();
    await h.answerAll();
    // Two more ticks: the ring (two ticks) now starts at 1, past b's cursor.
    h.op(4);
    h.pusher.pump();
    await h.answerAll();
    await h.advance(MAX_SHARD_BACKOFF);
    h.pusher.pump();
    const resync = h.sent.find((s) => s.shard === 'b')!;
    expect(resync.push).toMatchObject({ from: 0, known: true, records: null, to: 4 });
  });

  it('backs a failing shard off, never past 30 s, then tries hourly but never forgets it', async () => {
    const h = harness();
    h.pusher.follow('down', null, 0);
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      h.op(i);
      h.pusher.pump();
      const s = h.sent.splice(0);
      expect(s).toHaveLength(1);
      s[0]!.reject(new Error('down'));
      await h.settle();
      const retryAt = (
        h.pusher as unknown as { shards: Map<string, { retryAt: number }> }
      ).shards.get('down')!.retryAt;
      waits.push(retryAt - h.now());
      await h.advance(retryAt - h.now());
    }
    expect(waits.slice(0, 3)).toEqual([500, 1000, 2000]);
    expect(Math.max(...waits)).toBe(MAX_SHARD_BACKOFF);
    // Failing for a day: still followed (it may have sockets that need the changes once it
    // is back), now tried hourly.
    await h.advance(SHARD_GIVE_UP_MS);
    h.op(100);
    h.pusher.pump();
    h.sent.splice(0)[0]!.reject(new Error('still down'));
    await h.settle();
    expect(h.pusher.following).toEqual(['down']);
    const shards = (h.pusher as unknown as { shards: Map<string, { retryAt: number }> }).shards;
    expect(shards.get('down')!.retryAt - h.now()).toBe(SHARD_SLOW_RETRY_MS);
    // Back: it gets every change it missed in one push.
    await h.advance(SHARD_SLOW_RETRY_MS);
    h.pusher.pump();
    const back = h.sent.splice(0)[0]!;
    expect(back.push.known).toBe(true);
    expect(cellsOf(back.push.records)?.length).toBeGreaterThan(10);
  });

  it('keeps a following shard at the seq its sockets are known to have (lost follow replies)', async () => {
    const h = harness();
    h.pusher.follow('a', null, 0);
    h.op(1);
    h.pusher.pump();
    await h.answerAll();
    h.op(2);
    // Evicted with open sockets at seq 1: it follows from there. The reply (the snapshot at
    // seq 2) may be lost, so the canvas still counts its sockets at 1.
    expect(cellsOf(h.pusher.follow('a', 1, 3).changes)).toEqual([2]);
    h.op(3);
    h.pusher.pump();
    expect(h.sent[0]!.push).toMatchObject({ from: 1, known: true, to: 3 });
    expect(cellsOf(h.sent[0]!.push.records)).toEqual([2, 3]);
    await h.answerAll();
    // The canvas cannot say what changed (an unknown seq): nothing is known of its sockets,
    // and pushes start where its snapshot was, marked unknown.
    h.op(4);
    expect(h.pusher.follow('a', -5, 3).changes).toBeNull();
    h.op(5);
    h.pusher.pump();
    expect(h.sent[0]!.push).toMatchObject({ from: 4, known: false, to: 5 });
  });

  it('keeps at most maxInFlight pushes out, and starts each pump at another shard', async () => {
    const h = harness();
    h.pusher.maxInFlight = 2;
    for (const name of ['a', 'b', 'c', 'd', 'e']) h.pusher.follow(name, null, 0);
    h.op(1);
    h.pusher.pump();
    expect(h.sent.map((s) => s.shard)).toEqual(['a', 'b']);
    expect(h.pusher.pending.inFlight).toBe(2);
    // A push nobody answers is given up after the timeout, freeing its place.
    await h.advance(h.pusher.pushTimeoutMs);
    expect(h.pusher.pending.inFlight).toBe(0);
    h.sent.length = 0;
    h.pusher.pump();
    // The next pump starts one shard further (a and b now back off after their timeouts).
    expect(h.sent.map((s) => s.shard)).toEqual(['c', 'd']);
  });

  it('does not take an answer to a push sent before the shard followed again as its cursor', async () => {
    const h = harness();
    h.pusher.follow('a', null, 0);
    h.op(1);
    h.pusher.pump();
    const old = h.sent.splice(0)[0]!;
    h.op(2);
    // The shard lost its mirror and followed again at seq 2.
    h.pusher.follow('a', null, 0);
    old.resolve({ seq: 1, sockets: 1 });
    await h.settle();
    h.op(3);
    h.pusher.pump();
    // Its cursor is still 2: the push carries seq 3's cell only.
    expect(h.sent[0]!.push.from).toBe(2);
    expect(cellsOf(h.sent[0]!.push.records)).toEqual([3]);
  });

  it('shares records between shards of one tick and caps the bytes one pump builds', async () => {
    const h = harness();
    h.pusher.follow('a', null, 0);
    h.op(1, 2, 3);
    h.pusher.follow('b', null, 0);
    h.pusher.pump();
    await h.answerAll();
    // c at the start, d at seq 1: different ticks, different records.
    h.op(10);
    h.pusher.pump();
    await h.answerAll();
    h.pusher.maxPumpBytes = 3 * RECORD_BYTES;
    h.pusher.follow('c', null, 0);
    h.op(20, 21, 22, 23);
    h.pusher.pump();
    // a and b share one set (cursor 2); c's (cursor 2 too, rounded to its tick start).
    const froms = h.sent.map((s) => s.push.from);
    expect(new Set(froms).size).toBe(1);
    expect(h.pusher.lastPumpBytes).toBe(4 * RECORD_BYTES);
    await h.answerAll();
    // Now two shards at different cursors: only the first set fits the cap; the other waits.
    const shards = (h.pusher as unknown as { shards: Map<string, { acked: number | null }> })
      .shards;
    shards.get('a')!.acked = 1;
    shards.get('b')!.acked = 2;
    shards.get('c')!.acked = 2;
    h.pusher.pump();
    expect(h.pusher.lastPumpBytes).toBeLessThanOrEqual(8 * RECORD_BYTES);
    const first = h.sent.splice(0);
    expect(first.length).toBeLessThan(3);
    for (const s of first) s.resolve({ seq: s.push.to, sockets: 1 });
    await h.settle();
    h.pusher.pump();
    expect(h.sent.length).toBeGreaterThan(0);
  });

  it('caps the record bytes awaiting answers, and counts pushes to unknown cursors as resyncs', async () => {
    const h = harness();
    h.pusher.maxInFlightBytes = 2 * RECORD_BYTES;
    for (const name of ['a', 'b', 'c']) h.pusher.follow(name, null, 0);
    h.op(1, 2, 3);
    h.pusher.pump();
    // The first push always goes; the next would pass the cap.
    expect(h.sent).toHaveLength(1);
    await h.answerAll();
    h.pusher.pump();
    expect(h.sent).toHaveLength(1);
    await h.answerAll();
    // Unknown cursors (a shard whose follow() the canvas could not answer with changes).
    const fresh = harness();
    fresh.pusher.maxResyncs = 1;
    for (const name of ['x', 'y']) fresh.pusher.follow(name, -1, 2);
    fresh.op(1);
    fresh.pusher.pump();
    expect(fresh.sent).toHaveLength(1);
    expect(fresh.sent[0]!.push.known).toBe(false);
    expect(fresh.pusher.pending.resyncs).toBe(1);
  });

  it('refuses follow() past its rate, so a burst of shards cannot copy the grid at once', () => {
    const h = harness();
    h.pusher.maxFollowsPerSecond = 2;
    h.pusher.follow('a', null, 0);
    h.pusher.follow('b', null, 0);
    expect(() => h.pusher.follow('c', null, 0)).toThrow(/busy/);
  });

  it('lets only a few resync pushes out at once', async () => {
    const h = harness();
    h.pusher.maxResyncs = 1;
    h.pusher.maxTickCells = 1;
    for (const name of ['a', 'b', 'c']) h.pusher.follow(name, null, 0);
    h.op(1, 2);
    h.pusher.pump();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.push.records).toBeNull();
    expect(h.pusher.pending.resyncs).toBe(1);
    await h.answerAll();
    h.pusher.pump();
    expect(h.sent).toHaveLength(1);
  });

  it('marks pushes to cursors it lost as unknown, and keeps saved ones after a restart', async () => {
    const h = harness({
      seq: 5,
      rows: [
        { name: 'saved', acked: 7 },
        { name: 'lost', acked: null },
        { name: 'old', acked: 3 },
      ],
    });
    h.op(6);
    h.op(7);
    h.op(8);
    h.pusher.pump();
    const pushes = new Map(h.sent.map((s) => [s.shard, s.push]));
    expect(pushes.get('saved')).toMatchObject({ from: 5, known: true, to: 8 });
    // Lost, or older than where the ring starts: the whole ring, not taken as a cursor.
    expect(pushes.get('lost')).toMatchObject({ from: 5, known: false, to: 8 });
    expect(pushes.get('old')).toMatchObject({ from: 5, known: false });
    await h.answerAll();
    h.writes.length = 0;
    h.pusher.saveCursors();
    expect(h.writes.map((w) => w[1])).toEqual([8, 8, 8]);
    h.writes.length = 0;
    h.pusher.saveCursors();
    expect(h.writes).toEqual([]);
  });

  it('lists the cells of its newest ticks, up to a count, for a shard to seed from (ADR 0040)', () => {
    const h = harness();
    // An empty ring: nothing changed after the current seq.
    expect(h.pusher.recent(10)).toEqual({ from: 0, ticks: [] });
    h.pusher.follow('a', null, 0);
    h.op(5, 6);
    h.pusher.pump();
    // Changed and changed back within one tick: still listed.
    h.op(6, 7);
    h.op(7);
    h.pusher.pump();
    h.op(1);
    h.pusher.pump();
    // Every tick fits, each as it was cut.
    expect(h.pusher.recent(10)).toEqual({
      from: 0,
      ticks: [
        { to: 1, cells: Uint32Array.of(5, 6) },
        { to: 3, cells: Uint32Array.of(6, 7) },
        { to: 4, cells: Uint32Array.of(1) },
      ],
    });
    // Counted per tick, newest first: the last two ticks (1 + 2 cells) fit in 3, not the first.
    expect(h.pusher.recent(3)).toEqual({
      from: 1,
      ticks: [
        { to: 3, cells: Uint32Array.of(6, 7) },
        { to: 4, cells: Uint32Array.of(1) },
      ],
    });
    // Not even the newest tick fits.
    expect(h.pusher.recent(0)).toBeNull();
  });
});
