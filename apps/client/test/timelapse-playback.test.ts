import { describe, expect, it } from 'vitest';
import { Playback, type PlaybackHost, type Timer } from '../src/timelapse/playback.ts';

// The timelapse's play loop: one loop at a time, and a stopped loop never touches the page
// again, even when it was asleep between frames.

/** A manual timer: waits fire only when the test says so. */
function manualTimer() {
  const pending = new Set<() => void>();
  const timer: Timer = (wake) => {
    pending.add(wake);
    return () => pending.delete(wake);
  };
  const fireAll = async () => {
    const due = [...pending];
    pending.clear();
    for (const wake of due) wake();
    // Let the woken loop run up to its next wait.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { timer, fireAll, pending };
}

function host(frames: number, start = 0) {
  let shown = start;
  const events: string[] = [];
  const shows: number[] = [];
  const h: PlaybackHost = {
    frames,
    current: () => shown,
    show: async (frame) => {
      shows.push(frame);
      shown = frame;
      return true;
    },
    interval: () => 250,
    onPlaying: (playing) => events.push(playing ? 'play' : 'pause'),
  };
  return { h, events, shows };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('timelapse playback', () => {
  it('plays to the end, one frame a wait, then marks itself paused', async () => {
    const { timer, fireAll } = manualTimer();
    const { h, events, shows } = host(4);
    const playback = new Playback(h, timer, () => 0);
    const done = playback.toggle();
    await flush();
    expect(shows).toEqual([1]);
    await fireAll();
    await fireAll();
    await done;
    expect(shows).toEqual([1, 2, 3]);
    expect(events).toEqual(['play', 'pause']);
    expect(playback.playing).toBe(false);
  });

  it('starts over from the first frame when played at the end', async () => {
    const { timer, fireAll } = manualTimer();
    const { h, shows } = host(3, 2);
    const playback = new Playback(h, timer, () => 0);
    const done = playback.toggle();
    await flush();
    await fireAll();
    await done;
    expect(shows).toEqual([0, 1, 2]);
  });

  it('wakes a stopped loop at once and keeps it from touching the page', async () => {
    const { timer, fireAll, pending } = manualTimer();
    const { h, events, shows } = host(10);
    const playback = new Playback(h, timer, () => 0);
    const first = playback.toggle();
    await flush();
    expect(pending.size).toBe(1);
    // Paused mid-wait, then played again before the old wait would have ended.
    playback.stop();
    expect(pending.size).toBe(0);
    const second = playback.toggle();
    await first;
    await flush();
    // One loop: frame 1 from the first run, frame 2 from the second, nothing doubled.
    expect(shows).toEqual([1, 2]);
    expect(events).toEqual(['play', 'pause', 'play']);
    expect(playback.playing).toBe(true);
    await fireAll();
    expect(shows).toEqual([1, 2, 3]);
    playback.stop();
    await second;
    expect(events).toEqual(['play', 'pause', 'play', 'pause']);
  });

  it('lets a loop stopped by a rebuild end without pausing the new player', async () => {
    const { timer } = manualTimer();
    const old = host(10);
    const oldPlayback = new Playback(old.h, timer, () => 0);
    const running = oldPlayback.toggle();
    await flush();
    // The resize rebuild: the old player stops, a new one starts playing.
    oldPlayback.stop();
    const fresh = host(10, 1);
    const newPlayback = new Playback(fresh.h, timer, () => 0);
    void newPlayback.toggle();
    await running;
    await flush();
    expect(old.events).toEqual(['play', 'pause']);
    expect(fresh.events).toEqual(['play']);
    expect(newPlayback.playing).toBe(true);
    newPlayback.stop();
  });

  it('does nothing with a single frame', async () => {
    const { h, events } = host(1);
    await new Playback(h, manualTimer().timer).toggle();
    expect(events).toEqual([]);
  });
});
