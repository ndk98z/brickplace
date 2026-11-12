# Security policy

## Reporting a vulnerability

Please report privately, never in a public issue, discussion or PR:
- GitHub: **Security → Report a vulnerability** on this repository (private vulnerability
  reporting).
- Email: [ndk98z.tech@gmail.com](mailto:ndk98z.tech@gmail.com), with "security" in the subject.

Include what you found, how to reproduce it, and the impact. We aim to acknowledge within
3 days and to agree on a fix and disclosure date within 14 days.

## In scope

- Server-side rule bypasses: getting items without waiting, choosing your own item, acting
  outside the open area, double-spending an item, acting as another player.
- Anti-cheat or rate-limit bypasses, including ways to run many accounts cheaply.
- Leaks of other players' identities or data.
- Anything that lets a client crash, stall or run up costs on the shared Durable Objects.

## Out of scope

- Volumetric DDoS, spam and social engineering.
- Rendering glitches with no security impact (open a normal issue).

## Supported versions

Only the version deployed at the official site and the `main` branch receive fixes.
