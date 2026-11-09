import {
  type ConfigMessage,
  decodeClientMessage,
  decodeClientOp,
  encodeServerMessage,
  type HoldMessage,
  type StatsMessage,
} from '@brickplace/protocol';
import { describe, expect, it } from 'vitest';
import {
  Connection,
  type ConnectionStatus,
  type SocketLike,
  socketUrlFor,
} from '../src/net/connection.ts';

type SocketEvent = { readonly data: unknown; readonly code?: number };

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  sent: ArrayBuffer[] = [];
  private handlers: Record<string, ((event: SocketEvent) => void)[]> = {};

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const list = this.handlers[type] ?? [];
    list.push(listener);
    this.handlers[type] = list;
  }
  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.readyState = 3;
    for (const h of this.handlers.close ?? []) h({ data: undefined, code });
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  receive(frame: Uint8Array): void {
    this.emit('message', frame.slice().buffer);
  }
  private emit(type: string, data?: unknown): void {
    for (const h of this.handlers[type] ?? []) h({ data });
  }
}

interface Timer {
  fn: () => void;
  ms: number;
  live: boolean;
}

/** Distinct from every backoff step, so tests can tell the two kinds of timer apart. */
const STABLE_MS = 7777;

function setup(random: () => number = () => 0) {
  const sockets: FakeSocket[] = [];
  const timers: Timer[] = [];
  const log: string[] = [];
  const statuses: ConnectionStatus[] = [];
  const acks: [number, boolean, string | null][] = [];
  const diffs: number[] = [];
  const holds: HoldMessage[] = [];
  const configs: ConfigMessage[] = [];
  const closes: number[] = [];
  const connection = new Connection(
    'ws://test/ws',
    {
      status: (s) => statuses.push(s),
      reset: () => log.push('reset'),
      diffs: (seq, d) => {
        log.push(`diffs ${seq}`);
        diffs.push(...d.map((x) => x.index));
      },
      ack: (opId, ok, reason) => acks.push([opId, ok, reason]),
      hold: (hold) => holds.push(hold),
      config: (config) => configs.push(config),
      closed: (code) => closes.push(code),
    },
    {
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => {
        const timer = { fn, ms, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        (handle as Timer).live = false;
      },
      now: () => 1000,
      random,
      stableMs: STABLE_MS,
    },
  );
  /** Reconnect delays scheduled so far. */
  const reconnects = () => timers.filter((x) => x.ms !== STABLE_MS).map((x) => x.ms);
  const fireLast = () => {
    const timer = timers.filter((x) => x.ms !== STABLE_MS && x.live).at(-1)!;
    timer.live = false;
    timer.fn();
  };
  const fireStable = () => {
    const timer = timers.filter((x) => x.ms === STABLE_MS && x.live).at(-1)!;
    timer.live = false;
    timer.fn();
  };
  return {
    connection,
    sockets,
    reconnects,
    fireLast,
    fireStable,
    log,
    statuses,
    acks,
    diffs,
    holds,
    configs,
    closes,
  };
}

const brick = { kind: 'brick', x: 3, y: 4, shape: 2, rotation: 1, color: 9 } as const;

describe('socket ids', () => {
  const noop = { status() {}, reset() {}, diffs() {}, ack() {}, hold() {}, config() {} };

  it('go into the socket URL, keeping any existing query', () => {
    expect(socketUrlFor('wss://example.test/ws?v=1', { client: 'conn-12345' })).toBe(
      'wss://example.test/ws?v=1&client=conn-12345',
    );
    expect(
      socketUrlFor('wss://example.test/ws', { client: 'conn-12345', player: 'abc-12345' }),
    ).toBe('wss://example.test/ws?client=conn-12345&player=abc-12345');
    // The map the page holds (ADR 0040): its seq and canvas, only when the seq is one.
    expect(
      socketUrlFor('wss://example.test/ws', {
        client: 'conn-12345',
        held: { canvas: 's2', seq: 42 },
      }),
    ).toBe('wss://example.test/ws?client=conn-12345&since=42&canvas=s2');
    for (const seq of [-1, 1.5, Number.NaN]) {
      expect(
        socketUrlFor('wss://example.test/ws', { client: 'c-123456', held: { canvas: 's2', seq } }),
      ).toBe('wss://example.test/ws?client=c-123456');
    }
    expect(socketUrlFor('wss://example.test/ws', { client: 'c-123456', held: null })).toBe(
      'wss://example.test/ws?client=c-123456',
    );
  });

  it('ask for the since as each socket is created, and pass a Resume frame on (ADR 0040)', () => {
    const urls: string[] = [];
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const resumed: number[] = [];
    let since: number | null = null;
    const connection = new Connection(
      'ws://test/ws',
      { ...noop, resume: (from) => resumed.push(from) },
      {
        since: () => (since === null ? null : { canvas: 'canvas', seq: since }),
        createSocket: (url) => {
          urls.push(url);
          const s = new FakeSocket();
          sockets.push(s);
          return s;
        },
        setTimer: (fn) => timers.push(fn),
        clearTimer: () => {},
        random: () => 0,
      },
    );
    connection.start();
    since = 17;
    sockets[0]!.open();
    sockets[0]!.close(1006);
    timers.at(-1)!();
    expect(urls.map((u) => new URL(u).searchParams.get('since'))).toEqual([null, '17']);
    sockets[1]!.open();
    sockets[1]!.receive(encodeServerMessage({ type: 'resume', from: 17 }));
    expect(resumed).toEqual([17]);
    // reopen(): the socket closes and the next one comes on the backoff, ops kept.
    connection.reopen();
    expect(sockets[1]!.readyState).toBe(3);
    timers.at(-1)!();
    expect(sockets).toHaveLength(3);
  });

  it('are made once per Connection and used for every reconnect', () => {
    const urls: string[] = [];
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const connection = new Connection('ws://test/ws', noop, {
      devPlayer: true,
      createSocket: (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
    expect(connection.playerId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(connection.clientId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    connection.start();
    sockets[0]!.close();
    timers.at(-1)!();
    const url = `ws://test/ws?client=${connection.clientId}&player=${connection.playerId}`;
    expect(urls).toEqual([url, url]);
    const next = new Connection('ws://test/ws', noop, { devPlayer: true });
    expect(next.playerId).not.toBe(connection.playerId);
    expect(next.clientId).not.toBe(connection.clientId);
  });

  it('says a socket is opening before it creates it, on every reconnect', () => {
    const log: string[] = [];
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const connection = new Connection(
      'ws://test/ws',
      { ...noop, opening: () => log.push('opening'), reset: () => log.push('open') },
      {
        createSocket: () => {
          log.push('create');
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        setTimer: (fn) => timers.push(fn),
        clearTimer: () => {},
      },
    );
    connection.start();
    sockets[0]!.open();
    sockets[0]!.close();
    timers.at(-1)!();
    expect(log).toEqual(['opening', 'create', 'open', 'opening', 'create']);
  });

  it('send no dev id unless asked: the session decides who plays', () => {
    const connection = new Connection('ws://test/ws', noop);
    expect(connection.playerId).toBeNull();
  });
});

describe('Connection', () => {
  it('resets the map on every open, before any diff of that socket', () => {
    const t = setup();
    t.connection.start();
    const socket = t.sockets[0]!;
    expect(socket.binaryType).toBe('arraybuffer');
    socket.open();
    socket.receive(
      encodeServerMessage({ type: 'diffs', seq: 7, diffs: [{ index: 42, cell: 0x80, shield: 0 }] }),
    );
    expect(t.log).toEqual(['reset', 'diffs 7']);
    expect(t.diffs).toEqual([42]);
    expect(t.statuses.map((s) => s.state)).toEqual(['connecting', 'open']);
  });

  it('passes the close code on before reconnecting, so a kick can renew the session', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    t.sockets[0]!.close(4403);
    expect(t.closes).toEqual([4403]);
    expect(t.reconnects()).toHaveLength(1);
    t.fireLast();
    t.sockets[1]!.close();
    expect(t.closes).toEqual([4403, 0]);
    // Stopping is not a close the page has to act on.
    t.connection.stop();
    expect(t.closes).toEqual([4403, 0]);
  });

  it('does not reconnect when the close handler stops the connection', () => {
    const t = setup();
    let stopOn = 0;
    const events = (t.connection as unknown as { events: { closed?(code: number): void } }).events;
    const record = events.closed!;
    events.closed = (code) => {
      record(code);
      if (code === stopOn) t.connection.stop();
    };
    stopOn = 4409;
    t.connection.start();
    t.sockets[0]!.open();
    t.sockets[0]!.close(4409);
    expect(t.closes).toEqual([4409]);
    expect(t.reconnects()).toHaveLength(0);
    // Started again later, it opens a socket at once.
    t.connection.start();
    expect(t.sockets).toHaveLength(2);
  });

  it('sends views without an id or an ack, and only on an open socket', () => {
    const t = setup();
    expect(t.connection.sendView({ x: 1, y: 2, w: 3, h: 4 })).toBe(false);
    t.connection.start();
    t.sockets[0]!.open();
    expect(t.connection.sendView({ x: 1, y: 2, w: 3, h: 4 })).toBe(true);
    expect(decodeClientMessage(new Uint8Array(t.sockets[0]!.sent[0]!))).toEqual({
      view: { x: 1, y: 2, w: 3, h: 4 },
    });
    // A new socket does not resend it: the page sends its view again itself.
    t.sockets[0]!.close(1006);
    t.fireLast();
    t.sockets[1]!.open();
    expect(t.sockets[1]!.sent).toHaveLength(0);
  });

  it('resends an op after reconnecting with the view it was sent with, then the current one', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const before = { x: 1, y: 1, w: 10, h: 10 };
    const after = { x: 500, y: 500, w: 10, h: 10 };
    t.connection.sendView(before);
    const opId = t.connection.send(brick)!;
    // The player pans, then the socket drops before the answer.
    t.connection.sendView(after);
    t.sockets[0]!.close(1006);
    t.fireLast();
    t.sockets[1]!.open();
    const frames = t.sockets[1]!.sent.map((f) => decodeClientMessage(new Uint8Array(f)));
    expect(frames).toEqual([{ view: before }, { opId, op: brick }, { view: after }]);
  });

  it('resends a subscribing view only plain with an op, never subscribing the new socket', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const shown = { x: 1, y: 1, w: 10, h: 10 };
    t.connection.sendView(shown, true);
    expect(decodeClientMessage(new Uint8Array(t.sockets[0]!.sent[0]!))).toEqual({
      view: shown,
      subscribe: true,
    });
    const opId = t.connection.send(brick)!;
    // Panned (plain, as on a server without views) before the socket dropped.
    const after = { x: 500, y: 500, w: 10, h: 10 };
    t.connection.sendView(after);
    t.sockets[0]!.close(1006);
    t.fireLast();
    t.sockets[1]!.open();
    // The op goes again after the view it was sent with, plain: the new socket follows every
    // tile until the page subscribes it itself (ADR 0028).
    const frames = t.sockets[1]!.sent.map((f) => decodeClientMessage(new Uint8Array(f)));
    expect(frames).toEqual([{ view: shown }, { opId, op: brick }, { view: after }]);
  });

  it('holds the reconnect while paused, keeping the op in flight, and resends it on resume', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const opId = t.connection.send(brick)!;
    // The server closes without an ack (a challenge, 4428); the page pauses as it closes.
    const events = (t.connection as unknown as { events: { closed?(code: number): void } }).events;
    const record = events.closed!;
    events.closed = (code) => {
      record(code);
      if (code === 4428) t.connection.pause();
    };
    t.sockets[0]!.close(4428);
    expect(t.reconnects()).toHaveLength(0);
    expect(t.acks).toEqual([]);
    t.connection.resume();
    expect(t.sockets).toHaveLength(2);
    t.sockets[1]!.open();
    expect(decodeClientOp(new Uint8Array(t.sockets[1]!.sent[0]!)).opId).toBe(opId);
    // Resuming again does nothing more.
    t.connection.resume();
    expect(t.sockets).toHaveLength(2);
  });

  it('encodes ops and matches acks by op id', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const a = t.connection.send(brick)!;
    const b = t.connection.send({ kind: 'hammer', x: 1, y: 2 })!;
    expect(b).toBe(a + 1);
    expect(decodeClientOp(new Uint8Array(t.sockets[0]!.sent[0]!))).toEqual({ opId: a, op: brick });
    t.sockets[0]!.receive(
      encodeServerMessage({ type: 'ack', opId: b, ok: false, reason: 'empty' }),
    );
    t.sockets[0]!.receive(encodeServerMessage({ type: 'ack', opId: a, ok: true }));
    // A second ack for the same op (or an unknown op) is ignored.
    t.sockets[0]!.receive(encodeServerMessage({ type: 'ack', opId: a, ok: true }));
    expect(t.acks).toEqual([
      [b, false, 'empty'],
      [a, true, null],
    ]);
  });

  it('passes the config frame on, apart from acks and diffs', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const config: ConfigMessage = {
      type: 'config',
      mapSize: 2048,
      open: { x: 256, y: 256, w: 1536, h: 1536 },
      maxShield: 5,
    };
    t.sockets[0]!.receive(encodeServerMessage(config));
    expect(t.configs).toEqual([config]);
    expect(t.acks).toEqual([]);
    expect(t.diffs).toEqual([]);
  });

  it('passes Stats frames on (ADR 0030)', () => {
    const got: StatsMessage[] = [];
    const sockets: FakeSocket[] = [];
    const connection = new Connection(
      'ws://test/ws',
      {
        status() {},
        reset() {},
        diffs() {},
        ack() {},
        hold() {},
        config() {},
        stats: (s) => got.push(s),
      },
      {
        createSocket: () => {
          const s = new FakeSocket();
          sockets.push(s);
          return s;
        },
        setTimer: () => null,
        clearTimer: () => {},
      },
    );
    connection.start();
    sockets[0]!.open();
    const stats: StatsMessage = { type: 'stats', playing: 1284, team: 12 };
    sockets[0]!.receive(encodeServerMessage(stats));
    expect(got).toEqual([stats]);
  });

  it('passes the server hold on, and sends discards under the op id counter', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const hold: HoldMessage = {
      type: 'hold',
      capacity: 3,
      cooldown: 60_000,
      nextIn: 1234,
      revision: 3,
      items: [{ kind: 'brick', shape: 4 }],
    };
    t.sockets[0]!.receive(encodeServerMessage(hold));
    expect(t.holds).toEqual([hold]);
    const a = t.connection.send(brick)!;
    const d = t.connection.discard({ kind: 'brick', shape: 4 })!;
    expect(d).toBe(a + 1);
    expect(decodeClientMessage(new Uint8Array(t.sockets[0]!.sent[1]!))).toEqual({
      opId: d,
      discard: { kind: 'brick', shape: 4 },
    });
    t.sockets[0]!.receive(
      encodeServerMessage({ type: 'ack', opId: d, ok: false, reason: 'no_item' }),
    );
    expect(t.acks).toEqual([[d, false, 'no_item']]);
  });

  it('refuses to send while not connected', () => {
    const t = setup();
    t.connection.start();
    expect(t.connection.send(brick)).toBeNull();
  });

  it('skips frames it cannot decode', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const warn = console.warn;
    console.warn = () => {};
    try {
      t.sockets[0]!.receive(new Uint8Array([99, 0x82]));
    } finally {
      console.warn = warn;
    }
    expect(t.log).toEqual(['reset']);
  });

  it('backs off, and starts over only once a socket has stayed open', () => {
    // Mid-spread: the first retry 3 s, later ones exactly their step.
    const t = setup(() => 0.5);
    t.connection.start();
    t.sockets[0]!.close(); // never opened
    expect(t.statuses.at(-1)).toEqual({ state: 'waiting', retryAt: 4000 });
    expect(t.reconnects()).toEqual([3000]);
    t.fireLast();
    // Accepted, then closed at once (e.g. 1012): the delay keeps growing.
    t.sockets[1]!.open();
    t.sockets[1]!.close();
    t.fireLast();
    t.sockets[2]!.close();
    expect(t.reconnects()).toEqual([3000, 2000, 4000]);
    t.fireLast();
    t.sockets[3]!.open();
    t.fireStable(); // stayed open long enough
    t.sockets[3]!.close();
    expect(t.reconnects()).toEqual([3000, 2000, 4000, 3000]);
  });

  it('waits at least the 8 s step after a 1013 (an overloaded object)', () => {
    const t = setup(() => 0.5);
    t.connection.start();
    t.sockets[0]!.open();
    t.fireStable();
    t.sockets[0]!.close(1013);
    expect(t.reconnects()).toEqual([8000]);
    t.fireLast();
    // The backoff goes on from there.
    t.sockets[1]!.close();
    expect(t.reconnects()).toEqual([8000, 15_000]);
  });

  it('spreads the first retry over 1 to 5 s, later ones by 0.5 to 1.5 times (ADR 0040)', () => {
    const delays: number[] = [];
    const timers: (() => void)[] = [];
    const sockets: FakeSocket[] = [];
    const noop = { status() {}, reset() {}, diffs() {}, ack() {}, hold() {}, config() {} };
    const connection = new Connection('ws://test/ws', noop, {
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => {
        if (ms !== STABLE_MS) {
          delays.push(ms);
          timers.push(fn);
        }
      },
      clearTimer: () => {},
      // The largest spread.
      random: () => 1,
      stableMs: STABLE_MS,
    });
    connection.start();
    sockets[0]!.close();
    timers.at(-1)!();
    sockets[1]!.close();
    expect(delays).toEqual([5000, 3000]);
  });

  it('resends an op in flight on the next socket with the same op id', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const opId = t.connection.send(brick)!;
    t.sockets[0]!.close();
    expect(t.acks).toEqual([]); // not lost yet
    t.fireLast();
    t.sockets[1]!.open();
    expect(t.log).toEqual(['reset', 'reset']);
    expect(decodeClientOp(new Uint8Array(t.sockets[1]!.sent[0]!))).toEqual({ opId, op: brick });
    t.sockets[1]!.receive(encodeServerMessage({ type: 'ack', opId, ok: true }));
    expect(t.acks).toEqual([[opId, true, null]]);
  });

  it('reports unavailable once the resend also goes unanswered', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const opId = t.connection.send(brick)!;
    t.sockets[0]!.close();
    t.fireLast();
    t.sockets[1]!.open();
    t.sockets[1]!.close();
    expect(t.acks).toEqual([[opId, false, 'unavailable']]);
    t.fireLast();
    t.sockets[2]!.open();
    expect(t.sockets[2]!.sent).toHaveLength(0);
  });

  it('retries once on an unavailable ack before reporting it', () => {
    const t = setup();
    t.connection.start();
    const socket = t.sockets[0]!;
    socket.open();
    const opId = t.connection.send(brick)!;
    const unavailable = { type: 'ack', opId, ok: false, reason: 'unavailable' } as const;
    socket.receive(encodeServerMessage(unavailable));
    expect(socket.sent).toHaveLength(2);
    expect(decodeClientOp(new Uint8Array(socket.sent[1]!)).opId).toBe(opId);
    expect(t.acks).toEqual([]);
    socket.receive(encodeServerMessage(unavailable));
    expect(t.acks).toEqual([[opId, false, 'unavailable']]);
  });

  it('reports busy at once and leaves the retry to the player (ADR 0032)', () => {
    const t = setup();
    t.connection.start();
    const socket = t.sockets[0]!;
    socket.open();
    const opId = t.connection.send(brick)!;
    socket.receive(encodeServerMessage({ type: 'ack', opId, ok: false, reason: 'busy' }));
    expect(socket.sent).toHaveLength(1);
    expect(t.acks).toEqual([[opId, false, 'busy']]);
  });

  it('op ids keep counting across reconnects', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const a = t.connection.send(brick)!;
    t.sockets[0]!.receive(encodeServerMessage({ type: 'ack', opId: a, ok: true }));
    t.sockets[0]!.close();
    t.fireLast();
    t.sockets[1]!.open();
    expect(t.connection.send(brick)).toBe(a + 1);
  });

  it('stop() closes the socket, fails ops in flight and does not reconnect', () => {
    const t = setup();
    t.connection.start();
    t.sockets[0]!.open();
    const opId = t.connection.send(brick)!;
    t.connection.stop();
    expect(t.acks).toEqual([[opId, false, 'unavailable']]);
    expect(t.reconnects()).toHaveLength(0);
  });
});
