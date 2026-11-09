# 0044. Staging reads the map from the tiles bucket's r2.dev URL (amended: a custom domain)

- Status: proposed (built 2026-10-28; moved off r2.dev to a custom domain the same day, and
  to the `brickplace.app` zone on 2026-11-03, below)
- Date: 2026-10-28
- Amends: 0018 (where the bucket is, staging only)
- Relates to: 0009 (watchers on the CDN), 0014 (public tiles bucket), 0029 (staging on
  workers.dev), 0040 (resume), 0043 (shard measurements)

## Context

ADR 0018 puts the map that pages read without a socket on the tiles bucket's custom domain,
named by the gateway's `TILES_ORIGIN`, empty until the owner sets that domain. The account has
no zone yet (ADR 0029: staging runs on `*.brickplace.workers.dev`), so staging's
`TILES_ORIGIN` stayed empty and every staging page took the whole map from its FanoutDO shard.
The third 2,000-bot run on staging (2026-10-28 06:38 UTC, PROGRESS.md) showed what that costs
once the map fills: 314 KB a join, first joins p95 43 s, 63 sockets closed 1013 and the shard
at 51% CPU in the first minute. Production does not run like that: its pages load the map from
the CDN and resume (ADR 0040). Staging measurements of joins mean nothing until staging does
the same.

An R2 bucket can serve itself on a Cloudflare-managed `pub-<id>.r2.dev` address without a zone.
Cloudflare limits its rate and does not cache it, and says it is not for production.

Opening the bucket showed it frozen: manifest at seq 8786, last written 2026-10-27 12:26:47
UTC. CanvasDO's alarm had not run since. Its handler threw through all its retries at
12:27-12:29, when the account passed the Durable Objects rows-written limit, and the stored
alarm stayed at 12:26:48: the start after the next deploy read that time back from
`getAlarm()` (the platform's trace of that start names it). `arm()` skips `setAlarm` while an
alarm is due no later than the one it wants, and a time in the past always is, so no alarm was
set again through three deploys and about 12,000 calls: no segment, manifest, checkpoint, log
shipping or trim. Production would freeze the same way after any failure that outlasts the
retries.

## Decision

Staging's `TILES_ORIGIN` is `https://pub-e72c08801673451fa9f8eaba84bf00e1.r2.dev`, the r2.dev
address of `brickplace-tiles-staging`, until there is a zone for the custom domain ADR 0018
asks for; then it moves there and r2.dev access is turned off. Production stays on ADR 0018 as
written: no r2.dev, a custom domain with caching.

In ADR 0018's order, the owner turned on r2.dev access and the CORS policy of
`docs/ops/setup.md` (GET and HEAD from the staging gateway's origin only) before this value:
on 2026-10-28 the manifest, a tile and a segment answered 200 with `Access-Control-Allow-Origin`
for that origin, and none for another one.

CanvasDO takes an alarm more than `LOST_ALARM_MS` (1 minute) past its time as lost: `arm()`
sets a new one instead of waiting for it. The start after a deploy sets one at once when work
is due (staging's is: a checkpoint), else the next accepted op does. An alarm only late (a
queue, a slow tick) is at worst moved a few seconds later.

`TILES_ORIGIN` reached staging first (2026-10-28 08:56 UTC), so until this fix deploys,
staging's watchers see the map of 27 October. The game deploy restarts the canvas, which
starts on its first call (Durable Objects start lazily) and then sets its alarm, a checkpoint
being due. The next tick writes one segment covering everything since seq 8786 (a full
resync instead if over 100,000 cells changed), then a manifest; changed tiles follow on the
maintenance cadence. A move on staging after the deploy is the call that wakes it, and the
check of `docs/ops/setup.md` (the manifest's `Last-Modified` moves) shows it worked.

### Amended 2026-10-28: a custom domain instead of r2.dev

Watchers on staging saw moves more than 5 s late, and r2.dev was much of it: 30 manifest
reads 2 s apart took p50 0.5 s, p90 4.5 s, max 13 s, where the R2 API read the same object in
at most 0.8 s (PROGRESS.md). The owner put the custom domain `bp-cdn-staging.dropto.site` on
`brickplace-tiles-staging`, on the `dropto.site` zone in the same account, for now. Staging's
`TILES_ORIGIN` is that domain; once open pages have reloaded, r2.dev access is turned off.

Checked before the change: the manifest, a tile and a segment answer 200; the bucket's CORS
policy applies on the domain as on r2.dev (staging's origin only). Tiles and segments are
cached at the edge (`immutable`; a MISS, then HITs). The manifest is not: Cloudflare does not
cache `.json` by default, so every read reaches R2. 30 reads 2 s apart: p50 0.86 s, p90 1.1 s,
max 1.8 s, from the same cloud container (outside Asia, the bucket is in APAC). A Cache Rule
on the zone that caches the manifest by its own `max-age=1` would take most reads off R2; it
is the owner's dashboard setting, not needed at staging's traffic.

### Amended 2026-11-03: the brickplace.app zone

`brickplace.app` is now a zone in the account, so the stand-in on `dropto.site` goes. Staging's
`TILES_ORIGIN` is `https://tiles-staging.brickplace.app`, a custom domain of
`brickplace-tiles-staging`; production's will be `tiles.brickplace.app`. Both sit one level
under the zone, where the free certificate (`*.brickplace.app`) covers them. The zone has the
manifest Cache Rule, for both names; the bucket's CORS policy allows the staging gateway's
workers.dev origin and `https://staging.brickplace.app`, where staging's pages will move.

Checked before the change, in ADR 0018's order: the manifest, a tile, a segment and the
overview answer 200 with `Access-Control-Allow-Origin` for both origins and none for another
one; the manifest is cached by its `max-age=1` (a MISS, then REVALIDATED); a move on staging
moved the manifest from seq 30148 to 30149 within seconds (15:30:21 UTC).

Changing the CORS policy needs a purge of the zone's cache afterwards. The edge keeps one copy
of the manifest per `Origin`, and while the manifest does not change R2 answers its
revalidations with a 304, so a copy cached before the change kept serving the old headers (no
`Access-Control-Allow-Origin` for the new origin) until the purge. Tiles and segments are
immutable and would keep stale headers for a year.

`bp-cdn-staging.dropto.site` and its Cache Rule on `dropto.site` came off the same evening,
with ADR 0045's deploy (16:07 UTC): pages still open from before it could no longer play, so
nothing waited a day. The bucket's CORS then kept `https://staging.brickplace.app` only, and
the zone was purged; the old name no longer resolves.

## Consequences

- Staging pages watch through the CDN and play after a resume, as production will; the bots
  do the same (`tools/bots`), so a staging run measures production's join path.
- While staging was on r2.dev, which has no cache, each page's tile reads reached R2 (Class B
  operations, 10 million a month free) and counted against r2.dev's rate limit; a 429 makes a
  page fall back to its socket after three failed manifest reads. On the custom domain only
  manifest reads and first reads of a tile or segment reach R2.
- The domain, like r2.dev, serves every key in the bucket, where ADR 0018's dev route serves
  only the keys pages read. The bucket is public by design (ADR 0014) and holds nothing else.
  Its address is in this repo and in `/api/me`, so anyone may read it and spend Class B
  operations (manifest reads, cache misses); the zone's own protections apply.
- The first maintenance after the fix ships and trims a day of op-log rows; the deletes count
  as rows written. On Workers Free, check the day's total before the next bot run.
- A frozen bucket looks healthy to every check of ADR 0018's order (200s and CORS headers):
  after a deploy, and before a measured run, the manifest's `Last-Modified` must move while
  someone plays (`docs/ops/setup.md`).
- The second and third bot runs had a canvas without maintenance: their rows-written numbers
  leave out checkpoints and log shipping.
- FanoutDO's `ensureAlarm` trusted `getAlarm()` the same way, and staging's shard was stuck
  from the same minute (every read during the third run returned 27 October 12:27:05): no
  hold alarm or watchdog ran in the second and third bot runs. It replaces an alarm more than
  `LOST_ALARM_MS` overdue by one a second out, not by its caller's time (a move's reply asks
  for that player's next item, up to a cooldown away): the handler then delivers every due
  hold, runs the watchdog if due and sets the next time itself. A realtime deploy drops the
  sockets; the first connect after it re-arms the shard.
- To move or undo: set `TILES_ORIGIN` to the new origin (or empty it) and deploy the gateway,
  wait for open pages to reload, then turn the old address off (r2.dev access, or the custom
  domain). The other order leaves pages without a map for about 12 s before they fall back
  (`docs/ops/setup.md`). Nothing reloads an open page: one that already read a manifest from
  the old address keeps it and, once that address is off, shows a frozen map (the header says
  the CDN fails) until reloaded. Turn the old address off only once its reads stop (the
  bucket's metrics), or a day later.
