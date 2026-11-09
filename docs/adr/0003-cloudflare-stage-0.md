# 0003. Cloudflare-only architecture, starting with one CanvasDO

- Status: accepted
- Date: 2026-10-23

## Context

The design review (design doc, tabs "Scale triệu CCU" and "Kiến trúc") found that one
Durable Object can hold the whole game until roughly 100–250k concurrent players; the first
limit hit is about 1,000 messages per second into one DO, not CPU. Beyond that the map must
be split into region DOs. Deploying a Worker restarts all of its DOs and drops their sockets.

## Decision

- Everything runs on Cloudflare: Workers, Durable Objects (SQLite), R2, D1, CDN, Access.
- Three Worker scripts: `gateway` (no DOs), `realtime` (FanoutDO), `game` (CanvasDO now;
  SessionDO, MapShardDO and CoordinatorDO later). Game deploys therefore keep sockets up.
- Stage 0 keeps the grid, inventories and op log in one CanvasDO. Ops go to it immediately;
  only outbound diffs are batched per 250 ms tick. The SQLite op log is the source of truth.
- Code is written for the split from day one: pure rules in `packages/core`, region-sized
  addressing, an inventory interface with reserve/commit/refund, per-tile subscriptions.
- Move to the next stage only on measured triggers (messages into CanvasDO above 500/s,
  apply p99 above 20 ms, CPU above 50%, or a map above 4096²).

## Consequences

Cheap and simple now (about $5–20 a month at 10k MAU). The split to region DOs later is a
transport change, not a rules rewrite. A single Rust writer on dedicated servers stays the
fallback if two-phase commits across regions prove too costly.
