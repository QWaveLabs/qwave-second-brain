import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKPOINT_KINDS,
  HISTORY_MODES,
  planHistoryCheckpoint,
  planPrivateHistory
} from "../src/index.mjs";

test("local-only history is an explicit customer-owned choice with no remote push", () => {
  assert.deepEqual(planPrivateHistory({ mode: "local-only" }), {
    status: "ready",
    mode: "local-only",
    remoteStatus: "not-configured",
    mayInitializeLocalHistory: true,
    mayPush: false,
    message: "Your private history can stay on this Mac. No remote backup will be created."
  });
});

test("a private remote requires a current visibility readback before history may be pushed", () => {
  const plan = planPrivateHistory({
    mode: "private-remote",
    remote: {
      reference: "private QWave customer repository",
      visibility: "private",
      verifiedAt: "2026-08-20T16:30:00.000Z"
    }
  });
  assert.equal(plan.status, "ready");
  assert.equal(plan.remoteStatus, "private-verified");
  assert.equal(plan.mayInitializeLocalHistory, true);
  assert.equal(plan.mayPush, true);
  assert.doesNotMatch(JSON.stringify(plan), /customer repository/i, "private remote references stay out of the public plan");
});

test("a public or unverifiable remote fails closed before local history initialization or a push", () => {
  for (const remote of [
    { reference: "public repository", visibility: "public", verifiedAt: "2026-08-20T16:30:00.000Z" },
    { reference: "unverified repository", visibility: "private" },
    { visibility: "private", verifiedAt: "2026-08-20T16:30:00.000Z" }
  ]) {
    const plan = planPrivateHistory({ mode: "private-remote", remote });
    assert.equal(plan.status, "blocked");
    assert.equal(plan.mayInitializeLocalHistory, false);
    assert.equal(plan.mayPush, false);
    assert.doesNotMatch(JSON.stringify(plan), /repository/i, "the blocked plan must not disclose a private reference");
  }
});

test("checkpoint intents are readable and require a later adapter readback", () => {
  assert.deepEqual(HISTORY_MODES, ["local-only", "private-remote"]);
  assert.deepEqual(CHECKPOINT_KINDS, ["build", "refresh", "migration", "restore", "purge"]);
  assert.deepEqual(planHistoryCheckpoint({ kind: "restore" }), {
    kind: "restore",
    label: "Second Brain restore checkpoint",
    requiresReadback: true,
    customerMessage: "I will create and verify a private restore checkpoint before changing your brain."
  });
});
