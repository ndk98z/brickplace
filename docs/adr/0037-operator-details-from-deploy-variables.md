# 0037. Operator details come from deploy variables

- Status: accepted
- Date: 2026-10-27

## Context

The repository will be public (ADR 0002). The client still carried the owner's details as
code: the operator's name and postal address and a personal email in the terms, privacy and
trademark pages, the owner's Ko-fi page as the Donate default, a sponsor `mailto:` constant,
and the repository URL in every "Source code" link. A fork that built and ran the client
unchanged would publish the owner as its operator and send its donations to the owner, and its
source links would point at the wrong repository (AGPL-3.0 section 13 asks for its own).

Moving only the game core to a separate public repository was considered and rejected: the
core, protocol, golden fixtures, Workers and client share one pnpm/Turbo workspace and one
`pnpm verify`; a split would need published packages and two-repo changes for every rule
change, while the private parts (secrets, abuse thresholds, moderation lists) already live
outside the repository.

## Decision

The code names no operator. The client reads who runs it from build-time variables
(`apps/client/src/instance.ts`): `VITE_OPERATOR_NAME`, `VITE_OPERATOR_ADDRESS`,
`VITE_CONTACT_EMAIL`, `VITE_SOURCE_URL`, `VITE_KOFI_URL`, plus the existing `VITE_SPONSORS`
and `VITE_SPONSOR_INFO_URL`. The static pages use `{{name}}` placeholders that a Vite plugin
fills, HTML-escaped, at build time. The deploy workflow passes the GitHub Actions
variables of the same names, set on the repository and shared by staging and production (an
environment may override one); the source URL defaults to the repository being deployed, and the
deploy build (`VITE_REQUIRE_OPERATOR=1`) fails when the operator's name, address or a valid
contact email is missing.

Unset, a build shows `[not configured]` in the legal pages, `#` for links, and no Donate or
sponsor link, so local and CI builds work and a fork never shows the owner's details.

## Consequences

- Changing the operator, address, contact or donation page is a variable change and a
  redeploy, not a commit. `docs/ops/setup.md` step 4.6 lists the variables.
- Staging and production deploys fail until the three operator variables are set.
- Jurisdiction-specific wording stays text: the governing law and courts in `terms.html` and
  the data protection authority in `privacy.html` (Viet Nam). They are legal terms, not
  contact details; a fork in another country edits them.
- `CODE_OF_CONDUCT.md` and `SECURITY.md` name the maintainer's reporting address in text:
  Markdown read on GitHub cannot take build variables. It is the project's contact, not a
  hosted copy's operator; a fork edits it.
- Git history still holds the old values; the fresh, squashed public repository (ADR 0002)
  is what removes them.
- `.github/FUNDING.yml`, `CODEOWNERS` and the contributors list still name the owner's GitHub
  account. That is repository metadata and authorship, not operator details, and stays.
