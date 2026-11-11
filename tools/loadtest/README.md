# Load tests

k6 scripts. Install k6 separately (`brew install k6`). Point them at local dev (`pnpm dev`) or
at staging in an agreed window; never at production.
- `ws-smoke.js`: N virtual users each open a socket as a fresh dev identity, wait for the hold,
  discard its first item and wait for the ack (local dev only; every ack should be ok).
- `diff-latency.js`: senders place bricks, watchers spread over the FanoutDO shards measure how
  long each brick takes to reach them and the bytes of live frames each receives, with tile
  views (ADR 0028) or without.
- `reconnect-storm.js`: watchers and players connect, every socket drops at once, and every
  client reconnects with the browser client's own backoff and jitter (the first retry after 1
  to 5 s, then 2, 4, 8, 15 s, each × 0.5 to 1.5, and from the 8 s step after a 1013, ADR
  0040) and, like a page, asks to resume from
  the seq its last socket reached. Measures how long the crowd takes to get its map back, how
  many reconnects were resumed and their bytes, refused (503) and failed connects, and whether
  each player's first op after the reconnect is answered.

## Reconnect storm

```sh
pnpm dev   # another terminal; stop it afterwards
k6 run -e WS_URL=ws://localhost:8787/ws -e WATCHERS=800 -e PLAYERS=200 \
  tools/loadtest/reconnect-storm.js
```

Options (all `-e NAME=value`): `WATCHERS` (200), `PLAYERS` (50), `STORM_AT` seconds (20),
`DURATION` seconds (60), `ACK_TIMEOUT` seconds (10), `RESUME` (1: reconnect with `since` and
`canvas`; 0: ask for the whole map, as pages before ADR 0040), `CANVAS` (default: the season's,
read from `/api/me` next to `WS_URL`), `MODE`:
- `client` (default): every client closes its socket at `STORM_AT`, as if the server had
  dropped them all. Nothing to do on the server side.
- `server`: clients wait to be dropped. Trigger it during the run: locally, save any file under
  `workers/realtime/src` (wrangler dev reloads and closes every socket); on staging, a realtime
  deploy (Actions → Deploy, env `staging`, realtime ticked), which is exactly what a realtime
  release does to players.

Players use dev identities (`?player=`), which the gateway accepts only with
`ENVIRONMENT=dev`. On staging run watchers only (`PLAYERS=0`); for players there, use `tools/bots`,
which plays as staging's bots and prints the same reconnect numbers.

What to read in the summary:

| Metric                                  | Meaning                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reconnect_ready_ms`                    | Drop to the map and rules back (the config frame follows the grid or the changes). Its floor is the first backoff step, 1 to 5 s (1 to 1.3 s before ADR 0040).     |
| `reconnect_resumed`, `reconnect_kb`     | Share of reconnects the server resumed (a Resume frame first), and the bytes each received before the config frame: the whole map, or the changes since.           |
| `reconnect_open_ms`                     | Drop to the 101 of the new socket.                                                                                                                                 |
| `initial_ready_ms`                      | Start to the first map: the join storm when every client arrives at once.                                                                                          |
| `connect_refused`                       | Joins answered with a status other than 101, mostly FanoutDO's 503 when too many initial grids are queued (`fanout_join_refused` in the logs, docs/ops/alerts.md). |
| `connect_failed`                        | No HTTP answer at all (TCP reset, timeout).                                                                                                                        |
| `reconnected`                           | Share of clients that lost their map and got it back before the end (threshold 99%).                                                                               |
| `op_ack_ms`, `op_acked_after_reconnect` | Each player's first op after the reconnect (a hammer inside the open area): any verdict but `unavailable` counts as answered (threshold 99%).                      |
| `op_ack_unavailable`, `op_ack_timeout`  | Ops the canvas could not confirm, or that got no ack in `ACK_TIMEOUT`.                                                                                             |

### Local results (2026-10-25, 8-core arm64 Mac, k6 2.3, `pnpm dev`, near-empty map)

| Run                                   | Clients                   | `reconnect_ready_ms` p50 / p90 / p95 / p99 / max | Refused | Failed | Reconnected | Op acks after reconnect |
| ------------------------------------- | ------------------------- | ------------------------------------------------ | ------- | ------ | ----------- | ----------------------- |
| MODE=client, STORM_AT=8, DURATION=30  | 20 watchers, 10 players   | 1.15 / 1.26 / 1.28 / 1.29 / 1.29 s               | 0       | 0      | 30/30       | 10/10, p95 3 ms         |
| MODE=client, STORM_AT=20, DURATION=60 | 800 watchers, 200 players | 2.08 / 4.21 / 4.31 / 4.47 / 4.5 s                | 729     | 949    | 1000/1000   | 200/200, p95 34 ms      |

In the 1,000-client run the refusals are FanoutDO's join gate doing its job (503, retried after
the backoff); the failures are TCP resets from the local dev server's listener (macOS accepts
only so many connections at once), not from the Workers. The map was nearly empty, so initial
grids were tiny; late in a season a grid is up to about 6 MiB and the gate holds each join
longer. Staging numbers are the ones that matter for launch.

## Diff delivery

```sh
# another terminal; FANOUT_SHARDS spreads sockets over that many FanoutDOs (default 1)
pnpm dev   # or the same wrangler dev command with --var FANOUT_SHARDS:4; stop it afterwards
k6 run -e WATCHERS=100 -e SENDERS=10 -e DURATION=40 -e TILE=1,1 tools/loadtest/diff-latency.js

# staging, in an agreed window: senders play as staging's bots (ADR 0034), and every socket
# carries staging's Access service token (ADR 0045, amended)
k6 run -e WS_URL=wss://staging.brickplace.app/ws \
  -e BOT_KEY="$(cat ~/.brickplace-bot-key)" -e SENDERS=150 -e DURATION=60 -e TILE=2,1 \
  -e CF_ACCESS_CLIENT_ID="$(cat ~/.brickplace-access-id)" \
  -e CF_ACCESS_CLIENT_SECRET="$(cat ~/.brickplace-access-secret)" \
  tools/loadtest/diff-latency.js
```

Staging sits behind Cloudflare Access, so `diff-latency.js` and `reconnect-storm.js` take its
service token as `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (both or neither, `wss://`
only); without it every staging socket is refused. `ws-smoke.js` plays as dev identities and
is for local dev only.

Locally each brick is sent by a fresh dev identity. With `BOT_KEY` each sender is one staging
bot (numbers from `BOT_FIRST`, default 900000, clear of `tools/bots`' numbers) that keeps one
socket for the run, reports the target tile as its view and plays every brick its hold gets:
up to 3 at once, then about one a minute. So a staging run needs more senders for as many
bricks, and a refused brick (two senders in one slot) goes to a later slot.

Each brick lands in a 4x4 slot of the target tile that encodes when it was sent, so a watcher
on any shard reads the delay off the cells (±10 ms). Half the watchers view the target tile
and its neighbours (`near`), half the map corner farthest from it (`far`). `VIEWS=0` makes
them behave like clients from before views (every tile). Slots stay filled: give each run on
the same local map another `TILE` inside the open area a new canvas starts with (1 or 2 each
way on the 1024² launch map, 2 to 5 on a 2048² one with `MAP_SIZE=2048`). Most bricks are
refused `occupied` when two senders hit one slot; only placed bricks are measured. The
results below were measured on the 2048² map of the time (target tiles 2 to 4 a side).

| Metric                                 | Meaning                                                               |
| -------------------------------------- | --------------------------------------------------------------------- |
| `diff_latency_ms{group:near}`          | Brick sent to its cells seen by a watcher that views its tile.        |
| `live_kb_per_min{group:near / far}`    | Live frames (diffs and Tile frames after the grid) per watcher.       |
| `bricks_seen_by_far_watchers`          | Bricks a watcher whose view excludes the tile still saw: should be 0. |
| `bricks_placed`, `holds_without_brick` | Accepted bricks; senders whose one starting item was not a brick.     |

### Local results (2026-10-25, 8-core arm64 Mac, k6 2.3, 100 watchers, 10 senders, 40 s)

| Server                                | Bricks placed | Latency p50 / p95 / p99 / max | KB/min near | KB/min far |
| ------------------------------------- | ------------- | ----------------------------- | ----------- | ---------- |
| `main` before ADR 0028 (one FanoutDO) | 1,467         | 4 / 19 / 37 / 144 ms          | 64.5        | 64.5       |
| 1 shard, views                        | 1,556         | 4 / 14 / 21 / 39 ms           | 68.3        | 0          |
| 4 shards, views                       | 1,581         | 125 / 253 / 272 / 359 ms      | 54.0        | 0          |
| 4 shards, views (final frame, cells)  | 1,545         | 118 / 255 / 278 / 319 ms      | 52.6        | 0          |
| 4 shards, no views (`VIEWS=0`)        | 1,554         | 124 / 256 / 273 / 307 ms      | 53.1        | 53.1       |

The first three runs of this branch sent views as tile rectangles; the last one the final
frame (the cells shown with the `subscribe` flag, tiles followed with one around). With one
shard every watcher shares the senders' FanoutDO and gets each brick from the op's
reply at once, as before. With four, three quarters of the watchers get it with the canvas's
next 250 ms tick: the delay is the tick's wait (0 to 250 ms) plus a few ms. A tick merges
the ops of 250 ms into one frame per socket, so a socket that sees every tile receives fewer
bytes than one frame per op (53 against 64.5 KB/min at about 36 bricks/s); a watcher whose
view leaves out the busy tile receives none. Before ADR 0028 a second FanoutDO could not have
been used at all: it saw only its own players' ops.

The scale targets and what to measure are in the design doc ("Scale triệu CCU" tab): messages
per second into CanvasDO, apply p99, connections per FanoutDO, bytes per client.
