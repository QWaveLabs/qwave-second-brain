# QWA-142 Google Drive folder-scope proof

Date: 2026-08-17

This proof exercises the public Google Drive lifecycle using injected,
simulated read-only adapters. It does **not** open a Google account, start an
OAuth flow, access Drive metadata or file bodies, modify a Drive file, or
claim that Google Drive is live and verified.

## Customer-visible guided path

After the ordinary-language Setup Session, the customer can say in English or
Spanish that they want to connect Google Drive. The customer-visible flow is:

```text
plain-language Drive request
  -> explicit approval for a selected-folder metadata-only, read-only authorization
  -> metadata-only folder review
  -> include/exclude reviewed folders and acknowledge disclosures
  -> granular selected-folder grant
  -> bounded opaque source-reference processing
  -> review or revoke from the same conversation
```

Drive remains separate from Gmail and Calendar. The public status reports
`live: false`, cannot edit/move/share/delete files, and distinguishes a
partial authorization, confirmed revocation, unconfirmed plugin revocation,
and a connector interruption that needs attention. A customer never needs a
slash command.

## Privacy and source-boundary contract

- The desktop-plugin seam is invoked only after explicit approval and must
  declare `metadataOnly: true` and `readOnly: true`.
- Before a granular folder grant, the connector receives only metadata
  discovery; the tests assert zero file-body fetches and zero body accesses.
- Plugin-approved folder identifiers are opaque Google-style IDs. Metadata
  outside those folders, including aggregate fields and people, is filtered
  before it reaches the generic permission review.
- A later grant may narrow those reviewed folders further but cannot add an
  unreviewed folder. Drive has no date window, so an approved evergreen file
  is retained even when it predates a communication-style date window.
- The bounded adapter rejects a connector record that was not present in the
  approved metadata inventory **or** falls outside the customer's final
  granted folders. Only opaque references reach the caller.
- Stable source records contain an opaque Drive ID, a redacted filename, a
  bounded account ID, validated modification time and MIME type, and a safe
  canonical Google link only when its path identifies that same opaque Drive
  item. Credential-bearing, mismatched, query, and fragment access material
  are discarded.
- Revocation always disables the local granular grant. If the plugin cannot
  confirm remote revocation, the status stays `revocation-unconfirmed` rather
  than claiming success.
- A post-grant connector interruption invalidates the current saved local
  grant when it is available and always clears the Drive folder state
  fail-closed. Explicit revoked/expired authorization codes report `revoked`;
  an unclassified interruption reports `needs-attention`. In either case, the
  audit records body access as unconfirmed rather than claiming that a failed
  connector read nothing, and processing can resume only through a fresh
  authorization and folder review.

No raw file body, token, credential, customer folder name, real Drive URL, or
customer metadata is stored in the repository or this proof.

## Automated acceptance evidence

Run from the private implementation repository:

```text
npm run test:qwa-142
npm test
```

Captured result on 2026-08-17:

```text
# QWA-142 focused suite
1..8
# pass 8
# fail 0

# full suite
1..47
# pass 47
# fail 0
```

The focused suite proves:

1. authorization is separate, normal-language, explicit, metadata-only, and
   causes no body access before approval;
2. folder inclusion/exclusion is granular, files outside the reviewed folders
   are excluded, and evergreen selected files remain eligible;
3. stable normalized references carry bounded account context, reject unsafe
   or mismatched links, and source applications remain non-writing;
4. a connector cannot surface either an unreviewed record or a preflight
   record outside the customer's final folder grant;
5. partial and revoked permissions report their actual state and prevent
   further processing; and
6. a missing metadata-only assertion is denied, a metadata interruption saves
   a retry point, and Spanish resumes the same safe review without a body read.
7. an explicit authorization-revoked fetch failure clears the local grant,
   reports `revoked`, and requires a fresh folder review before resuming; and
8. an unclassified connector interruption reports `needs-attention` rather
   than retaining a misleading ready state.

## Honest limitation and next gate

This is an adapter-contract vertical slice, not evidence of a live Google
Drive connector or real OAuth permission dialog. A production or clean-Mac
release gate must use an officially supported Drive plugin path, explicit
customer authorization, and a real read-only verification before any status
can become `live and verified`. Until then, this capability remains an
unverified simulated contract and must not be presented as a connected source.
