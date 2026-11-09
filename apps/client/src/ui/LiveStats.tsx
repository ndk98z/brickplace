import { type ItemKind, PHASE_THRESHOLDS, PHASES } from '@brickplace/core';
import { useState } from 'preact/hooks';
import type { Account } from '../game/account.ts';
import type { Game } from '../game/game.ts';
import {
  dropShares,
  type LiveStats,
  latestCount,
  PHASE_NAMES,
  STATS_STALE_MS,
} from '../game/live-stats.ts';
import { seasonOver } from '../game/states.ts';
import { useSelector } from './observable.ts';
import { useNow } from './SystemStates.tsx';

// The Game design's live numbers (ADR 0030): players on the map, the phase and how full the
// open area is, the player's team online, and what drops now.

const number = new Intl.NumberFormat('en-US');

const KIND_NAMES: Record<ItemKind, string> = {
  brick: 'Brick',
  single: 'Single',
  hammer: 'Hammer',
  shield: 'Shield',
};

/** The current stats while fresh, from the poll. */
function useStats(live: LiveStats) {
  useSelector(live.state, (s) => s.at);
  const now = useNow(30_000);
  return { stats: live.current(now), now };
}

/** Whether the season the page shows is over: no phase or drops for a read-only map. */
function useOver(account: Account, now: number): boolean {
  const season = useSelector(account.state, (s) => s.me.config.season ?? null);
  return seasonOver(season, now);
}

/** "● 1,284 playing now": the freshest of the poll and the socket's own frames. */
export function PlayingPill({ game, live }: { game: Game; live: LiveStats }) {
  const { stats, now } = useStats(live);
  const at = useSelector(live.state, (s) => s.at);
  const socket = useSelector(game.ui, (s) => s.live);
  const playing = latestCount(
    stats ? { value: stats.playing, at } : null,
    socket ? { value: socket.playing, at: socket.at } : null,
    now,
  );
  if (playing === null) return null;
  return (
    <span class="chip chip-green" title="Players with the map open and signed in, everywhere">
      <span class="live-dot" aria-hidden="true" />
      {number.format(playing)} playing now
    </span>
  );
}

/** "Settling · 42% filled": the phase draws use now and what sets it. */
export function PhasePill({ account, live }: { account: Account; live: LiveStats }) {
  const { stats, now } = useStats(live);
  const over = useOver(account, now);
  if (!stats || over) return null;
  // The pill's number sets the phase; the map grows by another number, which the title gives.
  let title = 'How much of the open area no brick can reach';
  if (stats.built !== null) title += `. Bricks cover ${stats.built}% of it`;
  if (stats.built !== null && stats.growsAt !== null) {
    title += `; the map grows at ${stats.growsAt}%`;
  }
  return (
    <span class="chip chip-blue" title={title}>
      {PHASE_NAMES[stats.phase]} · {stats.filled}% filled
    </span>
  );
}

/** "· 12 online" for the team pill: the socket's last count of the player's team. */
export function TeamOnline({ game }: { game: Game }) {
  const socket = useSelector(game.ui, (s) => s.live);
  const now = useNow(30_000);
  if (!socket || socket.team === null || now - socket.at >= STATS_STALE_MS) return null;
  return (
    <>
      <span class="pill-sep" aria-hidden="true">
        ·
      </span>
      <span class="team-online">
        <span class="live-dot" aria-hidden="true" />
        {number.format(socket.team)} online
      </span>
    </>
  );
}

/** "Drops now": the current phase's shares as a bar and a legend, every phase on demand. */
export function DropRates({ account, live }: { account: Account; live: LiveStats }) {
  const { stats, now } = useStats(live);
  const over = useOver(account, now);
  const [open, setOpen] = useState(false);
  if (!stats || over) return null;
  const shares = dropShares(stats.rates[stats.phase]);
  const label = shares.map((s) => `${KIND_NAMES[s.kind]} ${s.percent}%`).join(', ');
  return (
    <section class="drops" aria-labelledby="drops-title">
      <div class="drops-head">
        <h3 id="drops-title" class="drops-title">
          Drops now · {PHASE_NAMES[stats.phase]}
        </h3>
        <button
          type="button"
          class="drops-toggle"
          aria-expanded={open}
          aria-controls="drops-table"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide' : 'As the map fills'}
        </button>
      </div>
      <div class="drops-bar" role="img" aria-label={`Drop rates now: ${label}`}>
        {shares
          .filter((s) => s.percent > 0)
          .map((s) => (
            <span
              key={s.kind}
              class={`drops-seg drops-${s.kind}`}
              style={{ flexGrow: s.percent }}
            />
          ))}
      </div>
      <ul class="drops-legend">
        {shares.map((s) => (
          <li key={s.kind}>
            <span class={`drops-swatch drops-${s.kind}`} aria-hidden="true" />
            {KIND_NAMES[s.kind]} <strong>{s.percent}%</strong>
          </li>
        ))}
      </ul>
      {open && (
        <table id="drops-table" class="drops-table">
          <thead>
            <tr>
              <th scope="col">Map filled</th>
              {shares.map((s) => (
                <th key={s.kind} scope="col">
                  {KIND_NAMES[s.kind]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PHASES.map((phase) => (
              <tr key={phase} class={phase === stats.phase ? 'drops-now' : undefined}>
                <th scope="row">{PHASE_RANGES[phase]}</th>
                {dropShares(stats.rates[phase]).map((s) => (
                  <td key={s.kind}>{s.percent}%</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The share of the open area no brick can reach in each phase (ADR 0010's thresholds). */
const PHASE_RANGES = {
  settling: `Under ${PHASE_THRESHOLDS[0]}%`,
  contested: `${PHASE_THRESHOLDS[0]}–${PHASE_THRESHOLDS[1]}%`,
  saturated: `Over ${PHASE_THRESHOLDS[1]}%`,
} as const;
