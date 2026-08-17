/**
 * Controlled QWA-143 Calendar adapter contract.
 *
 * This adapter is deliberately injected and simulated. It does not call Google,
 * OAuth, a desktop application, or a customer calendar. Source-shaped fixture
 * data stays inside the adapter: public metadata, grants, and fetch results use
 * opaque identifiers and never expose event titles, attendees, descriptions,
 * locations, conferencing links, or raw event bodies.
 */

import { createHash } from "node:crypto";

import { SENSITIVE_CATEGORIES } from "../permissions/setup-source-permissions.mjs";

const SOURCE = "google-calendar";
const SENSITIVE_CATEGORY_SET = new Set(SENSITIVE_CATEGORIES);
const CONNECTION_STATUSES = new Set(["ready", "partial", "empty", "revoked", "unavailable"]);
const ACCESS_RANK = Object.freeze({ allowed: 0, restricted: 1, blocked: 2 });

export class SimulatedGoogleCalendarAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SimulatedGoogleCalendarAdapterError";
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function opaqueId(prefix, value) {
  const digest = createHash("sha256").update(`${prefix}:${value}`).digest("hex").slice(0, 20);
  return `${prefix}-${digest}`;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function moreRestrictive(left, right) {
  return ACCESS_RANK[left] >= ACCESS_RANK[right] ? left : right;
}

function eventTime(value) {
  const candidate = value && typeof value === "object"
    ? value.dateTime ?? value.date ?? value.startTime ?? value.endTime
    : value;
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function attendeeValues(event) {
  // Preserve every source-shaped attendee field. Choosing one field over the
  // other could silently omit a restricted participant before the permission
  // lifecycle has a chance to exclude the event.
  return [
    ...(Array.isArray(event?.attendees) ? event.attendees : []),
    ...(Array.isArray(event?.participantIds) ? event.participantIds : [])
  ];
}

function attendeeId(value) {
  return typeof value === "string" ? text(value) : text(value?.id ?? value?.email ?? value?.address);
}

function normalizedSensitiveCategories(event) {
  const categories = new Set(
    (Array.isArray(event?.sensitiveCategories) ? event.sensitiveCategories : [])
      .filter((category) => SENSITIVE_CATEGORY_SET.has(category))
  );
  if (event?.uncertainSensitivity === true) categories.add("uncertain-sensitivity");
  if (event?.calendarPrivate === true || event?.calendarSensitive === true) categories.add("private-restricted-labels");
  if (event?.titleSensitive === true || event?.sensitiveTitle === true) categories.add("private-restricted-labels");

  // Event titles are metadata, but they can still contain high-risk material.
  // Classify conservatively before a record can reach a detail fetch and never
  // return the source title to the public lifecycle.
  const title = text(event?.title ?? event?.summary) ?? "";
  if (/\b(?:password|passcode|secret|api[ _-]?key|medical|doctor|legal|lawsuit|payroll|salary|hr|bank|social security)\b/i.test(title)) {
    categories.add("private-restricted-labels");
  }
  if (attendeeValues(event).some((attendee) => attendee && typeof attendee === "object" && (attendee.sensitive === true || attendee.private === true))) {
    categories.add("private-restricted-labels");
  }
  return [...categories].sort();
}

function buildPeople(people, events) {
  const byRawId = new Map();

  const register = (candidate) => {
    const rawId = attendeeId(candidate);
    if (!rawId) return;
    const existing = byRawId.get(rawId);
    const explicitAccess = typeof candidate === "object" && ACCESS_RANK[candidate.accessLevel] !== undefined
      ? candidate.accessLevel
      : null;
    // A bare attendee identifier refers to a previously reviewed person when
    // one exists; it must not silently downgrade that saved access decision.
    if (existing && !explicitAccess) return;
    const accessLevel = explicitAccess ?? "restricted";
    byRawId.set(rawId, {
      rawId,
      accessLevel: existing ? moreRestrictive(existing.accessLevel, accessLevel) : accessLevel
    });
  };

  for (const person of Array.isArray(people) ? people : []) register(person);
  for (const event of Array.isArray(events) ? events : []) {
    for (const attendee of attendeeValues(event)) register(attendee);
  }

  const normalizedPeople = [...byRawId.values()]
    .sort((left, right) => left.rawId.localeCompare(right.rawId))
    .map(({ rawId, accessLevel }) => ({
      id: opaqueId("calendar-person", rawId),
      label: accessLevel === "allowed" ? "Approved attendee" : "Private attendee",
      accessLevel
    }));
  const opaqueByRawId = new Map([...byRawId.keys()].map((rawId) => [rawId, opaqueId("calendar-person", rawId)]));
  return { people: normalizedPeople, opaqueByRawId };
}

function normalizeEvents(events, opaquePeopleByRawId) {
  const normalization = {
    recurringInstances: 0,
    cancelledExcluded: 0,
    invalidExcluded: 0,
    duplicateExcluded: 0
  };
  const normalizedEvents = [];
  const seenIds = new Set();

  for (const sourceEvent of Array.isArray(events) ? events : []) {
    if (!sourceEvent || typeof sourceEvent !== "object") {
      normalization.invalidExcluded += 1;
      continue;
    }
    const status = text(sourceEvent.status)?.toLowerCase() ?? "confirmed";
    if (status === "cancelled" || status === "canceled") {
      normalization.cancelledExcluded += 1;
      continue;
    }

    const rawEventId = text(sourceEvent.id);
    const rawCalendarId = text(sourceEvent.calendarId ?? sourceEvent.calendar) ?? "primary";
    const start = eventTime(sourceEvent.start ?? sourceEvent.startTime);
    const end = eventTime(sourceEvent.end ?? sourceEvent.endTime);
    if (!rawEventId || !start || !end || Date.parse(start) > Date.parse(end)) {
      normalization.invalidExcluded += 1;
      continue;
    }

    const rawSeriesId = text(sourceEvent.recurringEventId);
    const originalStart = eventTime(sourceEvent.originalStartTime) ?? start;
    const recurrenceKey = rawSeriesId ? `${rawSeriesId}:${originalStart}` : rawEventId;
    const id = opaqueId("calendar-event", `${rawCalendarId}:${recurrenceKey}`);
    if (seenIds.has(id)) {
      normalization.duplicateExcluded += 1;
      continue;
    }
    seenIds.add(id);
    if (rawSeriesId) normalization.recurringInstances += 1;

    const participantIds = attendeeValues(sourceEvent)
      .map(attendeeId)
      .filter(Boolean)
      .map((rawId) => opaquePeopleByRawId.get(rawId) ?? opaqueId("calendar-unreviewed-person", rawId))
      .sort();
    const sensitiveCategories = normalizedSensitiveCategories(sourceEvent);
    normalizedEvents.push({
      id,
      kind: "item",
      area: opaqueId("calendar", rawCalendarId),
      category: "calendar-event",
      timestamp: start,
      participantIds,
      sensitiveCategories,
      // Never reflect a raw title in metadata. The generic QWA-139 layer may
      // further redact this fixed label, but it cannot reveal source text.
      label: sensitiveCategories.length > 0 ? "Sensitive calendar event" : "Calendar event",
      recurring: rawSeriesId !== null,
      originalStart
    });
  }

  normalizedEvents.sort((left, right) => `${left.timestamp}:${left.id}`.localeCompare(`${right.timestamp}:${right.id}`));
  return { normalizedEvents, normalization };
}

function listIncludes(value, selected) {
  return value == null || selected.includes(value);
}

function isInsideScope(record, scope) {
  if (!scope || !scope.dateRange) return false;
  const timestamp = Date.parse(record.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (timestamp < Date.parse(scope.dateRange.from) || timestamp > Date.parse(scope.dateRange.to)) return false;
  if ((scope.exclusions?.dateRanges ?? []).some((range) => timestamp >= Date.parse(range.from) && timestamp <= Date.parse(range.to))) return false;
  if (!listIncludes(record.area, scope.areas ?? [])) return false;
  if (!listIncludes(record.category, scope.categories ?? [])) return false;
  if ((record.participantIds ?? []).some((personId) => (scope.exclusions?.people ?? []).includes(personId))) return false;
  const excludedSensitive = new Set([
    ...(scope.sensitiveGroups?.excluded ?? []),
    ...(scope.exclusions?.categories ?? [])
  ]);
  return !record.sensitiveCategories.some((category) => excludedSensitive.has(category));
}

/**
 * A safe, injected Calendar fixture. It exposes only the QWA-139 connector
 * contract plus a metadata-only availability summary. It has no mutation API.
 */
export class SimulatedGoogleCalendarAdapter {
  constructor({
    account = { id: "simulated-calendar-account", label: "Simulated Calendar" },
    people = [],
    events = [],
    connectionStatus,
    unavailableCalendars = [],
    metadataFailuresBeforeSuccess = 0,
    detailFailuresBeforeSuccess = 0,
    failuresBeforeGrantRegistration = 0
  } = {}) {
    const rawAccountId = text(account?.id) ?? "simulated-calendar-account";
    this.account = {
      id: opaqueId("calendar-account", rawAccountId),
      label: "Calendar account"
    };
    const personIndex = buildPeople(people, events);
    const normalized = normalizeEvents(events, personIndex.opaqueByRawId);
    this.people = personIndex.people;
    this.events = normalized.normalizedEvents;
    this.normalization = normalized.normalization;
    this.unavailableCalendarCount = Array.isArray(unavailableCalendars) ? unavailableCalendars.length : 0;
    const inferredStatus = this.unavailableCalendarCount > 0 ? "partial" : (this.events.length === 0 ? "empty" : "ready");
    this.connectionStatus = CONNECTION_STATUSES.has(connectionStatus) ? connectionStatus : inferredStatus;
    this.metadataFailuresBeforeSuccess = metadataFailuresBeforeSuccess;
    this.detailFailuresBeforeSuccess = detailFailuresBeforeSuccess;
    this.failuresBeforeGrantRegistration = failuresBeforeGrantRegistration;
    this.metadataPreflightCalls = 0;
    this.bodyFetchCalls = 0;
    this.bodyAccesses = 0;
    this.eventDetailFetches = 0;
    this.grantRegistrationCalls = 0;
    this.grantRevocationCalls = 0;
    this.writeCalls = 0;
    this.authorizedGrantIds = new Set();
    this.grantsSeen = [];
  }

  setConnectionStatus(status) {
    if (!CONNECTION_STATUSES.has(status)) throw new TypeError("A known simulated Calendar connection status is required.");
    this.connectionStatus = status;
  }

  async getReadOnlyStatus() {
    return {
      status: this.connectionStatus,
      readOnly: true,
      accountId: this.account.id,
      availableCalendarCount: new Set(this.events.map((event) => event.area)).size,
      unavailableCalendarCount: this.unavailableCalendarCount,
      normalization: clone(this.normalization)
    };
  }

  async discoverMetadata({ source }) {
    this.metadataPreflightCalls += 1;
    if (source !== SOURCE) throw new SimulatedGoogleCalendarAdapterError("CALENDAR_SOURCE_MISMATCH", "Simulated Calendar source mismatch.");
    if (this.connectionStatus === "revoked") throw new SimulatedGoogleCalendarAdapterError("CALENDAR_ACCESS_REVOKED", "Simulated Calendar access is revoked.");
    if (this.connectionStatus === "unavailable") throw new SimulatedGoogleCalendarAdapterError("CALENDAR_METADATA_UNAVAILABLE", "Simulated Calendar metadata is unavailable.");
    if (this.metadataFailuresBeforeSuccess > 0) {
      this.metadataFailuresBeforeSuccess -= 1;
      throw new SimulatedGoogleCalendarAdapterError("CALENDAR_METADATA_UNAVAILABLE", "Simulated Calendar metadata review interrupted.");
    }
    return {
      source: SOURCE,
      account: clone(this.account),
      readOnly: true,
      people: clone(this.people),
      items: this.events.map((event) => ({
        id: event.id,
        kind: event.kind,
        area: event.area,
        category: event.category,
        timestamp: event.timestamp,
        participantIds: event.participantIds,
        sensitiveCategories: event.sensitiveCategories,
        label: event.label
      }))
    };
  }

  async registerPermissionGrant({ grant }) {
    this.grantRegistrationCalls += 1;
    if (this.connectionStatus === "revoked") throw new SimulatedGoogleCalendarAdapterError("CALENDAR_ACCESS_REVOKED", "Simulated Calendar access is revoked.");
    if (this.failuresBeforeGrantRegistration > 0) {
      this.failuresBeforeGrantRegistration -= 1;
      throw new SimulatedGoogleCalendarAdapterError("CALENDAR_GRANT_UNAVAILABLE", "Simulated Calendar grant registration failed.");
    }
    if (grant?.source !== SOURCE || grant?.accountId !== this.account.id || grant?.status !== "active" || !grant?.id) {
      throw new SimulatedGoogleCalendarAdapterError("CALENDAR_GRANT_INVALID", "Simulated Calendar refused an invalid read-only grant.");
    }
    this.authorizedGrantIds.add(grant.id);
  }

  async revokePermissionGrant({ grantId }) {
    this.grantRevocationCalls += 1;
    this.authorizedGrantIds.delete(grantId);
  }

  async fetchApprovedContent({ source, accountId, grant }) {
    this.bodyFetchCalls += 1;
    if (source !== SOURCE || accountId !== this.account.id || grant?.status !== "active" || grant?.scope?.accountId !== this.account.id || !this.authorizedGrantIds.has(grant?.id)) {
      throw new SimulatedGoogleCalendarAdapterError("CALENDAR_GRANT_REQUIRED", "Simulated Calendar refused a detail fetch without a matching active grant.");
    }
    if (this.connectionStatus === "revoked") throw new SimulatedGoogleCalendarAdapterError("CALENDAR_ACCESS_REVOKED", "Simulated Calendar access is revoked.");
    if (this.detailFailuresBeforeSuccess > 0) {
      this.detailFailuresBeforeSuccess -= 1;
      throw new SimulatedGoogleCalendarAdapterError("CALENDAR_DETAIL_FETCH_UNAVAILABLE", "Simulated Calendar detail fetch interrupted.");
    }
    const records = this.events
      .filter((event) => isInsideScope(event, grant.scope))
      .map((event) => ({ sourceRecordId: event.id, source: SOURCE }));
    this.grantsSeen.push(clone(grant));
    this.eventDetailFetches += records.length;
    if (records.length > 0) this.bodyAccesses += 1;
    return { rawBodiesReturned: false, records };
  }
}
