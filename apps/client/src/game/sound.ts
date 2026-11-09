import type { ItemKind } from './hold.ts';

// The "Sound effects" preference: a short click when a move is accepted, made with Web Audio
// so no sound file is downloaded. Each item has its own pitch; a hammer's falls lower.
// Browsers (WebKit above all) start audio only inside a user gesture, while the click plays
// later, from the socket's ack: so the context is opened and resumed by `unlockAudio`, called
// from the gesture that sends a move or switches sound on, and `playClick` only schedules.

/** The click of an accepted move; a seam for tests. */
export interface Sound {
  /** Called inside a user gesture: opens and resumes the audio context. */
  unlock(): void;
  play(kind: ItemKind): void;
}

const TONES: Record<ItemKind, { readonly hz: number; readonly type: OscillatorType }> = {
  brick: { hz: 660, type: 'triangle' },
  single: { hz: 880, type: 'triangle' },
  hammer: { hz: 220, type: 'square' },
  shield: { hz: 990, type: 'sine' },
};

let context: AudioContext | null = null;

export function unlockAudio(): void {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
  } catch {
    // No Web Audio (old browser, blocked): no sound, nothing else changes.
  }
}

export function playClick(kind: ItemKind): void {
  if (context?.state !== 'running') return;
  try {
    const { hz, type } = TONES[kind];
    const at = context.currentTime;
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.type = type;
    tone.frequency.setValueAtTime(hz, at);
    tone.frequency.exponentialRampToValueAtTime(hz / 2, at + 0.08);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.15, at + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
    tone.connect(gain).connect(context.destination);
    tone.start(at);
    tone.stop(at + 0.1);
  } catch {
    // As above: a click is never worth an error.
  }
}

export const webAudio: Sound = { unlock: unlockAudio, play: playClick };
