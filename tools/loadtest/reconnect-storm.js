// k6 reconnect storm: watchers and players connect, every socket drops at once, and every
// client comes back with the browser client's own backoff and jitter
// (apps/client/src/net/connection.ts: the first retry after 1 to 5 s, then 2, 4, 8, 15 s, each
// × 0.5..1.5 at random, and from the 8 s step after a 1013, ADR 0040). Measures how long the crowd takes to get its map back, how
// many joins are refused or fail, and whether an op sent right after the reconnect is answered.
// Like pages, clients reconnect with `?since=` (the seq their last socket reached) and
// `?canvas=`, so the server can send only what changed (ADR 0040).
//
// Local dev (never production; staging only in an agreed window, see README.md):
//   pnpm dev   # in another terminal
//   k6 run -e WS_URL=ws://localhost:8787/ws tools/loadtest/reconnect-storm.js
//
// Two ways to drop the sockets:
//   MODE=client (default): every client closes its socket at STORM_AT seconds, as if the
//     server had dropped them all; nothing to do on the server side.
//   MODE=server: clients wait for the server to close them. Trigger the drop yourself during
//     the run: locally, save any file under workers/realtime/src (wrangler dev reloads and every
//     socket closes); on staging, a realtime deploy (Actions → Deploy → env staging, realtime
//     ticked), which is what every realtime release does to players.
//
// Environment:
//   WS_URL        socket URL (default ws://localhost:8787/ws)
//   WATCHERS      watch-only clients (default 200)
//   PLAYERS       playing clients, dev identities (`?player=`), local dev only (default 50).
//                 The gateway accepts `?player=` only with ENVIRONMENT=dev: on staging set 0.
//   STORM_AT      seconds after the start when MODE=client drops every socket (default 20)
//   DURATION      seconds every client stays around in total (default 60)
//   MODE          client | server (default client)
//   ACK_TIMEOUT   seconds an op may wait for its ack (default 10)
//   RESUME        1 (default): reconnect with `since` and `canvas`; 0: ask for the whole map,
//                 as pages before ADR 0040
//   CANVAS        the canvas named with `since` (default: the season's, from /api/me next to
//                 WS_URL, as a page reads it)
//   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
//                 staging's Cloudflare Access service token (ADR 0045, amended), sent on
//                 every socket and on /api/me; both or neither, wss:// only
import { sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import ws from 'k6/ws';

const WS_URL = __ENV.WS_URL || 'ws://localhost:8787/ws';
const WATCHERS = Number(__ENV.WATCHERS ?? 200);
const PLAYERS = Number(__ENV.PLAYERS ?? 50);
const STORM_AT = Number(__ENV.STORM_AT ?? 20) * 1000;
const DURATION = Number(__ENV.DURATION ?? 60) * 1000;
const MODE = __ENV.MODE || 'client';
const ACK_TIMEOUT = Number(__ENV.ACK_TIMEOUT ?? 10) * 1000;
const RESUME = (__ENV.RESUME ?? '1') === '1';
const ACCESS = accessHeaders();

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

// The client's reconnect schedule (connection.ts DEFAULT_BACKOFF, FIRST_RETRY_SPREAD, the
// 0.5-1.5 jitter of later steps, the 1013 jump, stable time).
const BACKOFF = [1000, 2000, 4000, 8000, 15000];
const FIRST_RETRY_SPREAD = 5;
const TRY_AGAIN_LATER = 1013;
const OVERLOADED_STEP = 3;
const STABLE_MS = 5000;

// Wire format (packages/protocol): [version u8][opcode u8] ...
const VERSION = 1;
const HAMMER = 0x02;
const ACK = 0x81;
const DIFFS = 0x82;
const CONFIG = 0x84;
const TILE = 0x85;
const RESUMED = 0x87;
const UNAVAILABLE = 0xff;

export const options = {
  scenarios: {
    storm: {
      executor: 'per-vu-iterations',
      vus: WATCHERS + PLAYERS,
      iterations: 1,
      maxDuration: `${Math.ceil(DURATION / 1000) + 60}s`,
    },
  },
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    // Every client that lost its socket got its map back before the end.
    reconnected: ['rate>0.99'],
    // Every player's first op after the reconnect was answered (any verdict but `unavailable`).
    op_acked_after_reconnect: ['rate>0.99'],
  },
};

/** Drop to the first byte of the new socket's map (101 received). */
const reconnectOpen = new Trend('reconnect_open_ms', true);
/** Drop to the whole map and rules received again (the config frame follows the grid). */
const reconnectReady = new Trend('reconnect_ready_ms', true);
/** First connect of the run, start to map and rules received: the initial join storm. */
const initialReady = new Trend('initial_ready_ms', true);
/** Op sent to its ack, for the first op after the reconnect. */
const opAck = new Trend('op_ack_ms', true);
const reconnected = new Rate('reconnected');
const opAckedAfterReconnect = new Rate('op_acked_after_reconnect');
const attempts = new Counter('reconnect_attempts');
const refused = new Counter('connect_refused');
const failed = new Counter('connect_failed');
const socketErrors = new Counter('socket_errors');
const closedByServer = new Counter('closed_by_server');
const ackUnavailable = new Counter('op_ack_unavailable');
const ackTimeout = new Counter('op_ack_timeout');
/** Share of reconnects the server resumed (a Resume frame first) rather than send a map. */
const reconnectResumed = new Rate('reconnect_resumed');
/** Bytes before the config frame on a reconnect: the whole map, or the changes since `since`. */
const reconnectKb = new Trend('reconnect_kb');

/** The canvas a page names with `since`: the season's from /api/me, or Stage 0's; null: none. */
function findCanvas() {
  if (!RESUME) return null;
  if (__ENV.CANVAS) return __ENV.CANVAS;
  const url = WS_URL.replace(/^ws(s?):\/\/([^/?#]+).*$/, 'http$1://$2/api/me');
  // Access redirects a request without a valid token to its login page: follow nothing.
  const res = http.get(url, { headers: ACCESS, redirects: 0 });
  if (res.status !== 200) {
    console.warn(`${url}: HTTP ${res.status}; reconnecting without since`);
    return null;
  }
  const config = res.json('config');
  if (!config || config.seasonGuessed) return null;
  return config.season ? config.season.canvas || null : 'canvas';
}

export function setup() {
  const canvas = findCanvas();
  console.log(canvas ? `resuming on canvas ${canvas}` : 'reconnecting without since');
  // One start time for every VU, so MODE=client drops them all at the same moment.
  return { start: Date.now(), canvas };
}

function hammerFrame(opId, x, y) {
  const view = new DataView(new ArrayBuffer(10));
  view.setUint8(0, VERSION);
  view.setUint8(1, HAMMER);
  view.setUint32(2, opId, true);
  view.setUint16(6, x, true);
  view.setUint16(8, y, true);
  return view.buffer;
}

/** A cell inside the config frame's open area, spread over clients. */
function cellIn(open, seed) {
  return {
    x: open.x + ((seed * 7919) % Math.max(1, open.w)),
    y: open.y + ((seed * 104729) % Math.max(1, open.h)),
  };
}

export default function (data) {
  const player = __VU > WATCHERS;
  const id = `lt-${__VU}-${data.start.toString(36)}`;
  const base = `${WS_URL}?client=${id}${player ? `&player=${id}` : ''}`;
  const stormAt = data.start + STORM_AT;
  const endAt = data.start + DURATION;

  const startedAt = Date.now();
  let attempt = 0;
  /** True once this client had its map: later losses count as drops. */
  let hadMap = false;
  /** When this client lost its socket, until the map is back. */
  let droppedAt = null;
  let opId = __VU * 1000;
  let stormed = false;
  /** The seq of the last map frames a socket delivered once its map was in, as a page keeps. */
  let heldSeq = null;

  while (Date.now() < endAt) {
    let opened = false;
    let stableAt = null;
    /** The server's close code, when it sent one (1013: back off from the 8 s step). */
    let closeCode = null;
    let res = null;
    const url =
      data.canvas && heldSeq !== null
        ? `${base}&since=${heldSeq}&canvas=${encodeURIComponent(data.canvas)}`
        : base;
    try {
      res = ws.connect(url, { headers: ACCESS }, (socket) => {
        let ready = false;
        /** Seq of this socket's map frames before the config frame, bytes and a Resume frame. */
        let gridSeq = -1;
        let bytes = 0;
        let resumed = false;
        /** Set before this script closes the socket itself; any other close is the server's. */
        let closing = false;
        /** The op sent after this socket's map arrived: id and send time. */
        let pending = null;
        let afterReconnect = false;

        socket.on('open', () => {
          opened = true;
          stableAt = Date.now() + STABLE_MS;
          if (droppedAt !== null) reconnectOpen.add(Date.now() - droppedAt);
        });

        socket.on('binaryMessage', (message) => {
          const view = new DataView(message);
          if (view.byteLength < 2) return;
          const opcode = view.getUint8(1);
          if ((opcode === DIFFS || opcode === TILE) && view.byteLength >= 6) {
            if (ready) heldSeq = view.getUint32(2, true);
            else gridSeq = view.getUint32(2, true);
          }
          if (!ready && opcode !== CONFIG) {
            bytes += view.byteLength;
            if (opcode === RESUMED) resumed = true;
          }
          if (opcode === CONFIG && !ready && view.byteLength >= 13) {
            ready = true;
            if (gridSeq >= 0) heldSeq = gridSeq;
            const now = Date.now();
            if (!hadMap) initialReady.add(now - startedAt);
            if (droppedAt !== null) {
              reconnectReady.add(now - droppedAt);
              reconnected.add(true);
              reconnectResumed.add(resumed);
              reconnectKb.add(bytes / 1024);
              afterReconnect = true;
              droppedAt = null;
            }
            hadMap = true;
            if (player) {
              const open = {
                x: view.getUint16(4, true),
                y: view.getUint16(6, true),
                w: view.getUint16(8, true),
                h: view.getUint16(10, true),
              };
              const { x, y } = cellIn(open, __VU + opId);
              opId += 1;
              const sent = opId;
              pending = { opId: sent, at: Date.now(), afterReconnect };
              socket.sendBinary(hammerFrame(sent, x, y));
              socket.setTimeout(() => {
                if (pending && pending.opId === sent) {
                  ackTimeout.add(1);
                  if (pending.afterReconnect) opAckedAfterReconnect.add(false);
                  pending = null;
                }
              }, ACK_TIMEOUT);
            }
          } else if (opcode === ACK && pending && view.byteLength >= 7) {
            if (view.getUint32(2, true) !== pending.opId) return;
            const status = view.getUint8(6);
            if (status === UNAVAILABLE) ackUnavailable.add(1);
            if (pending.afterReconnect) {
              opAck.add(Date.now() - pending.at);
              opAckedAfterReconnect.add(status !== UNAVAILABLE);
            }
            pending = null;
          }
          // Diff and hold frames: the map and items flowing, nothing to measure here.
        });

        socket.on('close', (code) => {
          if (!closing) closedByServer.add(1);
          if (typeof code === 'number') closeCode = code;
        });

        socket.on('error', () => {
          socketErrors.add(1);
        });

        // MODE=client: drop at STORM_AT, once. Afterwards, and in MODE=server, stay until the end.
        const until = MODE === 'client' && !stormed ? Math.min(stormAt, endAt) : endAt;
        socket.setTimeout(
          () => {
            if (MODE === 'client' && Date.now() < endAt) stormed = true;
            closing = true;
            socket.close();
          },
          Math.max(0, until - Date.now()),
        );
      });
    } catch {
      // No response at all (connection refused, DNS): k6 throws for some of these.
      res = null;
    }

    if (res?.status !== 101) {
      if (res?.status) refused.add(1, { status: String(res.status) });
      else failed.add(1);
    }
    if (Date.now() >= endAt) break;
    // The socket is gone (dropped, refused or failed): back off as the browser does. The
    // schedule starts over only after a socket stayed up for STABLE_MS.
    if (hadMap && droppedAt === null) droppedAt = Date.now();
    if (opened && stableAt !== null && Date.now() >= stableAt) attempt = 0;
    if (closeCode === TRY_AGAIN_LATER) attempt = Math.max(attempt, OVERLOADED_STEP);
    const step = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    const factor =
      attempt === 0 ? 1 + (FIRST_RETRY_SPREAD - 1) * Math.random() : 0.5 + Math.random();
    attempt += 1;
    attempts.add(1);
    sleep((step * factor) / 1000);
  }

  // Lost its map and never got it back before the end.
  if (droppedAt !== null) reconnected.add(false);
}
