-- Moderation (ADR 0023). Applied by the deploy workflow before the gateway ships; `pnpm dev`
-- applies it locally. Times are ms since the epoch.

-- A moderator's reset of a nickname (or team name) to a neutral placeholder: set until the
-- player (or team owner) chooses a new name, which the 30-day rename limit does not hold up.
-- While set, the account counts as having no nickname: it watches until it chooses one.
-- The name a reset removed (lower case) is kept beside it, so the same account or team cannot
-- choose it straight back.
ALTER TABLE users ADD COLUMN nickname_reset_at INTEGER;
ALTER TABLE users ADD COLUMN nickname_reset_key TEXT;
ALTER TABLE teams ADD COLUMN name_reset_at INTEGER;
ALTER TABLE teams ADD COLUMN name_reset_key TEXT;

-- Reports may now name a team (reason `team_name`) instead of a player. SQLite cannot change a
-- CHECK, so the table is rebuilt with its rows and indexes. Nothing references `reports`.
PRAGMA defer_foreign_keys = true;

CREATE TABLE reports_new (
  id INTEGER PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Exactly one target: a player, or a team (teams are never deleted, only closed).
  target_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  target_team_id INTEGER REFERENCES teams (id),
  -- The nickname, or the team name, as it was when reported: it may change before a
  -- moderator looks.
  target_nickname TEXT NOT NULL,
  reason TEXT NOT NULL
    CHECK (reason IN ('offensive', 'hateful', 'impersonation', 'personal_info', 'team_name')),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolved_at INTEGER,
  CHECK ((target_id IS NULL) <> (target_team_id IS NULL)),
  -- A team is reported for its name, a player for one of the nickname reasons.
  CHECK ((target_team_id IS NOT NULL) = (reason = 'team_name'))
);

INSERT INTO reports_new (id, reporter_id, target_id, target_team_id, target_nickname, reason,
  created_at, status, resolved_at)
SELECT id, reporter_id, target_id, NULL, target_nickname, reason, created_at, status, resolved_at
FROM reports;

DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;

-- One open report per reporter and target, for each kind of target.
CREATE UNIQUE INDEX reports_one_open_per_pair ON reports (reporter_id, target_id)
  WHERE status = 'open' AND target_id IS NOT NULL;
CREATE UNIQUE INDEX reports_one_open_per_team_pair ON reports (reporter_id, target_team_id)
  WHERE status = 'open' AND target_team_id IS NOT NULL;
-- The daily cap counts a reporter's recent reports.
CREATE INDEX reports_by_reporter ON reports (reporter_id, created_at);
CREATE INDEX reports_by_target ON reports (target_id);
CREATE INDEX reports_by_team ON reports (target_team_id);
CREATE INDEX reports_open ON reports (status, created_at);
