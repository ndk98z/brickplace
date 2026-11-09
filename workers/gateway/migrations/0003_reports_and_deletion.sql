-- Nickname reports and account deletion (ADR 0008, 0019). Applied by the deploy workflow
-- before the gateway ships; `pnpm dev` applies it locally.

-- A player's report of another player's nickname. One open report per reporter and target;
-- moderators close it (the moderation queue is later work).
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The nickname as it was when reported: it may change before a moderator looks.
  target_nickname TEXT NOT NULL,
  reason TEXT NOT NULL
    CHECK (reason IN ('offensive', 'hateful', 'impersonation', 'personal_info')),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolved_at INTEGER
);

CREATE UNIQUE INDEX reports_one_open_per_pair ON reports (reporter_id, target_id)
  WHERE status = 'open';
-- The daily cap counts a reporter's recent reports.
CREATE INDEX reports_by_reporter ON reports (reporter_id, created_at);
CREATE INDEX reports_by_target ON reports (target_id);
CREATE INDEX reports_open ON reports (status, created_at);

-- Bans of accounts that were deleted, kept as an audit trail without any link to a person:
-- what was decided, by whom and when, not about whom.
CREATE TABLE bans_of_deleted_accounts (
  id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  lifted_at INTEGER,
  account_deleted_at INTEGER NOT NULL
);

-- Ids of deleted accounts. The op log still holds them until the season's ids are stripped
-- (ADR 0008); nothing maps them to a person any more, and they are never given out again.
CREATE TABLE deleted_accounts (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

-- Provider identities of recently deleted accounts, as keyed hashes (HMAC with the session
-- key) so no provider id is kept in the clear. A new account cannot be made from one until
-- the deleted account's last session token has expired (ADR 0019): otherwise delete and sign
-- up again would run several players, each with a starting item, from one provider account.
-- Rows older than that are pruned at the next deletion.
CREATE TABLE deleted_identities (
  hash TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

CREATE INDEX deleted_identities_by_time ON deleted_identities (deleted_at);

CREATE TRIGGER users_never_reuse_deleted_ids
BEFORE INSERT ON users
WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'deleted account id');
END;
