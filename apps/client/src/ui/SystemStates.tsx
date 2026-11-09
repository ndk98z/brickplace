import { useEffect, useState } from 'preact/hooks';
import type { Account } from '../game/account.ts';
import type { Game } from '../game/game.ts';
import { cooldownSpan } from '../game/rules-copy.ts';
import type { Screens } from '../game/screens.ts';
import {
  backAround,
  nextSeasonText,
  type SystemState,
  type SystemStatus,
  seasonOver,
  systemState,
  timeLeft,
} from '../game/states.ts';
import type { Teams } from '../game/teams.ts';
import { fetchMeResult, type SeasonInfo } from '../net/account.ts';
import { LEGAL, timelapseLink } from './links.ts';
import { useSelector } from './observable.ts';

// The States design: one card over the map for whatever stops normal play (game/states.ts
// decides which), next to the per-move toasts.

/** Date.now(), refreshed every `ms` while mounted. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine ?? true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

function WarnIcon() {
  return (
    <svg
      class="state-icon"
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
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16v.5" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M14.5 6.5a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.1-5.1a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
    </svg>
  );
}

function Dismiss({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" class="toast-close state-close" aria-label="Dismiss" onClick={onClick}>
      ×
    </button>
  );
}

function Ended({
  season,
  account,
  teams,
  onDismiss,
}: {
  season: SeasonInfo | null;
  account: Account;
  teams: Teams;
  onDismiss: () => void;
}) {
  const { next, signedIn, canSignIn } = useSelector(account.state, (s) => ({
    next: s.me.config.nextSeason ?? null,
    signedIn: s.me.signedIn,
    canSignIn: s.me.config.providers.length > 0,
  }));
  const now = useNow(30_000);
  const name = season ? `Season ${season.id}` : 'This season';
  const when = nextSeasonText(next, now);
  return (
    <section class="state-card state-dark" role="status" aria-labelledby="state-title">
      <Dismiss onClick={onDismiss} />
      <span class="state-kicker">Season ended</span>
      <h2 id="state-title" class="state-title">
        {name} is over. The map is read-only.
      </h2>
      <p class="state-body">
        {when ? `${when}, on a fresh map.` : 'The next season starts on a fresh map.'} Your team
        stays; items reset.
      </p>
      <div class="state-actions">
        <a class="btn btn-yellow" href={timelapseLink(season?.canvas ?? null)}>
          Watch the timelapse
        </a>
        <button type="button" class="btn btn-ghost" onClick={() => void teams.openRanking()}>
          Final ranking
        </button>
        {!signedIn && canSignIn && (
          <button type="button" class="btn btn-ghost" onClick={() => account.open('signin')}>
            Sign in for the next one
          </button>
        )}
      </div>
    </section>
  );
}

function Card({
  state,
  account,
  teams,
  status,
  onDismiss,
}: {
  state: SystemState;
  account: Account;
  teams: Teams;
  status: SystemStatus;
  onDismiss: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    await status.recheck(fetchMeResult, (me) => account.adopt(me, true));
    setRetrying(false);
  };
  const retryButton = (label: string, dark: boolean) => (
    <button
      type="button"
      class={`btn ${dark ? 'btn-dark' : 'btn-light'} btn-small`}
      disabled={retrying}
      onClick={() => void retry()}
    >
      {retrying ? 'Trying…' : label}
    </button>
  );
  switch (state.kind) {
    case 'ended':
      return <Ended season={state.season} account={account} teams={teams} onDismiss={onDismiss} />;
    case 'offline':
      return (
        <div class="toast toast-dark" role="status">
          <WarnIcon />
          <span class="toast-text">
            <strong>You're offline</strong>
            <span>The map shows what it had and catches up when you're back.</span>
          </span>
          <button
            type="button"
            class="btn btn-light btn-small state-retry"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? 'Trying…' : 'Retry'}
          </button>
        </div>
      );
    case 'rate_limited':
      return (
        <section class="state-card state-warn" role="status" aria-labelledby="state-title">
          <Dismiss onClick={onDismiss} />
          <h2 id="state-title" class="state-title state-title-small">
            Too many requests
          </h2>
          <p class="state-body">
            Your network sent a lot of requests in a short time, so this page only watches for now.
            Wait a minute, then try again.
          </p>
          {retryButton('Try again', true)}
        </section>
      );
    case 'wrong_host':
      return (
        <section class="state-card state-warn" role="status" aria-labelledby="state-title">
          <Dismiss onClick={onDismiss} />
          <h2 id="state-title" class="state-title state-title-small">
            Sign-in works on the main address only
          </h2>
          <p class="state-body">
            This address can show the map but not your account. Open the game from its main address
            to play.
          </p>
        </section>
      );
    case 'maintenance':
      return (
        <section class="state-card" role="status" aria-labelledby="state-title">
          <span class="state-kicker">Maintenance</span>
          <WrenchIcon />
          <h2 id="state-title" class="state-title">
            We're upgrading the map
          </h2>
          <p class="state-body">
            {backAround(state.until, Date.now())} Nothing on the map is lost, and your hold keeps
            its items.
          </p>
          {retryButton('Check again', false)}
        </section>
      );
    case 'new_season':
      return (
        <section class="state-card state-dark" role="status" aria-labelledby="state-title">
          <Dismiss onClick={onDismiss} />
          <span class="state-kicker">New season</span>
          <h2 id="state-title" class="state-title state-title-small">
            {state.season ? `Season ${state.season.id} is on` : 'The map has moved on'}
          </h2>
          <p class="state-body">
            This page still shows the map it opened with. Reload to see and play the current one.
          </p>
          <div class="state-actions">
            <button type="button" class="btn btn-yellow" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </section>
      );
    case 'paused':
      return (
        <section class="state-card state-warn" role="status" aria-labelledby="state-title">
          <Dismiss onClick={onDismiss} />
          <h2 id="state-title" class="state-title state-title-small">
            The map is paused
          </h2>
          <p class="state-body">
            Moves are on hold for a moment. Your items stay in your hold; try again shortly.
          </p>
        </section>
      );
    case 'accounts_down':
      return (
        <section class="state-card state-warn" role="status" aria-labelledby="state-title">
          <Dismiss onClick={onDismiss} />
          <h2 id="state-title" class="state-title state-title-small">
            Accounts are unavailable
          </h2>
          <p class="state-body">
            Sign-in and items cannot be read right now, so this page only watches. Nothing on the
            map or in your hold is lost.
          </p>
          {retryButton('Try again', true)}
        </section>
      );
    case 'signed_out':
      return (
        <section class="state-card" role="status" aria-labelledby="state-title">
          <Dismiss onClick={onDismiss} />
          <h2 id="state-title" class="state-title state-title-small">
            You were signed out
          </h2>
          <p class="state-body">
            Your session ended, so this page only watches. Sign in again to keep playing.
          </p>
          <button
            type="button"
            class="btn btn-dark btn-small"
            onClick={() => {
              onDismiss();
              account.open('signin');
            }}
          >
            Sign in
          </button>
        </section>
      );
    case 'suspended':
      return (
        <section class="state-card" role="alert" aria-labelledby="state-title">
          <Dismiss onClick={onDismiss} />
          <span class="state-kicker">Account suspended</span>
          <h2 id="state-title" class="state-title state-title-small">
            This account cannot play right now
          </h2>
          <p class="state-body">
            It broke the rules of the <a href={LEGAL.terms}>Terms</a>. You can still watch the map.
            The Terms say how to appeal.
          </p>
        </section>
      );
  }
}

/** The current system state as a card (or the offline toast), or nothing. */
export function SystemStates({
  game,
  account,
  teams,
  status,
}: {
  game: Game;
  account: Account;
  teams: Teams;
  status: SystemStatus;
}) {
  const page = useSelector(status.state, (s) => s);
  const halt = useSelector(game.ui, (s) => s.halt);
  const season = useSelector(account.state, (s) => s.me.config.season ?? null);
  const online = useOnline();
  const now = useNow(30_000);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const state = systemState({
    me: page.me,
    maintenanceUntil: page.maintenanceUntil,
    online,
    season,
    now,
    paused: halt === 'read_only',
    ended: halt === 'ended',
    signedOut: page.signedOut,
    newSeason: page.newSeason,
  });
  // A dismissal holds while its state lasts; once it ends, the next time shows again.
  const kind = state?.kind ?? null;
  useEffect(() => {
    if (dismissed !== null && kind !== dismissed) setDismissed(null);
  }, [kind, dismissed]);
  if (!state || state.kind === dismissed) return null;
  return (
    <Card
      state={state}
      account={account}
      teams={teams}
      status={status}
      onDismiss={() => {
        setDismissed(state.kind);
        if (state.kind === 'signed_out') status.set({ signedOut: false });
        // A dismissed suspension stops hiding the states behind it.
        if (state.kind === 'suspended') status.set({ me: 'ok' });
      }}
    />
  );
}

/**
 * The header's season chip: live with time left, or over, with the next season's start when
 * one is known. Nothing while the gateway's answer is missing: the season is unknown then.
 */
export function SeasonChip({ account, status }: { account: Account; status: SystemStatus }) {
  const known = useSelector(status.state, (s) => s.me === 'ok' || s.me === 'suspended');
  const { season, next } = useSelector(account.state, (s) => ({
    season: s.me.config.season ?? null,
    next: s.me.config.nextSeason ?? null,
  }));
  const now = useNow(60_000);
  if (!known) return null;
  const upcoming = next && next.startsAt > now ? ` · next in ${timeLeft(next.startsAt, now)}` : '';
  if (!season) {
    return (
      <span class="chip" title="No season has started yet">
        Preseason{upcoming}
      </span>
    );
  }
  const text = seasonOver(season, now)
    ? `Season ${season.id} · ended${upcoming}`
    : `Season ${season.id} · ends in ${timeLeft(season.endsAt, now)}`;
  return <span class="chip">{text}</span>;
}

/**
 * The welcome card over the map for a first visit while a game is under way: what the game is,
 * in two lines, with sign-in and the full landing one tap away. Shown once per browser.
 */
export function WelcomeCard({
  game,
  account,
  screens,
}: {
  game: Game;
  account: Account;
  screens: Screens;
}) {
  const open = useSelector(screens.state, (s) => s.screen === 'welcome');
  const span = useSelector(game.ui, (s) => cooldownSpan(s.hold.cooldownMs));
  const canSignIn = useSelector(account.state, (s) => s.me.config.providers.length > 0);
  if (!open) return null;
  return (
    <section class="state-card" role="status" aria-labelledby="welcome-title">
      <Dismiss onClick={() => screens.leaveLanding()} />
      <span class="state-kicker">Welcome to BrickPlace</span>
      <h2 id="welcome-title" class="state-title">
        One shared map. Everyone builds on it.
      </h2>
      <p class="state-body">
        Every {span} each player gets a brick, a hammer or a shield to use anywhere on the map.
        Watching needs no account.
      </p>
      <div class="state-actions">
        {canSignIn && (
          <button
            type="button"
            class="btn btn-dark"
            onClick={() => {
              screens.leaveLanding();
              account.open('signin');
            }}
          >
            Sign in to play
          </button>
        )}
        <button
          type="button"
          class="btn btn-light"
          onClick={() => {
            screens.leaveLanding();
            screens.open('landing');
          }}
        >
          How it works
        </button>
      </div>
    </section>
  );
}
