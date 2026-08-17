# QWA-138 customer-visible vertical-slice proof (simulated)

This proof exercises the public Setup Session boundary with injected simulated environment and Desktop-vault adapters. It does **not** claim that Obsidian was installed or opened; that real-macOS handoff belongs to QWA-140.

## Customer entry

> Set up my second brain

The customer receives a plain-language response that the setup will proceed one step at a time and that progress is saved for a normal-language resume request. No slash command or terminal action is presented.

## Completed visible result

```text
Setup progress: 4 of 4 setup steps complete
Vault: /simulated/Desktop/My Second Brain

My Second Brain/
├── Home.md
└── System/
    └── Status.md
```

The visible state includes saved starting answers, safe setup decisions, environment validation, and vault validation. Re-entering with “Continue setting up my second brain” returns the same completed result without creating a second vault or another set of files.

## Resume proof

The focused test suite intentionally pauses after each completed QWA-138 stage:

1. environment
2. foundation
3. vault
4. validation

Each resumed run loads the durable private state file through a new state-store instance, completes the remaining steps, and proves that only one simulated vault exists.

## Honest limitation

The vault path and files are simulated dependency output only. This ticket proves the persisted customer journey seam; it does not yet detect, install, modify, or open Obsidian, connect a source, read source content, or access a real Desktop.
