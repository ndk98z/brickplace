import {
  DEFAULT_MAP_SIZE,
  DEFAULT_MAX_SHIELD,
  DEFAULT_OPEN_EDGE,
  type Rect,
} from '@brickplace/core';
import { type Art, accuracy, imageArt, randomArt } from './art.ts';
import { Bot, type GoneReason, type Identity, type Join, Stats } from './bot.ts';
import { Cdn, type CdnStats, tilesOf } from './cdn.ts';
import { Eye } from './eye.ts';
import { Mirror } from './mirror.ts';
import { PLAYER_KINDS, Player, type PlayerKind, type World } from './player.ts';
import type { Image } from './png.ts';
import { Rng } from './rng.ts';
import { type Connect, nodeConnect } from './socket.ts';

export interface RunConfig {
  /** The game's WebSocket URL, e.g. ws://localhost:8787/ws. */
  readonly url: string;
  readonly identity: Identity;
  readonly bots: number;
  /** The first bot number; bots take `first`, `first + 1`, ... */
  readonly first: number;
  /** Numbers that may replace bots whose number is out (challenged), at most. */
  readonly spare: number;
  /** builder/casual/griefer/repairer shares. */
  readonly mix: Readonly<Record<PlayerKind, number>>;
  /** Random artworks to draw, and their edge. */
  readonly arts: number;
  readonly artSize: number;
  /** An image every builder and repairer draws (see art.ts imageArt). */
  readonly image: ImagePlan | null;
  readonly minutes: number;
  readonly seed: number;
  /** Bots connected per second at the start. */
  readonly rate: number;
  /** Seconds between status lines. */
  readonly every: number;
  /**
   * Sockets after a bot's first resume from the seq its last one reached (ADR 0040), as pages
   * do; false: every socket gets the whole map, as pages before.
   */
  readonly resume: boolean;
  /**
   * With `resume`: load the map from the CDN /api/me names before the first socket and resume
   * that one too, as a page about to play does; false: the first socket gets the whole map.
   */
  readonly cdn: boolean;
}

/** Fetches a URL and reads its JSON body; throws on a status other than 2xx. */
export type FetchJson = (url: string) => Promise<unknown>;

const fetchJson: FetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

export interface ImagePlan {
  readonly image: Image;
  /** Its top-left cell; null: centred in the open area. */
  readonly at: readonly [x: number, y: number] | null;
  /** Its width in cells; null: one cell per pixel. */
  readonly width: number | null;
}

/** Players look for the most damaged artwork (repairers) or another one (griefers) this often. */
const RETARGET_MS = 10 * 60_000;
/** The map must arrive within this long, or the run stops (ms). */
const MAP_WAIT_MS = 60_000;

/**
 * One run: the Eye keeps the map, then bots join a few per second and play until the time is
 * up or the run is interrupted. Prints a status line now and then and a summary at the end.
 */
export class Run {
  readonly mirror = new Mirror(
    DEFAULT_MAP_SIZE,
    centred(DEFAULT_MAP_SIZE, DEFAULT_OPEN_EDGE),
    DEFAULT_MAX_SHIELD,
  );
  readonly stats = new Stats();
  readonly arts: Art[] = [];
  readonly bots: Bot[] = [];
  private readonly rng: Rng;
  private readonly eye: Eye;
  private nextNumber: number;
  private sparesLeft: number;
  private readonly gone: Record<string, number> = {};
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private readonly started = Date.now();
  private done: (() => void) | null = null;
  private stopping = false;
  /** The canvas bots name when they resume; null: they ask for the whole map. */
  private canvas: string | null = null;
  /** Where bots load the map before their first socket (ADR 0040); null: from the socket. */
  private cdn: Cdn | null = null;
  /** Joins already counted in a status line. */
  private joinsShown = 0;

  constructor(
    private readonly config: RunConfig,
    private readonly connect: Connect = nodeConnect,
    private readonly log: (line: string) => void = console.log,
    private readonly fetch: FetchJson = fetchJson,
  ) {
    this.rng = new Rng(config.seed);
    this.eye = new Eye(config.url, this.mirror, connect, () => this.rng.next(), log);
    this.nextNumber = config.first;
    this.sparesLeft = config.spare;
  }

  /** Runs to the end; resolves once every socket is closed. */
  async run(): Promise<void> {
    const { config, log } = this;
    this.eye.start();
    log(`waiting for the map from ${config.url}`);
    const deadline = Date.now() + MAP_WAIT_MS;
    while (!this.mirror.ready) {
      if (this.stopping) return;
      if (Date.now() > deadline) {
        this.eye.stop();
        throw new Error('no map within 60 s: is the game running at that URL?');
      }
      await sleep(250);
    }
    const { open, size } = this.mirror;
    log(`map ${size}², open area ${open.w}×${open.h} at ${open.x},${open.y}`);
    if (config.resume) this.canvas = await this.findCanvas();
    this.placeArts();
    this.createBots();
    const ending = new Promise<void>((resolve) => {
      this.done = resolve;
    });
    this.bots.forEach((bot, i) => {
      this.timers.push(setTimeout(() => bot.start(), (i * 1000) / config.rate));
    });
    this.timers.push(setTimeout(() => this.stop(), config.minutes * 60_000));
    const status = setInterval(() => log(this.status()), config.every * 1000);
    const retarget = setInterval(() => {
      for (const bot of this.bots) bot.player.retarget(this.world());
    }, RETARGET_MS);
    await ending;
    clearInterval(status);
    clearInterval(retarget);
    log(this.summary());
  }

  /** Ends the run: every bot and the Eye close their sockets. */
  stop(): void {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    for (const bot of this.bots) bot.stop();
    this.eye.stop();
    this.done?.();
    this.done = null;
  }

  world(): World {
    return { mirror: this.mirror, arts: this.arts, rng: this.rng, now: Date.now() };
  }

  /**
   * The season's canvas from /api/me, as a page reads it; null (and said so) if unknown. With
   * the CDN the answer names, bots load the map from there before their first socket.
   */
  private async findCanvas(): Promise<string | null> {
    const url = meUrl(this.config.url);
    let canvas: string | null = null;
    let tiles: string | null = null;
    try {
      const me = await this.fetch(url);
      canvas = canvasOf(me);
      tiles = tilesOf(me, url);
    } catch (error) {
      this.log(`${url}: ${(error as Error).message}`);
    }
    this.log(
      canvas === null
        ? 'no season canvas known: every socket gets the whole map (no resume)'
        : `canvas ${canvas}: sockets after a bot's first resume from its last seq (ADR 0040)`,
    );
    if (canvas !== null && this.config.cdn) {
      this.cdn = tiles ? new Cdn(tiles, this.stats.cdn) : null;
      this.log(
        tiles
          ? `map from the CDN at ${tiles} before each bot's first socket, which resumes from it`
          : 'no CDN named by /api/me (TILES_ORIGIN unset): first sockets get the whole map',
      );
    }
    return canvas;
  }

  private placeArts(): void {
    const { config, rng, mirror } = this;
    const { open } = mirror;
    if (config.image) {
      const { image, at, width } = config.image;
      const w = width ?? image.width;
      const h = Math.max(1, Math.round((image.height * w) / image.width));
      const [x, y] = at ?? [
        open.x + Math.floor((open.w - w) / 2),
        open.y + Math.floor((open.h - h) / 2),
      ];
      const art = imageArt(image, x, y, w);
      this.arts.push(art);
      const { rect } = art;
      const inside =
        rect.x >= open.x &&
        rect.y >= open.y &&
        rect.x + rect.w <= open.x + open.w &&
        rect.y + rect.h <= open.y + open.h;
      this.log(
        `image ${rect.w}×${rect.h} cells at ${rect.x},${rect.y}, ${art.cells} to fill` +
          (inside ? '' : ' (part of it is outside the open area: that part cannot be drawn yet)'),
      );
    }
    const edge = Math.min(config.artSize, open.w, open.h);
    for (let i = 0; i < config.arts; i++) {
      let rect: Rect = { x: open.x, y: open.y, w: edge, h: edge };
      for (let attempt = 0; attempt < 200; attempt++) {
        rect = {
          x: open.x + rng.int(open.w - edge + 1),
          y: open.y + rng.int(open.h - edge + 1),
          w: edge,
          h: edge,
        };
        if (!this.arts.some((a) => overlaps(a.rect, rect))) break;
      }
      this.arts.push(randomArt(rng, rect));
    }
  }

  private createBots(): void {
    const counts = splitBots(this.config.bots, this.config.mix);
    for (const kind of PLAYER_KINDS) {
      for (let i = 0; i < counts[kind]; i++) this.bots.push(this.newBot(kind, this.bots.length));
    }
  }

  private newBot(kind: PlayerKind, seat: number): Bot {
    const { config } = this;
    // Without artworks only casual play makes sense; with an image, builders and repairers all
    // work on it (it is arts[0]).
    const playable = this.arts.length ? kind : 'casual';
    const art = config.image && kind !== 'griefer' ? 0 : seat % Math.max(1, this.arts.length);
    const player = new Player(playable, art, this.world());
    const number = this.nextNumber++;
    return new Bot(
      number,
      player,
      config.url,
      config.identity,
      () => this.world(),
      this.stats,
      this.connect,
      () => this.rng.next(),
      {
        gone: (bot, why) => this.onGone(bot, why),
      },
      this.canvas,
      this.cdn ? () => this.cdn!.heldSeq() : null,
    );
  }

  /** A bot that cannot play on: a challenged number is replaced from the spares, once each. */
  private onGone(bot: Bot, why: GoneReason): void {
    Stats.bump(this.gone, why);
    const index = this.bots.indexOf(bot);
    if (why === 'watching' && this.gone.watching === 1) {
      this.log(
        `${bot.name}: no hold came, so the server lets it only watch: the gateway does not take ` +
          'this identity (staging needs BOT_KEY on a gateway with ADR 0034; local dev needs ' +
          'ENVIRONMENT=dev), or the bot was kicked',
      );
    }
    if (why === 'watching' && this.gone.watching === this.bots.length) {
      this.log('no bot can play: stopping');
      this.stop();
      return;
    }
    if (why === 'elsewhere')
      this.log(`${bot.name}: another socket plays as it (a second run with the same numbers?)`);
    if (why !== 'challenged' || index < 0) return;
    if (this.sparesLeft <= 0) {
      this.log(`${bot.name}: challenged, and no spare numbers left (--spare)`);
      return;
    }
    this.sparesLeft--;
    const replacement = this.newBot(bot.player.kind, index);
    this.log(`${bot.name}: challenged (out for 7 days); ${replacement.name} takes its place`);
    this.bots[index] = replacement;
    replacement.start();
  }

  private status(): string {
    const s = this.stats;
    const minutes = ((Date.now() - this.started) / 60_000).toFixed(1);
    const sum = (counts: Record<string, number>) =>
      Object.values(counts).reduce((a, b) => a + b, 0);
    const reasons = Object.entries(s.refused)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    const art = this.arts.length
      ? ` | art ${this.arts.map((a) => `${Math.round(accuracy(a, this.mirror, Date.now()) * 100)}%`).join(' ')}`
      : '';
    const joins = s.joins.slice(this.joinsShown);
    this.joinsShown = s.joins.length;
    return (
      `${minutes} min | sent ${sum(s.sent)}, accepted ${sum(s.accepted)}, refused ${sum(s.refused)}` +
      `${reasons ? ` (${reasons})` : ''}, discarded ${s.discarded}${art}` +
      (joins.length ? ` | joins ${describeJoins(joins)}` : '')
    );
  }

  private summary(): string {
    const s = this.stats;
    const table = (name: string, counts: Record<string, number>) =>
      `  ${name}: ${
        Object.entries(counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ') || 'none'
      }`;
    return [
      'summary',
      table('sent', s.sent),
      table('accepted', s.accepted),
      table('refused', s.refused),
      table('socket closes', s.closes),
      table('bots gone', this.gone),
      `  connects ${s.connects}, ack timeouts ${s.timeouts}, discarded ${s.discarded}`,
      ...(this.cdn ? [`  cdn: ${describeCdn(s.cdn)}`] : []),
      ...joinGroups(s.joins).map(([name, joins]) => `  joins, ${name}: ${describeJoins(joins)}`),
      ...this.arts.map(
        (a, i) =>
          `  art ${i} at ${a.rect.x},${a.rect.y} (${a.rect.w}×${a.rect.h}): ` +
          `${Math.round(accuracy(a, this.mirror, Number.POSITIVE_INFINITY) * 100)}% correct`,
      ),
    ].join('\n');
  }
}

/**
 * How many bots of each kind: `bots` split by the shares, largest remainders first, so the
 * counts add up to `bots` exactly and a zero share gets none.
 */
export function splitBots(
  bots: number,
  mix: Readonly<Record<PlayerKind, number>>,
): Record<PlayerKind, number> {
  const total = PLAYER_KINDS.reduce((sum, kind) => sum + mix[kind], 0);
  const exact = PLAYER_KINDS.map((kind) => (total ? (bots * mix[kind]) / total : 0));
  const counts = exact.map(Math.floor);
  let left = bots - counts.reduce((a, b) => a + b, 0);
  const byRemainder = PLAYER_KINDS.map((_, k) => k)
    .filter((k) => mix[PLAYER_KINDS[k]!] > 0)
    .sort((a, b) => exact[b]! - counts[b]! - (exact[a]! - counts[a]!) || a - b);
  for (const k of byRemainder) {
    if (left-- <= 0) break;
    counts[k]!++;
  }
  return Object.fromEntries(PLAYER_KINDS.map((kind, k) => [kind, counts[k]!])) as Record<
    PlayerKind,
    number
  >;
}

/** The gateway's /api/me next to its socket URL: ws:// becomes http://, wss:// https://. */
export function meUrl(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/me';
  url.search = '';
  return url.toString();
}

/**
 * The canvas a page names when it resumes, from an /api/me answer: the season's, or the Stage 0
 * `canvas` before any season; null while the gateway only guessed the season, or for an answer
 * of another shape.
 */
export function canvasOf(me: unknown): string | null {
  const config = (me as { config?: unknown } | null)?.config as
    | { season?: { canvas?: unknown } | null; seasonGuessed?: boolean }
    | undefined;
  if (!config || typeof config !== 'object' || config.seasonGuessed) return null;
  if (config.season == null) return 'canvas';
  return typeof config.season.canvas === 'string' && config.season.canvas
    ? config.season.canvas
    : null;
}

/** The CDN line of the summary: loads, fallbacks and why, what was fetched. */
export function describeCdn(c: CdnStats): string {
  const reasons = Object.entries(c.errors)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return (
    `${c.loaded} maps loaded, ${c.fallbacks} fell back to the socket` +
    `${reasons ? ` (${reasons})` : ''}; ${c.manifests} manifests, ` +
    `${c.objects} tiles and segments (${Math.round(c.bytes / 1024)} KB, once a run)`
  );
}

/** Joins split as the summary shows them: first maps, then later ones resumed or whole. */
export function joinGroups(joins: readonly Join[]): [string, Join[]][] {
  const groups: [string, Join[]][] = [
    ['first', joins.filter((j) => j.kind === 'first')],
    ['again, resumed', joins.filter((j) => j.kind === 'again' && j.resumed)],
    ['again, whole map', joins.filter((j) => j.kind === 'again' && !j.resumed)],
  ];
  return groups.filter(([, group]) => group.length > 0);
}

/** `12 (9 resumed), ready p50 1.8 s, p95 4.6 s, max 5.2 s; 14 KB each, p95 40 KB` (or B). */
export function describeJoins(joins: readonly Join[]): string {
  const ms = joins.map((j) => j.ms).sort((a, b) => a - b);
  const bytes = joins.map((j) => j.bytes).sort((a, b) => a - b);
  const resumed = joins.filter((j) => j.resumed).length;
  const s = (v: number) => `${(v / 1000).toFixed(1)} s`;
  const kb = (v: number) => (v < 1024 ? `${Math.round(v)} B` : `${Math.round(v / 1024)} KB`);
  const mean = bytes.reduce((a, b) => a + b, 0) / bytes.length;
  return (
    `${joins.length} (${resumed} resumed), ready p50 ${s(quantile(ms, 0.5))}, ` +
    `p95 ${s(quantile(ms, 0.95))}, max ${s(ms.at(-1)!)}; ${kb(mean)} each, ` +
    `p95 ${kb(quantile(bytes, 0.95))}`
  );
}

/** The value at quantile `q` of sorted values (nearest rank). */
function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function centred(size: number, edge: number): Rect {
  const at = Math.floor((size - edge) / 2);
  return { x: at, y: at, w: edge, h: edge };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
