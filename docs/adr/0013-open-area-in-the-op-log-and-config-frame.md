# 0013. Open-area growth: automatic, in the op log, sent to clients

- Status: accepted; default step amended by 0027 (128 cells)
- Date: 2026-10-24

## Context

The open area only grows during a season (ADR 0004). The core already had `setOpenArea`,
but nothing grew the area and nothing recorded a growth, so a replay of the op log would
have rebuilt the grid with the starting area: ops accepted after a growth would replay as
`out_of_area` and their cells would vanish. Clients hard-coded the Stage 0 area and the
shield cap, so a grown area would have been drawn closed, and the cap could not change
without a client build.

## Decision

1. **The canvas grows the area by itself.** After every batch with an accepted op, if
   filled cells reach `atPercent` of the open area, the area grows by `step` cells on each
   side, clamped to the map; once the whole map is open it stops. Both values are pinned in
   the canvas's stored config (`growth`, default 70% and 256 cells, the design doc's
   threshold and ADR 0004's step; configs stored before this get the defaults pinned).
   The rule is the core's `nextOpenArea` (integers only), used by CanvasDO and the season
   simulation alike. `CanvasDO.setOpenArea` grows the area for admins. Growth driven by
   fill rate instead of a threshold stays an open owner question; it would change only
   when the check fires.
2. **A growth is an op log entry.** `{"kind": "open", x, y, w, h}` is written as its own
   `op_log` row, right after the batch that crossed the threshold and in the same
   transaction (the reply names its seq as `grewAt`), and replayed by the
   core's `applyEntry` (player ops go through `apply`, unchanged). Replay never re-derives
   a growth from the fill, so a later change of the threshold cannot change history. The
   row takes a seq, changes no cell and takes no time: the logical clock moves only with
   accepted ops, so shield decay replays the same. A rectangle that does not contain the
   current area, or leaves the map, is refused and logged nowhere. Golden fixture
   `open-area-growth` pins the replay for any port of the rules.
3. **Rules reach clients in a config frame** (server opcode 0x84, appended, no
   `PROTOCOL_VERSION` bump): map size, open area and `maxShield`. FanoutDO sends it after
   the initial grid, to every socket when a batch result or resync brings newer rules
   (each carries the canvas seq it was read at, so a late reply cannot shrink the area
   back), and again to open sockets after it is evicted. Clients use their built-in
   defaults only until it arrives; a move outside the area they know still only warns
   (`shouldSend`).

## Consequences

- Checkpoints and log trimming must carry the open area: a checkpoint taken after a growth
  has to store the grown area (or the growth row must stay in the replayed tail), or a
  restore from it replays later ops against the old area.
- An automatic growth costs FanoutDO nothing: it moves its mirror past the `grewAt` row,
  which carries no diffs. An admin growth costs one resync (a full snapshot) at the next
  op. With the defaults the area grows twice a season on the 2048² map
  (1024² → 1536² → 2048²).
- An automatic growth reaches clients with the reply to the batch that triggered it; an
  admin growth with the next accepted op, a resync or a reconnect.
