# Season simulation

Plays a whole season on the real `@brickplace/core` to tune the drop rates in ADR 0005
and ADR 0010 before launch. It measures what the ADRs ask for: holes remaining, share of
filled cells held by single bricks, fill speed, how well artworks survive and how many
items players throw away.

```sh
pnpm --filter @brickplace/sim sim                       # 72 h, 500 players, the core's rates and rules
pnpm --filter @brickplace/sim sim --hours 168 --rates 75/5/10/10,60/5/20/15,50/6/24/20
pnpm --filter @brickplace/sim sim --phases fill --draw any --rates 75/5/10/10,55/10/22/13,32/18/40/10   # ADR 0005
pnpm --filter @brickplace/sim sim --help
```

A run is deterministic for a given seed and config. `--json FILE` writes every hourly
snapshot. A 168 h run at the defaults takes about 22 s (27 s at 30% griefers) on an 8-core
laptop.

## Model

- **Map**: 512² with a 256² start growing by 64 a side at 70% fill: the real 1024² / 512²
  (ADR 0027) and the core's `DEFAULT_OPEN_GROWTH` (70%, 128 a side) at half the edge. 500
  sim players on 512² is roughly 2,000 concurrent players on the real map (same items per
  cell per minute). The results below were run when the real map was 2048² (ADR 0004); the
  sim map and its proportions are unchanged, so they hold, and the real player counts they
  stand for are a quarter of what they were.
- **Items**: the core's `DEFAULT_ITEM_CONFIG` (ADR 0010–0012): the ADR 0011 rates (k1) with ADR 0035's settling hammer
  (`84/5/1/10,70/10/10/10,40/10/25/25`; the results below predate it and ran k1), a
  hold of 3, a 60 s cooldown and one starting item. `--rates` replaces only the rates; the
  core's `checkItemConfig` refuses anything it would refuse (whole numbers only).
- **Time and the hold**: one tick is one cooldown. Each player looks at its hold once per
  tick, as the server does when an op arrives, with the core's hold arithmetic (`newHold`,
  `itemsDue`, `addItems`, `takeItem`): the starting item at once, then one item per cooldown
  while the hold has room. The player plays whatever it can, and throws away its oldest item
  (the discard op, ADR 0012) when the hold is full and nothing was useful. So a hold is never
  full from one tick to the next, and the core's rule that a full hold banks no time never
  comes into play here, as it would for a player who stays away with a full hold.
- **Draws**: the core's own draw, `drawContext` and `drawFrom` with the rates of the core's
  `phaseOf` (ADR 0010), read from the map as it is at the moment the item arrives: phase by
  brick room (settling < 60%, contested < 85%, saturated above), a single brick becomes a
  brick while the map has no hole, a brick's shape is drawn among the shapes that fit, and a
  brick no shape fits becomes a shield. Each draw takes two 32-bit words from the run's
  seeded generator where the server takes them from its keyed HMAC (ADR 0012).
  `test/core-draw.test.ts` checks that the sim's draw function, with every experiment off
  and the rates of `phaseOf`, gives the core's `drawItem` for the same map and words; the
  season tests in `test/sim.test.ts` check that a run draws with the live map (not the
  map at the start of the tick) and with the rates of the phase by brick room. `--phases fill` (the ADR 0005 phases, at the core's thresholds) and
  `--draw any` (any of the seven shapes) are experiments.
- **Refresh**: every tick (`--refresh N` for every N ticks) and right after the open area
  grows, the sim reads the core's anti-stuck counters (`state.counters`: cover per cell)
  into the lists of coverable cells and holes that players aim at. That is a model of what
  players see, not a rule: draws and phases always read the live counters. Before
  2026-10-24 the scan ran every 10 ticks and not after growth, and until the changes below
  draws also used these lists, so a player drawing late in a tick saw the room as it was at
  the start of the tick.
- **Players** (default mix 40/40/10/10):
  - builders draw one artwork each (30 artworks of 24², a few colour regions with irregular
    borders): bricks in the colour most of their cells want, single bricks into holes in the
    right colour, hammers on wrong cells, shields on right ones. A finished artwork leaves
    bricks and single bricks free for the rest of the map;
  - casual players put bricks anywhere in any colour (of 12 spots that fit, the one touching
    the most filled cells), and hammer and shield random cells;
  - griefers pick an artwork, hammer its right cells (least shielded first), add wrong
    colours and shield the damage; spare bricks and single bricks go anywhere;
  - repairers move every hour to the most damaged artwork and maintain it like a builder.
- **Rules on the core**: every move goes through `apply` of `@brickplace/core` at the
  tick's logical time (one tick is 60,000 ms): single bricks only into an empty cell no
  brick placement can cover (ADR 0005, refused as `coverable` otherwise), shield layers
  expiring 48 h after they were placed (ADR 0007; the core sweeps them with the first
  accepted op at or after their time), a hammer removing the newest layer (ADR 0010).
  Growth is the core's `nextOpenArea` and `setOpenArea`. A divergence: the server checks it
  after every batch of ops, the sim only after a whole tick of moves, so here the open area
  can grow up to one tick (one cooldown) later. The sim only keeps report bookkeeping (which cells hold
  a single brick), the player model and the experiments below.
- **Experiments**, not rules, there to measure alternatives. The draw experiments sit on
  top of the core's draw: they change which shapes count as fitting, or re-draw a brick
  draw (a brick the core handed out, or one it turned into a shield):
  - `--hammer piece`: an unshielded hit clears every unshielded cell of the brick;
  - `--fit-min N`: a shape counts as fitting only with at least N valid placements
    (ADR 0010 says one);
  - `--no-fit redraw`: a brick draw with no fitting shape is re-drawn among single brick,
    hammer and shield by their phase rates (single bricks left out while the map has no
    hole) instead of becoming a shield;
  - `--room-scale P`: a brick draw is kept with probability min(1, placements / P), where
    placements is the total of valid placements in the open area, and re-drawn as above
    otherwise; the brick weight it loses goes to the other items in proportion to their
    rates. Used with `--no-fit redraw`.
- **Discards**: a player throws its oldest item away when the hold is full and nothing in
  it could be played. Every player tries a brick or single brick it cannot use on its own
  target anywhere on the map, so a discarded brick or single brick is one nobody could
  use at that moment, whoever held it. Builders and repairers hammer and shield only their
  own artwork (every hammer they use clears a wrong cell), so their hammer and shield
  discards are items they did not want. Casual players play hammers and shields anywhere
  and never discard them, so the casual discard share counts only bricks and single
  bricks. The summary reports all discards and the casual share; `byPlayer` in `--json`
  has draws, uses and discards per player kind.

Known biases: players are online all the time, casual hammering is uniform over the map, and
there is no coordination between builders. A run whose phase measure lands near a
threshold plays at the rates of whichever side it sits on: in the fill-based results below,
the 30%-griefer run with the one-cell hammer stays just under 85% and plays mostly at
contested rates (hammers 24% of the run's draws, against 40% at saturated rates), and its
fill and holes figures come from that. Treat the numbers as directions, not forecasts.

## Results with fill-based phases (ADR 0005 rules, 2026-10-23, seed 1)

These runs predate ADR 0010 and were made at commit 858b39c. The current code with
`--phases fill --draw any --refresh 10` and the rates of the row plays the same rules but
also rescans after the open area grows and draws from the live map, so its figures are
close to these, not identical (ADR 0005 rates, seed 1: 663 holes against 692, singles
33.8% / 70.0% / 92.7% against 34% / 70% / 93%; 666 and 33.7% / 69.9% / 92.7% before the
core-draw change). 500 players,
mix 40/40/10/10 unless noted. "Low singles" is `75/5/10/10,60/5/20/15,50/6/24/20`; "no
singles" moves the single share to bricks. Holes are a share of the whole 512² map. The
open area reached its full size after about 1.3 h in every run except the
saturated-rates² rows (3.1 h with the one-cell hammer, 8.0 h with the whole-brick one).

| Run                       | Hours | Fill  | Holes | Singles at 24 / 72 / 168 h | Art correct | Bricks used / drawn |
| ------------------------- | ----- | ----- | ----- | -------------------------- | ----------- | ------------------- |
| ADR 0005 rates            | 168   | 99.7% | 0.3%  | 34% / 70% / 93%            | 99.9%       | 4%                  |
| ADR rates, `--search 48`  | 168   | 99.8% | 0.2%  | 34% / 70% / 93%            | 99.9%       | 4%                  |
| Low singles               | 168   | 94.1% | 5.9%  | 14% / 38% / 65%            | 100%        | 3%                  |
| ADR rates, piece hammer   | 168   | 99.7% | 0.2%  | 27% / 53% / 82%            | 99.9%       | 18%                 |
| Low singles, piece        | 168   | 94.8% | 5.2%  | 14% / 37% / 66%            | 100%        | 7%                  |
| No singles                | 72    | 78.0% | 21.8% | 0%                         | 74.6%       | 7%                  |
| ADR, 30% griefers¹        | 72    | 85.0% | 15.0% | 14% / 31% / –              | 68.4%       | 7%                  |
| ADR, 30% griefers¹, piece | 72    | 92.3% | 6.9%  | 16% / 33% / –              | 44.0%       | 51%                 |
| Saturated rates², cell    | 72    | 84.0% | 15.8% | – / 37% / –                | 43.0%       | 19%                 |
| Saturated rates², piece   | 72    | 92.5% | 6.8%  | – / 33% / –                | 45.6%       | 57%                 |

¹ `--mix 30/35/30/5`. ² `--rates 32/18/40/10` in all three phases, `--mix 30/35/30/5`, so
both hammer rules play the same items.

30-day runs, share of filled cells held by single bricks:

| Rates          | 5 days | 10 days | 15 days | 20 days | 30 days |
| -------------- | ------ | ------- | ------- | ------- | ------- |
| ADR 0005 rates | 85%    | 97.5%   | 99.5%   | 99.9%   | 100%    |
| Low singles    | 54%    | 77%     | 87%     | 91%     | 94%     |

What it says (directions, given the biases above):
1. **Single bricks are needed.** Without them artworks end at 75% correct and none stays
   above 90%; with them they stay near 100% at a 10% griefer share.
2. **Over a long season the map turns into single bricks.** Once the map is full, a
   hammered cell can only come back as a single brick, and single-brick cells only become
   brick space again when four touching cells are empty at once, which almost never happens
   on a full map. At the ADR rates the share reaches 100% by about day 20; with low singles
   it levels off near 94% by day 30 (each 5-day gain is about half the one before), with
   about 90,000 cells held by shields. Over a one-week season: 93% and 65%. The ~12% in
   ADR 0005 holds only for the first hours.
3. **Holes depend on the single-brick supply, not on packing.** With the ADR rates nearly
   every hole gets filled (0.3% left, fill 99.7%); with low singles every drawn single brick
   is used and 6% of the map stays as holes. `--search 12` and `48` give the same result.
4. **Most bricks are useless**: over the week, with the one-cell hammer, 96–97% of drawn
   bricks are thrown away because nothing fits once the map is full (after the first
   hours). Players would mostly receive junk.
5. **A whole-brick hammer** (experiment) slows the drift a little (82% against 93% after a
   week; 33% against 37% at equal rates). At equal rates it also halves the holes (6.8%
   against 15.8%) and places three times the bricks (57% of draws against 19%); over the
   week-long runs holes barely move (0.3% to 0.2%, 5.9% to 5.2%) and bricks placed go from
   4% to 18% (ADR rates) and 3% to 7% (low singles). It does not make griefing stronger:
   at equal rates artworks end 45.6% correct against 43.0% with the one-cell hammer. The
   44% against 68% in the 30%-griefer rows comes from the one-cell run playing at contested
   rates (fewer hammers), not from the hammer rule.

## Results with the ADR 0010 rules (2026-10-24, seeds 1–3, scan every tick)

Phases by brick room and fitting shape draws (the defaults), with the open area rescanned
every tick. An earlier version of this section (commit 7bfedea) scanned every 10 ticks;
its figures are superseded. The stale scan hid brick room from casual players for up to
10 ticks, and several results moved a lot once it was removed (see point 3). These tables
were made with the sim's own draw, which saw the map as it was at the start of each tick;
the k1 rows were re-run on the core's draw (below the first table) and the other sets were
not. Their unusable and discard shares are likely overstated in the same way (k1's
unusable share fell from 10.0% to 7.6%), not measured.

Every row is the mean of three runs, `--seed 1`, `--seed 2` and `--seed 3`, each with
`--hours 168 --rates <set> --hammer <cell|piece>`, plus `--mix 30/35/30/5` in the
30%-griefer table and `--fit-min 200` where noted. At the default mix, art, single-brick
shares and discards varied across seeds by at most 0.8 points, shielded shares by 1.5
points, bricks placed by at most 3,700 and holes by at most 120; the 30%-griefer ranges are
in that table. The rate sets:

| Set         | `--rates`                            | Note                                            |
| ----------- | ------------------------------------ | ----------------------------------------------- |
| ADR 0005    | `75/5/10/10,55/10/22/13,32/18/40/10` |                                                 |
| Low singles | `75/5/10/10,60/5/20/15,50/6/24/20`   |                                                 |
| k1          | `85/5/0/10,70/10/10/10,40/10/25/25`  | the owner's starting set                        |
| k2          | `85/5/0/10,70/10/10/10,45/8/22/25`   | fewer singles and hammers than k1               |
| k3          | `85/5/0/10,70/10/10/10,35/12/35/18`  | more hammers, fewer shields                     |
| k4          | `85/5/0/10,70/10/10/10,40/10/20/30`  | k1 with five points of hammers moved to shields |
| k5          | `85/5/0/10,70/10/10/10,35/10/25/30`  | k1 with five points of bricks moved to shields  |
| r1          | `85/5/0/10,70/10/10/10,25/25/25/25`  |                                                 |
| r2          | `85/5/0/10,70/10/10/10,30/15/20/35`  |                                                 |
| r3          | `85/5/0/10,70/10/10/10,20/20/30/30`  |                                                 |
| r4          | `85/5/0/10,70/10/10/10,40/12/24/24`  |                                                 |

Default mix (10% griefers). Singles are the share of filled cells held by single bricks;
bricks are thousands placed; holes are empty cells no brick can reach, on the 262,144-cell
map; discards are a share of items drawn, for all players and for casual players only;
"unusable" is bricks and single bricks thrown away by anyone, as a share of all items
drawn (items nobody could use, see Model); shielded is the share of the map's cells with at
least one shield layer at the end.

| Set             | Hammer | Art correct | Singles 24 / 168 h | Bricks by 24 / 168 h | Holes  | Discards all / casual | Unusable | Shielded |
| --------------- | ------ | ----------- | ------------------ | -------------------- | ------ | --------------------- | -------- | -------- |
| ADR 0005        | cell   | 100.0%      | 34.4% / 81.7%      | 65 / 65              | 38     | 43.4% / 10.6%         | 11.8%    | 52%      |
| ADR 0005        | piece  | 99.7%       | 25.2% / 81.3%      | 149 / 318            | 101    | 41.6% / 26.2%         | 27.2%    | 19%      |
| Low singles     | cell   | 100.0%      | 14.7% / 55.1%      | 67 / 71              | 13     | 51.6% / 16.8%         | 17.0%    | 75%      |
| Low singles     | piece  | 100.0%      | 13.7% / 66.0%      | 119 / 188            | 12,328 | 61.4% / 45.8%         | 45.9%    | 37%      |
| k1              | cell   | 100.0%      | 24.0% / 56.4%      | 62 / 62              | 13     | 48.5% / 9.7%          | 10.0%    | 72%      |
| k1              | piece  | 100.0%      | 22.8% / 73.2%      | 105 / 133            | 15     | 54.0% / 27.9%         | 28.6%    | 69%      |
| k2              | cell   | 100.0%      | 20.1% / 51.2%      | 62 / 62              | 10     | 49.7% / 10.2%         | 10.5%    | 76%      |
| k2              | piece  | 100.0%      | 19.0% / 68.5%      | 103 / 129            | 11     | 55.8% / 29.8%         | 30.2%    | 73%      |
| k3              | cell   | 100.0%      | 26.2% / 73.0%      | 66 / 67              | 24     | 45.2% / 10.0%         | 10.9%    | 62%      |
| k3              | piece  | 100.0%      | 24.0% / 83.9%      | 133 / 205            | 40     | 49.4% / 29.5%         | 30.4%    | 40%      |
| k4              | cell   | 100.0%      | 24.3% / 47.8%      | 59 / 60              | 10     | 50.0% / 9.5%          | 9.7%     | 76%      |
| k4              | piece  | 100.0%      | 23.4% / 63.2%      | 92 / 105             | 10     | 54.4% / 23.5%         | 24.0%    | 76%      |
| k5              | cell   | 100.0%      | 24.3% / 55.7%      | 61 / 61              | 12     | 48.2% / 8.9%          | 9.3%     | 72%      |
| k5              | piece  | 100.0%      | 23.1% / 70.2%      | 102 / 120            | 14     | 51.9% / 21.7%         | 22.4%    | 71%      |
| r1              | cell   | 100.0%      | 31.4% / 61.6%      | 57 / 57              | 14     | 52.1% / 19.8%         | 20.0%    | 63%      |
| r1              | piece  | 100.0%      | 28.1% / 76.4%      | 96 / 122             | 24     | 55.6% / 33.1%         | 33.6%    | 58%      |
| r2              | cell   | 100.0%      | 27.7% / 48.9%      | 58 / 58              | 10     | 51.1% / 12.3%         | 12.5%    | 74%      |
| r2              | piece  | 100.0%      | 26.1% / 62.4%      | 86 / 94              | 8      | 53.8% / 21.6%         | 22.0%    | 73%      |
| r3              | cell   | 100.0%      | 33.4% / 67.1%      | 58 / 58              | 23     | 48.2% / 13.8%         | 14.2%    | 61%      |
| r3              | piece  | 100.0%      | 30.4% / 78.4%      | 102 / 124            | 29     | 49.8% / 22.0%         | 22.8%    | 59%      |
| r4              | cell   | 100.0%      | 27.8% / 55.3%      | 60 / 60              | 10     | 49.1% / 10.4%         | 10.7%    | 72%      |
| r4              | piece  | 100.0%      | 24.7% / 73.5%      | 102 / 129            | 16     | 55.3% / 30.5%         | 31.1%    | 68%      |
| k1, fit-min 200 | cell   | 99.9%       | 24.6% / 52.8%      | 59 / 60              | 13     | 46.8% / 5.4%          | 5.8%     | 72%      |
| k1, fit-min 200 | piece  | 100.0%      | 24.3% / 59.5%      | 89 / 93              | 15     | 46.1% / 4.7%          | 5.4%     | 72%      |

Every artwork stayed intact (≥ 90% correct) in every run of this table.

**Re-run on the core's own rules** (2026-10-24, after the sim moved from its own single
brick, shield decay and placement scan to the core's; same flags, seeds 1–3). Two rows of
the table above; holes here are the mean over hours 126–168 of each run (then over seeds),
since the count at a single hour moves a lot:

| Set      | Hammer | Art correct | Singles 24 / 168 h | Bricks by 24 / 168 h | Holes, h126–168 | Discards all / casual | Unusable | Shielded |
| -------- | ------ | ----------- | ------------------ | -------------------- | --------------- | --------------------- | -------- | -------- |
| ADR 0005 | cell   | 100.0%      | 34.4% / 81.6%      | 65 / 65              | 38.4 → 39.1     | 43.4% / 10.6%         | 11.8%    | 52%      |
| k1       | cell   | 100.0%      | 24.0% / 56.5%      | 62 / 62              | 14.1 → 15.0     | 48.5% / 9.7%          | 10.0%    | 72%      |

Everything else matches the earlier table to the shown precision (singles at 168 h moved by
0.1 point). The holes at hour 168 alone read 13 → 18 for k1 (12/12/15 against 17/16/20 by
seed), but the hourly count ranges from 6 to 24 over hours 126–168 in both versions and
the window means differ by less than one cell, so the change is within noise. A run also
takes about 20 s instead of 41 s, since the counters replace the per-tick scan.

**Re-run on the core's draws and hold** (2026-10-24, after the sim moved from its own draw,
phases and hold to the core's `drawFrom`, `phaseOf` and hold functions; k1, one-cell hammer,
168 h, seeds 1–3). Before: the version above, re-run at commit 3744eb2. Holes are the mean
over hours 126–168 as above, and the value at hour 168:

| k1, cell                    | Art correct | Singles 24 / 168 h | Bricks by 24 / 168 h | Holes, h126–168 / h168 | Discards all / casual | Unusable | Shielded |
| --------------------------- | ----------- | ------------------ | -------------------- | ---------------------- | --------------------- | -------- | -------- |
| Default mix, before         | 100.0%      | 24.0% / 56.5%      | 62 / 62              | 15.0 / 18              | 48.5% / 9.7%          | 10.0%    | 72%      |
| Default mix, core draws     | 100.0%      | 24.3% / 55.1%      | 61 / 61              | 14.4 / 14              | 47.9% / 7.9%          | 7.6%     | 72%      |
| 30% griefers, earlier table | 71.4%       |                    |                      | – / 14                 | – / 12.6%             |          |          |
| 30% griefers, core draws    | 72.3%       | 20.4% / 55.7%      | 62 / 62              | 16.0 / 12              | 27.6% / 8.6%          | 8.2%     | 68%      |

At 30% griefers art is 72.3% (71.6–73.0 by seed) against 71.4% (70.6–71.9); the earlier
figures there come from the tables above, which predate the core-backed change, and were
not re-run. Builder and repairer hammers are 436 thousand against 437 in the earlier
table, and griefers used 374 thousand (seed 1) as before.

Why the numbers moved: draws now read the map at the moment each player's item arrives,
as the server does, instead of lists refreshed at the start of each tick. Within a tick of
500 players the last hole is often filled, or the last brick placement taken, before
everyone has drawn. The core then turns a single brick into a brick and a brick that fits
nowhere into a shield, where the old sim still handed out the single brick or the brick,
which nobody could use. At the default mix about 46,000 single bricks a week were drawn
while the map had no hole and converted (seed 1: 45,938, against 23 before), each to a
brick, or to a shield when no shape fit either; 83,000 fewer bricks were drawn (211,928
against 294,538) and 130,000 more shields. So fewer unusable items
are handed out (unusable 10.0% to 7.6%, casual discards 9.7% to 7.9%), slightly fewer single
bricks are placed (singles after a week 56.5% to 55.1%), and the rest moves little
(singles after a day 24.0% to 24.3%, bricks placed 61.9 to 61.5 thousand, holes within
noise, shielded unchanged). The starting item, one item per cooldown and the discard of the
oldest item behave as before; what changed is the map each draw sees. A run takes about
22 s (27 s at 30% griefers).

30% griefers (`--mix 30/35/30/5`), art correct as mean (lowest–highest seed). Builder and
repairer hammers are those they used, in thousands: they only hammer wrong cells of their
artwork, and in these runs they used practically every hammer they drew, so the column is
the hammer supply of builders and repairers:

| Set             | Art, cell         | Holes, cell | Builder and repairer hammers, cell | Art, piece        | Holes, piece |
| --------------- | ----------------- | ----------- | ---------------------------------- | ----------------- | ------------ |
| ADR 0005        | 0.6% (0.5–0.7)    | 42,624      | 699                                | 0.7% (0.5–1.1)    | 25,885       |
| Low singles     | 69.9% (69.4–70.6) | 45,756      | 420                                | 67.4% (66.7–67.8) | 34,724       |
| k1              | 71.4% (70.6–71.9) | 14          | 437                                | 66.4% (66.0–66.6) | 18           |
| k2              | 65.8% (64.7–66.3) | 14          | 385                                | 68.6% (68.4–69.1) | 17           |
| k3              | 31.4% (30.8–32.5) | 44,336      | 610                                | 33.8% (33.3–34.7) | 32,470       |
| k4              | 58.3% (57.4–59.2) | 10          | 349                                | 61.6% (60.9–62.6) | 13           |
| k5              | 68.4% (67.3–69.4) | 17          | 436                                | 67.5% (67.1–67.8) | 18           |
| r1              | 61.0% (60.7–61.2) | 18          | 436                                | 50.1% (49.9–50.4) | 27           |
| r2              | 56.6% (55.9–57.2) | 8           | 350                                | 58.9% (58.8–58.9) | 14           |
| r3              | 67.1% (66.2–68.6) | 30          | 523                                | 56.2% (55.2–57.7) | 36           |
| r4              | 67.6% (67.1–67.9) | 21          | 420                                | 58.0% (57.3–58.9) | 20           |
| k1, fit-min 200 | 58.8% (58.5–59.0) | 16          | 436                                | 62.6% (61.7–63.8) | 19           |

No run kept a 30%-griefer artwork set above 72% correct; at most four artworks of 30
stayed intact.

What it says (directions, given the biases above):
1. **At 500 players the saturated rates decide the week.** By brick room the saturated
   phase starts at hour 3 (hour 4 in 6 of 192 runs), while the fill is 75–86%, and no run
   leaves it, so the settling and contested rates apply for about 3 of 168 hours. Bricks
   are placed almost only in the first 24 hours with the one-cell hammer. This depends on
   the player count: with k1 and 50 players (`--players 50`, seed 1) settling lasts 10 h
   and contested 11 h (saturated from hour 22, 52 of 61 thousand bricks placed by 24 h);
   with 25 players 19 h and 22 h (saturated from hour 42, 29 of 58 thousand by 24 h).
2. **At 10% griefers every set keeps the artworks**, so that target does not separate
   them. At 30% griefers none comes near 95%: the best is k1 with the one-cell hammer
   (71%), then low singles (70%), k5, r4 and r3 (67–68%); ADR 0005 and k3 lose almost
   everything. k1's case for the week is a trade-off rather than a clear win: slower drift
   to single bricks than ADR 0005 (56% against 82% after a week), few holes (13), and one
   of the lowest unusable shares (10.0%; k5 9.3%, k4 9.7%). Lower drift is available (k4
   48%, r2 49%, k2 51%) at a lower 30%-griefer score (58%, 57%, 66%). On the core's draw k1
   reads 55% drift, 14 holes, 7.6% unusable and 72% at 30% griefers; the other sets were
   not re-run, so the comparison stands on the old draw.
3. **The 30%-griefer results are very sensitive to the model, and so is their ranking.**
   Small rate changes move them by 5–15 points (k1 71%, k4 58%), and so does the scan
   interval: with a scan every 10 ticks k1 scored 89% and r3 94.8–97.1%, against 71% and
   67% here, and ADR 0005 44% against 1%. The order flips too (r3 above k1 with the
   10-tick scan, k1 above r3 here), so the ranking is not robust either. A 48 h check
   (ADR 0005 rates, 30% griefers, seed 1) points at brick placement on the map: the
   default ends at 0.4% correct, `--search 1` (no preference for tight gaps) at 31.6% and
   `--refresh 10` at 39.5%. A hypothesis, not measured directly: with fresh room
   information, bricks placed by the casual rule, which prefers the spot touching the most
   filled cells, go into the tight gaps griefers open in artworks, in random colours. That
   rule places casual players' bricks and also every other player's spare bricks (those
   that do not fit its own target). Treat the 30%-griefer column as one model's output,
   not as survival rates.
4. **Hammer supply and repairs** (measured, not proven causal): builders and repairers
   clear wrong cells only with hammers, and in the 30%-griefer runs they used every hammer
   they drew (k1 436,544 of 436,656, k4 349,517 of 349,517, seed 1), so the table's column
   is their hammer supply, set by the rates. k4 moves five points from hammers to shields,
   gets 349 thousand against k1's 437, and scores 58% against 71%. Equal supply does not
   give equal art: k1, k5, r1 and k1 with `--fit-min 200` all get about 436 thousand and
   score 71%, 68%, 61% and 59%. ADR 0005 and k3 get more (699 and 610 thousand) and still
   collapse.
5. **Where the week ends up depends on holes.** At the default mix every set packs the map
   to almost no brick room (8–101 holes left), except low singles with the whole-brick
   hammer (12,328 holes). Once nothing fits, bricks become shields (ADR 0010), and
   19–76% of the map's cells end the week shielded, 72% with k1 and the one-cell hammer.
   At 30% griefers, ADR 0005, low singles and k3 leave 25,900–45,800 holes open with
   either hammer: single bricks do not keep up with the hammers there.
6. **With the one-cell hammer and 500 players, rates cannot buy brick play.** At the
   default mix every set places 57–71 thousand bricks over the week, about one fill of the
   map. What the rates
   change is how fast bricks are replaced by single bricks: 48–82% of filled cells after
   a week, lowest with k4, r2 and k2. With the whole-brick hammer, bricks keep being placed
   all week (93–318 thousand), most with the ADR 0005 rates.
7. **Most discards are items players did not want, not items nobody could use.** Builders'
   and repairers' hammer and shield discards (on a finished, fully shielded artwork) are
   65–67% of all discards in the k1 and ADR 0005 one-cell runs (seed 1, `byPlayer` in the
   `--json` report). The unusable share is 9–20% with the one-cell hammer (5.8% with
   `--fit-min 200`) and 22–46% with the whole-brick hammer, where brick room keeps
   reopening and many drawn bricks still find no spot. The casual figures count only bricks
   and single bricks: casual players never discard a hammer or shield.
8. **Hammer rule at equal rates**: at 10% griefers both keep the artworks. At 30% the
   whole-brick hammer scores lower in six sets (by up to 11 points; k1 66% against 71%),
   2–3 points higher in four (k2, k3, k4, r2) and level for ADR 0005. It is mostly level
   or worse for artworks under these rules. ADR 0010 §5 records the whole-brick hammer as
   "not worse for artworks" from the earlier fill-based runs; these per-tick runs do not
   change the decision to keep the one-cell hammer.
9. **Model limits on the discard figures**: casual players compare 12 random spots for a
   brick (`--search`), and the scan interval matters. With k1 and the one-cell hammer
   (seed 1), casual discards are 9.6% with a scan every tick, 11.1% every 10 ticks and
   9.5% with `--search 48`; with `--fit-min 200` 5.4%, 4.1% and 5.4%. The earlier
   10-tick figures overstated the waste and the `--fit-min` gain.

## Bricks that fit nowhere useful: thresholds against a room-scaled draw (2026-10-24)

ADR 0010 hands out a brick whenever some shape has one valid placement. On a nearly full
map that leaves a few placements for 500 players, so most such bricks are thrown away.
Two ways to stop that were compared with k1 and the one-cell hammer, 168 h, seeds 1–3, at
both mixes:
- **A, hard threshold**: a shape counts as fitting only with at least N valid placements
  (`--fit-min N`); with none, the brick becomes a shield (A) or is re-drawn among single
  brick, hammer and shield by their phase rates (A-redraw, `--no-fit redraw`).
- **B, gradual**: a brick draw is kept with probability min(1, placements / P), where
  placements is the total over all orientations, and re-drawn otherwise
  (`--room-scale P --no-fit redraw`), so the lost brick weight goes to the other items in
  proportion.

Every row adds its flags to
`--hours 168 --rates 85/5/0/10,70/10/10/10,40/10/25/25 --hammer cell`, with
`--mix 30/35/30/5` for the 30% values. Columns are for the default mix except the 30% art
and 30% casual discards.

| Variant      | Flags                               | Art 10% / 30% | Casual discards 10% / 30% | Unusable | Shielded | Singles 24 / 168 h | Holes | Bricks |
| ------------ | ----------------------------------- | ------------- | ------------------------- | -------- | -------- | ------------------ | ----- | ------ |
| ADR 0010     | (none)                              | 100% / 71.4%  | 9.7% / 12.6%              | 10.0%    | 72%      | 24.0% / 56.4%      | 13    | 62     |
| A, N 50      | `--fit-min 50`                      | 100% / 59.3%  | 5.4% / 5.3%               | 5.8%     | 72%      | 24.5% / 53.0%      | 13    | 60     |
| A, N 200     | `--fit-min 200`                     | 99.9% / 58.8% | 5.4% / 5.3%               | 5.8%     | 72%      | 24.6% / 52.8%      | 13    | 60     |
| A, N 800     | `--fit-min 800`                     | 99.5% / 60.4% | 5.5% / 5.3%               | 5.8%     | 72%      | 24.9% / 52.2%      | 12    | 60     |
| A-redraw 50  | `--fit-min 50 --no-fit redraw`      | 100% / 57.6%  | 5.6% / 3.5%               | 7.0%     | 51%      | 35.0% / 79.4%      | 36    | 62     |
| A-redraw 200 | `--fit-min 200 --no-fit redraw`     | 99.8% / 57.6% | 5.4% / 3.5%               | 6.9%     | 51%      | 35.0% / 79.2%      | 37    | 62     |
| A-redraw 800 | `--fit-min 800 --no-fit redraw`     | 99.3% / 58.2% | 5.6% / 3.5%               | 7.0%     | 51%      | 35.5% / 78.9%      | 36    | 62     |
| B, P 250     | `--room-scale 250 --no-fit redraw`  | 100% / 57.0%  | 5.5% / 3.5%               | 7.0%     | 52%      | 34.9% / 79.6%      | 36    | 62     |
| B, P 1000    | `--room-scale 1000 --no-fit redraw` | 100% / 58.2%  | 5.5% / 3.5%               | 6.9%     | 51%      | 35.0% / 79.4%      | 38    | 62     |
| B, P 4000    | `--room-scale 4000 --no-fit redraw` | 100% / 57.1%  | 5.5% / 3.5%               | 7.0%     | 51%      | 35.0% / 79.4%      | 41    | 62     |

Seed ranges: at most 0.5 points at the default mix, and 0.5–4.1 points for 30% art.

This table was made with the sim's own draw (the map as at the start of each tick). Three
rows re-run on the core's draw (2026-10-24, same flags, seeds 1–3; experiments now sit on
top of the core's `drawFrom`):

| Variant   | Art 10% / 30%             | Casual discards 10% / 30% | Unusable | Shielded | Singles 24 / 168 h | Holes | Bricks |
| --------- | ------------------------- | ------------------------- | -------- | -------- | ------------------ | ----- | ------ |
| ADR 0010  | 100% / 72.3% (71.6–73.0)  | 7.9% / 8.6%               | 7.6%     | 72%      | 24.3% / 55.1%      | 14    | 61     |
| A, N 50   | 99.8% / 57.1% (56.0–57.9) | 5.0% / 5.0%               | 4.9%     | 72%      | 24.6% / 52.8%      | 13    | 60     |
| B, P 1000 | 100% / 57.2% (57.0–57.3)  | 5.2% / 3.4%               | 6.5%     | 51%      | 35.0% / 79.5%      | 42    | 62     |

The core's draw already stops handing out a brick or single brick once the last placement
or hole is taken earlier in the same tick, which the old draw did not, so it removes part
of the waste the variants were meant to remove: the gap in unusable items shrinks from 4.2
to 2.7 points (A) and from 3.0 to 1.1 points (B). The cost at 30% griefers grows a little,
to 15 points, since the ADR 0010 draw gained about a point and the variants lost one or
two; both moves are within or near the seed spread. The points below quote the old
figures and, where they changed, the core-draw ones.

What it says:
1. **Every variant cuts the waste, by about 3–4 points of all draws** (1–3 points with the
   core's draw): unusable items go from 10.0% of draws to 5.8% (A) or 7.0% (A-redraw, B);
   with the core's draw from 7.6% to 4.9% (A, N 50) or 6.5% (B, P 1000). Casual discards
   roughly halve, from 9.7% to 5.4–5.6% (12.6% to 3.5–5.3% at 30% griefers); with the
   core's draw from 7.9% to 5.0–5.2% (8.6% to 3.4–5.0%). At 10% griefers all keep the
   artworks (≥ 99.3%).
2. **The gain is almost all in hours 3–24.** That is when the ADR 0010 draw hands out
   bricks for the last scraps of room: with k1, 207,704 bricks are thrown away between
   hour 3 and hour 24, against 1,275 with A, N 50 (seed 1); with the core's draw 142,555
   against 137. After day 1 the remaining waste is mostly single bricks: 270 thousand
   thrown away with k1, 288 thousand with A, N 50, and 345 thousand with B, P 1000 (seed
   1); with the core's draw 232, 243 and 325 thousand. No variant reduces it; A raises it a
   little and B more.
3. **N and P barely matter in the ranges tried** (N 50–800, P 250–4000; nothing below
   N 50 was tried). At 500 players brick room collapses within a few hours of the start,
   so every threshold cuts bricks off at about the same time. What matters is where the
   brick weight goes.
4. **Shield (A) or re-draw (A-redraw, B)**: A keeps the slow drift (53% single bricks after
   a week) but keeps the shield flood (72% of cells shielded). Re-drawing avoids the flood
   (51%) but hands out more hammers and single bricks, so the map turns over faster (79%
   single bricks after a week, 35% after a day against 24%). B and A-redraw are the same
   within noise.
5. **All variants cost artworks at 30% griefers**: 57–60% correct against 71% with the
   ADR 0010 draw, 11–14 points, against seed spreads of at most 4.1 points (with the
   core's draw 57% against 72%, 15 points, for A, N 50 and B, P 1000). Why is not
   established; two candidates, neither proven:
   - with A, some empty cells can take a brick but get none, since no shape reaches N and
     a single brick is only allowed where no brick fits. This dead room does not explain
     the cost on its own: over hours 96–168 it is 29–267 cells with N 50 and 181–1,011
     with N 200 (all seeds, both mixes), yet both lose the same art. A also hands the
     griefers more shields (524 thousand used with N 200 against 463 thousand, seed 1);
   - with B and A-redraw, the re-draws hand out more hammers to everyone: griefers use
     621 thousand with B, P 1000, against 374 thousand with k1 (seed 1).
6. **Scaling to the real map**: N and P count placements over the open area, which on the
   real 1024² map (ADR 0027) is 4 times the sim's 512² at the same players per cell. N 50
   here is about 200 there and P 1000 about 4,000; as shares of the open area, 0.02% and
   0.4% of its cells. With fewer players per cell, room lasts longer and the thresholds bite later.

**Recommendation**: on these numbers, keeping ADR 0010 as it is (one valid placement, no
threshold) gives the best artworks at 30% griefers, at the cost of about 8% of draws being
unusable with the core's draw (10% in the old sim), mostly single bricks after day 1.
Every variant tried costs 11–15 points of art at 30% griefers, more than the seed spread,
so that cost comes with any of them. If cutting unusable items matters more, A is the
variant to try: it removes the wasted bricks of hours 3–24 (unusable 7.6% to 4.9% with the
core's draw; 10.0% to 5.8% in the old sim) and keeps k1's slow drift, but keeps the
shield flood and leaves a little dead room that only a rule change could fill (for
example letting a single brick into a cell when no shape reaches N; not simulated). N 50
(about 200 placements on the real map, 0.02% of the open area) is one point in a flat
range: N 50–800 gave the same results, and nothing lower was tried. If the shield flood
matters more than the drift, B with any P from 250 to 4,000 (1,000–16,000 on the real map)
does the same without it, with a faster drift. At 10% griefers every option keeps the
artworks.

## Questions for the owner

ADR 0011 settled the rates (k1) and the threshold (none), and the re-run on the core's
draw does not change that case: a threshold now gains 1–3 points of draws and still costs
about 15 points of art at 30% griefers. What the results still leave open:
1. **ADR 0011's figures.** It quotes about 10% unusable draws and 56% single bricks after a
   week; on the core's draw these are 7.6% and 55%. Amend its Consequences, or leave them
   as the figures the decision was taken on?
2. **Heavy griefing.** At 30% griefers no rate set kept artworks above about 73% correct
   (k1: 72%), and the ranking between sets is not robust (see point 3 of the ADR 0010
   results). Is that acceptable for launch, or must moderation (rollback, area lock,
   trust limits on hammers) carry that case? Rates alone did not.
