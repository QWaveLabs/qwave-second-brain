/**
 * Emits a safe, customer-visible QWA-149 proof as JSON.
 *
 * It uses only synthetic opaque export ids and a temporary local state file.
 * It never opens a real source, reads a source body, or writes to a source.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FileStateStore,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedGenericExportAdapter,
  SimulatedObsidianAdapter,
  beginSimulatedExportPreview,
  buildSimulatedExportPermissionScope,
  getSourceStatusHandoff,
  grantSimulatedExportPermission,
  getGoogleDriveConnectionStatus,
  getIMessageBetaStatus,
  getPersistedAdapterSourceStatus,
  importSimulatedExportSnapshot,
  startSetupSession
} from "../src/index.mjs";

const clock = { now: () => new Date("2026-08-17T12:00:00.000Z") };
const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa149-proof-"));
const localAlias = (namespace, kind, suffix) => (
  `local-${namespace}-${kind}-00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`
);
const aliasState = (namespace, mappings) => ({ version: 1, namespace, mappings });
const accountMapping = (namespace, accountId, suffix) => ({
  kind: "account",
  raw: accountId,
  alias: localAlias(namespace, "account", suffix)
});

try {
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  await startSetupSession({
    message: "Set up my second brain",
    answers: { displayName: "Demo", focus: "review safe source states" },
    decisions: { vaultName: "My Second Brain" },
    stateStore,
    clock,
    adapters: {
      environment: new SimulatedEnvironmentAdapter(),
      obsidian: new SimulatedObsidianAdapter(),
      vault: new SimulatedDesktopVaultAdapter()
    }
  });
  const adapter = new SimulatedGenericExportAdapter({
    exportId: "proof-export",
    items: [{ id: "proof-item-001", category: "planning" }]
  });
  const preview = await beginSimulatedExportPreview({
    message: "Preview a simulated export for my second brain",
    stateStore,
    adapter,
    clock,
    reviewIdFactory: () => "proof-review"
  });
  const scope = buildSimulatedExportPermissionScope({
    metadataPreview: preview.sourceStatus.metadataPreview,
    selectedItemIds: ["proof-item-001"]
  });
  scope.acknowledgements.metadataOnlyPreview = true;
  scope.acknowledgements.untrustedSourceMaterial = true;
  scope.acknowledgements.simulatedSnapshot = true;
  await grantSimulatedExportPermission({
    message: "I approve exactly this simulated export item",
    stateStore,
    adapter,
    reviewId: "proof-review",
    scope,
    clock,
    grantIdFactory: () => "proof-grant"
  });
  const imported = await importSimulatedExportSnapshot({
    message: "Import the approved simulated snapshot",
    stateStore,
    adapter,
    reviewId: "proof-review",
    clock
  });
  const rawFailureCodes = [
    "RAW_PROOF_DRIVE_METADATA_CODE",
    "RAW_PROOF_DRIVE_FETCH_CODE",
    "RAW_PROOF_DRIVE_REVOKED_CODE",
    "RAW_PROOF_IMESSAGE_METADATA_CODE",
    "RAW_PROOF_IMESSAGE_ROOT_CODE",
    "RAW_PROOF_MALFORMED_DRIVE_CODE",
    "RAW_PROOF_MALFORMED_IMESSAGE_CODE",
    "RAW_PROOF_MISSING_ACCOUNT_DRIVE_CODE",
    "RAW_PROOF_MISSING_ACCOUNT_IMESSAGE_CODE"
  ];
  const duplicateDriveAccountAlias = localAlias("drive", "account", 901);
  const malformedDriveAccountAlias = localAlias("drive", "account", 902);
  const crossDomainDriveAlias = localAlias("drive", "account", 917);
  const collidingIMessageReviewAlias = localAlias("imessage", "review", 903);
  const collidingCalendarReferenceAlias = localAlias("calendar", "reference", 904);
  const collidingCalendarGenerationAlias = localAlias("calendar", "generation", 905);
  const legacyState = await stateStore.load();
  legacyState.googleDriveLifecycle = {
    version: 1,
    entries: {
      "drive:proof-drive-attention": {
        source: "drive",
        accountId: "proof-drive-attention",
        status: "needs-attention",
        authorization: { status: "unavailable", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: ["proof-drive-folder"],
        reviewId: "proof-drive-review",
        normalizedMetadataById: {
          "proof-drive-record": {
            source: "drive",
            sourceRecordId: "proof-drive-record",
            folderId: "proof-drive-folder"
          }
        },
        audit: [{
          type: "drive-metadata-review-unavailable",
          accountId: "proof-drive-attention",
          reviewId: "proof-drive-review",
          grantId: "proof-drive-grant",
          sourceRecordId: "proof-drive-record",
          operationId: "proof-drive-metadata-operation",
          reason: rawFailureCodes[0],
          contentBodiesRead: false
        }, {
          type: "drive-approved-reference-fetch-interrupted",
          accountId: "proof-drive-attention",
          reviewId: "proof-drive-review",
          grantId: "proof-drive-grant",
          sourceRecordId: "proof-drive-record",
          operationId: "proof-drive-fetch-operation",
          reason: rawFailureCodes[1],
          contentBodiesRead: false
        }]
      },
      "drive:proof-drive-revoked": {
        source: "drive",
        accountId: "proof-drive-revoked",
        status: "revoked",
        authorization: { status: "revoked", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: [],
        reviewId: "proof-drive-revoked-review",
        normalizedMetadataById: {},
        audit: [{
          type: "drive-approved-reference-fetch-interrupted",
          accountId: "proof-drive-revoked",
          reviewId: "proof-drive-revoked-review",
          grantId: "proof-drive-revoked-grant",
          operationId: "proof-drive-revoked-operation",
          reason: rawFailureCodes[2],
          contentBodiesRead: false
        }]
      },
      "drive:proof-collision-a": {
        source: "drive",
        accountId: "proof-drive-collision-a",
        publicIdentifierAliases: aliasState("drive", [{
          kind: "account",
          raw: "proof-drive-collision-a",
          alias: duplicateDriveAccountAlias
        }]),
        status: "authorization-denied",
        authorization: { status: "denied", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: [],
        reviewId: null,
        normalizedMetadataById: {},
        audit: []
      },
      "drive:proof-collision-b": {
        source: "drive",
        accountId: "proof-drive-collision-b",
        publicIdentifierAliases: aliasState("drive", [{
          kind: "account",
          raw: "proof-drive-collision-b",
          alias: duplicateDriveAccountAlias
        }]),
        status: "revoked",
        authorization: { status: "revoked", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: [],
        reviewId: null,
        normalizedMetadataById: {},
        audit: []
      },
      "drive:proof-malformed": {
        source: "drive",
        accountId: "proof-drive-malformed",
        publicIdentifierAliases: aliasState("drive", [
          {
            kind: "account",
            raw: "proof-drive-malformed",
            alias: malformedDriveAccountAlias
          },
          { kind: "review", raw: "proof-drive-malformed-review", alias: "raw-drive-review-alias" }
        ]),
        status: "needs-attention",
        authorization: { status: "unavailable", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: [],
        reviewId: "proof-drive-malformed-review",
        normalizedMetadataById: {},
        audit: [{
          type: "drive-metadata-review-unavailable",
          reason: rawFailureCodes[5],
          contentBodiesRead: false
        }]
      },
      "drive:proof-malformed-collision-peer": {
        source: "drive",
        accountId: "proof-drive-malformed-collision-peer",
        publicIdentifierAliases: aliasState("drive", [{
          kind: "account",
          raw: "proof-drive-malformed-collision-peer",
          alias: malformedDriveAccountAlias
        }]),
        status: "processed",
        authorization: { status: "active", readOnly: true, metadataOnly: true, attempts: 1 },
        authorizedFolderIds: [],
        reviewId: null,
        normalizedMetadataById: {},
        audit: []
      },
      "drive:proof-missing-account": {
        source: "drive",
        accountId: null,
        publicIdentifierAliases: aliasState("drive", []),
        status: "needs-attention",
        authorization: { status: "unavailable", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: [],
        reviewId: null,
        normalizedMetadataById: {},
        audit: [{
          type: "drive-metadata-review-unavailable",
          reason: rawFailureCodes[7],
          contentBodiesRead: false
        }]
      },
      "drive:proof-duplicate-source-a": {
        source: "drive",
        accountId: "proof-drive-duplicate-source",
        publicIdentifierAliases: aliasState("drive", [
          accountMapping("drive", "proof-drive-duplicate-source", 915)
        ]),
        status: "awaiting-authorization",
        authorization: { status: "not-started", readOnly: false, metadataOnly: false, attempts: 0 },
        authorizedFolderIds: [],
        reviewId: null,
        normalizedMetadataById: {},
        audit: []
      },
      "drive:proof-duplicate-source-b": {
        source: "drive",
        accountId: "proof-drive-duplicate-source",
        publicIdentifierAliases: aliasState("drive", [
          accountMapping("drive", "proof-drive-duplicate-source", 916)
        ]),
        status: "revoked",
        authorization: { status: "revoked", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: [],
        reviewId: null,
        normalizedMetadataById: {},
        audit: []
      },
      "drive:proof-cross-domain-source": {
        source: "drive",
        accountId: "proof-drive-cross-domain-source",
        publicIdentifierAliases: aliasState("drive", [{
          kind: "account",
          raw: "proof-drive-cross-domain-source",
          alias: crossDomainDriveAlias
        }]),
        status: "awaiting-authorization",
        authorization: { status: "not-started", readOnly: false, metadataOnly: false, attempts: 0 },
        authorizedFolderIds: [],
        reviewId: null,
        normalizedMetadataById: {},
        audit: []
      },
      "drive:proof-cross-domain-alias": {
        source: "drive",
        accountId: crossDomainDriveAlias,
        publicIdentifierAliases: aliasState("drive", [
          accountMapping("drive", crossDomainDriveAlias, 918)
        ]),
        status: "revoked",
        authorization: { status: "revoked", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: [],
        reviewId: null,
        normalizedMetadataById: {},
        audit: []
      }
    },
    audit: []
  };
  legacyState.imessageBetaLifecycle = {
    version: 1,
    entries: {
      "imessage:proof-imessage-fallback": {
        source: "imessage",
        accountId: "proof-imessage-fallback",
        status: "snapshot-available",
        mode: "snapshot",
        connectionTruth: "beta",
        localAccess: { status: "unavailable", attempts: 1 },
        snapshot: { available: true, started: false, oneTime: true, live: false },
        contactAndGroupPrivacyApplied: false,
        sensitiveApprovals: {
          attachments: { approved: false, approvedAt: null },
          highRiskIdentifiers: { approved: false, approvedAt: null }
        },
        reviewId: "proof-imessage-review",
        audit: [{
          type: "imessage-metadata-review-unavailable",
          accountId: "proof-imessage-fallback",
          reviewId: "proof-imessage-review",
          grantId: "proof-imessage-grant",
          sourceRecordId: "proof-imessage-record",
          operationId: "proof-imessage-operation",
          reason: rawFailureCodes[3],
          contentBodiesRead: false
        }]
      },
      "imessage:proof-review-collision-a": {
        source: "imessage",
        accountId: "proof-imessage-review-collision-a",
        publicIdentifierAliases: aliasState("imessage", [
          accountMapping("imessage", "proof-imessage-review-collision-a", 906),
          { kind: "review", raw: "proof-imessage-review-a", alias: collidingIMessageReviewAlias }
        ]),
        status: "snapshot-available",
        mode: "snapshot",
        connectionTruth: "beta",
        localAccess: { status: "unavailable", attempts: 1 },
        snapshot: { available: true, started: false, oneTime: true, live: false },
        contactAndGroupPrivacyApplied: false,
        sensitiveApprovals: {
          attachments: { approved: false, approvedAt: null },
          highRiskIdentifiers: { approved: false, approvedAt: null }
        },
        reviewId: "proof-imessage-review-a",
        audit: []
      },
      "imessage:proof-review-collision-b": {
        source: "imessage",
        accountId: "proof-imessage-review-collision-b",
        publicIdentifierAliases: aliasState("imessage", [
          accountMapping("imessage", "proof-imessage-review-collision-b", 907),
          { kind: "review", raw: "proof-imessage-review-b", alias: collidingIMessageReviewAlias }
        ]),
        status: "processed",
        mode: "snapshot",
        connectionTruth: "beta",
        localAccess: { status: "unavailable", attempts: 1 },
        snapshot: { available: true, started: true, oneTime: true, live: false },
        contactAndGroupPrivacyApplied: true,
        sensitiveApprovals: {
          attachments: { approved: false, approvedAt: null },
          highRiskIdentifiers: { approved: false, approvedAt: null }
        },
        reviewId: "proof-imessage-review-b",
        audit: []
      },
      "imessage:proof-malformed": {
        source: "imessage",
        accountId: "proof-imessage-malformed",
        publicIdentifierAliases: aliasState("imessage", [
          accountMapping("imessage", "proof-imessage-malformed", 908),
          { kind: "generation", raw: "proof-imessage-malformed-generation", alias: "raw-imessage-generation-alias" }
        ]),
        status: "snapshot-available",
        mode: "snapshot",
        connectionTruth: "beta",
        localAccess: { status: "unavailable", attempts: 1 },
        snapshot: { available: true, started: false, oneTime: true, live: false },
        contactAndGroupPrivacyApplied: false,
        sensitiveApprovals: {
          attachments: { approved: false, approvedAt: null },
          highRiskIdentifiers: { approved: false, approvedAt: null }
        },
        reviewId: null,
        audit: [{
          type: "imessage-metadata-review-unavailable",
          reason: rawFailureCodes[6],
          contentBodiesRead: false
        }]
      },
      "imessage:proof-missing-account": {
        source: "imessage",
        accountId: null,
        publicIdentifierAliases: aliasState("imessage", []),
        status: "snapshot-available",
        mode: "snapshot",
        connectionTruth: "beta",
        localAccess: { status: "unavailable", attempts: 1 },
        snapshot: { available: true, started: false, oneTime: true, live: false },
        contactAndGroupPrivacyApplied: false,
        sensitiveApprovals: {
          attachments: { approved: false, approvedAt: null },
          highRiskIdentifiers: { approved: false, approvedAt: null }
        },
        reviewId: null,
        audit: [{
          type: "imessage-metadata-review-unavailable",
          reason: rawFailureCodes[8],
          contentBodiesRead: false
        }]
      }
    },
    audit: [{
      type: "imessage-snapshot-fallback-available",
      accountId: "proof-imessage-fallback",
      reason: rawFailureCodes[4]
    }]
  };
  legacyState.googleCalendarLifecycle = {
    version: 1,
    entries: {
      "calendar:proof-reference-collision-a": {
        source: "calendar",
        accountId: "proof-calendar-reference-collision-a",
        publicIdentifierAliases: aliasState("calendar", [
          accountMapping("calendar", "proof-calendar-reference-collision-a", 909),
          { kind: "reference", raw: "proof-calendar-reference-a", alias: collidingCalendarReferenceAlias }
        ]),
        status: "authorization-denied",
        audit: [{ sourceRecordId: "proof-calendar-reference-a" }]
      },
      "calendar:proof-reference-collision-b": {
        source: "calendar",
        accountId: "proof-calendar-reference-collision-b",
        publicIdentifierAliases: aliasState("calendar", [
          accountMapping("calendar", "proof-calendar-reference-collision-b", 910),
          { kind: "reference", raw: "proof-calendar-reference-b", alias: collidingCalendarReferenceAlias }
        ]),
        status: "revoked",
        audit: [{ sourceRecordId: "proof-calendar-reference-b" }]
      },
      "calendar:proof-generation-collision-a": {
        source: "calendar",
        accountId: "proof-calendar-generation-collision-a",
        publicIdentifierAliases: aliasState("calendar", [
          accountMapping("calendar", "proof-calendar-generation-collision-a", 911),
          { kind: "generation", raw: "proof-calendar-generation-a", alias: collidingCalendarGenerationAlias }
        ]),
        status: "connected",
        audit: [{ operationId: "proof-calendar-generation-a" }]
      },
      "calendar:proof-generation-collision-b": {
        source: "calendar",
        accountId: "proof-calendar-generation-collision-b",
        publicIdentifierAliases: aliasState("calendar", [
          accountMapping("calendar", "proof-calendar-generation-collision-b", 912),
          { kind: "generation", raw: "proof-calendar-generation-b", alias: collidingCalendarGenerationAlias }
        ]),
        status: "skipped",
        audit: [{ operationId: "proof-calendar-generation-b" }]
      },
      "calendar:proof-malformed": {
        source: "calendar",
        accountId: "proof-calendar-malformed",
        publicIdentifierAliases: aliasState("calendar", [
          accountMapping("calendar", "proof-calendar-malformed", 913),
          { kind: "reference", raw: "proof-calendar-malformed-reference", alias: "raw-calendar-reference-alias" }
        ]),
        status: "connected",
        audit: []
      },
      "calendar:proof-valid": {
        source: "calendar",
        accountId: "proof-calendar-valid",
        publicIdentifierAliases: aliasState("calendar", [
          accountMapping("calendar", "proof-calendar-valid", 914)
        ]),
        status: "authorization-denied",
        audit: []
      }
    },
    audit: []
  };
  await stateStore.save(legacyState);

  // Reopen the durable file, then ask for handoff first. No specialized
  // connector status call is allowed to pre-clean this proof fixture.
  const restartedStore = new FileStateStore(stateStore.filePath);
  let handoffMigrationLoadCalls = 0;
  let handoffMigrationSaveCalls = 0;
  const countingRestartedStore = {
    async load() {
      handoffMigrationLoadCalls += 1;
      return restartedStore.load();
    },
    async save(nextState) {
      handoffMigrationSaveCalls += 1;
      return restartedStore.save(nextState);
    }
  };
  const handoff = await getSourceStatusHandoff({ stateStore: countingRestartedStore });
  assert.equal(handoffMigrationLoadCalls, 1);
  assert.equal(handoffMigrationSaveCalls, 1);
  const persisted = await restartedStore.load();
  const driveAttention = persisted.googleDriveLifecycle.entries["drive:proof-drive-attention"];
  const driveRevoked = persisted.googleDriveLifecycle.entries["drive:proof-drive-revoked"];
  const imessage = persisted.imessageBetaLifecycle.entries["imessage:proof-imessage-fallback"];
  const accountAlias = (entry) => entry.publicIdentifierAliases.mappings
    .find((mapping) => mapping.kind === "account" && mapping.raw === entry.accountId).alias;
  const driveAttentionAlias = accountAlias(driveAttention);
  const driveRevokedAlias = accountAlias(driveRevoked);
  const imessageAlias = accountAlias(imessage);
  const validCalendarAlias = localAlias("calendar", "account", 914);
  const publicIds = handoff.sourceStatusHandoff.sources.map((source) => source.source.id);
  assert.equal(new Set(publicIds).size, publicIds.length);
  for (const omittedSourceId of [
    `drive:${duplicateDriveAccountAlias}`,
    `drive:${malformedDriveAccountAlias}`,
    `drive:${localAlias("drive", "account", 915)}`,
    `drive:${localAlias("drive", "account", 916)}`,
    `drive:${crossDomainDriveAlias}`,
    `drive:${localAlias("drive", "account", 918)}`,
    `imessage:${localAlias("imessage", "account", 906)}`,
    `imessage:${localAlias("imessage", "account", 907)}`,
    `imessage:${localAlias("imessage", "account", 908)}`,
    `calendar:${localAlias("calendar", "account", 909)}`,
    `calendar:${localAlias("calendar", "account", 910)}`,
    `calendar:${localAlias("calendar", "account", 911)}`,
    `calendar:${localAlias("calendar", "account", 912)}`,
    `calendar:${localAlias("calendar", "account", 913)}`
  ]) {
    assert.equal(publicIds.includes(omittedSourceId), false);
  }
  assert.equal(publicIds.includes(`drive:${driveAttentionAlias}`), true);
  assert.equal(publicIds.includes(`drive:${driveRevokedAlias}`), true);
  assert.equal(publicIds.includes(`imessage:${imessageAlias}`), true);
  assert.equal(publicIds.includes(`calendar:${validCalendarAlias}`), true);
  const driveAttentionStatus = await getGoogleDriveConnectionStatus({
    stateStore: restartedStore,
    accountId: driveAttentionAlias
  });
  const driveRevokedStatus = await getGoogleDriveConnectionStatus({
    stateStore: restartedStore,
    accountId: driveRevokedAlias
  });
  const imessageStatus = await getIMessageBetaStatus({
    stateStore: restartedStore,
    accountId: imessageAlias
  });
  const calendarValidStatus = getPersistedAdapterSourceStatus({
    state: persisted,
    adapter: "google-calendar",
    accountId: validCalendarAlias
  });
  assert.equal(calendarValidStatus?.source.id, `calendar:${validCalendarAlias}`);
  assert.equal(getPersistedAdapterSourceStatus({
    state: persisted,
    adapter: "google-calendar",
    accountId: localAlias("calendar", "account", 909)
  }), null);
  assert.equal(getPersistedAdapterSourceStatus({
    state: persisted,
    adapter: "google-drive",
    accountId: duplicateDriveAccountAlias
  }), null);
  assert.equal(getPersistedAdapterSourceStatus({
    state: persisted,
    adapter: "google-drive",
    accountId: malformedDriveAccountAlias
  }), null);
  assert.equal(getPersistedAdapterSourceStatus({
    state: persisted,
    adapter: "google-drive",
    accountId: "proof-drive-duplicate-source"
  }), null);
  assert.equal(getPersistedAdapterSourceStatus({
    state: persisted,
    adapter: "google-drive",
    accountId: crossDomainDriveAlias
  }), null);
  await assert.rejects(
    getGoogleDriveConnectionStatus({
      stateStore: restartedStore,
      accountId: duplicateDriveAccountAlias
    }),
    (error) => error?.code === "DRIVE_LOCAL_ACCOUNT_REFERENCE_REQUIRED"
  );
  await assert.rejects(
    getGoogleDriveConnectionStatus({
      stateStore: restartedStore,
      accountId: malformedDriveAccountAlias
    }),
    (error) => error?.code === "DRIVE_LOCAL_ACCOUNT_REFERENCE_REQUIRED"
  );
  await assert.rejects(
    getGoogleDriveConnectionStatus({
      stateStore: restartedStore,
      accountId: localAlias("drive", "account", 915)
    }),
    (error) => error?.code === "DRIVE_LOCAL_ACCOUNT_REFERENCE_REQUIRED"
  );
  await assert.rejects(
    getGoogleDriveConnectionStatus({
      stateStore: restartedStore,
      accountId: crossDomainDriveAlias
    }),
    (error) => error?.code === "DRIVE_LOCAL_ACCOUNT_REFERENCE_REQUIRED"
  );
  await assert.rejects(
    getIMessageBetaStatus({
      stateStore: restartedStore,
      accountId: localAlias("imessage", "account", 906)
    }),
    (error) => error?.code === "IMESSAGE_LOCAL_ACCOUNT_REFERENCE_REQUIRED"
  );
  const publicEvidence = JSON.stringify({
    handoff,
    driveAttentionStatus,
    driveRevokedStatus,
    imessageStatus,
    calendarValidStatus
  });
  const persistedRoot = JSON.stringify(persisted);
  for (const rawFailureCode of rawFailureCodes) {
    assert.equal(persistedRoot.includes(rawFailureCode), false);
    assert.equal(publicEvidence.includes(rawFailureCode), false);
  }
  assert.deepEqual(
    driveAttention.audit.map((event) => event.reason),
    ["DRIVE_METADATA_REVIEW_FAILED", "DRIVE_APPROVED_FETCH_FAILED"]
  );
  assert.equal(driveRevoked.audit[0].reason, "DRIVE_APPROVED_FETCH_AUTHORIZATION_REVOKED");
  assert.equal(imessage.audit[0].reason, "IMESSAGE_METADATA_REVIEW_FAILED");
  assert.equal(persisted.imessageBetaLifecycle.audit[0].reason, "IMESSAGE_METADATA_REVIEW_FAILED");
  assert.equal(
    persisted.googleDriveLifecycle.entries["drive:proof-malformed"].audit[0].reason,
    "DRIVE_METADATA_REVIEW_FAILED"
  );
  assert.equal(
    persisted.imessageBetaLifecycle.entries["imessage:proof-malformed"].audit[0].reason,
    "IMESSAGE_METADATA_REVIEW_FAILED"
  );
  assert.equal(
    persisted.googleDriveLifecycle.entries["drive:proof-missing-account"].audit[0].reason,
    "DRIVE_METADATA_REVIEW_FAILED"
  );
  assert.equal(
    persisted.imessageBetaLifecycle.entries["imessage:proof-missing-account"].audit[0].reason,
    "IMESSAGE_METADATA_REVIEW_FAILED"
  );
  assert.notEqual(driveAttentionAlias, driveRevokedAlias);

  const secondRestartedStore = new FileStateStore(stateStore.filePath);
  let secondRestartLoadCalls = 0;
  let secondRestartSaveCalls = 0;
  const secondCountingStore = {
    async load() {
      secondRestartLoadCalls += 1;
      return secondRestartedStore.load();
    },
    async save(nextState) {
      secondRestartSaveCalls += 1;
      return secondRestartedStore.save(nextState);
    }
  };
  const secondHandoff = await getSourceStatusHandoff({ stateStore: secondCountingStore });
  assert.equal(secondRestartLoadCalls, 1);
  assert.equal(secondRestartSaveCalls, 0);
  assert.deepEqual(
    secondHandoff.sourceStatusHandoff.sources.map((source) => source.source.id),
    publicIds
  );

  console.log(JSON.stringify({
    proof: "QWA-149 simulated source-status export",
    source: imported.sourceStatus.source,
    state: imported.sourceStatus.state,
    connection: imported.sourceStatus.connection,
    metadataPreview: imported.sourceStatus.metadataPreview,
    granularPermission: imported.sourceStatus.granularPermission,
    snapshotImport: imported.sourceStatus.snapshotImport,
    legacyFailureMigration: {
      processRestartedBeforeHandoff: true,
      handoffMigrationLoadCalls,
      handoffMigrationSaveCalls,
      aliasesMigratedWithoutCollision: true,
      rootIMessageAuditNormalized: true,
      malformedAccountEntryFailuresNormalized: true,
      fixedFailureReasons: {
        drive: [
          "DRIVE_METADATA_REVIEW_FAILED",
          "DRIVE_APPROVED_FETCH_FAILED",
          "DRIVE_APPROVED_FETCH_AUTHORIZATION_REVOKED"
        ],
        imessage: ["IMESSAGE_METADATA_REVIEW_FAILED"]
      },
      rawAdapterFailureCodesPersisted: false,
      rawAdapterFailureCodesProjected: false
    },
    aliasIntegrity: {
      completeLifecycleMapsValidated: true,
      malformedCollisionPeersOmitted: true,
      crossDomainIdentifierCollisionsOmitted: true,
      duplicateSourceIdsProjected: false,
      contradictoryStatusesProjected: false,
      guidedReverseMappingRejectedAmbiguity: true,
      validNonCollidingEntriesRetained: true,
      calendarNamespaceCovered: true,
      secondRestartLoadCalls,
      secondRestartSaveCalls
    },
    releaseGate: handoff.sourceStatusHandoff.releaseGate,
    adapterCounters: {
      metadataPreviewCalls: adapter.metadataPreviewCalls,
      snapshotImportCalls: adapter.snapshotImportCalls,
      bodyReads: adapter.bodyReads,
      writeCalls: adapter.writeCalls
    }
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
