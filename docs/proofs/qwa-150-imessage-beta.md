# QWA-150 iMessage beta and snapshot proof

Date: 2026-08-17

This proof exercises the public Setup Session extension with simulated,
read-only iMessage adapters. It does not open a customer Messages database,
request a real macOS privacy prompt, read a real message body, retain a real
attachment, send a message, or alter a message.

## Customer-visible guided path

After the normal plain-language Setup Session, a customer can say:

> Please review iMessage for my second brain

The response makes the product boundary explicit in English and Spanish:

> iMessage is a local beta feature, not a cloud connector.

It offers two non-technical choices in the same guided conversation:

1. explain and approve a read-only local macOS attempt; or
2. continue with a clearly labeled one-time beta snapshot.

No slash command or technical instruction is required. The status always says
that the source is beta, read-only, and not live. It cannot send, edit, or
delete messages.

## Safe local-to-snapshot behavior

The public lifecycle is durable and resumable:

```text
plain-language iMessage request
  -> explain local beta / snapshot choice
  -> explicit macOS approval gate
  -> metadata-only privacy review OR safe snapshot fallback
  -> granular content grant
  -> bounded opaque reference processing
```

The local adapter is never called before the explicit approval value is true.
If local permission is denied, unavailable, or an attempted metadata review
fails, the existing Setup Session remains complete and the customer can resume
the saved one-time snapshot path. The retry does not duplicate setup or read a
message body.

## Privacy boundary before content

Both local-beta metadata review and snapshot review use the QWA-139
deny-by-default permission lifecycle:

- metadata preflight occurs before any message-body fetch;
- contacts use Allowed, Restricted, and Blocked privacy levels;
- group conversations with a Blocked participant are excluded by default;
- date range, category, conversation, and people exclusions remain durable;
- source material is declared untrusted and cannot expand its own scope; and
- the result exposed to the caller contains only opaque inert references, not
  message bodies.

Attachments and high-risk identifiers are separate gates. They remain excluded
until the customer separately approves them for the same saved review. The
read-only iMessage connector receives that persisted policy before its bounded
fetch, so excluded attachments and identifiers are filtered before content
processing rather than after it.

## Automated acceptance evidence

Run from the private implementation repository:

```text
npm run test:qwa-150
npm test
```

Captured result after the final privacy/resume review:

```text
# QWA-150 focused suite
1..6
# pass 6
# fail 0

# full suite
1..39
# pass 39
# fail 0
```

The QWA-150 tests prove all of the following without using customer data:

1. local access is not attempted before the explanatory approval gate;
2. denied/unavailable local access is non-blocking and resumes as a snapshot;
3. a failed metadata review safely falls back and can resume later;
4. contact and blocked-group privacy applies before a message is processed;
5. attachment and high-risk identifier approval is separate and persisted;
6. hostile metadata cannot activate attachments or widen scope; and
7. Spanish retains the same beta/snapshot and privacy truth.

## Honest limitation and release gate

This is a controlled adapter-contract proof, not evidence of a live iMessage
connector. It deliberately makes no claim that a real Messages database,
macOS privacy dialog, iCloud synchronization, or ongoing/live iMessage access
works. QWA-162 remains the clean-Mac, permission-aware release gate; until it
passes, customer-facing status must remain **snapshot/beta**.
