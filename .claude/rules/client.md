---

paths:
- "apps/**"

---

# Client

- WebGL2 only for the map: one R8UI texture per 256x256 tile, palette lookup in the shader,
  `texSubImage2D` batched once per animation frame, no render loop while idle.
- The client is untrusted. It renders and sends intents; the server decides everything.
- Budgets: initial load under 400 KB, at most 250 KB/min of diffs while zoomed in.
