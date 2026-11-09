import { useEffect, useRef } from 'preact/hooks';
import type { Account } from '../game/account.ts';
import type { Game } from '../game/game.ts';
import { cooldownSpan, countWord } from '../game/rules-copy.ts';
import type { Screens } from '../game/screens.ts';
import { nextSeasonText, seasonOver, timeLeft } from '../game/states.ts';
import type { Teams } from '../game/teams.ts';
import { Footer } from './Footer.tsx';
import { useModalFocus } from './focus.ts';
import { BRICK_ART, BrickCells, heroArt, SINGLE_ART, SINGLE_RING } from './ItemArt.tsx';
import { HammerIcon, ShieldIcon } from './icons.tsx';
import { Logo } from './Logo.tsx';
import { CONTRIBUTORS_PAGE, EXTERNAL_REL, SOURCE_URL, timelapseLink } from './links.ts';
import { useSelector } from './observable.ts';
import { useNow } from './SystemStates.tsx';
import './screens.css';

// The Landing design, for a first visit: what BrickPlace is, "watch now" and "sign in to
// play". A full-viewport layer over the map, which loads behind it, so watching starts at
// once. Every section lays its content out in the same column (.container).

function SeasonChip({ account }: { account: Account }) {
  const { season, next } = useSelector(account.state, (s) => ({
    season: s.me.config.season ?? null,
    next: s.me.config.nextSeason ?? null,
  }));
  const now = useNow(60_000);
  const upcoming = nextSeasonText(next, now);
  if (!season) {
    return upcoming ? <span class="chip chip-blue landing-chip">{upcoming}</span> : null;
  }
  if (seasonOver(season, now)) {
    // The way in to what is left of a season: its timelapse.
    return (
      <a class="chip chip-blue landing-chip" href={timelapseLink(season.canvas)}>
        Season {season.id} is over · watch its timelapse{upcoming ? ` · ${upcoming}` : ''}
      </a>
    );
  }
  return (
    <span class="chip chip-blue landing-chip">
      Season {season.id} is live · ends in {timeLeft(season.endsAt, now)}
    </span>
  );
}

/** A corner of a map, drawn: decoration for the hero, not the live map. */
function HeroArt() {
  return (
    <div class="landing-art" aria-hidden="true">
      <div class="landing-art-grid">
        {heroArt().map((color, i) => (
          <span
            key={i}
            class={color ? 'landing-art-cell' : 'landing-art-empty'}
            style={color ? { background: color } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

export function Landing({
  game,
  account,
  screens,
  teams,
  onCover,
}: {
  game: Game;
  account: Account;
  screens: Screens;
  teams: Teams;
  /** Makes the game under the landing inert (true) or live again (false). */
  onCover: (covered: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const rules = useSelector(game.ui, (s) => ({
    span: cooldownSpan(s.hold.cooldownMs),
    capacity: countWord(s.hold.capacity),
    maxShield: countWord(s.rules.maxShield),
  }));
  const { signedIn, canSignIn, canvas, over } = useSelector(account.state, (s) => ({
    signedIn: s.me.signedIn,
    canSignIn: s.me.config.providers.length > 0,
    canvas: s.me.config.season?.canvas ?? null,
    over: seasonOver(s.me.config.season, Date.now()),
  }));
  const watch = () => screens.leaveLanding();
  useModalFocus(box, watch);
  // After useModalFocus, so it notes the opener (still focusable) before the game goes inert;
  // on close its focus restore waits for the game to be live again (restoreFocus).
  useEffect(() => {
    onCover(true);
    return () => onCover(false);
  }, [onCover]);
  const signIn = () => {
    screens.leaveLanding();
    account.open('signin');
  };
  const ranking = () => {
    screens.leaveLanding();
    void teams.openRanking();
  };
  return (
    <div
      ref={box}
      class="landing"
      role="dialog"
      aria-modal="true"
      aria-labelledby="landing-title"
      tabIndex={-1}
    >
      <header class="landing-head">
        <div class="container site-header-inner">
          <span class="logo">
            <Logo />
          </span>
          <nav aria-label="About BrickPlace" class="site-nav">
            <a class="nav-link landing-nav-link" href="#how">
              How it works
            </a>
            <a class="nav-link landing-nav-link" href={timelapseLink(canvas)}>
              Seasons
            </a>
            <button type="button" class="nav-link landing-nav-link" onClick={ranking}>
              Ranking
            </button>
            <a class="nav-link landing-nav-link" href={CONTRIBUTORS_PAGE}>
              Contributors
            </a>
            <button type="button" class="btn btn-dark btn-small landing-close" onClick={watch}>
              Close
            </button>
          </nav>
        </div>
      </header>

      <section class="landing-hero">
        <div class="container landing-hero-inner">
          <div class="landing-hero-text">
            <SeasonChip account={account} />
            <h1 id="landing-title" class="landing-title">
              Place a brick.
              <br />
              Every {rules.span}.
            </h1>
            <p class="landing-lead">
              One shared map and everyone on it. Every {rules.span} you get a brick, a hammer or a
              shield. Build something, clear something, protect what matters.
            </p>
            <div class="landing-actions">
              {!signedIn && canSignIn ? (
                <button type="button" class="btn-primary landing-primary" onClick={signIn}>
                  {over ? 'Sign in for the next season' : 'Sign in to play'}
                </button>
              ) : null}
              <button
                type="button"
                class="btn btn-outline btn-large landing-secondary"
                onClick={watch}
                data-autofocus
              >
                {signedIn ? 'Back to the map' : 'Watch now'}
              </button>
            </div>
            <p class="landing-fine">Free · no download · watching needs no account</p>
          </div>
          <HeroArt />
        </div>
      </section>

      <section id="how" class="landing-band" aria-labelledby="how-title">
        <div class="container landing-stack">
          <h2 id="how-title" class="landing-h2">
            Four items. Endless fights.
          </h2>
          <div class="landing-items">
            <article class="landing-item landing-item-brick">
              <span class="landing-item-icon">
                <BrickCells cells={BRICK_ART} />
              </span>
              <h3>Brick</h3>
              <p>
                Fills four empty cells in one of seven shapes. Rotate it, pick one of 32 colours,
                drop it anywhere in the open area.
              </p>
            </article>
            <article class="landing-item landing-item-single">
              <span class="landing-item-icon">
                <BrickCells cells={SINGLE_ART} ring={SINGLE_RING} />
              </span>
              <h3>Single brick</h3>
              <p>
                Fills one hole that no brick can reach. It's how you repair art after a hammer hits
                it, not how you paint.
              </p>
            </article>
            <article class="landing-item landing-item-hammer">
              <span class="landing-item-icon">
                <HammerIcon size={48} />
              </span>
              <h3>Hammer</h3>
              <p>Clears one cell, or knocks one layer off a shield. Make room or fix mistakes.</p>
            </article>
            <article class="landing-item landing-item-shield">
              <span class="landing-item-icon">
                <ShieldIcon size={48} />
              </span>
              <h3>Shield</h3>
              <p>
                Protects a filled cell. Stack up to {rules.maxShield} layers on the parts of your
                art that matter most.
              </p>
            </article>
          </div>
          <p class="landing-fine">
            You hold up to {rules.capacity} items. A new one arrives every {rules.span} while you
            have room.
          </p>
        </div>
      </section>

      <section class="landing-more">
        <div class="container landing-cards">
          <div class="landing-card landing-card-dark">
            <h2 class="landing-h3">Seasons and teams</h2>
            <p>
              Each season ends with a final snapshot and a timelapse anyone can watch. Join a team
              and climb the ranking with the cells your team keeps standing.
            </p>
            <div class="landing-actions">
              <button type="button" class="btn btn-yellow" onClick={ranking}>
                See the ranking
              </button>
              <a class="btn btn-ghost" href={timelapseLink(canvas)}>
                Watch the timelapse
              </a>
            </div>
          </div>
          <div class="landing-card">
            <h2 class="landing-h3">Built in the open</h2>
            <p>
              The whole game is open source under AGPL-3.0. Fix a bug, draw the art, translate the
              game or help moderate.
            </p>
            <div class="landing-actions">
              <a class="btn btn-dark" href={SOURCE_URL} rel={EXTERNAL_REL}>
                View the source
              </a>
              <a class="btn btn-light" href={CONTRIBUTORS_PAGE}>
                Meet the contributors
              </a>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
