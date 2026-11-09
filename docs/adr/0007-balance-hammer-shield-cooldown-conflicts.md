# 0007. Balance: hammers, shield decay, fixed cooldown, first-come conflicts

- Status: accepted
- Date: 2026-10-23

## Context

The scale review (design doc, tab "Scale triệu CCU") proposed several balance rules. The
owner decided four of them before the inventory and core work starts.

## Decision

1. **Hammers: no extra limit.** A hold of 3 can unload three hammers at once; bursts are
   handled by drop rates (ADR 0005) and anti-bot measures, not by a hammer cooldown.
2. **Shield decay: each layer expires 48 hours after it was placed** (admin-configurable).
   Keeping art protected needs players who keep defending it.
3. **Cooldown stays fixed** (60 s by default) and is changed by admins by hand. Automatic
   scaling with concurrent players waits for real player data.
4. **Conflicts: first op to reach the authoritative object wins.** The later op is rejected
   and its item refunded. No per-tick random ordering for now; revisit with regional DOs.

## Consequences

- Shield decay makes the core time-dependent. `apply()` must take a logical timestamp
  carried in the op log (never `Date.now()`), so replay and golden fixtures stay
  deterministic. Expiry times are stored only for shielded cells (sparse), not per cell.
- Golden fixtures need cases for shield expiry at, before and after 48 h.
- Players far from the APAC region lose close contests; accepted for now.
- Still open: season-start staggering, end-of-season anti-sniping, an automatic PR review
  workflow (PROGRESS.md, Open decisions).
