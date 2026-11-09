-- Team standings (ADR 0020): a D1 database of its own (binding STANDINGS), so the game Worker
-- never binds the accounts database. Applied by the deploy workflow before any script ships;
-- `pnpm dev` applies it locally. Times are ms since the epoch. Never edit an applied
-- migration: add the next one.

-- Each canvas's live counters per team, written by the canvas (CanvasDO) about once a minute
-- while they change. The gateway reads them for the ranking; nothing here names a player.
CREATE TABLE team_standings (
  canvas TEXT NOT NULL,
  -- A team id from the accounts database (teams.id); no foreign key across databases.
  team_id INTEGER NOT NULL,
  -- Cells on the map whose last writer counted for the team.
  cells INTEGER NOT NULL,
  built INTEGER NOT NULL,
  cleared INTEGER NOT NULL,
  shields INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (canvas, team_id)
);

CREATE INDEX team_standings_rank ON team_standings (canvas, cells DESC);
