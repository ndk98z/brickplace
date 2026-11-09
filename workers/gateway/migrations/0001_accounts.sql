-- Accounts (ADR 0008, 0016). D1 migration, applied with
--   wrangler d1 migrations apply ACCOUNTS --local -c workers/gateway/wrangler.jsonc
-- (`pnpm dev` does it locally; staging and production need it applied with --env before the
-- first deploy that signs anyone in, which the deploy workflow does not do yet).
-- Times are ms since the epoch. Never edit an applied migration: add the next one.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- Verified address from the first provider that gave one (Reddit gives none). Personal data.
  email TEXT,
  -- Chosen at first sign-in; NULL until then (such an account can only watch).
  nickname TEXT,
  -- Lower-cased nickname: makes uniqueness case-insensitive.
  nickname_key TEXT UNIQUE,
  nickname_changed_at INTEGER,
  created_at INTEGER NOT NULL,
  signed_in_at INTEGER NOT NULL,
  -- Session tokens from sign-ins before this time are not renewed ("sign out everywhere").
  sessions_valid_after INTEGER NOT NULL DEFAULT 0
);

-- Provider accounts linked to a user: at most one per provider, each owned by one user.
CREATE TABLE identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'reddit', 'discord', 'dev')),
  -- The provider's stable id for the person (OIDC `sub`, Discord or Reddit user id).
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  signed_in_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);

-- Bans, kept as history: one applies while it is neither lifted nor expired.
CREATE TABLE bans (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  -- Who issued it: a moderator id or an automatic rule name.
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- NULL: until lifted.
  expires_at INTEGER,
  lifted_at INTEGER
);

CREATE INDEX bans_by_user ON bans (user_id);
