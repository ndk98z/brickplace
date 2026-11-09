# 0039. A cap on how many play at once

- Status: accepted
- Date: 2026-10-27
- Relates to: 0009 (spectators read from the CDN), 0018 (who holds a socket), 0026 (one
  playing socket per account), 0028 (FanoutDO shards), 0030 (live counts), 0032 (busy),
  0033 (stats in the manifest), 0038 (settings from the admin area)

## Context

Until sponsors pay for it, the owner wants the running cost bounded (owner, 2026-10-27).
Watchers cost almost nothing: they read the map from the CDN with no Worker and no socket
(ADR 0009, 0033). What grows with load is the players: each holds a FanoutDO socket, and the
design doc's scale review puts sockets, their setups and their inbound messages at most of the
realtime cost (about USD 4.6k a month at 1M CCU, ADR 0009). Nothing bounds them today: a shard
logs `fanout_sockets_high` at 80% of the runtime's 32,768 sockets and still accepts, joins
are refused only by rate (429) or a full join gate (503), and CanvasDO sheds moves (ADR 0032),
not players. A page cannot read the HTTP status of a refused WebSocket upgrade (it sees 1006),
so a refusal the page must understand has to be a close code on an accepted socket.

Cloudflare has no hard spending cap; this bounds the part that grows with players. Billing
notifications on the account, the zone's rate limiting rules (ADR 0019) and the emergency
switches (ADR 0022) stay the other levers.

## Decision

- **What counts.** Playing sockets: those with a player (one per account, ADR 0026). Watching
  sockets, kicked players (who join as watchers) and CDN watchers do not.
- **Where it is set.** The owner sets the cap in the admin area: a whole number of players, or
  off. It is a site setting, not per season, in a new `site_settings` row of the accounts
  database (gateway migration 0008), written with an audit row like ADR 0038's links. With no
  row the cap is **5,000** (`DEFAULT_PLAYER_CAP`, owner's choice). Not a secret and not an
  abuse threshold: a capacity setting that ships in code and changes in the admin area.
- **Who enforces it.** The gateway reads the setting (cached per isolate for 30 s; on a failed
  read it keeps the last value, or the default) and passes each socket's shard its share,
  `ceil(cap / FANOUT_SHARDS)`, in a new `X-BrickPlace-Cap` header it sets and strips like the
  others. Players reach shards by account hash (ADR 0028), so shares fill evenly. FanoutDO
  tags every playing socket `*playing` beside its player id and counts that tag's sockets (no
  attachment is read) at a join, before the initial grid is queued and again in the serial
  step that accepts it:
  - lets in an account that already has a socket on the shard (a second page or a fast
    reconnect replaces it, ADR 0026), and any join while under the share;
  - when full, frees the seat of the socket idle longest, if it made no op or discard for
    **10 minutes** (`IDLE_YIELD_MS`), closing it with **4408** ("gave up its place"), and lets
    the newcomer in. A move's time is kept in memory; after a restart every socket counts as
    having just moved, so no one is pushed out on a guess. No timer: seats are freed only for
    someone waiting;
  - otherwise accepts the socket, sends nothing and closes it with **4503** ("map full").
    A sampled ops event `fanout_full` (canvas, playing, share; no ids) sits beside
    `fanout_sockets_high`. Lowering the cap closes no socket: it only stops new joins until the
    count falls under it.
- **Client.** The page learns the cap at load (`/api/me`'s `config.playerCap`) and the players
  from the manifest stats (ADR 0033). When `playing >= cap` it opens no socket and shows "The
  map is full" while it watches through the CDN. On 4503 it watches and shows the same. Either
  way it tries again after 45-90 s (jittered), and that retry opens a socket whatever the
  stats say: they count idle players too, and only a join makes FanoutDO free an idle
  player's place (owner's choice, 2026-10-27, over trying only every third retry or counting
  idle players in the stats). A page that stops wanting to play meanwhile (zoomed out) ends
  the wait; a hidden page keeps waiting and tries on the first retry after it is shown (it
  could otherwise take play from a page of the same account its player is looking at). On 4408 it
  watches and shows "You gave up your place after 10 minutes without a move" with a "Play
  again" button; it never rejoins by itself, so two pages do not take turns on a seat. Both
  codes keep the hold: the server keeps it, as for any socket that closes.
- **No protocol change.** Two close codes beside 4401/4403/4409/4428; no new frame, no
  `PROTOCOL_VERSION` bump.

## Consequences

- Socket count, setups and inbound messages are bounded by the cap, in steps of one setting.
  A refused join costs one accepted-and-closed socket, about two requests (gateway Worker and
  FanoutDO) and no grid. A waiting page tries every 45-90 s: 1,000 pages waiting around the
  clock come to about 15 tries a second, some USD 17 a month at list prices. Each try also
  counts against the per-account and per-address limits on socket opens (ADR 0026), far below
  them for one page.
- On a full map, a player who zooms out or hides the page for 60 s gives the socket back (ADR
  0018) and may not get it back. A network blip can lose a seat the same way. Accepted.
- A realtime deploy closes every socket at once. Players reconnect within 1-15 s, waiting pages
  try every 45-90 s, so players almost always get their seats back; nothing reserves them.
- An account with a socket still listed on the shard gets in (its new socket replaces the
  old one), even while that socket is closing after 4408 or 4409: a client that reconnects
  within the close handshake can go one over the share. Pages do not (they rejoin after 4408
  only when asked); a script could, by one, until its old socket is gone.
- Bots on staging (ADR 0034) are players and count against the cap.
- Per-shard shares are exact with one shard (the default). With several, a shard can turn a
  player away while another has room, by a few percent of the cap.
- Without a CDN (no public tiles domain, ADR 0018) a turned-away page has nothing to watch
  live: it shows the notice and retries. Watching sockets in that mode stay uncapped.
- Deploy order: a gateway without the header leaves the cap off (FanoutDO treats no header as
  no cap); a FanoutDO that predates it ignores the header. Pages open from before the client
  ships treat 4503 and 4408 as an ordinary close and reconnect on their backoff (up to 15 s)
  until reloaded.
- To watch: how often `fanout_full` fires, and whether 10 minutes frees seats fast enough.
