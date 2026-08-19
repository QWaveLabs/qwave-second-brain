# QWA-148 Slack channel and people boundaries proof (simulated)

Date: 2026-08-17

This proof exercises the public QWave Second Brain Setup Session extension with
a controlled, offline adapter for the official Slack-plugin seam. It does not
open a Slack workspace, begin OAuth, read a customer message body, retain a
workspace dump, post, react, edit, archive, invite, change Slack state, or use
customer credentials.

## Customer-visible guided path

After the normal, plain-language Setup Session, a customer can say:

> Please connect Slack to my second brain

The saved flow remains in the same conversation:

```text
plain-language Slack request
  -> explain the official-plugin seam and explicit read-only approval
  -> simulated non-writing verification
  -> complete metadata-only pagination review
  -> granular channel / DM / group / people / date permission grant
  -> bounded opaque stable-thread-reference processing
```

No slash command is required. The same guidance is covered in Spanish. Every
public result says that this is a **simulation-only** contract proof and keeps
`live: false`; it never represents the fixture as a connected live Slack
workspace.

## Read-only and privacy boundaries

Before any approved fetch, the customer can independently narrow:

- public channels;
- direct-message conversations;
- group-message conversations;
- Allowed, Restricted, and Blocked people; and
- the default previous-90-days date window.

The shared permission lifecycle now treats the Allowed-person selection as a
real allowlist: an omitted Allowed person is added to the connector-side
exclusions before the bounded fetch. Restricted and Blocked people remain
excluded.

Private channels, and channels whose visibility is unknown, are excluded
before they enter the metadata review. The status reports only a safe count;
it does not expose their names or identifiers. Every simulated Slack record
must carry a valid timestamp, so an undated record cannot bypass the date
boundary.

A group containing a Blocked person is listed only as an opaque group ID and
is skipped by default. It can be included only after a separate review and an
explicit confirmation for that exact reviewed group snapshot. The exception
cannot approve a different group, and any later participant, privacy, thread,
or metadata change fails closed and requires a new review. The body-capable
adapter receives the exact approved metadata snapshot at the fetch boundary,
revalidates it there, and restricts its source read to those reviewed record
IDs. The connector also receives the persisted one-group policy before the
fetch, so a generic grant containing an exception cannot by itself make a
blocked group readable.

The same atomic boundary binds the completed pagination summary and normalized
sensitivity snapshot. Pagination that becomes incomplete at fetch time fails
before body access. Unknown classifications remain `uncertain-sensitivity`:
they are excluded by default, but an explicit granular inclusion is both
integrity-checkable after resume and fetchable without exposing the adapter's
raw classification. If exclusions leave no approved record, the adapter makes
no body-capable call and the saved/public body-read counter remains zero.

The adapter exposes no write operation. The read-only verification proves that
posting, reactions, edits, archiving, invitations, and workspace-state changes
are all unavailable. Its counters remain zero for writes.

## Safe source references

An approved fetch returns only validated, inert references such as:

```text
slack:<local-workspace-alias>:<local-conversation-alias>:<local-thread-alias>
```

Each reference can include an opaque conversation ID, thread ID, and (when
available) opaque parent-thread ID. It does not contain a message body, title,
workspace name, permalink, attachment, participant profile, or raw channel
dump. Imported source material remains untrusted reference data and cannot
change scope or cause a write.

## Failure, resume, and truthful status

- An authorization denial becomes `skipped` without reading metadata or a
  message body, and can be retried later.
- Incomplete metadata pagination becomes `needs-attention`; no permission
  review or content fetch is created. A contradictory adapter claim of zero
  reviewed pages with a non-empty inventory is also rejected. Once pagination
  is complete and internally consistent, the saved setup resumes through a
  fresh metadata-only review.
- A revoked plugin response deactivates the local simulated grant and reports
  `revoked`, `live: false`, and no approved references.
- A malformed safe-reference response stops in `needs-attention` and exposes
  no reference payload.
- A plugin cannot remap an approved opaque record to another conversation,
  thread, or conversation type; it is rejected before any reference is shown.
- If reviewed metadata changes, a connector returns an excluded/unreviewed
  record, connector-side revocation fails, or revocation races a resumed fetch
  or the final grant save, the local grant is invalidated and the saved state
  remains fail-closed. A direct customer revoke uses the same local-invalidation
  fallback if the injected connector's revoke callback fails.
- Status derives the Slack lifecycle and generic permission view from one
  loaded root snapshot. A revoke triggered during a read-only test-state load
  may complete, but the status view still returns one internally consistent
  snapshot. Public writer re-entry is blocked before it can create a stale
  full-root save.

## Automated acceptance evidence

Run from the private implementation repository:

```text
npm run test:qwa-148
npm test
```

The focused suite contains 36 passing scenarios covering:

- explicit authorization, read-only verification, body-free metadata
  pagination, local aliasing, and independent scope enforcement;
- default private/unknown-channel exclusion, explicit participant
  classification, unknown-sensitivity exclusion, and a separate blocked-group
  exception review pinned to one reviewed membership snapshot; a Restricted
  person cannot be relabeled as Blocked to widen that exception;
- malformed, rebound, unreviewed, duplicate, or final-scope-excluded records
  and stable references failing closed, including a contradictory connector
  receipt that returns records while claiming no body was read;
- denial, retry, resume, Spanish parity, persisted-grant integrity failure,
  and generic-API rejection for Slack;
- incomplete and internally contradictory pagination failing before a grant;
- participant and public/private-channel drift at the exact adapter-fetch
  boundary, and pagination becoming incomplete at that boundary, failing
  before the simulated body-access counter advances;
- unknown sensitivity staying excluded before body access, even when it is the
  only otherwise-selected record; a zero-record result preserving zero public
  body-read/fetch counters; and an explicitly included uncertain record
  surviving normalized grant-integrity validation and producing one inert
  reference;
- connector-side and direct-revoke failures invalidating the local grant; and
- revoke races against authorization, group approval, grant registration,
  final grant save, approved fetch, another Slack account, and a generic source
  save without resurrecting access; a same-context callback cannot re-enter a
  public writer and later overwrite its permission change; and ordinary and
  re-entrant status reads cannot combine two different persisted snapshots.

Historical isolated verification captured after the final security pass:

```text
# QWA-148 focused suite
1..36
# pass 36
# fail 0

# full branch suite
1..103
# pass 103
# fail 0
```

Current combined integration verification (managed sandbox, 2026-08-19):

```text
# QWA-148 focused suite
1..36
# pass 36
# fail 0

# full local suite
# pass 268
# fail 9
# the nine failures are the known QWA-146 detached-worker sandbox limitation
```

The current result leaves the Slack contract intact while clearly separating
the environment-bound QWA-146 worker gap from Slack verification. It remains
a simulated, local-only proof and not evidence of a live Slack integration.

## Honest limitation and release gate

This is a controlled adapter-contract proof, not evidence that a real Slack
plugin, OAuth flow, workspace, pagination API, or production read-only token
works. It does not satisfy the real-device connector validation gate. Until a
clean-Mac, interactive official-plugin verification passes, customer-facing
status must remain **selected but unfinished / simulation-only**, never live
and verified.

The canonical per-state-file lock used by this implementation is process-local.
Public writer re-entry fails closed; trusted connector lifecycles use explicit
lock-held internal operations, while read-only status composition may permit a
nested writer because it never saves its loaded snapshot. The lock serializes
participating Setup Session writers inside one Node.js process; it is not an
operating-system lock and does not provide cross-process atomicity. Additive
integration must also place the real outer Gmail, Drive, Calendar, and iMessage
full-root lifecycle writers behind this same in-process lock before the
cross-source race proof applies to primary.
