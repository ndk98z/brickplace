import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { foldNow } from '@brickplace/game/journal';
import { decodeServerMessage, encodeClientOp, type ServerMessage } from '@brickplace/protocol';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/index.ts';
import { CANVAS_HEADER, fanoutName, PLAYER_HEADER } from '../src/player.ts';

// A FanoutDO per season's canvas (ADR 0021): the gateway names the canvas, the FanoutDO pins it
// and relays to that CanvasDO only.

const { FANOUT, CANVAS } = env as unknown as Env;

async function stock(canvas: string, player: string) {
  await runInDurableObject(CANVAS.get(CANVAS.idFromName(canvas)), (instance, state) => {
    foldNow(instance, state.storage);
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO inventory (player, items, draw_index, since, config_version) ' +
        'VALUES (?, \'[{"kind":"brick","shape":1}]\', 0, ?, 1)',
      player,
      2 ** 50,
    );
  });
}

function open(canvas: string | null, fanout = fanoutName(canvas ?? 'canvas')) {
  const headers: Record<string, string> = { Upgrade: 'websocket', [PLAYER_HEADER]: 'p1' };
  if (canvas !== null) headers[CANVAS_HEADER] = canvas;
  return FANOUT.get(FANOUT.idFromName(fanout)).fetch('https://fanout/ws', { headers });
}

/** Opens a socket and resolves with the first ack it receives after sending one op. */
async function ackOf(canvas: string): Promise<ServerMessage> {
  const response = await open(canvas);
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.binaryType = 'arraybuffer';
  const ack = new Promise<ServerMessage>((resolve, reject) => {
    // Usually a few ms; 2 s ran out on a loaded GitHub runner.
    const timer = setTimeout(() => reject(new Error('no ack within 10 s')), 10_000);
    ws.addEventListener('message', (event) => {
      const message = decodeServerMessage(new Uint8Array(event.data as ArrayBuffer));
      if (message.type !== 'ack') return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  ws.accept();
  ws.send(
    encodeClientOp({
      opId: 1,
      op: { kind: 'brick', x: 600, y: 600, shape: 1, rotation: 0, color: 3 },
    }),
  );
  const message = await ack;
  ws.close(1000);
  return message;
}

describe('FanoutDO per season', () => {
  it('names the Stage 0 fanout as before and every other canvas apart', () => {
    expect(fanoutName('canvas')).toBe('fanout-0');
    expect(fanoutName('s2')).toBe('s2:fanout-0');
  });

  it('relays to the canvas the gateway names', async () => {
    await stock('season-r1', 'p1');
    expect(await ackOf('season-r1')).toEqual({ type: 'ack', opId: 1, ok: true });
    const status = await CANVAS.get(CANVAS.idFromName('season-r1')).status();
    expect(status.seq).toBe(1);
  });

  it('refuses a socket for another canvas than the one it serves, and bad names', async () => {
    await stock('season-r2', 'p1');
    const first = await open('season-r2', 'shared-fanout');
    expect(first.status).toBe(101);
    first.webSocket!.accept();
    first.webSocket!.close(1000);
    expect((await open('season-r3', 'shared-fanout')).status).toBe(409);
    expect((await open('Not A Name', 'other-fanout')).status).toBe(400);
  });

  it('acks `ended` once the season is over', async () => {
    await stock('season-r4', 'p1');
    await CANVAS.get(CANVAS.idFromName('season-r4')).setSchedule({ endsAt: 1 });
    expect(await ackOf('season-r4')).toEqual({ type: 'ack', opId: 1, ok: false, reason: 'ended' });
  });
});
