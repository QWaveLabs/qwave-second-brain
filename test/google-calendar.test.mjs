import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileStateStore,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedGoogleCalendarAdapter,
  SimulatedObsidianAdapter,
  SimulatedReadOnlyConnector,
  beginGoogleCalendarReview,
  beginSourcePermissionReview,
  fetchApprovedGoogleCalendarContent,
  getGoogleCalendarStatus,
  getSourcePermissionStatus,
  grantGoogleCalendarContent,
  grantSourcePermission,
  revokeSourcePermission,
  startSetupSession
} from "../src/index.mjs";

const clock = { now: () => new Date("2026-08-17T12:00:00.000Z") };

function event(overrides = {}) {
  return {
    id: "weekly-planning",
    calendarId: "work-calendar",
    start: "2026-08-10T14:00:00.000Z",
    end: "2026-08-10T15:00:00.000Z",
    title: "Weekly planning",
    attendees: ["approved-person"],
    ...overrides
  };
}

function calendarFixture(overrides = {}) {
  return {
    account: { id: "calendar-account@example.test", label: "Private account label" },
    people: [
      { id: "approved-person", label: "Approved Person", accessLevel: "allowed" },
      { id: "restricted-person", label: "Restricted Person", accessLevel: "restricted" },
      { id: "blocked-person", label: "Blocked Person", accessLevel: "blocked" }
    ],
    events: [event()],
    ...overrides
  };
}

async function withCalendarFixture(run, { language = "en", connectorOptions = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa143-"));
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  const adapters = {
    environment: new SimulatedEnvironmentAdapter(),
    obsidian: new SimulatedObsidianAdapter(),
    vault: new SimulatedDesktopVaultAdapter()
  };
  const connector = new SimulatedGoogleCalendarAdapter(calendarFixture(connectorOptions));
  try {
    await startSetupSession({
      message: language === "es" ? "Configura mi segundo cerebro" : "Set up my second brain",
      answers: { displayName: "Alex", focus: "prepare for the week" },
      decisions: { vaultName: "My Second Brain" },
      stateStore,
      adapters
    });
    await run({ directory, stateStore, connector });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function approvedScope(review) {
  const scope = structuredClone(review.googleCalendar.permissionReview.permissionRequest.requestedScope);
  scope.acknowledgements.modelProcessing = true;
  scope.acknowledgements.untrustedSourceMaterial = true;
  return scope;
}

test("Calendar is a separate read-only natural-language lifecycle with the specified default window", async () => {
  await withCalendarFixture(async ({ stateStore, connector }) => {
    const review = await beginGoogleCalendarReview({
      message: "Please connect Calendar to my second brain",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "calendar-review"
    });
    const calendar = review.googleCalendar;
    const accountId = calendar.permissionReview.account.id;
    const requestedScope = calendar.permissionReview.permissionRequest.requestedScope;

    assert.equal(calendar.source, "google-calendar");
    assert.equal(calendar.connection.separateAuthorization, true);
    assert.equal(calendar.connection.readOnly, true);
    assert.equal(calendar.connection.canCreateEvents, false);
    assert.equal(calendar.connection.canEditEvents, false);
    assert.equal(calendar.connection.canAcceptEvents, false);
    assert.equal(calendar.connection.canDeclineEvents, false);
    assert.equal(calendar.connection.canDeleteEvents, false);
    assert.equal(calendar.connection.liveVerified, false);
    assert.equal(requestedScope.dateRange.pastMonths, 6);
    assert.equal(requestedScope.dateRange.futureDays, 90);
    assert.equal(requestedScope.dateRange.from, "2026-02-17T12:00:00.000Z");
    assert.equal(requestedScope.dateRange.to, "2026-11-15T12:00:00.000Z");
    assert.equal(connector.metadataPreflightCalls, 1);
    assert.equal(connector.bodyFetchCalls, 0);
    assert.equal(connector.eventDetailFetches, 0);
    assert.equal(connector.writeCalls, 0);

    // A Calendar grant lives under google-calendar, not the Gmail key.
    const gmailConnector = new SimulatedReadOnlyConnector({
      source: "gmail",
      account: { id: "separate-gmail", label: "Separate Gmail" },
      items: [{ id: "gmail-item", area: "inbox", category: "work", label: "Gmail item" }]
    });
    await beginSourcePermissionReview({
      message: "Please connect Gmail to my second brain",
      stateStore,
      connector: gmailConnector,
      source: "gmail",
      reviewIdFactory: () => "gmail-review"
    });
    const preserved = await getGoogleCalendarStatus({ stateStore, accountId });
    assert.equal(preserved.googleCalendar.permissionReview.permissionRequest.reviewId, "calendar-review");
    assert.equal(preserved.googleCalendar.permissionReview.permissionRequest.source, "google-calendar");

    await assert.rejects(
      () => fetchApprovedGoogleCalendarContent({
        message: "Import my Calendar now",
        stateStore,
        connector,
        accountId,
        reviewId: "calendar-review"
      }),
      /saved granular review is not ready/i
    );
    assert.equal(connector.eventDetailFetches, 0);

    const granted = await grantGoogleCalendarContent({
      message: "I approve the reviewed Calendar scope",
      stateStore,
      connector,
      accountId,
      reviewId: "calendar-review",
      scope: approvedScope(review),
      clock,
      grantIdFactory: () => "calendar-grant"
    });
    assert.equal(granted.googleCalendar.status, "ready-to-import");
    assert.equal(granted.googleCalendar.permissionReview.activeGrant.grantId, "calendar-grant");

    const fetched = await fetchApprovedGoogleCalendarContent({
      message: "Import the approved Calendar events",
      stateStore,
      connector,
      accountId,
      reviewId: "calendar-review",
      clock
    });
    assert.equal(fetched.googleCalendar.status, "imported");
    assert.equal(fetched.approvedRecords.length, 1);
    assert.match(fetched.approvedRecords[0].sourceRecordId, /^calendar-event-/);
    assert.equal("body" in fetched.approvedRecords[0], false);
    assert.equal(connector.eventDetailFetches, 1);
    assert.equal(connector.writeCalls, 0);
  });
});

test("a Calendar full-root save cannot resurrect another source grant revoked through the same Setup Session", async () => {
  await withCalendarFixture(async ({ directory, stateStore, connector }) => {
    const gmail = new SimulatedReadOnlyConnector({
      source: "gmail",
      account: { id: "calendar-race-gmail", label: "Work email" },
      people: [{ id: "calendar-race-person", label: "Reviewed person", accessLevel: "allowed" }],
      items: [{
        id: "calendar-race-message",
        kind: "conversation",
        area: "inbox",
        conversation: "calendar-race-message",
        category: "work",
        participantIds: ["calendar-race-person"],
        label: "Safe simulated metadata"
      }]
    });
    const gmailReview = await beginSourcePermissionReview({
      message: "Review Gmail before Calendar",
      stateStore,
      connector: gmail,
      source: "gmail",
      reviewIdFactory: () => "calendar-race-gmail-review"
    });
    const gmailScope = structuredClone(gmailReview.permissionReview.permissionRequest.requestedScope);
    gmailScope.acknowledgements.modelProcessing = true;
    gmailScope.acknowledgements.untrustedSourceMaterial = true;
    await grantSourcePermission({
      message: "Approve the reviewed Gmail scope",
      stateStore,
      connector: gmail,
      source: "gmail",
      accountId: "calendar-race-gmail",
      reviewId: "calendar-race-gmail-review",
      scope: gmailScope,
      grantIdFactory: () => "calendar-race-gmail-grant"
    });

    connector.setConnectionStatus("unavailable");
    let signalStatusRead;
    const statusRead = new Promise((resolve) => { signalStatusRead = resolve; });
    let releaseStatusRead;
    const statusReadReleased = new Promise((resolve) => { releaseStatusRead = resolve; });
    const originalStatus = connector.getReadOnlyStatus.bind(connector);
    connector.getReadOnlyStatus = async () => {
      signalStatusRead();
      await statusReadReleased;
      return originalStatus();
    };

    const calendarAttempt = beginGoogleCalendarReview({
      message: "Review Calendar while another source is being revoked",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "calendar-race-review"
    });
    await statusRead;
    const resumedStateStore = new FileStateStore(path.join(directory, "private-state", "..", "private-state", "setup-session.json"));
    const gmailRevocation = revokeSourcePermission({
      message: "Revoke Gmail during the Calendar availability check",
      stateStore: resumedStateStore,
      connector: gmail,
      source: "gmail",
      accountId: "calendar-race-gmail",
      reviewId: "calendar-race-gmail-review",
      clock
    });
    releaseStatusRead();
    const [calendarResult, revoked] = await Promise.all([calendarAttempt, gmailRevocation]);
    assert.equal(calendarResult.metadataReviewUnavailable, true);
    assert.equal(revoked.permissionReview.status, "revoked");
    const saved = await getSourcePermissionStatus({
      stateStore: resumedStateStore,
      source: "gmail",
      accountId: "calendar-race-gmail"
    });
    assert.equal(saved.permissionReview.status, "revoked");
    assert.equal(saved.permissionReview.activeGrant, null);
  });
});

test("a same-context callback cannot re-enter a Calendar writer and overwrite its stale full-root snapshot", async () => {
  await withCalendarFixture(async ({ stateStore, connector }) => {
    const gmail = new SimulatedReadOnlyConnector({
      source: "gmail",
      account: { id: "calendar-reentrant-gmail", label: "Work email" },
      people: [{ id: "calendar-reentrant-person", label: "Reviewed person", accessLevel: "allowed" }],
      items: [{
        id: "calendar-reentrant-message",
        kind: "conversation",
        area: "inbox",
        conversation: "calendar-reentrant-message",
        category: "work",
        participantIds: ["calendar-reentrant-person"],
        label: "Safe simulated metadata"
      }]
    });
    const reviewId = "calendar-reentrant-gmail-review";
    const gmailReview = await beginSourcePermissionReview({
      message: "Review Gmail before the hooked Calendar callback",
      stateStore,
      connector: gmail,
      source: "gmail",
      reviewIdFactory: () => reviewId
    });
    const gmailScope = structuredClone(gmailReview.permissionReview.permissionRequest.requestedScope);
    gmailScope.acknowledgements.modelProcessing = true;
    gmailScope.acknowledgements.untrustedSourceMaterial = true;
    await grantSourcePermission({
      message: "Approve the reviewed Gmail scope",
      stateStore,
      connector: gmail,
      source: "gmail",
      accountId: "calendar-reentrant-gmail",
      reviewId,
      scope: gmailScope,
      grantIdFactory: () => "calendar-reentrant-gmail-grant"
    });

    connector.setConnectionStatus("unavailable");
    const filePath = stateStore.filePath;
    let triggerNestedRevoke = true;
    let nestedError = null;
    const hookedStateStore = {
      filePath,
      async load() {
        const snapshot = await stateStore.load();
        if (triggerNestedRevoke) {
          triggerNestedRevoke = false;
          try {
            await revokeSourcePermission({
              message: "Attempt a nested Gmail revoke from Calendar state loading",
              stateStore: new FileStateStore(filePath),
              connector: gmail,
              source: "gmail",
              accountId: "calendar-reentrant-gmail",
              reviewId,
              clock
            });
          } catch (error) {
            nestedError = error;
          }
        }
        return snapshot;
      },
      async save(state) {
        return stateStore.save(state);
      }
    };

    const calendarResult = await beginGoogleCalendarReview({
      message: "Review Calendar through the hooked state store",
      stateStore: hookedStateStore,
      connector,
      clock,
      reviewIdFactory: () => "calendar-reentrant-review"
    });
    assert.equal(calendarResult.metadataReviewUnavailable, true);
    assert.equal(nestedError?.code, "STATE_LOCK_REENTRANT_OPERATION_BLOCKED");
    assert.equal(gmail.grantRevocationCalls, 0);
    const unchanged = await getSourcePermissionStatus({
      stateStore,
      source: "gmail",
      accountId: "calendar-reentrant-gmail"
    });
    assert.equal(unchanged.permissionReview.status, "granted");
    assert.notEqual(unchanged.permissionReview.activeGrant, null);

    const revoked = await revokeSourcePermission({
      message: "Revoke Gmail after the Calendar step has finished",
      stateStore,
      connector: gmail,
      source: "gmail",
      accountId: "calendar-reentrant-gmail",
      reviewId,
      clock
    });
    assert.equal(revoked.permissionReview.status, "revoked");
    assert.equal(gmail.grantRevocationCalls, 1);
  });
});

test("calendar, attendee, and title sensitivity apply before detail fetch in English and Spanish", async () => {
  await withCalendarFixture(async ({ stateStore, connector }) => {
    const rawSensitiveTitle = "Payroll salary review";
    const rawRestrictedAttendee = "private.person@example.test";
    const review = await beginGoogleCalendarReview({
      message: "Quiero revisar Calendar para mi segundo cerebro",
      stateStore,
      connector,
      language: "es",
      clock,
      reviewIdFactory: () => "spanish-calendar-review"
    });
    const calendar = review.googleCalendar;
    const accountId = calendar.permissionReview.account.id;
    const serializedReview = JSON.stringify(review);

    assert.match(calendar.message, /Revisé únicamente metadatos/i);
    assert.match(calendar.connection.boundary, /solo de lectura/i);
    assert.match(calendar.privacy.message, /antes de leer detalles/i);
    assert.equal(calendar.privacy.appliedBeforeEventDetailFetch, true);
    assert.equal(connector.eventDetailFetches, 0);
    assert.equal(connector.bodyFetchCalls, 0);
    assert.doesNotMatch(serializedReview, new RegExp(rawSensitiveTitle, "i"));
    assert.doesNotMatch(serializedReview, new RegExp(rawRestrictedAttendee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.deepEqual(
      calendar.permissionReview.metadataPreflight.sensitiveGroups.map((group) => group.category),
      ["private-restricted-labels"]
    );

    const granted = await grantGoogleCalendarContent({
      message: "Apruebo solo el alcance de Calendar revisado",
      stateStore,
      connector,
      accountId,
      reviewId: "spanish-calendar-review",
      scope: approvedScope(review),
      language: "es",
      clock,
      grantIdFactory: () => "spanish-calendar-grant"
    });
    assert.equal(granted.googleCalendar.status, "ready-to-import");

    const fetched = await fetchApprovedGoogleCalendarContent({
      message: "Importa los eventos aprobados de Calendar",
      stateStore,
      connector,
      accountId,
      reviewId: "spanish-calendar-review",
      language: "es",
      clock
    });
    assert.match(fetched.googleCalendar.message, /Procesé únicamente referencias opacas/i);
    assert.equal(fetched.approvedRecords.length, 1, "only the ordinary event is eligible by default");
    assert.equal(connector.eventDetailFetches, 1);
    assert.equal(connector.writeCalls, 0);
  }, {
    language: "es",
    connectorOptions: {
      people: [
        { id: "approved-person", accessLevel: "allowed" },
        { id: "restricted-person", accessLevel: "restricted" }
      ],
      events: [
        event(),
        event({ id: "private-calendar", calendarId: "personal", calendarPrivate: true, title: "Family schedule" }),
        event({ id: "sensitive-title", title: "Payroll salary review" }),
        event({ id: "restricted-attendee", attendees: [{ id: "private.person@example.test", accessLevel: "restricted" }] })
      ]
    }
  });
});

test("recurring instances are stable while cancelled events are excluded before a detail fetch", async () => {
  await withCalendarFixture(async ({ stateStore, connector }) => {
    const review = await beginGoogleCalendarReview({
      message: "Review my Calendar for my second brain",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "recurring-review"
    });
    const accountId = review.googleCalendar.permissionReview.account.id;
    assert.deepEqual(review.googleCalendar.availability.normalization, {
      recurringInstances: 2,
      cancelledExcluded: 1,
      invalidExcluded: 0,
      duplicateExcluded: 0
    });
    assert.equal(review.googleCalendar.permissionReview.metadataPreflight.itemCount, 2);

    await grantGoogleCalendarContent({
      message: "Approve the recurring Calendar scope",
      stateStore,
      connector,
      accountId,
      reviewId: "recurring-review",
      scope: approvedScope(review),
      clock
    });
    const fetched = await fetchApprovedGoogleCalendarContent({
      message: "Import the approved recurring Calendar events",
      stateStore,
      connector,
      accountId,
      reviewId: "recurring-review",
      clock
    });
    assert.equal(fetched.approvedRecords.length, 2);
    assert.equal(new Set(fetched.approvedRecords.map((record) => record.sourceRecordId)).size, 2);
    assert.ok(fetched.approvedRecords.every((record) => /^calendar-event-/.test(record.sourceRecordId)));
    assert.equal(connector.eventDetailFetches, 2);
    assert.equal(connector.writeCalls, 0);
  }, {
    connectorOptions: {
      events: [
        event({ id: "instance-one", recurringEventId: "weekly-series", originalStartTime: "2026-08-10T14:00:00.000Z" }),
        event({ id: "instance-two", recurringEventId: "weekly-series", start: "2026-08-17T14:00:00.000Z", end: "2026-08-17T15:00:00.000Z", originalStartTime: "2026-08-17T14:00:00.000Z" }),
        event({ id: "cancelled-instance", recurringEventId: "weekly-series", status: "cancelled" })
      ]
    }
  });
});

test("empty, partial, and revoked Calendar states stay customer-visible and non-mutating", async () => {
  await withCalendarFixture(async ({ stateStore, connector }) => {
    const review = await beginGoogleCalendarReview({
      message: "Review my Calendar for my second brain",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "empty-review"
    });
    const accountId = review.googleCalendar.permissionReview.account.id;
    await grantGoogleCalendarContent({
      message: "Approve the empty Calendar scope",
      stateStore,
      connector,
      accountId,
      reviewId: "empty-review",
      scope: approvedScope(review),
      clock
    });
    const empty = await fetchApprovedGoogleCalendarContent({
      message: "Import the approved Calendar scope",
      stateStore,
      connector,
      accountId,
      reviewId: "empty-review",
      clock
    });
    assert.equal(empty.googleCalendar.status, "empty");
    assert.match(empty.googleCalendar.message, /There are no approved events/i);
    assert.deepEqual(empty.approvedRecords, []);
    assert.equal(connector.eventDetailFetches, 0);
    assert.equal(connector.writeCalls, 0);
  }, { connectorOptions: { events: [] } });

  await withCalendarFixture(async ({ stateStore, connector }) => {
    const review = await beginGoogleCalendarReview({
      message: "Review my Calendar for my second brain",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "partial-review"
    });
    const accountId = review.googleCalendar.permissionReview.account.id;
    assert.equal(review.googleCalendar.availability.status, "partial");
    assert.match(review.googleCalendar.message, /only part of the available calendars/i);
    await grantGoogleCalendarContent({
      message: "Approve the partially available Calendar scope",
      stateStore,
      connector,
      accountId,
      reviewId: "partial-review",
      scope: approvedScope(review),
      clock
    });
    const partial = await fetchApprovedGoogleCalendarContent({
      message: "Import the available Calendar events",
      stateStore,
      connector,
      accountId,
      reviewId: "partial-review",
      clock
    });
    assert.equal(partial.googleCalendar.status, "imported-partially");
    assert.match(partial.googleCalendar.message, /Some calendars were unavailable/i);
    assert.equal(partial.approvedRecords.length, 1);
    assert.equal(connector.writeCalls, 0);
  }, { connectorOptions: { unavailableCalendars: ["other-calendar"] } });

  await withCalendarFixture(async ({ stateStore, connector }) => {
    const review = await beginGoogleCalendarReview({
      message: "Review my Calendar for my second brain",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "empty-partial-review"
    });
    const accountId = review.googleCalendar.permissionReview.account.id;
    await grantGoogleCalendarContent({
      message: "Approve the available Calendar scope",
      stateStore,
      connector,
      accountId,
      reviewId: "empty-partial-review",
      scope: approvedScope(review),
      clock
    });
    const emptyPartial = await fetchApprovedGoogleCalendarContent({
      message: "Import the available Calendar events",
      stateStore,
      connector,
      accountId,
      reviewId: "empty-partial-review",
      clock
    });
    assert.equal(emptyPartial.googleCalendar.status, "empty-partial");
    assert.match(emptyPartial.googleCalendar.message, /Some calendars were unavailable/i);
    assert.deepEqual(emptyPartial.approvedRecords, []);
    assert.equal(connector.writeCalls, 0);
  }, { connectorOptions: { events: [], unavailableCalendars: ["other-calendar"] } });

  await withCalendarFixture(async ({ stateStore, connector }) => {
    const revoked = await beginGoogleCalendarReview({
      message: "Review my Calendar for my second brain",
      stateStore,
      connector,
      clock
    });
    assert.equal(revoked.googleCalendar.status, "access-revoked");
    assert.match(revoked.googleCalendar.message, /access is no longer available/i);
    assert.equal(connector.metadataPreflightCalls, 0);
    assert.equal(connector.eventDetailFetches, 0);
    assert.equal(connector.writeCalls, 0);
  }, { connectorOptions: { connectionStatus: "revoked" } });
});

test("metadata and approved-detail interruptions fail closed and resume without broadening scope", async () => {
  await withCalendarFixture(async ({ directory, stateStore, connector }) => {
    const first = await beginGoogleCalendarReview({
      message: "Review my Calendar for my second brain",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "recovered-calendar-review"
    });
    assert.equal(first.metadataReviewUnavailable, true);
    assert.equal(first.googleCalendar.status, "metadata-retry-required");
    assert.equal(connector.metadataPreflightCalls, 1);
    assert.equal(connector.eventDetailFetches, 0);

    const resumedStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
    const resumed = await beginGoogleCalendarReview({
      message: "Please retry my saved Calendar review",
      stateStore: resumedStore,
      connector,
      clock,
      reviewIdFactory: () => "recovered-calendar-review"
    });
    const accountId = resumed.googleCalendar.permissionReview.account.id;
    assert.equal(resumed.googleCalendar.status, "awaiting-grant");
    assert.equal(resumed.googleCalendar.permissionReview.permissionRequest.reviewId, "recovered-calendar-review");
    assert.equal(connector.metadataPreflightCalls, 2);

    await grantGoogleCalendarContent({
      message: "Approve the recovered Calendar scope",
      stateStore: resumedStore,
      connector,
      accountId,
      reviewId: "recovered-calendar-review",
      scope: approvedScope(resumed),
      clock,
      grantIdFactory: () => "recovered-calendar-grant"
    });
    const interrupted = await fetchApprovedGoogleCalendarContent({
      message: "Import the approved Calendar events",
      stateStore: resumedStore,
      connector,
      accountId,
      reviewId: "recovered-calendar-review",
      clock
    });
    assert.equal(interrupted.contentFetchUnavailable, true);
    assert.equal(interrupted.googleCalendar.status, "fetch-retry-required");
    assert.deepEqual(interrupted.approvedRecords, []);
    assert.equal(connector.eventDetailFetches, 0);

    const finished = await fetchApprovedGoogleCalendarContent({
      message: "Retry the saved approved Calendar scope",
      stateStore: new FileStateStore(resumedStore.filePath),
      connector,
      accountId,
      reviewId: "recovered-calendar-review",
      clock
    });
    assert.equal(finished.googleCalendar.status, "imported");
    assert.equal(finished.approvedRecords.length, 1);
    assert.equal(connector.eventDetailFetches, 1);
    assert.equal(connector.writeCalls, 0);
  }, { connectorOptions: { metadataFailuresBeforeSuccess: 1, detailFailuresBeforeSuccess: 1 } });
});

test("external Calendar revocation invalidates an active grant instead of reviving it on reconnect", async () => {
  await withCalendarFixture(async ({ stateStore, connector }) => {
    const review = await beginGoogleCalendarReview({
      message: "Review my Calendar for my second brain",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "revocation-review"
    });
    const accountId = review.googleCalendar.permissionReview.account.id;
    await grantGoogleCalendarContent({
      message: "Approve the reviewed Calendar scope",
      stateStore,
      connector,
      accountId,
      reviewId: "revocation-review",
      scope: approvedScope(review),
      clock,
      grantIdFactory: () => "revocation-grant"
    });

    connector.setConnectionStatus("revoked");
    const lost = await fetchApprovedGoogleCalendarContent({
      message: "Import the approved Calendar events",
      stateStore,
      connector,
      accountId,
      reviewId: "revocation-review",
      clock
    });
    assert.equal(lost.googleCalendar.status, "access-revoked");
    assert.equal(lost.googleCalendar.permissionReview.status, "revoked");
    assert.equal(lost.googleCalendar.permissionReview.activeGrant, null);
    assert.equal(connector.eventDetailFetches, 0);

    connector.setConnectionStatus("ready");
    const fresh = await beginGoogleCalendarReview({
      message: "Start a new Calendar review for my second brain",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "fresh-after-revocation"
    });
    assert.equal(fresh.googleCalendar.status, "awaiting-grant");
    assert.equal(fresh.googleCalendar.permissionReview.permissionRequest.reviewId, "fresh-after-revocation");
    assert.equal(connector.writeCalls, 0);
  });
});

test("a Calendar adapter cannot surface an unreviewed or final-scope-excluded event reference", async () => {
  await withCalendarFixture(async ({ stateStore, connector }) => {
    const review = await beginGoogleCalendarReview({
      message: "Review my Calendar for my second brain",
      stateStore,
      connector,
      clock,
      reviewIdFactory: () => "bounded-record-review"
    });
    const accountId = review.googleCalendar.permissionReview.account.id;
    const excludedRecord = connector.events.find((candidate) => candidate.area !== connector.events[0].area);
    assert.ok(excludedRecord, "fixture must contain a second reviewed calendar area");

    const scope = approvedScope(review);
    scope.exclusions.areas = [excludedRecord.area];
    await grantGoogleCalendarContent({
      message: "Approve only the selected Calendar area",
      stateStore,
      connector,
      accountId,
      reviewId: "bounded-record-review",
      scope,
      clock,
      grantIdFactory: () => "bounded-record-grant"
    });

    const originalFetch = connector.fetchApprovedContent.bind(connector);
    connector.fetchApprovedContent = async (input) => ({
      rawBodiesReturned: false,
      records: [{ sourceRecordId: excludedRecord.id, source: "google-calendar" }]
    });
    await assert.rejects(
      () => fetchApprovedGoogleCalendarContent({
        message: "Import the approved Calendar events",
        stateStore,
        connector,
        accountId,
        reviewId: "bounded-record-review",
        clock
      }),
      (error) => error?.code === "CALENDAR_SCOPE_BYPASS"
    );

    connector.fetchApprovedContent = async (input) => ({
      rawBodiesReturned: false,
      records: [{ sourceRecordId: "calendar-event-00000000000000000000", source: "google-calendar" }]
    });
    await assert.rejects(
      () => fetchApprovedGoogleCalendarContent({
        message: "Retry the saved approved Calendar scope",
        stateStore,
        connector,
        accountId,
        reviewId: "bounded-record-review",
        clock
      }),
      (error) => error?.code === "CALENDAR_UNREVIEWED_RECORD"
    );

    connector.fetchApprovedContent = originalFetch;
    const recovered = await fetchApprovedGoogleCalendarContent({
      message: "Import only the final approved Calendar area",
      stateStore,
      connector,
      accountId,
      reviewId: "bounded-record-review",
      clock
    });
    assert.equal(recovered.approvedRecords.length, 1);
    assert.equal(recovered.approvedRecords[0].sourceRecordId, connector.events.find((candidate) => candidate.id !== excludedRecord.id).id);
  }, {
    connectorOptions: {
      events: [
        event({ id: "approved-work-event", calendarId: "work-calendar" }),
        event({ id: "excluded-private-event", calendarId: "private-calendar" })
      ]
    }
  });
});
