# 0002. Name, license and open-source timing

- Status: accepted (amended by 0046: public before season 1, and no rotation of Workers
  Secrets)
- Date: 2026-10-23

## Context

The working name was TetriPlace. The Tetris Company enforces "Tetris", "-tris" and similar
names and the game's look (for example Rockbox renamed "Tetrox"; Tetris Holding v. Xio,
D.N.J. 2012). The game is meant to be both a hosted service and open source, and its
anti-abuse logic must not be easy to study.

## Decision

- Name: **BrickPlace**. Never "Tetr-", "-tris", "-mino" or "tetromino"; pieces are bricks.
  No Tetris Guideline colours, ghost piece, next queue or 10×20 well.
- Code: **AGPL-3.0-or-later**; art and sound: CC BY-SA 4.0; name and logo reserved
  (TRADEMARKS.md, COPYING.md).
- Contributions: **DCO** sign-off, no CLA.
- Timing: develop privately; after season 1 launches, publish a fresh repository with a
  squashed history, after a gitleaks scan of the full history and rotating every key.
- Because AGPL covers everything compiled into a deployed Worker, abuse heuristics,
  thresholds and moderation lists live outside this repo (Secrets, KV/D1, a private ops
  repo, or a separate owner-only Worker).

## Consequences

Hosted forks must publish their changes. No closed relicensing later without every
contributor's consent. A trademark search and domain purchase are still to do.
