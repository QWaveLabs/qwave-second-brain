# QWave Second Brain

QWave Second Brain is a local-first, customer-owned setup system for creating a
private Obsidian second brain through one guided Codex Desktop conversation.

## Customer start

Send the customer the exact prompt in [CUSTOMER_PROMPT.md](CUSTOMER_PROMPT.md).
They paste it into Codex
Desktop. Codex pulls this repository, reads its setup instructions, and starts
or resumes the guided setup. The customer never needs Terminal or commands.

## What this package is

- A public, QWave-branded repository and natural-language operating guide.
- A public QWave setup repository that Codex may clone after visibility readback.
- A guide for a separate, private customer vault on the Desktop.
- A release candidate with a resumable bootstrap handoff and Setup Session API.

It is not a hosted account, analytics service, license gate, automatic public
vault repository, or real-time background capture product.

## Current release boundary

The first usable handoff is this public QWave repository and one prompt; no
repository invitation or separate bootstrap is needed. Customer vault history
remains local-only or uses a verified private remote.

## Supported environment and diagnostics

The intended v1 path is a private macOS user account using Codex Desktop,
optimized for Sol, with English or Spanish guidance. The public installer
manifest records the installer version, state schema, support boundary, and
migration separation without reading a customer vault or source:

```text
npm run diagnose
```

That command is for QWave release verification, not a customer setup step.

## Privacy and ownership

Customer vaults, raw staging, credentials, local setup state, caches, and
environment files must never enter this installer repository. Connected source
applications remain read-only. No source body may be read before the customer
has granted the specific scope.

Generated vaults are privately owned and are not automatically MIT-licensed.
Customer Git history must remain local-only or use a remote whose private
visibility is read back before the first push.

## Release verification

```text
npm test
npm run scrub
npm run diagnose
```

These checks are local evidence only. They do not prove a live connector,
provider email delivery, a published remote, or a clean-Mac customer journey.

## License and notices

The installer source is [MIT licensed](LICENSE). See
[third-party notices](THIRD_PARTY_NOTICES.md) for the AIS-OS attribution rule.
