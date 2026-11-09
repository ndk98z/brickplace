# 0011. Starting drop rates, and no brick-room threshold

- Status: accepted; settling rates amended by 0035 (84 / 5 / 1 / 10)
- Date: 2026-10-24 (numbers updated and the 30%-griefer result accepted on 2026-10-25)
- Amends: 0005 (starting rates)

## Context

ADR 0005 set starting drop rates as a hypothesis; ADR 0010 changed the phases to brick room
and asked for the rates to be re-checked by simulation before the inventory work. The
season simulation (`tools/sim/README.md`, ADR 0010 section, per-tick scans, 500 players,
one-week season, one-cell hammer) compared eleven rate sets and two ways of withholding
bricks that fit almost nowhere.

## Decision

1. **Starting rates (brick / single brick / hammer / shield), admin-configurable:**

   | Phase     | Brick | Single brick | Hammer | Shield |
   | --------- | ----- | ------------ | ------ | ------ |
   | Settling  | 85    | 5            | 0      | 10     |
   | Contested | 70    | 10           | 10     | 10     |
   | Saturated | 40    | 10           | 25     | 25     |

   With 10% griefers every set kept artworks intact; this one drifts to single bricks
   slowly (55% of filled cells after a week, against 82% at the ADR 0005 rates) and ranked
   first at 30% griefers under the sim's model, although that ranking is not robust.
2. **About 72% of artwork cells kept with 30% griefers is accepted** (owner decision,
   2026-10-25). No rate set the sim tried keeps a 30%-griefer artwork set near 95%; real
   griefing is answered by moderation (ADR 0023, 0024) and the abuse limits (ADR 0026), not
   by the drop rates.
3. **No brick-room threshold.** ADR 0010's rule stays as it is: a brick is drawn in a shape
   with at least one valid placement, otherwise a shield. A threshold or a gradual brick
   weight cut unusable draws from about 10% to 6–7%, but cost 11–14 points of artwork
   accuracy at 30% griefers in every variant tried.

## Current numbers (2026-10-25)

Re-run on `main` at d00af1e: the sim on the core's own draw, phases and hold, its 512² map
standing for the 1024² launch map (ADR 0027; `tools/sim/README.md`, "Model"), k1 rates,
one-cell hammer, 500 players, 168 h, seeds 1–3
(`pnpm --filter @brickplace/sim sim --hours 168 [--mix 30/35/30/5] --seed N`; since ADR 0035
add `--rates 85/5/0/10,70/10/10/10,40/10/25/25` to run k1 again). They match the
"core draws" rows of `tools/sim/README.md` (2026-10-24) to the decimal:

| Mix                    | Art correct          | Singles 24 / 72 / 168 h | Bricks placed | Discards all / casual |
| ---------------------- | -------------------- | ----------------------- | ------------- | --------------------- |
| Default (10% griefers) | 100.0%, 30/30 intact | 24.3% / 41.3% / 55.1%   | 61.5k         | 47.9% / 7.9%          |
| 30% griefers           | 72.3% (71.6–73.0)    | 20.4% / 40.9% / 55.7%   | 62.2k         | 27.6% / 8.6%          |

Unusable draws: 7.6% over a week at the default mix and 8.2% at 30% griefers (the README's
measurement on the same code; the CLI summary does not print it). The figures this ADR was
written with (56% singles, about 10% unusable, 71% art at 30% griefers) predate the sim's
move to the core's draw; the decision stands on either.

## Consequences

- About 8% of draws are unusable over a week (7.6% in the sim), mostly single bricks after the
  first day.
- The rates are a starting point: real player numbers replace the sim's assumptions, and
  admins change the rates without a deploy (versioned config, `effectiveAt`).
