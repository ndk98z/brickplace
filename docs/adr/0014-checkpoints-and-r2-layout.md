# 0014. Grid checkpoints, op-log segments and CDN tiles in R2

- Status: accepted
- Date: 2026-10-24

## Context

CanvasDO replayed its whole SQLite op log on every start, and `blockConcurrencyWhile` gives
that about 30 s; a week-long season outgrows it. ADR 0008 puts the grid in DO SQLite "plus
checkpoints" with log segments in R2; ADR 0009 has spectators read tiles, diff segments and a
manifest from the CDN. The owner wants spectators near live (a few seconds behind) and two
buckets: a private one for the log, a public one for the map. A SQLite row holds at most
2 MB; the grid is 8 MiB at 2048².

## Decision

**Checkpoints** (`packages/core/src/checkpoint.ts`): a canonical little-endian encoding of
the config (size, open area, maxShield, shield lifetime), logical clock, cells, shields, each
shielded cell's expiry times and the live expiry queue; counters are recounted on decode. The
same history encodes to the same bytes, which is how a property test proves that checkpoint
plus tail equals a full replay. Decoding refuses broken invariants (link bits, empty cells,
maxShield, expiry order). CanvasDO keeps one, gzipped in 1 MiB parts, with its seq, SHA-256
and gridHash. A new one is written beside it and read back and checked (without the
recount) before it replaces it. A restore starts from the checkpoint's config and ignores
the stored canvas config's core rules, so every rule change must be a logged op before admins
can make it. Open-area growth already is (ADR 0013): its rows replay through `applyEntry`
like any other, the checkpoint carries the open area they produced, and they ship and trim
with the rest of the log. The growth rule itself stays in the stored config; it decides only
future growth.

**Two cadences.** Every 2 s while the map changes (`SEGMENT_MS`): one diff segment and the
manifest. Every 10 s at most, only when due: a checkpoint after 60 s of activity, log
shipping, trimming, tiles, garbage. Idle canvases schedule no alarm. Amended 2026-10-28 (as
ADR 0028 did for ticks): an op asks for a segment at once when no segment step had anything
to write in the 2 s before it (nor is the bucket backing off), else for the rest of the
interval. Ops never ask for a segment sooner than 2 s after the last one; a burst after a
quiet spell costs at most one more.

**Op log** (bucket `OPLOG`, private; will hold player ids per ADR 0008):
`c/{canvas}/oplog/{from:012}-{to:012}.ndjson.gz`, at most 20,000 rows: a header line
`{"format":1,"from","to"}`, then every op_log row with all columns. `customMetadata` has the
range and the SHA-256 of the body. Rows leave SQLite only once they are in both the stored
checkpoint and R2. A retry finds an object starting at the same seq and checks it instead of
writing another; a mismatch stops trimming, and shipping backs off up to hourly. Objects are
never overwritten. `{canvas}` is pinned in the canvas's meta on first start.

**CDN** (bucket `TILES`, public custom domain, anonymous; formats in
`@brickplace/protocol/cdn`), gzip bytes without `Content-Encoding`:
- `tiles/{tx}-{ty}/{version}.bin.gz`: one 256² tile, version = the seq it was cut at, at
  most one new version per 45 s per tile. Immutable.
- `diffs/{from}-{to}.bin.gz`: end values of the cells seqs from+1..to changed. Immutable.
  More than 100,000 changed cells (an outage, a canvas older than this) are not segmented:
  every tile is republished instead, so segments in the manifest may skip seqs.
- `overview/{version}.bin.gz`: the whole map downscaled to at most 512² pixels (`factor`
  cells a side each, the smallest that divides the size: 4 at 2048² and 1792²), per pixel the
  colour most of its filled cells
  have and how much of it is filled (protocol `encodeOverview`, about a 32nd of the tiles'
  bytes). Cut like a tile, at most once per 45 s while the map changes, at its own seq; the
  manifest names it (`overview: {factor, version}`), and the one it replaces is garbage once
  a manifest without it is out. Pages zoomed far out and the minimap draw the tiles they do
  not hold from it, so a watcher loads only the tiles in view (ADR 0009). Immutable.
- `manifest.json` (`max-age=1`): seq, geometry, the open area, each tile's version (0 =
  never written) and the segments a reader needs: every tile's changes after its version,
  plus the last 60 s. A growth row changes no cell; the next segment still covers its seq
  (possibly with no diffs), so the manifest's seq and open area follow it within one tick.
- Spectators see the map about 2-4 s late: up to one segment interval, the manifest's cache
  second, and their polling. Since the 2026-10-28 amendment, a lone move skips the segment
  interval (before it, the owner saw over 5 s from a move to a watcher's screen on staging,
  which read r2.dev until ADR 0044's amendment).
- A checkpoint does not wait for the CDN. If the TILES bucket is down, segments and tiles
  wait, retried with a backoff growing from 2 s to 5 minutes; a restart past the last segment
  republishes every tile.
- A resync (too many cells, or a restart past the last segment) republishes every tile in
  the same tick, and no manifest goes out until all of them are recorded.
- The canvas remembers in SQLite that a manifest is owed, so a restart still writes it.

**Retention.** SQLite: the current checkpoint and the log after it (plus unshipped rows).
OPLOG: everything (season archive); stripping player ids after a season writes new objects
under a new prefix, then deletes the old. TILES: the canvas deletes what the manifest stops
listing (old tile versions, retired segments) and anything uploaded but never recorded, one
hour later. A replaced tile version counts as unlisted only once a manifest without it is in
R2. Nothing listed expires, so no lifecycle rule is needed, and one must not be set
on `tiles/` or `diffs/`: an unchanged tile keeps its version for days.

## Consequences

- Start-up is one checkpoint decode (about 120 ms at 2048²) and at most about a minute of log.
- Measured on a laptop in Node at 2048²: a segment tick costs 0.3-1.3 ms of CPU (400-4,000
  changed cells), one tile 0.4 ms. A checkpoint costs about 25 ms (encode 11 ms, gridHash
  11 ms) plus its read-back check, once a minute at most.
- R2 Class A writes while active, if busy around the clock: a segment and a manifest every
  2 s, about 2.6M a month (about $12); tiles at most one version per 45 s each, up to about
  3.7M a month (about $17) when all 64 tiles keep changing, about 0.9M (about $4) at Stage 0's
  16 open tiles; one log object a minute. Idle costs nothing.
- Manifest reads at `max-age=1`: without tiered cache every edge asks R2 once a second, which
  could cost hundreds of dollars a month in Class B reads; with it, a few upper tiers do.
- Before the first deploy the owner: creates the four buckets (oplog/tiles for staging and
  production); gives the tiles buckets a custom domain, caching and CORS; turns tiered cache
  on for that zone; gives the oplog buckets no public access.
- Checkpoint copies in R2 for disaster recovery: built by ADR 0024 §10 (hourly copies of the
  stored checkpoint under `c/{canvas}/checkpoints/` in OPLOG, kept 48 recent plus 31 daily,
  deleted at the seal). A start whose checkpoint is damaged, or missing under a trimmed log,
  recovers from the newest copy plus the log after it, or else replays every OPLOG segment.
