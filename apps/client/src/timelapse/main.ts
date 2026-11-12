import type { Keyframes } from '@brickplace/protocol/cdn';
import { seasonParam } from '../game/share.ts';
import { wantsLessMotion } from '../game/stored-prefs.ts';
import { fetchGzip, fetchText } from '../net/cdn-fetch.ts';
import { Timelapse } from './frames.ts';
import { Latest, type Opened, openSeason, seasonHeading, winnerOf } from './load.ts';
import { cellColors, paintOverview, paintTile } from './paint.ts';
import { Playback } from './playback.ts';
import {
  closedParts,
  fitStage,
  keyAction,
  playsOverviews,
  type Rect,
  relayoutPlan,
  scaledRect,
  viewBounds,
} from './stage.ts';
import './timelapse.css';

// The season timelapse (ADR 0021): plays a season's keyframes from the public tiles bucket.
// A page of its own (timelapse.html), so the game page's bundle does not grow. `?canvas=`
// picks a season; by default the current one. The stage shows the open area, fitted to the
// page (stage.ts).

interface SeasonEntry {
  readonly id: number;
  readonly canvas: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly state: string;
  readonly tilesUrl: string | null;
}

interface SeasonList {
  readonly current: { readonly canvas: string; readonly tilesUrl: string | null };
  readonly seasons: readonly SeasonEntry[];
}

/** Frames per second at speed 1. */
const BASE_FPS = 4;
/** Room kept under the stage for the controls, so the map and its play button fit at once. */
const CONTROLS_ROOM = 150;
const MIN_STAGE = 260;
/** Over the part of the stage not open yet at the frame shown (ink at low alpha). */
const CLOSED_SHADE = 'rgba(23, 27, 38, 0.08)';
const MAX_STAGE = 900;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>('status');
const list = $<HTMLUListElement>('seasons');
const heading = $<HTMLHeadingElement>('tl-heading');
const winner = $<HTMLAnchorElement>('winner');
const winnerName = $<HTMLSpanElement>('winner-name');
const stage = $<HTMLDivElement>('stage');
const canvas = $<HTMLCanvasElement>('map');
const empty = $<HTMLDivElement>('empty');
const emptyTitle = $<HTMLHeadingElement>('empty-title');
const emptyBody = $<HTMLParagraphElement>('empty-body');
const retry = $<HTMLButtonElement>('retry');
const note = $<HTMLParagraphElement>('note');
const controls = $<HTMLDivElement>('controls');
const keys = $<HTMLParagraphElement>('keys');
const play = $<HTMLButtonElement>('play');
const slider = $<HTMLInputElement>('frame');
const first = $<HTMLSpanElement>('first');
const last = $<HTMLSpanElement>('last');
const when = $<HTMLParagraphElement>('when');
const speeds = [...document.querySelectorAll<HTMLInputElement>('input[name="speed"]')];

// Fewer frames a second for people who asked for less motion (the map's preference, which
// starts from the system setting).
const reducedMotion = wantsLessMotion();
if (reducedMotion) for (const input of speeds) input.checked = input.value === '1';
document.documentElement.dataset.motion = reducedMotion ? 'reduce' : 'full';

const say = (text: string) => {
  status.textContent = text;
};

/** The empty state in place of the map; `canRetry` offers to load again. */
function showEmpty(title: string, body: string, canRetry = false): void {
  canvas.hidden = true;
  emptyTitle.textContent = title;
  emptyBody.textContent = body;
  retry.hidden = !canRetry;
  empty.hidden = false;
  say('');
}

function speed(): number {
  return Number(speeds.find((input) => input.checked)?.value ?? 2);
}

function setPlaying(playing: boolean): void {
  play.setAttribute('aria-label', playing ? 'Pause timelapse' : 'Play timelapse');
  play.querySelector('.tl-icon-play')?.toggleAttribute('hidden', playing);
  play.querySelector('.tl-icon-pause')?.toggleAttribute('hidden', !playing);
}

function setSlider(i: number, frames: number): void {
  slider.value = String(i);
  const fill = frames > 1 ? (i / (frames - 1)) * 100 : 100;
  slider.style.setProperty('--fill', `${fill}%`);
}

async function seasons(): Promise<SeasonList | null> {
  try {
    // Same-origin cookies: the answer is public and the same for everyone, but on staging
    // Cloudflare Access lets a request through only with its own cookie (ADR 0045, amended).
    const response = await fetch('/api/seasons', { credentials: 'same-origin' });
    return response.ok ? ((await response.json()) as SeasonList) : null;
  } catch {
    return null;
  }
}

const dateLabel = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** The room the stage may take: the column's width, and the window's height under it. */
function stageBox(): { width: number; height: number } {
  const top = stage.getBoundingClientRect().top + window.scrollY;
  const room = window.innerHeight - Math.min(top, window.innerHeight / 2) - CONTROLS_ROOM;
  return {
    width: stage.clientWidth,
    height: Math.max(MIN_STAGE, Math.min(MAX_STAGE, room)),
  };
}

let player: Player | null = null;

class Player {
  private readonly context: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly colors = cellColors();
  /** The part of the image drawn: the stage's bounds, in image pixels. */
  private readonly source: Rect;
  private shown = -1;
  private loading: AbortController | null = null;
  private readonly playback: Playback;

  /**
   * `bounds`: the cells the stage shows. `small`: drawn at so few pixels a cell that the
   * frames' overviews are played instead of tiles (stage.ts, playsOverviews).
   */
  constructor(
    private readonly timelapse: Timelapse,
    private readonly bounds: Rect,
    readonly small: boolean,
  ) {
    const index = timelapse.index;
    const side = small ? timelapse.overviewSide! : index.size;
    this.source = small ? scaledRect(bounds, index.size / side) : bounds;
    canvas.width = this.source.w;
    canvas.height = this.source.h;
    this.context = canvas.getContext('2d')!;
    this.image = this.context.createImageData(side, side);
    slider.max = String(timelapse.frames - 1);
    setSlider(0, timelapse.frames);
    first.textContent = dayLabel(index.frames[0]!.at);
    last.textContent = timelapse.frames > 1 ? dayLabel(index.frames[timelapse.frames - 1]!.at) : '';
    this.layout();
    this.playback = new Playback({
      frames: timelapse.frames,
      current: () => this.shown,
      show: (frame) => this.show(frame),
      interval: () => 1000 / (BASE_FPS * speed()),
      onPlaying: setPlaying,
    });
  }

  get frames(): number {
    return this.timelapse.frames;
  }

  get current(): number {
    return this.shown;
  }

  /** Sizes the canvas to fit the stage; called again when the window changes size. */
  layout(): void {
    const fit = fitStage(this.bounds, stageBox(), window.devicePixelRatio || 1);
    canvas.style.width = `${fit.width}px`;
    canvas.style.height = `${fit.height}px`;
  }

  /** Shows frame `i`; a newer call cancels an older one still loading. */
  async show(i: number): Promise<boolean> {
    this.loading?.abort();
    const controller = new AbortController();
    this.loading = controller;
    const { index } = this.timelapse;
    try {
      if (this.small) {
        const overview = await this.timelapse.overview(i, controller.signal);
        controller.signal.throwIfAborted();
        paintOverview(this.image.data, overview, this.colors);
      } else {
        const tiles = await this.timelapse.load(i, controller.signal);
        // A newer frame took over meanwhile: painting this one would show stale tiles.
        controller.signal.throwIfAborted();
        for (const { tile, cells } of tiles) {
          paintTile(this.image.data, index.size, index.tileSize, tile, cells, this.colors);
        }
      }
      const { x, y, w, h } = this.source;
      this.context.putImageData(this.image, -x, -y, x, y, w, h);
      // Shade what was not open yet at this frame, so the open area visibly grows.
      const open = index.frames[i]!.open;
      const scale = index.size / this.image.width;
      this.context.fillStyle = CLOSED_SHADE;
      for (const part of closedParts(this.source, this.small ? scaledRect(open, scale) : open)) {
        this.context.fillRect(part.x - x, part.y - y, part.w, part.h);
      }
      canvas.hidden = false;
      this.shown = i;
      setSlider(i, this.frames);
      when.textContent = `${dateLabel(index.frames[i]!.at)} · frame ${i + 1} of ${this.frames}`;
      say('');
      return true;
    } catch (error) {
      if (!controller.signal.aborted) say(`Could not load this frame (${String(error)}).`);
      return false;
    }
  }

  toggle(): Promise<void> {
    return this.playback.toggle();
  }

  stop(): void {
    this.playback.stop();
    setPlaying(false);
    this.loading?.abort();
  }
}

function reset(): void {
  player?.stop();
  player = null;
  onStage = null;
  play.disabled = true;
  slider.disabled = true;
  // Controls show only when there is something to play.
  controls.hidden = true;
  keys.hidden = true;
  note.hidden = true;
  empty.hidden = true;
  canvas.hidden = true;
  when.textContent = '';
  first.textContent = '';
  last.textContent = '';
  setSlider(0, 1);
}

const opens = new Latest();
/** Winning-team answers for a season picked away from meanwhile are dropped. */
const winners = new Latest();
let opening: AbortController | null = null;
/** The season on the stage, kept to rebuild the player when a resize changes its mode. */
let onStage: {
  readonly base: string;
  readonly index: Keyframes;
  readonly bounds: Rect;
  readonly factor: number | null;
} | null = null;

/** Whether the stage, at its current size, plays overviews rather than tiles. */
function smallAt(bounds: Rect, factor: number | null): boolean {
  return playsOverviews(fitStage(bounds, stageBox(), window.devicePixelRatio || 1).scale, factor);
}

/**
 * After a resize: refit the canvas, and when the stage crossed the overview threshold (a
 * window maximised, a phone turned), rebuild the player in the other mode at the same frame.
 * A fresh Timelapse, as the old one tracks which tiles its own image holds.
 */
function relayout(): void {
  if (!player || !onStage) return;
  const small = smallAt(onStage.bounds, onStage.factor);
  const plan = relayoutPlan(player, small);
  if (plan.kind === 'refit') {
    player.layout();
    return;
  }
  player.stop();
  const timelapse = new Timelapse(onStage.base, onStage.index, fetchGzip);
  player = new Player(timelapse, onStage.bounds, small);
  void player.show(plan.frame);
}

async function open(tilesUrl: string | null, season?: SeasonEntry): Promise<void> {
  // A newer open (another season picked) cancels this one and wins every check below.
  opening?.abort();
  const controller = new AbortController();
  opening = controller;
  const ticket = opens.next();
  reset();
  say('Loading the timelapse…');
  let opened: Opened;
  try {
    opened = await openSeason(tilesUrl, location.href, fetchText, controller.signal);
  } catch (error) {
    if (opens.isCurrent(ticket)) {
      showEmpty('Could not read this timelapse', String(error), true);
    }
    return;
  }
  if (!opens.isCurrent(ticket)) return;
  if (opened.kind === 'no_bucket') {
    showEmpty(
      'The timelapse is not set up here',
      'It plays from the public map bucket, which this site has not set up yet. The live map works as usual.',
    );
    return;
  }
  if (opened.kind === 'no_frames') {
    showEmpty(
      'No frames yet',
      'The timelapse starts once the first bricks are placed. New frames are added as the map changes.',
    );
    return;
  }
  const { base, index } = opened;
  // The index knows whether the archive is sealed, earlier than the gateway's times do.
  if (season) heading.textContent = seasonHeading(season, index.sealed === true);
  const timelapse = new Timelapse(base, index, fetchGzip);
  const side = timelapse.overviewSide;
  const factor = side === null ? null : index.size / side;
  const bounds = viewBounds(index.frames, index.size, factor ?? 1);
  onStage = { base, index, bounds, factor };
  player = new Player(timelapse, bounds, smallAt(bounds, factor));
  if (timelapse.frames < 2) {
    note.textContent =
      'Only one frame so far. New frames are added as the map changes: come back later to watch it grow.';
    note.hidden = false;
  } else {
    play.disabled = false;
    slider.disabled = false;
    controls.hidden = false;
    keys.hidden = false;
  }
  // The latest frame first: the map as it is (or ended), with Play running from the start.
  await player.show(timelapse.frames - 1);
}

function seasonName(season: { readonly id: number }): string {
  return season.id > 0 ? `Season ${season.id}` : 'Current map';
}

/** The season list: one link per season, the shown one marked. */
function renderSeasons(entries: readonly SeasonEntry[], selected: string): void {
  list.replaceChildren(
    ...entries.map((season) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'tl-season';
      link.href = `?canvas=${encodeURIComponent(season.canvas)}`;
      if (season.canvas === selected) link.setAttribute('aria-current', 'page');
      const name = document.createElement('span');
      name.className = 'tl-season-name';
      name.textContent = seasonName(season);
      if (season.state === 'live') {
        const live = document.createElement('span');
        live.className = 'tl-live';
        live.textContent = 'Live';
        name.append(live);
      }
      const meta = document.createElement('span');
      meta.className = 'tl-season-meta';
      meta.textContent =
        season.id > 0
          ? `${dayLabel(season.startsAt)} – ${dayLabel(season.endsAt)}`
          : 'The map so far';
      link.append(name, meta);
      link.addEventListener('click', (event) => {
        // A new tab or window keeps the browser's own handling.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        select(entries, season.canvas);
      });
      item.append(link);
      return item;
    }),
  );
}

function select(entries: readonly SeasonEntry[], canvasName: string): void {
  const season = entries.find((s) => s.canvas === canvasName) ?? entries[0]!;
  const params = new URLSearchParams(location.search);
  params.set('canvas', season.canvas);
  params.delete('season');
  history.replaceState(null, '', `?${params}`);
  renderSeasons(entries, season.canvas);
  heading.textContent = seasonHeading(season, null);
  void showWinner(season);
  void open(season.tilesUrl, season);
}

/** A season that is over: its winning team, linking to that season's ranking on the map page. */
async function showWinner(season: SeasonEntry): Promise<void> {
  const ticket = winners.next();
  winner.hidden = true;
  if (season.id <= 0 || season.state === 'live' || season.state === 'scheduled') return;
  let best: ReturnType<typeof winnerOf> = null;
  try {
    const response = await fetch(`/api/teams/ranking?season=${season.id}`);
    best = response.ok ? winnerOf(await response.json()) : null;
  } catch {
    // No ranking (offline, no accounts here): no card, the timelapse plays as usual.
  }
  if (!winners.isCurrent(ticket) || !best) return;
  winnerName.textContent =
    best.tied > 1 ? `${best.name} and ${best.tied - 1} more →` : `${best.name} →`;
  winner.href = `/?ranking=${season.id}`;
  winner.hidden = false;
}

/** Keys anywhere on the page, except where they already mean something (a field, a radio). */
function onKey(event: KeyboardEvent): void {
  if (!player || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName ?? '';
  const focus =
    tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
      ? 'field'
      : tag === 'BUTTON' || tag === 'A'
        ? 'control'
        : 'page';
  const action = keyAction(event.key, focus, !play.disabled, player.current, player.frames);
  if (!action) return;
  event.preventDefault();
  if (action.kind === 'toggle') {
    void player.toggle();
    return;
  }
  player.stop();
  void player.show(action.frame);
}

play.addEventListener('click', () => void player?.toggle());
slider.addEventListener('input', () => {
  if (!player) return;
  player.stop();
  void player.show(Number(slider.value));
});
document.addEventListener('keydown', onKey);
let resizing = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(relayout);
});
retry.addEventListener('click', () => location.reload());

const answer = await seasons();
if (!answer) {
  showEmpty(
    'Could not reach the server',
    'The list of seasons did not load. Check your connection and try again.',
    true,
  );
} else {
  // `?canvas=` picks a season by its canvas; `?season=<id>` by its number (a share link from
  // another season sends here).
  const params = new URLSearchParams(location.search);
  const bySeason = seasonParam(params, 'season');
  const wanted =
    params.get('canvas') ??
    answer.seasons.find((s) => s.id === bySeason)?.canvas ??
    answer.current.canvas;
  const entries: readonly SeasonEntry[] = answer.seasons.length
    ? answer.seasons
    : [
        {
          id: 0,
          canvas: answer.current.canvas,
          tilesUrl: answer.current.tilesUrl,
          startsAt: 0,
          endsAt: 0,
          state: 'live',
        },
      ];
  select(entries, entries.some((s) => s.canvas === wanted) ? wanted : entries[0]!.canvas);
}
