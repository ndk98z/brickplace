// k6 smoke test for the WebSocket path: connect, wait for the hold, send one op, wait for its
// ack. Each iteration is a fresh dev identity: its own connection id (`?client=`) and player
// (`?player=`, which the gateway takes only with ENVIRONMENT=dev), so local dev only:
//   pnpm dev   # in another terminal
//   k6 run -e WS_URL=ws://localhost:8787/ws tools/loadtest/ws-smoke.js
//
// The op discards the first item the hold shows: valid whatever was drawn, so every ack
// should be ok. An empty hold (none drawn yet) sends a hammer instead, refused `no_item`.
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import ws from 'k6/ws';

export const options = {
  vus: Number(__ENV.VUS || 50),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    'checks{check:op_answered}': ['rate>0.99'],
    'checks{check:signed_in}': ['rate==1'],
  },
};

// Wire format (packages/protocol): [version u8][opcode u8] ...
const VERSION = 1;
const HAMMER = 0x02;
const DISCARD = 0x05;
const ACK = 0x81;
const HOLD = 0x83;
/** Ack statuses past the rule rejections (packages/protocol, the Ack frame). */
const OK = 0;
const SIGNED_OUT = 254;

const accepted = new Counter('ops_accepted');
const refused = new Counter('ops_refused');

/** Discard: [hdr][opId u32][kind u8][shape u8], the item as the hold listed it. */
function discardFrame(opId, kind, shape) {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint8(0, VERSION);
  view.setUint8(1, DISCARD);
  view.setUint32(2, opId, true);
  view.setUint8(6, kind);
  view.setUint8(7, shape);
  return view.buffer;
}

/** Hammer: [hdr][opId u32][x u16][y u16]. */
function hammerFrame(opId, x, y) {
  const view = new DataView(new ArrayBuffer(10));
  view.setUint8(0, VERSION);
  view.setUint8(1, HAMMER);
  view.setUint32(2, opId, true);
  view.setUint16(6, x, true);
  view.setUint16(8, y, true);
  return view.buffer;
}

export default function () {
  const url = __ENV.WS_URL || 'ws://localhost:8787/ws';
  const id = `smoke-${__VU}-${__ITER}-${Date.now().toString(36)}`;
  let status = null;
  const res = ws.connect(`${url}?client=${id}&player=${id}`, null, (socket) => {
    let sent = false;
    socket.on('binaryMessage', (message) => {
      const view = new DataView(message);
      if (view.byteLength < 2) return;
      const opcode = view.getUint8(1);
      // Hold: [hdr][capacity u8][count u8][cooldown u32][nextIn u32][revision u32] then items.
      if (opcode === HOLD && !sent && view.byteLength >= 16) {
        sent = true;
        const count = view.getUint8(3);
        socket.sendBinary(
          count > 0
            ? discardFrame(1, view.getUint8(16), view.getUint8(17))
            : hammerFrame(1, 512 + (__VU % 256), 512 + (__ITER % 256)),
        );
      } else if (opcode === ACK && sent && view.byteLength >= 7) {
        status = view.getUint8(6);
        if (status === OK) accepted.add(1);
        else refused.add(1);
        socket.close();
      }
    });
    socket.setTimeout(() => socket.close(), 5000);
  });
  check(res, { 'upgraded to WebSocket': (r) => r && r.status === 101 });
  check(status, {
    op_answered: (s) => s !== null,
    signed_in: (s) => s !== SIGNED_OUT,
  });
}
