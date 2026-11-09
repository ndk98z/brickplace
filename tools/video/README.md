# Promo video

Films a simulated crowd playing on local dev, for posts and the landing page. Everything on
screen goes through the real Workers and client: bots are dev players (`?player=`, honoured only
with `ENVIRONMENT=dev`), the server draws their items and applies the rules. The cooldown is
shortened and the clip sped up, so label it as a simulation wherever it is posted (for example
"Simulation: 300 bots, shortened cooldown, sped up 6×").
- `crowd.ts`: N long-lived dev players on a 120×80 patch. Four in five build a few artworks
  (the BRICK PLACE sign, a heart, a smiley, a flag, a tree, a mushroom); the rest scatter
  bricks, hammer anything and sometimes run a brick through an artwork. Builders place where
  they leave the fewest holes no brick can fill, put singles in those holes, hammer stray
  bricks off their art (or off-art cells when there are none) and shield it. A refused move is
  tried elsewhere once, then discarded; a bot leaves on `signed_out`, `ended` or `read_only`.
  Bots do not reconnect: one closed by a resync (1012) is gone, which the `open=` log shows.
- `record.mjs`: sets the item config through the local admin API (10 s cooldown, hammers from
  the start, singles at 12%), runs the crowd, films the client with Playwright as a signed-out
  visitor (`?watch`, watching over its socket: local dev's tiles bucket is not where `/api/me`
  points watchers, so the page's `tilesUrl` is dropped), stops the crowd
  and puts the previous item config back (also on an error, Ctrl-C or SIGTERM), then cuts the
  play, speeds it up and writes `brickplace.mp4` and `brickplace.gif`.

Both refuse any host but localhost. Needs ffmpeg and a Playwright with Chromium installed on the
machine. Playwright is not a repo dependency: `record.mjs` loads it through `NODE_PATH`, which a
global npm install needs pointing at.

```sh
pnpm dev                       # terminal 1
pnpm dev:admin                 # terminal 2, once `pnpm dev` is ready (not both at once)
NODE_PATH="$(npm root -g)" node tools/video/record.mjs   # terminal 3, about two minutes
```

Stop both dev servers afterwards. Output goes to `$TMPDIR/brickplace-video` (`OUT` to change):
the MP4, the GIF, `last-frame.png` and the raw `.webm`. Post the MP4, which Reddit and most
sites compress less than a GIF.

Options (env): `PLAYERS` (300), `COOLDOWN` ms (10000), `WARMUP` s (28: the crowd is online but
only discards, so the "playing now" count is up before anything appears), `PLAY` s of play
filmed (80), `SPEED` (6), `ZOOM` (7), `X0`/`Y0` the patch corner (275/382; the whole patch must
sit in the open area, cells 256 to 767 on a fresh canvas, and on an empty spot, since the local
map keeps what earlier runs built), `SITE` (the crowd plays on its `/ws`) and `ADMIN` URLs.

The crowd runs on its own too (`pnpm exec tsx tools/video/crowd.ts`), with `WS_URL`,
`PLAYERS`, `X0`, `Y0`, `START_DELAY` and `DURATION`.
