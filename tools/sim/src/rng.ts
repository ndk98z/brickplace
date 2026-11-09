/** Seeded PRNG (mulberry32). Every random choice in a run comes from one instance. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  /** A uniform 32-bit unsigned integer: the form the core's draws take their randomness in. */
  word(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform in [0, 1): the next word over 2^32. */
  next(): number {
    return this.word() / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
}
