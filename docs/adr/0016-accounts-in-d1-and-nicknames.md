# 0016. Accounts in D1, linked identities and nicknames

- Status: accepted
- Date: 2026-10-24

## Context

ADR 0008 puts accounts in D1 and lets players choose a nickname (3–20 characters, unique
case-insensitively, word-filtered, renamed every 30 days). A player may sign in with more
than one provider, and an account must never be taken over through another one.

## Decision

- **Schema** (`workers/gateway/migrations/0001_accounts.sql`, a D1 migration):
  - `users`: random UUID id, verified email (first provider that gives one), nickname,
    `nickname_key` (lower case, `UNIQUE`), `nickname_changed_at`, `created_at`,
    `signed_in_at`, `sessions_valid_after`.
  - `identities`: primary key `(provider, subject)`, `UNIQUE (user_id, provider)`, the
    provider's email and display name. At most one identity per provider per account.
  - `bans`: history rows (reason, issuer, created, expires, lifted); one applies while
    neither lifted nor expired.
- **Linking** happens only from a recent signed-in session (profile → Connect; ADR 0015).
  Accounts are never merged by matching email: an identity that belongs to someone else
  stays theirs. The last identity cannot be unlinked.
- **Nicknames**: ASCII letters, digits and `_` only (owner decision), 3–20 characters,
  pre-filled from the provider's name with accents, spaces and other characters dropped.
  Uniqueness is the `UNIQUE` index on the lower-cased name. The word list lives in KV
  (`MODERATION`, key `nickname-words`, one entry per line, `=entry` for whole-name
  matches), compared after folding case, separators and digit stand-ins; outside dev a
  missing list refuses nicknames (fail closed). First choice any time, then one change per
  30 days; the limit is a condition of the `UPDATE` itself, so two renames racing cannot
  both pass it. Until a nickname is chosen the account only watches.
- `oauth_flows` (migration 0002): the `state` of every finished sign-in flow until it would
  have expired, so each flow is accepted once (ADR 0015).
- Times are ms since the epoch. The player id sockets and CanvasDO use is the user id.

## Consequences

- Owner: `wrangler d1 create brickplace-accounts-{staging,production}`, put the ids in
  `wrangler.jsonc`, apply all of `migrations/` (0001, 0002) per env before deploying the
  gateway (the deploy workflow does not run D1 migrations yet); `wrangler kv namespace
  create` the `MODERATION` namespaces and write the word list from the private ops repo.
- ASCII-only nicknames keep homoglyph tricks out but exclude names in other scripts
  (Vietnamese diacritics included).
- Not built yet: reporting a nickname, the moderator reset, trust score, data download and
  account deletion (ADR 0008 consequences), avatars.
