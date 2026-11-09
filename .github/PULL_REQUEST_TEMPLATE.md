## What and why

<!-- One or two sentences. Link the issue or ADR. -->

## Checklist

- [ ] `pnpm verify` passes locally
- [ ] Commits are signed off (`git commit -s`, see CONTRIBUTING.md)
- [ ] Rule changes: golden fixtures updated and an ADR added
- [ ] Protocol changes: backward compatible, or `PROTOCOL_VERSION` bumped
- [ ] Durable Object `migrations` changed? Then this PR changes nothing else and needs the `do-lifecycle` label
- [ ] No secrets, abuse thresholds or moderation lists in code
