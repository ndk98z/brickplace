import { cellsOf, type Rotation, SHAPE_NAMES, type ShapeId } from '@brickplace/core';
import { useEffect, useState } from 'preact/hooks';
import type { Sponsor } from '../config.ts';
import type { Account } from '../game/account.ts';
import type { Game } from '../game/game.ts';
import type { Hold, Item } from '../game/hold.ts';
import type { LiveStats } from '../game/live-stats.ts';
import { nextSeasonText, seasonOver } from '../game/states.ts';
import { inkOn, PALETTE } from '../palette.ts';
import { HammerIcon, HeartIcon, RotateIcon, ShieldIcon } from './icons.tsx';
import { DropRates } from './LiveStats.tsx';
import { useSelector } from './observable.ts';
import { useNow } from './SystemStates.tsx';

function BrickIcon({
  shape,
  rotation,
  color,
}: {
  shape: ShapeId;
  rotation: Rotation;
  color: string;
}) {
  const cells = cellsOf(shape, rotation);
  const w = Math.max(...cells.map(([x]) => x)) + 1;
  const h = Math.max(...cells.map(([, y]) => y)) + 1;
  // Long bricks get smaller cells so every rotation fits the 48 x 40 icon box.
  const size = Math.max(w, h) > 3 ? 9 : 13;
  return (
    <span
      class="brick-icon"
      style={{ gridTemplateColumns: `repeat(${w}, ${size}px)`, gridAutoRows: `${size}px` }}
    >
      {cells.map(([x, y]) => (
        <span
          key={`${x},${y}`}
          class="brick-icon-cell"
          style={{ gridColumn: x + 1, gridRow: y + 1, background: color }}
        />
      ))}
    </span>
  );
}

function itemText(item: Item): { label: string; sub: string } {
  switch (item.kind) {
    case 'brick':
      return { label: 'Brick', sub: `${SHAPE_NAMES[item.shape]} shape · 4 cells` };
    case 'hammer':
      return { label: 'Hammer', sub: 'Clears 1 cell or 1 shield layer' };
    case 'shield':
      return { label: 'Shield', sub: 'Adds 1 layer to a filled cell' };
    case 'single':
      return { label: 'Single brick', sub: 'Fills 1 hole' };
  }
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function Countdown({ hold }: { hold: Hold }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (hold.nextAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [hold.nextAt]);
  if (hold.nextAt === null) {
    return (
      <div class="slot slot-empty slot-idle">
        <span class="slot-sub">Empty</span>
      </div>
    );
  }
  const left = hold.nextAt - now;
  const progress = Math.min(1, Math.max(0, 1 - left / hold.cooldownMs));
  return (
    <div class="slot slot-empty">
      <span class="slot-timer">{formatCountdown(left)}</span>
      <span class="slot-progress">
        <span class="slot-progress-label">Next item arrives</span>
        <span class="progress-track" aria-hidden="true">
          <span class="progress-fill" style={{ width: `${progress * 100}%` }} />
        </span>
      </span>
    </div>
  );
}

function HoldSlots({ game }: { game: Game }) {
  const { hold, selected, rotation, color } = useSelector(game.ui, (s) => ({
    hold: s.hold,
    selected: s.selected,
    rotation: s.rotation,
    color: s.color,
  }));
  const empty = hold.capacity - hold.items.length;
  return (
    <div class="slots">
      {hold.items.map((item) => {
        const on = item.id === selected;
        const pending = hold.pending.has(item.id);
        const { label, sub } = itemText(item);
        return (
          <button
            key={item.id}
            type="button"
            class={`slot${on ? ' slot-on' : ''}`}
            aria-pressed={on}
            disabled={pending}
            onClick={() => game.select(item.id)}
          >
            <span class="slot-icon" aria-hidden="true">
              {item.kind === 'brick' && (
                <BrickIcon
                  shape={item.shape}
                  rotation={on ? rotation : 0}
                  color={PALETTE[color]!}
                />
              )}
              {item.kind === 'hammer' && <HammerIcon />}
              {item.kind === 'shield' && <ShieldIcon />}
              {item.kind === 'single' && (
                <span class="single-icon" style={{ background: PALETTE[color]! }} />
              )}
            </span>
            <span class="slot-text">
              <span class="slot-label">{label}</span>
              <span class="slot-sub">{pending ? 'Sending…' : sub}</span>
            </span>
          </button>
        );
      })}
      {empty > 0 && <Countdown hold={hold} />}
      {Array.from({ length: Math.max(0, empty - 1) }, (_, i) => (
        <div key={`empty-${i}`} class="slot slot-empty slot-idle">
          <span class="slot-sub">Empty</span>
        </div>
      ))}
    </div>
  );
}

function Palette({ game }: { game: Game }) {
  const color = useSelector(game.ui, (s) => s.color);
  return (
    <div class="palette">
      <span class="section-label">Colour · #{color + 1}</span>
      <div role="radiogroup" aria-label="Brick colour" class="swatches">
        {PALETTE.map((hex, i) => (
          // biome-ignore lint/a11y/useSemanticElements: numbered swatch buttons as in the design; role and aria-checked keep the radio-group semantics.
          <button
            key={hex}
            type="button"
            role="radio"
            aria-checked={color === i}
            aria-label={`Colour ${i + 1}`}
            class={`swatch${color === i ? ' swatch-on' : ''}`}
            style={{ background: hex, color: inkOn(hex) }}
            onClick={() => game.setColor(i)}
          >
            {i + 1}
          </button>
        ))}
      </div>
    </div>
  );
}

function hintFor(item: Item | undefined): string {
  if (!item) return 'Pick an item from your hold. Drag to move the map, scroll or pinch to zoom.';
  switch (item.kind) {
    case 'brick':
      return 'Click a cell to place · R to rotate · Esc to cancel.';
    case 'hammer':
      return 'Click a filled cell to clear it, or to knock one layer off its shield.';
    case 'shield':
      return 'Click a filled cell to add a shield layer.';
    case 'single':
      return 'Single bricks only fit holes no brick can fill. Click such a hole to repair it.';
  }
}

function Sponsors({ sponsors }: { sponsors: readonly Sponsor[] }) {
  if (sponsors.length === 0) return null;
  return (
    <>
      <span class="section-label section-label-caps">Sponsored by</span>
      <div class="sponsors">
        {sponsors.map((s) => (
          <a
            key={s.href}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer sponsored"
            class={`sponsor${s.featured ? ' sponsor-featured' : ''}`}
            aria-label={s.name}
          >
            {s.logo ? <img src={s.logo} alt="" /> : s.name}
          </a>
        ))}
      </div>
    </>
  );
}

/** In place of the hold for a page that only watches. */
function WatchCard({ account }: { account: Account }) {
  const { signedIn, canSignIn, season, next } = useSelector(account.state, (s) => ({
    signedIn: s.me.signedIn,
    canSignIn: s.me.config.providers.length > 0,
    season: s.me.config.season ?? null,
    next: s.me.config.nextSeason ?? null,
  }));
  const now = useNow(60_000);
  if (seasonOver(season, now)) {
    // Nothing to play until the next season: no "sign in to play" on a read-only map.
    return (
      <div class="watch-card">
        <strong class="watch-title">Season over</strong>
        <span class="slot-sub">
          The map is read-only. {nextSeasonText(next, now) ?? 'A new season is coming.'}
        </span>
        {!signedIn && canSignIn && (
          <button type="button" class="btn btn-dark" onClick={() => account.open('signin')}>
            Sign in for the next one
          </button>
        )}
      </div>
    );
  }
  return (
    <div class="watch-card">
      <strong class="watch-title">You're watching</strong>
      <span class="slot-sub">
        {signedIn
          ? 'Pick a nickname to get items: one every minute, up to three in your hold.'
          : 'Sign in to get items: one every minute, up to three in your hold.'}
      </span>
      {(signedIn || canSignIn) && (
        <button
          type="button"
          class="btn btn-dark"
          onClick={() => account.open(signedIn ? 'nickname' : 'signin')}
        >
          {signedIn ? 'Pick a nickname' : 'Sign in to play'}
        </button>
      )}
    </div>
  );
}

export function ToolColumn({
  game,
  account,
  live,
}: {
  game: Game;
  account: Account;
  /** The canvas stats for "Drops now"; the block is left out without them. */
  live?: LiveStats;
}) {
  const { count, capacity, selectedItem, watching } = useSelector(game.ui, (s) => ({
    count: s.hold.items.length,
    capacity: s.hold.capacity,
    selectedItem: s.hold.items.find((item) => item.id === s.selected),
    watching: s.role === 'watcher',
  }));
  const { kofiUrl, sponsors, sponsorInfoUrl } = game.config;
  const isBrick = selectedItem?.kind === 'brick';
  const hasColour = isBrick || selectedItem?.kind === 'single';
  return (
    <aside class="tools" aria-label="Tools">
      <div class="tools-head">
        <h2>Your items</h2>
        <span class="tools-count">
          {count} / {capacity}
        </span>
      </div>
      {watching ? <WatchCard account={account} /> : <HoldSlots game={game} />}
      {live && <DropRates account={account} live={live} />}
      <div class="tool-actions">
        <button
          type="button"
          class="btn btn-dark"
          disabled={!isBrick}
          onClick={() => game.rotate()}
        >
          <RotateIcon />
          Rotate · R
        </button>
        <button
          type="button"
          class="btn btn-light"
          disabled={!selectedItem}
          onClick={() => game.discard()}
        >
          Discard
        </button>
      </div>
      {hasColour && <Palette game={game} />}
      <p class="hint">{hintFor(selectedItem)}</p>
      <div class="tools-foot">
        <Sponsors sponsors={sponsors} />
        <div class="donate-row">
          {kofiUrl ? (
            <a class="donate" href={kofiUrl} target="_blank" rel="noopener noreferrer">
              <HeartIcon />
              Donate
            </a>
          ) : (
            <span class="donate donate-off" aria-disabled="true" title="Donations open soon">
              <HeartIcon />
              Donate
            </span>
          )}
          {sponsorInfoUrl && (
            <a class="foot-link" href={sponsorInfoUrl}>
              Become a sponsor
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}
