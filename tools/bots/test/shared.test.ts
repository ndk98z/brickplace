import { CHALLENGE_REQUIRED, KICKED, PLAYING_ELSEWHERE } from '@brickplace/realtime/player';
import { describe, expect, it } from 'vitest';
import { hexToRgb, PALETTE } from '../../../apps/client/src/palette.ts';
import { PALETTE_RGB } from '../src/palette.ts';
import { CLOSE } from '../src/socket.ts';

// The bots repeat a few values from the client and FanoutDO rather than import them at run time.

describe('values shared with the game', () => {
  it('uses the close codes FanoutDO sends', () => {
    expect(CLOSE.kicked).toBe(KICKED);
    expect(CLOSE.playingElsewhere).toBe(PLAYING_ELSEWHERE);
    expect(CLOSE.challenge).toBe(CHALLENGE_REQUIRED);
  });

  it('uses the client palette, in the same order', () => {
    expect(PALETTE_RGB.map((rgb) => [...rgb])).toEqual(PALETTE.map(hexToRgb));
  });
});
