-- Sponsors and site links, set from the admin area (ADR 0038). Applied by the deploy workflow
-- before the gateway ships; `pnpm dev` applies it locally. Written by the admin Worker through
-- its ACCOUNTS binding, read by the gateway for GET /api/sponsors.

-- One row per sponsor of one season's canvas (seasons.canvas, or Stage 0's `canvas`). It shows
-- from shows_from until shows_until (ms) unless hidden; the admin Worker keeps the window
-- inside the season's times when it writes. Featured first, then by position.
CREATE TABLE sponsors (
  id INTEGER PRIMARY KEY,
  canvas TEXT NOT NULL CHECK (length(canvas) BETWEEN 1 AND 32),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  href TEXT NOT NULL CHECK (substr(href, 1, 8) = 'https://' AND length(href) <= 500),
  -- R2 key in the sponsors bucket (`logos/<sha256>.<png|webp>`); null shows the name.
  logo TEXT CHECK (logo IS NULL OR length(logo) <= 100),
  shows_from INTEGER NOT NULL,
  shows_until INTEGER NOT NULL CHECK (shows_until > shows_from),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX sponsors_by_canvas ON sponsors (canvas, position);
-- ADR 0006: one featured sponsor per season.
CREATE UNIQUE INDEX sponsors_one_featured ON sponsors (canvas) WHERE featured = 1;

-- Links the client shows: "Become a sponsor" and the Ko-fi page. An absent row falls back to
-- the build's VITE_* value (ADR 0037).
CREATE TABLE site_links (
  key TEXT PRIMARY KEY CHECK (key IN ('sponsor_info', 'kofi')),
  url TEXT NOT NULL CHECK (substr(url, 1, 8) = 'https://' AND length(url) <= 500),
  updated_at INTEGER NOT NULL
);
