import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDO, Env } from '../src/index.ts';
import { foldNow } from '../src/journal.ts';
import { errorText, loggableError, OpsSampler } from '../src/ops.ts';

// Ops events (docs/ops/alerts.md): stable names, no player ids, sampled so they cannot flood.

const { CANVAS } = env as unknown as Required<Env>;

type Line = { event?: string } & Record<string, unknown>;
const lines = (spy: { mock: { calls: unknown[][] } }, event: string) =>
  spy.mock.calls.map(([line]) => line as Line).filter((line) => line?.event === event);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpsSampler', () => {
  it('logs a name at most once per interval and counts what it held back', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 0;
    const sampler = new OpsSampler(60_000, () => now);
    expect(sampler.emit('warn', 'canvas_queue_deep', { depth: 64 })).toBe(true);
    now = 30_000;
    expect(sampler.emit('warn', 'canvas_queue_deep', { depth: 70 })).toBe(false);
    expect(sampler.emit('warn', 'canvas_queue_deep', { depth: 80 })).toBe(false);
    // Another name has its own interval.
    expect(sampler.emit('warn', 'canvas_tick_slow', { ms: 2_500 })).toBe(true);
    now = 60_000;
    expect(sampler.emit('warn', 'canvas_queue_deep', { depth: 90 })).toBe(true);
    expect(lines(warn, 'canvas_queue_deep')).toEqual([
      { event: 'canvas_queue_deep', depth: 64, suppressed: 0 },
      { event: 'canvas_queue_deep', depth: 90, suppressed: 2 },
    ]);
  });

  it('cuts long error text', () => {
    expect(errorText(new RangeError('bad'))).toBe('RangeError: bad');
    expect(errorText('x'.repeat(400))).toHaveLength(301);
  });

  it('withholds what a SyntaxError quotes, from errorText and from plain error logs', () => {
    let parsed: unknown;
    try {
      JSON.parse('{"who":x"[[\\"zq9\\",3]]"}');
    } catch (error) {
      parsed = error;
    }
    expect(String(parsed)).toContain('zq9');
    expect(errorText(parsed)).toBe('SyntaxError (message withheld: it may quote data)');
    expect(loggableError(parsed)).toBe(errorText(parsed));
    const other = new Error('R2 down');
    expect(loggableError(other)).toBe(other);
  });
});

describe('CanvasDO start without the draw key', () => {
  it('logs item_draw_key_missing with the canvas only', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = CANVAS.get(CANVAS.idFromName('ops-no-key'));
    await runInDurableObject(stub, (instance: CanvasDO, state) => {
      const env = (instance as unknown as { env: Env }).env;
      // The constructor as the runtime runs it after a deploy without the secret.
      const Canvas = instance.constructor as new (state: DurableObjectState, env: Env) => CanvasDO;
      new Canvas(state, { ...env, ITEM_DRAW_KEY: undefined });
    });
    expect(lines(errors, 'item_draw_key_missing')).toEqual([
      { event: 'item_draw_key_missing', canvas: 'ops-no-key' },
    ]);
  });
});

describe('CanvasDO overload events', () => {
  it('logs canvas_queue_deep once calls pile up in its queue, once a minute at most', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = CANVAS.get(CANVAS.idFromName('ops-queue'));
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      // Started in one synchronous step: each waits for the one before it.
      await Promise.all(Array.from({ length: 100 }, () => instance.holds(['p1'], 1_000)));
    });
    const deep = lines(warn, 'canvas_queue_deep');
    expect(deep).toEqual([
      { event: 'canvas_queue_deep', canvas: 'ops-queue', depth: 64, suppressed: 0 },
    ]);
    expect(JSON.stringify(deep)).not.toContain('p1');
  });

  it('sheds new ops and discards busy while 256 calls wait, never queueing them (ADR 0032)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = CANVAS.get(CANVAS.idFromName('ops-shed'));
    const brick = { kind: 'brick', shape: 1 } as const;
    const op = (opId: number, x: number) => ({
      player: 'p1',
      opId,
      op: { kind: 'brick', x, y: 600, shape: 1, rotation: 0, color: 3 } as const,
    });
    await runInDurableObject(stub, async (instance: CanvasDO, state) => {
      foldNow(instance, state.storage);
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
          'VALUES (?, ?, 0, ?, 1)',
        'p1',
        JSON.stringify([brick, brick, brick]),
        1_000,
      );
      expect((await instance.applyBatch([op(1, 600)], 1_000)).results[0]!.ok).toBe(true);
      // Started in one synchronous step: 256 hold reads wait, so what follows is shed.
      const waiting = Array.from({ length: 256 }, () => instance.holds(['p1'], 1_000));
      const shed = instance.applyBatch([op(1, 600), op(2, 610), op(3, -5)], 1_000);
      const thrown = instance.discard('p1', 4, brick, 1_000);
      // Holds are never shed: this one queues behind the others.
      const hold = instance.holds(['p1'], 1_000);
      const batch = await shed;
      // The accepted op's retry is still a duplicate; the rest are busy, applied nothing.
      expect(batch.results).toEqual([
        { ok: true, duplicate: true, diffs: [] },
        { ok: false, reason: 'busy' },
        { ok: false, reason: 'busy' },
      ]);
      expect(batch.holds.size).toBe(0);
      expect((await thrown).result).toEqual({ ok: false, reason: 'busy' });
      await Promise.all(waiting);
      // Both items still held, and once the queue drained the same move goes through.
      expect((await hold).get('p1')!.items).toHaveLength(2);
      expect((await instance.applyBatch([op(2, 610)], 1_000)).results[0]!.ok).toBe(true);
    });
    const shedding = lines(warn, 'canvas_shedding');
    expect(shedding).toEqual([
      { event: 'canvas_shedding', canvas: 'ops-shed', depth: 256, suppressed: 0 },
    ]);
  });

  it('queues a retry of a move still in the queue, and lets a pause answer first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = CANVAS.get(CANVAS.idFromName('ops-shed-retry'));
    const brick = { kind: 'brick', shape: 1 } as const;
    const op = (opId: number, x: number) => ({
      player: 'p1',
      opId,
      op: { kind: 'brick', x, y: 600, shape: 1, rotation: 0, color: 3 } as const,
    });
    await runInDurableObject(stub, async (instance: CanvasDO, state) => {
      foldNow(instance, state.storage);
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
          'VALUES (?, ?, 0, ?, 1)',
        'p1',
        JSON.stringify([brick, brick, brick]),
        1_000,
      );
      // 254 hold reads, then op 1 and discard 2: 256 calls wait.
      const waiting = Array.from({ length: 254 }, () => instance.holds(['p1'], 1_000));
      const first = instance.applyBatch([op(1, 600)], 1_000);
      const thrown = instance.discard('p1', 2, brick, 1_000);
      // Their retries (a new socket resends with the same ids) wait behind them, not shed:
      // answered busy, the player would think the move was dropped while it is applied.
      const retry = instance.applyBatch([op(1, 600)], 1_000);
      const thrownAgain = instance.discard('p1', 2, brick, 1_000);
      // A new move is shed.
      const fresh = instance.applyBatch([op(3, 610)], 1_000);
      expect((await fresh).results).toEqual([{ ok: false, reason: 'busy' }]);
      expect((await first).results[0]!.ok).toBe(true);
      expect((await retry).results).toEqual([{ ok: true, duplicate: true, diffs: [] }]);
      expect((await thrown).result).toEqual({ ok: true });
      expect((await thrownAgain).result).toEqual({ ok: true, duplicate: true });
      await Promise.all(waiting);
      // Paused while the queue is deep: the pause is the answer, not busy.
      expect(await instance.setSchedule({ readOnly: 'raid' })).toMatchObject({ ok: true });
      const backlog = Array.from({ length: 256 }, () => instance.holds(['p1'], 1_000));
      expect((await instance.applyBatch([op(3, 610)], 1_000)).results).toEqual([
        { ok: false, reason: 'read_only' },
      ]);
      expect((await instance.discard('p1', 4, brick, 1_000)).result).toEqual({
        ok: false,
        reason: 'read_only',
      });
      await Promise.all(backlog);
    });
  });

  it('logs canvas_tick_slow for a tick longer than a segment interval', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = CANVAS.get(CANVAS.idFromName('ops-tick'));
    await runInDurableObject(stub, async (instance: CanvasDO) => {
      await instance.tick(10_000_000);
      expect(lines(warn, 'canvas_tick_slow')).toEqual([]);
      // Any tick counts as slow now; the real threshold is SEGMENT_MS.
      (instance as unknown as { tickSlowMs: number }).tickSlowMs = -1;
      await instance.tick(10_010_000);
    });
    expect(lines(warn, 'canvas_tick_slow')).toEqual([
      expect.objectContaining({ canvas: 'ops-tick', maintained: true, suppressed: 0 }),
    ]);
  });
});
