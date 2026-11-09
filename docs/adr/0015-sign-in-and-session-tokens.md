# 0015. Sign-in, session tokens and watch-only sockets

- Status: accepted
- Date: 2026-10-24

## Context

Players sign in with Google, Reddit or Discord (PROGRESS.md, ADR 0008: sessions are signed
tokens, not stored). The gateway holds no Durable Objects, so it cannot keep session state,
and every socket connect must not cost a D1 read: a realtime deploy reconnects every socket
within seconds. Visitors without an account must still see the map (ADR 0009).

## Decision

- **OAuth 2.0 authorization code flow with PKCE (S256) and `state` for every provider**,
  plus an OIDC `nonce` for Google. Providers sit behind one interface
  (`workers/gateway/src/providers.ts`). `POST /auth/:provider/start` keeps state, verifier,
  nonce and return path in a signed HttpOnly cookie for ten minutes; `GET
  /auth/:provider/callback` checks it, trades the code, and then, before any account is read
  or written, records the `state` in D1 (`oauth_flows`) so each flow is accepted once.
  Without that, one Turnstile pass and one flow cookie could be replayed through the
  provider into many accounts; recording only after a successful trade means no D1 write
  without a real provider code. Redirect URIs are exactly
  `${PUBLIC_ORIGIN}/auth/{google,reddit,discord}/callback`; without `PUBLIC_ORIGIN` sign-in
  is closed outside dev. Google's ID token comes straight from its token endpoint over TLS,
  so its claims (issuer, audience, expiry, nonce) are checked without its signature (OIDC Core
  3.1.3.7). Reddit ignores PKCE and gives no email.
- **A fake provider exists only with `ENVIRONMENT=dev`**: a gateway page plays the provider
  and issues signed codes checked like a real one (redirect URI, PKCE, nonce), so the whole
  flow runs locally and in tests.
- **Session token**: `kid.payload.mac`, HMAC-SHA-256 with a purpose label, keys from the
  `SESSION_KEYS` secret (`kid:secret` entries; the first signs, all verify, so rotation is
  prepend, wait 30 days, drop). Payload: account id, a random session id, sign-in time, issue
  and expiry times, and whether a nickname is chosen. A token is enough on its own for **one
  hour**; `/api/me` reissues it after ten minutes or once expired, after a D1 check (account
  exists, not banned, not signed out everywhere since). A sign-in lasts **30 days**, then
  OAuth again. Cookie `__Host-bp_session`: Secure, HttpOnly, SameSite=Lax, Path=/.
- **CSRF**: every state change is a POST that needs `X-CSRF-Token` (a token bound to the
  session id, from `/api/me`) and, outside dev, an `Origin` of our own. Logout clears the
  cookie; "everywhere" moves `sessions_valid_after` so no older sign-in renews.
- **Linking** a provider passes the CSRF token as a form field, needs a sign-in from the last
  **10 minutes**, and checks the account in D1 (the same check as a renewal) both at `start`
  and at the callback, so a copied cookie cannot add an attacker's identity after the owner
  signed out everywhere.
- **Turnstile** is checked at `start` and **required to create an account**; a returning
  player signs in even if the widget failed. Outside dev the siteverify answer must also
  name our hostname and the sign-in widget's action (`signin`). Dev and tests use
  Cloudflare's public test keys. "On suspicious activity" is left to the abuse work.
- **`/ws`**: a current token with a nickname plays as the account; in dev `?player=` still
  plays as a dev guest; anyone else **watches**: FanoutDO sends the map and diffs, no hold,
  and acks every op or discard with the new status `signed_out` (254, appended, no protocol
  version bump). A foreign `Origin` is refused. A locked deployment keeps `/ws`, `/api` and
  `/auth` closed. The CDN spectator path of ADR 0009 stays later work.
- **Socket expiry**: the gateway passes the token's expiry to FanoutDO with the player id;
  after it the socket's ops are acked `signed_out` and the socket is closed (4401).
  `/api/me` returns how long the token it leaves in the cookie has left (relative, so a page
  whose clock is off counts it right). An open page renews every 20 minutes and, once it
  holds a later token, moves to a fresh socket two to three minutes (random, to spread
  reconnects) before the old one's expiry, counted from when that socket started opening,
  at a moment with no op in flight, so normal play never meets the refusal. When it does (a
  computer that slept), the page renews through `/api/me` (the D1 check) and reconnects as
  whatever it now is.

## Consequences

- No session table and no D1 read per socket. The price (accepted by the owner): a ban or
  "sign out everywhere" reaches an open socket within about an hour, when its token expires.
  Since ADR 0023 a ban, a nickname reset, an account deletion and "sign out everywhere" close
  the player's sockets at once (`FanoutDO.kick`), and sockets opened with a token issued before
  the kick only watch; a failed kick falls back to the token's expiry.
- Each playing page opens a new socket about once an hour, and with it receives the whole
  grid again until map tiles exist (ADR 0009); the hourly cost is one more connect per
  player, not per spectator.
- The owner must create the provider apps with the exact redirect URIs above, set
  `PUBLIC_ORIGIN`, the client ids and Turnstile site key in `wrangler.jsonc` per env, and the
  secrets `SESSION_KEYS`, `GOOGLE_CLIENT_SECRET`, `REDDIT_CLIENT_SECRET`,
  `DISCORD_CLIENT_SECRET` and `TURNSTILE_SECRET_KEY` per env.
- The sign-in copy now says we read the name and verified email (ADR 0008 stores email); the
  approved design said "name and avatar".
- No rate limits on `/auth` and `/api` yet (abuse work).
