---

name: new-adr
description: Record a decision as docs/adr/NNNN-title.md. Use when a choice changes game rules, the wire protocol, storage, Durable Object layout, deploy flow, licensing, or anything a future contributor would ask "why?" about.
---

# New ADR

1. Find the next number: the highest `docs/adr/NNNN-*.md` plus one, four digits.
2. Create `docs/adr/NNNN-short-kebab-title.md` from this template:

   ```markdown
   # NNNN. Title in sentence case

   - Status: proposed | accepted | superseded by NNNN
   - Date: YYYY-MM-DD

   ## Context
   What forces the decision. Numbers, limits, links.

   ## Decision
   What we will do, in one or two short paragraphs.

   ## Consequences
   What becomes easier, what becomes harder, what we must watch.
   ```

3. Keep it under a page. Link the design doc section or PR it came from.
4. If it supersedes an older ADR, update the old one's Status line.
