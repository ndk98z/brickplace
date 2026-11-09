import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Item, Op } from '@brickplace/core';
import { foldNow } from '@brickplace/game/journal';
import { decodeServerMessage, encodeClientOp, type ServerMessage } from '@brickplace/protocol';
import { describe, expect, it } from 'vitest';
import { ChangeLog, RESUME_MAX_CELLS } from '../src/changes.ts';
import type { Env } from '../src/index.ts';
import { CANVAS_HEADER, PLAYER_HEADER } from '../src/player.ts';
import { WAIT_MS } from './wait.ts';

// A socket resumes from the map the page holds (ADR 0040): opened with `?since=S&canvas=C`, it
// gets a Resume frame and the cells changed after S instead of the whole map, when the
// shard's change list reaches S, a freshly loaded shard's included (seeded from the canvas).
// The map it ends with must equal the whole map, cell for cell.

const { FANOUT, CANVAS } = env as unknown as Env;
const O: Item = { kind: 'brick', shape: 1 };
const HAMMER: Item = { kind: 'hammer' };
type Diffs = Extract<ServerMessage, { type: 'diffs' }>;
const brick = (x: number, y: number): Op => ({
  kind: 'brick',
  x,
  y,
  shape: 1,
  rotation: 0,
  color: 3,
});

async function stock(canvas: string, player: string, items: readonly Item[]) {
  await runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance, state) => {
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, ?, 0, ?, 1)',
      player,
      JSON.stringify(items),
      2 ** 50,
    );
  });
}

/** A page's map: non-empty cells by index, as [cell, shield]. */
type PageMap = Map<number, readonly [number, number]>;

function apply(map: PageMap, frames: readonly ServerMessage[]): PageMap {
  for (const m of frames) {
    if (m.type !== 'diffs') continue;
    for (const d of m.diffs) {
      if (d.cell === 0 && d.shield === 0) map.delete(d.index);
      else map.set(d.index, [d.cell, d.shield]);
    }
  }
  return map;
}

async function connect(
  canvas: string,
  shard: string,
  player: string,
  held?: { since: number | string; canvas?: string },
) {
  const stub = FANOUT.get(FANOUT.idFromName(shard));
  const query = held ? `?since=${held.since}&canvas=${held.canvas ?? canvas}` : '';
  const response = await stub.fetch(`https://fanout/ws${query}`, {
    headers: { Upgrade: 'websocket', [CANVAS_HEADER]: canvas, [PLAYER_HEADER]: player },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.binaryType = 'arraybuffer';
  const frames: ServerMessage[] = [];
  ws.addEventListener('message', (event) => {
    frames.push(decodeServerMessage(new Uint8Array(event.data as ArrayBuffer)));
  });
  ws.accept();
  /** Polls (up to WAIT_MS) until `ready` holds. */
  const until = async (ready: () => boolean | Promise<boolean>) => {
    for (let waited = 0; !(await ready()); waited += 5) {
      if (waited > WAIT_MS) throw new Error(`not ready within ${WAIT_MS} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  /** The frames up to the config frame that ends the join: the grid or the resume. */
  const joined = async () => {
    await until(() => frames.some((m) => m.type === 'config'));
    return frames.slice(
      0,
      frames.findIndex((m) => m.type === 'config'),
    );
  };
  /** Sends an op and waits for its ack and, when accepted, its diffs. */
  const move = async (opId: number, op: Op) => {
    ws.send(encodeClientOp({ opId, op }));
    await until(() => frames.some((m) => m.type === 'ack' && m.opId === opId));
  };
  return { ws, stub, frames, joined, move, until };
}

const diffsOf = (frames: readonly ServerMessage[]) =>
  frames.filter((m): m is Diffs => m.type === 'diffs');
const cellCount = (frames: readonly ServerMessage[]) =>
  diffsOf(frames).reduce((n, m) => n + m.diffs.length, 0);
const resumed = (frames: readonly ServerMessage[]) => frames[0]?.type === 'resume';

async function mirrorSeq(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub, (instance: unknown) => {
    return (instance as { mirror: { seq: number } | null }).mirror?.seq ?? null;
  });
}

describe('ChangeLog', () => {
  it('locates the step that holds a seq, and lists the cells of the steps from there', () => {
    const log = new ChangeLog(10);
    log.record(12, Uint32Array.of(5, 3, 5));
    log.record(15, Uint32Array.of(7));
    log.record(16, new Uint32Array(0));
    // Before the list: unknown.
    expect(log.locate(9)).toBeNull();
    // At its start, and within the first step (rounded down to its start): every cell.
    const at = (since: number) => {
      const point = log.locate(since);
      return point && { from: point.from, cells: log.cells(point) };
    };
    expect(at(10)).toEqual({ from: 10, cells: Uint32Array.of(3, 5, 7) });
    expect(at(11)).toEqual({ from: 10, cells: Uint32Array.of(3, 5, 7) });
    expect(at(12)).toEqual({ from: 12, cells: Uint32Array.of(7) });
    // Past the last step that touched a cell: nothing to send.
    expect(at(15)).toEqual({ from: 15, cells: new Uint32Array(0) });
    expect(at(40)).toEqual({ from: 15, cells: new Uint32Array(0) });
    // Too many cells for one resume (counted before merging: 2 + 1 here).
    expect(log.cells(log.locate(10)!, 3)).toEqual(Uint32Array.of(3, 5, 7));
    expect(log.cells(log.locate(10)!, 2)).toBeNull();
  });

  it('refuses a seq inside a step that only knows its end (a resync)', () => {
    const log = new ChangeLog(0);
    log.record(5, Uint32Array.of(1));
    log.record(9, Uint32Array.of(2), false);
    log.record(12, Uint32Array.of(3));
    expect(log.locate(5)).toEqual({ from: 5, first: 1 });
    expect(log.locate(7)).toBeNull();
    expect(log.locate(9)).toEqual({ from: 9, first: 2 });
    // An inexact step with no cell still marks its seqs.
    log.record(20, new Uint32Array(0), false);
    expect(log.locate(15)).toBeNull();
    expect(log.locate(12)).toEqual({ from: 12, first: 3 });
  });

  it('drops its oldest steps past its bounds, and starts afresh on a reset', () => {
    const log = new ChangeLog(0, 3, 10);
    log.record(1, Uint32Array.of(1, 2));
    log.record(2, Uint32Array.of(3, 4));
    expect(log.from).toBe(1);
    expect(log.locate(0)).toBeNull();
    expect(log.cells(log.locate(1)!)).toEqual(Uint32Array.of(3, 4));
    log.reset(9);
    expect(log.locate(2)).toBeNull();
    expect(log.locate(9)).toEqual({ from: 9, first: 0 });
    expect(RESUME_MAX_CELLS).toBe(1 << 17);
  });
});

describe('a socket that resumes (ADR 0040)', () => {
  it('gets a Resume frame and only the cells changed since its seq', async () => {
    const canvas = 'resume-a';
    const shard = `${canvas}:fanout-0`;
    await stock(canvas, 'res-a', [O, O]);
    const a = await connect(canvas, shard, 'res-a');
    const grid = await a.joined();
    expect(resumed(grid)).toBe(false);
    const held = diffsOf(grid)[0]!.seq;
    const page = apply(new Map(), grid);
    await a.move(1, brick(600, 700));
    await a.move(2, brick(610, 700));
    // Another page, holding the map at `held`.
    const b = await connect(canvas, shard, 'res-b', { since: held });
    const frames = await b.joined();
    expect(frames[0]).toEqual({ type: 'resume', from: held });
    expect(diffsOf(frames).every((m) => m.seq === held + 2)).toBe(true);
    expect(cellCount(frames)).toBe(8);
    // Its map ends equal to a whole map's.
    const whole = await connect(canvas, shard, 'res-w');
    expect(apply(page, frames)).toEqual(apply(new Map(), await whole.joined()));
    // At the current seq: a Resume frame and one empty Diffs frame, which names the seq.
    const c = await connect(canvas, shard, 'res-c', { since: held + 2 });
    const current = await c.joined();
    expect(current[0]).toEqual({ type: 'resume', from: held + 2 });
    expect(diffsOf(current)).toEqual([{ type: 'diffs', seq: held + 2, diffs: [] }]);
    for (const s of [a, b, c, whole]) s.ws.close();
  });

  it('lists a cell changed and changed back within one tick, for a page that saw it in between', async () => {
    const canvas = 'resume-b';
    const watching = `${canvas}:fanout-0`;
    const playing = `${canvas}:fanout-1`;
    await stock(canvas, 'res-p', [O, HAMMER]);
    const w = await connect(canvas, watching, 'res-o');
    await w.joined();
    const p = await connect(canvas, playing, 'res-p');
    const grid = await p.joined();
    const start = diffsOf(grid)[0]!.seq;
    // On the other shard: a brick, then a hammer on it, both within one tick for `watching`.
    await p.move(1, brick(640, 700));
    const between = apply(new Map(), p.frames);
    await p.move(2, { kind: 'hammer', x: 640, y: 700 });
    await CANVAS.get(CANVAS.idFromName(canvas)).pushTicks();
    await w.until(async () => (await mirrorSeq(w.stub)) === start + 2);
    // A page that held the map with the brick in it (seq start + 1) resumes on `watching`.
    const r = await connect(canvas, watching, 'res-r', { since: start + 1 });
    const frames = await r.joined();
    expect(resumed(frames)).toBe(true);
    const whole = await connect(canvas, watching, 'res-x');
    expect(apply(between, frames)).toEqual(apply(new Map(), await whole.joined()));
    for (const s of [w, p, r, whole]) s.ws.close();
  });

  it('gets the whole map for a seq or a canvas it cannot vouch for', async () => {
    const canvas = 'resume-c';
    const shard = `${canvas}:fanout-0`;
    const a = await connect(canvas, shard, 'res-d');
    const seq = diffsOf(await a.joined())[0]!.seq;
    // Ahead of the mirror, malformed, from another canvas (a page left open across a season
    // change), or before the list: the whole map, no Resume frame.
    for (const held of [
      { since: seq + 5 },
      { since: 'abc' },
      { since: '-1' },
      { since: seq, canvas: 'another' },
    ]) {
      const s = await connect(canvas, shard, 'res-e', held);
      expect(resumed(await s.joined()), JSON.stringify(held)).toBe(false);
      s.ws.close();
    }
    await runInDurableObject(a.stub, (instance: unknown) => {
      const mirror = (instance as { mirror: { seq: number; changes: ChangeLog } }).mirror;
      mirror.changes.reset(mirror.seq + 1);
    });
    const old = await connect(canvas, shard, 'res-f', { since: seq });
    expect(resumed(await old.joined())).toBe(false);
    a.ws.close();
    old.ws.close();
  });

  it('resumes after the shard restarted with only the cells since its seq, tick by tick', async () => {
    const canvas = 'resume-d';
    const shard = `${canvas}:fanout-0`;
    await stock(canvas, 'res-g', [O, O]);
    const a = await connect(canvas, shard, 'res-g');
    await a.joined();
    // A brick before the page's seq, cut into a tick of its own; then the page's seq.
    await a.move(1, brick(600, 700));
    await CANVAS.get(CANVAS.idFromName(canvas)).pushTicks();
    const page = apply(new Map(), a.frames);
    const held = diffsOf(a.frames).at(-1)!.seq;
    await a.move(2, brick(620, 700));
    a.ws.close();
    // A realtime deploy: the shard loses its mirror and its list.
    await evictDurableObject(a.stub);
    const b = await connect(canvas, shard, 'res-h', { since: held });
    const frames = await b.joined();
    expect(resumed(frames)).toBe(true);
    // The second brick only: the canvas's ticks keep their boundaries in the seed.
    expect(cellCount(frames)).toBe(4);
    const whole = await connect(canvas, shard, 'res-i');
    expect(apply(page, frames)).toEqual(apply(new Map(), await whole.joined()));
    b.ws.close();
    whole.ws.close();
  });
});
