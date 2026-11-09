import { DEFAULT_COOLDOWN, DEFAULT_HOLD, type Item as ServerItem } from '@brickplace/core';
import type { HoldMessage } from '@brickplace/protocol';

/** A held item as the UI tracks it: the server's item plus a local id for selection. */
export type Item = ServerItem & { readonly id: number };

export type ItemKind = Item['kind'];

/**
 * The player's hold as the server last sent it. The server draws items, runs the cooldown and
 * decides every op; the client only shows the hold and greys out items it has sent.
 */
export interface Hold {
  readonly items: readonly Item[];
  /** Items sent to the server and waiting for an ack; shown greyed out, not usable. */
  readonly pending: ReadonlySet<number>;
  /** When the next item arrives (ms, this client's clock), or null while the hold is full. */
  readonly nextAt: number | null;
  /** Length of one cooldown in ms, for the progress bar. */
  readonly cooldownMs: number;
  /** Most items the hold can take. */
  readonly capacity: number;
  /** Highest item id handed out so far; ids are never reused. */
  readonly lastId: number;
  /** Revision of the server hold shown; an older one arriving late is ignored. -1: none yet. */
  readonly revision: number;
}

/** Before the server's first hold message: nothing to use, no countdown. */
export function emptyHold(): Hold {
  return {
    items: [],
    pending: new Set(),
    nextAt: null,
    cooldownMs: DEFAULT_COOLDOWN,
    capacity: DEFAULT_HOLD,
    lastId: 0,
    revision: -1,
  };
}

/**
 * A new socket: whatever revision it sends is current (the old socket's replies can no
 * longer arrive), so the next hold is taken whatever its revision.
 */
export function newSocket(hold: Hold): Hold {
  return { ...hold, revision: -1 };
}

function same(a: ServerItem, b: ServerItem): boolean {
  return a.kind === b.kind && (a.kind !== 'brick' || (b.kind === 'brick' && a.shape === b.shape));
}

/**
 * Replaces the hold with the server's, unless it is older than the one shown. Items that were
 * already shown keep their ids (so a selection or a pending op stays on the same slot), items
 * not waiting for an ack first: a pending item is the one most likely spent already. New ones
 * get fresh ids. `now` turns the server's delay into a time on this client's clock.
 */
export function fromServer(hold: Hold, message: HoldMessage, now: number): Hold {
  if (message.revision < hold.revision) return hold;
  const unused = [...hold.items];
  let lastId = hold.lastId;
  const take = (item: ServerItem, pending: boolean): Item | null => {
    const match = unused.findIndex(
      (shown) => same(shown, item) && hold.pending.has(shown.id) === pending,
    );
    return match >= 0 ? unused.splice(match, 1)[0]! : null;
  };
  const items = message.items.map((item): Item => {
    const kept = take(item, false) ?? take(item, true);
    if (kept) return kept;
    lastId += 1;
    return { ...item, id: lastId };
  });
  const ids = new Set(items.map((item) => item.id));
  return {
    items,
    pending: new Set([...hold.pending].filter((id) => ids.has(id))),
    nextAt: message.nextIn === null ? null : now + message.nextIn,
    cooldownMs: Math.max(1, message.cooldown),
    capacity: message.capacity,
    lastId,
    revision: message.revision,
  };
}

/** Marks an item as sent. Returns the hold unchanged if the item is gone or already sent. */
export function markPending(hold: Hold, id: number): Hold {
  if (hold.pending.has(id) || !hold.items.some((item) => item.id === id)) return hold;
  return { ...hold, pending: new Set([...hold.pending, id]) };
}

/**
 * The server accepted the op or discard: the item is spent. The hold message that follows
 * the ack brings the new countdown.
 */
export function consume(hold: Hold, id: number): Hold {
  if (!hold.items.some((item) => item.id === id)) return hold;
  const pending = new Set(hold.pending);
  pending.delete(id);
  return { ...hold, items: hold.items.filter((item) => item.id !== id), pending };
}

/** The server refused the op: the item stays in the hold. */
export function refund(hold: Hold, id: number): Hold {
  if (!hold.pending.has(id)) return hold;
  const pending = new Set(hold.pending);
  pending.delete(id);
  return { ...hold, pending };
}
