# QWA-145 — Gmail Read-Only Lifecycle Proof

## Evidence boundary

This is a controlled local contract proof. It uses `SimulatedGmailPlugin`; it did **not** authenticate to, list, read, send, label, archive, delete, or modify a real Gmail account. Therefore it does not represent Gmail as live.

## Customer-visible path exercised

| Customer step | Visible result | Safety evidence |
| --- | --- | --- |
| “I want to connect Gmail to my second brain.” | Gmail is described as a separate read-only source. | The simulated plugin reports zero metadata and approved-page reads before the customer proceeds. |
| Plugin unavailable or cancelled | One exact fallback action appears: “In Codex Desktop, open Apps, select Gmail, and choose Connect.” | No metadata or message-body fetch occurs. |
| “Please review Gmail for my second brain.” | The customer sees a metadata-only review and the previous-90-days communication window. | The grant remains absent; no approved page can be fetched. |
| “I approve the reviewed Gmail scope.” | A granular read-only permission is saved. | QWA-139 acknowledgements and the persisted grant are required before the next step. |
| “Process my approved Gmail references.” | Only normalized opaque references such as `gmail:mail-001` are returned. | Every page record must independently match the approved date, area, and email-category boundaries; no body, snippet, header, payload, or source title is returned; write capability remains false. |
| Large mailbox | The importer pauses at a saved page checkpoint. | Resume starts from the next opaque page token without duplicate references; a repeated checkpoint fails closed instead of looping. |
| Interrupted page / revoked authorization | The connection becomes `needs-attention` or `revoked` with a safe retry/review path. | Earlier successful checkpoints persist; revoked grants are not reused; a post-fetch interruption never falsely states that no mail was read. |
| Spanish conversation | The same metadata, grant, and simulation truth are shown in Spanish. | Gmail remains non-live in the simulation. |

## Automated proof

Run locally:

```sh
npm run test:qwa-145
```

Result on this branch: **11 passing tests, 0 failures**. The black-box scenarios cover metadata-first ordering, 90-day scope, granular grant registration, empty sources, cancelled/unavailable plugin flow, metadata retry, oversized pagination checkpoints, mid-page resume, out-of-scope page rejection, repeated-checkpoint rejection, permission cancellation, local/external revocation, body-boundary rejection, opaque reference normalization, English/Spanish customer wording, and the no-live-simulation rule.

## Remaining limitation

This slice only supplies an injected connector contract and a simulation. An actual Gmail connection may be labeled `live-and-verified` only when an official host plugin returns a real read-only verification result (`actualRead: true`, `simulated: false`) after the saved Permission Grant exists. Clean-Mac/official-plugin verification remains a release-gate activity and has not been claimed here.
