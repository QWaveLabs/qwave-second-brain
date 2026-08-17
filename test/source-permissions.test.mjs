import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileStateStore,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedObsidianAdapter,
  SimulatedReadOnlyConnector,
  DEFAULT_PERMISSION_WINDOWS,
  SENSITIVE_CATEGORIES,
  beginSourcePermissionReview,
  denySourcePermission,
  fetchApprovedSourceContent,
  getSourcePermissionStatus,
  grantSourcePermission,
  revokeSourcePermission,
  startSetupSession
} from "../src/index.mjs";

async function withPermissionFixture(run, { connectorOptions, language = "en" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa139-"));
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  const adapters = {
    environment: new SimulatedEnvironmentAdapter(),
    obsidian: new SimulatedObsidianAdapter(),
    vault: new SimulatedDesktopVaultAdapter()
  };
  const connector = new SimulatedReadOnlyConnector(connectorOptions ?? {
    source: "gmail",
    account: { id: "work-account", label: "Work account" },
    people: [{ id: "person-1", label: "Taylor", accessLevel: "allowed" }],
    items: [{
      id: "conversation-1",
      kind: "conversation",
      area: "inbox",
      conversation: "conversation-1",
      category: "work",
      participantIds: ["person-1"],
      label: "Weekly planning"
    }]
  });

  try {
    await startSetupSession({
      message: language === "es" ? "Configura mi segundo cerebro" : "Set up my second brain",
      answers: { displayName: "Alex", focus: "prepare for the week" },
      decisions: { vaultName: "My Second Brain" },
      stateStore,
      adapters
    });
    await run({ stateStore, connector });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function approvedScope(review) {
  const scope = structuredClone(review.permissionReview.permissionRequest.requestedScope);
  scope.acknowledgements.modelProcessing = true;
  scope.acknowledgements.untrustedSourceMaterial = true;
  return scope;
}

test("metadata-only preflight never fetches a source body until an explicit granular grant exists", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    await assert.rejects(
      () => beginSourcePermissionReview({
        message: "/connect Gmail",
        stateStore,
        connector,
        source: "gmail"
      }),
      /do not need a command/i
    );
    assert.equal(connector.metadataPreflightCalls, 0);

    const review = await beginSourcePermissionReview({
      message: "Please connect Gmail to my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "review-1"
    });

    assert.equal(connector.metadataPreflightCalls, 1);
    assert.equal(connector.bodyFetchCalls, 0);
    assert.equal(connector.bodyAccesses, 0);
    assert.equal(review.permissionReview.readOnly, true);
    assert.equal(review.permissionReview.metadataPreflight.contentBodiesRead, false);
    assert.equal(review.permissionReview.permissionRequest.source, "gmail");
    assert.equal(review.permissionReview.permissionRequest.account.id, "work-account");
    assert.match(review.permissionReview.metadataPreflight.message, /have not read any message, file, or event body/i);
    assert.match(review.permissionReview.permissionRequest.cancelableReview, /no source body is read without an active grant/i);
    assert.match(review.permissionReview.permissionRequest.purpose, /only the items you approve/i);
    assert.match(review.permissionReview.permissionRequest.retention, /temporary local staging/i);
    assert.match(review.permissionReview.permissionRequest.disclosures.modelProcessing, /active AI provider/i);
    assert.match(review.permissionReview.permissionRequest.disclosures.untrustedSourceMaterial, /untrusted reference material/i);

    await assert.rejects(
      () => fetchApprovedSourceContent({
        message: "Please import the reviewed Gmail items",
        stateStore,
        connector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "review-1"
      }),
      /no active permission grant/i
    );
    assert.equal(connector.bodyFetchCalls, 0);
    assert.equal(connector.bodyAccesses, 0);

    const scope = review.permissionReview.permissionRequest.requestedScope;
    await assert.rejects(
      () => grantSourcePermission({
        message: "I approve the reviewed Gmail scope for my second brain",
        stateStore,
        connector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "review-1",
        scope
      }),
      /acknowledge both the active AI-provider processing disclosure/i
    );
    assert.equal(connector.grantRegistrationCalls, 0);
    scope.acknowledgements.modelProcessing = true;
    scope.acknowledgements.untrustedSourceMaterial = true;
    const granted = await grantSourcePermission({
      message: "I approve the reviewed Gmail scope for my second brain",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "review-1",
      scope,
      grantIdFactory: () => "grant-1"
    });

    assert.equal(granted.permissionReview.activeGrant.grantId, "grant-1");
    assert.equal(granted.permissionReview.activeGrant.disclosuresAcknowledged.modelProcessing.acknowledged, true);
    assert.equal(granted.permissionReview.activeGrant.disclosuresAcknowledged.untrustedSourceMaterial.acknowledged, true);

    const fetched = await fetchApprovedSourceContent({
      message: "Please import the approved Gmail items for my second brain",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "review-1"
    });

    assert.equal(connector.bodyFetchCalls, 1);
    assert.equal(connector.bodyAccesses, 1);
    assert.deepEqual(fetched.approvedRecords, [{
      sourceRecordId: "conversation-1",
      processingDisposition: "untrusted-inert-reference",
      source: "gmail"
    }]);
    assert.equal("body" in fetched.approvedRecords[0], false);
    assert.equal(fetched.permissionReview.metadataPreflight.contentBodiesReadAtPreflight, false);
    assert.equal(fetched.permissionReview.metadataPreflight.contentBodiesRead, true);
    assert.match(fetched.permissionReview.metadataPreflight.message, /metadata-only/i);
  });
});

test("the public review exposes the specified default windows and granular exclusion controls", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    const communications = await beginSourcePermissionReview({
      message: "Please review Gmail for my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "communications-review"
    });
    const communicationScope = communications.permissionReview.permissionRequest.requestedScope;
    assert.equal(communicationScope.dateRange.label, DEFAULT_PERMISSION_WINDOWS.communication.label);
    assert.equal(communicationScope.dateRange.pastDays, 90);
    assert.equal(communicationScope.dateRange.futureDays, 0);
    assert.deepEqual(
      communications.permissionReview.permissionRequest.exclusionsSupported,
      ["accounts", "areas", "folders", "channels", "people", "conversations", "categories", "dateRanges"]
    );

    const tooBroad = approvedScope(communications);
    tooBroad.dateRange = { kind: "rolling", pastDays: 365, futureDays: 0 };
    await assert.rejects(
      () => grantSourcePermission({
        message: "Approve the Gmail review",
        stateStore,
        connector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "communications-review",
        scope: tooBroad
      }),
      /does not match the reviewed default/i
    );
  });

  await withPermissionFixture(async ({ stateStore, connector }) => {
    const calendar = await beginSourcePermissionReview({
      message: "Please connect Calendar to my second brain",
      stateStore,
      connector,
      source: "calendar",
      reviewIdFactory: () => "calendar-review"
    });
    const calendarScope = calendar.permissionReview.permissionRequest.requestedScope;
    assert.equal(calendarScope.dateRange.label, DEFAULT_PERMISSION_WINDOWS.calendar.label);
    assert.equal(calendarScope.dateRange.pastMonths, 6);
    assert.equal(calendarScope.dateRange.futureDays, 90);
  }, {
    connectorOptions: {
      source: "calendar",
      account: { id: "calendar-account", label: "Calendar account" },
      items: [{ id: "event-1", area: "primary", category: "meetings", label: "Planning meeting" }]
    }
  });

  await withPermissionFixture(async ({ stateStore, connector }) => {
    const drive = await beginSourcePermissionReview({
      message: "Please connect Drive to my second brain",
      stateStore,
      connector,
      source: "drive",
      reviewIdFactory: () => "drive-review"
    });
    const driveScope = approvedScope(drive);
    assert.equal(driveScope.dateRange.label, DEFAULT_PERMISSION_WINDOWS.drive.label);
    assert.equal(driveScope.dateRange.dateRangeAllowed, false);

    driveScope.dateRange = { kind: "rolling", pastDays: 90, futureDays: 0 };
    await assert.rejects(
      () => grantSourcePermission({
        message: "Approve the Drive review",
        stateStore,
        connector,
        source: "drive",
        accountId: "drive-account",
        reviewId: "drive-review",
        scope: driveScope
      }),
      /selected folders, not an arbitrary date window/i
    );
  }, {
    connectorOptions: {
      source: "drive",
      account: { id: "drive-account", label: "Drive account" },
      items: [{ id: "file-1", folder: "Projects", category: "work", label: "Project brief" }]
    }
  });
});

test("Allowed, Restricted, and Blocked people retain their boundaries, including blocked group conversations", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    const review = await beginSourcePermissionReview({
      message: "Please review Gmail privacy for my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "people-review"
    });
    assert.deepEqual(review.permissionReview.metadataPreflight.blockedGroupConversations, [
      { id: "blocked-group", label: "Group planning" },
      { id: "blocked-plus-restricted-group", label: "Mixed private group" }
    ]);

    const scope = approvedScope(review);
    const granted = await grantSourcePermission({
      message: "Approve the reviewed Gmail privacy scope",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "people-review",
      scope,
      grantIdFactory: () => "people-grant"
    });
    assert.deepEqual(granted.permissionReview.activeGrant.scope.people.restricted, ["person-restricted"]);
    assert.deepEqual(granted.permissionReview.activeGrant.scope.people.blocked, ["person-blocked"]);
    assert.deepEqual(granted.permissionReview.activeGrant.scope.blockedGroupConversationExceptions, []);

    const defaultFetch = await fetchApprovedSourceContent({
      message: "Please import the approved Gmail material",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "people-review"
    });
    assert.deepEqual(defaultFetch.approvedRecords.map((record) => record.sourceRecordId), ["allowed-direct"]);

    await revokeSourcePermission({
      message: "Please revoke this Gmail permission",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "people-review"
    });
    const separateReview = await beginSourcePermissionReview({
      message: "Please start a new Gmail review for my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "group-exception-review"
    });
    const exceptionScope = approvedScope(separateReview);
    exceptionScope.blockedGroupConversationExceptions = ["blocked-group", "blocked-plus-restricted-group"];
    const exceptionGrant = await grantSourcePermission({
      message: "I explicitly approve this one reviewed group conversation",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "group-exception-review",
      scope: exceptionScope,
      grantIdFactory: () => "group-exception-grant"
    });
    assert.deepEqual(exceptionGrant.permissionReview.activeGrant.scope.blockedGroupConversationExceptions, ["blocked-group", "blocked-plus-restricted-group"]);

    const exceptionFetch = await fetchApprovedSourceContent({
      message: "Please import the explicitly approved Gmail material",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "group-exception-review"
    });
    assert.deepEqual(
      exceptionFetch.approvedRecords.map((record) => record.sourceRecordId).sort(),
      ["allowed-direct", "blocked-group"]
    );
  }, {
    connectorOptions: {
      source: "gmail",
      account: { id: "work-account", label: "Work account" },
      people: [
        { id: "person-allowed", label: "Avery", accessLevel: "allowed" },
        { id: "person-restricted", label: "Riley", accessLevel: "restricted" },
        { id: "person-blocked", label: "Morgan", accessLevel: "blocked" }
      ],
      items: [
        { id: "allowed-direct", kind: "conversation", area: "inbox", category: "work", participantIds: ["person-allowed"], label: "Project update" },
        { id: "restricted-direct", kind: "conversation", area: "inbox", category: "work", participantIds: ["person-restricted"], label: "Private conversation" },
        { id: "unclassified-direct", kind: "conversation", area: "inbox", category: "work", participantIds: ["person-not-in-review"], label: "Unclassified participant" },
        { id: "blocked-group", kind: "conversation", isGroup: true, area: "inbox", category: "work", participantIds: ["person-allowed", "person-blocked"], label: "Group planning" },
        { id: "blocked-plus-restricted-group", kind: "conversation", isGroup: true, area: "inbox", category: "work", participantIds: ["person-allowed", "person-blocked", "person-restricted"], label: "Mixed private group" }
      ]
    }
  });
});

test("reviewed date windows and explicit date exclusions narrow the bounded fetch", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    const clock = { now: () => new Date("2026-08-17T12:00:00.000Z") };
    const review = await beginSourcePermissionReview({
      message: "Please review Gmail for my second brain",
      stateStore,
      connector,
      source: "gmail",
      clock,
      reviewIdFactory: () => "date-exclusion-review"
    });
    const scope = approvedScope(review);
    scope.exclusions.dateRanges = [{
      from: "2026-08-11T00:00:00.000Z",
      to: "2026-08-11T23:59:59.999Z"
    }];
    const granted = await grantSourcePermission({
      message: "Approve the reviewed Gmail date boundary",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "date-exclusion-review",
      scope,
      clock,
      grantIdFactory: () => "date-exclusion-grant"
    });
    assert.deepEqual(granted.permissionReview.activeGrant.scope.exclusions.dateRanges, [{
      from: "2026-08-11T00:00:00.000Z",
      to: "2026-08-11T23:59:59.999Z"
    }]);

    const fetched = await fetchApprovedSourceContent({
      message: "Please import the approved Gmail material",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "date-exclusion-review"
    });
    assert.deepEqual(fetched.approvedRecords.map((record) => record.sourceRecordId), ["in-window"]);
  }, {
    connectorOptions: {
      source: "gmail",
      account: { id: "work-account", label: "Work account" },
      items: [
        { id: "out-of-window", area: "inbox", category: "work", timestamp: "2026-05-01T12:00:00.000Z", label: "Older item" },
        { id: "excluded-window", area: "inbox", category: "work", timestamp: "2026-08-11T12:00:00.000Z", label: "Excluded item" },
        { id: "in-window", area: "inbox", category: "work", timestamp: "2026-08-10T12:00:00.000Z", label: "Approved item" }
      ]
    }
  });
});

test("sensitive categories are grouped, excluded by default, and uncertain sensitivity never silently expands access", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    const review = await beginSourcePermissionReview({
      message: "Please review this Gmail source for my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "sensitive-review"
    });
    const groups = review.permissionReview.metadataPreflight.sensitiveGroups;
    assert.deepEqual(groups.map((group) => group.category).sort(), ["credentials", "uncertain-sensitivity"]);
    assert.deepEqual(groups.find((group) => group.category === "credentials").itemLabels, ["Account setup"]);
    assert.equal(SENSITIVE_CATEGORIES.includes("financial-identifiers"), true);
    assert.equal(SENSITIVE_CATEGORIES.includes("identity-documents"), true);
    assert.equal(SENSITIVE_CATEGORIES.includes("medical-information"), true);
    assert.equal(SENSITIVE_CATEGORIES.includes("legal-matters"), true);
    assert.equal(SENSITIVE_CATEGORIES.includes("hr-payroll"), true);
    assert.equal(SENSITIVE_CATEGORIES.includes("intimate-communications"), true);
    assert.equal(SENSITIVE_CATEGORIES.includes("minors"), true);
    assert.equal(SENSITIVE_CATEGORIES.includes("private-restricted-labels"), true);

    const scope = approvedScope(review);
    assert.deepEqual(scope.sensitiveGroups.included, []);
    assert.deepEqual(scope.sensitiveGroups.excluded.sort(), ["credentials", "uncertain-sensitivity"]);
    const granted = await grantSourcePermission({
      message: "Approve only the default non-sensitive Gmail scope",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "sensitive-review",
      scope,
      grantIdFactory: () => "sensitive-grant"
    });
    assert.deepEqual(granted.permissionReview.activeGrant.scope.sensitiveGroups.included, []);

    const fetched = await fetchApprovedSourceContent({
      message: "Please import the approved Gmail source",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "sensitive-review"
    });
    assert.deepEqual(fetched.approvedRecords.map((record) => record.sourceRecordId), ["routine-item"]);
  }, {
    connectorOptions: {
      source: "gmail",
      account: { id: "work-account", label: "Work account" },
      items: [
        { id: "routine-item", area: "inbox", category: "work", label: "Routine update" },
        { id: "credential-item", area: "inbox", category: "work", sensitiveCategories: ["credentials"], label: "Account setup" },
        { id: "uncertain-item", area: "inbox", category: "work", uncertainSensitivity: true, label: "Needs review" }
      ]
    }
  });
});

test("untrusted imported content cannot broaden a reviewed permission scope", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    const review = await beginSourcePermissionReview({
      message: "Please review Gmail for my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "injection-review"
    });
    const injectedScope = approvedScope(review);
    injectedScope.sourceDrivenPermission = "scope-expansion-attempt";
    await assert.rejects(
      () => grantSourcePermission({
        message: "Approve the reviewed Gmail scope",
        stateStore,
        connector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "injection-review",
        scope: injectedScope
      }),
      /untrusted request to change the permission shape/i
    );

    const expandedAreaScope = approvedScope(review);
    expandedAreaScope.areas.push("unreviewed-area");
    await assert.rejects(
      () => grantSourcePermission({
        message: "Approve the reviewed Gmail scope",
        stateStore,
        connector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "injection-review",
        scope: expandedAreaScope
      }),
      /not part of the metadata review/i
    );
    assert.equal(connector.bodyFetchCalls, 0);
    assert.equal(connector.bodyAccesses, 0);
    assert.equal(connector.writeCalls, 0);
  }, {
    connectorOptions: {
      source: "gmail",
      account: { id: "work-account", label: "Work account" },
      items: [{
        id: "untrusted-item",
        area: "inbox",
        category: "work",
        label: "Planning note",
        untrustedInstructionType: "scope-expansion-attempt"
      }]
    }
  });
});

test("denial, retry, resume, idempotency, and revocation do not revive stale grants", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    const deniedReview = await beginSourcePermissionReview({
      message: "Please review Gmail for my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "denied-review"
    });
    const denied = await denySourcePermission({
      message: "Do not approve Gmail right now",
      stateStore,
      source: "gmail",
      accountId: "work-account",
      reviewId: "denied-review"
    });
    assert.equal(denied.permissionReview.status, "denied");
    assert.match(denied.message, /No content access was granted/i);

    await assert.rejects(
      () => grantSourcePermission({
        message: "Approve the old Gmail review",
        stateStore,
        connector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "denied-review",
        scope: approvedScope(deniedReview)
      }),
      /no longer valid/i
    );

    const retried = await beginSourcePermissionReview({
      message: "Please start a new Gmail review for my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "retry-review"
    });
    const retryScope = approvedScope(retried);
    const firstGrant = await grantSourcePermission({
      message: "Approve the new Gmail review",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "retry-review",
      scope: retryScope,
      grantIdFactory: () => "retry-grant"
    });
    const resumedStore = new FileStateStore(stateStore.filePath);
    const idempotentGrant = await grantSourcePermission({
      message: "Approve the new Gmail review again",
      stateStore: resumedStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "retry-review",
      scope: retryScope,
      grantIdFactory: () => "should-not-be-used"
    });
    assert.equal(firstGrant.permissionReview.activeGrant.grantId, "retry-grant");
    assert.equal(idempotentGrant.permissionReview.activeGrant.grantId, "retry-grant");
    assert.equal(idempotentGrant.permissionReview.audit.filter((event) => event.type === "permission-granted").length, 1);

    const resumedConnector = new SimulatedReadOnlyConnector({
      source: "gmail",
      account: { id: "work-account", label: "Work account" },
      items: [{ id: "conversation-1", kind: "conversation", area: "inbox", conversation: "conversation-1", category: "work", label: "Weekly planning" }]
    });
    const resumedFetch = await fetchApprovedSourceContent({
      message: "Please import the approved Gmail material after resuming",
      stateStore: resumedStore,
      connector: resumedConnector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "retry-review"
    });
    assert.deepEqual(resumedFetch.approvedRecords.map((record) => record.sourceRecordId), ["conversation-1"]);
    assert.equal(resumedConnector.bodyAccesses, 1);
    assert.equal(resumedConnector.grantRegistrationCalls, 1);

    const revoked = await revokeSourcePermission({
      message: "Please revoke the Gmail permission",
      stateStore: resumedStore,
      connector: resumedConnector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "retry-review"
    });
    assert.equal(revoked.permissionReview.status, "revoked");
    assert.match(revoked.message, /cannot be revived/i);

    await assert.rejects(
      () => fetchApprovedSourceContent({
        message: "Please import Gmail now",
        stateStore: resumedStore,
        connector: resumedConnector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "retry-review"
      }),
      /no active permission grant/i
    );
    await assert.rejects(
      () => grantSourcePermission({
        message: "Approve the stale Gmail request",
        stateStore: resumedStore,
        connector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "retry-review",
        scope: retryScope
      }),
      /no longer valid/i
    );
    assert.equal(connector.bodyFetchCalls, 0);
    await assert.rejects(
      () => resumedConnector.fetchApprovedContent({
        source: "gmail",
        accountId: "work-account",
        grant: {
          id: "retry-grant",
          status: "active",
          scope: idempotentGrant.permissionReview.activeGrant.scope
        }
      }),
      /refused a fetch/i
    );
    assert.equal(resumedConnector.bodyAccesses, 1);

    const status = await getSourcePermissionStatus({
      stateStore: resumedStore,
      source: "gmail",
      accountId: "work-account"
    });
    assert.equal(status.permissionReview.status, "revoked");
    assert.equal(status.permissionReview.audit.some((event) => event.type === "permission-denied"), true);
    assert.equal(status.permissionReview.audit.some((event) => event.type === "permission-revoked"), true);
  });
});

test("Spanish permission language retains the same metadata, disclosure, and cancellation boundaries", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    const review = await beginSourcePermissionReview({
      message: "Quiero conectar Gmail a mi segundo cerebro",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "spanish-review"
    });
    assert.match(review.permissionReview.metadataPreflight.message, /Todavía no he leído ningún cuerpo/i);
    assert.match(review.permissionReview.permissionRequest.connectionBoundary, /solo de lectura/i);
    assert.match(review.permissionReview.permissionRequest.disclosures.modelProcessing, /proveedor de IA activo/i);
    assert.match(review.permissionReview.permissionRequest.disclosures.untrustedSourceMaterial, /material de referencia no confiable/i);
    assert.match(review.permissionReview.permissionRequest.cancelableReview, /Puedes cancelar/i);

    const granted = await grantSourcePermission({
      message: "Apruebo el alcance revisado de Gmail",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "spanish-review",
      scope: approvedScope(review),
      grantIdFactory: () => "spanish-grant"
    });
    assert.match(granted.permissionReview.activeGrant.disclosuresAcknowledged.modelProcessing.text, /proveedor de IA activo/i);
    assert.match(granted.permissionReview.activeGrant.disclosuresAcknowledged.untrustedSourceMaterial.text, /no confiable/i);
  }, { language: "es" });
});

test("the simulated connector rejects a forged grant and a failed activation leaves no accidental access", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    await assert.rejects(
      () => connector.fetchApprovedContent({
        source: "gmail",
        accountId: "work-account",
        grant: { id: "forged-grant", status: "active", scope: { accountId: "work-account" } }
      }),
      /refused a fetch/i
    );
    assert.equal(connector.bodyAccesses, 0);

    const review = await beginSourcePermissionReview({
      message: "Please review Gmail for my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "activation-retry-review"
    });
    const scope = approvedScope(review);
    await assert.rejects(
      () => grantSourcePermission({
        message: "Approve the reviewed Gmail scope",
        stateStore,
        connector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "activation-retry-review",
        scope,
        grantIdFactory: () => "failed-grant"
      }),
      /could not activate that read-only permission safely/i
    );
    const afterFailure = await getSourcePermissionStatus({ stateStore, source: "gmail", accountId: "work-account" });
    assert.equal(afterFailure.permissionReview.status, "awaiting-grant");
    assert.equal(afterFailure.permissionReview.activeGrant, null);
    assert.equal(connector.bodyAccesses, 0);

    const retried = await grantSourcePermission({
      message: "Retry the reviewed Gmail approval",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "activation-retry-review",
      scope,
      grantIdFactory: () => "activated-grant"
    });
    assert.equal(retried.permissionReview.activeGrant.grantId, "activated-grant");
  }, {
    connectorOptions: {
      source: "gmail",
      account: { id: "work-account", label: "Work account" },
      items: [{ id: "item-1", area: "inbox", category: "work", label: "Planning note" }],
      failuresBeforeGrantRegistration: 1
    }
  });
});

test("a malformed persisted grant fails closed instead of widening a resumed fetch", async () => {
  await withPermissionFixture(async ({ stateStore, connector }) => {
    const review = await beginSourcePermissionReview({
      message: "Please review Gmail for my second brain",
      stateStore,
      connector,
      source: "gmail",
      reviewIdFactory: () => "persisted-grant-review"
    });
    await grantSourcePermission({
      message: "Approve the reviewed Gmail scope",
      stateStore,
      connector,
      source: "gmail",
      accountId: "work-account",
      reviewId: "persisted-grant-review",
      scope: approvedScope(review),
      grantIdFactory: () => "persisted-grant"
    });

    const alteredState = await stateStore.load();
    const entry = Object.values(alteredState.sourcePermissionLifecycle.entries)[0];
    entry.grants.find((grant) => grant.id === "persisted-grant").scope.areas = ["unreviewed-area"];
    await stateStore.save(alteredState);

    await assert.rejects(
      () => fetchApprovedSourceContent({
        message: "Please import Gmail after resuming",
        stateStore: new FileStateStore(stateStore.filePath),
        connector,
        source: "gmail",
        accountId: "work-account",
        reviewId: "persisted-grant-review"
      }),
      /saved permission no longer matches its reviewed scope/i
    );
    assert.equal(connector.bodyAccesses, 0);
  });
});
