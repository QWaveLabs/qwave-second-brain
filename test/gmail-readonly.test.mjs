import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileStateStore,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedGmailPlugin,
  SimulatedObsidianAdapter,
  beginGmailConnection,
  beginGmailPrivacyReview,
  cancelGmailReadOnlyScope,
  fetchApprovedGmailReferences,
  getGmailReadOnlyStatus,
  grantGmailReadOnlyScope,
  revokeGmailReadOnlyConnection,
  startSetupSession
} from "../src/index.mjs";

function gmailFixture(overrides = {}) {
  return {
    account: { id: "gmail-work", label: "Work Gmail" },
    estimatedItemCount: 3,
    pages: [
      {
        records: [{
          id: "mail-001",
          threadId: "thread-001",
          area: "mail",
          category: "email",
          timestamp: "2026-08-10T12:00:00.000Z",
          body: "This raw fixture body must never leave the simulated plugin."
        }],
        nextPageToken: "page-2"
      },
      {
        records: [{
          id: "mail-002",
          threadId: "thread-002",
          area: "mail",
          category: "email",
          timestamp: "2026-08-11T12:00:00.000Z",
          body: "This raw fixture body must never leave the simulated plugin."
        }],
        nextPageToken: "page-3"
      },
      {
        records: [{
          id: "mail-003",
          threadId: "thread-003",
          area: "mail",
          category: "email",
          timestamp: "2026-08-12T12:00:00.000Z",
          body: "This raw fixture body must never leave the simulated plugin."
        }]
      }
    ],
    ...overrides
  };
}

async function withGmailFixture(run, { language = "en", pluginOptions = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa145-"));
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  const adapters = {
    environment: new SimulatedEnvironmentAdapter(),
    obsidian: new SimulatedObsidianAdapter(),
    vault: new SimulatedDesktopVaultAdapter()
  };
  const plugin = new SimulatedGmailPlugin(gmailFixture(pluginOptions));
  const clock = { now: () => new Date("2026-08-17T12:00:00.000Z") };
  try {
    await startSetupSession({
      message: language === "es" ? "Configura mi segundo cerebro" : "Set up my second brain",
      answers: { displayName: "Alex", focus: "prepare for the week" },
      decisions: { vaultName: "My Second Brain", language },
      stateStore,
      adapters,
      clock
    });
    await run({ directory, stateStore, adapters, plugin, clock });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function approvedScope(gmail) {
  const scope = structuredClone(gmail.permissionReview.permissionRequest.requestedScope);
  scope.acknowledgements.modelProcessing = true;
  scope.acknowledgements.untrustedSourceMaterial = true;
  return scope;
}

async function connectReviewAndGrant({ stateStore, plugin, clock, language = "en", reviewId = "gmail-review", grantId = "gmail-grant" }) {
  const startMessage = language === "es"
    ? "Quiero conectar Gmail a mi segundo cerebro"
    : "I want to connect Gmail to my second brain";
  const reviewMessage = language === "es"
    ? "Quiero revisar Gmail para mi segundo cerebro"
    : "Please review Gmail for my second brain";
  const grantMessage = language === "es"
    ? "Apruebo el alcance revisado de Gmail"
    : "I approve the reviewed Gmail scope";
  await beginGmailConnection({ message: startMessage, stateStore, plugin, language, clock });
  const review = await beginGmailPrivacyReview({ message: reviewMessage, stateStore, plugin, language, clock, reviewIdFactory: () => reviewId });
  assert.equal(review.recoverable, undefined);
  const granted = await grantGmailReadOnlyScope({
    message: grantMessage,
    stateStore,
    plugin,
    language,
    clock,
    scope: approvedScope(review.gmail),
    grantIdFactory: () => grantId
  });
  assert.equal(granted.recoverable, undefined);
  return { review, granted };
}

test("Gmail stays metadata-first and simulated verification never claims a live customer mailbox", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    const started = await beginGmailConnection({
      message: "I want to connect Gmail to my second brain",
      stateStore,
      plugin,
      clock
    });
    assert.equal(started.gmail.connection.live, false);
    assert.equal(started.gmail.connection.readOnly, true);
    assert.equal(started.gmail.connection.canSendMail, false);
    assert.equal(started.gmail.connection.canLabelMail, false);
    assert.equal(plugin.connectionCalls, 1);
    assert.equal(plugin.metadataPreflightCalls, 0);
    assert.equal(plugin.approvedPageCalls, 0);

    const review = await beginGmailPrivacyReview({
      message: "Please review Gmail for my second brain",
      stateStore,
      plugin,
      clock,
      reviewIdFactory: () => "metadata-first-review"
    });
    assert.equal(review.gmail.permissionReview.metadataPreflight.contentBodiesRead, false);
    assert.equal(review.gmail.permissionReview.permissionRequest.requestedScope.dateRange.pastDays, 90);
    assert.match(review.gmail.message, /metadata only|not read any email body/i);
    assert.equal(plugin.metadataPreflightCalls, 1);
    assert.equal(plugin.approvedPageCalls, 0);
    assert.equal(plugin.bodyReads, 0);

    const granted = await grantGmailReadOnlyScope({
      message: "I approve the reviewed Gmail scope",
      stateStore,
      plugin,
      clock,
      scope: approvedScope(review.gmail),
      grantIdFactory: () => "metadata-first-grant"
    });
    assert.equal(granted.gmail.import.status, "ready-to-verify");
    assert.equal(plugin.approvedPageCalls, 0, "a grant does not itself read mail");

    const fetched = await fetchApprovedGmailReferences({
      message: "Process my approved Gmail references",
      stateStore,
      plugin,
      clock,
      maxPages: 5
    });
    assert.equal(fetched.complete, true);
    assert.deepEqual(fetched.approvedReferences.map((reference) => reference.sourceRecordId), ["gmail:mail-001", "gmail:mail-002", "gmail:mail-003"]);
    assert.equal("body" in fetched.approvedReferences[0], false);
    assert.equal("snippet" in fetched.approvedReferences[0], false);
    assert.equal(fetched.gmail.connection.live, false);
    assert.equal(fetched.gmail.connection.simulationOnly, true);
    assert.equal(fetched.gmail.status, "selected-but-unfinished");
    assert.match(fetched.gmail.message, /did not verify a real Gmail account/i);
    assert.equal(plugin.bodyReads, 0);
    assert.equal(plugin.writeCalls, 0);
    assert.equal(typeof plugin.sendMail, "undefined");
    assert.equal(typeof plugin.labelMail, "undefined");
    assert.equal(typeof plugin.deleteMail, "undefined");
  });
});

test("an empty simulated Gmail response remains non-live even if the fixture claims an actual read", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "empty-review", grantId: "empty-grant" });
    plugin.fetchApprovedPage = async () => ({
      readOnly: true,
      rawBodiesReturned: false,
      simulated: true,
      actualRead: true,
      records: [],
      nextPageToken: null
    });
    const fetched = await fetchApprovedGmailReferences({
      message: "Process my approved Gmail references",
      stateStore,
      plugin,
      clock
    });
    assert.equal(fetched.complete, true);
    assert.equal(fetched.gmail.import.empty, true);
    assert.deepEqual(fetched.approvedReferences, []);
    assert.equal(fetched.gmail.connection.live, false);
    assert.equal(fetched.gmail.status, "selected-but-unfinished");
    assert.match(fetched.gmail.message, /simulation found no approved references/i);
  }, { pluginOptions: { pages: [], estimatedItemCount: 0 } });
});

test("a cancelled or unavailable plugin connection gives one exact in-app action and safely resumes", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    const withoutPlugin = await beginGmailConnection({
      message: "Please connect Gmail for my second brain",
      stateStore,
      clock
    });
    assert.deepEqual(withoutPlugin.gmail.nextAction, {
      id: "open-gmail-plugin-connect",
      kind: "in-app-plugin-action",
      instruction: "In Codex Desktop, open Apps, select Gmail, and choose Connect."
    });
    assert.equal(withoutPlugin.gmail.connection.live, false);

    plugin.connectionResults = ["cancelled", "connected"];
    const cancelled = await beginGmailConnection({
      message: "Try Gmail again",
      stateStore,
      plugin,
      clock
    });
    assert.equal(cancelled.gmail.plugin.status, "cancelled");
    assert.match(cancelled.gmail.message, /cancelled/i);
    assert.equal(plugin.metadataPreflightCalls, 0);
    assert.equal(plugin.approvedPageCalls, 0);

    const resumed = await beginGmailConnection({
      message: "Try Gmail again in my second brain",
      stateStore,
      plugin,
      clock
    });
    assert.equal(resumed.gmail.plugin.status, "connected");
    assert.equal(plugin.connectionCalls, 2);
    const review = await beginGmailPrivacyReview({
      message: "Please review Gmail for my second brain",
      stateStore,
      plugin,
      clock,
      reviewIdFactory: () => "resumed-after-cancel"
    });
    assert.equal(review.gmail.permissionReview.metadataPreflight.contentBodiesRead, false);
  });
});

test("metadata interruption remains resumable and does not fetch a mail page", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    plugin.metadataFailures = 1;
    await beginGmailConnection({ message: "Connect Gmail to my second brain", stateStore, plugin, clock });
    const failed = await beginGmailPrivacyReview({
      message: "Review Gmail for my second brain",
      stateStore,
      plugin,
      clock,
      reviewIdFactory: () => "failed-metadata"
    });
    assert.equal(failed.recoverable, true);
    assert.equal(failed.gmail.status, "needs-attention");
    assert.equal(plugin.approvedPageCalls, 0);
    assert.equal(plugin.bodyReads, 0);

    const resumed = await beginGmailPrivacyReview({
      message: "Retry the Gmail review for my second brain",
      stateStore: new FileStateStore(stateStore.filePath),
      plugin,
      clock,
      reviewIdFactory: () => "resumed-metadata"
    });
    assert.equal(resumed.recoverable, undefined);
    assert.equal(resumed.gmail.permissionReview.permissionRequest.reviewId, "resumed-metadata");
    assert.equal(plugin.metadataPreflightCalls, 2);
    assert.equal(plugin.approvedPageCalls, 0);
  });
});

test("oversized Gmail pagination is checkpointed and resumes without duplicate opaque references", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    plugin.estimatedItemCount = 500;
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "paged-review", grantId: "paged-grant" });

    const first = await fetchApprovedGmailReferences({
      message: "Process my approved Gmail references",
      stateStore,
      plugin,
      clock,
      maxPages: 1
    });
    assert.equal(first.complete, false);
    assert.equal(first.checkpointRequired, true);
    assert.deepEqual(first.approvedReferences.map((reference) => reference.sourceRecordId), ["gmail:mail-001"]);
    assert.equal(first.gmail.import.pagesCompleted, 1);
    assert.equal(first.gmail.import.estimatedItemCount, 500);
    assert.match(first.gmail.message, /safe checkpoint/i);

    const second = await fetchApprovedGmailReferences({
      message: "Continue Gmail in my second brain",
      stateStore: new FileStateStore(stateStore.filePath),
      plugin,
      clock,
      maxPages: 1
    });
    assert.deepEqual(second.approvedReferences.map((reference) => reference.sourceRecordId), ["gmail:mail-002"]);
    assert.equal(second.complete, false);

    const completed = await fetchApprovedGmailReferences({
      message: "Continue Gmail in my second brain",
      stateStore: new FileStateStore(stateStore.filePath),
      plugin,
      clock,
      maxPages: 1
    });
    assert.deepEqual(completed.approvedReferences.map((reference) => reference.sourceRecordId), ["gmail:mail-003"]);
    assert.equal(completed.complete, true);
    assert.equal(completed.gmail.import.recordsProcessed, 3);
    assert.deepEqual(
      plugin.requests.filter((request) => request.type === "approved-page").map((request) => request.pageToken),
      [null, "page-2", "page-3"]
    );
    const idempotent = await fetchApprovedGmailReferences({
      message: "Continue Gmail in my second brain",
      stateStore,
      plugin,
      clock
    });
    assert.deepEqual(idempotent.approvedReferences, []);
    assert.equal(plugin.approvedPageCalls, 3);
  });
});

test("a mid-pagination failure preserves the earlier checkpoint and retry resumes the same page", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    plugin.failuresByPageToken = new Map([["page-2", 1]]);
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "failure-review", grantId: "failure-grant" });
    const interrupted = await fetchApprovedGmailReferences({
      message: "Process my approved Gmail references",
      stateStore,
      plugin,
      clock,
      maxPages: 3
    });
    assert.equal(interrupted.recoverable, true);
    assert.deepEqual(interrupted.approvedReferences.map((reference) => reference.sourceRecordId), ["gmail:mail-001"]);
    assert.equal(interrupted.gmail.status, "needs-attention");
    assert.equal(interrupted.gmail.import.pagesCompleted, 1);

    const recovered = await fetchApprovedGmailReferences({
      message: "Retry Gmail in my second brain",
      stateStore: new FileStateStore(stateStore.filePath),
      plugin,
      clock,
      maxPages: 3
    });
    assert.equal(recovered.complete, true);
    assert.deepEqual(recovered.approvedReferences.map((reference) => reference.sourceRecordId), ["gmail:mail-002", "gmail:mail-003"]);
    assert.equal(recovered.gmail.import.recordsProcessed, 3);
    assert.deepEqual(
      plugin.requests.filter((request) => request.type === "approved-page").map((request) => request.pageToken),
      [null, "page-2", "page-2", "page-3"]
    );
  });
});

test("an opaque Gmail page record outside the granted date or area boundary is never exposed", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "scope-boundary-review", grantId: "scope-boundary-grant" });
    plugin.fetchApprovedPage = async () => ({
      readOnly: true,
      rawBodiesReturned: false,
      simulated: true,
      actualRead: false,
      records: [{
        id: "mail-outside-scope",
        threadId: "thread-outside-scope",
        area: "inbox",
        category: "email",
        timestamp: "2020-01-01T00:00:00.000Z"
      }],
      nextPageToken: null
    });
    const denied = await fetchApprovedGmailReferences({
      message: "Process approved Gmail references",
      stateStore,
      plugin,
      clock
    });
    assert.equal(denied.gmail.status, "needs-attention");
    assert.equal(denied.gmail.lastSafeError.code, "GMAIL_SCOPE_BOUNDARY_VIOLATION");
    assert.deepEqual(denied.approvedReferences, []);
    assert.equal(denied.gmail.connection.live, false);
    assert.doesNotMatch(denied.gmail.message, /No mail was read/i);
    assert.equal(plugin.writeCalls, 0);
  });
});

test("a repeated Gmail page checkpoint fails closed instead of allowing an endless resume loop", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "loop-review", grantId: "loop-grant" });
    let calls = 0;
    plugin.fetchApprovedPage = async () => {
      calls += 1;
      return {
        readOnly: true,
        rawBodiesReturned: false,
        simulated: true,
        actualRead: false,
        records: [{
          id: `mail-loop-${calls}`,
          threadId: `thread-loop-${calls}`,
          area: "mail",
          category: "email",
          timestamp: "2026-08-12T12:00:00.000Z"
        }],
        nextPageToken: "page-repeat"
      };
    };
    const interrupted = await fetchApprovedGmailReferences({
      message: "Process approved Gmail references",
      stateStore,
      plugin,
      clock,
      maxPages: 3
    });
    assert.equal(interrupted.gmail.status, "needs-attention");
    assert.equal(interrupted.gmail.lastSafeError.code, "GMAIL_CHECKPOINT_LOOP");
    assert.deepEqual(interrupted.approvedReferences.map((reference) => reference.sourceRecordId), ["gmail:mail-loop-1", "gmail:mail-loop-2"]);
    assert.equal(calls, 2);
  });
});

test("a cancelled scope requires a new review, and revoked Gmail is never reused", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await beginGmailConnection({ message: "Connect Gmail to my second brain", stateStore, plugin, clock });
    const initialReview = await beginGmailPrivacyReview({
      message: "Review Gmail for my second brain",
      stateStore,
      plugin,
      clock,
      reviewIdFactory: () => "cancelled-review"
    });
    const cancelled = await cancelGmailReadOnlyScope({
      message: "Do not approve Gmail right now",
      stateStore,
      clock
    });
    assert.equal(cancelled.gmail.import.status, "cancelled");
    assert.match(cancelled.message, /No Gmail content access was granted/i);
    assert.equal(plugin.approvedPageCalls, 0);

    const freshReview = await beginGmailPrivacyReview({
      message: "Start a new Gmail review for my second brain",
      stateStore,
      plugin,
      clock,
      reviewIdFactory: () => "fresh-review"
    });
    assert.notEqual(initialReview.gmail.permissionReview.permissionRequest.reviewId, freshReview.gmail.permissionReview.permissionRequest.reviewId);
    await grantGmailReadOnlyScope({
      message: "Approve the fresh Gmail scope",
      stateStore,
      plugin,
      clock,
      scope: approvedScope(freshReview.gmail),
      grantIdFactory: () => "fresh-grant"
    });
    const revoked = await revokeGmailReadOnlyConnection({
      message: "Revoke Gmail access",
      stateStore,
      plugin,
      clock
    });
    assert.equal(revoked.gmail.status, "revoked");
    assert.equal(revoked.gmail.connection.live, false);
    assert.equal(plugin.grantRevocationCalls, 1);
    await assert.rejects(
      () => fetchApprovedGmailReferences({
        message: "Process Gmail now",
        stateStore,
        plugin,
        clock
      }),
      /saved granular review is not ready/i
    );
    assert.equal(plugin.writeCalls, 0);
  });
});

test("external revocation and a body-boundary violation fail closed without a live claim", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    plugin.revokedPageTokens = new Set(["page-2"]);
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "external-revoke-review", grantId: "external-revoke-grant" });
    plugin.revokePermissionGrant = async () => {
      throw new Error("Simulated local plugin grant cleanup failure.");
    };
    const revoked = await fetchApprovedGmailReferences({
      message: "Process approved Gmail references",
      stateStore,
      plugin,
      clock,
      maxPages: 3
    });
    assert.equal(revoked.gmail.status, "revoked");
    assert.equal(revoked.recoverable, false);
    assert.equal(revoked.gmail.connection.live, false);
    assert.deepEqual(revoked.approvedReferences.map((reference) => reference.sourceRecordId), ["gmail:mail-001"]);

    const status = await getGmailReadOnlyStatus({ stateStore });
    assert.equal(status.gmail.status, "revoked");

    await beginGmailConnection({ message: "Connect Gmail again for my second brain", stateStore, plugin, clock });
    const fresh = await beginGmailPrivacyReview({
      message: "Start a fresh Gmail review for my second brain",
      stateStore,
      plugin,
      clock,
      reviewIdFactory: () => "after-external-revocation"
    });
    assert.equal(fresh.gmail.permissionReview.permissionRequest.reviewId, "after-external-revocation");
    assert.equal(fresh.gmail.permissionReview.activeGrant, null, "an externally revoked grant is not reused by a new review even when plugin cleanup fails");
  });

  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "body-violation-review", grantId: "body-violation-grant" });
    plugin.fetchApprovedPage = async () => ({
      readOnly: true,
      simulated: true,
      rawBodiesReturned: false,
      records: [{ id: "mail-hostile", threadId: "thread-hostile", body: "must never reach the lifecycle" }],
      nextPageToken: null
    });
    const failed = await fetchApprovedGmailReferences({
      message: "Process approved Gmail references",
      stateStore,
      plugin,
      clock
    });
    assert.equal(failed.gmail.status, "needs-attention");
    assert.equal(failed.gmail.lastSafeError.code, "GMAIL_BODY_BOUNDARY_VIOLATION");
    assert.deepEqual(failed.approvedReferences, []);
    assert.equal(failed.gmail.connection.live, false);
  });
});

test("Spanish Gmail lifecycle preserves the same privacy boundary and simulated-status truth", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    const { review, granted } = await connectReviewAndGrant({
      stateStore,
      plugin,
      clock,
      language: "es",
      reviewId: "spanish-review",
      grantId: "spanish-grant"
    });
    assert.match(review.gmail.message, /solo metadatos|Todavía no he leído/i);
    assert.match(granted.gmail.message, /permiso granular y de solo lectura/i);
    const checkpoint = await fetchApprovedGmailReferences({
      message: "Procesa mis referencias aprobadas de Gmail",
      stateStore,
      plugin,
      language: "es",
      clock,
      maxPages: 1
    });
    assert.equal(checkpoint.complete, false);
    assert.match(checkpoint.gmail.nextAction.message, /Continúa la importación guardada/i);
    const fetched = await fetchApprovedGmailReferences({
      message: "Continúa Gmail en mi segundo cerebro",
      stateStore,
      plugin,
      language: "es",
      clock,
      maxPages: 5
    });
    assert.match(fetched.gmail.message, /no verificó una cuenta real de Gmail/i);
    assert.equal(fetched.gmail.connection.live, false);
    assert.equal(plugin.writeCalls, 0);
  }, { language: "es" });
});
