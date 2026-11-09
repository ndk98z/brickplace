// Records a promo clip on local dev: sets a short cooldown through the local admin API, runs
// the crowd (crowd.ts), films the client with Playwright while it plays, puts the item config
// back, then cuts and speeds the recording up into an MP4 and a GIF with ffmpeg. See README.md.
//
//   pnpm dev          # one terminal
//   pnpm dev:admin    # another, once `pnpm dev` is ready (both at once fight over SQLite)
//   NODE_PATH="$(npm root -g)" node tools/video/record.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const SITE = env.SITE ?? 'http://localhost:8787';
const ADMIN = env.ADMIN ?? 'http://localhost:8788';
const COOLDOWN = Number(env.COOLDOWN ?? 10_000);
const PLAYERS = env.PLAYERS ?? '300';
const X0 = Number(env.X0 ?? 275);
const Y0 = Number(env.Y0 ?? 382);
/** Seconds the crowd stays idle (online, discarding) so the "playing now" count is up. */
const WARMUP = Number(env.WARMUP ?? 28);
/** Seconds of play filmed after the warm-up. */
const PLAY = Number(env.PLAY ?? 80);
const SPEED = Number(env.SPEED ?? 6);
const ZOOM = Number(env.ZOOM ?? 7);
const OUT = env.OUT ?? join(tmpdir(), 'brickplace-video');

// Local dev only: the bots are dev identities and the admin calls change the item config.
for (const url of [SITE, ADMIN]) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error(`${url} is not local: this tool runs against local dev only`);
  }
}

const here = import.meta.dirname;
const root = join(here, '../..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// Playwright is not a repo dependency: use the one installed on the machine. createRequire's
// CommonJS lookup searches NODE_PATH (ESM imports do not), so point it at the global install.
const { chromium } = createRequire(import.meta.url)('playwright');

async function admin(path, body) {
  const res = await fetch(`${ADMIN}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-BrickPlace-Admin': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`admin ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Schedules an item config effective now; returns the one it replaces. */
async function setItems(change, reason) {
  const { state } = await admin('/api/config');
  if (!state) throw new Error('admin sees no canvas: is `pnpm dev` running?');
  await admin('/api/config', { scope: 'items', reason, config: change(state.items) });
  return state.items;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

mkdirSync(OUT, { recursive: true });
const videoDir = join(OUT, `raw-${Date.now()}`);

// Shorter cooldown, hammers from the start so the clip shows them, and more singles so the
// artworks lose fewer cells to holes no brick fits.
const previous = await setItems(
  (items) => ({
    ...items,
    cooldown: COOLDOWN,
    rates: { ...items.rates, settling: [64, 12, 14, 10] },
  }),
  'local promo video',
);

let crowd = null;
let restored = null;
/** Stops the crowd and puts the item config back, once, however the run ends. */
function cleanUp() {
  // The crowd is pnpm → tsx → node: signal its whole process group, not just pnpm.
  if (crowd?.pid && crowd.exitCode === null) {
    try {
      process.kill(-crowd.pid, 'SIGTERM');
    } catch {}
  }
  restored ??= setItems(() => previous, 'local promo video done');
  return restored;
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    cleanUp().finally(() => process.exit(code));
  });
}

let actionAt;
try {
  const started = Date.now();
  crowd = spawn('pnpm', ['exec', 'tsx', join(here, 'crowd.ts')], {
    cwd: root,
    stdio: 'inherit',
    detached: true,
    env: {
      ...env,
      WS_URL: new URL('/ws', SITE).href.replace(/^http/, 'ws'),
      PLAYERS,
      X0: String(X0),
      Y0: String(Y0),
      START_DELAY: String(WARMUP),
      DURATION: String(PLAY + 10),
    },
  });
  // A crowd that fails to start or dies early would leave an empty clip: stop filming.
  const crowdFailed = new Promise((_, reject) => {
    crowd.on('error', reject);
    crowd.on('exit', (code) => reject(new Error(`the crowd exited early (${code})`)));
  });
  crowdFailed.catch(() => {});
  // Open the page once most of the crowd is in, so its first stats frame counts them.
  await Promise.race([wait(Math.min(12, WARMUP / 2) * 1000), crowdFailed]);

  // Centre on the 120×80 patch, nudged right: the item column covers the right of the map.
  const camX = Math.round(X0 + 60 + 115 / ZOOM);
  const camY = Y0 + 40;
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    });
    const page = await context.newPage();
    // Film as a signed-out visitor (`?watch`), not as a dev guest holding items. Local dev's
    // tiles bucket is not where /api/me points watchers (the canvas stores them under its id's
    // hex, not `c/canvas`), so drop `tilesUrl` and let the page watch over its socket instead.
    await page.route('**/api/me', async (route) => {
      try {
        const response = await route.fetch();
        const me = await response.json();
        const json = { ...me, config: { ...me.config, tilesUrl: null } };
        await route.fulfill({ response, json });
      } catch {
        // Not JSON (the gateway reloading, say): pass it through untouched.
        await route.fallback().catch(() => {});
      }
    });
    const pageOpened = Date.now();
    await page.goto(`${SITE}/@${camX},${camY},${ZOOM}x?watch`);
    await wait(3000);
    await page
      .locator('button[aria-label="Close"]')
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});
    actionAt = Math.max(0, (started + WARMUP * 1000 - pageOpened) / 1000);
    await Promise.race([wait(started + (WARMUP + PLAY) * 1000 - Date.now()), crowdFailed]);
    await page.screenshot({ path: join(OUT, 'last-frame.png') });
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  await cleanUp();
}

const raw = join(
  videoDir,
  readdirSync(videoDir).find((f) => f.endsWith('.webm')),
);
const cut = `trim=${actionAt.toFixed(2)},setpts=(PTS-STARTPTS)/${SPEED}`;
const hold = 'tpad=stop_mode=clone:stop_duration=2.5';
await run('ffmpeg', [
  ...['-v', 'error', '-y', '-i', raw],
  ...['-vf', `${cut},fps=30,${hold},format=yuv420p`],
  ...['-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart'],
  join(OUT, 'brickplace.mp4'),
]);
await run('ffmpeg', [
  ...['-v', 'error', '-y', '-i', raw],
  '-filter_complex',
  `[0:v]${cut},fps=15,${hold},scale=960:-1:flags=lanczos,split[a][b];` +
    '[a]palettegen=max_colors=160:stats_mode=diff[p];' +
    '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  join(OUT, 'brickplace.gif'),
]);
console.log(`Done: ${join(OUT, 'brickplace.mp4')}, ${join(OUT, 'brickplace.gif')}`);
