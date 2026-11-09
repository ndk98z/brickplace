import { describe, expect, it } from 'vitest';
import {
  type AckReason,
  type ClientDiscard,
  type ClientOp,
  type ClientView,
  decodeClientMessage,
  decodeClientOp,
  decodeServerMessage,
  encodeClientDiscard,
  encodeClientOp,
  encodeClientView,
  encodeServerMessage,
  MAX_DIFFS_PER_FRAME,
  Opcode,
  PROTOCOL_VERSION,
  ProtocolError,
  type ServerMessage,
  viewTiles,
} from '../src/index.ts';

describe('client ops', () => {
  const cases: ClientOp[] = [
    { opId: 1, op: { kind: 'brick', x: 2047, y: 0, shape: 6, rotation: 3, color: 31 } },
    { opId: 0xffffffff, op: { kind: 'hammer', x: 10, y: 20 } },
    { opId: 42, op: { kind: 'shield', x: 0, y: 2047 } },
    { opId: 43, op: { kind: 'single', x: 1023, y: 7, color: 31 } },
  ];
  it.each(cases)('round-trips $op.kind', (msg) => {
    expect(decodeClientOp(encodeClientOp(msg))).toEqual(msg);
  });

  it('keeps brick frames at 13 bytes and single brick frames at 11', () => {
    expect(encodeClientOp(cases[0]!).byteLength).toBe(13);
    expect(encodeClientOp(cases[3]!).byteLength).toBe(11);
  });

  it('pins the single brick frame layout', () => {
    expect([...encodeClientOp(cases[3]!)]).toEqual([1, 0x04, 43, 0, 0, 0, 0xff, 0x03, 7, 0, 31]);
  });

  it('refuses a single brick frame without its colour', () => {
    const frame = encodeClientOp(cases[3]!).subarray(0, 10);
    expect(() => decodeClientOp(frame)).toThrow(ProtocolError);
  });

  it('rejects truncated and foreign frames', () => {
    expect(() => decodeClientOp(new Uint8Array([1, 1, 0]))).toThrow(ProtocolError);
    expect(() => decodeClientOp(new Uint8Array([9, 1, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(
      ProtocolError,
    );
  });
});

describe('discards', () => {
  const cases: ClientDiscard[] = [
    { opId: 5, discard: { kind: 'brick', shape: 6 } },
    { opId: 0xffffffff, discard: { kind: 'single' } },
    { opId: 6, discard: { kind: 'hammer' } },
    { opId: 7, discard: { kind: 'shield' } },
  ];
  it.each(cases)('round-trips a discarded $discard.kind', (msg) => {
    expect(decodeClientMessage(encodeClientDiscard(msg))).toEqual(msg);
  });

  it('pins the discard frame layout', () => {
    expect([...encodeClientDiscard(cases[0]!)]).toEqual([1, 0x05, 5, 0, 0, 0, 0, 6]);
    expect([...encodeClientDiscard(cases[2]!)]).toEqual([1, 0x05, 6, 0, 0, 0, 2, 0xff]);
  });

  it('decodes ops through the same entry point, and refuses discards as ops', () => {
    const op: ClientOp = { opId: 3, op: { kind: 'hammer', x: 1, y: 2 } };
    expect(decodeClientMessage(encodeClientOp(op))).toEqual(op);
    expect(() => decodeClientOp(encodeClientDiscard(cases[1]!))).toThrow(ProtocolError);
  });

  it('refuses unknown items and short frames', () => {
    expect(() => decodeClientMessage(new Uint8Array([1, 5, 0, 0, 0, 0, 4, 0]))).toThrow(
      ProtocolError,
    );
    expect(() => decodeClientMessage(new Uint8Array([1, 5, 0, 0, 0, 0, 0, 7]))).toThrow(
      ProtocolError,
    );
    expect(() => decodeClientMessage(new Uint8Array([1, 5, 0, 0, 0, 0, 0]))).toThrow(ProtocolError);
  });
});

describe('views (ADR 0026)', () => {
  it('round-trips a view through the client entry point', () => {
    const msg: ClientView = { view: { x: 0xffff, y: 0, w: 1920, h: 7 } };
    expect(decodeClientMessage(encodeClientView(msg))).toEqual(msg);
  });

  it('pins the view frame layout', () => {
    expect([...encodeClientView({ view: { x: 1, y: 0x0102, w: 3, h: 4 } })]).toEqual([
      1, 0x06, 1, 0, 2, 1, 3, 0, 4, 0,
    ]);
  });

  it('refuses short frames, values past u16, and views as ops', () => {
    expect(() => decodeClientMessage(new Uint8Array([1, 6, 0, 0, 0, 0, 0, 0, 0]))).toThrow(
      ProtocolError,
    );
    expect(() => encodeClientView({ view: { x: -1, y: 0, w: 1, h: 1 } })).toThrow(ProtocolError);
    expect(() => encodeClientView({ view: { x: 0, y: 0, w: 0x10000, h: 1 } })).toThrow(
      ProtocolError,
    );
    const frame = encodeClientView({ view: { x: 1, y: 2, w: 3, h: 4 } });
    expect(() => decodeClientOp(frame)).toThrow(ProtocolError);
  });
});

describe('server messages', () => {
  const cases: ServerMessage[] = [
    { type: 'ack', opId: 7, ok: true },
    { type: 'ack', opId: 8, ok: false, reason: 'occupied' },
    { type: 'ack', opId: 9, ok: false, reason: 'unavailable' },
    { type: 'ack', opId: 10, ok: false, reason: 'signed_out' },
    {
      type: 'diffs',
      seq: 99,
      diffs: [
        { index: 4_194_303, cell: 0x83, shield: 5 },
        { index: 0, cell: 0, shield: 0 },
      ],
    },
    {
      type: 'hold',
      capacity: 3,
      cooldown: 60_000,
      nextIn: 12_345,
      revision: 0xffffffff,
      items: [{ kind: 'brick', shape: 3 }, { kind: 'single' }],
    },
    { type: 'hold', capacity: 3, cooldown: 60_000, nextIn: null, revision: 0, items: [] },
  ];
  it.each(cases)('round-trips $type', (msg) => {
    expect(decodeServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('keeps existing ack status codes and appends coverable as 6', () => {
    const status = (reason: AckReason) =>
      encodeServerMessage({ type: 'ack', opId: 1, ok: false, reason })[6];
    expect(status('invalid')).toBe(1);
    expect(status('shield_full')).toBe(5);
    expect(status('coverable')).toBe(6);
    expect(status('unavailable')).toBe(0xff);
    expect(decodeServerMessage(new Uint8Array([1, 0x81, 1, 0, 0, 0, 6]))).toEqual({
      type: 'ack',
      opId: 1,
      ok: false,
      reason: 'coverable',
    });
  });

  it('refuses to encode a reject reason it does not know, rather than send it as ok', () => {
    const reason = 'from_a_newer_build' as AckReason;
    expect(() => encodeServerMessage({ type: 'ack', opId: 1, ok: false, reason })).toThrow(
      ProtocolError,
    );
  });

  it('sends signed_out as status 254, apart from the core reasons', () => {
    expect(encodeServerMessage({ type: 'ack', opId: 1, ok: false, reason: 'signed_out' })[6]).toBe(
      0xfe,
    );
  });

  it('sends the season statuses ended and read_only as 253 and 252, and reads them back', () => {
    for (const [reason, status] of [
      ['ended', 0xfd],
      ['read_only', 0xfc],
    ] as const) {
      const frame = encodeServerMessage({ type: 'ack', opId: 9, ok: false, reason });
      expect(frame[6]).toBe(status);
      expect(decodeServerMessage(frame)).toEqual({ type: 'ack', opId: 9, ok: false, reason });
    }
  });

  it('sends locked (ADR 0024) as status 251 and reads it back', () => {
    const frame = encodeServerMessage({ type: 'ack', opId: 4, ok: false, reason: 'locked' });
    expect(frame[6]).toBe(0xfb);
    expect(decodeServerMessage(frame)).toEqual({
      type: 'ack',
      opId: 4,
      ok: false,
      reason: 'locked',
    });
  });

  it('sends limited (ADR 0026) as status 250 and reads it back', () => {
    const frame = encodeServerMessage({ type: 'ack', opId: 5, ok: false, reason: 'limited' });
    expect(frame[6]).toBe(0xfa);
    expect(decodeServerMessage(frame)).toEqual({
      type: 'ack',
      opId: 5,
      ok: false,
      reason: 'limited',
    });
  });

  it('sends busy (ADR 0032) as status 249 and reads it back', () => {
    const frame = encodeServerMessage({ type: 'ack', opId: 6, ok: false, reason: 'busy' });
    expect(frame[6]).toBe(0xf9);
    expect(decodeServerMessage(frame)).toEqual({ type: 'ack', opId: 6, ok: false, reason: 'busy' });
  });

  it('appends no_item as status 7', () => {
    expect(encodeServerMessage({ type: 'ack', opId: 1, ok: false, reason: 'no_item' })[6]).toBe(7);
  });

  it('pins the hold frame layout', () => {
    const frame = encodeServerMessage({
      type: 'hold',
      capacity: 3,
      cooldown: 60_000,
      nextIn: null,
      revision: 258,
      items: [{ kind: 'brick', shape: 2 }, { kind: 'shield' }, { kind: 'hammer' }],
    });
    expect([...frame]).toEqual([
      1, 0x83, 3, 3, 0x60, 0xea, 0, 0, 0xff, 0xff, 0xff, 0xff, 2, 1, 0, 0, 0, 2, 3, 0xff, 2, 0xff,
    ]);
    expect(() => decodeServerMessage(frame.subarray(0, 21))).toThrow(ProtocolError);
    expect(() =>
      encodeServerMessage({
        type: 'hold',
        capacity: 3,
        cooldown: 1,
        nextIn: 0xffffffff,
        revision: 0,
        items: [],
      }),
    ).toThrow(ProtocolError);
  });

  it('refuses a diff batch that does not fit one frame', () => {
    const diffs = Array.from({ length: MAX_DIFFS_PER_FRAME + 1 }, () => ({
      index: 0,
      cell: 0,
      shield: 0,
    }));
    expect(() => encodeServerMessage({ type: 'diffs', seq: 1, diffs })).toThrow(ProtocolError);
  });
});

describe('config frames', () => {
  const config: ServerMessage = {
    type: 'config',
    mapSize: 2048,
    open: { x: 512, y: 512, w: 1024, h: 1024 },
    maxShield: 5,
  };

  it('round-trips, including an open area that fills the map', () => {
    expect(decodeServerMessage(encodeServerMessage(config))).toEqual(config);
    const full = { ...config, mapSize: 8192, open: { x: 0, y: 0, w: 8192, h: 8192 } };
    expect(decodeServerMessage(encodeServerMessage(full))).toEqual(full);
  });

  it('pins the config frame layout as an appended opcode, without a version bump', () => {
    expect(Opcode.Config).toBe(0x84);
    expect(PROTOCOL_VERSION).toBe(1);
    expect([...encodeServerMessage(config)]).toEqual([
      1, 0x84, 0x00, 0x08, 0x00, 0x02, 0x00, 0x02, 0x00, 0x04, 0x00, 0x04, 5,
    ]);
  });

  it('refuses an open area outside the map, a zero map and short frames', () => {
    const outside = { ...config, open: { x: 1536, y: 0, w: 1024, h: 1024 } };
    expect(() => encodeServerMessage(outside)).toThrow(ProtocolError);
    expect(() => encodeServerMessage({ ...config, mapSize: 0 })).toThrow(ProtocolError);
    expect(() => encodeServerMessage({ ...config, maxShield: 256 })).toThrow(ProtocolError);
    const frame = encodeServerMessage(config);
    expect(() => decodeServerMessage(frame.subarray(0, 12))).toThrow(ProtocolError);
    const bad = frame.slice();
    bad[9] = 0x08; // w = 2048 from x = 512: past the map's edge
    expect(() => decodeServerMessage(bad)).toThrow(ProtocolError);
  });

  it('appends area locks after maxShield, which older readers stop before (ADR 0024)', () => {
    const locked: ServerMessage = {
      ...config,
      locks: [
        { x: 600, y: 700, w: 16, h: 8 },
        { x: 0, y: 0, w: 2048, h: 1 },
      ],
    } as ServerMessage;
    const frame = encodeServerMessage(locked);
    expect([...frame.subarray(0, 13)]).toEqual([...encodeServerMessage(config)]);
    expect([...frame.subarray(13)]).toEqual([
      2, 0x58, 0x02, 0xbc, 0x02, 16, 0, 8, 0, 0, 0, 0, 0, 0x00, 0x08, 1, 0,
    ]);
    expect(decodeServerMessage(frame)).toEqual(locked);
    // An empty list is sent as a zero count, so a client can tell "no locks" from "unknown".
    const none = encodeServerMessage({ ...config, locks: [] } as ServerMessage);
    expect(none.length).toBe(14);
    expect(decodeServerMessage(none)).toEqual({ ...config, locks: [] });
    // Without locks the frame is unchanged, and decodes without them.
    expect(decodeServerMessage(encodeServerMessage(config))).not.toHaveProperty('locks');
    expect(() => decodeServerMessage(frame.subarray(0, 20))).toThrow(ProtocolError);
    const outside = { ...config, locks: [{ x: 2040, y: 0, w: 16, h: 1 }] } as ServerMessage;
    expect(() => encodeServerMessage(outside)).toThrow(ProtocolError);
  });
});

describe('views and tiles (ADR 0028)', () => {
  const config: ServerMessage = {
    type: 'config',
    mapSize: 2048,
    open: { x: 512, y: 512, w: 1024, h: 1024 },
    maxShield: 5,
  };

  it('appends View (0x06) and Tile (0x85) without a version bump', () => {
    expect(Opcode.View).toBe(0x06);
    expect(Opcode.Tile).toBe(0x85);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('round-trips a view of cells and pins its layout', () => {
    const view: ClientView = { view: { x: 600, y: 3, w: 4, h: 1 } };
    const frame = encodeClientView(view);
    expect([...frame]).toEqual([1, 0x06, 0x58, 0x02, 3, 0, 4, 0, 1, 0]);
    expect(decodeClientMessage(frame)).toEqual(view);
    expect(() => decodeClientMessage(frame.subarray(0, 9))).toThrow(ProtocolError);
    expect(() => encodeClientView({ view: { x: -1, y: 0, w: 1, h: 1 } })).toThrow(ProtocolError);
    // A view is not an op: the op decoder refuses it.
    expect(() => decodeClientOp(frame)).toThrow(ProtocolError);
  });

  it('appends the subscribe flag, which readers of the plain view stop before (ADR 0028)', () => {
    const subscribing: ClientView = { view: { x: 600, y: 3, w: 4, h: 1 }, subscribe: true };
    const frame = encodeClientView(subscribing);
    expect([...frame]).toEqual([1, 0x06, 0x58, 0x02, 3, 0, 4, 0, 1, 0, 1]);
    expect(decodeClientMessage(frame)).toEqual(subscribing);
    expect(decodeClientMessage(encodeClientView({ ...subscribing, subscribe: false }))).toEqual({
      ...subscribing,
      subscribe: false,
    });
  });

  it('names the tiles a subscribing view follows: touched ones plus a margin', () => {
    // Cells 600..799 by 600..699: tiles 2..3 by 2, one more around each side.
    expect(viewTiles({ x: 600, y: 600, w: 200, h: 100 }, 2048)).toEqual({
      x: 1,
      y: 1,
      w: 4,
      h: 3,
    });
    // Up to the map's edges, and nothing for an empty view.
    expect(viewTiles({ x: 0, y: 0, w: 2048, h: 2048 }, 2048)).toEqual({ x: 0, y: 0, w: 8, h: 8 });
    expect(viewTiles({ x: 2000, y: 0, w: 48, h: 1 }, 2048)).toEqual({ x: 6, y: 0, w: 2, h: 2 });
    expect(viewTiles({ x: 5, y: 5, w: 0, h: 9 }, 2048)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('appends the views feature after the locks, which older readers stop before', () => {
    const withViews = { ...config, views: true } as ServerMessage;
    const frame = encodeServerMessage(withViews);
    // The lock count (0) comes first, so a reader of locks still reads a valid frame.
    expect([...frame.subarray(13)]).toEqual([0, 1]);
    expect(decodeServerMessage(frame)).toEqual({ ...config, locks: [], views: true });
    const locked = {
      ...config,
      locks: [{ x: 600, y: 700, w: 16, h: 8 }],
      views: true,
    } as ServerMessage;
    expect(decodeServerMessage(encodeServerMessage(locked))).toEqual(locked);
    const off = { ...config, locks: [], views: false } as ServerMessage;
    expect(decodeServerMessage(encodeServerMessage(off))).toEqual(off);
    // Without the feature the frame is byte for byte what it was.
    expect(decodeServerMessage(encodeServerMessage(config))).not.toHaveProperty('views');
  });

  /** A tile of edge 256 with `filled` non-empty cells spread over it. */
  function tile(filled: number): Extract<ServerMessage, { type: 'tile' }> {
    const edge = 256;
    const cells = new Uint8Array(edge * edge);
    const shields = new Uint8Array(edge * edge);
    for (let i = 0; i < filled; i++) {
      const at = (i * 7919) % (edge * edge);
      cells[at] = (i % 200) + 1;
      shields[at] = i % 3;
    }
    return { type: 'tile', seq: 77, tx: 3, ty: 7, edge, cells, shields };
  }

  /**
   * Same tile, with its 64K-cell arrays compared in a plain loop: `toEqual` walks typed arrays
   * element by element through its generic equality, 0.35 s here and over 5 s on a 2-CPU CI
   * runner.
   */
  function expectSameTile(actual: ServerMessage, expected: ReturnType<typeof tile>): void {
    if (actual.type !== 'tile') throw new Error(`expected a tile, got ${actual.type}`);
    const { cells, shields, ...rest } = actual;
    const { cells: wantCells, shields: wantShields, ...wantRest } = expected;
    expect(rest).toEqual(wantRest);
    expect(cells).toBeInstanceOf(Uint8Array);
    expect(shields).toBeInstanceOf(Uint8Array);
    expect(firstDifference(cells, wantCells)).toBe(-1);
    expect(firstDifference(shields, wantShields)).toBe(-1);
  }

  /** The first index where the arrays differ, the shorter length if one is a prefix, else -1. */
  function firstDifference(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
  }

  it('sends a sparse tile as its non-empty cells and reads it back dense', () => {
    const msg = tile(100);
    const frame = encodeServerMessage(msg);
    expect(frame.byteLength).toBe(13 + 4 + 100 * 4);
    expect(frame[12]).toBe(0);
    expectSameTile(decodeServerMessage(frame), msg);
    // An empty tile costs its header and a zero count.
    expect(encodeServerMessage(tile(0)).byteLength).toBe(17);
    expectSameTile(decodeServerMessage(encodeServerMessage(tile(0))), tile(0));
  });

  it('sends a full tile dense, whichever is smaller', () => {
    const msg = tile(40_000);
    const frame = encodeServerMessage(msg);
    expect(frame[12]).toBe(1);
    expect(frame.byteLength).toBe(13 + 2 * 256 * 256);
    expectSameTile(decodeServerMessage(frame), msg);
  });

  it('pins the tile header and refuses bad tiles', () => {
    const frame = encodeServerMessage(tile(1));
    expect([...frame.subarray(0, 21)]).toEqual([
      1, 0x85, 77, 0, 0, 0, 3, 0, 7, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0,
    ]);
    expect(() => decodeServerMessage(frame.subarray(0, 18))).toThrow(ProtocolError);
    const unknown = frame.slice();
    unknown[12] = 9;
    expect(() => decodeServerMessage(unknown)).toThrow(ProtocolError);
    const short = { ...tile(0), cells: new Uint8Array(10) };
    expect(() => encodeServerMessage(short)).toThrow(ProtocolError);
    // A sparse cell outside the tile is refused, not written past it.
    const small: ServerMessage = {
      type: 'tile',
      seq: 1,
      tx: 0,
      ty: 0,
      edge: 4,
      cells: new Uint8Array(16).fill(5, 15),
      shields: new Uint8Array(16),
    };
    expect(decodeServerMessage(encodeServerMessage(small))).toEqual(small);
    const outside = encodeServerMessage(small).slice();
    expect(outside[12]).toBe(0);
    outside[17] = 16;
    expect(() => decodeServerMessage(outside)).toThrow(ProtocolError);
  });
});

describe('stats frames (ADR 0030)', () => {
  it('round-trips the counts, with and without a team', () => {
    for (const msg of [
      { type: 'stats', playing: 1284, team: 12 },
      { type: 'stats', playing: 0, team: null },
      { type: 'stats', playing: 0xfffffffe, team: 0 },
    ] as const) {
      const bytes = encodeServerMessage(msg);
      expect(bytes[0]).toBe(PROTOCOL_VERSION);
      expect(bytes[1]).toBe(Opcode.Stats);
      expect(bytes.byteLength).toBe(10);
      expect(decodeServerMessage(bytes)).toEqual(msg);
    }
  });

  it('refuses counts that would read as no team, and a short frame', () => {
    expect(() => encodeServerMessage({ type: 'stats', playing: 1, team: 0xffffffff })).toThrow(
      ProtocolError,
    );
    expect(() => encodeServerMessage({ type: 'stats', playing: -1, team: null })).toThrow(
      ProtocolError,
    );
    const bytes = encodeServerMessage({ type: 'stats', playing: 3, team: 1 });
    expect(() => decodeServerMessage(bytes.subarray(0, 9))).toThrow(ProtocolError);
  });
});

describe('resume frames (ADR 0040)', () => {
  it('round-trips the seq the changes start after, and refuses one out of range', () => {
    for (const from of [0, 1234, 0xffffffff]) {
      const bytes = encodeServerMessage({ type: 'resume', from });
      expect([bytes[0], bytes[1], bytes.byteLength]).toEqual([PROTOCOL_VERSION, Opcode.Resume, 6]);
      expect(decodeServerMessage(bytes)).toEqual({ type: 'resume', from });
    }
    expect(() => encodeServerMessage({ type: 'resume', from: -1 })).toThrow(ProtocolError);
    const bytes = encodeServerMessage({ type: 'resume', from: 7 });
    expect(() => decodeServerMessage(bytes.subarray(0, 5))).toThrow(ProtocolError);
  });
});

describe('encoder bounds', () => {
  it('refuses values that would wrap', () => {
    expect(() => encodeClientOp({ opId: 1, op: { kind: 'hammer', x: 70_000, y: 0 } })).toThrow(
      ProtocolError,
    );
    expect(() => encodeClientOp({ opId: -1, op: { kind: 'hammer', x: 0, y: 0 } })).toThrow(
      ProtocolError,
    );
  });
});
