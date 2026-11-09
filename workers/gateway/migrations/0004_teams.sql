-- Teams and team ranking (ADR 0020). Applied by the deploy workflow before the gateway ships;
-- `pnpm dev` applies it locally. Times are ms since the epoch.

-- A team. Open while it has an owner; it closes when the owner leaves or deletes their
-- account, and stays closed (its row is kept: cells on the map still count for it, and the
-- id is never given to another team).
CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- Lower-cased name: unique among open teams.
  name_key TEXT NOT NULL,
  -- Index into the 32-colour brick palette.
  color INTEGER NOT NULL CHECK (color BETWEEN 0 AND 31),
  -- NULL once closed: a closed team keeps no link to a person.
  owner_id TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  CHECK ((owner_id IS NULL) = (closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX teams_open_name ON teams (name_key) WHERE closed_at IS NULL;
-- One open team per owner.
CREATE UNIQUE INDEX teams_open_owner ON teams (owner_id) WHERE closed_at IS NULL;

-- An account's place in the teams: its current team (if any) and the times the rules count
-- from. A row exists once the account has joined or created a team.
CREATE TABLE team_players (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- NULL: in no team.
  team_id INTEGER REFERENCES teams (id),
  -- The last join (creating a team joins it): the next join waits 3 days from here.
  joined_at INTEGER,
  -- The last team this account created: the next creation waits 7 days from here.
  created_team_at INTEGER,
  -- 1 after the player's team closed under them: their next join does not wait.
  free_join INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX team_players_by_team ON team_players (team_id);

-- The standings the ranking reads live in their own database (STANDINGS,
-- workers/game/migrations), written by the canvas.
