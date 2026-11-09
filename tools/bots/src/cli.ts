import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Identity } from './bot.ts';
import { type ImagePlan, Run } from './driver.ts';
import { PLAYER_KINDS, type PlayerKind } from './player.ts';
import { decodePng } from './png.ts';

const USAGE = `Usage: pnpm --filter @brickplace/bots start [options]

Bots that play the game over WebSocket (ADR 0034). Local dev (pnpm dev, ENVIRONMENT=dev) needs
no key: bots play under dev ids. Staging needs the gateway's BOT_KEY, from the BOT_KEY
environment variable or --key-file; without it bots only watch there.

  --url URL        game socket (default ws://localhost:8787/ws; staging:
                   wss://staging.brickplace.app/ws)
  --key-file FILE  file holding the bot key (trailing newline ignored), instead of BOT_KEY
  --bots N         bots playing at once (default 200)
  --first N        first bot number (default 1); bots take N, N+1, ...
  --spare N        numbers that may replace challenged bots, at most (default 50)
  --mix M          builder/casual/griefer/repairer shares (default 40/40/10/10)
  --image FILE     a PNG every builder and repairer draws (8-bit, not interlaced); colours
                   become the nearest of the 32, pixels under half opaque are left alone
  --at X,Y         the image's top-left cell (default: centred in the open area)
  --width N        the image's width in cells (default: one cell per pixel)
  --arts N         random artworks to draw (default 6, or 0 with --image)
  --art-size N     edge of the random artworks (default 32)
  --minutes N      how long to play (default 60)
  --rate N         bots connected per second at the start (default 4)
  --whole-map      every socket gets the whole map, as pages before ADR 0040; by default a
                   bot's later sockets resume from the seq its last one reached
  --no-cdn         a bot's first socket gets the whole map even when /api/me names a CDN;
                   by default a bot loads the map from there first and resumes, as a page
  --every N        seconds between status lines (default 30)
  --seed N         random seed (default: from the clock)`;

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    'key-file': { type: 'string' },
    bots: { type: 'string' },
    first: { type: 'string' },
    spare: { type: 'string' },
    mix: { type: 'string' },
    image: { type: 'string' },
    at: { type: 'string' },
    width: { type: 'string' },
    arts: { type: 'string' },
    'art-size': { type: 'string' },
    minutes: { type: 'string' },
    rate: { type: 'string' },
    'whole-map': { type: 'boolean' },
    'no-cdn': { type: 'boolean' },
    every: { type: 'string' },
    seed: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function whole(name: string, text: string | undefined, fallback: number, min = 0): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be a whole number of at least ${min}`);
  return n;
}

const url = values.url ?? 'ws://localhost:8787/ws';
let parsed: URL;
try {
  parsed = new URL(url);
} catch {
  fail(`--url ${url} is not a URL`);
}
if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
  fail('--url must start with ws:// or wss://');

const keyText = values['key-file'] ? readFileSync(values['key-file'], 'utf8') : process.env.BOT_KEY;
const key = keyText?.trim();
const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
if (!key && !local) {
  fail(
    'no bot key: set BOT_KEY or pass --key-file (without one, bots only watch outside local dev)',
  );
}
if (key && !local && parsed.protocol !== 'wss:') fail('the bot key goes over wss:// only');
const identity: Identity = key ? { key } : { dev: true };

const mixParts = (values.mix ?? '40/40/10/10').split('/').map(Number);
if (
  mixParts.length !== PLAYER_KINDS.length ||
  mixParts.some((n) => !Number.isInteger(n) || n < 0)
) {
  fail('--mix takes four whole numbers, builder/casual/griefer/repairer');
}
if (mixParts.every((n) => n === 0)) fail('--mix needs at least one non-zero share');
const mix = Object.fromEntries(PLAYER_KINDS.map((kind, i) => [kind, mixParts[i]!])) as Record<
  PlayerKind,
  number
>;

let image: ImagePlan | null = null;
if (values.image) {
  let decoded: ReturnType<typeof decodePng>;
  try {
    decoded = decodePng(readFileSync(values.image));
  } catch (error) {
    fail(`--image ${values.image}: ${(error as Error).message}`);
  }
  let at: [number, number] | null = null;
  if (values.at) {
    const [x, y] = values.at.split(',').map(Number);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x! < 0 || y! < 0) fail('--at takes X,Y');
    at = [x!, y!];
  }
  image = { image: decoded, at, width: values.width ? whole('width', values.width, 0, 1) : null };
}

const bots = whole('bots', values.bots, 200, 1);
const first = whole('first', values.first, 1);
const spare = whole('spare', values.spare, 50);
// The gateway takes bot numbers 0 to 999999 (ADR 0034); dev ids have room for far more.
if (key && first + bots + spare - 1 > 999_999) {
  fail('bot numbers stop at 999999: lower --first, --bots or --spare');
}

const run = new Run({
  url,
  identity,
  bots,
  first,
  spare,
  mix,
  image,
  arts: whole('arts', values.arts, image ? 0 : 6),
  artSize: whole('art-size', values['art-size'], 32, 4),
  minutes: whole('minutes', values.minutes, 60, 1),
  rate: whole('rate', values.rate, 4, 1),
  every: whole('every', values.every, 30, 1),
  resume: !values['whole-map'],
  cdn: !values['no-cdn'],
  seed: whole('seed', values.seed, Date.now() % 0x7fffffff),
});

process.once('SIGINT', () => {
  console.log('stopping (Ctrl-C again to quit at once)');
  run.stop();
  process.once('SIGINT', () => process.exit(130));
});

run.run().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
