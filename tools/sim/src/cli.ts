import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_OPEN_GROWTH, PHASES } from '@brickplace/core';
import {
  DEFAULT_CONFIG,
  type NoFit,
  type PhaseBy,
  type PhaseRates,
  PLAYER_KINDS,
  type PlayerKind,
  parseRates,
  type ShapeDraw,
  type SimConfig,
} from './config.ts';
import { type Report, run, summarize } from './sim.ts';
import type { HammerMode } from './world.ts';

function ratesText(rates: PhaseRates): string {
  return PHASES.map((phase) => rates[phase].join('/')).join(',');
}

const USAGE = `Usage: pnpm --filter @brickplace/sim sim [options]

  --hours N        season length in hours (default ${DEFAULT_CONFIG.hours})
  --players N      concurrent players (default ${DEFAULT_CONFIG.players})
  --seed N         random seed (default ${DEFAULT_CONFIG.seed})
  --map N          map edge (default ${DEFAULT_CONFIG.mapSize})
  --open N         starting open edge (default ${DEFAULT_CONFIG.openSize})
  --grow N         cells added per side on growth (default ${DEFAULT_CONFIG.growth.step}, the core's
                   ${DEFAULT_OPEN_GROWTH.step} scaled to the sim map; grows at ${DEFAULT_CONFIG.growth.atPercent}% full)
  --arts N         artworks (default ${DEFAULT_CONFIG.arts})
  --search N       spots compared per brick, i.e. packing skill (default ${DEFAULT_CONFIG.search})
  --hammer MODE    cell (the rule) or piece (experiment: a hit clears the whole brick)
  --phases BY      room (the core, ADR 0010: share no brick can reach) or fill (experiment,
                   the ADR 0005 rule); default room
  --draw MODE      fit (ADR 0010: only shapes that fit, else a shield) or any; default fit
  --fit-min N      experiment: placements a shape needs to count as fitting (default 1)
  --no-fit MODE    when no shape fits: shield (ADR 0010) or redraw (experiment: single,
                   hammer or shield by their phase rates); default shield
  --refresh N      ticks between scans that give players the cells to aim at (default
                   ${DEFAULT_CONFIG.refreshTicks}); draws and phases always read the core's live counters
  --room-scale P   experiment: keep a brick draw with probability min(1, placements / P),
                   else re-draw it as above; 0 (default) is off
  --rates R        brick/single/hammer/shield per phase, whole numbers; default the core's
                   ${ratesText(DEFAULT_CONFIG.items.rates)} (ADR 0011)
  --mix M          builder/casual/griefer/repairer shares, e.g. 40/40/10/10
  --every N        print a row every N hours (default 6)
  --json FILE      write the full report as JSON`;

const { values } = parseArgs({
  options: {
    hours: { type: 'string' },
    players: { type: 'string' },
    seed: { type: 'string' },
    map: { type: 'string' },
    open: { type: 'string' },
    grow: { type: 'string' },
    arts: { type: 'string' },
    search: { type: 'string' },
    hammer: { type: 'string' },
    phases: { type: 'string' },
    draw: { type: 'string' },
    'fit-min': { type: 'string' },
    'no-fit': { type: 'string' },
    'room-scale': { type: 'string' },
    refresh: { type: 'string' },
    rates: { type: 'string' },
    mix: { type: 'string' },
    every: { type: 'string' },
    json: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const num = (text: string | undefined, fallback: number) => {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a number: ${text}`);
  return n;
};

function parseMix(text: string): Record<PlayerKind, number> {
  const shares = text.split('/').map(Number);
  if (shares.length !== PLAYER_KINDS.length || shares.some((s) => !Number.isFinite(s) || s < 0)) {
    throw new Error(`bad mix "${text}": expected builder/casual/griefer/repairer`);
  }
  return Object.fromEntries(PLAYER_KINDS.map((kind, i) => [kind, shares[i]!])) as Record<
    PlayerKind,
    number
  >;
}

function parseHammer(text: string | undefined): HammerMode {
  if (text === undefined) return DEFAULT_CONFIG.hammerMode;
  if (text !== 'cell' && text !== 'piece') throw new Error(`bad hammer mode "${text}"`);
  return text;
}

function parseChoice<T extends string>(
  text: string | undefined,
  choices: readonly T[],
  fallback: T,
  name: string,
): T {
  if (text === undefined) return fallback;
  if (!(choices as readonly string[]).includes(text)) throw new Error(`bad ${name} "${text}"`);
  return text as T;
}

const config: SimConfig = {
  ...DEFAULT_CONFIG,
  hours: num(values.hours, DEFAULT_CONFIG.hours),
  players: num(values.players, DEFAULT_CONFIG.players),
  seed: num(values.seed, DEFAULT_CONFIG.seed),
  mapSize: num(values.map, DEFAULT_CONFIG.mapSize),
  openSize: num(values.open, DEFAULT_CONFIG.openSize),
  growth: { ...DEFAULT_CONFIG.growth, step: num(values.grow, DEFAULT_CONFIG.growth.step) },
  arts: num(values.arts, DEFAULT_CONFIG.arts),
  search: Math.max(1, num(values.search, DEFAULT_CONFIG.search)),
  hammerMode: parseHammer(values.hammer),
  phaseBy: parseChoice<PhaseBy>(values.phases, ['room', 'fill'], DEFAULT_CONFIG.phaseBy, 'phases'),
  shapeDraw: parseChoice<ShapeDraw>(values.draw, ['fit', 'any'], DEFAULT_CONFIG.shapeDraw, 'draw'),
  fitMin: Math.max(1, num(values['fit-min'], DEFAULT_CONFIG.fitMin)),
  noFit: parseChoice<NoFit>(values['no-fit'], ['shield', 'redraw'], DEFAULT_CONFIG.noFit, 'no-fit'),
  roomScale: num(values['room-scale'], DEFAULT_CONFIG.roomScale),
  refreshTicks: Math.max(1, Math.round(num(values.refresh, DEFAULT_CONFIG.refreshTicks))),
  items: values.rates
    ? { ...DEFAULT_CONFIG.items, rates: parseRates(values.rates) }
    : DEFAULT_CONFIG.items,
  mix: values.mix ? parseMix(values.mix) : DEFAULT_CONFIG.mix,
};

const started = performance.now();
const report = run(config);
print(report, num(values.every, 6));
console.log(`\n${((performance.now() - started) / 1000).toFixed(1)} s`);
if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);

function print(r: Report, every: number): void {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const rows = r.snapshots.filter((s, i) => (i + 1) % every === 0 || s === r.final);
  console.table(
    rows.map((s) => ({
      hour: s.hour,
      edge: s.openEdge,
      phase: s.phase,
      fill: pct(s.fill),
      blocked: pct(s.blocked),
      shapes: s.shapesFit,
      holes: s.holes,
      singles: pct(s.singleShare),
      'art ok': pct(s.artAccuracy),
      intact: `${s.artsIntact}/${r.config.arts}`,
      'art holes': s.artHoles,
      shielded: s.shieldedCells,
    })),
  );
  console.log(
    'growth:',
    r.growth.map((g) => `${g.edge} at ${g.hour.toFixed(1)} h`).join(', ') || 'none',
  );
  console.table(
    Object.fromEntries((['drawn', 'used', 'discarded'] as const).map((key) => [key, r[key]])),
  );
  console.log(`singles drawn with no hole on the map, given as bricks: ${r.convertedSingles}`);
  console.log(
    `bricks drawn with no shape fitting anywhere, given as shields: ${r.bricksAsShields}`,
  );
  console.log(
    `bricks re-drawn as another item (--no-fit redraw, --room-scale): ${r.bricksRedrawn}`,
  );
  const s = summarize(r);
  const at = (values: readonly (number | null)[]) =>
    values.map((v) => (v === null ? '–' : pct(v))).join(' / ');
  const extra = [
    r.config.fitMin > 1 ? `fit-min ${r.config.fitMin}` : '',
    r.config.noFit !== 'shield' ? `no-fit ${r.config.noFit}` : '',
    r.config.roomScale > 0 ? `room-scale ${r.config.roomScale}` : '',
  ]
    .filter(Boolean)
    .map((text) => `, ${text}`)
    .join('');
  console.log(`summary (${r.config.phaseBy} phases, ${r.config.shapeDraw} draw${extra}):`);
  console.log(`  art correct ${pct(s.artAccuracy)}, ${s.artsIntact}/${r.config.arts} intact`);
  console.log(`  singles at 24 / 72 / 168 h: ${at(s.singleShareAt)}`);
  console.log(
    `  bricks used: ${s.bricksUsedAt.map((v) => v ?? '–').join(' / ')} by 24 / 72 / 168 h`,
  );
  console.log(
    `  discarded: ${pct(s.discardShare)} of drawn items, ${pct(s.casualDiscardShare)} of casual players' (bricks ${pct(s.brickDiscardShare)} of drawn bricks)`,
  );
  console.log(
    `  hours per phase: ${Object.entries(s.phaseHours)
      .map(([name, hours]) => `${name} ${hours}`)
      .join(', ')}`,
  );
}
