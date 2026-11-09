# 0028. Diff ticks to FanoutDO shards and per-tile views

- Status: proposed
- Date: 2026-10-25

## Context

Until now each canvas had one FanoutDO (`fanout-0`). It relayed its sockets' ops to CanvasDO
and broadcast each op's diffs from the reply, one frame per op to every socket. A second
FanoutDO would not have worked: it never heard of the first one's ops. One object holds at
most 32,768 sockets, and the design doc (tab "Scale triệu CCU") plans about 2,000 per
FanoutDO, each getting the whole map's stream and filtering it per tile; ADR 0003 already
says "only outbound diffs are batched per 250 ms tick". Measured before this change (cost
model over `workers/realtime/src/views.ts`, on the 2048² map of the time, 1920x1080 views at
zoom 4, ops spread over the open area): every op costs one send per socket (2,000 sends per op
at 2,000 sockets). The map now launches at 1024² (ADR 0027): 16 tiles instead of 64, so a
view covers a larger share of the map and filtering saves less there than these numbers show,
until the map grows.

## Decision

**Ticks.** CanvasDO cuts the cells changed since its last tick into one tick every 250 ms
(at most every 250 ms since the 2026-10-27 amendment under Consequences;
`workers/game/src/push.ts`) and pushes every FanoutDO shard that follows it one push from
that shard's own cursor: `{from, to, records, rules}`, records at their values at `to`. End
values make pushes idempotent, so the shard compares them with its mirror and sends only what
its sockets lack (its own ops' replies still go out at once). Pushes run beside the op queue:
one in flight per shard, 32 in all, each given up after 10 s; a failing shard backs off (0.5 s
doubling to 30 s), keeps its cursor and is caught up in one push; the others are not held up,
and each pump starts at the next shard. A bounded ring of recent ticks (sorted cell indices
only, at most 2M cells and 2,400 ticks) serves lagging shards: cursors are rounded down to the
start of their tick so shards share records, merged without sets, at most 16 MiB of records
built per pump (the rest wait 250 ms). Past the ring, or past a tick of more than 262,144
cells, the push carries no records and the shard resyncs from a snapshot; at most 4 such
pushes are out at once (pushes to unknown cursors count too), and at most 64 MiB of records
await answers, so a huge tick never makes every shard copy the grid together.

**Cursors.** Per shard the canvas keeps `acked`, a seq its open sockets are known to have,
raised only by the shard's own answers to pushes, and `floor`, the seq of its last snapshot.
A shard follows with `CanvasDO.follow(name, since, sockets)`, which returns its snapshot plus
the cells its open sockets missed (since a tick's known cursor, the behind marker, or the
canvas's `acked`). The reply may be lost, so follow() never sets `acked` to the snapshot's seq
while the shard has open sockets: it keeps the seq it brought them from, or none when it could
not say (`changes: null`; the shard then closes its open sockets with 1012). A push to an
unknown cursor starts at `floor` (or the ring's start) and says `known: false`: a shard with a
mirror takes it (end values), one without follows again from nothing it could misread. Names
and `acked` are stored (one row per shard, saved at follow and every maintenance pass), so a
restarted canvas pushes again, its ring seeded from the log rows after its checkpoint. A shard
that keeps failing is tried hourly after a day, never forgotten: only its own "no sockets"
answer drops it. follow() is refused past 16 a second (each answer copies the grid).

**Watchdog.** A following shard relies on the pushes. If they stop while the map changes (a
game script rolled back to one without ticks, a canvas that lost the shard), nothing else
brings its sockets the other shards' changes, so the shard checks: after a gap in its replies,
in its behind check, on a join after a quiet spell, and from an alarm every 30 s while sockets
are open (an alarm, not a timer, so a quiet shard still hibernates), it asks
`CanvasDO.cursor(name)` (no grid copy) whether it is followed and how far the log is. Not
followed, or ahead with no tick for 3 s: it follows again (`fanout_refollow`) and sends its
sockets every cell that differs from its old mirror. When the canvas says its pushes to the
shard are failing (`backingOff`), the shard leaves the canvas's own retries (backing off up
to 30 s) 33 s before following again, so the two never race to copy the grid. More than
262,144 changed cells (the canvas's tick cap) are not sent as records: the shard closes its
sockets with 1012 instead (`fanout_stale_closed`), and they reconnect for the grid. A game
script without `cursor()` (rolled back to one from before this ADR), or a canvas whose
`cursor()` says it cannot register the shard (`registrable: false`: no FANOUT binding, or all
256 slots taken): the watchdog neither loads a hibernated shard's mirror, nor follows again,
nor closes sockets, and the old rules apply (a gap in the replies resyncs, a woken shard
that is not followed trusts its marker alone). A mirror that still counted on pushes catches
up once from a snapshot, without closing anything. Cost: one alarm and
one `cursor()` call per shard every 30 s while sockets are open, about 5,760 requests a day
per shard (2,880 calls to the canvas, 2,880 alarms), none while a shard has no sockets.

**Shards.** The gateway's `FANOUT_SHARDS` (1 to 64, default 1: nothing changes until the owner
sets it) spreads sockets by player (all of a player's sockets on one shard, so holds reach
them) and watchers by connection id. Shard 0 keeps the old name. Kicks, from the gateway and
the admin Worker, go to all 64 shards there may be, so a socket left on a shard after the
count changed is still reached (64 calls per kick; kicks are rare).

**Views.** One view frame serves both this ADR and the abuse work's bot signal (ADR 0026, lane
A): opcode 0x06 with the cells the page shows. This ADR appends a flags byte whose bit 0,
`subscribe`, asks for per-tile diffs; a frame without it (the bot signal's 10 bytes) narrows
nothing and is only kept on the socket. A client whose config frame says `views` (a feature
byte appended after the locks) sends subscribing views at most twice a second. Its socket then
gets diffs only for the tiles `viewTiles` names: those the cells touch plus one tile around,
computed the same way on both sides (protocol). A tick's records are grouped by tile once;
frames are shared between sockets that see the same changed tiles (up to 32 MiB of shared
frames per tick, then built per socket) and split at `MAX_DIFFS_PER_FRAME`, all full but the
last. A tile newly followed comes first as a Tile frame (0x85, sparse or dense, whichever is
smaller) at the seq the diffs continue from. FanoutDO applies a view at most every 250 ms per
socket (the latest one waits), holds Tile frames to a 4 MiB burst and 1 MiB/s per socket and a
64 MiB burst and 16 MiB/s per object, and keeps the subscription in the socket's attachment as
`tiles` (the bot signal keeps `view`). Tiles no longer followed keep the seq
they were left at in the client, and the CDN handover (ADR 0018) adopts each tile at its own
seq. Clients that never subscribe, the bot signal's included, get every tile.

## Consequences

- Sends per op drop from one per socket to at most one per socket per tick for the sockets
  whose tiles changed: 2,000 → 40 at 200 ops/s, 2,000 → 8 at 1,000 ops/s; building the filtered
  frames costs about 0.7-1.2 ms of CPU per tick at 2,000 sockets (cost model). Locally, 100
  watchers and 36 bricks/s: about 54 KB/min per socket that views the busy tile, 0 for one that
  does not, 64.5 KB/min before (`tools/loadtest/README.md`).
- Players on another shard than the op's see it after the tick: locally p50 125 ms, p95 255 ms
  with 4 shards, against 4 / 19 ms on one shard (which still gets every op from the reply).
  Within the p50 ≤ 300 ms target; a shorter tick trades it for more pushes into the canvas.
  Amended 2026-10-27 (owner's choice over a 100 ms tick): a change with no pump in the 250 ms
  before it is cut at once; the rest wait for the next tick, up to 250 ms. On a quiet map other
  shards' players see a move about as soon as the op's own shard does; on a busier one most
  changes still wait, somewhat less on average. The peak stays at most one tick per 250 ms (4
  pushes/s per shard, as below), but a burst after a quiet spell costs one more tick than
  before, so on a sparse map pushes can rise by up to 2x on average. The figures above predate
  this and were not measured again.
- Memory (a Durable Object has 128 MB), on the 1024² launch map (ADR 0027; 4×4 tiles), with
  2048² (8×8 tiles), the largest a later season may grow to, in brackets. Per shard: the
  mirror, 2 MiB [8 MiB]; the grid frames cache for joins (6 bytes per non-empty cell), up to
  6 MiB on a full map [24 MiB]; one Tile frame per tile at most, 16 × 128 KiB = 2 MiB
  [64 × 128 KiB = 8 MiB], dropped on every change; a tick's grouped records and shared
  frames while it is sent (a push is at most 1.5 MiB of records unless resyncing; shared
  frames at most 32 MiB, transient); a follow reply, the grid plus the changes (6 bytes a
  cell, at most every cell, and at most the ring's 2M), up to 2 + 6 MiB [8 + 12 MiB],
  transient; a resync after a re-follow builds at most 262,144 records (1.5 MiB; a quarter of
  the 1024² map [a sixteenth of 2048²], then it closes the sockets instead) plus their frames
  (shared, within the 32 MiB). Everything at once, about 53 MiB [about 95 MiB]; typical
  5-10 MiB [20-30 MiB]. The transient parts (shared frames, a follow reply) rarely coincide,
  and the 32 MiB of shared frames is the largest either way. Per socket a tile mask (2 bytes
  at 16 tiles [8 at 64]), the tiles
  still owed (at most 16 numbers [64], also kept in the socket's attachment so an eviction
  does not lose them) and a few numbers: 2,000 sockets cost well under 1 MiB. Per canvas the
  ring (at most 2M cell indices, 8 MiB, at any map size: twice the 1024² map's cells, half of
  2048²'s), the records one pump builds (16 MiB, the first push excepted) and those in flight
  (64 MiB, the first push excepted; structured-cloned per RPC), and one row and a few numbers
  per shard.
- Convergence is checked by a seeded fault-injection test over the real CanvasDO and FanoutDO
  (`workers/realtime/test/convergence.test.ts`), in three mixes. `push`: three shards, random
  ops and ticks, pushes dropped, lost, doubled, delayed or timed out; no socket may close.
  `full`: the same plus lost follow() replies, shard evictions, canvas restarts with and
  without saved cursors, a canvas forgetting a shard and oversized ticks. `rollback`: one
  shard, the `full` faults plus a game script without follow() for a while. Afterwards every
  open socket shows the canvas's grid in the tiles it follows; a socket may have closed (1012)
  only if it was open when its shard was evicted and, before the shard loaded again, the
  canvas could not say what it missed (cursor unknown or behind the ring after a restart,
  forget() or an oversized tick, or a follow() reply that may have been lost), and the share
  of sockets closed over all seeds stays under a baseline. 200 seeds
  of each mix pass; the kept seeds failed with the cursor or watchdog fix out.
- Every push is an RPC out of CanvasDO: 4 per second per shard while the map changes. At the
  design doc's 250 shards that is the 1,000 requests/s a single object should not exceed, which
  is where the Merger layer of the design doc comes in. Shards never sleep while the map changes.
- Deploy order stays game, then realtime, then gateway. The game script now binds the realtime
  script's FanoutDO (`script_name`), so each script binds the other's class; neither declares
  it and no `migrations` change. Not yet checked on a real deploy: watch the first staging one.
  Staging: both scripts exist, so the cycle should upload as is, and no staged rollout is
  needed (`FANOUT_SHARDS` stays 1 until set, below). Production has never been deployed (no
  deployed tags, placeholder ids in its `wrangler.jsonc`): its first deploy is the bootstrap
  case, so follow the steps below there. If an upload of the game script is refused because
  of the FANOUT binding (a fresh environment, or Cloudflare checking `script_name` against a
  script that is not there): remove the FANOUT
  entry from that environment's `durable_objects.bindings` in `workers/game/wrangler.jsonc` in
  a branch, run the deploy workflow for that environment (game ships without pushes; FanoutDOs
  fall back to snapshots), let realtime ship in the same run, then restore the entry and run
  the workflow again. Without the binding no shard can follow: `cursor()` says the canvas
  cannot register shards, the watchdog does nothing and the rules from before this ADR apply
  (gaps in a shard's replies resync from snapshots, a woken shard trusts its marker). That is
  only safe with every op going through one shard, so `FANOUT_SHARDS` must be 1 for as long
  as the binding is missing (as for a rollback, below).
  Until realtime ships, no FanoutDO calls `follow`, so no shard is registered and nothing is
  pushed; an old FanoutDO meeting a pushed tick fails it and is retried with backoff
  (`canvas_push_failed`).
- Rollback of the game script to a version from before this ADR: set `FANOUT_SHARDS` to 1
  first and deploy the gateway, then make sure no socket is left on another shard (a realtime
  deploy reconnects every socket, which then lands on shard 0), then roll the game back. With
  one shard every op goes
  through it, so the old rules (gaps in its replies, the marker) keep its sockets right; the
  watchdog sees no `cursor()` and does nothing. Several shards against such a game script are
  not supported: nothing would push one shard's ops to the others, and a shard woken after an
  eviction could not tell what its sockets missed. When the game is deployed again, the
  watchdog finds `cursor()` back and follows again; `FANOUT_SHARDS` can then go back up.
- Set `FANOUT_SHARDS` above 1 only once every realtime instance runs this version (gradual
  deployments finished): an old FanoutDO on shard 1 would never hear of shard 0's ops.
- Abuse limits that a FanoutDO keeps per address or per account (lane A, ADR 0026) become per
  shard: with N shards a watcher's address could open N times as many sockets. Players are
  pinned to one shard by account (`shardOf(player)`), so one playing socket per account and
  the per-account limits hold; per-address ones are N× weaker. An account's bot signals and
  Turnstile challenge live on its shard: the gateway lifts a challenge there, and the admin
  area merges the suspects of all 64 possible shards. After `FANOUT_SHARDS` changes, an
  account's old signals and pending challenge stay on its previous shard until they expire.
- A canvas restart while a shard is evicted closes that shard's sockets only when the shard's
  saved cursor is older than the canvas's checkpoint (the ring cannot reach it); otherwise the
  saved cursor repairs them.
- Out of scope: the per-client budget that stretches the tick for a client over 250 KB/min,
  overview images for zoomed-out players, and the Merger tier.
