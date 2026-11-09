import type { AckReason } from '@brickplace/protocol';

export interface Notice {
  readonly title: string;
  readonly body: string;
  /**
   * 'warn' for outcomes the player should double-check on the map; 'busy' when the server is
   * too loaded to take the move (the item was kept).
   */
  readonly tone: 'info' | 'warn' | 'busy';
  /** A button on the toast, e.g. "Reload". */
  readonly action?: { readonly label: string; readonly run: () => void };
}

/**
 * The design's "busy" toast, for an op or discard the canvas shed (`busy`, ADR 0032). Worded
 * for the whole map: a canvas sheds as a whole, not per area. Not resent on its own; op rate
 * limits (ADR 0026) still answer `unavailable`.
 */
export const BUSY_NOTICE: Notice = {
  title: 'The map is busy',
  body: 'Too many moves at once right now. Your item was kept. Try again in a few seconds.',
  tone: 'busy',
};

export type ItemName = 'brick' | 'hammer' | 'shield' | 'single';

const NAMES: Record<ItemName, string> = {
  brick: 'brick',
  hammer: 'hammer',
  shield: 'shield',
  single: 'single brick',
};

/**
 * Player-facing copy for a rejected (or unconfirmed) op, following the design's states.
 * `sent` is false when the client's own check stopped the op before it left.
 */
export function noticeFor(reason: AckReason, kind: ItemName, sent = true): Notice {
  const notice = copyFor(reason, NAMES[kind]);
  if (sent) return notice;
  return { ...notice, body: notice.body.replace('is back in your hold', 'is still in your hold') };
}

/** Copy for a discard the server did not confirm. */
export function discardNotice(reason: AckReason): Notice {
  if (reason === 'unavailable') {
    return {
      title: "Couldn't confirm the discard",
      body: 'The server restarted mid-move. Your hold shows what really happened.',
      tone: 'warn',
    };
  }
  if (reason === 'signed_out') {
    return { title: 'Sign in to play', body: 'Watching needs no account; items do.', tone: 'info' };
  }
  if (
    reason === 'ended' ||
    reason === 'read_only' ||
    reason === 'locked' ||
    reason === 'limited' ||
    reason === 'busy'
  ) {
    return copyFor(reason, 'item');
  }
  return {
    title: 'Nothing discarded',
    body: 'That item is no longer in your hold. Your items are up to date now.',
    tone: 'info',
  };
}

function copyFor(reason: AckReason, item: string): Notice {
  switch (reason) {
    case 'occupied':
      return {
        title: 'Cell already taken',
        body: `Someone got there first. Your ${item} is back in your hold.`,
        tone: 'info',
      };
    case 'out_of_area':
      return {
        title: 'Outside the open area',
        body: `That spot is not open yet. Your ${item} is back in your hold.`,
        tone: 'info',
      };
    case 'empty':
      return {
        title: 'Nothing there',
        body: `That cell is empty now. Your ${item} is back in your hold.`,
        tone: 'info',
      };
    case 'shield_full':
      return {
        title: 'Shield is full',
        body: `That cell already has every shield layer. Your ${item} is back in your hold.`,
        tone: 'info',
      };
    case 'coverable':
      return {
        title: 'A brick still fits here',
        body: `Single bricks only fill holes no brick can reach. Your ${item} is back in your hold.`,
        tone: 'info',
      };
    case 'no_item':
      return {
        title: 'Not in your hold',
        body: `The server has no ${item} in your hold for that move. Your items are up to date now.`,
        tone: 'info',
      };
    case 'invalid':
      return {
        title: 'Move not allowed',
        body: `The server did not accept that move. Your ${item} is back in your hold.`,
        tone: 'info',
      };
    case 'signed_out':
      return {
        title: 'Sign in to play',
        body: `Anyone can watch, but placing needs an account. Your ${item} was not used.`,
        tone: 'info',
      };
    case 'ended':
      return {
        title: 'This season is over',
        body: `The map is closed for good now. Your ${item} was not used. Reload to see the next season once it starts.`,
        tone: 'info',
      };
    case 'read_only':
      return {
        title: 'The map is paused',
        body: `Moves are on hold for a moment. Your ${item} is still in your hold; try again shortly.`,
        tone: 'info',
      };
    case 'locked':
      return {
        title: 'This area is locked',
        body: `Moderators paused play in the striped area for now. Your ${item} is still in your hold.`,
        tone: 'info',
      };
    case 'limited':
      return {
        title: 'Hammers and shields are limited for now',
        body: `New accounts can use only a few for a while. Your ${item} is still in your hold; try it again later. Bricks work as usual.`,
        tone: 'info',
      };
    case 'busy':
      return BUSY_NOTICE;
    case 'unavailable':
      return {
        title: "Couldn't confirm that move",
        body: 'The server restarted mid-move. Check the map: the cell shows what really happened.',
        tone: 'warn',
      };
  }
}
