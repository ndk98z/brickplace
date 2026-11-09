# 0032. A busy signal: the canvas sheds moves when it falls behind

- Status: accepted
- Date: 2026-10-26
- Relates to: 0006 (UI design: the "busy" toast), 0012 (holds), 0025 (`canvas_queue_deep`),
  0026 (per-account op limits), 0028 (one canvas, many shards)

## Context

A canvas is one Durable Object: every op, discard, hold read and admin call runs through its
serial queue, about a millisecond each. Past 64 waiting calls it logs `canvas_queue_deep`
(ADR 0025) but still queues everything, so under a surge every player's move waits longer
and longer, the socket's 8 calls in flight per account fill up (ADR 0026), and moves come back
`unavailable` after the client's timeout. That reads as "the server restarted mid-move" and
the client resends once, adding to the queue. The approved design has a "busy" toast ("Your
item was kept. Try again in a few seconds") that no server signal sends (`BUSY_NOTICE`).

## Decision

- **Shedding.** CanvasDO refuses a new op or discard at once, without queueing it, while
  `QUEUE_SHED` (256, about a quarter second of work) calls already wait. Hold reads, ticks,
  admin calls and shard pushes are never shed: only moves, which a player can simply make
  again. A retry of an op or discard the canvas already accepted is still answered as a
  duplicate, and a retry of one still waiting in the queue (a new socket resends with the
  same ids) is queued behind it rather than shed, so a move answered `busy` is never applied
  later. A paused or ended map still answers `read_only` or `ended`. The item is not taken
  (as for any refusal). A sampled ops event,
  `canvas_shedding`, sits beside `canvas_queue_deep`. The number is a capacity setting in code,
  like `QUEUE_DEEP`, not an abuse threshold.
- **Protocol.** A new ack status `busy` (0xf9), appended below `limited` (0xfa) as earlier
  canvas statuses were (ADR 0021, 0026); no `PROTOCOL_VERSION` bump. FanoutDO passes it on
  like the other canvas statuses, giving back the trust allowance's use as for any refusal.
  Older clients skip an ack they cannot read, so the op times out as unconfirmed, as today.
- **Client.** `busy` maps to `BUSY_NOTICE`, worded for the whole map ("The map is busy")
  since shedding is per canvas, not per area. The item goes back into the hold, and the
  page does not resend on its own: the player retries.

## Consequences

- Under a surge players get an answer within one round trip instead of a timeout, and the
  queue stops growing from resends; ticks and holds keep their pace for everyone.
- A move refused `busy` is never applied, so no dedupe or late-commit question arises (unlike
  `unavailable`).
- Deploy order: FanoutDO relays the canvas's reason into the ack it encodes, so a realtime
  script that predates `busy` cannot encode one and answers `unavailable` instead (its guard
  for a reason it does not know). The deploy workflow ships game before realtime: for that
  minute a shed move reads as unconfirmed and the page resends it once, as today. Until the
  client ships, `busy` times out as unconfirmed.
- To watch: a canvas that sheds often needs more than a threshold (ADR 0028's Merger tier).
  The k6 `diff-latency.js` run can measure the threshold on staging before a public season.
- The owner's answers (2026-10-26): a threshold of 256; no per-area shedding (it needs a
  per-tile queue, which one serial canvas does not have); no client back-off, the toast is
  enough; the toast is worded for the whole map.
