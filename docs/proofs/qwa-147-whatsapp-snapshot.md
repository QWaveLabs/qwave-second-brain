# QWA-147 — Private WhatsApp snapshot boundary proof

## Delivered boundary

QWA-147 now provides a real, bounded local-file reader for a documented
personal WhatsApp snapshot format. It is not a live WhatsApp connection and it
does not parse WhatsApp's native ZIP export. The only accepted format is an
uncompressed **QWave WhatsApp Snapshot Bundle v1** inside an explicitly chosen
private local root:

- one `*.qwave-wa.json` metadata manifest;
- one or more per-chat `.jsonl` message segments; and
- optional opaque `.bin` media files.

The connector constructor and all getters perform zero filesystem operations.
After the customer confirms the export and explicitly approves local import,
preflight opens only the manifest. Selected JSONL/media bodies remain unopened
until a granular, immutable QWA-139 grant exists.

The implementation never opens WhatsApp, never exports on the customer's
behalf, never sends/edits/deletes a message, and exposes no source-write API.

## Bundle v1 schema

The manifest accepts only this metadata shape (values below are illustrative):

```json
{
  "format": "qwave.whatsapp-snapshot-bundle/v1",
  "generation": "export-generation-1",
  "capturedAt": "2026-08-17T11:30:00.000Z",
  "account": { "id": "local-account-id", "label": "Private account label" },
  "people": [
    { "id": "person-id", "label": "Private person label", "accessLevel": "allowed" }
  ],
  "chats": [
    {
      "id": "chat-id",
      "label": "Private chat label",
      "type": "direct",
      "participantIds": ["person-id"],
      "sensitivity": "general",
      "media": "present",
      "mediaInventory": [
        {
          "id": "media-id",
          "segmentId": "segment-id",
          "messageId": "message-id",
          "path": "media/item.bin",
          "sha256": "<64 lowercase hex characters>",
          "bytes": 123,
          "mimeType": "application/octet-stream"
        }
      ],
      "segments": [
        {
          "id": "segment-id",
          "path": "segments/chat-1.jsonl",
          "sha256": "<64 lowercase hex characters>",
          "bytes": 123,
          "count": 1,
          "from": "2026-08-10T12:00:00.000Z",
          "to": "2026-08-10T12:00:00.000Z"
        }
      ]
    }
  ]
}
```

Manifest, account, person, chat, segment, and media-inventory objects reject
unknown fields. That means `body`, `content`, `text`, message arrays, media
bodies, and similar content cannot be smuggled into metadata preflight. The
inventory is bounded during preflight and binds every opaque media ID to one
chat, segment, and message plus one relative path, byte size, SHA-256 digest,
and allowlisted inert MIME type. `media: "none"` requires an empty inventory;
`media: "present"` requires a non-empty one.

Each JSONL line is opened only after grant and accepts exactly:

```json
{
  "id": "message-id",
  "chatId": "chat-id",
  "senderId": "person-id",
  "sentAt": "2026-08-10T12:00:00.000Z",
  "sensitivity": "general",
  "text": "Untrusted message body",
  "media": [
    {
      "id": "media-id",
      "path": "media/item.bin",
      "sha256": "<64 lowercase hex characters>",
      "bytes": 123,
      "mimeType": "application/octet-stream"
    }
  ]
}
```

Bodies are parsed only to produce inert opaque references. Message text and
media bytes are never returned or persisted by the public lifecycle.

## Permission and privacy behavior

The guided English/Spanish flow is one action at a time:

1. offer a personal, local, non-live snapshot;
2. require customer confirmation of the exact capture time;
3. require explicit manifest-preflight approval;
4. show alias-only metadata and require explicit chat, Allowed-person, date,
   sensitive-category, and media choices;
5. persist the immutable selection;
6. require the exact QWA-139 read-only grant; and
7. read only grant-bound segments/media and return opaque references.

Selection is fail-closed:

- every selected chat participant must be explicitly classified `allowed`;
- the selected people must exactly equal the participant union for the chosen
  chats, so an unrelated Allowed person cannot be added;
- sensitive approvals must exactly equal the chosen chats' sensitivities;
- dates must be strict UTC timestamps, remain inside the reviewed window, and
  end no later than capture;
- media must be an explicit boolean and is immutable in the grant; and
- the normalized selected media inventory is bound into the snapshot,
  selection, grant, fetch plan, and unit receipts;
- unknown access, sensitivity, participants, media state, MIME type, or record
  metadata stops processing.

Raw account/person/chat/group/message/media IDs, raw labels, the manifest's raw
generation, local roots, relative filenames, the full manifest digest, and
per-segment/media digests stay inside connector memory or the customer-owned
manifest. Private durable state retains opaque snapshot and selection bindings
needed for replay defense, but never the raw mapping, raw generation, full
manifest digest, or per-content-file paths/digests. Public output exposes no
path or digest; it contains only local aliases such as `wa-account-*`, `wa-person-*`,
`wa-chat-*`, `wa-segment-*`, `wa-message-*`, and `wa-media-*`, generic labels, and an opaque
snapshot reference. The connector rejects a caller-supplied account reference
unless it already uses the local `wa-account-*` namespace. The unsupported
Business status boundary enforces the same account-alias rule.

Imported content is always inert and untrusted. It cannot change permission,
open links, reveal secrets, run actions, or write to WhatsApp.

## File and replay defenses

The connector canonicalizes the approved root only after import approval and
rejects:

- native ZIP and other compressed/archive formats;
- absolute, escaping, backslash, empty-component, overlong, or deeply nested
  content paths;
- files inside the code repository;
- symlinked or hard-linked files;
- non-regular files, changed file identities, size mismatches, digest
  mismatches, truncated JSONL, duplicate IDs, reused paths, and overlapping
  chat segments; and
- manifest replacement after review or connector/snapshot substitution.

The immutable manifest binding is revalidated immediately before each selected
segment and each selected media open. Each segment/media file is then opened
read-only with no-follow behavior, identity and byte bounds are checked across
the open, and its SHA-256 digest is verified before records or media references
are used. Reads allocate no more than the approved file size plus one sentinel
byte, so a concurrently growing file cannot turn a bounded import into an
unbounded read.

Default upper bounds are:

| Boundary | Limit |
| --- | ---: |
| Manifest | 512 KiB |
| People / chats / segments | 2,000 / 500 / 2,000 |
| Records | 50,000 |
| One JSONL segment / all JSONL | 8 MiB / 64 MiB |
| One JSONL line / message text | 256 KiB / 128 KiB |
| Media files | 500 |
| One media file / all media | 16 MiB / 128 MiB |
| Path characters / components | 1,024 / 64 |

Callers may only lower these limits.

## Durable failure, resume, and concurrency proof

- A durable pending save occurs before manifest preflight and before selected
  body access. If either save fails, the corresponding file is not opened.
- Metadata review correlation is preserved across an outer final-save failure;
  retry resumes the same generation instead of adopting an unrelated review.
- Review and grant identifiers cannot be reused across generations, and every
  public mutation requires the current numeric generation.
- Before adapter access can become body-readable, the lifecycle creates one
  exact grant identifier and durably records and reads back a pending activation
  journal bound to generation, review, snapshot, selection, and media inventory.
  Adapter preparation is separately read back as pending and non-readable. The
  generic active grant and the outer activation authorization must then each be
  durable and read back exactly before adapter activation. There is no durable
  save after activation, so the former active-before-save orphan seam no longer
  exists.
- No lifecycle secret, capability, credential, or authorization value crosses
  a connector method or request boundary. Each exact constructed connector is
  associated with module-private operation closures in a `WeakMap`; the
  lifecycle retrieves those closures without reading an application-controlled
  property. High-authority operations additionally consume a synchronous,
  one-shot, exact-operation authorization held only in the lifecycle module's
  own `WeakMap`. Exported public prepare/register/revoke/fetch methods always
  deny, so a caller-fabricated `active` grant cannot register itself or open a
  segment/media body.
- Lifecycle calls bypass subclass overrides and prototype monkeypatches. A
  wrapper or proxy is not the exact registered instance and is rejected before
  any wrapper property is read. The internal operation bridge is not exported
  from the package entrypoint; even a direct deep import cannot perform a
  high-authority operation without the matching one-shot authorization that
  only the lifecycle can create. Generic permission review receives a frozen
  internal metadata-only proxy whose content-read method always denies.
- A retry or supported process restart reconciles the exact pending identifier;
  it never invokes the supplied grant-ID factory again. Persistence, readback,
  scope reconciliation, preparation, and activation-readback failures all fail
  closed. Public fetch, deny, cancel, restart, resume, cleanup, and revoke remain
  blocked while activation is pending; after exact retry activates the one
  durable identifier, public revoke uses the existing exact durable revoke
  intent and private adapter readback before it reports `revoked`.
- Within the documented process-local boundary, every connector registration
  for an exact account/review/grant/snapshot binding is tracked together. Replay
  first revokes and reads back the prior authoritative registration as inactive,
  then activates the same durable identifier in the replacement connector.
  Public revoke invokes and reads back every possibly active tracked
  registration; any failure leaves the public lifecycle nonterminal,
  revocation-pending/unconfirmed, and content reads denied.
- The connector creates one bounded opaque work plan: every selected segment
  in deterministic order, followed by media units only when media was
  explicitly approved. No media unit can open until all segment receipts are
  durably present and their record media sets exactly match the manifest
  inventory.
- Before each segment or media open, the outer lifecycle persists an exact
  pre-read pending unit. The generic permission layer then persists an
  alias-only post-read receipt. Only a matching plan/unit receipt advances the
  outer cursor. The final processed state has an exact completion receipt over
  every ordered unit receipt.
- An outer cursor/final-save failure is reconciled from the generic unit
  receipt. After process restart, completed segments and completed media are
  never reopened; processing resumes at the first unit without a committed
  receipt.
- If the fetch outcome lacks a durable receipt, status becomes
  `fetch-interrupted`; there is no automatic retry. A customer must explicitly
  confirm retry. Only that unconfirmed unit may be retried; already committed
  units remain behind the durable cursor. A process death after a raw read but
  before its post-read receipt is inherently ambiguous, so the implementation
  blocks instead of claiming that unit completed.
- Deny, cancel, revoke, repeated revoke, restart, and cleanup are generation
  safe. Before any adapter revoke, the lifecycle persists and reads back an
  exact intent bound to generation, review, grant, snapshot, and selection. A
  pending intent is a one-way gate: fetch, grant restore, grant, resume,
  restart, cancel, denial, and cleanup cannot run; only exact revocation retry
  is allowed. After process loss, retry invokes only revoke and confirms exact
  grant readback before final `revoked`. A nonthrowing but lying revoke remains
  `revoke-unconfirmed`, blocks processing, and exposes only a retry action.
  Revoke is idempotent in process and never mutates source files.
- All full-root permission and WhatsApp transactions use the canonical
  process-local re-entrant lock. Internal specialized permission primitives may
  re-enter; descendant state-store callbacks invoking a public revoke or
  cross-source write are rejected before they can save, preventing a stale
  outer save from erasing or resurrecting state. Connector overrides are not
  lifecycle callbacks and are bypassed by the exact-instance private operations.

Cleanup clears connector-private maps, and bounded file byte buffers are zeroed
after each read. The implementation makes no claim about JavaScript garbage-
collection timing for temporary parsed strings. It creates no staging files and
deliberately does not delete the customer-owned export; the customer retains it
until they delete it.

## Official WhatsApp Business truth

No registered shared host provider exists in this release. Therefore every
public WhatsApp Business path is unconditionally:

- `status: "unsupported"`;
- `live: false`;
- `verified: false`; and
- source/content access not started.

Caller-supplied contracts, fake evidence, stale evidence, and simulated claims
are not invoked or accepted. This ticket does not claim live Business access.

## Automated evidence

All evidence uses generated temporary fixtures only. No customer export,
WhatsApp account, network service, or live source was accessed.

Historical scoped verification captured before the combined integration:

| Command | Result |
| --- | ---: |
| `npm run test:qwa-147` | 67/67 passed |
| `npm run test:qwa-139` | 10/10 passed |
| `npm run test:qwa-142` | 8/8 passed |
| `npm run test:qwa-150` | 6/6 passed |
| `npm test` | 114/114 passed |
| `node --check` over source/test/test-support `*.mjs` | 21/21 passed; no `test-support` directory exists |
| process-leak check after tests | 0 matching Node/npm test processes |
| `git diff --check` | passed |

Current combined integration verification (managed sandbox, 2026-08-19):

| Command | Result |
| --- | ---: |
| `npm run test:qwa-147` | 67/67 passed |
| `npm run test:qwa-142` | 9/9 passed |
| `npm run test:qwa-150` | 7/7 passed |
| `npm test` | 268/277 passed; only the nine known QWA-146 detached-worker sandbox exceptions failed |
| `node --check` over changed `*.mjs` | passed |
| `git diff --check` | passed |

This current local integration evidence remains fixture-only and makes no
live WhatsApp, customer-export, or production claim.

The focused suite covers zero-I/O construction, manifest-only lazy preflight,
raw-value scans of public and persisted state, exact membership/sensitivity,
no-media and approved-media reads, hostile instructions, malformed/oversize/
truncated files, archive/path/symlink/hardlink/repository defenses, manifest and
file replacement, timestamp/skew/record-capture rules, connector substitution,
generation replay, all durable save seams, explicit retry, idempotency,
concurrent fetch/revoke/cross-source writers, same-context callback re-entry,
terminal revoke recovery, exact-grant revoke readback against a lying adapter,
pre-adapter revoke-intent save failure, process-loss revoke retry without grant
restore, manifest media-inventory substitution/extra/missing attacks with zero
media opens, multi-segment late-failure and process-restart zero-reread proofs,
ordered completion receipts, duplicate segment membership, media-excluded
zero-open behavior, cleanup/restart truth, Spanish behavior, Business forgery
rejection, and the former post-activation save seam. That regression leaves the
first exact candidate durably pending and non-readable, rejects a direct fetch
without changing record/body-read counters, restarts with a fresh connector,
proves a deliberately different retry factory is never called, activates only
the original exact identifier, and publicly revokes it while the unused second
candidate remains inactive. Public and durable-state scans include raw account,
person, chat, segment, message, media, label, path, manifest-generation, and
digest values.

The suite also imports the exported local connector directly and proves that a
caller-fabricated active grant causes zero registration, record, message-body,
media-file, and media-body reads. A two-instance replay regression proves that
the original registration is revoked before the replacement becomes
authoritative, that a retry factory proposing another ID is never called, and
that public revoke confirms both registrations inactive before reporting the
durable grant revoked. A post-revoke fetch remains denied with every body-read
counter unchanged.

Adversarial connector regressions also run a legitimate guided review and
grant through an inspecting application subclass, then attempt a fabricated
direct activation and fetch. Every subclass override sees zero legitimate
lifecycle requests, no lifecycle credential is observable or reusable, and
the fabricated operations leave file/body-read counters unchanged. An
application proxy is rejected by exact instance identity without invoking its
property trap. A separate prototype-monkeypatch regression replaces every
public connector operation with an interceptor and proves that legitimate
review, grant, fetch, and revoke complete with zero interceptions.

## Honest release limitations

- This is a local normalized snapshot contract, not native WhatsApp ZIP
  support and not an exporter.
- Personal and Business access both remain non-live.
- Only synthetic bundles were verified; no real/customer WhatsApp data was
  accessed in this ticket.
- The state lock is in-process only. This work does not claim cross-process or
  multi-host atomicity; a future durable state-store transaction contract is
  required for that.
- A process death between a body read and its durable post-read receipt cannot
  prove whether that one pending unit completed. It remains blocked and needs
  an explicit retry; the implementation does not reread any earlier committed
  unit.
- Source export files remain customer-owned on disk and are not deleted by the
  application.
