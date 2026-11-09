import { useEffect, useRef, useState } from 'preact/hooks';
import type { Game } from '../game/game.ts';
import { cooldownClock, cooldownSpan, countWord } from '../game/rules-copy.ts';
import type { Screens } from '../game/screens.ts';
import type { Teams } from '../game/teams.ts';
import { Dialog } from './AccountDialogs.tsx';
import { BRICK_ART, BrickCells, SINGLE_ART, SINGLE_RING } from './ItemArt.tsx';
import './screens.css';
import { HammerIcon, ShieldIcon } from './icons.tsx';
import { useSelector } from './observable.ts';

// The Onboarding design: three steps after the first nickname (items and the hold, what each
// item does, teams). Skippable, and shown once per account (screens.ts). The numbers come
// from the server's hold and config frames (or the defaults until they arrive).

const STEPS = 3;

interface Words {
  readonly span: string;
  readonly clock: string;
  readonly capacity: string;
  readonly maxShield: string;
}

function Hold({ words }: { words: Words }) {
  return (
    <div class="guide-hold">
      <span class="guide-slot guide-slot-on">
        <BrickCells cells={BRICK_ART} />
        Brick
      </span>
      <span class="guide-slot">
        <ShieldIcon size={30} />
        Shield
      </span>
      <span class="guide-slot guide-slot-empty">
        <strong>{words.clock}</strong>
        <span>next item</span>
      </span>
      <span class="guide-aside">
        Which item you get is random, and decided by the server the moment it arrives.
      </span>
    </div>
  );
}

function StepOne({ words }: { words: Words }) {
  return (
    <>
      <p class="guide-copy">
        Items land in your hold. It keeps up to {words.capacity}, so you can save them for a big
        move. When the hold is full the timer pauses until you use something.
      </p>
      <Hold words={words} />
    </>
  );
}

function StepTwo({ words }: { words: Words }) {
  return (
    <>
      <div class="guide-items">
        <div class="guide-item" style={{ background: 'var(--accent-soft)' }}>
          <BrickCells cells={BRICK_ART} />
          <strong>Brick</strong>
          <span>Fills four empty cells. Press R to rotate, pick a colour, click to place.</span>
        </div>
        <div class="guide-item" style={{ background: '#fff8e1' }}>
          <BrickCells cells={SINGLE_ART} ring={SINGLE_RING} />
          <strong>Single brick</strong>
          <span>Fills one hole that no brick can fit. Use it to repair art.</span>
        </div>
        <div class="guide-item" style={{ background: 'var(--soft)' }}>
          <HammerIcon size={28} />
          <strong>Hammer</strong>
          <span>Clears one cell, or removes one shield layer first.</span>
        </div>
        <div class="guide-item" style={{ background: 'var(--blue-soft)' }}>
          <ShieldIcon size={28} />
          <strong>Shield</strong>
          <span>Adds a layer to a filled cell, up to {words.maxShield}.</span>
        </div>
      </div>
      <p class="guide-note">
        Nobody owns a cell and the map never shows who placed what. Anyone can build or clear
        anywhere in the open area.
      </p>
    </>
  );
}

function StepThree({ findTeam }: { findTeam: () => void }) {
  return (
    <>
      <p class="guide-copy">
        Teams are for the ranking only: what you do counts for your team. You can switch teams once
        every 3 days.
      </p>
      <div class="guide-team">
        <button type="button" class="btn btn-outline" onClick={findTeam}>
          Find a team
        </button>
        <span class="guide-aside">or skip and decide later</span>
      </div>
    </>
  );
}

export function Guide({ game, screens, teams }: { game: Game; screens: Screens; teams: Teams }) {
  const [step, setStep] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const words = useSelector(game.ui, (s) => ({
    span: cooldownSpan(s.hold.cooldownMs),
    clock: cooldownClock(s.hold.cooldownMs),
    capacity: countWord(s.hold.capacity),
    maxShield: countWord(s.rules.maxShield),
  }));
  const close = () => screens.close();
  // A new step moves focus to its title, so the step is read out and focus is never lost
  // when the button that was pressed goes away.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    title.current?.focus();
  }, [step]);
  const titles = [
    `You get one item every ${words.span}`,
    'Build, clear, protect',
    'Play with a team (optional)',
  ];
  return (
    <Dialog label="How to play" wide onClose={close}>
      <div class="guide-progress">
        {Array.from({ length: STEPS }, (_, i) => (
          <span
            key={i}
            class={`guide-dot${i === step ? ' guide-dot-on' : ''}`}
            aria-hidden="true"
          />
        ))}
        <span class="guide-count">
          Step {step + 1} of {STEPS}
        </span>
      </div>
      <h1 ref={title} tabIndex={-1} class="guide-title">
        {titles[step]}
      </h1>
      {step === 0 && <StepOne words={words} />}
      {step === 1 && <StepTwo words={words} />}
      {step === 2 && (
        <StepThree
          findTeam={() => {
            close();
            void teams.openTeam();
          }}
        />
      )}
      <div class="guide-foot">
        <button type="button" class="link-btn guide-skip" onClick={close}>
          Skip guide
        </button>
        {step > 0 && (
          <button type="button" class="btn btn-light" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < STEPS - 1 ? (
          <button
            type="button"
            class="btn btn-dark"
            data-autofocus
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        ) : (
          <button type="button" class="btn-primary guide-start" onClick={close}>
            Start playing
          </button>
        )}
      </div>
    </Dialog>
  );
}
