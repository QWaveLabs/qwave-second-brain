# QWave Second Brain

QWave Second Brain is a guided, local-first way to build a private Obsidian
Second Brain with Codex. Instead of handing someone a setup checklist, a shell
script, or a pile of integrations, QWave gives them one normal-language prompt.
Codex pulls this public repository, takes care of the technical work, and asks
only the next question that genuinely needs the person's answer.

The public repository is the setup playbook and safety boundary. The person's
Second Brain, setup state, source permissions, raw imports, and credentials stay
on their Mac. They do not belong in this repository.

## Start here

Send a customer the exact prompt in [CUSTOMER_PROMPT.md](CUSTOMER_PROMPT.md).
They paste it into Codex Desktop. There are no Terminal steps, slash commands,
or Git instructions for the customer to follow.

Codex will:

1. Clone this public QWave repository and read its customer-setup instructions.
2. Check safely for a protected setup it can resume.
3. If none exists, ask whether to create a new Second Brain or continue an
   existing one.
4. Handle ordinary local setup itself and pause only for a sign-in, a privacy or
   security choice, or a specific source permission.
5. End with a plain-English account of what is ready, imported, skipped,
   beta-only, or blocked.

The first question should feel like a conversation, not an installation:

> Would you like to create a new Second Brain or continue an existing one?

## Why this exists

Most people already have useful context scattered across notes, meetings,
calendar events, email, files, and messages. The hard part is not merely
collecting it. It is deciding what belongs in a durable knowledge base, what is
sensitive, what should stay local, and how to recover safely when setup pauses.

QWave Second Brain is designed to make that first setup calm and deliberate:

- **One guided conversation.** The person says what they want in ordinary
  language; Codex does the technical work.
- **Customer ownership.** The resulting vault is private and customer-owned,
  rather than an account inside a hosted QWave product.
- **Permission before content.** A source is reviewed as metadata first. Codex
  does not read source bodies until the person approves the exact scope.
- **Resumable progress.** Protected setup state lets the conversation continue
  after a pause without recreating a vault or silently repeating a source read.
- **Truthful status.** A simulation, a partial result, a skipped source, and a
  verified live connection are never presented as the same thing.

This is not a promise that every personal data source should be connected. The
point is a useful private operating surface with deliberate boundaries.

## How the system behaves

~~~mermaid
flowchart LR
    A[Customer sends one prompt] --> B[Codex clones public QWave setup code]
    B --> C[Read-only check for a protected setup]
    C -->|Found| D[Resume saved guided session]
    C -->|Not found| E[Ask one setup question]
    E --> F[Create and validate a private local vault]
    F --> G[Optional source review]
    G -->|Customer grants an exact scope| H[Read-only import or snapshot]
    G -->|Customer declines or skips| I[Leave source untouched]
    H --> J[Truthful final status]
    I --> J
~~~

The public repository contains code and guidance only. The vault and source data
flow the other way: into a private local setup under the customer's control.

### A normal-language start and resume

The setup session accepts ordinary messages such as "Set up my second brain" or
"Continue setting up my second brain." It deliberately rejects slash commands
as the customer-facing entry point. A resume is meant to reuse the protected
setup state rather than start over.

### A safe local foundation

The first setup flow is structured around five stages:

| Stage | What Codex verifies or prepares |
| --- | --- |
| Environment | The supported local environment is present and understandable. |
| Obsidian | The official app path is inspected before any vault handoff. |
| Foundation | The customer's core direction, language, scope, and privacy choices can be gathered in small guided batches. |
| Vault | A new Desktop-visible vault is planned before creation; an existing customer folder is never overwritten. |
| Validation | The expected vault location and starting files are checked before calling the setup ready. |

If Obsidian needs attention, Codex should describe the official next action in
plain English and wait for approval. It should not silently install software,
guess which vault window is active, or pretend an unverified window is the new
vault.

### One question at a time

Codex should not turn setup into an interview. It asks a question only when the
customer's decision changes the result, for example:

- whether to make a new vault or resume one;
- whether to approve the official Obsidian installation action;
- the name and location of a new private vault;
- whether to connect a source at all; or
- the exact scope of a read-only source permission.

Everything else that is safe and local is Codex's work to perform.

## Privacy model

The privacy model is deny-by-default. "Connect my calendar" is not permission
to read every event, attachment, participant, message, or file.

For every optional source, the intended pattern is:

1. **Metadata review.** Identify only the available source, account, folders,
   date range, labels, or other safe summaries needed to propose a scope.
2. **Customer review.** Show the proposed scope in plain language.
3. **Specific Permission Grant.** Proceed only after the person approves that
   exact scope.
4. **Read-only handling.** The source is never modified by this setup flow.
5. **Private, bounded processing.** Approved material is treated as untrusted
   reference material, not automatic truth.
6. **Truthful result.** State whether the result is verified, partial, skipped,
   simulated, beta-only, or blocked.

Sensitive categories, source boundaries, participants, media, and date ranges
are intended to remain part of the permission decision. A later retry cannot
widen an earlier review by accident.

### What never belongs in this public repository

- Customer vaults and generated notes
- Raw staging or source exports
- Local setup state and caches
- Credentials, tokens, or environment files
- Customer contacts, message bodies, or filenames that reveal private context
- A public Git history of a customer's Second Brain

The repository's scrub check rejects common protected folders, credential-like
files, obvious secret patterns, and oversized files. That is a guardrail, not a
substitute for human judgment before publishing future changes.

## Sources and connectors: current truth

The repository contains carefully bounded lifecycle code for several sources.
That does **not** mean a live customer account has been connected. The table
below distinguishes the design and test coverage from real-world evidence.

| Source | Intended behavior | Current release truth |
| --- | --- | --- |
| Gmail | Metadata-first, read-only review; approved references rather than a broad mailbox scrape. | Lifecycle and simulated-plugin tests exist. A real mailbox connection has not been verified in this release. |
| Google Calendar | Separate read-only review with scoped events; sensitive titles, attendees, and details stay behind approval. | Lifecycle and simulated-adapter tests exist. No live calendar connection is claimed. |
| Google Drive | Folder-bounded, metadata-first review before an approved folder scope. | Lifecycle and simulated-plugin tests exist. No live Drive import is claimed. |
| Slack | Read-only lifecycle with shared-permission safeguards. | Tested with a simulated official-plugin seam. No live workspace connection is claimed. |
| iMessage | A local snapshot/beta path with explicit macOS approval and separate sensitive-content approval. | Beta only. No real Messages database, iCloud synchronization, or live iMessage access has been verified. |
| WhatsApp | A bounded local snapshot/export path; official Business connection has its own verification boundary. | Snapshot contracts are tested. An official Business connection is not claimed as live. |
| Generic exports | A safe, simulated export path for reviewed references. | Test adapter only; not evidence of a real third-party connection. |

If a source is unavailable, declined, unsupported, or only partially approved,
the right behavior is to say so and continue with the rest of the setup. A
useful Second Brain can start small.

## What the customer will see at the end

The final handoff uses a small status vocabulary so there is no ambiguity:

| Status | Meaning |
| --- | --- |
| **Live and verified** | A real capability was checked with the evidence needed to call it live. |
| **Imported once** | A bounded, approved import or snapshot completed without claiming ongoing sync. |
| **Skipped** | The customer chose not to connect or import that source. |
| **Beta-only** | A constrained experiment or snapshot path exists, but it is not a general live integration. |
| **Blocked** | Setup stopped safely because it needs a decision, sign-in, permission, or missing external evidence. |
| **Delivery unverified** | A local support report may exist, but the system cannot honestly prove it reached QWave. |

This vocabulary matters. It prevents an empty connector, a simulated adapter,
or a failed delivery from being turned into a false success story.

## Vault ownership, history, and backups

The public QWave repository is not the customer's vault repository.

The current design offers two possible directions for a customer's own history:

- **Local-only:** the private history stays on the customer's Mac. No remote
  backup is created or pushed.
- **Private remote:** before any customer history is initialized or pushed, the
  remote must be read back as private.

The current code includes the preflight and checkpoint-intent boundaries for
this decision. It does **not** yet prove a finished backup, restore, or
clean-Mac recovery journey. A public remote is never an acceptable destination
for customer vault history.

## Support behavior

If setup is blocked, Codex first attempts bounded safe recovery. It does not
send support traffic merely because someone mentions QWave support.

When a customer explicitly asks for help, the support boundary is designed to
create a small sanitized technical report. It excludes source content, contacts,
prompts, credentials, local paths, and sensitive filenames. A simulated relay
or local acknowledgement is not proof that an email or provider delivery
occurred. Without a host-verifiable receipt, the honest status is **delivery
unverified**.

## What this is not

QWave Second Brain is not:

- a hosted SaaS account or analytics product;
- a public database of the customer's notes;
- background surveillance, continuous capture, or a real-time sync claim;
- an automatic importer with permission to read everything;
- a source-writing automation; or
- a substitute for the customer's judgment about privacy.

The focus is a guided private foundation: a clear place to start, a safe way to
add context, and a record of what actually happened.

## Current release boundary

The public setup repository is live at
[QWaveLabs/qwave-second-brain](https://github.com/QWaveLabs/qwave-second-brain)
and defaults to main.

The automated setup, permission, retention, source-status, and public-prompt
contracts are locally tested. The following are still separate release gates:

- a real clean-Mac customer walkthrough using Codex and Obsidian;
- a genuinely live, read-only connector with verified scoped access;
- provider-backed support delivery evidence; and
- English and Spanish customer beta acceptance.

Until those gates are complete, this repository should be described as a
production-ready testing candidate, not a proven production customer rollout.

## For QWave operators

1. Send [CUSTOMER_PROMPT.md](CUSTOMER_PROMPT.md) to the customer.
2. Let Codex lead the setup conversation.
3. Stay available only if the customer needs account access, a sign-in, a
   privacy decision, or support.
4. Do not ask the customer to use Terminal, clone a repository manually, or
   choose a technical integration path.

The customer should always leave with a plain answer to: "What did we set up,
what did we connect, and what is still waiting on me?"

## Development verification

These commands are for QWave contributors and release reviewers, not customers:

    npm test
    npm run scrub
    npm run diagnose

They verify local code and package boundaries. They do not prove a live
connector, provider delivery, or a completed clean-Mac customer journey.

## License and attribution

The setup source is [MIT licensed](LICENSE). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the AIS-OS attribution
boundary. Customer vaults and generated knowledge remain private and are not
automatically covered by this repository's license.
