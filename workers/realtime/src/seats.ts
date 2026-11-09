// Seats on a full shard (ADR 0039): when the playing sockets reach the shard's share of the
// players-at-once cap, a newcomer may take the place of the player who has not moved for the
// longest, once that is IDLE_YIELD_MS or more. Memory only: after a restart every playing
// socket counts as having just moved, so nobody is pushed out on a guess.

/** No op or discard for this long (ms), on a full shard, gives a player's place away. */
export const IDLE_YIELD_MS = 10 * 60 * 1000;

/**
 * When each player last moved (or joined), oldest first: a move takes the player out and puts
 * it back at the end, so the first entry whose socket is still open is the idlest.
 */
export class Seats {
  private readonly moves = new Map<string, number>();
  /** Whether the playing sockets open at wake-up are in `moves` yet. */
  private seeded = false;
  /** Size past which bound() sweeps next. */
  private sweepAt = 0;

  constructor(private readonly idleMs = IDLE_YIELD_MS) {}

  /** Players listed, those who left included until a sweep. */
  get size(): number {
    return this.moves.size;
  }

  /** The player moved (an op or a discard) or joined at `now`. */
  moved(player: string, now: number): void {
    this.moves.delete(player);
    this.moves.set(player, now);
  }

  /**
   * After a wake-up: the players of the sockets already open count as having moved now. Their
   * last move is not known, and a player must never lose a place on a guess. Runs once.
   */
  seed(players: () => Iterable<string>, now: number): void {
    if (this.seeded) return;
    this.seeded = true;
    for (const player of players()) if (!this.moves.has(player)) this.moves.set(player, now);
  }

  /**
   * The player idle longest at `now`, if idle for idleMs or more; null otherwise. Players
   * without an open socket (`open` says) are dropped on the way.
   */
  idlest(now: number, open: (player: string) => boolean): string | null {
    for (const [player, at] of this.moves) {
      if (!open(player)) {
        this.moves.delete(player);
        continue;
      }
      return now - at >= this.idleMs ? player : null;
    }
    return null;
  }

  /** The player gave up its place: it is no candidate while its socket is still closing. */
  forget(player: string): void {
    this.moves.delete(player);
  }

  /**
   * A bound on memory: players who left stay listed until they come first, so once the list
   * doubles since the last sweep (and holds over `floor`), every player without an open socket
   * is dropped. Amortised: each sweep is paid for by as many joins.
   */
  bound(open: (player: string) => boolean, floor = 1024): void {
    if (this.moves.size <= Math.max(floor, this.sweepAt)) return;
    for (const player of [...this.moves.keys()]) if (!open(player)) this.moves.delete(player);
    this.sweepAt = 2 * this.moves.size;
  }
}
