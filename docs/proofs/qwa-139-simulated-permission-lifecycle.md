# QWA-139 customer-visible permission proof (simulated)

This proof exercises the public Setup Session permission boundary with a simulated, read-only connector. It does not connect an account, begin OAuth, access a real source, retain a source body, send a message, change a calendar, or edit a file.

## Natural-language setup flow

After the normal QWA-138 setup session, the customer can say:

> Please connect Gmail to my second brain

The reply is a metadata-only permission review, not an import. Its customer-visible boundary says:

> I reviewed metadata only to prepare this decision. I have not read any message, file, or event body.

It also states that the connection is read-only and cannot send messages, change calendars, or edit files. No slash command or technical instruction is shown.

## What the customer reviews before any body fetch

The request records a discrete, deny-by-default allowlist for:

- one reviewed account;
- source areas, folders, channels, and conversations;
- Allowed, Restricted, and Blocked people;
- content categories and grouped sensitive categories;
- a source-specific date boundary; and
- exclusions for accounts, areas, folders, channels, people, conversations, categories, and date ranges.

It also includes a plain-language purpose, temporary-retention explanation, cancellation/review path, model-processing disclosure, and acknowledgement that imported material is untrusted reference data rather than instructions. Both acknowledgements are stored on the specific grant before a fetch can occur.

## Default scope rules

| Source type | Default approval boundary |
| --- | --- |
| Communication sources | Previous 90 days |
| Calendar | Previous 6 months and upcoming 90 days |
| Drive | Selected folders only; no arbitrary date window |

Changing a reviewed default window or adding an unreviewed area is rejected; the customer must start a new explicit review instead.

## Sensitive and people boundaries

Sensitive review batches include credentials, security codes, financial identifiers, identity documents, medical information, legal matters, HR/payroll, intimate communications, minors, and private/restricted labels. Uncertain sensitivity is also grouped and excluded until explicitly approved.

Restricted people are retained only as a boundary; their private communications are excluded. Blocked people are excluded from content access. A group conversation with a blocked participant is flagged and skipped by default. It can only be considered through a new review with one specific group-conversation exception; that exception cannot be broadened by source data.

## Safe lifecycle result

The simulated public path is:

```text
metadata-only preflight
  -> granular permission review
  -> explicit grant with two acknowledgements
  -> bounded opaque source-reference fetch
  -> review / revoke / fresh-review path
```

Denial records no access. A failed activation leaves the review awaiting approval and reads nothing. Grants persist in the Setup Session state, resume with a new simulated connector instance, and are idempotent for the same review and scope. Revocation deactivates the local grant and connector registration; a stale UI input cannot reactivate it.

## Adversarial privacy checks

The focused test suite proves that:

1. metadata preflight and rejected pre-grant fetches make zero body accesses;
2. a forged grant is refused by the connector;
3. untrusted scope-expansion attempts and unreviewed areas are rejected;
4. sensitive and uncertain items remain excluded by default;
5. blocked participants in group conversations are skipped until an explicit narrow exception;
6. denied and revoked grants cannot be revived by stale input;
7. retry/resume never duplicates a grant or broadens its scope; and
8. a malformed persisted grant fails closed before the connector can fetch; and
9. English and Spanish permission disclosures express the same boundaries.

No raw source bodies, credentials, tokens, or real account data are used in the tests or this proof.

## Honest limitation

This is a simulated contract and customer-visible proof for QWA-139. It does not prove a real plugin/OAuth connection or production source adapter. The connector matrix tickets must use this grant boundary before they claim a live verified source.
