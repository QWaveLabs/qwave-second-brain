# QWA-140 Obsidian and safe Desktop-vault proof (simulated)

This artifact proves the QWA-140 behavior through the public Setup Session boundary using injected adapters. It is deliberately **not** a claim that this worker installed Obsidian, created a real Desktop vault, or opened a real customer vault on this Mac.

## Reproducible evidence

Run from the isolated QWA-140 worktree:

```text
npm test
```

Captured result on 2026-08-17:

```text
1..16
# tests 16
# pass 16
# fail 0
# cancelled 0
```

The tests create only disposable paths under the operating system temporary directory and remove those fixtures afterward. They do not create, inspect, open, or change a real Desktop vault.

## Acceptance evidence

| Criterion | Status | Observable proof |
| --- | --- | --- |
| Existing official Obsidian is detected without mutation | Proven in simulation | Existing-vault inventory is read-only; no official-install action is emitted; only the new target is passed to the open verifier. |
| Missing Obsidian requires explicit approval and one official action | Proven in simulation | The session first pauses for approval, then emits only `https://obsidian.md/download`; it does not call an installation API and does not repeat the action on resume. |
| Default and renamed visible Desktop vault paths | Proven in simulation | `/simulated/Desktop/My Second Brain` is the default; a supplied name produces its corresponding Desktop path. |
| Existing vault collision is safe | Proven in simulation | A requested path matching an existing vault stops before `ensureVault`; a later renamed resume creates only the new path. |
| Shared macOS profile is blocked | Proven in simulation | The environment stage stops before Obsidian detection or vault creation. |
| Exact generated vault opens before completion | Proven in simulation | The injected verifier must return `opened: true` and the same target path; failure blocks validation and a normal-language resume retries without rebuilding the vault. |
| Real-adapter path is guarded and resumable | Proven with noncustomer temporary fixture | The macOS adapter test uses an explicit temporary Desktop root, exact approved target, injected `open`/readback seams, delayed registry confirmation, and an injected target-file failure. The same Setup Session resumes the installer-owned partial target without touching a pre-existing fixture vault. |

## Implementation safety contract

`MacOSObsidianAdapter`:

- Detects only `/Applications/Obsidian.app` as official when its bundle identifier is `md.obsidian`.
- Reads the Obsidian vault registry only for discovery; it never writes that registry or an existing vault.
- Emits the official download action only after the public session receives explicit approval.
- Refuses to call `open` unless the requested path equals the separately approved exact path.
- Polls the injected registry/readback verifier after launch; a successful process launch alone is not considered proof.

`MacOSDesktopVaultAdapter`:

- Resolves only one direct child of the configured Desktop root.
- Requires `allowCreate` and an exact separately approved path.
- Refuses any pre-existing path unless it bears its own marker for the same persisted Setup Session installation ID.
- Stages the initial files in a uniquely named sibling folder before reserving the final target.
- Never overwrites files: a retry writes only missing installer-owned files and stops if an existing file differs.
- Cleans staging folders only after validating their marker, target, and installation ID; it never cleans a customer vault.

## Real-device handoff — not executed here

The orchestrator may perform this controlled proof only after validating a noncustomer target and receiving the required customer/operator approvals:

1. Use a private macOS test account and a fresh, clearly noncustomer Desktop vault name.
2. Read-only detect the official app and existing-vault registry; record the target path separately from every existing vault.
3. If Obsidian is absent, obtain explicit approval and present the single official download/install action. Do not claim success until the next detection readback finds the official app.
4. Confirm the exact Desktop target is absent, then construct both guarded adapters with that same exact approved path and creation/open permission.
5. Run the Setup Session and require the final open readback to equal the new target path.
6. Save the terminal/UI readback as real-device evidence. If any step fails, preserve the saved Setup Session state and retry in the same conversation; do not open or modify an existing vault.

## Honest limitation

The automated suite demonstrates contracts, staged-write recovery, and the public journey with simulated/injected dependencies. It does not replace the release-gating clean-Mac run with real Codex Desktop, user approval dialogs, an actual official installation when needed, and an actual Obsidian window verified on the generated vault.
