# 0030. Live counts and drop rates on the game screen

- Status: accepted
- Date: 2026-10-25
- Relates to: 0010 (phases), 0011 (drop rates), 0020 (teams), 0025 (ops events, no ids),
  0026 (one playing socket per account), 0028 (shards and their watchdog)

## Context

The owner approved a game screen that shows how many people are playing now, how many of the
player's team are online, and what the next item is likely to be: the current phase, how full
the open area is, and the drop rates of each phase (design artifact, version 22). None of it
reached the client: phase and rates lived only in CanvasDO, and nothing counted players across
FanoutDO shards.

Two constraints shape it. Spectators read the map from the CDN without a socket (ADR 0009), and
a player zoomed out hands its socket back, so a socket-only channel would leave most pages
without numbers. And counting must not cost a call per page: a canvas is one Durable Object.

## Decision

- **Counting.** Each FanoutDO shard already calls `cursor()` on its canvas every 30 s while it
  has sockets (the tick watchdog, ADR 0028). The call now carries the shard's counts: playing
  sockets (sockets with a player; one per account, ADR 0026) and those per team id. CanvasDO
  keeps the last report of each shard in memory and sums the ones younger than 75 s
  (`workers/game/src/presence.ts`). "Playing" therefore means signed in with a socket open;
  spectators are not counted, and the screen says "playing now", not "online".
- **Team count.** The `cursor()` answer carries the canvas-wide total and the totals of the
  teams the shard named. The shard sends every socket a new server frame, Stats (opcode 0x86:
  `[playing u32][team u32, 0xffffffff = none]`), with its own team's total, after each
  watchdog call and on join. Only members of a team learn its count. Older clients skip the
  opcode; no protocol version bump.
- **Canvas stats for every page.** `GET /api/stats` (gateway) answers
  `{playing, phase, filled, rates}` for the current canvas: `filled` is the percent of the open
  area no brick can reach (what sets the phase, ADR 0010), `rates` the item config in force,
  per phase. The gateway binds FanoutDO only, so shard 0 of the canvas passes the call on
  (`FanoutDO.stats()` → `CanvasDO.stats()`). Public, edge-cached 15 s; clients poll once a
  minute while visible.
- **Counts only.** No player id leaves a shard for this; the canvas holds integers per shard
  and team, in memory. A restarted canvas or an evicted shard counts again within one watchdog
  interval.

## Consequences

- Numbers lag by up to about a minute and a half for a page without a socket (a 30 s
  watchdog, the 15 s cache and the 60 s poll); a playing socket's own frames lag 30 s at most.
- The rates shown are nominal: a brick with nowhere to go becomes a shield and a single brick
  with no hole a brick (ADR 0005, 0010), so actual draws drift toward shields late in a season.
- Deploy order is free: a canvas that predates the report ignores it (no totals, no Stats
  frames), a shard that predates it sends none, and `/api/stats` answers 503 until both the
  game and realtime scripts have it.
- The canvas gets one more RPC per stats cache miss: at most 4 a minute in each colo, each
  through shard 0. The watchdog calls were already there.
- Every poll runs the gateway Worker: the edge cache spares the canvas, not the Worker, so
  spectators now cost one Worker request a minute each, against ADR 0009's aim of none (about
  1,700 requests per second at 100,000 open pages). Before a large public season the canvas
  should publish a small stats file to the public bucket next to the manifest, read from the
  CDN like the tiles, and pages without a socket should read that instead.
