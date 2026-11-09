# 0040. A socket resumes from the map the page holds

- Status: accepted
- Date: 2026-10-27
- Relates to: 0009 (spectators read from the CDN), 0014 (tiles and segments), 0018 (CDN
  handover in the client), 0028 (ticks, shards, the canvas's tick ring), 0039 (a cap on
  players)

## Context

Every socket starts with the whole map: FanoutDO sends its mirror as Diffs frames, up to
about 6 MiB on a full 1024² map. To keep a reconnect storm from making the runtime buffer one
grid per socket, a shard sends 8 grids at a time at about 8 MiB/s (`SendGate`), so late in a
season about ten sockets join per second. A realtime deploy closes every socket at once: 2,000
players on a shard take 3-4 minutes to be back, 5,000 about 8 (owner's question and an outside
review, 2026-10-27). Yet most of those pages still hold the map, a few seconds old: the
socket that closed kept it current, and the CDN feed carries it on (ADR 0018). A page that
watched before playing can load the rest from the CDN, where a read costs no Durable Object
time. The reconnect itself is barely spread: the first retry comes 1-1.3 s after the close.

## Decision

- **The page says what it holds.** When every tile of its store is held (a socket's grid, or
  CDN tiles) the page opens the socket with `?since=S&canvas=C`, S the lowest seq any tile is
  surely at (a CDN change still spreading does not count, ADR 0018) and C the season's canvas
  it shows (from `/api/me`; none while the gateway only guessed, or once the page learns of a
  new season). Otherwise it sends nothing and gets the whole map, as today. The gateway passes
  the query through; FanoutDO ignores a since for another canvas than its own.
- **FanoutDO keeps what changed.** Each mirror keeps, per step (an op's reply, a tick, a
  resync), every cell the step touched, a cell changed and changed back included (a tick's
  records name every cell its ticks touched), for at most 262,144 cells or 2,400 steps
  (`RESUME_CELLS`, about 1 MiB of indices). A resync knows only the cells that differ at its
  end, so its step is marked inexact: a page at a seq inside it cannot resume. A mirror loaded
  from `CanvasDO.follow()` is seeded with the canvas's own tick ring (ADR 0028, ten minutes
  there): `follow()` takes the most cells it may return and answers `recent: {from, ticks}`,
  its newest ticks up to the snapshot, each with its end seq and cells, kept as steps of their
  own. A resync with too many changes to list, or a mirror from `snapshot()` (a game script
  from before this), starts the list afresh.
- **Resume.** A socket with `since = S` such that the list reaches S, S is at most the mirror's
  seq M and not inside an inexact step, gets a **Resume** frame (new server opcode 0x87:
  `[from u32]`, the start of the step holding S), then every cell the steps after it touched,
  at their values at M, as Diffs frames at M (all full but the last, at least one), then the
  config, stats and hold frames as today. Past 131,072 listed cells (`RESUME_MAX_CELLS`,
  768 KiB of records, counted before merging so the work per join is bounded too), it gets the
  whole map. Sockets resuming from the same step share one set of frames (or the verdict that
  there are too many) until the mirror changes, at most 4 sets per seq. A minutely ops event
  `fanout_joins` counts resumed and whole-map joins.
- **The page applies it.** On a Resume frame the page copies its store off screen, applies the
  frames to the copy, and swaps it in at the end of the seq, as it does with a whole map
  (ADR 0018): the map never flashes, and the CDN keeps it current meanwhile. A Resume frame
  for a since the page did not send (or past it) cannot be applied: the page closes that
  socket, keeping moves in flight, and the next one asks for the whole map.
- **A player's page loads the map from the CDN first.** A page that is about to play and holds
  no full map runs the CDN feed over every tile (not only those in view) and opens the
  socket once every tile is held, or after 3 s (`BOOTSTRAP_MS`) without `since`. This replaces
  ADR 0018's "a player's page load reads nothing from the CDN". Without a CDN nothing changes.
- **Reconnects spread out.** The first retry after a close, or after a first open that failed,
  comes after 1 to 5 s (uniformly) instead of 1 to 1.3 s; later retries keep the backoff.
  Amended 2026-11-02, after a 4,900-socket shard was moved by Cloudflare and every socket
  came back at once (PROGRESS.md): later retries wait their step (2, 4, 8, 15 s) times 0.5 to
  1.5 instead of 1 to 1.3, so pages that failed together spread out; a close with 1013 (Try
  Again Later, Cloudflare's code for an overloaded object) jumps to the 8 s step (4-12 s).
  The first retry is unchanged. The bots (`tools/bots`) do the same.
- **Compatibility.** An older FanoutDO ignores `since` and sends the whole map without a
  Resume frame, which the page reads as today. An older page sends no `since`. No
  `PROTOCOL_VERSION` bump (appended opcode).

## Consequences

- A realtime deploy's reconnects cost each page the cells touched since the tick holding its
  seq: a few KB to a few hundred, sent in one step, instead of a 6 MiB grid queued 8 at a
  time. The same holds for the hourly session renewal and every drop. Not measured yet.
- A player's page load reads every tile from the CDN (16 at 1024², 64 at 2048²; free on cache
  hits, an R2 read on a miss) and its socket then sends only the seconds since the tiles were
  cut. A player sees the map from the CDN while the socket opens, up to 3 s later than today
  on a slow CDN.
- A shard's memory grows by the list (at most about 1 MiB) and the shared resume frames (at
  most 4 sets of 768 KiB, about 3 MiB, for the current seq, dropped when it moves).
  `follow()` replies grow by at most 1 MiB.
- A page that the season changed under resumes nothing: it gets the new canvas's whole map,
  as before.
- A page whose tiles are not all held (a CDN feed that released a tile past a gap, or the 3 s
  passing) gets the whole map, as today: never worse than before.
- To watch: `fanout_joins` after a realtime deploy on staging, then the measurements of the
  shard count (PROGRESS.md).
