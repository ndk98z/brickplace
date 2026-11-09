# 0012. Inventory: discard, starting item, season reset, item draws

- Status: accepted
- Date: 2026-10-24

## Context

The inventory work (hold of 3, one item per cooldown, ADR 0011 rates) left a few choices to
the owner, and the draw needed a format that is unpredictable to players and checkable later.

## Decision

1. **Discard stays.** A player may throw away a held item through a server op (acked and
   deduplicated like any op). About 10% of draws are unusable over a week (ADR 0011), and a
   full hold gets no new items, so without discard a player holding three of them is stuck.
   Discarding never speeds up the one-item-per-cooldown rate.
2. **A new player starts with one item**, given at once; the rest arrive one per cooldown.
   Staggered starting items at season start stay an open question.
3. **Holds are cleared when a new season starts**: everyone starts level.
4. **Draws are HMAC-SHA-256(ITEM_DRAW_KEY, "bp-draw-v1" ‖ salt ‖ player ‖ draw index)**,
   where the salt is 16 random bytes generated once per canvas and pinned in its stored
   config, so a new season never replays an old one's draws. The key is a Workers secret;
   without it nothing is drawn (fail closed).

## Consequences

- The season reset of holds belongs to the seasons work.
- A draw's words can be recomputed by anyone with the key; the item they gave also depends
  on the map at draw time, so checking an item means replaying the op log to that moment.
- Staging and production need `wrangler secret put ITEM_DRAW_KEY` before any item is drawn,
  and a deploy or health check should fail when it is missing.
