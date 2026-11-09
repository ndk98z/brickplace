# 0009. Spectators read the map from the CDN, without a socket

- Status: accepted
- Date: 2026-10-23

## Context

Writes stay low at any scale (about 8–40k ops/s at 1M CCU) but viewers do not: the realtime
review (design doc, tab "Scale triệu CCU") puts the viewer side at most of the cost at 1M
CCU, mainly FanoutDOs that never sleep (about $2.1k/month), connection setups (about $1k)
and inbound client messages (about $1.5k). Many visitors only watch, and someone watching
does not need sub-second updates.

## Decision

- A visitor who is **not signed in**, or who is signed in but **zoomed out**, gets no
  WebSocket. The client fetches the manifest, tile snapshots, overview images and 10-second
  diff segments straight from R2 through the CDN (no Worker in front, so cache hits cost no
  Worker requests), refreshing every few seconds.
- The client **opens a socket only when the player signs in and zooms in to play**, and
  drops back to CDN mode after 60 s hidden or zoomed out.
- Spectators therefore see the map a few seconds late; players see changes within the
  realtime targets (p50 ≤ 300 ms in the same region).
- The client side (poll interval, the zoom that counts as playing, the handover, how pages
  find the bucket) is in ADR 0018; the published layout is in ADR 0014.
- **Overview images** (built after this decision): the canvas publishes the whole map
  downscaled (ADR 0014, `overview/{version}.bin.gz`, 512² pixels at most) beside the tiles.
  A watcher loads it and only the tiles in view; the minimap, and a page zoomed out below
  one device pixel per cell (which then wants no tile at all), draw the tiles they hold no
  cells for from it. The timelapse, shown at most two device pixels per overview pixel,
  plays each keyframe's overview instead of its tiles (ADR 0021).

## Consequences

- FanoutDO count, socket setups and inbound messages scale with players, not visitors.
  The saving depends on the share of watch-only visitors; measure it after launch.
- Tile snapshots and diff segments become a public read path: they must stay anonymous,
  immutable per version and cacheable, and the manifest must say which version to fetch.
- R2 Class B reads on cache misses and CDN bandwidth terms at high volume still need
  checking against Cloudflare's current pricing (an Enterprise contract may apply).
