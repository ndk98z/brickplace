# 0025. Ops alerts from structured logs, and a deploy check for the draw key

- Status: proposed
- Date: 2026-10-25

## Context

Before public traffic, some failures must reach a person, not only the logs:
- A season's seal can keep failing (an R2 outage, an archive object with other content, a raw
  log that does not rebuild the final map). Until it goes through, player ids stay in the
  canvas past ADR 0008's 90 days (ADR 0021). Its only trace was a free-text
  `archive seal failed` line, and its backoff started over whenever the object was evicted
  between attempts (every attempt after the first minute or two).
- Without the `ITEM_DRAW_KEY` secret no item is ever drawn (ADR 0012 fails closed); the game
  looks up but nobody can play.
- Overload shows first in the Durable Objects: a CanvasDO queue that grows, ticks that take
  longer than a segment interval, a FanoutDO near the runtime's 32,768 sockets per object,
  joins refused during a reconnect storm.

The repository is public and owner-run: no paid monitoring service, no thresholds that must
stay private, nothing that names a player in logs.

## Decision

Workers log operational events as one object per line with a stable `event` name and only
non-identifying fields (canvas name, counts, times, error text). Workers Logs indexes them as
fields; error-level events also reach Workers Issues, turned on in the `wrangler.jsonc` of
game, realtime and gateway, whose automations route them to the owner. Signals that can last
(overload) are sampled to one event per name per minute per object. The list of names, their
fields and what to do is `docs/ops/alerts.md`; names never change once shipped.

Seal failures are counted in the canvas's own storage (meta `seal_failures`): every failure
logs `archive_seal_failed`, the fifth and every later one `archive_seal_stuck`, and the backoff
is computed from the count, so it survives evictions. A seal runs in steps (25 raw segments
each), and a good step in between does not reset the count, or a seal that always fails on a
late step would never look stuck: only a completed seal clears it. Error text from a
`SyntaxError` (a damaged raw row, whose message may quote player ids) is never logged, only its
name.

The deploy workflow lists the game script's secret names through the Cloudflare API after the
game deploy and fails the run, before realtime and the gateway ship, when `ITEM_DRAW_KEY` is
missing. It runs on every deploy, not only when game ships. A health route was not added: the
game script has no public route, and reaching it from the gateway would need a new binding and
a public endpoint that wakes a Durable Object.

## Consequences

- The owner sets up alerts once per environment in the dashboard (automations, saved queries);
  the repository cannot do it for them. Until then the events are only searchable.
- Renaming an event breaks those alerts silently: add a name instead, and keep the old one
  until the alerts move.
- Workers Issues is in open beta, and `observability.issues` in `wrangler.jsonc` is new: confirm
  on the first staging deploy that the setting is accepted and Issues shows up for the three
  scripts. If Issues changes, the same events still work with Logpush or a Tail Worker
  filtering on `event`.
- The secret check needs the deploy token to read script settings (Workers Scripts Edit already
  covers it). A first deploy without the secret still ships the game script, then fails.
- The check gates the realtime and gateway deploys of the same run too: while the game's key is
  missing, an unrelated gateway hotfix does not ship either. That is on purpose (the game is
  unplayable anyway); put the key back, or run the deploy by hand, to unblock it.
- `canvas_tick_slow` measures with `Date.now()`, which in Workers only advances at I/O: a tick
  that burns CPU without awaiting (a big replay, a checkpoint encode) is undercounted.
- Thresholds (64 queued calls, 2 s ticks, 5 failures, 80% of sockets) are code defaults; tune
  them from what the load tests (`tools/loadtest/`) and the first season show.
