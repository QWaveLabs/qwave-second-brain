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
  getSourceStatusHandoff,
  grantGmailReadOnlyScope,
  revokeGmailReadOnlyConnection,
  skipGmailConnection,
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

test("Gmail public, status, reference, and handoff views expose only stable local lifecycle aliases", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    const rawAccountId = "gmail-private-account";
    plugin.account = { id: rawAccountId, label: "Private adapter label" };
    const rawReviewId = "gmail-private-review";
    const rawGrantId = "gmail-private-grant";
    const { review, granted } = await connectReviewAndGrant({
      stateStore,
      plugin,
      clock,
      reviewId: rawReviewId,
      grantId: rawGrantId
    });
    const accountAlias = review.gmail.account.context;
    assert.match(accountAlias, /^local-gmail-account-/);
    assert.equal(review.gmail.permissionReview.account.id, accountAlias);
    assert.equal(review.gmail.permissionReview.permissionRequest.account.id, accountAlias);
    assert.equal(review.gmail.permissionReview.permissionRequest.requestedScope.accountId, accountAlias);
    assert.match(review.gmail.permissionReview.permissionRequest.reviewId, /^local-gmail-review-/);
    assert.match(granted.gmail.permissionReview.activeGrant.grantId, /^local-gmail-grant-/);
    assert.equal(granted.gmail.permissionReview.activeGrant.scope.accountId, accountAlias);

    const fetched = await fetchApprovedGmailReferences({
      message: "Process one approved Gmail page",
      stateStore,
      plugin,
      clock,
      maxPages: 1
    });
    assert.equal(fetched.approvedReferences[0].accountContext, accountAlias);
    let loadCalls = 0;
    let nestedRevokes = 0;
    const hookedStore = {
      filePath: stateStore.filePath,
      async load() {
        loadCalls += 1;
        if (loadCalls === 2) {
          nestedRevokes += 1;
          await revokeGmailReadOnlyConnection({
            message: "Revoke Gmail from a hostile second status load",
            stateStore: hookedStore,
            plugin,
            clock
          });
        }
        return stateStore.load();
      },
      save: (value) => stateStore.save(value)
    };
    const status = await getGmailReadOnlyStatus({ stateStore: hookedStore });
    assert.equal(loadCalls, 1, "specialized Gmail status must compose from one loaded root");
    assert.equal(nestedRevokes, 0, "there is no second load window for a nested revoke");
    const handoff = await getSourceStatusHandoff({ stateStore });
    const persisted = await stateStore.load();
    const internalPageGenerationId = persisted.gmailReadOnlyLifecycle.entry.audit
      .find((event) => event.type === "gmail-page-read-started")?.operationId;
    const internalPageToken = persisted.gmailReadOnlyLifecycle.entry.import.nextPageToken;
    const publicText = JSON.stringify({ review, granted, fetched, status, handoff });
    for (const rawIdentifier of [rawAccountId, rawReviewId, rawGrantId, internalPageGenerationId, internalPageToken]) {
      assert.equal(publicText.includes(rawIdentifier), false, `public Gmail views must not expose ${rawIdentifier}`);
    }
    assert.equal(handoff.sourceStatusHandoff.sources.some((source) => source.source.id === `gmail:${accountAlias}`), true);
  }, { pluginOptions: { account: { id: "gmail-private-account", label: "Private adapter label" } } });
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
    assert.notEqual(resumed.gmail.permissionReview.permissionRequest.reviewId, "resumed-metadata");
    assert.match(resumed.gmail.permissionReview.permissionRequest.reviewId, /^local-gmail-review-/);
    assert.equal(plugin.metadataPreflightCalls, 2);
    assert.equal(plugin.approvedPageCalls, 0);
  });
});

test("metadata preflight rejects nested singular attachment and message/email body key variants before grant", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await beginGmailConnection({ message: "Connect Gmail to my second brain", stateStore, plugin, clock });
    const normalDiscover = plugin.discoverMetadata.bind(plugin);
    for (const bodyField of ["Attachment", "Message_Body", "EMAIL-body"]) {
      plugin.discoverMetadata = async (request) => {
        const metadata = await normalDiscover(request);
        metadata.account = {
          ...metadata.account,
          nested: { deeper: { [bodyField]: `private-${bodyField}` } }
        };
        return metadata;
      };
      const failed = await beginGmailPrivacyReview({
        message: "Review Gmail metadata for my second brain",
        stateStore,
        plugin,
        clock
      });
      assert.equal(failed.recoverable, true);
      assert.equal(failed.gmail.status, "needs-attention");
      assert.equal(failed.gmail.lastSafeError.code, "GMAIL_BODY_BOUNDARY_VIOLATION");
      assert.equal(JSON.stringify(failed).includes(`private-${bodyField}`), false);
      assert.equal(plugin.grantRegistrationCalls, 0);
      assert.equal(plugin.approvedPageCalls, 0);
    }
    assert.equal(plugin.writeCalls, 0);
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
    const persisted = await stateStore.load();
    assert.equal(persisted.gmailReadOnlyLifecycle.entry.import.pendingPageRead, null);
    assert.equal(persisted.gmailReadOnlyLifecycle.entry.import.operationRevision, 3);
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

test("a mid-pagination failure preserves the earlier checkpoint and blocks an uncertain page reread", async () => {
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
    assert.equal(interrupted.gmail.import.readMayHaveOccurred, true);
    assert.equal(interrupted.gmail.nextAction.kind, "revoke-and-start-fresh-gmail-review");
    const persistedInterruption = await stateStore.load();
    const pendingInterruption = persistedInterruption.gmailReadOnlyLifecycle.entry.import.pendingPageRead;
    assert.equal(pendingInterruption.checkpoint, "page-2");
    const interruptedSurface = JSON.stringify(interrupted);
    assert.equal(interruptedSurface.includes(pendingInterruption.operationId), false);
    assert.equal(interruptedSurface.includes('"page-2"'), false);
    assert.doesNotMatch(interruptedSurface, /operationRevision|pendingPageRead/);
    const callsAfterInterruption = plugin.approvedPageCalls;

    const blockedRetry = await fetchApprovedGmailReferences({
      message: "Retry Gmail in my second brain",
      stateStore: new FileStateStore(stateStore.filePath),
      plugin,
      clock,
      maxPages: 3
    });
    assert.equal(blockedRetry.complete, false);
    assert.equal(blockedRetry.recoveryRequired, true);
    assert.deepEqual(blockedRetry.approvedReferences, []);
    assert.equal(blockedRetry.gmail.import.recordsProcessed, 1);
    assert.equal(plugin.approvedPageCalls, callsAfterInterruption);
    const status = await getGmailReadOnlyStatus({ stateStore: new FileStateStore(stateStore.filePath) });
    for (const publicSurface of [blockedRetry, status]) {
      const rendered = JSON.stringify(publicSurface);
      assert.equal(rendered.includes(pendingInterruption.operationId), false);
      assert.equal(rendered.includes('"page-2"'), false);
      assert.doesNotMatch(rendered, /operationRevision|pendingPageRead/);
    }
    assert.deepEqual(
      plugin.requests.filter((request) => request.type === "approved-page").map((request) => request.pageToken),
      [null, "page-2"]
    );
  });
});

test("a failed pre-read checkpoint save makes zero Gmail page calls and remains safely retryable", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "pre-read-save-review", grantId: "pre-read-save-grant" });
    let failed = false;
    const failureStore = {
      filePath: stateStore.filePath,
      load: () => stateStore.load(),
      async save(value) {
        if (!failed && value.gmailReadOnlyLifecycle?.entry?.import?.pendingPageRead) {
          failed = true;
          const error = new Error("Synthetic pre-read checkpoint save failure.");
          error.code = "SYNTHETIC_PRE_READ_SAVE_FAILED";
          throw error;
        }
        return stateStore.save(value);
      }
    };

    const result = await fetchApprovedGmailReferences({
      message: "Process my approved Gmail references",
      stateStore: failureStore,
      plugin,
      clock,
      maxPages: 1
    });

    assert.equal(result.gmail.status, "needs-attention");
    assert.equal(result.gmail.import.status, "paused-before-read");
    assert.equal(result.gmail.import.readMayHaveOccurred, false);
    assert.equal(result.gmail.lastSafeError.sourceReadAttempted, false);
    assert.equal(result.gmail.nextAction.kind, "retry-saved-gmail-step");
    assert.equal(plugin.approvedPageCalls, 0);
    const persisted = await stateStore.load();
    assert.equal(persisted.gmailReadOnlyLifecycle.entry.import.pendingPageRead ?? null, null);
    assert.equal(persisted.gmailReadOnlyLifecycle.entry.import.pagesCompleted, 0);
    assert.equal(persisted.sourcePermissionLifecycle.entries["gmail:gmail-work"].bodyFetches, 0);
  });
});

test("a post-fetch outer checkpoint failure persists uncertainty and a normal retry makes zero page calls", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "outer-save-review", grantId: "outer-save-grant" });
    let failedOuterCheckpoint = false;
    const failureStore = {
      filePath: stateStore.filePath,
      load: () => stateStore.load(),
      async save(value) {
        const gmailImport = value.gmailReadOnlyLifecycle?.entry?.import;
        const permission = value.sourcePermissionLifecycle?.entries?.["gmail:gmail-work"];
        if (!failedOuterCheckpoint
          && gmailImport?.pendingPageRead === null
          && gmailImport?.pagesCompleted === 1
          && permission?.bodyFetches === 1) {
          failedOuterCheckpoint = true;
          const error = new Error("Synthetic post-fetch outer checkpoint failure.");
          error.code = "SYNTHETIC_OUTER_CHECKPOINT_SAVE_FAILED";
          throw error;
        }
        return stateStore.save(value);
      }
    };

    const interrupted = await fetchApprovedGmailReferences({
      message: "Process my approved Gmail references",
      stateStore: failureStore,
      plugin,
      clock,
      maxPages: 1
    });

    assert.equal(interrupted.gmail.status, "needs-attention");
    assert.equal(interrupted.gmail.import.status, "read-may-have-occurred");
    assert.equal(interrupted.gmail.import.readMayHaveOccurred, true);
    assert.equal(interrupted.gmail.nextAction.kind, "revoke-and-start-fresh-gmail-review");
    assert.equal(interrupted.gmail.lastSafeError.code, "GMAIL_PAGE_READ_CHECKPOINT_UNCERTAIN");
    assert.deepEqual(interrupted.approvedReferences, []);
    assert.equal(plugin.approvedPageCalls, 1);

    const persisted = await stateStore.load();
    const pending = persisted.gmailReadOnlyLifecycle.entry.import.pendingPageRead;
    assert.equal(persisted.gmailReadOnlyLifecycle.entry.status, "needs-attention");
    assert.equal(persisted.gmailReadOnlyLifecycle.entry.import.status, "read-may-have-occurred");
    assert.equal(pending.reviewId, "outer-save-review");
    assert.equal(pending.grantId, "outer-save-grant");
    assert.equal(pending.checkpoint, "initial");
    assert.equal(pending.operationRevision, 1);
    assert.equal(persisted.sourcePermissionLifecycle.entries["gmail:gmail-work"].bodyFetches, 1);
    const uncertainStatus = await getGmailReadOnlyStatus({ stateStore });
    const uncertainPublicText = JSON.stringify(uncertainStatus);
    for (const internalIdentifier of [pending.operationId, pending.reviewId, pending.grantId]) {
      assert.equal(uncertainPublicText.includes(String(internalIdentifier)), false, "pending page/read generation details stay private");
    }
    assert.equal(uncertainStatus.gmail.connection.live, false);

    const callsBeforeRetry = plugin.approvedPageCalls;
    const blockedRetry = await fetchApprovedGmailReferences({
      message: "Retry my saved Gmail step",
      stateStore: new FileStateStore(stateStore.filePath),
      plugin,
      clock,
      maxPages: 1
    });
    assert.equal(blockedRetry.recoveryRequired, true);
    assert.deepEqual(blockedRetry.approvedReferences, []);
    assert.equal(plugin.approvedPageCalls, callsBeforeRetry);

    const revoked = await revokeGmailReadOnlyConnection({
      message: "Revoke this uncertain Gmail permission",
      stateStore: new FileStateStore(stateStore.filePath),
      plugin,
      clock
    });
    assert.equal(revoked.gmail.status, "revoked");
    await beginGmailConnection({
      message: "Connect Gmail again for my second brain",
      stateStore,
      plugin,
      clock
    });
    const fresh = await beginGmailPrivacyReview({
      message: "Start a fresh Gmail metadata review",
      stateStore,
      plugin,
      clock,
      reviewIdFactory: () => "fresh-after-uncertain-read"
    });
    assert.notEqual(fresh.gmail.permissionReview.permissionRequest.reviewId, "fresh-after-uncertain-read");
    assert.match(fresh.gmail.permissionReview.permissionRequest.reviewId, /^local-gmail-review-/);
    assert.equal(plugin.approvedPageCalls, callsBeforeRetry);
  });
});

test("a persistent post-read save failure remains visibly uncertain across restart without rereading", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "persistent-save-review", grantId: "persistent-save-grant" });
    let pendingGenerationSaved = false;
    const persistentFailureStore = {
      filePath: stateStore.filePath,
      load: () => stateStore.load(),
      async save(value) {
        const pending = value.gmailReadOnlyLifecycle?.entry?.import?.pendingPageRead;
        if (pending && !pendingGenerationSaved) {
          pendingGenerationSaved = true;
          return stateStore.save(value);
        }
        if (pendingGenerationSaved && pending) {
          const error = new Error("Synthetic persistent post-read save failure.");
          error.code = "SYNTHETIC_PERSISTENT_SAVE_FAILED";
          throw error;
        }
        return stateStore.save(value);
      }
    };

    const interrupted = await fetchApprovedGmailReferences({
      message: "Process my approved Gmail references",
      stateStore: persistentFailureStore,
      plugin,
      clock,
      maxPages: 1
    });
    assert.equal(interrupted.gmail.status, "needs-attention");
    assert.equal(interrupted.gmail.import.readMayHaveOccurred, true);
    assert.equal(interrupted.gmail.nextAction.kind, "revoke-and-start-fresh-gmail-review");
    assert.equal(plugin.approvedPageCalls, 1);

    const durableBeforeRetry = await stateStore.load();
    assert.ok(durableBeforeRetry.gmailReadOnlyLifecycle.entry.import.pendingPageRead);
    assert.equal(durableBeforeRetry.gmailReadOnlyLifecycle.entry.import.pagesCompleted, 0);
    assert.equal(durableBeforeRetry.sourcePermissionLifecycle.entries["gmail:gmail-work"].bodyFetches, 0);
    const status = await getGmailReadOnlyStatus({ stateStore: new FileStateStore(stateStore.filePath) });
    assert.equal(status.gmail.status, "needs-attention");
    assert.equal(status.gmail.import.status, "read-may-have-occurred");

    const callsBeforeRetry = plugin.approvedPageCalls;
    const blockedRetry = await fetchApprovedGmailReferences({
      message: "Retry Gmail after restart",
      stateStore: new FileStateStore(stateStore.filePath),
      plugin,
      clock,
      maxPages: 1
    });
    assert.equal(blockedRetry.recoveryRequired, true);
    assert.deepEqual(blockedRetry.approvedReferences, []);
    assert.equal(plugin.approvedPageCalls, callsBeforeRetry);
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

test("a non-throwing Gmail plugin revoke without exact-grant confirmation remains needs-attention", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    await connectReviewAndGrant({
      stateStore,
      plugin,
      clock,
      reviewId: "ambiguous-revoke-review",
      grantId: "ambiguous-revoke-grant"
    });
    const normalRevoke = plugin.revokePermissionGrant.bind(plugin);
    plugin.getPermissionGrantStatus = undefined;
    plugin.revokePermissionGrant = async ({ grantId }) => {
      plugin.grantRevocationCalls += 1;
      plugin.authorizedGrantIds.delete(grantId);
      // Deliberately no exact-grant result: a non-throw is not verification.
    };

    const unconfirmed = await skipGmailConnection({
      message: "Skip Gmail for now",
      stateStore,
      plugin,
      clock
    });
    assert.equal(unconfirmed.gmail.status, "needs-attention");
    assert.equal(unconfirmed.gmail.status === "skipped", false);
    assert.equal(unconfirmed.gmail.grantLifecycle.status, "revocation-unconfirmed");
    assert.equal(unconfirmed.gmail.grantLifecycle.revocationConfirmed, false);
    assert.equal(unconfirmed.gmail.lastSafeError.code, "GMAIL_PLUGIN_REVOCATION_UNCONFIRMED");
    const persisted = await stateStore.load();
    assert.equal(persisted.sourcePermissionLifecycle.entries["gmail:gmail-work"].status, "granted");

    plugin.revokePermissionGrant = normalRevoke;
    const confirmed = await skipGmailConnection({
      message: "Retry the saved Gmail skip",
      stateStore,
      plugin,
      clock
    });
    assert.equal(confirmed.gmail.status, "skipped");
    assert.equal(confirmed.gmail.grantLifecycle.revocationConfirmed, true);
  });
});

test("external revocation and a body-boundary violation fail closed without a live claim", async () => {
  await withGmailFixture(async ({ stateStore, plugin, clock }) => {
    plugin.revokedPageTokens = new Set(["page-2"]);
    await connectReviewAndGrant({ stateStore, plugin, clock, reviewId: "external-revoke-review", grantId: "external-revoke-grant" });
    const normalRevoke = plugin.revokePermissionGrant.bind(plugin);
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
    assert.equal(revoked.gmail.status, "needs-attention");
    assert.equal(revoked.recoverable, true);
    assert.equal(revoked.gmail.grantLifecycle.status, "revocation-unconfirmed");
    assert.equal(revoked.gmail.grantLifecycle.revocationConfirmed, false);
    assert.equal(revoked.gmail.connection.live, false);
    assert.deepEqual(revoked.approvedReferences.map((reference) => reference.sourceRecordId), ["gmail:mail-001"]);
    assert.equal(plugin.authorizedGrantIds.has("external-revoke-grant"), true);

    const status = await getGmailReadOnlyStatus({ stateStore });
    assert.equal(status.gmail.status, "needs-attention");

    plugin.revokePermissionGrant = normalRevoke;
    const retried = await revokeGmailReadOnlyConnection({
      message: "Retry and confirm Gmail revocation",
      stateStore,
      plugin,
      clock
    });
    assert.equal(retried.gmail.status, "revoked");
    assert.equal(retried.gmail.grantLifecycle.revocationConfirmed, true);
    assert.equal(plugin.authorizedGrantIds.has("external-revoke-grant"), false);
    await beginGmailConnection({ message: "Connect Gmail again for my second brain", stateStore, plugin, clock });
    const fresh = await beginGmailPrivacyReview({
      message: "Start a fresh Gmail review for my second brain",
      stateStore,
      plugin,
      clock,
      reviewIdFactory: () => "after-external-revocation"
    });
    assert.notEqual(fresh.gmail.permissionReview.permissionRequest.reviewId, "after-external-revocation");
    assert.match(fresh.gmail.permissionReview.permissionRequest.reviewId, /^local-gmail-review-/);
    assert.equal(fresh.gmail.permissionReview.activeGrant, null, "an externally revoked grant is not reused after cleanup is explicitly confirmed");
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
