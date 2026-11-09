import { DEFAULT_MAP_SIZE, DEFAULT_OPEN_EDGE } from '@brickplace/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadConfig', () => {
  it("starts on the canvas's own map and open area until the server says otherwise", () => {
    vi.stubGlobal('location', new URL('https://play.example/'));
    const config = loadConfig();
    // The game's initialConfig: the core's map size, a DEFAULT_OPEN_EDGE square centred on it
    // (ADR 0027). A client that drew another size would misplace every cell.
    const offset = (DEFAULT_MAP_SIZE - DEFAULT_OPEN_EDGE) / 2;
    expect(config.mapSize).toBe(DEFAULT_MAP_SIZE);
    expect(config.open).toEqual({
      x: offset,
      y: offset,
      w: DEFAULT_OPEN_EDGE,
      h: DEFAULT_OPEN_EDGE,
    });
    expect(config.socketUrl).toBe('wss://play.example/ws');
  });
});
