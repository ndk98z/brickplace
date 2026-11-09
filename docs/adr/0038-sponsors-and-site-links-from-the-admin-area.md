# 0038. Sponsors and site links from the admin area

- Status: accepted
- Date: 2026-10-27
- Amends: 0006 (sponsor slots), 0037 (sponsor list and links from deploy variables)

## Context

ADR 0037 moved the sponsor list (`VITE_SPONSORS`), "Become a sponsor" (`VITE_SPONSOR_INFO_URL`)
and the Ko-fi page (`VITE_KOFI_URL`) out of the code and into deploy variables, with logos
committed under `apps/client/public/sponsors/`. Changing a sponsor therefore takes a variable
change, sometimes a commit, and a redeploy. Sponsors are sold per season and often for part of
one, so the owner wants to add, schedule, reorder and remove them from the admin area (ADR 0022)
without a deploy. Logos must stay same-origin (`apps/client/src/config.ts`): a sponsor's
server must never see players' requests.

## Decision

1. **Sponsors belong to a season and show in a window.** Table `sponsors` in the accounts
   database (gateway migration 0007), beside `seasons`, holds each sponsor's season `canvas`,
   `name` (at most 40 characters), `href` (https), optional `logo`, `shows_from` and
   `shows_until` (ms, inside the season's times when written), `featured`, `hidden` and
   `position`. A partial unique index keeps one featured sponsor per canvas. The admin Worker
   writes it through its existing `ACCOUNTS` binding (ADR 0022's blast radius, unchanged), and
   the gateway reads it. Owners change sponsors; moderators only read them. Every change is
   in the audit log.
2. **Logos live in a private R2 bucket, `brickplace-sponsors-<env>`, and are served by the
   gateway.** The admin page uploads a still PNG or WebP of at most 256 KB, 64 to 2048 px a
   side. The admin Worker checks the file's signature and dimensions itself and refuses
   animated files (APNG, animated WebP), then stores it under its SHA-256
   (`logos/<hash>.<png|webp>`). The gateway serves it at `/api/sponsor-logos/<hash>.<ext>`
   only while a sponsor row names it, with a one-day cache, `nosniff` and a
   `default-src 'none'` CSP. The bucket gets no public domain. SVG is refused because it can
   carry script.
3. **Site links** ("Become a sponsor", Ko-fi) are rows of `site_links` in the same database,
   https only, set by owners.
4. **The client reads both at run time.** `GET /api/sponsors` answers the current canvas's
   sponsors showing now: not hidden, featured first, then by position, at most five
   (ADR 0006), plus the links. It is edge-cached for 60 s, so a change shows within a few
   minutes. The game screen and the contributors page fetch it at load. While it fails, or
   while it lists no sponsor, they fall back to the build's `VITE_*` values. A link left unset
   in the admin area also falls back to its variable.

## Consequences

- Moving over: the build's sponsors stay on screen until the first one is entered here. Logos
  committed as SVG must be uploaded again as PNG or WebP. To show no sponsor at all, clear
  `VITE_SPONSORS` too.
- Sponsors and both links change without a deploy. The `VITE_SPONSORS`,
  `VITE_SPONSOR_INFO_URL` and `VITE_KOFI_URL` variables remain only as fallbacks; the operator
  details (ADR 0037) stay deploy variables.
- Each environment needs the bucket created once (`docs/ops/setup.md`, step 2) before the
  gateway and admin Workers deploy with the new `SPONSOR_LOGOS` binding.
- Logo files stay in the bucket when a sponsor is deleted (small, content-addressed), but the
  site stops serving one as soon as no sponsor names it, and caches drop it within a day. A
  takedown needs only the sponsor deleted or its logo replaced.
- Each logo request a browser has not cached costs one D1 read and one R2 read: the Worker's
  answer is not kept by the edge. Hiding a sponsor keeps its logo served; deleting it or
  replacing its logo does not.
- One more D1 read per edge-cache miss on `/api/sponsors`.
