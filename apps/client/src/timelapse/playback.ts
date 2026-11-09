// The timelapse's play loop, apart from the page so tests run it with their own clock. One
// loop at a time: each play is a run with its own number, and stopping ends the run, wakes
// its wait at once and keeps it from touching the page afterwards. Without that, a loop
// asleep between frames when the player was stopped and played again (or rebuilt after a
// resize) woke up next to the new one: two loops stepping frames, and the old one marking
// the new state as paused when it finished.

export interface PlaybackHost {
  readonly frames: number;
  /** The frame shown; -1 before the first. */
  current(): number;
  /** Shows a frame; false when it could not (or was cancelled). */
  show(frame: number): Promise<boolean>;
  /** Milliseconds a frame stays up at the current speed. */
  interval(): number;
  /** Playing started (true) or ended (false), for the play button. */
  onPlaying(playing: boolean): void;
}

/** Runs `wake` after `ms`; the returned function cancels it. */
export type Timer = (wake: () => void, ms: number) => () => void;

const browserTimer: Timer = (wake, ms) => {
  const id = setTimeout(wake, ms);
  return () => clearTimeout(id);
};

export class Playback {
  /** Number of the current run; a loop whose run is not this one has been stopped. */
  private run = 0;
  private active = false;
  /** Ends the current wait early (stop). */
  private interrupt: (() => void) | null = null;

  constructor(
    private readonly host: PlaybackHost,
    private readonly timer: Timer = browserTimer,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get playing(): boolean {
    return this.active;
  }

  /** Plays from the frame shown (from the start when at the end), or pauses. */
  async toggle(): Promise<void> {
    if (this.active) {
      this.stop();
      return;
    }
    if (this.host.frames < 2) return;
    this.run += 1;
    const run = this.run;
    this.active = true;
    this.host.onPlaying(true);
    const live = () => run === this.run;
    if (this.host.current() >= this.host.frames - 1 && !(await this.host.show(0))) {
      if (live()) this.end();
      return;
    }
    while (live() && this.host.current() < this.host.frames - 1) {
      const started = this.now();
      if (!(await this.host.show(this.host.current() + 1)) || !live()) break;
      // The last frame stays up: no wait after it before the loop ends.
      if (this.host.current() >= this.host.frames - 1) break;
      const wait = this.host.interval() - (this.now() - started);
      if (wait > 0) await this.sleep(wait);
    }
    if (live()) this.end();
  }

  /** Stops the current run, if any: its loop exits without touching the page again. */
  stop(): void {
    this.run += 1;
    this.interrupt?.();
    this.interrupt = null;
    if (this.active) this.end();
  }

  private end(): void {
    this.active = false;
    this.host.onPlaying(false);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.interrupt = null;
        resolve();
      };
      const cancel = this.timer(finish, ms);
      this.interrupt = () => {
        cancel();
        finish();
      };
    });
  }
}
