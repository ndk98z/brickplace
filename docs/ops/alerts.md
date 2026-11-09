# Alerts and ops events

What the Workers log when something needs a person, and how the owner turns that into an
alert. Decision and trade-offs: [ADR 0025](../adr/0025-ops-alerts-from-structured-logs.md).
Everything here uses what the Cloudflare account already has (Workers Logs, Workers Issues,
the deploy workflow); nothing needs a paid service.

## How events look

Each event is one `console.error` / `console.warn` / `console.log` call with a single object:

```json
{ "event": "archive_seal_failed", "canvas": "s1", "attempt": 3, "retryInMs": 40000, ... }
```

- `event` is stable: saved queries and alerts match on it, so a name never changes. A new
  signal gets a new name.
- No event carries a player id, a nickname, a session or a secret: only canvas names, counts,
  times (ms) and error text (which names R2 object keys at most). A `SyntaxError` (a damaged
  raw row) is logged by name only, since its message can quote the row and the ids in it.
- Sampled events (the overload ones) go out at most once a minute per object and name; the
  next one carries `suppressed`, the number held back meanwhile.
- Workers Logs indexes the object's keys, so the Observability query bar filters on them
  directly: `event = "archive_seal_stuck"`, `event = "canvas_tick_slow" AND ms > 5000`.
- Error-level events are also picked up by Workers Issues (enabled in the `wrangler.jsonc` of
  all four scripts; keep it there, or the next deploy turns Issues off again).
- Logs are never sampled, since alerts count events; traces are kept for every request on
  staging and 5% in production (admin: all). `tools/ci/test/observability.test.ts` holds
  these for every environment.

## Events

| Event                       | Script   | Level          | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fields                                                                                                                                                                                                  |
| --------------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item_draw_key_missing`     | game     | error          | A CanvasDO starts without the `ITEM_DRAW_KEY` secret: no item is drawn until it is set.                                                                                                                                                                                                                                                                                                                                                                                  | `canvas`                                                                                                                                                                                                |
| `archive_seal_failed`       | game     | error          | Each failed attempt to seal a season's archive (ADR 0021), or to purge the player tables once it is written. Retried after 10 s, doubling up to hourly; the count and the wait survive a restart, and only a completed seal clears them.                                                                                                                                                                                                                                 | `canvas`, `attempt` (failures since the seal began), `failingForMs`, `overdueMs`, `retryInMs`, `error`                                                                                                  |
| `archive_seal_stuck`        | game     | error          | The same, from the 5th failure on (about 2.5 min after the first, longer for a seal of many steps): the seal will not fix itself.                                                                                                                                                                                                                                                                                                                                        | as above                                                                                                                                                                                                |
| `archive_seal_no_bucket`    | game     | error          | A season was sealed without an OPLOG binding, so without an archive. A configuration mistake.                                                                                                                                                                                                                                                                                                                                                                            | `canvas`                                                                                                                                                                                                |
| `archive_sealed`            | game     | info           | The seal went through; player ids are gone from the canvas. Closes a seal alert.                                                                                                                                                                                                                                                                                                                                                                                         | `canvas`, `sealedAt`                                                                                                                                                                                    |
| `who_unreadable`            | game     | error, sampled | A log row's `who` (who made each op, ADR 0020) cannot be read, found while a start, a rollback or the seal replays the log: its ops count for nobody in the team ledger, a rollback by player cannot match them (the preview's `unattributedOps`), and the archive names nobody for them.                                                                                                                                                                                | `canvas`, `seq` (the row), `suppressed`                                                                                                                                                                 |
| `canvas_queue_deep`         | game     | warn, sampled  | 64 or more calls (ops, discards, holds, admin calls) wait in a CanvasDO's queue.                                                                                                                                                                                                                                                                                                                                                                                         | `canvas`, `depth`, `suppressed`                                                                                                                                                                         |
| `canvas_shedding`           | game     | warn, sampled  | A CanvasDO refused new ops and discards `busy` without queueing them (ADR 0032): 256 or more calls waited. Players get the busy toast and keep their items; holds, ticks and admin calls go on.                                                                                                                                                                                                                                                                          | `canvas`, `depth`, `suppressed`                                                                                                                                                                         |
| `canvas_tick_slow`          | game     | warn, sampled  | A maintenance or segment tick held the CanvasDO longer than 2 s (one segment interval): spectators fall behind, ops wait. Measured with `Date.now()`, which in Workers only advances at I/O: CPU spent without awaiting (a replay, a checkpoint encode) is undercounted.                                                                                                                                                                                                 | `canvas`, `ms`, `maintained`, `suppressed`                                                                                                                                                              |
| `canvas_push_failed`        | game     | warn, sampled  | A diff tick to a FanoutDO shard failed or was not answered within 10 s (ADR 0028). The shard is retried, backing off from 0.5 s to 30 s, and caught up in one push when it answers; the other shards are not held up; after a day of failures it is tried hourly (never forgotten while it may have sockets). Expected for a moment during a realtime deploy; a steady stream means a shard's sockets see others' moves late.                                            | `canvas`, `shard` (a FanoutDO name), `failures` (in a row, for that shard), `error`, `suppressed`                                                                                                       |
| `fanout_join_refused`       | realtime | warn, sampled  | A socket was refused because too many initial grids were queued (503, the client retries after its backoff). Normal for a few seconds after a realtime deploy.                                                                                                                                                                                                                                                                                                           | `canvas`, `active`, `waiting`, `suppressed`                                                                                                                                                             |
| `fanout_full`               | realtime | warn, sampled  | A player was turned away because the shard holds its share of the players-at-once cap set in the admin area (ADR 0039; close 4503, the page watches and tries again). Expected while the map is full.                                                                                                                                                                                                                                                                    | `canvas`, `playing`, `share` (the shard's part of the cap), `suppressed`                                                                                                                                |
| `fanout_relay_waiting`      | realtime | warn, sampled  | A FanoutDO refused a new op `busy` at once because 256 of its ops already waited for its call in flight to the canvas (ADR 0041). Players get the busy toast and keep their items.                                                                                                                                                                                                                                                                                       | `canvas`, `waiting`, `suppressed`                                                                                                                                                                       |
| `fanout_sockets_high`       | realtime | warn, sampled  | A FanoutDO holds 80% of the 32,768 sockets the runtime allows one object (counted at most every 10 s).                                                                                                                                                                                                                                                                                                                                                                   | `canvas`, `sockets`, `warnAt`, `suppressed`                                                                                                                                                             |
| `fanout_refollow`           | realtime | warn, sampled  | A FanoutDO shard's tick watchdog (ADR 0028) followed its canvas again: the canvas no longer follows the shard (`not_followed`: it restarted without the shard, forgot it, or was redeployed after a rollback), or it is ahead and no tick came for 3 s (`stalled`; 33 s while the canvas says its pushes to the shard are failing). Each one copies the grid once. A few around deploys are normal; a steady stream means pushes are not getting through.                | `canvas`, `reason` (`not_followed` or `stalled`), `suppressed`                                                                                                                                          |
| `fanout_stale_closed`       | realtime | warn, sampled  | A FanoutDO shard closed every open socket with 1012 (the pages reconnect for a fresh grid) because it could not tell what they missed: `unknown_cursor` (woken after an eviction, the canvas lost what the shard's sockets have), `marker` (not followed by its canvas, and woken while a lost reply left them behind) or `too_many_changes` (a resync found more than 262,144 changed cells). Expected after a canvas restart; a steady stream means a reconnect storm. | `canvas`, `sockets` (closed), `reason`, `suppressed`                                                                                                                                                    |
| `fanout_attachment_failed`  | realtime | warn, sampled  | A FanoutDO could not write an open socket's attachment (ADR 0028): `tiles` (the tiles it follows) or `owed` (Tile frames not sent yet). Nothing is lost while the object stays up; after an eviction that socket gets every tile again, or misses the owed Tile frames until its next view. Should not happen; a steady stream points at a runtime limit.                                                                                                                | `canvas`, `field`, `error`, `suppressed`                                                                                                                                                                |
| `fanout_canvas_call_failed` | realtime | warn, sampled  | A call from FanoutDO to CanvasDO failed. Expected during a game deploy; a steady stream, or `overloaded: true`, means the canvas cannot keep up.                                                                                                                                                                                                                                                                                                                         | `canvas`, `call`, `overloaded`, `suppressed`                                                                                                                                                            |
| `abuse_policy_missing`      | realtime | error, hourly  | A FanoutDO read KV `abuse-policy` (ADR 0026) and found none, or one it could not read (`malformed`): every abuse limit, the trust allowance and the bot signals are off until it is fixed.                                                                                                                                                                                                                                                                               | `canvas`, `reason` (`missing` or `malformed`), `suppressed`                                                                                                                                             |
| `fanout_abuse`              | realtime | info, minutely | Abuse limits and bot signals at work (ADR 0026): counts since the last event, sent with the first count after a minute, never an id or an address. A steady rise in `challenged` or `opsRefused` is worth a look in the admin area's bot signals.                                                                                                                                                                                                                        | `canvas`, any of `opensRefusedByAccount`, `opensRefusedByAddress`, `opensRefusedByNetwork`, `opsRefused`, `inFlightRefused`, `trustLimited`, `offView`, `noView`, `onCooldown`, `challenged`, `cleared` |
| `fanout_joins`              | realtime | info, minutely | Sockets that joined since the last event (ADR 0040): `resumed` got only the changes since the map their page held, `grids` the whole map. After a realtime deploy most should be resumed; many `grids` mean pages that do not hold the whole map (no CDN, a slow one) or a change list that no longer reaches them. Counts only.                                                                                                                                         | `canvas`, `resumed`, `grids`                                                                                                                                                                            |

The thresholds (64 and 256 calls, 2 s, 5 failures, 80%) are defaults in code, not secrets: change them
in `workers/game/src/index.ts` and `workers/realtime/src/ops.ts`.

The seal's count lives in the canvas's meta `seal_failures`. If that value is ever damaged (not
JSON, or a count or time that makes no sense), the canvas does not stop over it: it reads it as
one failure at the moment it is read. So the backoff starts over (the next failure is `attempt`
2, retried after 20 s), `archive_seal_stuck` comes back only from the fifth failure counted
anew, and `failingForMs` counts from the failure that read the damaged value (0 on that one),
understating how long the seal has really been failing. For the real start, look for the first
`archive_seal_failed` of that canvas in the logs.

## Setting up the alerts (owner, once per environment)

1. **Deploy check.** Nothing to do: the deploy workflow lists the game script's secret names
   after the game deploy and fails the run, before realtime and the gateway ship, when
   `ITEM_DRAW_KEY` is missing (`tools/ci/check-secrets.ts`). GitHub mails a failed run to the
   person who pushed; turn on "Actions" notifications for the repository if that is not you.
   While the key is missing, no realtime or gateway change ships either, hotfixes included.
2. **Workers Issues automation.** Dashboard → Workers & Pages → `brickplace-game-<env>` →
   Issues → Automations: on a new or recurring issue, send it to a destination the owner reads
   (email through a webhook relay, Discord or Slack webhook, an incident tool). Do the same for
   `brickplace-realtime-<env>` and `brickplace-gateway-<env>`. The seal and secret events are
   error level, so they arrive here; mark `archive_seal_failed` noisy issues as "Ignored" only
   once `archive_seal_stuck` has its own automation.
3. **Saved queries (optional).** Dashboard → Workers & Pages → Observability → Investigate, one saved
   query per line below, so the next person finds them:
   - `event = "archive_seal_stuck"` (and `archive_seal_failed`), grouped by `canvas`;
   - `event = "canvas_queue_deep" OR event = "canvas_tick_slow"`, max of `depth` and `ms`;
   - `event = "canvas_shedding" OR event = "fanout_relay_waiting"`, by `canvas` (players are
     seeing the busy toast);
   - `event = "fanout_join_refused" OR event = "fanout_sockets_high"`, by `canvas`;
   - `event = "fanout_canvas_call_failed" AND overloaded = true`.
4. **From a terminal (optional).** `node tools/ops/workers-logs.mjs --env staging --minutes 60`
   counts these events by script, sums `fanout_abuse` and lists each event with its fields,
   through the Workers Observability API: `CLOUDFLARE_ACCOUNT_ID` and a token with only
   Account → Workers Observability → Read in `CLOUDFLARE_API_TOKEN`. Handy after a bot run
   (`tools/bots`, ADR 0034).
5. **Logpush (optional).** Only if the account's plan has Workers Logpush and a log tool is in
   use: push the `workers_trace_events` dataset of these scripts there and alert on
   `Logs[].Message[0].event` with the same names. Not needed for the alerts above.
6. **Usage.** Cloudflare's own billing and usage notifications (Notifications → Add) cover
   account-level usage; set them before any public traffic.

Optionally, check an automation once after setting it up. The cheapest real event is
`abuse_policy_missing`: copy that environment's KV `abuse-policy` from the private ops repo,
set the key to text that is not JSON, open a page so a FanoutDO reads it (within 5 minutes),
see the alert arrive, then put the policy back. Every abuse limit, the trust allowance and the
bot signals are off meanwhile and for up to 5 minutes after, and the event goes out at most
hourly per object, so a second try within the hour may stay silent. Do not delete `ITEM_DRAW_KEY` for this: Workers Secrets cannot be read back, and
a key piped straight from `openssl` was never seen, so the same key cannot be put back and
every earlier draw stops being checkable (ADR 0012). The
seal events have tests (`workers/game/test/season.test.ts`); on staging, an owner can end a
throwaway season and seal it at once from the admin page (Seasons → Archive → Seal now), which
gives `archive_sealed`, or `archive_seal_no_bucket` if OPLOG is missing.

## What to do

- **`item_draw_key_missing`, or the deploy check failed.** Set the secret for that environment
  (`openssl rand -base64 32 | wrangler secret put ITEM_DRAW_KEY --env <env>`, from a machine
  the owner trusts; never commit it). If the environment had a key before and lost it, put the
  same key back: a new key changes every later draw and old draws can no longer be checked
  (ADR 0012). The secret change restarts the game script, which then draws again.
- **`archive_seal_failed`.** Read `error`. An R2 outage clears itself; the next attempt resumes
  where the last one stopped. `exists with other content`, `does not reach the final map`,
  `has a gap` or `changed after it was verified` need a person: the seal will not overwrite
  the locked `archive/` prefix (ADR 0021). Compare the object named in the error with the raw
  log, fix the raw side, and let the next attempt run.
- **`archive_seal_stuck`.** As above, now. `overdueMs` above 0 means player ids are already
  kept past ADR 0008's 90 days: record the incident and its end (the `archive_sealed` event).
- **`archive_seal_no_bucket`.** The game's `wrangler.jsonc` for that environment lost its
  `OPLOG` binding: restore it before any other season ends.
- **`who_unreadable`.** Rows are written whole in one transaction, so this points at storage
  damage or a hand edit. The map is unaffected; the ranking under-counts that row's cells and a
  rollback by player misses its ops (roll back by area and time instead). Read the row named by
  `seq` (SQLite `op_log`, or the R2 segment holding it) and repair its `who` before the seal, or
  the archive keeps those ops without a pseudonym.
- **`canvas_queue_deep` / `canvas_tick_slow`.** One now and then (a game deploy, a big
  checkpoint) is fine. Sustained: look at the CanvasDO's CPU and wall time in the dashboard,
  the op rate, and whether R2 is slow (`ms` with `maintained: true` points at maintenance:
  checkpoints, tiles, log shipping). Pause the map from the admin area if players see stalls.
- **`canvas_shedding`.** The canvas is past `canvas_queue_deep` and turning moves away. A few
  seconds of it in a surge is the design working; minutes of it mean one canvas no longer
  keeps up with its players: the same checks as above, then plan ADR 0028's next tier.
- **`fanout_relay_waiting`.** A shard's ops wait on one canvas call at a time (ADR 0041), so
  this fires when calls slow down (look at the CanvasDO's wall time and `canvas_queue_deep`)
  or when one shard carries more players than it relays for: raise `FANOUT_SHARDS`.
- **`fanout_join_refused`.** Expected for a minute after a realtime deploy (every socket
  reconnects; `tools/loadtest/reconnect-storm.js` measures it). Outside deploys, a sign of more
  joins than one FanoutDO serves: plan per-tile FanoutDOs (PROGRESS.md).
- **`fanout_full`.** The cap is doing its job. Raise it in the admin area (Overview → Players at
  once) if the budget allows; it takes effect within about 30 s.
- **`fanout_sockets_high`.** One FanoutDO is near its socket limit: per-tile subscriptions and
  more FanoutDOs per canvas must ship before the next growth step.
- **`fanout_canvas_call_failed` with `overloaded: true`.** The CanvasDO refuses work: the same
  checks as `canvas_queue_deep`.
- **`abuse_policy_missing`.** Write `abuse-policy` into that environment's MODERATION namespace
  from the private ops repo (shape in ADR 0026); `malformed` means a part is there but wrong,
  and the whole policy is ignored until it parses. FanoutDOs read it again within 5 minutes.
  The gateway logs `trust-weights is not set` (or `is malformed`) the same way for the trust
  score weights; tokens then carry no score and the policy's `unscored` applies.
- **`fanout_abuse`.** Information, not an alarm. Many `challenged` at once after a client
  deploy can mean a page that stopped sending views (`noView`): lower that weight in the policy.
