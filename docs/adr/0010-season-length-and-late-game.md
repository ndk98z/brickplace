# 0010. One-week seasons, a single-brick late game, phases by brick room

- Status: accepted
- Date: 2026-10-23
- Amends: 0005 (phases, anti-stuck), 0007 (which shield layer a hammer removes)

## Context

The season simulation (`tools/sim/README.md`) found that once the map is full, a hammered
cell can only come back as a single brick, so the share of filled cells held by single
bricks keeps climbing: 93% after a week at the ADR 0005 rates (100% by about day 20), 65%
with lower single rates (levelling off near 94%). Over a week 96–97% of drawn bricks fit
nowhere. The phases in ADR 0005 are set by fill, which ignores holes that no brick can
reach.

## Decision

1. **A season lasts about one week** (admin-configurable).
2. **A single-brick late game is accepted.** Bricks shape the map early; late in the season
   it is repainted cell by cell. No rule is added to give brick space back.
3. **Phases are set by brick room, not fill**: the share of the open area that no brick can
   reach (filled cells plus holes). The thresholds stay at 60% and 85%; with no holes this
   equals the fill.
4. **A brick is only drawn in a shape that has a valid placement** (the anti-stuck counters,
   one per orientation). When no shape fits anywhere, the draw becomes a shield. Together
   with the ADR 0005 rule (a single brick becomes a brick when there is no hole), every item
   drawn can be used somewhere.
5. **The hammer keeps clearing one cell** (re-confirmed by the owner). A whole-brick hammer
   was simulated: it slows the drift only a little; at equal rates it halves the holes,
   places three times the bricks and is not worse for artworks. (The first write-up said it
   made griefing about twice as effective; review showed that came from phase rates, not
   the hammer rule.)
6. **A hammer on a shielded cell removes the newest layer**, so older layers keep their own
   48 h clocks (ADR 0007 left this open).

## Consequences

- The core must maintain valid-placement counts per orientation and the count of empty cells
  a brick can reach, incrementally per op, to compute the phase and draw shapes.
- Starting drop rates are re-checked with the simulation under these rules before the
  inventory work; they stay admin-configurable.
- Players late in a week get mostly single bricks, hammers and shields; the UI and the
  first-time guide should say so, so it does not look like a bug.
