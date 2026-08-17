# QWA-143 Google Calendar vertical-slice proof (simulated)

Date: 2026-08-17

This proof exercises a public, plain-language Calendar lifecycle with an injected, simulated adapter. It does **not** authorize Google, start OAuth, open a customer calendar, read a real event, retain a real title or attendee, or create, edit, accept, decline, or delete an event.

## Customer-visible path

After the normal setup conversation, a customer can say:

> Please connect Calendar to my second brain

Calendar is kept separate from Gmail and Drive. The first reply is metadata-only and explains that no event detail has been read. It presents the fixed default window:

- previous six months; and
- upcoming 90 days.

The customer can then review a granular, deny-by-default scope and explicitly acknowledge both active AI-provider processing and that source material is untrusted before any approved event reference can be processed.

The English and Spanish lifecycle remains plain-language; it does not require a slash command or a technical workflow.

## Privacy and read-only boundary

Before an event can be eligible for a detail fetch, the simulated adapter applies all three boundaries:

1. calendar-level sensitivity;
2. attendee Allowed/Restricted/Blocked privacy; and
3. sensitive or uncertain event titles.

Sensitive event metadata is represented with fixed, non-source labels and opaque identifiers. Restricted attendees, blocked attendees, sensitive calendars, and sensitive titles remain excluded by default. The public result contains only opaque inert references—never titles, descriptions, locations, conferencing links, attendees, or raw event bodies.

The public response also states that Calendar is read-only and cannot create, edit, accept, decline, or delete events. The simulated adapter intentionally has no event mutation API and its mutation counter remains zero in every acceptance case.

## Predictable event handling and truthful states

Recurring instances receive deterministic opaque identifiers based on their series and occurrence start. Canceled or malformed events are excluded before a detail fetch and reported only as normalization counts, never as source text.

The lifecycle reports these states without overstating access:

- `empty` when the reviewed scope has no approved events, including a distinct truthful empty-partial result when other calendars are unavailable;
- `imported-partially` when some calendars are unavailable;
- `access-revoked` when Calendar access is no longer available;
- retry-required states for metadata, grant activation, or approved-detail interruptions; and
- a fresh review after an externally revoked grant, never revival of the old grant.

All status and retry paths preserve the no-mutation boundary.

## Automated acceptance evidence

Run from the private implementation repository:

```text
npm run test:qwa-143
npm test
```

Focused test result after the final review:

```text
# QWA-143 focused suite
1..6
# pass 6
# fail 0
```

Full private-suite result from the same clean worktree:

```text
1..45
# pass 45
# fail 0
```

The focused suite covers:

1. separate Calendar authorization, the 6-month/90-day window, and pre-grant denial;
2. English/Spanish customer language and calendar, attendee, and title sensitivity before a detail fetch;
3. recurring-instance normalization and canceled-event exclusion;
4. empty, partial, and revoked states;
5. metadata/detail interruption and resume; and
6. external revocation invalidating a prior active grant before a fresh review.

## Honest limitation

QWA-143 is an adapter-contract vertical slice only. It makes no claim that a live Google Calendar OAuth connection, real Calendar metadata read, real event detail fetch, or production account access has been verified. A future live connector must preserve this same separate grant, sensitivity-before-detail, opaque-reference, and no-mutation boundary before it can claim live status.
