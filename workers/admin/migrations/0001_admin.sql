-- The admin area's own database (ADR 0022): roles, config versions and the audit log. Applied
-- by the deploy workflow before any script ships; `pnpm dev:admin` applies it locally.
-- Times are ms since the epoch. Admins are named by the email Cloudflare Access verified,
-- lower case.

-- Who may use the admin area, and as what. Owners add and remove roles from the admin page;
-- the first owner is inserted by the operator (`wrangler d1 execute`), never committed.
CREATE TABLE admin_roles (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'moderator')),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);

-- Every config version an admin made, as sent to the canvas. `version` is the canvas's number
-- for its scope; the canvas stores its own copy and picks it up at `effective_at`.
CREATE TABLE config_versions (
  -- Positive, so no row can share the -1 an auto-assigned id reads as in a BEFORE INSERT
  -- trigger (the no-replace triggers below compare ids).
  id INTEGER PRIMARY KEY CHECK (id > 0),
  canvas TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('items', 'growth')),
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  -- As requested (a past time means now); the canvas's own time replaces it on delivery.
  effective_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  -- Set once the canvas has stored the version.
  delivered_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  UNIQUE (canvas, scope, version)
);

CREATE INDEX config_versions_by_time ON config_versions (canvas, created_at);

-- A version's content and authorship never change, and versions are never deleted: only
-- delivery and cancellation are recorded later, once each.
CREATE TRIGGER config_versions_fixed
BEFORE UPDATE OF id, canvas, scope, version, json, created_by, created_at, note
ON config_versions
BEGIN
  SELECT RAISE(ABORT, 'config versions are fixed once made');
END;

-- Delivery fixes the effective time the canvas chose; neither goes back or changes after.
CREATE TRIGGER config_versions_delivered_once
BEFORE UPDATE OF delivered_at, effective_at ON config_versions
WHEN OLD.delivered_at IS NOT NULL
  AND (NEW.delivered_at IS NOT OLD.delivered_at OR NEW.effective_at IS NOT OLD.effective_at)
BEGIN
  SELECT RAISE(ABORT, 'config versions are fixed once delivered');
END;

CREATE TRIGGER config_versions_cancelled_once
BEFORE UPDATE OF cancelled_at, cancelled_by ON config_versions
WHEN OLD.cancelled_at IS NOT NULL
  AND (NEW.cancelled_at IS NOT OLD.cancelled_at OR NEW.cancelled_by IS NOT OLD.cancelled_by)
BEGIN
  SELECT RAISE(ABORT, 'config versions are fixed once cancelled');
END;

CREATE TRIGGER config_versions_kept
BEFORE DELETE ON config_versions
BEGIN
  SELECT RAISE(ABORT, 'config versions are never deleted');
END;

-- INSERT OR REPLACE (and REPLACE) delete the conflicting row without firing DELETE triggers,
-- so an insert that would replace a version is refused before it starts. The message names
-- the UNIQUE constraint, as a plain conflicting insert would.
CREATE TRIGGER config_versions_no_replace
BEFORE INSERT ON config_versions
WHEN EXISTS (
  SELECT 1 FROM config_versions
  WHERE id = NEW.id OR (canvas = NEW.canvas AND scope = NEW.scope AND version = NEW.version)
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE: config versions are never replaced');
END;

-- Every admin action that passed sign-in and validation, including those the game refused:
-- who, what, on what, the state before and after (JSON), why, and how it ended.
CREATE TABLE audit_log (
  -- Positive, for the same reason as config_versions.id.
  id INTEGER PRIMARY KEY CHECK (id > 0),
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  -- Cloudflare Access's user id (`sub`), which stays the same if the email changes.
  actor_sub TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT,
  reason TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'ok'
);

CREATE INDEX audit_log_by_actor ON audit_log (actor, id);

-- Append only, whatever code runs against the database.
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- REPLACE would delete the old row without firing the DELETE trigger.
CREATE TRIGGER audit_log_no_replace
BEFORE INSERT ON audit_log
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
