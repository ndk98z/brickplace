# 0018. Watching through the CDN in the client

- Status: accepted; staging's bucket address amended by 0044
- Date: 2026-10-24

## Context

ADR 0009 decided that visitors who only watch get no WebSocket and read the map from the CDN,
and that a socket opens only to play, dropping back after 60 s hidden or zoomed out. ADR 0014
publishes what they read: `manifest.json` (`max-age=1`), immutable tile versions and diff
segments every 2 s. It left open the numbers the client needs (poll interval, the zoom that
counts as playing), how the client gets the bucket's address, how local dev serves a bucket
with no public domain, and how the map changes hands between the CDN and a socket without a
visible jump.

## Decision

**Who holds a socket.** A watcher (signed out, or signed in without a nickname) never does.
A player, or a local dev guest, holds one while the page is visible and zoomed in to at least
**2 px per cell** (`PLAY_MIN_ZOOM`; the page opens at 4). Hidden or zoomed out for **60 s**
(`SOCKET_IDLE_MS`), the page gives the socket back, but only once no op or discard waits for
its ack, as the session renewal already does. Zooming in again, or showing the page, opens a
new socket at once. A move made while watching asks the player to zoom in instead of being
sent.

**Where the bucket is.** The gateway's public var `TILES_ORIGIN` (https only; the tiles
bucket's custom domain) becomes `config.tilesUrl` in `/api/me`, as `{origin}/c/canvas`, the
Stage 0 canvas's prefix (staging: `tiles-staging.brickplace.app`, after a day on the bucket's
r2.dev address and a few on a stand-in domain, ADR 0044). Empty (as committed for production
until the owner sets the domain) means no CDN: every page keeps a socket, as before, so
nothing breaks before the bucket exists. Fetches omit credentials: the bucket is anonymous. A page that
cannot use the CDN at all (no manifest read in 3 tries, e.g. CORS missing, or a map of
another size) says so in the header and watches through a socket instead, for the rest of
the page's life (a reload tries the CDN again).

**Local dev.** One `wrangler dev` with several configs shares a local R2 bucket by name across
its scripts (checked live), so the gateway binds `DEV_TILES` (`brickplace-tiles-dev`, top level
only, never in staging or production) and, when `ENVIRONMENT=dev`, serves it read-only under
`/api/dev/tiles/`: GET and HEAD only, only keys of the three shapes the client reads, nothing
listed, with the Cache-Control and Content-Type the objects were stored with. Elsewhere the
route answers 404 (501 while locked, like the rest of `/api`).

**Reading.** The manifest is polled every **2 s** (one segment interval) while visible; a
hidden page doubles the interval up to 60 s and reads at once when shown; failures back off
from 4 s up to 30 s. A manifest older than the one followed (another edge's cached copy) is
ignored. The client keeps, per tile, the seq its copy is at:
- a tile not held is loaded at its listed version (version 0 is empty and costs no request),
  tiles in view first, then the rest (the minimap and zoomed-out view show the whole map);
- a tile held at or past its listed version needs only the listed segments ending after it;
- a tile held at an older seq is brought forward by segments only if they cover every seq
  after it with no gap; across a gap (seqs a server resync skipped, or segments retired) it is
  reloaded at its listed version;
- a segment applies to a tile still before its end and is skipped for a tile already past it
  (tiles are cut at the canvas's current seq, which may be past the manifest's).
  Tiles and segments of one sync land in the store in one step, and a tile is replaced only once
  its new content is in hand: the map never flashes empty. Stopping the feed, or handing it a
  socket's map, aborts the reads under way and drops their results.
- **Spreading** (built after this decision): a segment's changes to tiles the page already
  holds and has in view are not drawn at once but a few at a time over the next poll interval
  (`SPREAD_MS`, 2 s), in random order (segments carry end values in cell order, no timing),
  the cells of one brick in one step, each fading in from the cell's old look over 300 ms
  (not zoomed out below a device pixel per cell). The watcher sees the map change steadily
  instead of a burst every 2-4 s, another 2 s later at most. Tiles loaded in the sync, tiles
  out of view, a hidden page, "Reduce motion", or more than 20,000 cells waiting: drawn at
  once, after whatever still waited for those tiles. Stopping the feed or handing it a
  socket's map drops what still waits and rolls those tiles back to the seq the store is
  surely at.

**Who reads what.** A page that plays does not double its load: a player's page load opens
the socket and reads nothing from the CDN (the socket's grid brings the whole map). (Since
ADR 0040 a page about to play loads every tile from the CDN first and its socket resumes
from them, bringing only what changed.) While a
socket opens or reconnects for a page that already shows a map (a watcher zooming in, a socket
that dropped), the feed only keeps that map current and loads no tile out of view.

**Handover.** A new socket's initial grid is collected off screen and replaces the whole map in
one step when it is complete: at its last frame, the first one not full (a seq's frames are all
full but the last), or, for a grid that fills its last frame exactly, at the config frame, hold
frame or live frame that follows it. Never on a timer: on a slow link a full frame can take
seconds. Until then the CDN feed
keeps the map current; after it, the feed stops. When the socket goes (given back, closed,
replaced), the map holds every change up to the last seq whose frames all arrived (one seq's
diffs may span several frames, all full but the last), so the feed adopts that seq for every
tile and carries on with the next manifest: nothing is reloaded unless a gap requires it, and a
CDN that is a few seconds behind the socket changes nothing until it passes it. A socket that drops while playing hands back
to the CDN the same way until the next socket's grid is in. This also removes the blank map a
plain reconnect used to show.

## Consequences

- Sockets, FanoutDO load and inbound messages scale with players, not visitors, once
  `TILES_ORIGIN` is set; until then nothing changes for deployed pages.
- A watcher's first load reads every written tile (at Stage 0 about 16), far less than the
  socket's whole-grid frames, but more than the visible area alone; overview images for
  zoomed-out views (ADR 0009) would cut it and are a follow-up.
- Players zoomed out below 2 px per cell for a minute, or in a background tab, see the map
  2-4 s late and must zoom in (a socket and a fresh grid) before their next move.
- The gateway names the canvas prefix (`c/canvas`) that CanvasDO derives from its name and
  FanoutDO addresses; more than one canvas needs the gateway to say which.
- Before setting `TILES_ORIGIN`, the owner gives the tiles bucket CORS for the game's origin
  (GET, HEAD), as ADR 0014 already asks.
