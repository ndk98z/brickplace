// Words for the rules the landing and the guide explain, from the values the page has: the
// server's hold frame (cooldown, capacity) and config frame (shield cap), or the core's
// defaults until they arrive. Admins can change the cooldown (ADR 0007), so copy never
// hard-codes it.

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "three" for 3, "12" for 12. */
export function countWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n]! : String(n);
}

/** "minute", "2 minutes", "30 seconds", "90 seconds": one cooldown. */
export function cooldownSpan(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? 'minute' : `${minutes} minutes`;
  }
  return seconds === 1 ? 'second' : `${seconds} seconds`;
}

/** "1:00", "0:30", "2:05": one cooldown on a timer. */
export function cooldownClock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The numbers the copy needs, from the game's UI state. */
export interface RuleNumbers {
  readonly cooldownMs: number;
  readonly capacity: number;
  readonly maxShield: number;
}
