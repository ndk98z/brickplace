---

name: promo-video
description: Record a promo clip (MP4 + GIF) of a simulated crowd playing BrickPlace on local dev, for Reddit posts, social media or the landing page. Use when asked for a gameplay video, GIF, trailer or demo footage.
---

# Promo video

The tooling is in `tools/video/` (its README lists every option). Bots are dev players on the
real Workers and client, the cooldown is shortened and the clip sped up, so the footage is a
simulation and must be labelled as one wherever it is posted.
1. Start `pnpm dev` and wait for `Ready on http://localhost:8787`. Only then start
   `pnpm dev:admin` (both at once fail on a locked SQLite database). Run both in the
   background with output to the scratchpad.
2. Pick an empty patch: 120×80 cells inside the open area (cells 256 to 767 on a fresh
   canvas). The local map keeps what earlier runs built, so move `X0`/`Y0` off old patches.
3. Run `X0=… Y0=… OUT=<scratchpad>/video NODE_PATH="$(npm root -g)" node
   tools/video/record.mjs` in the background or with a timeout of at least 600000 ms (it takes
   about two minutes). It stops the crowd and puts the previous item config back when it ends,
   on an error, Ctrl-C or SIGTERM too. A SIGKILL skips that (the bots then play on until
   their DURATION runs out, about two minutes), so check
   `curl -s localhost:8788/api/config` shows the cooldown it had before (60000 by default).
4. Read `last-frame.png` in `OUT` before sending anything: the sign must read BRICK PLACE,
   the "playing now" pill must show the crowd, and the item column must read "You're watching"
   (the page films as a signed-out visitor, never as a dev guest holding items). The crowd
   logs refusals every 5 s; many `out_of_area` mean the patch is off the open area. To compare
   moments, pull frames from the raw `.webm` with ffmpeg into a contact sheet.
5. Send the MP4 (sites compress it less than the GIF) with a caption such as
   "Simulation: 300 bots, shortened cooldown, sped up 6×". Never present it as real players.
6. Stop both dev servers and say so in the report.

Changing the scene (artworks, colours, how bots play) is an edit to `tools/video/crowd.ts`;
keep its `W`/`H` in step with the camera maths in `record.mjs`.
