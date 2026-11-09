import type { CellDiff, Item, Op, Rect, RejectReason, Rotation, ShapeId } from '@brickplace/core';
import { ITEM_KINDS, REJECT_REASONS, TILE_SIZE } from '@brickplace/core';

// Wire format, little-endian. Every frame starts with [version u8][opcode u8].
// Bump PROTOCOL_VERSION on any incompatible change; servers must keep decoding the
// previous version until every client has reloaded. New opcodes and reject statuses are
// appended, never renumbered, so adding one is not an incompatible change.
export const PROTOCOL_VERSION = 1;

export const Opcode = {
  Brick: 0x01,
  Hammer: 0x02,
  Shield: 0x03,
  Single: 0x04,
  Discard: 0x05,
  /** Appended: the cells a page shows (bot signal, ADR 0026; per-tile diffs, ADR 0028). */
  View: 0x06,
  Ack: 0x81,
  Diffs: 0x82,
  Hold: 0x83,
  Config: 0x84,
  /** Appended for per-tile subscriptions (ADR 0028): one tile's whole content at a seq. */
  Tile: 0x85,
  /** Appended for live counts (ADR 0030): who is playing, on the canvas and in the team. */
  Stats: 0x86,
  /** Appended (ADR 0040): the socket's first Diffs frames are changes since `from`, not a map. */
  Resume: 0x87,
} as const;

export class ProtocolError extends Error {}

/**
 * A player action, tagged with a client-chosen id so the client can match the ack.
 * The id is also an idempotency key: the server remembers accepted ops by (player,
 * connection id, opId) for a recent window (ADR 0017), so resending the same op with the
 * same id after an `unavailable` ack never applies it twice. The connection id is a random
 * value the page sends once in the socket URL (`?client=`) and keeps across reconnects.
 * Clients must therefore never reuse an id for a different op under the same connection id.
 */
export interface ClientOp {
  readonly opId: number;
  readonly op: Op;
}

/**
 * Throws one held item away to make room. Answered by an ack like an op (`no_item` when the
 * hold has no such item), deduplicated by the same (player, opId) key.
 */
export interface ClientDiscard {
  readonly opId: number;
  readonly discard: Item;
}

/**
 * The cells the page shows, clamped to the map (ADR 0026): sent by a playing page when its
 * camera settles and after each socket opens. Not acked and never resent. The server compares
 * ops with it as a bot signal. Servers that predate it close the socket (1002), so the realtime
 * script ships before a client that sends it. With `subscribe` (ADR 0028) the socket then gets
 * live diffs only for the tiles `viewTiles` names (the view plus a margin), and each tile newly
 * among them comes first as a Tile frame with its content at the seq the diffs continue from.
 * A socket that never subscribes gets every tile, as before. Subscribe only on a server whose
 * config frame says `views`; an older one ignores the flag.
 */
export interface ClientView {
  readonly view: Rect;
  /** Appended flags byte, bit 0 (ADR 0028); absent from frames of clients that predate it. */
  readonly subscribe?: boolean;
}

export type ClientMessage = ClientOp | ClientDiscard | ClientView;

/** Edge (cells) of the tiles a subscription and Tile frames count in: the map's tiles. */
export const VIEW_TILE = TILE_SIZE;
/** Tiles around the view a subscription takes in too, so a short pan never shows a stale tile. */
export const VIEW_MARGIN = 1;

/**
 * The tiles (a rectangle in tiles) a subscribing view of these cells follows on a map of edge
 * `mapSize`: every tile the cells touch, plus VIEW_MARGIN tiles around, clamped to the map.
 * Server and client both use it, so they agree on which tiles stay live. An empty view
 * follows no tile.
 */
export function viewTiles(cells: Rect, mapSize: number): Rect {
  const perSide = Math.max(1, Math.ceil(mapSize / VIEW_TILE));
  if (cells.w <= 0 || cells.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const clamp = (t: number) => Math.min(perSide - 1, Math.max(0, t));
  const x0 = clamp(Math.floor(cells.x / VIEW_TILE) - VIEW_MARGIN);
  const y0 = clamp(Math.floor(cells.y / VIEW_TILE) - VIEW_MARGIN);
  const x1 = clamp(Math.floor((cells.x + cells.w - 1) / VIEW_TILE) + VIEW_MARGIN);
  const y1 = clamp(Math.floor((cells.y + cells.h - 1) / VIEW_TILE) + VIEW_MARGIN);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Rule rejections from the core, plus `unavailable`: the server could not confirm the op.
 * It may or may not have been applied; resend it with the same opId (see ClientOp).
 * `signed_out`: the socket watches without an account (or before a nickname is chosen), so
 * it cannot act; nothing was applied and resending will not help until the player signs in.
 * `ended`: the season this socket plays is over (ADR 0021); nothing was applied. A reload
 * reaches the current season (the gateway routes there); pages say so.
 * `read_only`: the map is paused (an admin or emergency switch, ADR 0021); nothing was
 * applied, and resending helps only once it is lifted.
 * `locked`: the op touches an area moderators locked (ADR 0024, listed in the config frame);
 * nothing was applied, and the item stays in the hold.
 * `limited`: the account may use only a few hammers and shields for now (ADR 0026: a new or
 * low-trust account); nothing was applied, the item stays in the hold, and the same move
 * works again later. Resending at once does not help.
 * `busy`: the canvas is behind and sheds new moves (ADR 0032); nothing was applied, the item
 * stays in the hold, and the player may try again in a few seconds. Not resent on its own.
 */
export type AckReason =
  | RejectReason
  | 'unavailable'
  | 'signed_out'
  | 'ended'
  | 'read_only'
  | 'locked'
  | 'limited'
  | 'busy';

/**
 * Diff frames: on connect, the server first sends the non-empty cells of the current grid as
 * one or more frames sharing one seq (at least one frame, even for an empty grid), then live
 * frames with increasing seqs. A seq may jump: that frame then carries every cell changed
 * since the previous one, so the client stays complete without asking for anything. When the
 * server cannot tell what a client missed, it closes the socket with 1012 instead; the client
 * reconnects and starts again from a fresh grid.
 */

export type ServerMessage =
  | { readonly type: 'ack'; readonly opId: number; readonly ok: true }
  | {
      readonly type: 'ack';
      readonly opId: number;
      readonly ok: false;
      readonly reason: AckReason;
    }
  | { readonly type: 'diffs'; readonly seq: number; readonly diffs: readonly CellDiff[] }
  | HoldMessage
  | ConfigMessage
  | TileMessage
  | StatsMessage
  | ResumeMessage;

/**
 * Sent first on a socket opened with `?since=` that the server can resume (ADR 0040): the
 * Diffs frames that follow, all at one seq, are the cells changed after `from` (at or below
 * the page's since), not the whole map. The page applies them to the map it holds. Pages that
 * send no since never get one.
 */
export interface ResumeMessage {
  readonly type: 'resume';
  readonly from: number;
}

/**
 * Who is playing (ADR 0030), sent to a playing socket about every 30 s and when it joins:
 * players with a socket open on the whole canvas, and those of the socket's own team. Counts
 * only, as the shards last reported them. Older clients skip the frame.
 */
export interface StatsMessage {
  readonly type: 'stats';
  readonly playing: number;
  /** Players of this socket's team, itself included; null when it plays for no team. */
  readonly team: number | null;
}

/**
 * One tile's whole content as of `seq` (ADR 0028), sent when a socket's view takes in a tile it
 * did not follow: the client replaces its copy, and the live diffs after it continue from
 * `seq`. Encoded sparse (only the non-empty cells) or dense, whichever is smaller; decoded
 * dense. Older clients skip the frame (and never ask for one).
 */
export interface TileMessage {
  readonly type: 'tile';
  readonly seq: number;
  /** Tile column and row, from the map's corner. */
  readonly tx: number;
  readonly ty: number;
  /** Tile edge in cells. */
  readonly edge: number;
  /** edge² cell bytes, row-major within the tile. */
  readonly cells: Uint8Array;
  /** edge² shield bytes, the same way. */
  readonly shields: Uint8Array;
}

/**
 * The canvas rules a client needs to draw the map and check a move before sending it: sent
 * after the initial grid on connect, and again whenever they change (the open area grows).
 * Until it arrives a client keeps its built-in defaults; older clients skip the frame.
 */
export interface ConfigMessage {
  readonly type: 'config';
  /** Map edge in cells. */
  readonly mapSize: number;
  /** Area players may act in; it only grows during a season. */
  readonly open: Rect;
  /** Most shield layers a cell can hold. */
  readonly maxShield: number;
  /**
   * Areas where moderators stopped play (ADR 0024): ops touching one are refused with
   * `locked`. Empty when there are none; absent from servers that predate locks.
   */
  readonly locks?: readonly Rect[];
  /**
   * The server takes subscribing View frames (ADR 0028): a client may then narrow its live
   * diffs to the tiles it shows. Absent from servers that predate it.
   */
  readonly views?: boolean;
}

/**
 * The player's hold, sent on connect and after every change (an op, a discard, an item
 * arriving). The server decides everything here; the client only shows it.
 */
export interface HoldMessage {
  readonly type: 'hold';
  /** Most items the hold can take. */
  readonly capacity: number;
  /** Length of one cooldown (ms), for a progress bar. */
  readonly cooldown: number;
  /**
   * Milliseconds from sending until the next item arrives, or null while the hold is full.
   * Relative, so a client clock that is off does not matter.
   */
  readonly nextIn: number | null;
  /**
   * Grows with every change of this player's hold. Holds can arrive out of order (two
   * replies racing); a client keeps the one with the highest revision. Equal revisions are
   * the same hold.
   */
  readonly revision: number;
  readonly items: readonly Item[];
}

const HEADER = 2;
const UNAVAILABLE = 0xff;
const SIGNED_OUT = 0xfe;
// Appended for seasons (ADR 0021), counting down from the top like the two above, so the core's
// reasons keep counting up from 1. Older clients skip an ack they cannot read; the op then
// times out as unconfirmed.
const ENDED = 0xfd;
const READ_ONLY = 0xfc;
/** Appended for area locks (ADR 0024), the same way. */
const LOCKED = 0xfb;
/** Appended for the trust allowance (ADR 0026), the same way. */
const LIMITED = 0xfa;
/** Appended for load shedding (ADR 0032), the same way. */
const BUSY = 0xf9;
/** Canvas-level statuses: not rule rejections, so they are not in the core's list. */
const CANVAS_STATUSES = {
  unavailable: UNAVAILABLE,
  signed_out: SIGNED_OUT,
  ended: ENDED,
  read_only: READ_ONLY,
  locked: LOCKED,
  limited: LIMITED,
  busy: BUSY,
} as const;
/** Most locks a config frame carries (a u8 count); the canvas holds far fewer. */
export const MAX_CONFIG_LOCKS = 0xff;
const CANVAS_REASONS = new Map<number, AckReason>(
  Object.entries(CANVAS_STATUSES).map(([reason, status]) => [status, reason as AckReason]),
);
/** `nextIn` when no item is coming (the hold is full). */
const NO_NEXT = 0xffffffff;
const NO_SHAPE = 0xff;
const SHAPES = 7;
/** Most diffs one frame can carry (u16 count); callers split larger batches. */
export const MAX_DIFFS_PER_FRAME = 0xffff;

function checkRange(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ProtocolError(`${name} ${value} out of range 0..${max}`);
  }
}

function header(view: DataView, opcode: number): void {
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, opcode);
}

function readHeader(bytes: Uint8Array): { view: DataView; opcode: number } {
  if (bytes.byteLength < HEADER) throw new ProtocolError('frame too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION) throw new ProtocolError('unsupported version');
  return { view, opcode: view.getUint8(1) };
}

function need(view: DataView, length: number): void {
  if (view.byteLength < length) throw new ProtocolError('frame too short');
}

// [hdr][opId u32][x u16][y u16] then, for bricks, [shape u8][rotation u8][color u8],
// and for single bricks [color u8]
export function encodeClientOp({ opId, op }: ClientOp): Uint8Array {
  checkRange('opId', opId, 0xffffffff);
  checkRange('x', op.x, 0xffff);
  checkRange('y', op.y, 0xffff);
  let view: DataView;
  switch (op.kind) {
    case 'brick':
      checkRange('shape', op.shape, 0xff);
      checkRange('rotation', op.rotation, 0xff);
      checkRange('color', op.color, 0xff);
      view = new DataView(new ArrayBuffer(HEADER + 11));
      header(view, Opcode.Brick);
      view.setUint8(10, op.shape);
      view.setUint8(11, op.rotation);
      view.setUint8(12, op.color);
      break;
    case 'single':
      checkRange('color', op.color, 0xff);
      view = new DataView(new ArrayBuffer(HEADER + 9));
      header(view, Opcode.Single);
      view.setUint8(10, op.color);
      break;
    default:
      view = new DataView(new ArrayBuffer(HEADER + 8));
      header(view, op.kind === 'hammer' ? Opcode.Hammer : Opcode.Shield);
  }
  view.setUint32(2, opId, true);
  view.setUint16(6, op.x, true);
  view.setUint16(8, op.y, true);
  return new Uint8Array(view.buffer);
}

export function decodeClientOp(bytes: Uint8Array): ClientOp {
  const { view, opcode } = readHeader(bytes);
  need(view, HEADER + 8);
  const opId = view.getUint32(2, true);
  const x = view.getUint16(6, true);
  const y = view.getUint16(8, true);
  switch (opcode) {
    case Opcode.Brick:
      need(view, HEADER + 11);
      return {
        opId,
        op: {
          kind: 'brick',
          x,
          y,
          shape: view.getUint8(10) as ShapeId,
          rotation: view.getUint8(11) as Rotation,
          color: view.getUint8(12),
        },
      };
    case Opcode.Hammer:
      return { opId, op: { kind: 'hammer', x, y } };
    case Opcode.Shield:
      return { opId, op: { kind: 'shield', x, y } };
    case Opcode.Single:
      need(view, HEADER + 9);
      return { opId, op: { kind: 'single', x, y, color: view.getUint8(10) } };
    default:
      throw new ProtocolError(`unknown client opcode ${opcode}`);
  }
}

// Items: [kind u8 (index into ITEM_KINDS)][shape u8 (0xff unless a brick)]
function writeItem(view: DataView, at: number, item: Item): void {
  const kind = ITEM_KINDS.indexOf(item.kind);
  if (kind < 0) throw new ProtocolError(`unknown item kind ${item.kind}`);
  view.setUint8(at, kind);
  if (item.kind === 'brick') checkRange('shape', item.shape, SHAPES - 1);
  view.setUint8(at + 1, item.kind === 'brick' ? item.shape : NO_SHAPE);
}

function readItem(view: DataView, at: number): Item {
  const kind = ITEM_KINDS[view.getUint8(at)];
  if (!kind) throw new ProtocolError(`unknown item kind ${view.getUint8(at)}`);
  if (kind !== 'brick') return { kind };
  const shape = view.getUint8(at + 1);
  if (shape >= SHAPES) throw new ProtocolError(`unknown shape ${shape}`);
  return { kind, shape: shape as ShapeId };
}

// Discard: [hdr][opId u32][item: kind u8, shape u8]
export function encodeClientDiscard({ opId, discard }: ClientDiscard): Uint8Array {
  checkRange('opId', opId, 0xffffffff);
  const view = new DataView(new ArrayBuffer(HEADER + 6));
  header(view, Opcode.Discard);
  view.setUint32(2, opId, true);
  writeItem(view, 6, discard);
  return new Uint8Array(view.buffer);
}

/** View flag (the appended byte): the socket wants diffs only for the view's tiles. */
const VIEW_SUBSCRIBE = 1;

// View: [hdr][x u16][y u16][w u16][h u16], the cells the page shows (clamped to the map)
//       then, appended for subscriptions (ADR 0028; older readers stop before it):
//       [flags u8], bit 0 = subscribe
export function encodeClientView({ view: area, subscribe }: ClientView): Uint8Array {
  for (const key of ['x', 'y', 'w', 'h'] as const) checkRange(`view.${key}`, area[key], 0xffff);
  const view = new DataView(new ArrayBuffer(HEADER + 8 + (subscribe === undefined ? 0 : 1)));
  header(view, Opcode.View);
  view.setUint16(2, area.x, true);
  view.setUint16(4, area.y, true);
  view.setUint16(6, area.w, true);
  view.setUint16(8, area.h, true);
  if (subscribe !== undefined) view.setUint8(10, subscribe ? VIEW_SUBSCRIBE : 0);
  return new Uint8Array(view.buffer);
}

/**
 * Any client frame: an op, a discard or a view (told apart by `'discard' in message` and
 * `'view' in message`).
 */
export function decodeClientMessage(bytes: Uint8Array): ClientMessage {
  const { view, opcode } = readHeader(bytes);
  if (opcode === Opcode.View) {
    need(view, HEADER + 8);
    const area = {
      x: view.getUint16(2, true),
      y: view.getUint16(4, true),
      w: view.getUint16(6, true),
      h: view.getUint16(8, true),
    };
    // Appended for subscriptions: a frame from a client that predates them ends here.
    if (view.byteLength === HEADER + 8) return { view: area };
    return { view: area, subscribe: (view.getUint8(HEADER + 8) & VIEW_SUBSCRIBE) !== 0 };
  }
  if (opcode !== Opcode.Discard) return decodeClientOp(bytes);
  need(view, HEADER + 6);
  return { opId: view.getUint32(2, true), discard: readItem(view, 6) };
}

// Ack: [hdr][opId u32][status u8] where 0 = ok, n = REJECT_REASONS[n - 1], 255 = unavailable,
//      254 = signed_out, 253 = ended, 252 = read_only, 251 = locked, 250 = limited,
//      249 = busy
// Diffs: [hdr][seq u32][count u16] then count x [index u32][cell u8][shield u8]
// Hold: [hdr][capacity u8][count u8][cooldown u32][nextIn u32, 0xffffffff = none]
//       [revision u32] then count x [kind u8][shape u8]
// Config: [hdr][mapSize u16][open x u16][y u16][w u16][h u16][maxShield u8]
//         then, appended for area locks (ADR 0024; older readers stop before it):
//         [count u8] then count x [x u16][y u16][w u16][h u16]
//         then, appended for subscriptions (ADR 0028; older readers stop before it):
//         [features u8], bit 0 = the server takes subscribing View frames
// Tile: [hdr][seq u32][tx u16][ty u16][edge u16][layout u8] then
//       layout 0 (sparse): [count u32] then count x [cell in tile u16][cell u8][shield u8]
//       layout 1 (dense): edge² cell bytes then edge² shield bytes, row-major
// Stats: [hdr][playing u32][team u32, 0xffffffff = no team]
// Resume: [hdr][from u32]
export function encodeServerMessage(msg: ServerMessage): Uint8Array {
  if (msg.type === 'hold') return encodeHold(msg);
  if (msg.type === 'resume') {
    checkRange('from', msg.from, 0xffffffff);
    const view = new DataView(new ArrayBuffer(RESUME_BYTES));
    header(view, Opcode.Resume);
    view.setUint32(2, msg.from, true);
    return new Uint8Array(view.buffer);
  }
  if (msg.type === 'stats') {
    checkRange('playing', msg.playing, NO_TEAM - 1);
    if (msg.team !== null) checkRange('team', msg.team, NO_TEAM - 1);
    const view = new DataView(new ArrayBuffer(STATS_BYTES));
    header(view, Opcode.Stats);
    view.setUint32(2, msg.playing, true);
    view.setUint32(6, msg.team ?? NO_TEAM, true);
    return new Uint8Array(view.buffer);
  }
  if (msg.type === 'config') return encodeConfig(msg);
  if (msg.type === 'tile') return encodeTile(msg);
  if (msg.type === 'ack') {
    const view = new DataView(new ArrayBuffer(HEADER + 5));
    header(view, Opcode.Ack);
    view.setUint32(2, msg.opId, true);
    let status = 0;
    if (!msg.ok) {
      if (Object.hasOwn(CANVAS_STATUSES, msg.reason)) {
        status = CANVAS_STATUSES[msg.reason as keyof typeof CANVAS_STATUSES];
      } else {
        const index = REJECT_REASONS.indexOf(msg.reason as RejectReason);
        // A reason this build does not know must never go out as status 0 (accepted).
        if (index < 0) throw new ProtocolError(`unknown reject reason ${msg.reason}`);
        status = index + 1;
      }
    }
    view.setUint8(6, status);
    return new Uint8Array(view.buffer);
  }
  if (msg.diffs.length > MAX_DIFFS_PER_FRAME) {
    throw new ProtocolError(`${msg.diffs.length} diffs exceed one frame; split the batch`);
  }
  checkRange('seq', msg.seq, 0xffffffff);
  const view = new DataView(new ArrayBuffer(HEADER + 6 + msg.diffs.length * 6));
  header(view, Opcode.Diffs);
  view.setUint32(2, msg.seq, true);
  view.setUint16(6, msg.diffs.length, true);
  msg.diffs.forEach((d, i) => {
    const at = HEADER + 6 + i * 6;
    view.setUint32(at, d.index, true);
    view.setUint8(at + 4, d.cell);
    view.setUint8(at + 5, d.shield);
  });
  return new Uint8Array(view.buffer);
}

export function decodeServerMessage(bytes: Uint8Array): ServerMessage {
  const { view, opcode } = readHeader(bytes);
  if (opcode === Opcode.Ack) {
    need(view, HEADER + 5);
    const opId = view.getUint32(2, true);
    const status = view.getUint8(6);
    if (status === 0) return { type: 'ack', opId, ok: true };
    const reason = CANVAS_REASONS.get(status) ?? REJECT_REASONS[status - 1];
    if (!reason) throw new ProtocolError(`unknown reject status ${status}`);
    return { type: 'ack', opId, ok: false, reason };
  }
  if (opcode === Opcode.Diffs) {
    need(view, HEADER + 6);
    const seq = view.getUint32(2, true);
    const count = view.getUint16(6, true);
    need(view, HEADER + 6 + count * 6);
    const diffs: CellDiff[] = [];
    for (let i = 0; i < count; i++) {
      const at = HEADER + 6 + i * 6;
      diffs.push({
        index: view.getUint32(at, true),
        cell: view.getUint8(at + 4),
        shield: view.getUint8(at + 5),
      });
    }
    return { type: 'diffs', seq, diffs };
  }
  if (opcode === Opcode.Hold) {
    need(view, HOLD_ITEMS);
    const capacity = view.getUint8(2);
    const count = view.getUint8(3);
    const cooldown = view.getUint32(4, true);
    const next = view.getUint32(8, true);
    const revision = view.getUint32(12, true);
    need(view, HOLD_ITEMS + count * 2);
    const items: Item[] = [];
    for (let i = 0; i < count; i++) items.push(readItem(view, HOLD_ITEMS + i * 2));
    const nextIn = next === NO_NEXT ? null : next;
    return { type: 'hold', capacity, cooldown, nextIn, revision, items };
  }
  if (opcode === Opcode.Config) {
    need(view, CONFIG_BYTES);
    const mapSize = view.getUint16(2, true);
    const open = {
      x: view.getUint16(4, true),
      y: view.getUint16(6, true),
      w: view.getUint16(8, true),
      h: view.getUint16(10, true),
    };
    checkConfig(mapSize, open);
    const maxShield = view.getUint8(12);
    // Appended for locks: a frame from a server that predates them ends here.
    if (view.byteLength === CONFIG_BYTES) return { type: 'config', mapSize, open, maxShield };
    const count = view.getUint8(CONFIG_BYTES);
    const featuresAt = CONFIG_BYTES + 1 + count * 8;
    need(view, featuresAt);
    const locks: Rect[] = [];
    for (let i = 0; i < count; i++) {
      const at = CONFIG_BYTES + 1 + i * 8;
      const lock = {
        x: view.getUint16(at, true),
        y: view.getUint16(at + 2, true),
        w: view.getUint16(at + 4, true),
        h: view.getUint16(at + 6, true),
      };
      checkArea('lock', lock, mapSize);
      locks.push(lock);
    }
    // Appended for views: a frame from a server that predates them ends here.
    if (view.byteLength === featuresAt) return { type: 'config', mapSize, open, maxShield, locks };
    const views = (view.getUint8(featuresAt) & FEATURE_VIEWS) !== 0;
    return { type: 'config', mapSize, open, maxShield, locks, views };
  }
  if (opcode === Opcode.Tile) return decodeTile(view);
  if (opcode === Opcode.Stats) {
    need(view, STATS_BYTES);
    const playing = view.getUint32(2, true);
    const team = view.getUint32(6, true);
    return { type: 'stats', playing, team: team === NO_TEAM ? null : team };
  }
  if (opcode === Opcode.Resume) {
    need(view, RESUME_BYTES);
    return { type: 'resume', from: view.getUint32(2, true) };
  }
  throw new ProtocolError(`unknown server opcode ${opcode}`);
}

const STATS_BYTES = HEADER + 8;
const RESUME_BYTES = HEADER + 4;
/** A Stats frame's team count when the socket plays for no team. */
const NO_TEAM = 0xffffffff;

/** Config feature bit: the server takes View frames. */
const FEATURE_VIEWS = 1;
const TILE_HEADER = HEADER + 11;
const SPARSE = 0;
const DENSE = 1;
/** Bytes per cell in a sparse tile frame. */
const SPARSE_CELL = 4;

function checkTileGeometry(tx: number, ty: number, edge: number): void {
  checkRange('tx', tx, 0xffff);
  checkRange('ty', ty, 0xffff);
  checkRange('edge', edge, 0xffff);
  if (edge === 0) throw new ProtocolError('edge must be positive');
}

function encodeTile(msg: TileMessage): Uint8Array {
  const { seq, tx, ty, edge, cells, shields } = msg;
  checkRange('seq', seq, 0xffffffff);
  checkTileGeometry(tx, ty, edge);
  const area = edge * edge;
  if (cells.length !== area || shields.length !== area) {
    throw new ProtocolError(`a tile of edge ${edge} has ${area} cells`);
  }
  let filled = 0;
  for (let i = 0; i < area; i++) if (cells[i] !== 0 || shields[i] !== 0) filled++;
  // Sparse addresses a cell with a u16, so only tiles of at most 65,536 cells can use it.
  const sparse = area <= 0x10000 && 4 + filled * SPARSE_CELL < 2 * area;
  const bytes = new Uint8Array(TILE_HEADER + (sparse ? 4 + filled * SPARSE_CELL : 2 * area));
  const view = new DataView(bytes.buffer);
  header(view, Opcode.Tile);
  view.setUint32(2, seq, true);
  view.setUint16(6, tx, true);
  view.setUint16(8, ty, true);
  view.setUint16(10, edge, true);
  view.setUint8(12, sparse ? SPARSE : DENSE);
  if (!sparse) {
    bytes.set(cells, TILE_HEADER);
    bytes.set(shields, TILE_HEADER + area);
    return bytes;
  }
  view.setUint32(TILE_HEADER, filled, true);
  let at = TILE_HEADER + 4;
  for (let i = 0; i < area; i++) {
    if (cells[i] === 0 && shields[i] === 0) continue;
    view.setUint16(at, i, true);
    view.setUint8(at + 2, cells[i]!);
    view.setUint8(at + 3, shields[i]!);
    at += SPARSE_CELL;
  }
  return bytes;
}

function decodeTile(view: DataView): TileMessage {
  need(view, TILE_HEADER);
  const seq = view.getUint32(2, true);
  const tx = view.getUint16(6, true);
  const ty = view.getUint16(8, true);
  const edge = view.getUint16(10, true);
  checkTileGeometry(tx, ty, edge);
  const area = edge * edge;
  const layout = view.getUint8(12);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (layout === DENSE) {
    need(view, TILE_HEADER + 2 * area);
    const cells = bytes.slice(TILE_HEADER, TILE_HEADER + area);
    const shields = bytes.slice(TILE_HEADER + area, TILE_HEADER + 2 * area);
    return { type: 'tile', seq, tx, ty, edge, cells, shields };
  }
  if (layout !== SPARSE) throw new ProtocolError(`unknown tile layout ${layout}`);
  need(view, TILE_HEADER + 4);
  const count = view.getUint32(TILE_HEADER, true);
  need(view, TILE_HEADER + 4 + count * SPARSE_CELL);
  const cells = new Uint8Array(area);
  const shields = new Uint8Array(area);
  for (let i = 0; i < count; i++) {
    const at = TILE_HEADER + 4 + i * SPARSE_CELL;
    const cell = view.getUint16(at, true);
    if (cell >= area) throw new ProtocolError(`cell ${cell} outside a tile of edge ${edge}`);
    cells[cell] = view.getUint8(at + 2);
    shields[cell] = view.getUint8(at + 3);
  }
  return { type: 'tile', seq, tx, ty, edge, cells, shields };
}

const CONFIG_BYTES = HEADER + 11;

/** A map edge of at least one cell and an open area inside it. */
function checkConfig(mapSize: number, open: Rect): void {
  checkRange('mapSize', mapSize, 0xffff);
  if (mapSize === 0) throw new ProtocolError('mapSize must be positive');
  checkArea('open area', open, mapSize);
}

/** A rectangle inside a map of edge `mapSize`. */
function checkArea(name: string, area: Rect, mapSize: number): void {
  for (const key of ['x', 'y', 'w', 'h'] as const) checkRange(`${name}.${key}`, area[key], mapSize);
  if (area.x + area.w > mapSize || area.y + area.h > mapSize) {
    throw new ProtocolError(`${name} must lie inside the map`);
  }
}

function encodeConfig(msg: ConfigMessage): Uint8Array {
  checkConfig(msg.mapSize, msg.open);
  checkRange('maxShield', msg.maxShield, 0xff);
  const locks = msg.locks ?? [];
  checkRange('locks', locks.length, MAX_CONFIG_LOCKS);
  for (const lock of locks) checkArea('lock', lock, msg.mapSize);
  // Without locks (or features) the frame stays as it was, byte for byte. Features come after
  // the locks, so a frame with features always carries the lock count, 0 or more.
  const withLocks = msg.locks !== undefined || msg.views !== undefined;
  const featuresAt = CONFIG_BYTES + 1 + locks.length * 8;
  const length = msg.views !== undefined ? featuresAt + 1 : withLocks ? featuresAt : CONFIG_BYTES;
  const view = new DataView(new ArrayBuffer(length));
  if (msg.views !== undefined) view.setUint8(featuresAt, msg.views ? FEATURE_VIEWS : 0);
  if (withLocks) {
    view.setUint8(CONFIG_BYTES, locks.length);
    locks.forEach((lock, i) => {
      const at = CONFIG_BYTES + 1 + i * 8;
      view.setUint16(at, lock.x, true);
      view.setUint16(at + 2, lock.y, true);
      view.setUint16(at + 4, lock.w, true);
      view.setUint16(at + 6, lock.h, true);
    });
  }
  header(view, Opcode.Config);
  view.setUint16(2, msg.mapSize, true);
  view.setUint16(4, msg.open.x, true);
  view.setUint16(6, msg.open.y, true);
  view.setUint16(8, msg.open.w, true);
  view.setUint16(10, msg.open.h, true);
  view.setUint8(12, msg.maxShield);
  return new Uint8Array(view.buffer);
}

/** Offset of the first item in a hold frame. */
const HOLD_ITEMS = HEADER + 14;

function encodeHold(msg: HoldMessage): Uint8Array {
  checkRange('capacity', msg.capacity, 0xff);
  checkRange('items', msg.items.length, 0xff);
  checkRange('cooldown', msg.cooldown, 0xffffffff);
  checkRange('revision', msg.revision, 0xffffffff);
  if (msg.nextIn !== null) checkRange('nextIn', msg.nextIn, NO_NEXT - 1);
  const view = new DataView(new ArrayBuffer(HOLD_ITEMS + msg.items.length * 2));
  header(view, Opcode.Hold);
  view.setUint8(2, msg.capacity);
  view.setUint8(3, msg.items.length);
  view.setUint32(4, msg.cooldown, true);
  view.setUint32(8, msg.nextIn ?? NO_NEXT, true);
  view.setUint32(12, msg.revision, true);
  msg.items.forEach((item, i) => {
    writeItem(view, HOLD_ITEMS + i * 2, item);
  });
  return new Uint8Array(view.buffer);
}
