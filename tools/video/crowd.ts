// A crowd of long-lived dev players for promo videos (local dev only: the gateway takes
// `?player=` only with ENVIRONMENT=dev). Most of them build a few artworks on a 120×80 patch,
// the rest scatter bricks, hammer whatever they like and sometimes run a brick through an
// artwork; builders hammer stray bricks off their art and shield it. Every move goes through
// the real server, which draws the items and applies the rules. See README.md.
//
//   pnpm exec tsx tools/video/crowd.ts      # with `pnpm dev` running
//
// Env: WS_URL (ws://localhost:8787/ws), PLAYERS (300), X0/Y0 (275/382, the patch's corner),
// START_DELAY seconds (0: players only discard until then, so the "playing now" count is up
// before anything appears), DURATION seconds (90, counted from start).
import {
  cellsOf,
  PLACEMENT_COUNT,
  PLACEMENTS,
  type Rotation,
  type ShapeId,
} from '../../packages/core/src/index.ts';
import {
  decodeServerMessage,
  encodeClientDiscard,
  encodeClientOp,
  type ServerMessage,
} from '../../packages/protocol/src/index.ts';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:8787/ws';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(WS_URL).hostname)) {
  throw new Error(`${WS_URL} is not local: the crowd plays on local dev only`);
}
const PLAYERS = Number(process.env.PLAYERS ?? 300);
const X0 = Number(process.env.X0 ?? 275);
const Y0 = Number(process.env.Y0 ?? 382);
const START_AT = Date.now() + Number(process.env.START_DELAY ?? 0) * 1000;
const DURATION = Number(process.env.DURATION ?? 90) * 1000;

/** Patch size in cells; record.mjs centres the camera on it (keep the two in step). */
const W = 120;
const H = 80;
const CELLS = W * H;

// ---- The scene: which artwork each cell belongs to (0 = none) and its wanted colour
// (palette indices, apps/client/src/palette.ts).

const RED = 0;
const PINK = 2;
const ORANGE = 4;
const YELLOW = 6;
const GREEN = 8;
const LIGHT_GREEN = 9;
const BLUE = 14;
const PURPLE = 16;
const BROWN = 20;
const BEIGE = 22;
const WHITE = 23;
const NAVY = 28;

const art = new Int8Array(CELLS);
const want = new Int16Array(CELLS).fill(-1);

function paint(id: number, x: number, y: number, colour: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  art[y * W + x] = id;
  want[y * W + x] = colour;
}

const FONT: Record<string, readonly string[]> = {
  A: [' 111 ', '1   1', '1   1', '11111', '1   1', '1   1', '1   1'],
  B: ['1111 ', '1   1', '1   1', '1111 ', '1   1', '1   1', '1111 '],
  C: [' 1111', '1    ', '1    ', '1    ', '1    ', '1    ', ' 1111'],
  E: ['11111', '1    ', '1    ', '1111 ', '1    ', '1    ', '11111'],
  I: ['11111', '  1  ', '  1  ', '  1  ', '  1  ', '  1  ', '11111'],
  K: ['1   1', '1  1 ', '1 1  ', '11   ', '1 1  ', '1  1 ', '1   1'],
  L: ['1    ', '1    ', '1    ', '1    ', '1    ', '1    ', '11111'],
  P: ['1111 ', '1   1', '1   1', '1111 ', '1    ', '1    ', '1    '],
  R: ['1111 ', '1   1', '1   1', '1111 ', '1 1  ', '1  1 ', '1   1'],
};

/** Draws `rows` ('1' = filled) at 2× so strokes are two cells wide and bricks fit them. */
function bitmap(
  id: number,
  rows: readonly string[],
  ox: number,
  oy: number,
  colour: (x: number, y: number) => number,
): void {
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c !== '1') return;
      for (let d = 0; d < 4; d++)
        paint(id, ox + x * 2 + (d & 1), oy + y * 2 + (d >> 1), colour(x, y));
    });
  });
}

const SIGN = 1;
const HEART = 2;
const SMILEY = 3;
const FLAG = 4;
const TREE = 5;
const MUSHROOM = 6;

// Sign: a navy board with the name on it.
for (let y = 0; y < 38; y++) for (let x = 0; x < 66; x++) paint(SIGN, 30 + x, 4 + y, NAVY);
function word(text: string, ox: number, oy: number, colour: number): void {
  [...text].forEach((ch, k) => {
    bitmap(SIGN, FONT[ch]!, ox + k * 12, oy, () => colour);
  });
}
word('BRICK', 34, 7, ORANGE);
word('PLACE', 34, 25, YELLOW);

const HEART_ROWS = [
  '  111   111  ',
  ' 11111 11111 ',
  '1111111111111',
  '1111111111111',
  '1111111111111',
  ' 11111111111 ',
  '  111111111  ',
  '   1111111   ',
  '    11111    ',
  '     111     ',
  '      1      ',
];
bitmap(HEART, HEART_ROWS, 2, 6, (x, y) => (x > 1 && x < 5 && y < 3 ? PINK : RED));

for (let y = 0; y < 22; y++) {
  for (let x = 0; x < 22; x++) {
    const r = Math.hypot(x - 10.5, y - 10.5);
    if (r > 11) continue;
    const eye = Math.hypot(x - 7, y - 7.5) < 2 || Math.hypot(x - 14, y - 7.5) < 2;
    const mouth = y >= 13 && y <= 15 && r > 4.5 && r < 7 && Math.abs(x - 10.5) < 6;
    paint(SMILEY, 97 + x, 4 + y, r > 9.6 || eye || mouth ? NAVY : YELLOW);
  }
}

const STRIPES = [RED, ORANGE, YELLOW, GREEN, BLUE, PURPLE];
for (let y = 0; y < 18; y++) {
  for (let x = 0; x < 26; x++) paint(FLAG, 92 + x, 48 + y, STRIPES[Math.floor(y / 3)]!);
}

for (let y = 0; y < 26; y++) {
  for (let x = 0; x < 20; x++) {
    if (Math.hypot(x - 9.5, y - 9) < 9.5) {
      paint(TREE, 50 + x, 46 + y, (x * 7 + y * 3) % 11 < 3 ? LIGHT_GREEN : GREEN);
    } else if (y >= 17 && x >= 8 && x <= 11) {
      paint(TREE, 50 + x, 46 + y, BROWN);
    }
  }
}

for (let y = 0; y < 16; y++) {
  for (let x = 0; x < 18; x++) {
    if (y < 9 && Math.hypot((x - 8.5) / 9, (y - 9) / 9) < 1) {
      const dot =
        Math.hypot(x - 5, y - 4) < 2 ||
        Math.hypot(x - 12, y - 3) < 1.6 ||
        Math.hypot(x - 9, y - 7) < 1.3;
      paint(MUSHROOM, 22 + x, 48 + y, dot ? WHITE : RED);
    } else if (y >= 9 && x >= 5 && x <= 12) {
      paint(MUSHROOM, 22 + x, 48 + y, BEIGE);
    }
  }
}

/** Cells of each colour per artwork (key id * 256 + colour). */
const USAGE = new Map<number, number>();
for (let i = 0; i < CELLS; i++) {
  if (art[i] !== 0)
    USAGE.set(art[i]! * 256 + want[i]!, (USAGE.get(art[i]! * 256 + want[i]!) ?? 0) + 1);
}
const usage = (id: number, c: number) => USAGE.get(id * 256 + c) ?? 0;

/** How many builders each artwork draws: the sign is the crowd's favourite (and biggest). */
const WEIGHTS: readonly (readonly [id: number, weight: number])[] = [
  [SIGN, 55],
  [HEART, 10],
  [SMILEY, 10],
  [FLAG, 9],
  [TREE, 8],
  [MUSHROOM, 7],
];
const SCATTER = [0, 4, 6, 8, 12, 14, 16, 18, 23, 27, 29, 30];

// ---- What the crowd knows of the patch. Every move on it is the crowd's own, so acks are
// enough to keep this in step (a move in flight marks its cells busy).

const colour = new Int16Array(CELLS).fill(-1);
const busy = new Uint8Array(CELLS);
const shields = new Uint8Array(CELLS);

const isFree = (i: number) => colour[i] === -1 && busy[i] === 0;

function contact(i: number): number {
  const x = i % W;
  const y = Math.floor(i / W);
  let n = 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    if (!isFree(ny * W + nx)) n++;
  }
  return n;
}

function pick<T>(list: readonly T[]): T | null {
  return list.length > 0 ? list[Math.floor(Math.random() * list.length)]! : null;
}

/** The patch cells of a brick at (x, y), or null when one is off the patch or taken. */
function footprint(shape: ShapeId, rotation: Rotation, x: number, y: number): number[] | null {
  const cells: number[] = [];
  for (const [dx, dy] of cellsOf(shape, rotation)) {
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cy < 0 || cx >= W || cy >= H || !isFree(cy * W + cx)) return null;
    cells.push(cy * W + cx);
  }
  return cells;
}

interface Placement {
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  readonly cells: readonly number[];
  readonly colour: number;
}

function placements(shape: ShapeId, accept: (cells: number[]) => number | null): Placement[] {
  const out: Placement[] = [];
  for (let r = 0; r < 4; r++) {
    const rotation = r as Rotation;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const cells = footprint(shape, rotation, x, y);
        if (!cells) continue;
        const c = accept(cells);
        if (c !== null) out.push({ x, y, rotation, cells, colour: c });
      }
    }
  }
  return out;
}

function pickArtwork(): number {
  const total = WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [id, w] of WEIGHTS) {
    r -= w;
    if (r < 0) return id;
  }
  return SIGN;
}

/** A builder's brick: on one artwork, in its colour, growing from what is there. */
function buildMove(shape: ShapeId): Placement | null {
  const id = pickArtwork();
  let options = placements(shape, (cells) => {
    const c = want[cells[0]!]!;
    return cells.every((i) => art[i] === id && want[i] === c) ? c : null;
  });
  if (options.length === 0) {
    // Edges between colours: a brick across them takes the artwork's rarest colour among its
    // cells when it has two of them, so strokes grow fat rather than get eaten.
    options = placements(shape, (cells) => {
      if (!cells.every((i) => art[i] === id)) return null;
      const rarest = cells.reduce((a, b) => (usage(id, want[b]!) < usage(id, want[a]!) ? b : a));
      const c = want[rarest]!;
      return cells.filter((i) => want[i] === c).length >= 2 ? c : null;
    });
  }
  if (options.length === 0) return null;
  // Grow from what is there, then of the snuggest few take the one leaving the fewest holes
  // on the artwork that no brick can fill any more.
  const snug = options
    .map((p) => ({ p, score: p.cells.reduce((sum, i) => sum + contact(i), 0) + Math.random() * 3 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
  for (const s of snug) s.score -= 4 * holesLeft(s.p.cells, id);
  snug.sort((a, b) => b.score - a.score);
  return snug[0]!.p;
}

/** Whether some brick still fits through cell i (off the patch counts as free). */
function coverable(i: number): boolean {
  const x = i % W;
  const y = Math.floor(i / W);
  for (let p = 0; p < PLACEMENT_COUNT; p++) {
    let fits = true;
    for (let k = 0; k < 4 && fits; k++) {
      const cx = x + PLACEMENTS[p * 8 + k * 2]!;
      const cy = y + PLACEMENTS[p * 8 + k * 2 + 1]!;
      const inside = cx >= 0 && cy >= 0 && cx < W && cy < H;
      fits = !inside || isFree(cy * W + cx);
    }
    if (fits) return true;
  }
  return false;
}

/** Empty cells of artwork `id` next to `cells` that a brick there would leave unfillable. */
function holesLeft(cells: readonly number[], id: number): number {
  for (const i of cells) busy[i] = 1;
  let holes = 0;
  for (const i of cells) {
    for (const j of [i - 1, i + 1, i - W, i + W]) {
      if (j < 0 || j >= CELLS || Math.abs((j % W) - (i % W)) > 1) continue;
      if (art[j] === id && isFree(j) && !coverable(j)) holes++;
    }
  }
  for (const i of cells) busy[i] = 0;
  return holes;
}

/** Anyone else's brick: a random spot and colour, mostly off the artworks. */
function scatterMove(shape: ShapeId): Placement | null {
  const c = pick(SCATTER)!;
  for (let tries = 0; tries < 200; tries++) {
    const x = Math.floor(Math.random() * W);
    const y = Math.floor(Math.random() * H);
    const rotation = Math.floor(Math.random() * 4) as Rotation;
    const cells = footprint(shape, rotation, x, y);
    if (!cells || (cells.some((i) => art[i] !== 0) && Math.random() < 0.85)) continue;
    return { x, y, rotation, cells, colour: c };
  }
  return null;
}

function cellsWhere(test: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) if (test(i)) out.push(i);
  return out;
}

// ---- Players

type Item = Extract<ServerMessage, { type: 'hold' }>['items'][number];

interface Move {
  readonly item: Item;
  readonly frame: Uint8Array;
  readonly cells: readonly number[];
  readonly onAccepted: () => void;
}

let sent = 0;
let accepted = 0;
const refusals = new Map<string, number>();
/** Refusals that no other move clears: the bot leaves rather than retry. */
const STOPPING = new Set<string>(['signed_out', 'ended', 'read_only']);

class Player {
  readonly ws: WebSocket;
  readonly builder = Math.random() < 0.8;
  private opId = 1;
  private inFlight: Move | null = null;
  /** Refusals in a row for the item in hand. */
  private refused = 0;

  constructor(n: number) {
    const id = `crowd-${n}-${Math.random().toString(36).slice(2, 10)}`;
    this.ws = new WebSocket(`${WS_URL}?client=${id}&player=${id}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (event) => {
      this.onMessage(decodeServerMessage(new Uint8Array(event.data as ArrayBuffer)));
    };
    this.ws.onerror = () => {};
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.type === 'ack') {
      const move = this.inFlight;
      this.inFlight = null;
      if (!move) return;
      for (const i of move.cells) busy[i] = 0;
      if (msg.ok) {
        accepted++;
        this.refused = 0;
        move.onAccepted();
      } else {
        refusals.set(msg.reason, (refusals.get(msg.reason) ?? 0) + 1);
        // The item stays in the hold and no new hold frame comes: try it somewhere else, and
        // after a second refusal throw it away.
        this.refused++;
        if (STOPPING.has(msg.reason)) this.ws.close();
        else if (msg.reason !== 'no_item') setTimeout(() => this.act(move.item), 500);
      }
      return;
    }
    if (msg.type !== 'hold' || this.inFlight || msg.items.length === 0) return;
    const item = msg.items[0]!;
    // A person takes a moment to decide.
    setTimeout(() => this.act(item), 300 + Math.random() * 2500);
  }

  private act(item: Item): void {
    if (this.inFlight || this.ws.readyState !== WebSocket.OPEN) return;
    const opId = this.opId++;
    const move = Date.now() < START_AT || this.refused >= 2 ? null : this.choose(item, opId);
    if (!move) this.refused = 0;
    this.inFlight = move ?? {
      item,
      frame: encodeClientDiscard({ opId, discard: item }),
      cells: [],
      onAccepted: () => {},
    };
    for (const i of this.inFlight.cells) busy[i] = 1;
    sent++;
    this.ws.send(this.inFlight.frame as Uint8Array<ArrayBuffer>);
  }

  private choose(item: Item, opId: number): Move | null {
    const at = (i: number) => ({ x: X0 + (i % W), y: Y0 + Math.floor(i / W) });
    switch (item.kind) {
      case 'brick': {
        const shape = item.shape as ShapeId;
        const p = (this.builder ? buildMove(shape) : null) ?? scatterMove(shape);
        if (!p) return null;
        const op = {
          kind: 'brick' as const,
          shape,
          rotation: p.rotation,
          color: p.colour,
          x: X0 + p.x,
          y: Y0 + p.y,
        };
        return {
          item,
          frame: encodeClientOp({ opId, op }),
          cells: p.cells,
          onAccepted: () => {
            for (const i of p.cells) colour[i] = p.colour;
          },
        };
      }
      case 'single': {
        // Singles only go where no brick fits (the server refuses them elsewhere).
        const holes = cellsWhere((j) => isFree(j) && contact(j) >= 2 && !coverable(j));
        const i = pick(holes.filter((j) => art[j] !== 0)) ?? pick(holes);
        if (i === null) return null;
        const c = art[i] !== 0 ? want[i]! : pick(SCATTER)!;
        return {
          item,
          frame: encodeClientOp({ opId, op: { kind: 'single', color: c, ...at(i) } }),
          cells: [i],
          onAccepted: () => {
            colour[i] = c;
          },
        };
      }
      case 'hammer': {
        const taken = cellsWhere((j) => colour[j] !== -1 && busy[j] === 0);
        const stray = taken.filter((j) => art[j] !== 0 && colour[j] !== want[j]);
        // Builders never knock holes in an artwork: stray bricks first, else something off it.
        const i = this.builder
          ? (pick(stray) ?? pick(taken.filter((j) => art[j] === 0)))
          : pick(taken);
        if (i === null) return null;
        return {
          item,
          frame: encodeClientOp({ opId, op: { kind: 'hammer', ...at(i) } }),
          cells: [i],
          onAccepted: () => {
            if (shields[i]! > 0) shields[i]!--;
            else colour[i] = -1;
          },
        };
      }
      default: {
        const i = pick(
          cellsWhere((j) => art[j] !== 0 && colour[j] === want[j] && !busy[j] && shields[j]! < 2),
        );
        if (i === null) return null;
        return {
          item,
          frame: encodeClientOp({ opId, op: { kind: 'shield', ...at(i) } }),
          cells: [i],
          onAccepted: () => {
            shields[i]!++;
          },
        };
      }
    }
  }
}

const started = Date.now();
const players: Player[] = [];
// People drift in rather than all at once (the initial-grid sends are capped per shard).
for (let n = 0; n < PLAYERS; n++) {
  players.push(new Player(n));
  await new Promise((resolve) => setTimeout(resolve, 15));
}
const log = setInterval(() => {
  const open = players.filter((p) => p.ws.readyState === WebSocket.OPEN).length;
  const filled = cellsWhere((i) => colour[i] !== -1).length;
  const refused = JSON.stringify(Object.fromEntries(refusals));
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`${elapsed}s open=${open} sent=${sent} ok=${accepted} filled=${filled} ${refused}`);
}, 5000);
await new Promise((resolve) => setTimeout(resolve, START_AT - started + DURATION));
clearInterval(log);
for (const p of players) p.ws.close();
await new Promise((resolve) => setTimeout(resolve, 500));
process.exit(0);
