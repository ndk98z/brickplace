# 0026. Abuse limits, trust score, bot signals and Turnstile on suspicious activity

- Status: proposed (owner questions at the end)
- Date: 2026-10-25
- Amends: 0015 (Turnstile "on suspicious activity"), 0019 (`/ws` limits)

## Context

The item economy already bounds what one account changes on the map (one item per cooldown,
drawn by the server, a hold of 3; ADR 0010–0012), and WAF rules limit `/auth` and `/api` per IP
(ADR 0019). Left open: an account playing from several tabs or devices at once, scripts that
open sockets or send ops in a loop (each op costs the one CanvasDO a call), fresh accounts made
to grief with hammers and shields, and bots that place blind or on a timer. Every threshold
that tunes a defence is an abuse threshold and stays out of this public repo (ADR 0002).

## Decision

1. **One playing socket per account.** When a playing socket joins FanoutDO, older playing
   sockets of the same account close with **4409**. Closing beats demoting to watch-only: a
   demoted page would show a hold it cannot use. The client gives that socket back without the
   usual reconnect and watches through the CDN until its player taps "Play here" (offered
   again when the page is shown or a move is tried), so two pages never pass the socket back
   and forth on their own. Taking over on every show was rejected: flipping between tabs would
   cost a socket and a whole grid each time, and meet the per-account limit on opens. Kicked pages
   that only watch close nobody. A page waiting for "Play here" is never reloaded by itself
   when a season changes (ADR 0021's season watch): the reload would forget it and take the
   socket back when shown. Today a canvas has one fanout shard; when it gets more,
   playing sockets must pick their shard **by account** (or a per-account object takes this
   job), never by load or area alone (`fanoutName`).
2. **Limits in FanoutDO**, the one object every playing socket of an account reaches:
   socket opens per account, per address key (IPv4, or an IPv6 /64) and per IPv6 network
   (/48, since a subscriber often holds one and could open from a fresh /64 each time), all
   from the gateway's `CF-Connecting-IP` and kept in memory only, are refused with **429** past
   their window; ops and discards per account with **`unavailable`** (existing; the page
   resends once, then reports) before the canvas. A bound of **8 ops in flight per account**
   holds with or without a policy. That number is committed on purpose: it is a capacity bound
   on what one socket can queue at the one CanvasDO, like the join queue, set from what a page
   does (one op per click, a hold of 3), not a tuned abuse threshold. Windows are fixed, in
   bounded memory maps (20,000 keys each, oldest out; measured at about 150 bytes a window and
   up to 650 a suspicion entry, under 30 MB all full). An eviction forgets them, which at
   worst gives a player fresh windows. Not Workers Rate Limiting (numbers in `wrangler.jsonc`,
   ADR 0019).
3. **Trust score.** Whenever the gateway issues a session token (sign-in, renewal), it scores
   the account 0..100 from D1: account age in days (capped), a verified email, linked providers
   beyond the first, reports a moderator acted on, and past bans. Open reports weigh nothing
   unless the owner sets `perOpenReport`: nobody has checked them, and a crowd of accounts
   could report a victim to limit it. Weights come from KV `trust-weights`. The token carries
   the score (`r`), the gateway passes it to FanoutDO, and FanoutDO limits **hammer and shield
   uses** per window by the tiers in `abuse-policy`. A use is taken before the canvas call (so
   racing ops cannot all pass) and given back, to the window it was taken in and no later one,
   when the canvas refuses the op, answers it as a duplicate, or cannot be reached. Past the
   allowance an op is refused with the new ack
   status **`limited`** (250, appended; no version bump), its item kept; bricks are never
   limited. **Layering:** this is policy about
   who may act how often, not a rule of the map: replaying the log needs no trust, and golden
   fixtures do not change. So it lives in realtime, before the canvas, like the other limits;
   core and CanvasDO stay untouched. Limiting uses rather than draws keeps ADR 0012's draws
   checkable and needs no hold changes.
4. **Bot signals.** Pages send the cells they show (**client view frame**, opcode 0x06,
   appended): after each socket opens, at most twice a second while the camera moves, and
   right before a move. FanoutDO keeps the latest view in memory and on the socket's
   attachment at most every 100 ms (a protocol-rate bound: a flood of view frames costs a map
   write each, not a storage write). An op resent on a new socket goes out after the view it
   was first sent with, then the page's current view, so a pan meanwhile does not count
   against it. Per op FanoutDO records: outside the view (plus a margin), no view at all, and **exact-cooldown timing** (fresh items used at
   nearly the same short lag, several in a row). Each adds its weight to a suspicion score that
   halves over time, lowers the trust score, and is counted in a minutely `fanout_abuse` event
   with no ids. Suspicion entries are dropped least recently updated first. `FanoutDO.suspects()`
   lists flagged accounts, and those that passed a Turnstile, in the admin area (read only). No
   signal bans anyone.
5. **Turnstile on suspicious activity.** From the policy's `challengeAt`, FanoutDO stores
   `challenge:<player>` (durable; dropped after a week unanswered) and closes the socket with
   **4428** without acking the op. The page pauses its connection, keeping the op in flight,
   and shows a Turnstile widget (action `challenge`). `POST /api/challenge` (CSRF, own origin)
   checks the token with the sign-up plumbing and calls `FanoutDO.clearChallenge`; the page
   reconnects and resends the op with its opId. Only a pending challenge is lifted, and then
   only the suspicion score starts over: the signal counts stay, with a pass counted, so a
   Turnstile solved at will neither wipes suspicion nor takes an account off the moderators'
   list. The page names the canvas it loaded, and the gateway lifts the challenge there too
   when it is Stage 0's or a registered season's, so a socket opened just before a season
   change is not met by 4428 again. A pending challenge is dropped when found past its week,
   and when the account is deleted (`kick(player, true)`); other kicks keep it, so "sign out
   everywhere" is no way out. The dialog starts afresh for each challenge (no spent token).
   Outside dev, no Turnstile secret passes nobody (fail closed, as at sign-up).
6. **Policy in KV**, namespace MODERATION, written from the private ops repo:
   - `abuse-policy` (realtime), JSON, each part optional (a missing part turns that limit off):
     `opens.account` / `opens.address` / `opens.network` / `ops.account` as
     `{limit, windowMs}`;
     `trust: {unscored, windowMs, tiers: [{below, uses}, ...]}` (ascending `below`;
     `unscored` stands in for a token without a score); `signals: {halfLifeMs, offView,
     viewMargin, noView, onCooldown, samples, withinMs, spreadMs, trustPenalty, challengeAt,
     flagAt}` (`challengeAt` 0: never).
   - `trust-weights` (gateway), JSON: `{base, perDay, maxAgeDays, email, perIdentity,
     perActionedReport, perBan}` required, `perOpenReport` optional (0); penalties negative.
     **Fail-safe: fail open.** A missing or malformed `abuse-policy` turns every policy limit off
     and logs **`abuse_policy_missing`** at error level (at most hourly per object), so Workers
     Issues tells the owner. Malformed means any present part is wrong: a typo must not drop one
     limit silently. Missing `trust-weights` leaves the score out of tokens (`unscored` applies)
     and logs an error. Failing closed would refuse every move, or every hammer, for everyone
     because of a setup slip; the item economy, the in-flight bound and the WAF still hold.

## Consequences

- Owner setup per environment: the MODERATION namespace is now bound in realtime's
  `wrangler.jsonc` too (same id as the gateway's); write `abuse-policy` and `trust-weights`
  with `wrangler kv key put ... --binding MODERATION --env <env> --remote` from the private ops
  repo; optionally add `/ws` to the WAF rate-limiting rule (ADR 0019) for per-IP opens before
  the Worker runs. Without the keys the game plays as before, and the error events say so.
- Deploy order: realtime (view frames, `limited`, 4409, 4428) before the gateway (client
  assets, `/api/challenge`), as usual. A realtime rollback behind a newer client closes its
  sockets with 1002 on the first view frame. Pages cached from before this change reconnect
  after 4409 and take the socket back after their backoff (slowly, until they reload); they do
  not know `limited` (the op times out as unconfirmed) or 4428 (they reconnect and meet it
  again).
- PR previews: a preview deploys the gateway (and client) only, bound to staging's realtime
  and game scripts. Until this realtime change reaches staging, a preview's client sends view
  frames to an older FanoutDO, which closes the socket with 1002 right after it opens (the
  page sends its view at once, so it never plays), and `/api/challenge` answers 503 (no
  `clearChallenge`).
  Previews of this change need realtime on staging first.
- Policy changes reach FanoutDO within 5 minutes; trust weights reach a token at its next
  renewal (up to an hour).
- State is memory only except challenges: limits, suspicion and the moderator list restart
  with the object (a realtime deploy). Accepted: bounds on bursts, not ledgers.
- The view signal trusts the page's own report, and a script can send a fitting view; the
  timing signal needs `samples` fresh items in a row. Both are cheap hints, tuned in KV.
- Player ids now sit in FanoutDO storage as challenges (as kicks did): not in the archive, and
  dropped after a week.

Open questions for the owner (recommendations in brackets):
- Fail open on a missing policy [yes, with the error event], or refuse play until it is set?
- Should `noView` weigh anything [0 for the first weeks: cached pages send no views]?
- Demote instead of closing an older tab [no: closing keeps the hold honest]?
- Feed `suspects()` into the trust score durably (D1), not only in memory [later, with data]?
- Let open (unchecked) reports lower trust [no, `perOpenReport` 0: sybil reports could limit a
  victim; actioned reports only, at the cost of reacting only after a moderator looks]?
