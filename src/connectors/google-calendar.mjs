/**
 * QWA-143 Google Calendar lifecycle.
 *
 * This is a public, natural-language wrapper around QWA-139's durable
 * metadata/grant boundary. It is intentionally separate from Gmail and Drive
 * and accepts only an injected read-only Calendar adapter. No OAuth or Google
 * Calendar client is included here.
 */

import {
  DEFAULT_PERMISSION_WINDOWS,
  SENSITIVE_CATEGORIES,
  beginSourcePermissionReview,
  fetchApprovedSourceContent,
  getSourcePermissionStatus,
  grantSourcePermission,
  revokeSourcePermission
} from "../permissions/setup-source-permissions.mjs";

const SOURCE = "google-calendar";
const STATE_KEY = "googleCalendarLifecycle";
const CONNECTION_STATUSES = new Set(["ready", "partial", "empty", "revoked", "unavailable"]);
const RETRYABLE_ENTRY_STATUSES = new Set(["awaiting-grant", "grant-retry-required", "ready-to-import", "fetch-retry-required", "imported", "imported-partially", "empty", "empty-partial"]);
const SENSITIVE_CATEGORY_SET = new Set(SENSITIVE_CATEGORIES);
const CALENDAR_ACCOUNT_ID = /^calendar-account-[a-f0-9]{20}$/;
const CALENDAR_EVENT_ID = /^calendar-event-[a-f0-9]{20}$/;
const CALENDAR_AREA_ID = /^calendar-[a-f0-9]{20}$/;
const CALENDAR_PERSON_ID = /^calendar-person-[a-f0-9]{20}$/;
const ACCESS_LEVELS = new Set(["allowed", "restricted", "blocked"]);

export class GoogleCalendarLifecycleError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "GoogleCalendarLifecycleError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(nonEmptyString)
    .filter(Boolean))].sort();
}

function safeIsoTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isCalendarAccountId(value) {
  return CALENDAR_ACCOUNT_ID.test(value ?? "");
}

function isCalendarEventId(value) {
  return CALENDAR_EVENT_ID.test(value ?? "");
}

function isCalendarAreaId(value) {
  return CALENDAR_AREA_ID.test(value ?? "");
}

function isCalendarPersonId(value) {
  return CALENDAR_PERSON_ID.test(value ?? "");
}

function calendarSensitiveCategories(item) {
  const supplied = uniqueStrings(item?.sensitiveCategories);
  const categories = new Set(supplied.filter((category) => SENSITIVE_CATEGORY_SET.has(category)));
  // An adapter that labels a category we do not recognize must not receive a
  // silent pass-through. Keep it excluded until a supported contract can
  // classify it explicitly.
  if (supplied.some((category) => !SENSITIVE_CATEGORY_SET.has(category))) categories.add("uncertain-sensitivity");
  if (item?.uncertainSensitivity === true || item?.calendarPrivate === true || item?.calendarSensitive === true || item?.titleSensitive === true) {
    categories.add("private-restricted-labels");
  }
  const title = nonEmptyString(item?.title ?? item?.summary ?? item?.label) ?? "";
  if (/\b(?:password|passcode|secret|api[ _-]?key|medical|doctor|legal|lawsuit|payroll|salary|hr|bank|social security)\b/i.test(title)) {
    categories.add("private-restricted-labels");
  }
  return [...categories].sort();
}

function normalizeCalendarMetadata(metadata, expectedAccountId = null) {
  if (!metadata || typeof metadata !== "object" || metadata.source !== SOURCE || metadata.readOnly !== true) {
    throw new GoogleCalendarLifecycleError("CALENDAR_METADATA_INVALID", "I could not safely confirm read-only Calendar metadata, so no event detail was read.");
  }
  const accountId = nonEmptyString(metadata.account?.id);
  if (!isCalendarAccountId(accountId) || (expectedAccountId && accountId !== expectedAccountId)) {
    throw new GoogleCalendarLifecycleError("CALENDAR_ACCOUNT_MISMATCH", "I could not safely match the Calendar metadata to this connection, so no event detail was read.");
  }

  const accessByPersonId = new Map();
  for (const person of Array.isArray(metadata.people) ? metadata.people : []) {
    const personId = nonEmptyString(person?.id);
    if (!isCalendarPersonId(personId)) {
      throw new GoogleCalendarLifecycleError("CALENDAR_METADATA_INVALID", "Calendar metadata contained an unsafe attendee reference, so no event detail was read.");
    }
    const accessLevel = ACCESS_LEVELS.has(person?.accessLevel) ? person.accessLevel : "restricted";
    const previous = accessByPersonId.get(personId);
    if (!previous || ["allowed", "restricted", "blocked"].indexOf(accessLevel) > ["allowed", "restricted", "blocked"].indexOf(previous)) {
      accessByPersonId.set(personId, accessLevel);
    }
  }

  const items = (Array.isArray(metadata.items) ? metadata.items : []).map((item) => {
    const id = nonEmptyString(item?.id);
    const area = nonEmptyString(item?.area);
    const timestamp = safeIsoTimestamp(item?.timestamp);
    const participantIds = uniqueStrings(item?.participantIds);
    if (!isCalendarEventId(id) || !isCalendarAreaId(area) || !timestamp || item?.kind !== "item" || item?.category !== "calendar-event" || participantIds.some((personId) => !isCalendarPersonId(personId))) {
      throw new GoogleCalendarLifecycleError("CALENDAR_METADATA_INVALID", "Calendar metadata did not preserve the approved opaque event boundary, so no event detail was read.");
    }
    for (const personId of participantIds) {
      if (!accessByPersonId.has(personId)) accessByPersonId.set(personId, "restricted");
    }
    const sensitiveCategories = calendarSensitiveCategories(item);
    return {
      id,
      kind: "item",
      area,
      category: "calendar-event",
      timestamp,
      participantIds,
      sensitiveCategories,
      label: sensitiveCategories.length > 0 ? "Sensitive calendar event" : "Calendar event"
    };
  });

  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new GoogleCalendarLifecycleError("CALENDAR_METADATA_INVALID", "Calendar metadata contained an ambiguous event reference, so no event detail was read.");
  }
  const people = [...accessByPersonId.entries()]
    .filter(([personId]) => items.some((item) => item.participantIds.includes(personId)))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, accessLevel]) => ({
      id,
      accessLevel,
      label: accessLevel === "allowed" ? "Approved attendee" : "Private attendee"
    }));

  return {
    source: SOURCE,
    account: { id: accountId, label: "Calendar account" },
    readOnly: true,
    people,
    areas: uniqueStrings(items.map((item) => item.area)),
    categories: ["calendar-event"],
    items
  };
}

function reviewedCalendarRecords(metadata, accountId) {
  const normalized = normalizeCalendarMetadata(metadata, accountId);
  return Object.fromEntries(normalized.items.map((item) => [item.id, {
    sourceRecordId: item.id,
    area: item.area,
    category: item.category,
    timestamp: item.timestamp,
    participantIds: item.participantIds,
    sensitiveCategories: item.sensitiveCategories
  }]));
}

function recordFitsCalendarGrant(record, grant, accountId) {
  const scope = grant?.scope;
  if (!scope || grant?.source !== SOURCE || scope.accountId !== accountId || !isCalendarEventId(record?.sourceRecordId)) return false;
  const timestamp = Date.parse(record.timestamp);
  const from = Date.parse(scope.dateRange?.from);
  const to = Date.parse(scope.dateRange?.to);
  if (!Number.isFinite(timestamp) || !Number.isFinite(from) || !Number.isFinite(to) || timestamp < from || timestamp > to) return false;
  if ((scope.exclusions?.dateRanges ?? []).some((range) => {
    const excludedFrom = Date.parse(range?.from);
    const excludedTo = Date.parse(range?.to);
    return Number.isFinite(excludedFrom) && Number.isFinite(excludedTo) && timestamp >= excludedFrom && timestamp <= excludedTo;
  })) return false;
  if (!Array.isArray(scope.areas) || !scope.areas.includes(record.area)) return false;
  if (!Array.isArray(scope.categories) || !scope.categories.includes(record.category)) return false;
  if ((record.participantIds ?? []).some((personId) => (scope.exclusions?.people ?? []).includes(personId))) return false;
  const excludedSensitive = new Set([
    ...(scope.sensitiveGroups?.excluded ?? []),
    ...(scope.exclusions?.categories ?? [])
  ]);
  return !(record.sensitiveCategories ?? []).some((category) => excludedSensitive.has(category));
}

/**
 * Enforces the exact opaque event inventory shown during metadata review.
 * An injected adapter cannot surface a new event, a raw identifier, or a
 * reviewed event that falls outside the final granular grant.
 */
export class CalendarBoundedConnector {
  constructor(connector, { reviewedRecordsById = null } = {}) {
    assertCalendarConnector(connector);
    this.connector = connector;
    this.reviewedRecordsById = reviewedRecordsById === null ? null : new Map(Object.entries(reviewedRecordsById));
    this.lastMetadata = null;
  }

  assertGrant(grant) {
    if (grant?.source !== SOURCE || !isCalendarAccountId(grant?.accountId) || grant?.scope?.accountId !== grant.accountId) {
      throw new GoogleCalendarLifecycleError("CALENDAR_GRANT_INVALID", "The Calendar grant did not match its read-only account boundary, so no event detail was read.");
    }
  }

  async discoverMetadata({ source }) {
    if (source !== SOURCE) throw new GoogleCalendarLifecycleError("CALENDAR_SOURCE_MISMATCH", "The source did not match the Calendar review, so no event detail was read.");
    this.lastMetadata = normalizeCalendarMetadata(await this.connector.discoverMetadata({ source }));
    return clone(this.lastMetadata);
  }

  async registerPermissionGrant({ grant }) {
    this.assertGrant(grant);
    return this.connector.registerPermissionGrant({ grant });
  }

  async revokePermissionGrant({ grantId }) {
    return this.connector.revokePermissionGrant({ grantId });
  }

  async fetchApprovedContent({ source, accountId, grant }) {
    if (source !== SOURCE || !isCalendarAccountId(accountId)) {
      throw new GoogleCalendarLifecycleError("CALENDAR_SOURCE_MISMATCH", "The source did not match the Calendar review, so no event detail was read.");
    }
    this.assertGrant(grant);
    if (grant.accountId !== accountId || !this.reviewedRecordsById) {
      throw new GoogleCalendarLifecycleError("CALENDAR_REVIEWED_RECORDS_MISSING", "The saved Calendar review no longer has a safe event inventory, so no event detail was read. Start a new review.");
    }
    const result = await this.connector.fetchApprovedContent({ source, accountId, grant });
    if (result?.rawBodiesReturned === true || !Array.isArray(result?.records)) {
      throw new GoogleCalendarLifecycleError("CALENDAR_BODY_BOUNDARY_INVALID", "The Calendar connector did not preserve the source-body boundary, so no event detail was exposed.");
    }
    const seen = new Set();
    const records = result.records.map((record) => {
      const sourceRecordId = nonEmptyString(record?.sourceRecordId ?? record?.id);
      if (!isCalendarEventId(sourceRecordId) || (record?.source && record.source !== SOURCE)) {
        throw new GoogleCalendarLifecycleError("CALENDAR_RECORD_INVALID", "The Calendar connector returned an invalid approved reference, so no event detail was exposed.");
      }
      if (seen.has(sourceRecordId)) {
        throw new GoogleCalendarLifecycleError("CALENDAR_RECORD_DUPLICATE", "The Calendar connector returned a duplicate approved reference, so no event detail was exposed.");
      }
      seen.add(sourceRecordId);
      const reviewed = this.reviewedRecordsById.get(sourceRecordId);
      if (!reviewed) {
        throw new GoogleCalendarLifecycleError("CALENDAR_UNREVIEWED_RECORD", "The Calendar connector returned an event outside the reviewed scope, so no event detail was exposed.");
      }
      if (!recordFitsCalendarGrant(reviewed, grant, accountId)) {
        throw new GoogleCalendarLifecycleError("CALENDAR_SCOPE_BYPASS", "The Calendar connector returned an event outside the final granted scope, so no event detail was exposed.");
      }
      return { sourceRecordId, source: SOURCE };
    });
    return { rawBodiesReturned: false, records };
  }
}

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function assertStateStore(stateStore) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent stateStore with load() and save() is required.");
  }
}

function assertNaturalLanguage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new GoogleCalendarLifecycleError("CALENDAR_MESSAGE_REQUIRED", "Tell me in normal language if you want to review your Calendar, approve the reviewed scope, or stop it.");
  }
  if (message.trim().startsWith("/")) {
    throw new GoogleCalendarLifecycleError("NO_SLASH_COMMANDS", "You do not need a command. Tell me what you want to do with Calendar in normal language.");
  }
}

function assertCalendarConnector(connector) {
  if (!connector || typeof connector.discoverMetadata !== "function" || typeof connector.fetchApprovedContent !== "function" || typeof connector.getReadOnlyStatus !== "function" || typeof connector.registerPermissionGrant !== "function" || typeof connector.revokePermissionGrant !== "function") {
    throw new TypeError("A read-only injected Calendar adapter with metadata discovery, grant lifecycle, status, and bounded fetch is required.");
  }
}

function languageFor(state, language) {
  return language === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function copy(language) {
  if (language === "es") {
    return {
      awaitingGrant: "Revisé únicamente metadatos de Calendar para preparar una aprobación separada. Todavía no he leído detalles de eventos. El alcance predeterminado es los 6 meses anteriores y los próximos 90 días.",
      partialReview: "Solo pude revisar parte de los calendarios disponibles. Los calendarios no disponibles no se incluirán y no se ha leído ningún detalle de evento.",
      empty: "No hay eventos aprobados dentro de este alcance. No se creó, editó, aceptó, rechazó ni eliminó ningún evento.",
      emptyPartial: "No hay eventos aprobados en los calendarios disponibles dentro de este alcance. Algunos calendarios no estaban disponibles y no se modificó ningún evento.",
      readyToImport: "La aprobación de Calendar está activa y sigue siendo solo de lectura. Puedes importar únicamente las referencias de eventos aprobadas.",
      imported: "Procesé únicamente referencias opacas de eventos aprobados. Calendar siguió siendo solo de lectura: no se creó, editó, aceptó, rechazó ni eliminó ningún evento.",
      importedPartial: "Procesé únicamente referencias opacas de los calendarios aprobados y disponibles. Algunos calendarios no estaban disponibles; no se modificó ningún evento.",
      metadataRetry: "No pude completar de forma segura la revisión de metadatos de Calendar. No se leyó ningún detalle de evento y puedes reanudar esta revisión más tarde.",
      grantRetry: "No pude activar de forma segura el permiso de Calendar. No se leyó ningún detalle de evento y puedes reintentar la misma revisión.",
      fetchRetry: "No pude leer los detalles de eventos aprobados en este momento. No se modificó ningún evento y puedes reintentar el alcance guardado.",
      revoked: "El acceso de Calendar ya no está disponible. No se leyó ningún detalle de evento y no se modificó ningún evento. Cuando se vuelva a conectar, inicia una revisión nueva.",
      revokedGrant: "El permiso de Calendar se revocó. No se modificó ningún evento y una aprobación anterior no puede reactivarlo.",
      boundary: "Calendar es una fuente separada y solo de lectura. No puede crear, editar, aceptar, rechazar ni eliminar eventos.",
      simulated: "Esta entrega verifica un contrato de adaptador simulado; no afirma una conexión de Google Calendar en vivo.",
      privacy: "La sensibilidad del calendario, de los asistentes y de los títulos se aplica antes de leer detalles de eventos. Los elementos sensibles permanecen excluidos hasta una aprobación explícita."
    };
  }
  return {
    awaitingGrant: "I reviewed Calendar metadata only to prepare a separate approval. I have not read event details. The default scope is the previous 6 months and upcoming 90 days.",
    partialReview: "I could review only part of the available calendars. Unavailable calendars will not be included, and no event detail has been read.",
    empty: "There are no approved events in this scope. No event was created, edited, accepted, declined, or deleted.",
    emptyPartial: "There are no approved events in the available calendars in this scope. Some calendars were unavailable, and no event was changed.",
    readyToImport: "The Calendar approval is active and remains read-only. You can import only the approved event references.",
    imported: "I processed only approved opaque event references. Calendar remained read-only: no event was created, edited, accepted, declined, or deleted.",
    importedPartial: "I processed only approved opaque references from available calendars. Some calendars were unavailable; no event was changed.",
    metadataRetry: "I could not safely complete the Calendar metadata review. No event detail was read, and you can resume this review later.",
    grantRetry: "I could not safely activate the Calendar permission. No event detail was read, and you can retry the same review.",
    fetchRetry: "I could not read approved event details right now. No event was changed, and you can retry the saved scope.",
    revoked: "Calendar access is no longer available. No event detail was read and no event was changed. When it is reconnected, start a new review.",
    revokedGrant: "The Calendar permission was revoked. No event was changed, and an earlier approval cannot reactivate it.",
    boundary: "Calendar is a separate, read-only source. It cannot create, edit, accept, decline, or delete events.",
    simulated: "This release verifies a simulated adapter contract; it does not claim a live Google Calendar connection.",
    privacy: "Calendar, attendee, and event-title sensitivity are applied before event details are read. Sensitive items stay excluded until explicitly approved."
  };
}

function lifecycle(state) {
  if (!state[STATE_KEY]) state[STATE_KEY] = { version: 1, entries: {}, audit: [] };
  return state[STATE_KEY];
}

function entryKey(accountId) {
  return `${SOURCE}:${encodeURIComponent(accountId)}`;
}

function requireSetup(state) {
  if (!state) {
    throw new GoogleCalendarLifecycleError("SETUP_SESSION_NOT_FOUND", "Start your second-brain setup first, then I can guide the Calendar review in this same conversation.");
  }
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  requireSetup(state);
  return state;
}

function numberOrZero(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeAvailability(value) {
  if (!value || value.readOnly !== true || !isCalendarAccountId(value.accountId)) {
    throw new GoogleCalendarLifecycleError("CALENDAR_STATUS_INVALID", "I could not safely confirm a read-only Calendar connection, so I stopped before reading event details.");
  }
  if (!CONNECTION_STATUSES.has(value.status)) {
    throw new GoogleCalendarLifecycleError("CALENDAR_STATUS_INVALID", "I could not safely confirm the Calendar connection state, so I stopped before reading event details.");
  }
  return {
    status: value.status,
    accountId: value.accountId,
    readOnly: true,
    availableCalendarCount: numberOrZero(value.availableCalendarCount),
    unavailableCalendarCount: numberOrZero(value.unavailableCalendarCount),
    normalization: {
      recurringInstances: numberOrZero(value.normalization?.recurringInstances),
      cancelledExcluded: numberOrZero(value.normalization?.cancelledExcluded),
      invalidExcluded: numberOrZero(value.normalization?.invalidExcluded),
      duplicateExcluded: numberOrZero(value.normalization?.duplicateExcluded)
    }
  };
}

async function inspectAvailability(connector) {
  assertCalendarConnector(connector);
  return normalizeAvailability(await connector.getReadOnlyStatus());
}

function newEntry(accountId, availability, now) {
  return {
    source: SOURCE,
    accountId,
    status: "metadata-retry-required",
    reviewId: null,
    reviewedRecordsById: {},
    availability: clone(availability),
    audit: [{ type: "calendar-lifecycle-started", at: now, contentDetailsRead: false }]
  };
}

function ensureEntry(state, accountId, availability, now) {
  const records = lifecycle(state);
  const key = entryKey(accountId);
  if (!records.entries[key]) records.entries[key] = newEntry(accountId, availability, now);
  records.entries[key].availability = clone(availability);
  return records.entries[key];
}

function selectedWindow(permissionReview) {
  return permissionReview?.permissionRequest?.requestedScope?.dateRange
    ?? permissionReview?.activeGrant?.scope?.dateRange
    ?? {
      kind: DEFAULT_PERMISSION_WINDOWS.calendar.kind,
      pastMonths: DEFAULT_PERMISSION_WINDOWS.calendar.pastMonths,
      futureDays: DEFAULT_PERMISSION_WINDOWS.calendar.futureDays,
      label: DEFAULT_PERMISSION_WINDOWS.calendar.label
    };
}

function messageFor(entry, wording) {
  if (entry.status === "access-revoked") return wording.revoked;
  if (entry.status === "metadata-retry-required") return wording.metadataRetry;
  if (entry.status === "grant-retry-required") return wording.grantRetry;
  if (entry.status === "fetch-retry-required") return wording.fetchRetry;
  if (entry.status === "revoked") return wording.revokedGrant;
  if (entry.status === "empty-partial") return wording.emptyPartial;
  if (entry.status === "empty") return wording.empty;
  if (entry.status === "imported-partially") return wording.importedPartial;
  if (entry.status === "imported") return wording.imported;
  if (entry.status === "ready-to-import") return wording.readyToImport;
  if (entry.availability?.status === "partial") return wording.partialReview;
  return wording.awaitingGrant;
}

function publicView(entry, language, permissionReview = null) {
  const wording = copy(language);
  return {
    source: SOURCE,
    status: entry.status,
    message: messageFor(entry, wording),
    connection: {
      separateAuthorization: true,
      readOnly: true,
      canCreateEvents: false,
      canEditEvents: false,
      canAcceptEvents: false,
      canDeclineEvents: false,
      canDeleteEvents: false,
      adapterContract: "simulated",
      liveVerified: false,
      boundary: wording.boundary,
      limitation: wording.simulated
    },
    defaultWindow: clone(selectedWindow(permissionReview)),
    privacy: {
      appliedBeforeEventDetailFetch: true,
      message: wording.privacy
    },
    availability: clone(entry.availability),
    permissionReview: permissionReview ? clone(permissionReview) : null,
    audit: clone(entry.audit)
  };
}

function recordAudit(state, entry, event) {
  entry.audit.push(event);
  lifecycle(state).audit.push({ ...event, accountId: entry.accountId });
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "calendar-operation-failed";
}

function canRetryFetch(error) {
  // Privacy-boundary failures (for example a tampered persisted grant or an
  // adapter returning raw bodies) must surface as hard failures. Only adapter
  // availability failures and a safe grant-registration restore are resumable.
  if ([
    "CALENDAR_BODY_BOUNDARY_INVALID",
    "CALENDAR_GRANT_INVALID",
    "CALENDAR_RECORD_DUPLICATE",
    "CALENDAR_RECORD_INVALID",
    "CALENDAR_REVIEWED_RECORDS_MISSING",
    "CALENDAR_SCOPE_BYPASS",
    "CALENDAR_UNREVIEWED_RECORD"
  ].includes(error?.code)) return false;
  return !error?.code || error.code === "PERMISSION_GRANT_RESTORE_FAILED" || /^CALENDAR_/.test(error.code);
}

function canRetryMetadata(error) {
  // A normal-language request error is actionable immediately and should not
  // be disguised as an availability outage. Source-status and adapter errors
  // fail closed and may be retried after the adapter is corrected.
  return !error?.code
    || /^CALENDAR_/.test(error.code)
    || ["METADATA_PREFLIGHT_INVALID", "METADATA_SOURCE_MISMATCH", "SOURCE_NOT_READ_ONLY"].includes(error.code);
}

async function statusForExistingReview(stateStore, entry, language) {
  if (!entry?.reviewId) return null;
  const current = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId: entry.accountId, language });
  return current?.permissionReview ?? null;
}

// Loss of source access must not leave an old active grant ready to revive if
// the adapter becomes available again. This revokes only the local adapter
// grant; it never changes a Calendar event. A connector that cannot confirm
// revocation remains visibly blocked below rather than being reused.
async function revokeInvalidatedGrant({ message, stateStore, connector, accountId, reviewId, language, clock }) {
  if (!accountId || !reviewId || typeof connector.revokePermissionGrant !== "function") return null;
  const current = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
  if (!current?.permissionReview?.activeGrant) return current?.permissionReview ?? null;
  try {
    const revoked = await revokeSourcePermission({ message, stateStore, connector, source: SOURCE, accountId, reviewId, language, clock });
    return revoked.permissionReview;
  } catch {
    return current.permissionReview;
  }
}

function statusForPermission(permissionReview) {
  if (permissionReview?.status === "granted") return "ready-to-import";
  if (permissionReview?.status === "revoked") return "revoked";
  if (permissionReview?.status === "denied") return "denied";
  return "awaiting-grant";
}

/**
 * Starts the separate, natural-language Calendar review. Discovery is metadata
 * only; an injected adapter remains the only source of event-shaped data.
 */
export async function beginGoogleCalendarReview({ message, stateStore, connector, language, clock, reviewIdFactory }) {
  assertNaturalLanguage(message);
  assertCalendarConnector(connector);
  let state = await loadState(stateStore);
  const now = isoNow(clock);
  let availability;
  try {
    availability = await inspectAvailability(connector);
  } catch (error) {
    const fallback = ensureEntry(state, "pending-calendar", {
      status: "unavailable",
      accountId: "pending-calendar",
      readOnly: true,
      availableCalendarCount: 0,
      unavailableCalendarCount: 0,
      normalization: { recurringInstances: 0, cancelledExcluded: 0, invalidExcluded: 0, duplicateExcluded: 0 }
    }, now);
    fallback.status = "metadata-retry-required";
    recordAudit(state, fallback, { type: "calendar-metadata-unavailable", at: now, reason: errorCode(error), contentDetailsRead: false });
    await stateStore.save(state);
    return { googleCalendar: publicView(fallback, languageFor(state, language)), metadataReviewUnavailable: true };
  }

  const entry = ensureEntry(state, availability.accountId, availability, now);
  if (availability.status === "revoked") {
    const invalidated = await revokeInvalidatedGrant({
      message,
      stateStore,
      connector,
      accountId: entry.accountId,
      reviewId: entry.reviewId,
      language: languageFor(state, language),
      clock
    });
    state = await loadState(stateStore);
    const revokedEntry = ensureEntry(state, availability.accountId, availability, now);
    revokedEntry.status = "access-revoked";
    recordAudit(state, revokedEntry, { type: "calendar-access-revoked", at: now, contentDetailsRead: false });
    await stateStore.save(state);
    return { googleCalendar: publicView(revokedEntry, languageFor(state, language), invalidated) };
  }
  if (availability.status === "unavailable") {
    entry.status = "metadata-retry-required";
    recordAudit(state, entry, { type: "calendar-metadata-unavailable", at: now, contentDetailsRead: false });
    await stateStore.save(state);
    return { googleCalendar: publicView(entry, languageFor(state, language)), metadataReviewUnavailable: true };
  }

  const existing = await statusForExistingReview(stateStore, entry, languageFor(state, language));
  if (existing?.status === "granted" && entry.status === "access-revoked") {
    // The adapter could not confirm local grant revocation while access was
    // lost. Keep that old grant blocked instead of allowing a reconnect to
    // silently reuse it; the public revoke path must succeed first.
    await stateStore.save(state);
    return { googleCalendar: publicView(entry, languageFor(state, language), existing) };
  }
  if (existing && RETRYABLE_ENTRY_STATUSES.has(entry.status)) {
    entry.status = statusForPermission(existing);
    entry.reviewId = existing.permissionRequest.reviewId;
    entry.availability = clone(availability);
    await stateStore.save(state);
    return { googleCalendar: publicView(entry, languageFor(state, language), existing) };
  }

  let review;
  let bounded;
  try {
    bounded = new CalendarBoundedConnector(connector);
    review = await beginSourcePermissionReview({
      message,
      stateStore,
      connector: bounded,
      source: SOURCE,
      language: languageFor(state, language),
      clock,
      reviewIdFactory
    });
  } catch (error) {
    if (!canRetryMetadata(error)) throw error;
    const refreshed = await loadState(stateStore);
    const retryEntry = ensureEntry(refreshed, availability.accountId, availability, now);
    retryEntry.status = "metadata-retry-required";
    recordAudit(refreshed, retryEntry, { type: "calendar-metadata-unavailable", at: now, reason: errorCode(error), contentDetailsRead: false });
    await stateStore.save(refreshed);
    return { googleCalendar: publicView(retryEntry, languageFor(refreshed, language)), metadataReviewUnavailable: true };
  }

  if (review.permissionReview.account.id !== availability.accountId) {
    throw new GoogleCalendarLifecycleError("CALENDAR_ACCOUNT_MISMATCH", "I could not safely match the Calendar metadata review to this connection, so no event detail was read.");
  }
  state = await loadState(stateStore);
  const reviewedEntry = ensureEntry(state, availability.accountId, availability, now);
  reviewedEntry.status = statusForPermission(review.permissionReview);
  reviewedEntry.reviewId = review.permissionReview.permissionRequest.reviewId;
  reviewedEntry.reviewedRecordsById = reviewedCalendarRecords(bounded.lastMetadata, availability.accountId);
  recordAudit(state, reviewedEntry, {
    type: "calendar-metadata-reviewed",
    at: now,
    reviewId: reviewedEntry.reviewId,
    contentDetailsRead: false,
    availability: availability.status
  });
  await stateStore.save(state);
  return { googleCalendar: publicView(reviewedEntry, languageFor(state, language), review.permissionReview) };
}

/** Records an explicit granular Calendar grant without any calendar mutation. */
export async function grantGoogleCalendarContent({ message, stateStore, connector, accountId, reviewId, scope, language, clock, grantIdFactory }) {
  assertNaturalLanguage(message);
  assertCalendarConnector(connector);
  let state = await loadState(stateStore);
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry || entry.reviewId !== reviewId) {
    throw new GoogleCalendarLifecycleError("CALENDAR_REVIEW_NOT_FOUND", "Continue the current Calendar metadata review before approving event access.");
  }
  const availability = await inspectAvailability(connector);
  if (availability.accountId !== accountId || availability.status === "revoked") {
    const invalidated = await revokeInvalidatedGrant({ message, stateStore, connector, accountId, reviewId, language, clock });
    state = await loadState(stateStore);
    const revokedEntry = lifecycle(state).entries[entryKey(accountId)];
    revokedEntry.availability = clone(availability);
    revokedEntry.status = "access-revoked";
    recordAudit(state, revokedEntry, { type: "calendar-access-revoked", at: isoNow(clock), contentDetailsRead: false });
    await stateStore.save(state);
    return { googleCalendar: publicView(revokedEntry, languageFor(state, language), invalidated) };
  }
  if (availability.status === "unavailable") {
    entry.availability = clone(availability);
    entry.status = "grant-retry-required";
    recordAudit(state, entry, { type: "calendar-grant-unavailable", at: isoNow(clock), contentDetailsRead: false });
    await stateStore.save(state);
    return { googleCalendar: publicView(entry, languageFor(state, language)), grantUnavailable: true };
  }

  let granted;
  try {
    granted = await grantSourcePermission({
      message,
      stateStore,
      connector: new CalendarBoundedConnector(connector, { reviewedRecordsById: entry.reviewedRecordsById }),
      source: SOURCE,
      accountId,
      reviewId,
      scope,
      language,
      clock,
      grantIdFactory
    });
  } catch (error) {
    if (error?.code !== "PERMISSION_GRANT_ACTIVATION_FAILED") throw error;
    state = await loadState(stateStore);
    const retryEntry = lifecycle(state).entries[entryKey(accountId)];
    retryEntry.availability = clone(availability);
    retryEntry.status = "grant-retry-required";
    recordAudit(state, retryEntry, { type: "calendar-grant-unavailable", at: isoNow(clock), reason: errorCode(error), contentDetailsRead: false });
    await stateStore.save(state);
    return { googleCalendar: publicView(retryEntry, languageFor(state, language)), grantUnavailable: true };
  }

  state = await loadState(stateStore);
  const grantedEntry = lifecycle(state).entries[entryKey(accountId)];
  grantedEntry.availability = clone(availability);
  grantedEntry.status = "ready-to-import";
  recordAudit(state, grantedEntry, { type: "calendar-content-granted", at: isoNow(clock), reviewId, grantId: granted.permissionReview.activeGrant?.grantId ?? null, contentDetailsRead: false });
  await stateStore.save(state);
  return { googleCalendar: publicView(grantedEntry, languageFor(state, language), granted.permissionReview) };
}

/** Fetches only opaque approved event references and reports empty/partial/failure truthfully. */
export async function fetchApprovedGoogleCalendarContent({ message, stateStore, connector, accountId, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  assertCalendarConnector(connector);
  let state = await loadState(stateStore);
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry || entry.reviewId !== reviewId || !["ready-to-import", "fetch-retry-required", "imported", "imported-partially", "empty", "empty-partial"].includes(entry.status)) {
    throw new GoogleCalendarLifecycleError("CALENDAR_GRANT_REQUIRED", "No Calendar event detail was read because the saved granular review is not ready.");
  }
  const availability = await inspectAvailability(connector);
  if (availability.accountId !== accountId || availability.status === "revoked") {
    const invalidated = await revokeInvalidatedGrant({ message, stateStore, connector, accountId, reviewId, language, clock });
    state = await loadState(stateStore);
    const revokedEntry = lifecycle(state).entries[entryKey(accountId)];
    revokedEntry.availability = clone(availability);
    revokedEntry.status = "access-revoked";
    recordAudit(state, revokedEntry, { type: "calendar-access-revoked", at: isoNow(clock), contentDetailsRead: false });
    await stateStore.save(state);
    return { googleCalendar: publicView(revokedEntry, languageFor(state, language), invalidated), approvedRecords: [] };
  }
  if (availability.status === "unavailable") {
    entry.availability = clone(availability);
    entry.status = "fetch-retry-required";
    recordAudit(state, entry, { type: "calendar-detail-fetch-unavailable", at: isoNow(clock), contentDetailsRead: false });
    await stateStore.save(state);
    return { googleCalendar: publicView(entry, languageFor(state, language)), approvedRecords: [], contentFetchUnavailable: true };
  }

  let fetched;
  try {
    fetched = await fetchApprovedSourceContent({
      message,
      stateStore,
      connector: new CalendarBoundedConnector(connector, { reviewedRecordsById: entry.reviewedRecordsById }),
      source: SOURCE,
      accountId,
      reviewId,
      language,
      clock
    });
  } catch (error) {
    if (!canRetryFetch(error)) throw error;
    state = await loadState(stateStore);
    const retryEntry = lifecycle(state).entries[entryKey(accountId)];
    retryEntry.availability = clone(availability);
    retryEntry.status = "fetch-retry-required";
    recordAudit(state, retryEntry, { type: "calendar-detail-fetch-unavailable", at: isoNow(clock), reason: errorCode(error), contentDetailsRead: false });
    await stateStore.save(state);
    return { googleCalendar: publicView(retryEntry, languageFor(state, language)), approvedRecords: [], contentFetchUnavailable: true };
  }

  state = await loadState(stateStore);
  const fetchedEntry = lifecycle(state).entries[entryKey(accountId)];
  fetchedEntry.availability = clone(availability);
  fetchedEntry.status = fetched.approvedRecords.length === 0
    ? availability.status === "partial" ? "empty-partial" : "empty"
    : availability.status === "partial" ? "imported-partially" : "imported";
  recordAudit(state, fetchedEntry, {
    type: "calendar-approved-event-references-processed",
    at: isoNow(clock),
    reviewId,
    recordCount: fetched.approvedRecords.length,
    availability: availability.status
  });
  await stateStore.save(state);
  return { googleCalendar: publicView(fetchedEntry, languageFor(state, language), fetched.permissionReview), approvedRecords: fetched.approvedRecords };
}

/** Revokes only the local grant state; it never changes a Calendar event. */
export async function revokeGoogleCalendarContent({ message, stateStore, connector, accountId, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  assertCalendarConnector(connector);
  const revoked = await revokeSourcePermission({ message, stateStore, connector, source: SOURCE, accountId, reviewId, language, clock });
  const state = await loadState(stateStore);
  const entry = lifecycle(state).entries[entryKey(accountId)];
  entry.status = "revoked";
  recordAudit(state, entry, { type: "calendar-content-revoked", at: isoNow(clock), reviewId, contentDetailsRead: false });
  await stateStore.save(state);
  return { googleCalendar: publicView(entry, languageFor(state, language), revoked.permissionReview) };
}

/** Read-only lifecycle status lookup; it never invokes the Calendar adapter. */
export async function getGoogleCalendarStatus({ stateStore, accountId, language }) {
  const state = await loadState(stateStore);
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry) return null;
  const permission = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
  return { googleCalendar: publicView(entry, languageFor(state, language), permission?.permissionReview) };
}
