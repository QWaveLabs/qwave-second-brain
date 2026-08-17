# QWA-141 — Bilingual recommendation-led onboarding proof

## Scope proved

This proof continues the saved QWA-138 Setup Session through public exports:

- startOnboardingSession
- continueOnboardingSession
- getOnboardingSessionStatus

It captures four short bilingual question batches and writes a local foundation
to the injected vault adapter. The slice does not connect sources, inspect
customer data, install Obsidian, create a real Desktop vault, create Git
history, send support messages, or publish anything.

## Customer-visible path

1. Complete the ordinary-language QWA-138 bootstrap.
2. Say in ordinary language that you are ready for the foundation questions.
3. Review one visible batch at a time. Each batch has exactly five questions
   and five visible recommendation records.
4. Reply with individual choices or say “I accept the visible recommendations”
   or “Acepto las recomendaciones visibles.”
5. After each batch, the exact accepted decision records are persisted.
6. After batch four, public output contains the structured foundation and
   read-back-verified vault notes.

The simulated proof returns these foundation files:

- Home.md
- Identity.md
- Priorities.md
- Scope.md
- System/Privacy.md

The proof fixture uses fictional values only. It includes a mixed-language
name and quotation to assert byte-for-byte preservation rather than
translation or normalization.

## Persisted-state and adapter contract

QWA-138's root Setup Session schema and bootstrap/resume APIs remain intact.
QWA-141 adds only an optional nested state.onboarding object containing:

- the primary language and active batch;
- known facts that require confirmation rather than duplicate questions;
- every accepted or explicit decision, including its source and timestamp;
- completed-batch transcript entries;
- final structured foundation and vault read-back result.

The only new vault capability is writeFiles with a saved vault path and
vault-relative files. The simulated adapter stores deterministic note paths in
a map, so repeated writes replace the same note rather than create duplicates.
It is used only after the inherited Setup Session has already supplied a saved
vault path.

During integration, the real macOS vault adapter must implement the same
bounded and idempotent writeFiles contract and perform a read-back before
QWA-141 can be claimed against a real customer vault. That work is not part
of this ticket.

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| Four 4–6-question batches show progress and recommendations | onboarding.test.mjs asserts four batches, five questions each, visible progress, and five recommendations each. |
| Accept recommendations persists every accepted decision | Public transcript has four batch_completed records with 20 decision records, all sourced as accepted_recommendation. |
| Captured/discovered fields are confirmed, not duplicated | Saved name/focus and supplied roles render once with mode: confirm and preserve their source. |
| English and Spanish foundations are equivalent | Test supplies identical structured choices in both paths and deep-compares the foundation after the expected primary-language label. |
| Mixed-language names and quotations remain untouched | Test proves María "Lola" O’Neill and “No traduzcas esta frase.” survive into public foundation and vault read-back unchanged. |
| Required foundation fields appear in vault | Identity.md, Priorities.md, Scope.md, and System/Privacy.md contain identity, roles, outcome, priorities, scope, privacy, and success fields; Home.md surfaces outcome and priorities. |
| Safe interruption/resume and completed re-run | Test pauses after every batch, resumes from a new state-store object, then verifies that a completed re-run does not call writeFiles again. |

## Verification command and limitation

Run:

    npm test

The proof is deterministic and local. Its vault adapter is simulated, so it
does not claim a real Obsidian install, actual customer-vault write,
source connection, external publication, or customer-data handling.
