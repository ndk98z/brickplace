// k6 diff delivery (ADR 0028): senders place bricks, watchers on every FanoutDO shard measure
// how long each brick takes to reach them and how many bytes of live frames they receive, with
// and without tile views.
//
// Local dev (never production; staging only in an agreed window, see README.md):
//   pnpm dev   # in another terminal; add `--var FANOUT_SHARDS:4` to spread sockets over shards
//   k6 run -e WS_URL=ws://localhost:8787/ws tools/loadtest/diff-latency.js
//
// How latency is measured without a shared clock between virtual users: every brick goes to a
// spot in the target tile (TILE, inside the open area a new canvas starts with) that encodes
// when it was sent, one 4x4 slot per SLOT_MS since the start. A watcher that sees a slot's
// cells subtracts that time from now (k6 runs every VU on one clock), ±SLOT_MS/2.
//
// Environment:
//   WS_URL     socket URL (default ws://localhost:8787/ws)
//   WATCHERS   watch-only sockets (default 100): half view the target tile and its neighbours
//              ("near"), half the map corner farthest from it ("far")
//   SENDERS    senders (default 10). Without BOT_KEY each brick is a fresh dev identity
//              (`?player=`, local dev only: the gateway takes it only with ENVIRONMENT=dev).
//              With BOT_KEY each sender is one staging bot (ADR 0034) on one socket for the
//              whole run, playing every brick its hold gets: up to 3 at once, then about one a
//              minute, so give a staging run more senders (100-200)
//   BOT_KEY    staging's bot key (docs/ops/setup.md, step 8); wss:// only
//   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
//              staging's Cloudflare Access service token (ADR 0045, amended), sent on every
//              socket; both or neither, wss:// only
//   BOT_FIRST  first bot number for the senders (default 900000, clear of tools/bots' 1...)
//   DURATION   seconds (default 40; at most SLOTS * SLOT_MS)
//   VIEWS      1 (default): watchers send their view when the server takes views; 0: they
//              never do and get every tile, as clients before ADR 0028
//   SLOT_MS    width of a time slot (default 20)
//   MAP_SIZE   the canvas's map edge (default 1024, the launch map of ADR 0027)
//   TILE       target tile `column,row`, each inside the open area a new canvas starts with
//              (1 or 2 at 1024², 2 to 5 at 2048²; default: the first one); a fresh one per run
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import ws from 'k6/ws';

const WS_URL = __ENV.WS_URL || 'ws://localhost:8787/ws';
const WATCHERS = Number(__ENV.WATCHERS ?? 100);
const SENDERS = Number(__ENV.SENDERS ?? 10);
const DURATION = Number(__ENV.DURATION ?? 40) * 1000;
const VIEWS = (__ENV.VIEWS ?? '1') === '1';
const SLOT_MS = Number(__ENV.SLOT_MS ?? 20);
const BOT_KEY = __ENV.BOT_KEY || '';
const BOT_FIRST = Number(__ENV.BOT_FIRST ?? 900000);
if (BOT_KEY && !WS_URL.startsWith('wss://')) throw new Error('the bot key goes over wss:// only');
const ACCESS = accessHeaders();
/** Socket params: the Access token, if any, plus `extra` headers. */
function params(extra) {
  return { headers: Object.assign({}, ACCESS, extra) };
}

/** Staging's Access service token as headers (none without the variables). */
function accessHeaders() {
  const id = (__ENV.CF_ACCESS_CLIENT_ID || '').trim();
  const secret = (__ENV.CF_ACCESS_CLIENT_SECRET || '').trim();
  if (!id && !secret) return {};
  if (!id || !secret) {
    throw new Error('set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither');
  }
  if (!WS_URL.startsWith('wss://')) throw new Error('the Access token goes over wss:// only');
  return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
}
if (BOT_KEY && (BOT_FIRST < 0 || BOT_FIRST + SENDERS - 1 > 999999)) {
  throw new Error('bot numbers stop at 999999: lower BOT_FIRST or SENDERS');
}

// Wire format (packages/protocol): [version u8][opcode u8] ...
const VERSION = 1;
const BRICK = 0x01;
const VIEW = 0x06;
const ACK = 0x81;
const DIFFS = 0x82;
const HOLD = 0x83;
const CONFIG = 0x84;
const TILE = 0x85;
const SIZE = Number(__ENV.MAP_SIZE ?? 1024);
const TILE_EDGE = 256;
const TILES_PER_SIDE = SIZE / TILE_EDGE;
/** A new canvas opens the middle half of its map: its first open tile a side. */
const FIRST_OPEN_TILE = TILES_PER_SIDE / 4;
/**
 * The target tile (column, row), inside the open area and away from the far corner. Each run
 * fills slots of it for good: give the next run on the same map another.
 */
const [TILE_X, TILE_Y] = (__ENV.TILE ?? `${FIRST_OPEN_TILE},${FIRST_OPEN_TILE}`)
  .split(',')
  .map(Number);
/** The target tile's first cell; 64 x 64 slots of 4 x 4 cells. */
const TARGET_X = TILE_X * TILE_EDGE;
const TARGET_Y = TILE_Y * TILE_EDGE;
const SLOTS_PER_ROW = 64;
const SLOTS = SLOTS_PER_ROW * SLOTS_PER_ROW;
/**
 * Views in cells: the target tile (the server follows it and the tiles around), or cells of
 * the map corner farthest from it, whose tiles followed (two a side) leave the target out.
 */
const NEAR = { x: TARGET_X, y: TARGET_Y, w: TILE_EDGE, h: TILE_EDGE };
const FAR = {
  x: TILE_X < TILES_PER_SIDE / 2 ? SIZE - 100 : 0,
  y: TILE_Y < TILES_PER_SIDE / 2 ? SIZE - 100 : 0,
  w: 100,
  h: 100,
};

export const options = {
  scenarios: {
    watchers: {
      executor: 'per-vu-iterations',
      vus: WATCHERS,
      iterations: 1,
      exec: 'watcher',
      maxDuration: `${Math.ceil(DURATION / 1000) + 30}s`,
    },
    senders: {
      executor: 'per-vu-iterations',
      vus: SENDERS,
      iterations: 1,
      exec: 'sender',
      // Let the watchers join first.
      startTime: '3s',
      maxDuration: `${Math.ceil(DURATION / 1000) + 30}s`,
    },
  },
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Loose bounds; they are here so the summary breaks the metrics down by watcher group.
  thresholds: {
    'diff_latency_ms{group:near}': ['p(95)<1000'],
    'diff_latency_ms{group:far}': ['max>=0'],
    'live_kb_per_min{group:near}': ['max>=0'],
    'live_kb_per_min{group:far}': ['max>=0'],
  },
};

/** Brick sent to its cells seen by a watcher that views the target tile (or every tile). */
const latency = new Trend('diff_latency_ms', true);
/** Bytes of live frames (diffs and tiles, after the grid and rules) per watcher and minute. */
const liveKbPerMin = new Trend('live_kb_per_min');
const tileFrames = new Counter('tile_frames');
const placed = new Counter('bricks_placed');
const refused = new Counter('bricks_refused');
const noBrick = new Counter('holds_without_brick');
const seenByFar = new Counter('bricks_seen_by_far_watchers');

export function setup() {
  return { start: Date.now() + 3000 };
}

/** A subscribing view frame: the cells shown, then the flags byte (bit 0, ADR 0028). */
function viewFrame(rect) {
  const view = new DataView(new ArrayBuffer(11));
  view.setUint8(0, VERSION);
  view.setUint8(1, VIEW);
  view.setUint16(2, rect.x, true);
  view.setUint16(4, rect.y, true);
  view.setUint16(6, rect.w, true);
  view.setUint16(8, rect.h, true);
  view.setUint8(10, 1);
  return view.buffer;
}

function brickFrame(opId, x, y, shape) {
  const view = new DataView(new ArrayBuffer(13));
  view.setUint8(0, VERSION);
  view.setUint8(1, BRICK);
  view.setUint32(2, opId, true);
  view.setUint16(6, x, true);
  view.setUint16(8, y, true);
  view.setUint8(10, shape);
  view.setUint8(11, 0);
  view.setUint8(12, 3);
  return view.buffer;
}

/** True when a config frame says the server takes views (the features byte after the locks). */
function takesViews(view) {
  if (view.byteLength <= 13) return false;
  const featuresAt = 14 + view.getUint8(13) * 8;
  return view.byteLength > featuresAt && (view.getUint8(featuresAt) & 1) === 1;
}

/** The slot a cell of the target tile belongs to, or -1. */
function slotOf(index) {
  const x = index % SIZE;
  const y = (index - x) / SIZE;
  if (x < TARGET_X || y < TARGET_Y || x >= TARGET_X + TILE_EDGE || y >= TARGET_Y + TILE_EDGE) {
    return -1;
  }
  return ((y - TARGET_Y) >> 2) * SLOTS_PER_ROW + ((x - TARGET_X) >> 2);
}

export function watcher(data) {
  const near = __VU % 2 === 1;
  const id = `lt-w${__VU}-${data.start.toString(36)}`;
  const endAt = data.start + DURATION;
  ws.connect(`${WS_URL}?client=${id}`, params({}), (socket) => {
    let ready = false;
    /** True once this watcher sent a view (the server takes them, and VIEWS=1). */
    let viewing = false;
    let since = 0;
    let bytes = 0;
    const seen = new Set();
    socket.on('binaryMessage', (message) => {
      const view = new DataView(message);
      if (view.byteLength < 2) return;
      const opcode = view.getUint8(1);
      if (!ready) {
        if (opcode !== CONFIG) return;
        ready = true;
        since = Date.now();
        if (VIEWS && takesViews(view)) {
          socket.sendBinary(viewFrame(near ? NEAR : FAR));
          viewing = true;
        }
        return;
      }
      bytes += view.byteLength;
      if (opcode === TILE) tileFrames.add(1);
      if (opcode !== DIFFS) return;
      const now = Date.now();
      const count = view.getUint16(6, true);
      for (let i = 0; i < count; i++) {
        const at = 8 + i * 6;
        const slot = slotOf(view.getUint32(at, true));
        if (slot < 0 || view.getUint8(at + 4) === 0 || seen.has(slot)) continue;
        seen.add(slot);
        // A far watcher with a view should never see the target tile.
        if (!near && viewing) seenByFar.add(1);
        latency.add(now - (data.start + slot * SLOT_MS + SLOT_MS / 2), {
          group: near ? 'near' : 'far',
        });
      }
    });
    socket.setTimeout(
      () => {
        if (ready) {
          const minutes = (Date.now() - since) / 60000;
          liveKbPerMin.add(bytes / 1024 / minutes, { group: near ? 'near' : 'far' });
        }
        socket.close();
      },
      Math.max(0, endAt - Date.now()),
    );
  });
}

/** The brick of a hold frame's items, or -1: [kind u8][shape u8] pairs from byte 16. */
function brickIn(view) {
  if (view.byteLength < 16) return -1;
  const count = view.getUint8(3);
  for (let i = 0; i < count && 17 + i * 2 < view.byteLength; i++) {
    if (view.getUint8(16 + i * 2) === 0) return view.getUint8(17 + i * 2);
  }
  return -1;
}

/** The slot's first cell for the time now, or null once the slots are used up. */
function slotCell(data) {
  const slot = Math.floor((Date.now() - data.start) / SLOT_MS);
  if (slot < 0 || slot >= SLOTS) return null;
  return {
    x: TARGET_X + (slot % SLOTS_PER_ROW) * 4,
    y: TARGET_Y + Math.floor(slot / SLOTS_PER_ROW) * 4,
  };
}

export function sender(data) {
  if (BOT_KEY) {
    botSender(data);
    return;
  }
  const endAt = data.start + DURATION;
  let n = 0;
  while (Date.now() < endAt) {
    n++;
    const id = `lt-s${__VU}-${n}-${data.start.toString(36)}`;
    ws.connect(`${WS_URL}?client=${id}&player=${id}`, null, (socket) => {
      let sent = false;
      socket.on('binaryMessage', (message) => {
        const view = new DataView(message);
        if (view.byteLength < 2) return;
        const opcode = view.getUint8(1);
        if (opcode === HOLD && !sent && view.byteLength >= 16) {
          const shape = brickIn(view);
          if (shape < 0) {
            noBrick.add(1);
            socket.close();
            return;
          }
          const cell = slotCell(data);
          if (!cell) {
            socket.close();
            return;
          }
          sent = true;
          socket.sendBinary(brickFrame(1, cell.x, cell.y, shape));
        } else if (opcode === ACK && sent) {
          if (view.getUint8(6) === 0) placed.add(1);
          else refused.add(1);
          socket.close();
        }
      });
      socket.setTimeout(() => socket.close(), 5000);
    });
    sleep(0.05);
  }
}

/**
 * A staging bot (ADR 0034) on one socket for the whole run: it reports the target tile as its
 * view first (an op outside the view is a bot signal, ADR 0026), then plays each brick its hold
 * gets into the slot of the moment, one op at a time. A refused brick (two senders in one slot)
 * stays held and goes to a later slot.
 */
function botSender(data) {
  const number = BOT_FIRST + exec.scenario.iterationInTest;
  const endAt = data.start + DURATION;
  const id = `lt-b${number}-${data.start.toString(36)}`;
  ws.connect(
    `${WS_URL}?client=${id}&bot=${number}`,
    params({ Authorization: `Bearer ${BOT_KEY}` }),
    (socket) => {
      let viewSent = false;
      /** A brick the latest hold shows (-1: none), and that hold's revision. */
      let shape = -1;
      let revision = -1;
      /** The revision the op in flight was chosen from: the next needs a newer hold. */
      let usedRevision = -1;
      let pending = false;
      let opId = 0;
      let refusals = 0;
      const play = () => {
        if (pending || !viewSent || shape < 0 || revision <= usedRevision) return;
        if (Date.now() >= endAt) return;
        const cell = slotCell(data);
        if (!cell) return;
        pending = true;
        usedRevision = revision;
        opId += 1;
        socket.sendBinary(brickFrame(opId, cell.x, cell.y, shape));
      };
      socket.on('binaryMessage', (message) => {
        const view = new DataView(message);
        if (view.byteLength < 2) return;
        const opcode = view.getUint8(1);
        if (opcode === CONFIG && !viewSent) {
          socket.sendBinary(viewFrame(NEAR));
          viewSent = true;
          play();
        } else if (opcode === HOLD && view.byteLength >= 16) {
          const next = view.getUint32(12, true);
          if (next < revision) return;
          revision = next;
          shape = brickIn(view);
          play();
        } else if (opcode === ACK && pending && view.byteLength >= 7) {
          if (view.getUint32(2, true) !== opId) return;
          pending = false;
          if (view.getUint8(6) === 0) {
            placed.add(1);
            refusals = 0;
            // The hold that follows a placed brick may be in already.
            play();
          } else {
            refused.add(1);
            // The brick is still held: try it again in a later slot, later still while
            // refusals keep coming.
            usedRevision = -1;
            socket.setTimeout(play, Math.min(2000, SLOT_MS * 2 ** refusals++));
          }
        }
      });
      socket.setTimeout(() => socket.close(), Math.max(0, endAt - Date.now()));
    },
  );
}
