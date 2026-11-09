# 0008. Where data lives, and personal data rules

- Status: accepted
- Date: 2026-10-23

## Context

Accounts, game state, team stats and moderation have very different access patterns. Data
read or written by every move needs to be consistent and fast; data written rarely but
searched (admin lookups, rankings) needs queries; big files need a CDN.

## Decision

| Data                                                                                                            | Lives in                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Accounts: user id, Google/Reddit/Discord identities, email, display name, avatar, created at, trust score, bans | D1                                                                                 |
| Sessions                                                                                                        | Not stored: signed tokens, signing key in Workers Secrets; bans checked from D1/KV |
| Inventory, cooldown, item draws                                                                                 | Durable Object SQLite (CanvasDO now, SessionDO later)                              |
| Grid, shields, op log                                                                                           | Durable Object SQLite + checkpoints; log segments to R2                            |
| Tiles, overviews, diff segments, season archives                                                                | R2 behind the CDN; archives bucket-locked and backed up off Cloudflare             |
| Teams, members, stats, rankings                                                                                 | D1, fed by counters flushed from DOs every 60 s                                    |
| Reports, moderation queue and actions                                                                           | D1                                                                                 |
| Last writer per cell (for rollback)                                                                             | Durable Object SQLite, internal only                                               |
| Admin config, season schedule, admin audit log                                                                  | Durable Object SQLite (CoordinatorDO later)                                        |
| Anti-abuse rules, thresholds, word lists                                                                        | KV, managed from the private ops repo                                              |
| Sponsor logos / list                                                                                            | R2 / D1                                                                            |
| Secrets (item-draw PRF key, token signing key, OAuth secrets)                                                   | Workers Secrets                                                                    |
| Operational metrics                                                                                             | Workers Analytics Engine                                                           |

Personal data:
- **Email is stored** (from the OAuth provider) for account contact and recovery.
- The op log keeps user ids for moderation and rollback until **90 days after the season
  ends**; after that the ids are stripped and only anonymous ops remain for the timelapse.
- **Deleting an account** removes the account rows and the link from ops to the person; the
  cells they placed stay on the map, since cells belong to nobody.
- Public pages and archives never show who placed what.
- **Display name is a nickname the player chooses** at first sign-in (pre-filled from the
  provider's name). Proposed defaults, admin-configurable: 3–20 characters, unique
  case-insensitively, checked against the word list in KV, reportable from team and ranking
  pages, changeable once every 30 days; moderators can reset one.

## Consequences

- Storing email makes the account table personal data under GDPR/DSA: it needs the data
  download and delete flows in the profile screen, and a privacy policy that says so.
- Chosen nicknames are user content: they need the word filter, reporting and a moderator
  reset, and the sign-in and profile screens need a nickname field.
