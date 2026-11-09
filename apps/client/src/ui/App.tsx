import { useEffect, useRef, useState } from 'preact/hooks';
import type { Account } from '../game/account.ts';
import type { Game, LinkStatus, UiState } from '../game/game.ts';
import type { LiveStats } from '../game/live-stats.ts';
import type { Screens } from '../game/screens.ts';
import type { SystemStatus } from '../game/states.ts';
import type { Teams } from '../game/teams.ts';
import type { Notice } from '../net/messages.ts';
import { AccountButton, AccountDialogs, ChallengeDialog } from './AccountDialogs.tsx';
import { PhasePill, PlayingPill } from './LiveStats.tsx';
import { Logo } from './Logo.tsx';
import { lazy } from './lazy.tsx';
import { CONTRIBUTORS_PAGE, TIMELAPSE_PAGE } from './links.ts';
import { MapControls, Minimap, ShieldTip } from './MapControls.tsx';
import { useSelector } from './observable.ts';
import { SeasonChip, SystemStates, WelcomeCard } from './SystemStates.tsx';
import { TeamScreens } from './TeamScreens.tsx';
import { ToolColumn } from './ToolColumn.tsx';

// Screens most visits never open load on demand, in chunks of their own.
const Landing = lazy(() => import('./Landing.tsx').then((m) => m.Landing));
const Guide = lazy(() => import('./Guide.tsx').then((m) => m.Guide));
const ShareDialog = lazy(() => import('./ShareDialog.tsx').then((m) => m.ShareDialog));

const LOAD_FAILED: Notice = {
  title: 'Reload to get the latest version',
  body: 'This part of the page could not load, probably because the game was just updated.',
  tone: 'warn',
  action: { label: 'Reload', run: () => location.reload() },
};

function connectionLabel(status: LinkStatus): string {
  switch (status.state) {
    case 'cdn':
      // Read from the CDN: a few seconds behind the live map.
      return status.ok ? 'Near live' : 'Offline';
    case 'open':
      return 'Live';
    case 'connecting':
      return 'Connecting…';
    case 'waiting':
      return 'Offline';
  }
}

function roleLabel(role: UiState['role']): string | null {
  if (role === 'guest') return 'Dev guest';
  if (role === 'watcher') return 'Watching';
  return null;
}

function Header({
  game,
  account,
  teams,
  screens,
  status,
  live,
  inert,
}: {
  game: Game;
  account: Account;
  teams: Teams;
  screens: Screens;
  status: SystemStatus;
  live?: LiveStats;
  inert: boolean;
}) {
  const connection = useSelector(game.ui, (s) => s.connection);
  const role = roleLabel(useSelector(game.ui, (s) => s.role));
  return (
    <header class="header" inert={inert}>
      <button
        type="button"
        class="logo logo-button"
        aria-label="About BrickPlace"
        onClick={() => screens.open('landing')}
      >
        <Logo />
      </button>
      <div class="header-pills">
        <SeasonChip account={account} status={status} />
        {live && <PhasePill account={account} live={live} />}
        {live && <PlayingPill game={game} live={live} />}
        <span class={`chip chip-keep chip-${connection.state}`} role="status">
          {connectionLabel(connection)}
        </span>
        {role && <span class="chip">{role}</span>}
      </div>
      <nav aria-label="Main" class="nav">
        <button type="button" class="nav-link" onClick={() => void teams.openRanking()}>
          Ranking
        </button>
        <a class="nav-link" href={TIMELAPSE_PAGE} title="Watch the season so far">
          Timelapse
        </a>
        <button type="button" class="nav-link" onClick={() => void teams.openTeam()}>
          Team
        </button>
        <a class="nav-link" href={CONTRIBUTORS_PAGE}>
          Contributors
        </a>
      </nav>
      <AccountButton account={account} />
    </header>
  );
}

function Reconnecting({ game }: { game: Game }) {
  const connection = useSelector(game.ui, (s) => s.connection);
  const watching = useSelector(game.ui, (s) => s.role === 'watcher');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (connection.state !== 'waiting') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [connection]);
  if (connection.state !== 'waiting') return null;
  const seconds = Math.max(0, Math.ceil((connection.retryAt - now) / 1000));
  return (
    <div class="toast toast-dark" role="status">
      <span class="spinner" aria-hidden="true" />
      <span class="toast-text">
        <strong>{seconds > 0 ? `Reconnecting in ${seconds} s…` : 'Reconnecting…'}</strong>
        <span>
          {watching
            ? 'The map catches up once it is back.'
            : 'Your items and timer are safe on the server.'}
        </span>
      </span>
    </div>
  );
}

/** The design's toast icons: a warning for "busy", an alert for "warn", a tick otherwise. */
function ToastIcon({ tone }: { tone: Notice['tone'] }) {
  const path =
    tone === 'busy' ? (
      <>
        <path d="M12 3l9 16H3z" />
        <path d="M12 10v4M12 17v.5" />
      </>
    ) : tone === 'warn' ? (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 16v.5" />
      </>
    ) : (
      <path d="M5 12l5 5 9-10" />
    );
  return (
    <svg
      class="toast-icon"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

function Notices({
  game,
  account,
  teams,
  screens,
  status,
}: {
  game: Game;
  account: Account;
  teams: Teams;
  screens: Screens;
  status: SystemStatus;
}) {
  const notices = useSelector(game.ui, (s) => s.notices);
  return (
    <div class="toasts">
      <WelcomeCard game={game} account={account} screens={screens} />
      <SystemStates game={game} account={account} teams={teams} status={status} />
      <Reconnecting game={game} />
      {notices.map(({ id, notice }) => (
        <div key={id} class={`toast toast-${notice.tone}`} role="status">
          <ToastIcon tone={notice.tone} />
          <span class="toast-text">
            <strong>{notice.title}</strong>
            <span>{notice.body}</span>
          </span>
          {notice.action && (
            <button type="button" class="btn btn-dark toast-action" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          )}
          <button
            type="button"
            class="toast-close"
            aria-label="Dismiss"
            onClick={() => game.dismiss(id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function Overlay({
  game,
  account,
  teams,
  screens,
  onCover,
}: {
  game: Game;
  account: Account;
  teams: Teams;
  screens: Screens;
  onCover: (covered: boolean) => void;
}) {
  const screen = useSelector(screens.state, (s) => s.screen);
  // The screen's code did not load (most often a chunk gone after a deploy): close it and
  // offer a reload, instead of a button that silently does nothing.
  const failed = () => {
    screens.close();
    game.notify(LOAD_FAILED);
  };
  if (screen === 'landing') {
    return (
      <Landing
        game={game}
        account={account}
        screens={screens}
        teams={teams}
        onCover={onCover}
        onLoadError={failed}
      />
    );
  }
  if (screen === 'guide') {
    return <Guide game={game} screens={screens} teams={teams} onLoadError={failed} />;
  }
  if (screen === 'share') {
    return <ShareDialog game={game} account={account} screens={screens} onLoadError={failed} />;
  }
  return null;
}

export function App({
  game,
  account,
  teams,
  screens,
  status,
  live,
}: {
  game: Game;
  account: Account;
  teams: Teams;
  screens: Screens;
  status: SystemStatus;
  /** The canvas's live numbers (ADR 0030); left out where the page has none. */
  live?: LiveStats;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const webgl = useSelector(game.ui, (s) => s.webgl);
  const challengeRound = useSelector(game.ui, (s) => s.challengeRound);
  // The landing covers the game: the header and map under it take no clicks, focus or screen
  // reader visits until it closes. Its siblings go inert, not .app, which also holds the landing.
  // The landing switches this itself once mounted (its code loads on demand): going inert
  // earlier would blur its opener before it could note where focus goes back on close.
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    game.attach(canvasRef.current!);
    return () => game.detach();
  }, [game]);
  return (
    <div class="app">
      <Header
        game={game}
        account={account}
        teams={teams}
        screens={screens}
        status={status}
        {...(live ? { live } : {})}
        inert={covered}
      />
      <main class="stage" inert={covered}>
        <section class="map" aria-label="Map" aria-describedby="map-keys">
          <canvas ref={canvasRef} class="map-canvas" />
          <ShieldTip game={game} />
          <p id="map-keys" class="visually-hidden">
            Arrow keys move the map, plus and minus zoom, R rotates a brick, Escape puts the item
            back.
          </p>
          {!webgl && (
            <p class="no-webgl">This browser cannot draw the map: BrickPlace needs WebGL2.</p>
          )}
        </section>
        <MapControls
          game={game}
          teams={teams}
          onShare={() => screens.open('share')}
          onHelp={() => screens.open('guide')}
        />
        <Minimap game={game} />
        <ToolColumn game={game} account={account} {...(live ? { live } : {})} />
        <Notices game={game} account={account} teams={teams} screens={screens} status={status} />
      </main>
      <TeamScreens teams={teams} />
      <AccountDialogs account={account} settings={game} />
      {/* Keyed by round: each challenge mounts a fresh dialog, never a spent token. */}
      <ChallengeDialog key={challengeRound} game={game} account={account} />
      <Overlay game={game} account={account} teams={teams} screens={screens} onCover={setCovered} />
    </div>
  );
}
