# 0041. Paced diff frames and batched op relays

- Status: proposed
- Date: 2026-10-27
- Relates to: 0003 (outbound diffs per 250 ms tick), 0028 (diff ticks, views), 0032 (busy),
  0039 (players at once), 0040 (resume)

## Context

The first shard measurement (PROGRESS.md, "Measure a shard"): 2,000 bots on one
FanoutDO, each with about one item a minute, all drawing one picture. Memory (~40 MB) and CPU
(p99 42 ms) were far from limits, yet after 2.5 minutes acks no longer reached the bots within
40 s, new sockets were refused ("Durable Object is overloaded. Too many requests queued.", 268
times on `GET /ws`) and the canvas's pushes to the shard queued too long. The shard's work per
op is what grows:
- **One RPC per op.** `relayOp` calls `CanvasDO.applyBatch([op])` for every op
  (`workers/realtime/src/index.ts`), though `applyBatch` takes many. Each call is a billed
  Durable Object request and an entry in both objects' queues, and each accepted op gets its
  own `op_log` row (written, later trimmed: two rows written) and transaction (`applyNow`).
- **One broadcast per op.** The reply's diffs go to every socket that views them at once
  (`publish`); ADR 0028 batches only the canvas's ticks to _other_ shards. Frames grow with
  ops × sockets: about 13,000 frames a second at ~6 applied ops a second here, about 66,000
  at the 33 ops a second 2,000 players can make.
- **Two paths for the same cells on one shard.** The canvas still pushes its tick (4 a second)
  for cells the reply already sent.

## Decision

**Paced frames.** A shard sends map changes to its sockets at most once per 250 ms
(`FLUSH_MS`). Reply diffs and canvas ticks go into the mirror as they arrive (joins and the
change list of ADR 0040 see them at once) and into one set of cells changed since the last
flush; a flush sends each socket the frames for the tiles it views (ADR 0028's shared tile
frames), at the mirror's seq. A change after a quiet spell (no flush in the last 250 ms) is
flushed at once, as ADR 0028's amendment does for ticks, and so are 65,536 waiting cells
(`MAX_PENDING_CELLS`). Until a flush, the cells are not the sockets': the behind marker and
the cursor a shard answers a tick with stay at the last flush. While a flush is still to come, the
op's own socket gets its op's cells right after the ack, so a player sees their move as soon
as it is confirmed: at the mirror's values, under the seq of the last flush, not the op's (the
socket may still lack other cells of the seqs in between, and a later seq would make it, and a
resume from it, count them as received); the flush sends them again. The wire format does not
change: fewer, larger diff frames of the same kind.

**Batched relays.** A shard keeps one `applyBatch` call in flight to its canvas. An op that
finds none in flight goes at once; ops arriving meanwhile wait and go together in the next
call when it returns, at most 64 per call (`MAX_RELAY_BATCH`), in arrival order (the canvas
applies them in array order, so a socket's ops keep their order). Each op keeps its own opId,
dedupe key, result and ack; holds come back per player as today. Abuse signals, the trust
allowance and the 8-in-flight per account (ADR 0026) are checked per op before it waits. When
more than 256 ops wait (`MAX_RELAY_WAITING`), new ones are answered `busy` at once, as the
canvas does under ADR 0032. A failed call, or one unanswered after 10 s
(`RELAY_TIMEOUT_MS`), answers every op in it `unavailable`; retries with the same opId stay
safe, and the next call goes out. A batch's diffs reach the mirror in the shard's queue in the order
the calls returned, and the next call does not wait for them (a resync, say). Discards keep
their own call for now. No game script change: the canvas already takes batches. Code:
`workers/realtime/src/pacing.ts` and FanoutDO (`relayOp`, `relayBatch`, `flushCells`).

## Consequences

- Estimates, to be checked with the next 2,000-bot run: frames a second at most sockets × 4
  (2,000 → 8,000) whatever the op rate; canvas calls a second at most 1 / call time per shard
  (20-50 at 20-50 ms), each with every waiting op, so the canvas's queue holds about one call
  per shard instead of one per op. The `op_log` row and its trim become one per batch; dedupe
  keys, holds, team credit and move counts stay per op or per player. Requests and rows
  written are what Workers Paid bills past its included quota.
- Latency: other players on the shard see a change 0-250 ms later than today under load (p50
  about 125 ms), not at all later on a quiet map; players on other shards already see that
  (ADR 0028). An op's ack waits for the call in flight under load: up to one call's time,
  nothing when idle.
- One slow canvas call now holds every op behind it on that shard; `MAX_RELAY_WAITING` turns
  that into `busy` rather than late acks. `canvas_queue_deep` and `canvas_shedding` will
  rarely fire from ops; a shard-side sampled event `fanout_relay_waiting` takes their place.
- ADR 0032's per-call queue figures (about 1 ms each) assumed one op per call; a 64-op call
  takes longer. QUEUE_SHED counts calls and is left as is; watch `canvas_tick_slow`.
- A shard answers ticks with its last flush's seq, so while cells wait the canvas counts it
  behind: one more push per shard at the end of a burst (still at most one per 250 ms), and
  under steady load a push carries records back to the last flush (the mirror skips the
  cells it has). A shard its canvas does not follow (a rolled-back game script) has no such
  cursor: cells waiting when it is evicted, under 250 ms' worth, are lost to its open sockets.
- Rollback: a realtime script from before this ADR relays op by op again; nothing is stored,
  so either direction is safe in any deploy order.
- Left open: a slower pace for watching sockets (500 ms-1 s), dropping the canvas's ticks to
  a lone shard (the watchdog relies on them), batching discards (needs a canvas method), and
  the numbers above (`FLUSH_MS`, 64, 256), to be tuned with bots.
