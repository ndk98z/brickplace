# 0005. Single brick: a one-cell repair item

- Status: accepted
- Date: 2026-10-23

## Context

A hammer clears one cell, but a brick needs four empty cells in a brick shape. A hole
inside a drawing therefore can never be refilled without clearing three more cells, and
late in a season (55% hammers in the saturated phase) maps fill with permanent holes.
A free one-cell item would fix that but turn the game into r/place, where art is painted
pixel by pixel.

## Decision

Add a fourth item, the **single brick** (UI name "Single brick"):
- It fills exactly one empty cell with one of the 32 colours. No rotation.
- It may only be placed in an empty cell that **no brick placement can cover**: none of the
  76 placements (19 orientations × 4 cells) that include the cell are fully empty and
  inside the open area. Otherwise the op is rejected and the item refunded.
- The cell is its own piece: no link bits to its neighbours, even of the same colour.
- It never paints over a filled cell.
- Anti-stuck: a drawn single brick becomes a brick when the open area has no such hole.

Starting drop rates (admin-configurable per phase), to be tuned by a season simulation:

| Phase              | Brick | Single brick | Hammer | Shield | Share of filled cells from singles |
| ------------------ | ----- | ------------ | ------ | ------ | ---------------------------------- |
| Settling (<60%)    | 75%   | 5%           | 10%    | 10%    | ~2%                                |
| Contested (60–85%) | 55%   | 10%          | 22%    | 13%    | ~4%                                |
| Saturated (>85%)   | 32%   | 18%          | 40%    | 10%    | ~12%                               |

## Consequences

- Repairs become possible, and late-season damage slows (hammers 55% → 40%), while bricks
  still fill over 88% of cells, so the game keeps its identity.
- The core needs a per-cell "can any brick cover this?" check; it reuses the valid-placement
  counters, so it stays O(76) per op.
- Protocol v1 gains an opcode for the item; golden fixtures must cover accepted and refused
  single bricks.
- The rates are a hypothesis. `tools/sim` should measure holes remaining, share of cells
  from singles, fill speed and art survival over a simulated season before launch.
