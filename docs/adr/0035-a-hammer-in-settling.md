# 0035. One percent of hammers while settling

- Status: accepted
- Date: 2026-10-26
- Amends: 0011 (settling rates)

## Context

ADR 0011's starting rates give no hammer at all while a canvas is settling (less than 60% of
the open area out of brick reach), so for the first part of a season nothing a player draws can
take a brick back out. The owner asked for hammers to exist from the start, at 1%.

## Decision

The default settling rates (brick / single brick / hammer / shield) become **84 / 5 / 1 / 10**,
in place of 85 / 5 / 0 / 10. The hammer's point comes from bricks, so the set still sums to 100
and every weight reads as a percent. Contested and saturated rates are unchanged.

| Phase     | Brick | Single brick | Hammer | Shield |
| --------- | ----- | ------------ | ------ | ------ |
| Settling  | 84    | 5            | 1      | 10     |
| Contested | 70    | 10           | 10     | 10     |
| Saturated | 40    | 10           | 25     | 25     |

The season sim with these defaults (`pnpm --filter @brickplace/sim sim --hours 168
[--mix 30/35/30/5] --seed N`, seeds 1–3, otherwise as in ADR 0011's "Current numbers"):

| Mix                    | Art correct          | Singles 24 / 72 / 168 h | Bricks placed | Discards all / casual |
| ---------------------- | -------------------- | ----------------------- | ------------- | --------------------- |
| Default (10% griefers) | 100.0%, 30/30 intact | 24.3% / 41.5% / 55.2%   | 61.6k         | 47.9% / 7.9%          |
| 30% griefers           | 71.1% (70.9–71.4)    | 20.4% / 40.9% / 55.7%   | 62.4k         | 27.7% / 8.7%          |

Against ADR 0011's k1 numbers, the default mix is unchanged and the 30%-griefer mix keeps about
one point less art (72.3% before). The sim leaves settling within its first hour (500 players on
a 512² map), so this measures little: on a real launch with fewer players settling lasts longer,
and the hammer weight matters more there than here.

## Consequences

- Only canvases without a stored item config get the new default: new canvases, and canvases
  stored before items existed, which pin today's defaults the next time their object starts
  (old dev and staging canvases at most). A canvas that has its config keeps it, and admins can
  still set any rates on a running season (ADR 0011).
- No op-log semantics change, so the golden fixtures and their hashes stay as they are.
- A griefer who joins early can now remove a brick about once every hundred draws instead of
  waiting for the contested phase; shields (10%) still protect what players care about.
