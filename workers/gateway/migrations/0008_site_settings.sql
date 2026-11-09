-- Site settings from the admin area (ADR 0039). Applied by the deploy workflow before the
-- gateway ships; `pnpm dev` applies it locally. Written by the admin Worker through its
-- ACCOUNTS binding, read by the gateway. One row per setting; keys are not limited here, so a
-- later setting needs no table rebuild, only its own CHECK below.

-- `player_cap`: how many may play at once, over every FanoutDO shard. An absent row means the
-- default in code (DEFAULT_PLAYER_CAP, 5,000); a row with a null value means no cap.
CREATE TABLE site_settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (key <> 'player_cap' OR value IS NULL OR value BETWEEN 0 AND 2000000)
);
