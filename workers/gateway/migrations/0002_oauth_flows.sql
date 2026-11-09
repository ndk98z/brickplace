-- Sign-in flows already finished (ADR 0015): each OAuth `state` is accepted once, so one
-- Turnstile pass and one flow cookie cannot be replayed to create account after account.
-- Rows are only needed until the flow would have expired anyway; callbacks prune them.

CREATE TABLE oauth_flows (
  state TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX oauth_flows_by_expiry ON oauth_flows (expires_at);
