# Golden fixtures

Each file in `fixtures/` is a JSON op log plus the grid hash the core must produce after
applying it, and the expected accept/reject outcome of every op. Any implementation of the
rules (the TypeScript core today, a Rust port later) must reproduce these hashes exactly.
- Time: an op may carry `"at"`, its logical timestamp in milliseconds (shield decay,
  ADR 0007). An op without one happens at the latest time so far (0 at the start), and a
  time earlier than that counts as that time: the clock never goes back. `config` may set
  `shieldLifetime` (ms); without it a layer lasts 48 h.
- Open area: an entry `{"kind": "open", "x", "y", "w", "h"}` grows the open area at that
  point of the log (`applyEntry` in the core, as a server replay does). It must contain the
  current area and lie inside the map, otherwise it is `invalid` and changes nothing. It
  takes no time: its `at` is ignored and the clock moves only with accepted ops.
- Restore: an entry `{"kind": "restore", "cells": [[index, cell, ...expiries], ...]}` sets
  each listed cell (index `y * size + x`, by increasing index) to its cell byte and its
  shield layers, one expiry time each, oldest first (ADR 0024, moderation rollbacks). It is
  `invalid` and changes nothing when the grid it leaves would break an invariant: a filled
  cell outside the open area, an empty cell with bits or layers, a link bit that does not
  land on a filled cell of the same colour (from a listed cell or into one), more than
  `maxShield` layers, a layer expiring at or before the clock or after `clock +
  shieldLifetime`, unsorted times or indices. It takes no time, like `open`.
- Add a case: write a fixture with `"expectedHash": ""`, then run `pnpm golden:update`.
- Review the generated hash and outcomes before committing. A changed hash on an existing
  fixture means the rules changed: that needs an ADR, not a silent update.
