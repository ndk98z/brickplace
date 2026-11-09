# 0017. Op dedupe key: player, connection id, opId

- Status: accepted
- Date: 2026-10-24

## Context

CanvasDO remembers accepted ops by (player, opId) so a resend after an `unavailable` ack is
answered as a duplicate. The dev identity was per page load, so opIds never repeated under
one player. With accounts, one player id spans tabs, devices and reloads, and every new page
counts opIds from 1: a fresh op from a second tab, or after a reload, would be taken for an
old one and silently dropped (answered "accepted", applied nothing).

## Decision

- The key is **(player, client, opId)**. `client` is a random connection id the page makes
  once per `Connection` (with its opId counter) and sends as `?client=` on every reconnect.
  The gateway checks its form (`[A-Za-z0-9-]{8,64}`) and passes it in a header; FanoutDO keeps
  it in the socket attachment and passes it to `applyBatch` and `discard`.
- The client chooses it, but only inside its own player id, which the gateway sets; reusing
  another page's id can only confuse the player's own retries.
- CanvasDO moves its `recent_ops` rows to a new `accepted_ops` table with an empty client
  (what older FanoutDOs send), in one transaction on load. `discard` takes the client as a
  trailing argument so the deployed FanoutDO keeps calling it with three.
- Rejected: random 32-bit opIds. With thousands of a player's ops in the window, a birthday
  collision silently drops an op now and then, and the client could no longer use small
  sequential ids.

## Consequences

- Two tabs and reloads never collide; a retry still works across reconnects of one page.
- Game still deploys before realtime. An op in flight at the moment the
  new realtime script replaces the old one is keyed without a client first and with one on
  the resend, so it may apply twice (spending a second item if the player holds one).
- Window size and trimming (`DEDUPE_WINDOW`) are unchanged.
