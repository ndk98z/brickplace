# Bots

Bots that play a running game over WebSocket, as players would: on local dev (`pnpm dev`), or
on staging behind the gateway's `BOT_KEY` (ADR 0034). The server draws every item, checks every
cooldown and judges every op; the bots only aim. Never production: the gateway takes the bot key
on staging only.

```sh
# Local: pnpm dev in another terminal (stop it afterwards); no key needed.
pnpm --filter @brickplace/bots start --bots 20 --minutes 5

# Staging: the key from docs/ops/setup.md, step 8, and staging's Access service token.
BOT_KEY=$(cat ~/.brickplace-bot-key) \
CF_ACCESS_CLIENT_ID=$(cat ~/.brickplace-access-id) \
CF_ACCESS_CLIENT_SECRET=$(cat ~/.brickplace-access-secret) \
pnpm --filter @brickplace/bots start \
  --url wss://staging.brickplace.app/ws --bots 200 --minutes 60
```

Staging sits behind Cloudflare Access, invited testers only (ADR 0045, amended 2026-11-11).
Bots get through with its service token: `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
(both or neither, `wss://` only) go on the map socket, every bot's socket and `/api/me`, never
on the CDN, which stays public. Without them every staging request ends at Access's login
page: the run waits for a map that never comes and stops after a minute.

`--help` lists every option. Ctrl-C stops the run cleanly and prints the summary.

## Players

Four kinds, after `tools/sim` (default mix `--mix 40/40/10/10`):
- **builder**: draws an artwork. Bricks in the colour most of their cells want, single bricks in
  holes, hammers on wrong cells, shields on right ones.
- **casual**: fills room near a home spot in colours it likes, and moves on when the spot is full.
- **griefer**: spoils an artwork: wrong colours, hammers on right cells, shields on the damage.
- **repairer**: mends the most damaged artwork, like a builder.

Without `--image`, builders draw `--arts` random artworks (6 of 32² by default) placed in the
open area.

## Measuring a shard

Every bot is a player socket on its account's FanoutDO shard. Staging runs three shards
(`FANOUT_SHARDS` 3 since 2026-11-02), so a run spreads its bots over three FanoutDOs by
account: read each shard's numbers (the GraphQL Durable Objects analytics split them by
`objectId`), about a third of the bots each. Before that it ran one, which is what
PROGRESS.md's earlier runs measured.
- Raise the players-at-once cap in the admin area at least 5% above `--bots` plus `--spare`
  before a large run (5,000 by default, ADR 0039). Each shard takes `ceil(cap / 3)`, and
  accounts do not split exactly evenly, so the fullest shard refuses joins first: bots
  `bot-0` to `bot-4949` split 1,671 / 1,639 / 1,640, past 1,667 on the first.
- `--rate` sets how many bots join per second: 5,000 bots at the default 4 take 21 minutes to
  join; `--rate 25` takes about 3 and a half.
- A realtime deploy during the run (Actions → Deploy, env `staging`, realtime ticked) drops
  every socket: the next status line's joins are the reconnects, resumed or whole.
- Watch each shard's CPU and memory in the Cloudflare dashboard (the staging realtime Worker's
  metrics and logs) and the minutely `fanout_joins` event while it runs.

```sh
# Every bot draws the lotus (builders and repairers only), in an empty corner of the open area.
BOT_KEY=$(cat ~/.brickplace-bot-key) pnpm --filter @brickplace/bots start \
  --url wss://staging.brickplace.app/ws \
  --bots 2000 --rate 25 --mix 90/0/0/10 --image examples/lotus-64x48.png --width 192 \
  --at 576,600 --minutes 30 --every 15
```

## Drawing an image

```sh
pnpm --filter @brickplace/bots start --mix 100/0/0/0 --image logo.png --at 300,300 --width 64
```

`examples/lotus-64x48.png` is a lotus on water, sized for a large run: `--width 192` makes it
192×144 cells (27,648 to fill), e.g. `--at 576,600` in the launch map's open area.
`examples/sun-bp-48x32.png` is a picture to try it with: 48×32 cells (1,536 to fill) in exact
palette colours on a solid background, a smiling sun, "BP", a heart and grass. The path is
read from where pnpm runs the script, the package's directory:
`--image examples/sun-bp-48x32.png`.
- The PNG must be 8-bit and not interlaced (what editors export by default). Each pixel becomes
  the nearest of the 32 brick colours; pixels under half opaque are left alone.
- `--at X,Y` is the image's top-left cell (default: centred in the open area); `--width N`
  scales it to N cells wide, nearest pixel (default: one cell per pixel). Inside the open area
  only: the rest cannot be drawn until the area grows.
- Builders place only bricks whose four cells all want the brick's colour, until three quarters
  of the picture are drawn. The cells left then sit where colours meet, where no brick fits
  exactly: builders accept one cell off, hammer it later, and the walled-in cell takes a single
  brick of the right colour. Those last cells are slow, because hammers and single bricks are
  rare draws while the map is young (ADR 0011).
- A brick may spill past the picture's edge or into transparent pixels, never onto a cell of
  another colour. Give the picture a background colour for a clean edge.
- Rough pace: a bot gets one item a minute, mostly bricks of four cells, so 200 builders fill
  up to about 600 cells a minute while there is room. Locally, 80 builders drew a 40×24 picture
  (960 cells) to 85% in four minutes and 88% in eight.

## How a bot behaves

- One socket per bot, with a connection id kept across reconnects (ADR 0017) and new each run,
  like the opIds (the seed only aims). Staging: `?bot=<n>` and `Authorization: Bearer <key>`,
  over `wss://` only; local dev: `?player=bot-<n>` (a dev id).
- It reports the cells it works on as a View frame before its first move and whenever they
  change, and never acts outside them: an op outside the view is a bot signal (ADR 0026).
- After an item arrives, and after each move, it waits 3 to 40 s, like a person; one op at a
  time. When the hold is full and nothing is useful, it throws the oldest item away.
- `unavailable`, or no ack in 20 s: sent again once with the same opId, after a pause.
  Refusals in a row wait 2, 4, 8 s... up to a minute. `limited`: hammers and shields wait 10
  minutes. `read_only` or `ended`: it looks again a minute later.
- After an hour its next op comes back `signed_out` and the socket closes (4401): it reconnects
  at once, which checks the key again. Other drops reconnect with the browser client's backoff
  (the first retry after 1 to 5 s, then 2, 4, 8, 15 s, ADR 0040), which starts over only once
  a socket stayed up 5 s.
- Like a page, a bot's later sockets ask to resume (ADR 0040): `?since=` the seq of the last
  map frames its previous socket delivered, and `?canvas=` the season's canvas from `/api/me`.
  The server then sends only the cells changed since, not the whole map. A bot's first socket
  resumes too when `/api/me` names a CDN (`tilesUrl`, the gateway's `TILES_ORIGIN`): like a
  page about to play, the bot first reads the manifest and every tile and segment it lists (3 s
  at most, else the socket brings the whole map), then opens with `?since=` the manifest's seq.
  Each bot reads the manifest; each tile and segment is fetched once a run, since they never
  change under their keys and the bots keep no copy (their map is the Eye's), so the run does
  not load the CDN as 2,000 pages would. The summary's `cdn:` line counts maps loaded and
  fallbacks. `--no-cdn` gives first sockets the whole map, as before;
  `--whole-map` turns resuming off altogether, to compare with pages from before. Challenged (4428): that number is out
  for 7 days and a spare number (`--spare`) takes its place. Another socket playing the same
  number (4409, a second run?): it stops.
- Bots are players, so they count against the players-at-once cap (ADR 0039; 5,000 unless the
  admin area says otherwise). On a full map a join closes with 4503, and a bot idle 10 minutes
  can lose its place (4408); both are plain drops here, retried with the backoff above. Raise
  the cap on staging before a run larger than it.
- No hold within a minute of joining means the gateway lets it only watch (no key, a wrong
  one, a gateway without ADR 0034, or a kick): it stops and says so; when no bot can play,
  the run ends.
- One extra socket only watches, to keep the map the bots aim with (`src/eye.ts`). The bots'
  own sockets subscribe to their view's tiles when the server offers it (ADR 0028).

## Reading the output

A status line every `--every` seconds: ops sent, accepted and refused (top reasons), items
thrown away, each artwork's share of cells in its target colour, and the joins since the last
line. The summary adds socket close codes, bots gone and every join of the run, split into
first maps, resumed reconnects and whole-map reconnects. For each: how many, how long until the
map and rules were in (p50, p95, max; a reconnect is timed from the drop, so it includes the
backoff and any refused tries) and the bytes before the config frame (the map, or the changes). A few `occupied` refusals are normal (two bots, one spot); many
`limited` mean staging's `abuse-policy` holds hammers and shields back (the `unscored` tier,
ADR 0034).
