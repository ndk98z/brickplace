---

paths:
- "packages/core/**"
- "packages/protocol/**"
- "packages/golden/**"

---

# Core, protocol and golden rules

- `packages/core` is the only place game rules live. It must stay platform-free: no
  `cloudflare:*`, no Node APIs, no Date, no randomness, no I/O. Biome blocks
  `cloudflare:workers` and `node:crypto` imports; review catches the rest.
- Integers and typed arrays only. Same op log in, same grid hash out, in any language.
- `apply()` mutates the state in place and returns the changed cells; a rejected op must
  leave the state byte-for-byte unchanged.
- Any rule change updates golden fixtures through `/golden-case` and gets an ADR.
- Protocol frames are versioned. An incompatible change bumps `PROTOCOL_VERSION`; the
  server keeps decoding the previous version until clients have reloaded.
- Never name things after Tetris: say brick, shape, rotation, not tetromino.
