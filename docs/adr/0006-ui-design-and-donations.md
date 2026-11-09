# 0006. UI design, sponsors and donations

- Status: accepted
- Date: 2026-10-23

## Context

The owner reviewed a 12-screen design (a private canvas, not published with the code)
covering landing, sign-in, first-time guide, game, share snapshot, system states, ranking,
seasons, team, profile, contributors and sponsors, and admin.

## Decision

- All UI copy is English. Desktop first; pages still reflow at phone width.
- Look: bright "toy brick" style. Fredoka for display, Inter for UI, rounded cells with an
  inner shadow. No Tetris look (no bevelled blocks, no Guideline palette) and no studs.
- Client UI around the WebGL2 map is built with **Preact**.
- Game screen: the map is full-bleed under the header. One tool column on the **right**:
  hold (up to 3 items, countdown in the empty slot), rotate and discard, the 32-colour
  palette with each swatch **numbered 1–32**, then up to **5 sponsor logos** (one featured)
  and a **Donate** button. Coordinates, team, zoom, snapshot, report and the minimap sit
  on the left.
- Sign-in: Google, Reddit and Discord, plus Cloudflare Turnstile. Spectating needs no account.
- Ranking is by team only, on cells still standing; no per-player public leaderboard, since
  the map never shows who built what.
- Sponsors get a logo on the game screen and the sponsors page, never map cells or any say
  in the game.
- In-game donations go to **Ko-fi** (donors need no account; payouts through the owner's
  PayPal). **GitHub Sponsors** is used only on the repository (`.github/FUNDING.yml`),
  because it requires donors to have a GitHub account.

## Consequences

Provider logos must follow each provider's brand rules when implemented. The Ko-fi page
name and the PayPal payout from Vietnam are still to be set up and verified by the owner.
