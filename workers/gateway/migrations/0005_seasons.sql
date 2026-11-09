-- The season registry (ADR 0021). Applied by the deploy workflow before the gateway ships;
-- `pnpm dev` applies it locally. Each season is its own canvas (CanvasDO name, R2 prefix
-- `c/{canvas}`); the gateway routes sockets and pages to the one whose start has passed last.
-- A season's phase (scheduled, live, ended) follows from the times; whether its archive is
-- sealed lives in its CanvasDO. Written by admins (lane I), or by hand until then.
CREATE TABLE seasons (
  id INTEGER PRIMARY KEY,
  canvas TEXT NOT NULL UNIQUE
    CHECK (length(canvas) BETWEEN 1 AND 32 AND canvas NOT GLOB '*[^a-z0-9-]*'
      AND substr(canvas, 1, 1) <> '-'),
  starts_at INTEGER NOT NULL,
  -- Must agree with the end set on the canvas itself (CanvasDO.setSchedule), which enforces it.
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX seasons_by_start ON seasons (starts_at);
