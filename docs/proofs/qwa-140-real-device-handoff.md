# QWA-140 controlled macOS handoff proof

Date: 2026-08-17

This is a controlled, noncustomer real-device proof of the QWA-140 public
Setup Session handoff. It does not claim that every macOS configuration has
been exercised, that Obsidian was installed during this run, or that any
connected source was accessed.

## Scope and safety boundary

- The existing official Obsidian application was detected at
  `/Applications/Obsidian.app` by its `md.obsidian` bundle identifier.
- The pre-existing vault registry was read only for vault-path discovery. No
  existing vault note, attachment, or configuration body was opened or read.
- A new, explicit target was created at
  `/Users/rob/Desktop/My Second Brain`. The guarded writer was approved only
  for that exact Desktop child path; it wrote only `Home.md`,
  `System/Status.md`, and its installation marker.
- No source connector, account, secret, raw staging data, generated-vault
  content, or private Setup Session state was added to this repository.

## Observed public journey

1. The persisted Setup Session had completed four of five stages and was
   safely blocked at vault-open validation. Its exact target and installation
   ID were preserved for normal-language resume.
2. Obsidian's native **Open folder as vault** flow was used to register the
   generated Desktop folder. The active application window then read
   `New tab - My Second Brain - Obsidian 1.13.7`.
3. The runtime read the registry only to obtain the generated vault's opaque
   identifier and used the documented official `obsidian://open?vault=<id>`
   launch form. A second active-window readback still named `My Second Brain`.
4. `continueSetupSession({ message: "Continue setting up my second brain" })`
   completed through the public boundary: `complete`, `5 of 5 setup steps`,
   `openedVaultPath: /Users/rob/Desktop/My Second Brain`, and
   `openVerified: true`.

The active-window confirmation was deliberately supplied through the adapter's
trusted UI-readback seam. The code rejects registry `open` flags as proof:
Obsidian can retain multiple such flags, so it never equates registry
membership or a successful launch process with the focused generated vault.

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| Existing app and vaults are detected without modification | Official bundle detection and read-only registry discovery ran before the new target handoff. Existing vault contents were not inspected. |
| Official installation is a single approved action when missing | Automated public-boundary test proves the one `https://obsidian.md/download` action and resume readback. This device already had the official app, so installation was not performed or claimed. |
| Default Desktop target is visible and collision-safe | The real target is visibly on the Desktop. The writer accepts only an exact direct child and refuses any pre-existing unowned path; collision and rename paths are covered by automated tests. |
| Shared profile is safely blocked | Public-boundary automated test stops before app or vault actions. |
| Generated vault opens before completion | The real session completed only after official vault-ID launch and a target-specific active-window readback. The product blocks if no trusted active-window reader is available. |
| Failures resume without rebuilding or overwriting | This real session resumed from a saved 4-of-5 validation block. Automated failure tests cover staging cleanup, registration pause/resume, and a write failure retry without touching an existing vault. |

## Regression verification

Run from the repository root:

```text
npm test
```

Captured result after the hardening changes:

```text
1..33
# tests 33
# pass 33
# fail 0
```

The suite includes explicit cases for the official install approval boundary,
Desktop collision and rename behavior, registration pause/resume, trusted
active-window readback, multiple ambiguous registry flags, staged-write retry,
and public normal-language Setup Session resume.

## Honest limitations

- The app was already installed; this proof does not represent an actual
  install on a clean Mac.
- A generic launcher without a target-specific active-window readback remains
  safely blocked. The current adapter intentionally refuses to claim success
  from URI launch or registry state alone.
- The current UI readback integration is a controlled macOS handoff seam. A
  production desktop release still needs its own supported, permission-aware
  active-window implementation and a clean-Mac release run.
