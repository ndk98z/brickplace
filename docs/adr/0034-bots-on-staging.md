# 0034. Bots that play on staging, behind one secret

- Status: proposed
- Date: 2026-10-26
- Amends: 0015 (who a socket plays as), 0026 (per-address limits, for bots only)

## Context

The owner wants to watch a crowd play on staging before launch: the map filling, hammers and
shields at work, the CDN tiles, the abuse limits and the admin area under a real load. Today
nothing can play there but real accounts. `?player=` dev identities and the fake sign-in
provider exist only with `ENVIRONMENT=dev`; staging signs in with Google or Discord, asks
Turnstile at sign-up, and signs sessions with `SESSION_KEYS`. The k6 scripts in
`tools/loadtest` can only watch staging (`PLAYERS=0`).

Rejected:
- Minting session tokens on a laptop for accounts seeded in staging D1: it puts
  `SESSION_KEYS` on a laptop, and those keys sign real players' sessions too.
- A handful of real accounts in several browsers: fine for a look, not for 200 players.
- `?player=` on staging: anyone who found the page could then play as anyone.

## Decision

1. **One secret opens it.** The gateway Worker of staging may hold a `BOT_KEY` Workers secret
   (at least 32 characters, like every other key). It is not in `secrets.required`: without
   it, or with a shorter one, no socket is a bot. A bot socket lasts a session token's
   lifetime (an hour): FanoutDO then closes it with 4401 at its next op, and the driver
   reconnects with the key. Deleting the secret therefore stops every bot within the hour (a
   realtime deploy stops them at once).
2. **Staging only, in code.** The gateway accepts a bot only when `ENVIRONMENT` is `staging`.
   Production, `locked` and dev ignore `BOT_KEY` even if one is set there by mistake; dev
   keeps `?player=`.
3. **The request.** A socket plays as bot `n` when its upgrade request carries
   `Authorization: Bearer <BOT_KEY>` and `?bot=<n>`, `n` being 1 to 6 digits. The key travels
   in a header, never the URL, so it does not reach request logs (and a page on another site
   cannot send it: browsers set no `Authorization` on a WebSocket). It is compared in constant
   time and stripped before FanoutDO. `n` has no leading zeros, so one number is one player.
   A wrong key, or a valid key without `?bot=`, makes a socket that watches, as without
   one; a malformed `?bot=` with the right key is refused 400. A session cookie wins over a
   bot request, as it does over `?player=` in dev.
4. **What a bot is.** Player id `bot-<n>` (the prefix keeps it apart from account ids, as
   `dev-` does). No account in D1, so no nickname, no team (owner decision 2026-10-26) and no
   trust score; an expiry an hour ahead, as above. Downstream it is a player like any other:
   FanoutDO and CanvasDO draw its items, check its cooldown and apply every rule. Nothing
   changes in core, protocol, the realtime or game Workers, or the golden fixtures.
5. **Limits.** Bots skip the limits keyed by address (owner decision 2026-10-26: 200 bots run
   from one laptop): the gateway sends FanoutDO no address or network key for a bot socket,
   which FanoutDO already treats as "no address limit". Everything per account still holds:
   one playing socket per bot, opens and ops per account, 8 ops in flight, the trust tiers
   (a bot has no score, so the `unscored` tier of staging's `abuse-policy` applies) and the
   bot signals. A bot pushed past `challengeAt` cannot pass Turnstile (`/api/challenge` needs a
   session), so that bot number is out for as long as FanoutDO keeps the challenge: 7 days,
   stored durably, so neither an eviction nor a deploy clears it. That is ADR 0026 working:
   the driver reports it and moves to unused numbers, within a cap per run so stored
   challenges stay few.
6. **The driver** lives in `tools/bots` (README there): Node, the protocol and core packages,
   the player kinds of `tools/sim`, run from a laptop with `BOT_KEY` in the shell's
   environment, never committed. It also works against `pnpm dev` without a key, through
   `?player=`. Bots behave like pages: a View frame before acting and no op outside it, a
   human wait after each item, one op at a time. It can also have builders draw a given PNG.

## Consequences

- Whoever holds `BOT_KEY` can put players on the staging map, as many as they like, with no
  per-address limit. Staging holds no real players' work worth protecting; rotate the key
  (`secret put` again) if it leaks.
- Staging's op log, standings (none: no team) and the season archive will contain `bot-` ids.
  The admin area lists them among suspects and can roll back their ops, but its ban and kick
  take account ids only, so a misbehaving bot is stopped by deleting the key (within the
  hour) or by a realtime deploy (at once).
- Up to a million bot numbers, with no address limit, can push real staging players' rate
  windows and signals out of FanoutDO's bounded memory (20,000 keys per map). Accepted:
  staging only, and the key's holder chooses how many bots run.
- The `unscored` trust tier and the bot signal weights of staging's `abuse-policy` decide how
  many hammers and shields the bots may use. The owner tunes them in the private ops repo for
  a bot run, or leaves them as production's to see the limits bite.
- Turning it on, once this change is deployed to staging, and off: docs/ops/setup.md, step 8
  (`wrangler secret put` / `secret delete BOT_KEY --env staging`, a copy of the key kept on the
  laptop with owner-only permissions).
