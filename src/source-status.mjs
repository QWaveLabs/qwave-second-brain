/**
 * QWA-149 source-state presentation and safe generic-export vertical slice.
 *
 * This module is a status boundary, not a connector SDK. It never opens an
 * OAuth flow, calls a real source, reads a source body, writes to a source, or
 * turns a reported adapter state into a claim that a connector is live. A
 * handoff may durably migrate private local aliases under the shared root lock;
 * that migration uses only the already-loaded local root. The one import path
 * is intentionally a simulated generic export that returns opaque,
 * snapshot-labelled references only after granular consent.
 */

import { randomUUID } from "node:crypto";
import {
  getSourcePermissionStatusFromState,
  withSourcePermissionStateLock,
  withSourcePermissionStateReadLock
} from "./permissions/setup-source-permissions.mjs";
import {
  migrateStableLocalAliases,
  validStableLocalAliasLifecycleEntries
} from "./connectors/stable-local-aliases.mjs";
import {
  sanitizePersistedDriveFailureReasons,
  sanitizePersistedIMessageEntryFailureReasons,
  sanitizePersistedIMessageRootFailureReasons
} from "./connectors/persisted-failure-reasons.mjs";

const STATE_KEY = "sourceStatusV2";
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ID = /^simulated-export(?::[a-z0-9][a-z0-9-]{0,63})?$/;
const BODY_FIELD_NAMES = new Set([
  "body",
  "bodies",
  "html",
  "text",
  "content",
  "snippet",
  "raw",
  "payload",
  "payloads",
  "header",
  "headers",
  "mime",
  "attachment",
  "attachments",
  "messagebody",
  "messagebodies",
  "emailbody",
  "emailbodies"
]);
const MAX_PREVIEW_ITEMS = 250;
const REMOTE_REVOCATION_REQUIRED_PERMISSION_STATUSES = new Set([
  "active",
  "grant-pending",
  "revocation-pending",
  "revocation-awaiting-registration",
  "revocation-unconfirmed",
  "consuming-revocation-pending"
]);
// A revoke can arrive through a reopened FileStateStore while this process is
// still awaiting adapter registration. The durable operation id lets that
// revoke remain pending until the registration promise has actually settled.
// A new process has an empty set, so an interrupted registration can be
// reconciled by an explicit retry rather than remaining stuck forever.
const inFlightGrantRegistrationOperations = new Set();

/** Shared state vocabulary used by every adapter presentation. */
export const SOURCE_STATUS_STATES = Object.freeze({
  NOT_STARTED: "not-started",
  AWAITING_GRANT: "awaiting-grant",
  READY_TO_IMPORT: "ready-to-import",
  IMPORTING: "importing",
  IMPORTED: "imported",
  SKIPPED: "skipped",
  REVOKED: "revoked",
  UNSUPPORTED: "unsupported",
  NEEDS_ATTENTION: "needs-attention"
});

export const SOURCE_STATE_VOCABULARY = SOURCE_STATUS_STATES;

/** Final customer handoff buckets. Each source appears in exactly one. */
export const SOURCE_HANDOFF_CATEGORIES = Object.freeze({
  UNFINISHED: "unfinished",
  SKIPPED: "skipped",
  IMPORTED: "imported",
  REVOKED: "revoked",
  UNSUPPORTED: "unsupported"
});

export const SOURCE_ADAPTER_NAMES = Object.freeze({
  GENERIC_EXPORT: "simulated-generic-export",
  GMAIL: "gmail-readonly",
  GOOGLE_CALENDAR: "google-calendar",
  GOOGLE_DRIVE: "google-drive",
  IMESSAGE: "imessage-beta"
});

export const LIVE_CONNECTOR_RELEASE_GATE = Object.freeze({
  id: "at-least-one-live-verified-connector",
  requirement: "At least one live, independently verified, read-only connector",
  simulationDoesNotSatisfyRequirement: true
});

const ALL_STATES = new Set(Object.values(SOURCE_STATUS_STATES));
const FINAL_STATES = new Set([
  SOURCE_STATUS_STATES.IMPORTED,
  SOURCE_STATUS_STATES.SKIPPED,
  SOURCE_STATUS_STATES.REVOKED,
  SOURCE_STATUS_STATES.UNSUPPORTED
]);

export class SourceStatusError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "SourceStatusError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

function clone(value) {
  return structuredClone(value);
}

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertStateStore(stateStore) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent stateStore with load() and save() is required.");
  }
}

function assertNaturalLanguage(message, action = "start") {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new SourceStatusError(
      "SOURCE_STATUS_MESSAGE_REQUIRED",
      "Tell me in normal language what you would like to do with this optional source."
    );
  }
  if (message.trim().startsWith("/")) {
    throw new SourceStatusError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Tell me normally whether you want to preview, approve, skip, resume, import, or revoke this source."
    );
  }
  if (action === "start" && !/(source|export|import|second\s+brain|segundo\s+cerebro|fuente|exportaci[oó]n|importar|conectar|connect|preview|vista previa|review|revisar)/i.test(message)) {
    throw new SourceStatusError(
      "UNRECOGNIZED_SOURCE_REQUEST",
      "Tell me you would like to preview a simulated export for your second brain, and I will guide the safe next step."
    );
  }
}

function assertSourceId(sourceId) {
  if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) {
    throw new SourceStatusError(
      "SIMULATED_SOURCE_ID_REQUIRED",
      "This safe slice only supports an explicitly simulated generic export. It will not open or imitate a real source connection."
    );
  }
  return sourceId;
}

function unsupportedSourceId(requestedSource) {
  const safe = typeof requestedSource === "string" && /^[a-z][a-z0-9-]{0,63}$/i.test(requestedSource)
    ? requestedSource.toLowerCase()
    : "unavailable-source";
  return `unsupported:${safe}`;
}

function languageFor(state, requestedLanguage) {
  return requestedLanguage === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function wording(language) {
  if (language === "es") {
    return {
      notStarted: "Esta fuente opcional todavía no se ha iniciado. No está conectada.",
      awaitingGrant: "La vista previa fue solo de metadatos. No se leyó ningún cuerpo de fuente. Elige exactamente qué elementos de exportación simulada autorizas antes de importar una instantánea.",
      readyToImport: "Tu permiso granular se guardó para esta exportación simulada. El siguiente paso importará únicamente una instantánea etiquetada y de una sola vez; no conecta una fuente real.",
      importing: "La importación de la instantánea simulada está en curso. Si se interrumpe, se pausará de forma segura y requerirá una vista previa nueva antes de volver a intentarlo.",
      imported: "Se importó una instantánea etiquetada de la exportación simulada. No se conectó ni verificó una fuente real, y el permiso de una sola vez quedó cerrado.",
      skipped: "Esta fuente opcional quedó omitida por ahora. Puedes reanudarla aquí más adelante; no se concedió acceso al contenido.",
      revoked: "El permiso de esta fuente fue revocado. Una pantalla o solicitud anterior no puede reactivarlo; inicia una vista previa nueva si quieres volver a considerarlo.",
      unsupported: "Esta fuente no es compatible en esta configuración segura. No se intentó ninguna conexión y no se leyó ningún dato de fuente. Puedes usar una exportación simulada de metadatos si quieres ver el flujo.",
      needsAttention: "Esta fuente necesita atención antes de continuar. El flujo se detuvo de forma segura y no se expuso ningún cuerpo de fuente. Puedes reanudar el paso seguro guardado.",
      metadataOnly: "Solo metadatos: nombres genéricos de elementos, identificadores opacos y categorías. No hay cuerpos, adjuntos, mensajes, archivos ni enlaces de fuente.",
      noLiveConnection: "No hay una conexión en vivo ni verificada en esta vista segura.",
      releaseGateUnsatisfied: "La puerta de lanzamiento sigue sin cumplir: esta entrega no tiene al menos un conector en vivo verificado de forma independiente. Las simulaciones y los estados informados por adaptadores no cuentan.",
      releaseGateSatisfied: "La puerta de lanzamiento cuenta con un conector en vivo y de solo lectura verificado de forma independiente y guardado por su ciclo de vida aprobado.",
      unsupportedSafe: "No puedo conectar esta fuente desde esta configuración. No inventaré una conexión, enlace ni estado en vivo."
    };
  }
  return {
    notStarted: "This optional source has not been started. It is not connected.",
    awaitingGrant: "The preview was metadata-only. No source body was read. Choose exactly which simulated export items you approve before importing a labelled snapshot.",
    readyToImport: "Your granular permission is saved for this simulated export. The next step imports only a labelled, one-time snapshot; it does not connect a real source.",
    importing: "The simulated snapshot import is in progress. If it is interrupted, it will pause safely and require a fresh preview before retrying.",
    imported: "A labelled simulated-export snapshot was imported. No real source was connected or verified, and the one-time permission is closed.",
    skipped: "This optional source is skipped for now. You can resume it here later; no content access was granted.",
    revoked: "This source permission was revoked. An earlier screen or request cannot reactivate it; start a fresh preview if you want to consider it again.",
    unsupported: "This source is unsupported in this safe setup. No connection was attempted and no source data was read. You can use a metadata-only simulated export to see the flow.",
    needsAttention: "This source needs attention before it can continue. The flow stopped safely and no source body was exposed. You can resume the saved safe step.",
    metadataOnly: "Metadata only: generic item labels, opaque ids, and categories. No bodies, attachments, messages, files, or source links are present.",
    noLiveConnection: "There is no live or verified connection in this safe view.",
    releaseGateUnsatisfied: "The release gate remains unsatisfied: this delivery has no independently verified live connector. Simulations and adapter-reported states do not count.",
    releaseGateSatisfied: "The release gate has at least one independently verified, read-only live connector recorded by its approved lifecycle.",
    unsupportedSafe: "I cannot connect this source from this safe setup. I will not invent a connection, link, or live status."
  };
}

function handoffCategoryFor(state) {
  if (state === SOURCE_STATUS_STATES.SKIPPED) return SOURCE_HANDOFF_CATEGORIES.SKIPPED;
  if (state === SOURCE_STATUS_STATES.IMPORTED) return SOURCE_HANDOFF_CATEGORIES.IMPORTED;
  if (state === SOURCE_STATUS_STATES.REVOKED) return SOURCE_HANDOFF_CATEGORIES.REVOKED;
  if (state === SOURCE_STATUS_STATES.UNSUPPORTED) return SOURCE_HANDOFF_CATEGORIES.UNSUPPORTED;
  return SOURCE_HANDOFF_CATEGORIES.UNFINISHED;
}

function stateMessage(state, language) {
  const copy = wording(language);
  const key = {
    [SOURCE_STATUS_STATES.NOT_STARTED]: "notStarted",
    [SOURCE_STATUS_STATES.AWAITING_GRANT]: "awaitingGrant",
    [SOURCE_STATUS_STATES.READY_TO_IMPORT]: "readyToImport",
    [SOURCE_STATUS_STATES.IMPORTING]: "importing",
    [SOURCE_STATUS_STATES.IMPORTED]: "imported",
    [SOURCE_STATUS_STATES.SKIPPED]: "skipped",
    [SOURCE_STATUS_STATES.REVOKED]: "revoked",
    [SOURCE_STATUS_STATES.UNSUPPORTED]: "unsupported",
    [SOURCE_STATUS_STATES.NEEDS_ATTENTION]: "needsAttention"
  }[state] ?? "needsAttention";
  return copy[key];
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SourceStatusError("SOURCE_STATUS_INPUT_INVALID", message);
  }
}

function assertAllowedKeys(value, allowed, field) {
  assertPlainObject(value, `${field} must be an object.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new SourceStatusError("SOURCE_STATUS_INPUT_INVALID", `${field} included an unsupported field, so I stopped without changing access.`);
  }
}

function assertNoSourceBody(value, location = "adapter response", seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSourceBody(item, `${location}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (BODY_FIELD_NAMES.has(normalizedKey)) {
      throw new SourceStatusError(
        "SOURCE_BODY_BOUNDARY_INVALID",
        `The ${location} included a source-body field, so I stopped before saving or showing it.`
      );
    }
    assertNoSourceBody(child, `${location}.${key}`, seen);
  }
}

function opaqueId(value, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new SourceStatusError("SOURCE_STATUS_INPUT_INVALID", `${field} must be a short opaque identifier.`);
  }
  return value;
}

function uniqueOpaqueIds(values, field) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_PREVIEW_ITEMS) {
    throw new SourceStatusError("GRANULAR_SELECTION_REQUIRED", `Choose one or more individual reviewed export items for ${field}.`);
  }
  const normalized = values.map((value) => opaqueId(value, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new SourceStatusError("GRANULAR_SELECTION_INVALID", "Each selected export item must appear once so the permission stays unambiguous.");
  }
  return normalized;
}

function rootLifecycle(state) {
  if (!state?.installationId) {
    throw new SourceStatusError(
      "SETUP_SESSION_NOT_FOUND",
      "Start your second-brain setup first, then I can guide this optional source safely in the same conversation."
    );
  }
  if (!state[STATE_KEY]) {
    state[STATE_KEY] = { version: 2, entries: {}, audit: [] };
  }
  return state[STATE_KEY];
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  rootLifecycle(state);
  return state;
}

// QWA-149 shares the same complete Setup Session document as QWA-139. Keep
// every local read-modify-write section on its canonical state-store lock, but
// deliberately release it for adapter calls and revalidate the durable
// generation when the call returns. That lets an explicit revoke win while a
// resumed process is waiting on an adapter.
function withSourceStatusStateLock(stateStore, operation) {
  return withSourcePermissionStateLock(stateStore, operation);
}

function defaultEntry(sourceId, now) {
  return {
    sourceId,
    adapter: SOURCE_ADAPTER_NAMES.GENERIC_EXPORT,
    // Every asynchronous source operation records a durable revision before
    // leaving local state. A later revoke increments it, so a stale import
    // response can never overwrite the revoke when it returns.
    revision: 0,
    state: SOURCE_STATUS_STATES.NOT_STARTED,
    resumeState: SOURCE_STATUS_STATES.NOT_STARTED,
    metadataPreview: null,
    permission: {
      status: "none",
      reviewId: null,
      grantId: null,
      registrationOperationId: null,
      selectedItemIds: [],
      grantedAt: null,
      revokedAt: null,
      revocationConfirmed: null
    },
    snapshotImport: {
      status: "not-started",
      snapshotLabel: null,
      importedAt: null,
      records: []
    },
    lastSafeError: null,
    audit: [{ type: "simulated-export-selected", at: now, sourceBodiesRead: false }]
  };
}

function entryRevision(entry) {
  return Number.isSafeInteger(entry?.revision) && entry.revision >= 0 ? entry.revision : 0;
}

function bumpEntryRevision(entry) {
  entry.revision = entryRevision(entry) + 1;
  return entry.revision;
}

function permissionMayRemainActive(entry) {
  const permission = entry?.permission;
  return REMOTE_REVOCATION_REQUIRED_PERMISSION_STATUSES.has(permission?.status)
    // Earlier QWA-149 candidates wrote this status even when adapter cleanup
    // failed. On upgrade, make that unknown legacy record fail closed until a
    // new explicit revocation confirms the remote state.
    || (permission?.status === "revoked-after-failure" && permission.revocationConfirmed !== true);
}

function operationStillCurrent(entry, { revision, grantId, state, permissionStatuses }) {
  return entryRevision(entry) === revision
    && entry?.permission?.grantId === grantId
    && entry?.state === state
    && permissionStatuses.includes(entry?.permission?.status);
}

function safePreview(preview) {
  if (!preview) return null;
  return {
    metadataOnly: true,
    contentBodiesRead: false,
    previewedAt: preview.previewedAt,
    itemCount: preview.itemCount,
    items: preview.items.map((item) => ({ id: item.id, label: item.label, category: item.category })),
    message: preview.message
  };
}

function publicSourceStatus(entry, language, {
  adapterReportedState = null,
  external = false,
  statusOrigin = null,
  authorizationOutcome = null,
  trustedLiveVerification = null
} = {}) {
  const simulated = entry.adapter === SOURCE_ADAPTER_NAMES.GENERIC_EXPORT;
  const category = handoffCategoryFor(entry.state);
  const verifiedLive = Boolean(trustedLiveVerification);
  return {
    source: {
      id: entry.sourceId,
      adapter: entry.adapter,
      kind: simulated ? "simulated-generic-export" : "adapter-status-only",
      label: entry.state === SOURCE_STATUS_STATES.UNSUPPORTED ? "Unsupported source" : simulated ? "Simulated generic export" : "Source status"
    },
    state: entry.state,
    stateRevision: entryRevision(entry),
    handoffCategory: category,
    message: stateMessage(entry.state, language),
    connection: {
      status: simulated ? "not-connected-simulation" : verifiedLive ? "live-and-verified" : "not-verified",
      live: verifiedLive,
      independentlyVerified: verifiedLive,
      readOnly: simulated || verifiedLive ? true : null,
      realConnectionAttempted: verifiedLive,
      sourceBodiesRead: false,
      sourceWrites: false,
      verifiedAt: trustedLiveVerification?.verifiedAt ?? null,
      verificationMethod: trustedLiveVerification?.verificationMethod ?? null,
      note: verifiedLive ? wording(language).releaseGateSatisfied : wording(language).noLiveConnection
    },
    metadataPreview: safePreview(entry.metadataPreview),
    granularPermission: {
      status: entry.permission.status,
      reviewId: entry.permission.reviewId,
      grantId: entry.permission.grantId,
      selectedItemIds: clone(entry.permission.selectedItemIds),
      grantedAt: entry.permission.grantedAt,
      revokedAt: entry.permission.revokedAt,
      revocationConfirmed: entry.permission.revocationConfirmed === true
    },
    snapshotImport: {
      status: entry.snapshotImport.status,
      snapshotLabel: entry.snapshotImport.snapshotLabel,
      simulated: simulated,
      importedAt: entry.snapshotImport.importedAt,
      recordCount: entry.snapshotImport.records.length,
      records: entry.snapshotImport.records.map((record) => ({
        source: record.source,
        snapshotRecordId: record.snapshotRecordId,
        processingDisposition: record.processingDisposition
      }))
    },
    nextAction: nextActionFor(entry, language),
    lastSafeError: entry.lastSafeError ? clone(entry.lastSafeError) : null,
    adapterReportedState: adapterReportedState ? { value: adapterReportedState, treatedAsProofOfLiveConnection: verifiedLive } : null,
    statusOrigin,
    authorizationOutcome,
    external,
    audit: clone(entry.audit)
  };
}

function nextActionFor(entry, language) {
  const isEs = language === "es";
  if (permissionMayRemainActive(entry) && entry.permission.status !== "active") {
    return {
      kind: "confirm-or-retry-simulated-export-revocation",
      instruction: isEs
        ? "Confirma o vuelve a intentar la revocación antes de omitir, reiniciar o conceder otro permiso para esta fuente."
        : "Confirm or retry revocation before skipping, restarting, or granting another permission for this source."
      };
  }
  if (entry.state === SOURCE_STATUS_STATES.AWAITING_GRANT) {
    return {
      kind: "review-granular-simulated-export-permission",
      instruction: isEs ? "Revisa los elementos de exportación simulada y aprueba exactamente los que quieres incluir." : "Review the simulated export items and approve exactly the ones you want included."
    };
  }
  if (entry.state === SOURCE_STATUS_STATES.READY_TO_IMPORT) {
    return {
      kind: "import-approved-simulated-snapshot",
      instruction: isEs ? "Importa la instantánea simulada aprobada de una sola vez." : "Import the approved one-time simulated snapshot."
    };
  }
  if (entry.state === SOURCE_STATUS_STATES.IMPORTING) {
    return {
      kind: "recover-interrupted-simulated-import",
      instruction: isEs
        ? "Reanuda la importación guardada para cerrar de forma segura el permiso interrumpido antes de iniciar una vista previa nueva."
        : "Resume the saved import to safely close its interrupted permission before starting a fresh preview."
    };
  }
  if (entry.state === SOURCE_STATUS_STATES.SKIPPED) {
    return {
      kind: "resume-optional-source",
      instruction: isEs ? "Reanuda esta fuente opcional cuando quieras continuar." : "Resume this optional source whenever you want to continue."
    };
  }
  if (entry.state === SOURCE_STATUS_STATES.NEEDS_ATTENTION) {
    return {
      kind: "retry-safe-simulated-step",
      instruction: isEs ? "Reintenta la vista previa segura guardada; no se reutilizará un permiso activo después de un fallo." : "Retry the saved safe preview; an active permission is never reused after a failure."
    };
  }
  if (entry.state === SOURCE_STATUS_STATES.UNSUPPORTED) {
    return {
      kind: "choose-supported-safe-path",
      instruction: wording(language).unsupportedSafe
    };
  }
  return null;
}

function normalizePreview(result, sourceId, now, language) {
  assertNoSourceBody(result, "metadata preview");
  if (!result || typeof result !== "object" || result.sourceId !== sourceId || result.simulated !== true || result.metadataOnly !== true || result.contentBodiesRead !== false) {
    throw new SourceStatusError(
      "METADATA_PREVIEW_INVALID",
      "I could not confirm a metadata-only simulated export preview, so I stopped before asking for content permission."
    );
  }
  if (!Array.isArray(result.items) || result.items.length > MAX_PREVIEW_ITEMS) {
    throw new SourceStatusError("METADATA_PREVIEW_INVALID", "The simulated export preview did not contain a safe bounded item list, so I stopped before asking for permission.");
  }
  const items = result.items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new SourceStatusError("METADATA_PREVIEW_INVALID", "The simulated export preview contained an invalid item, so I stopped safely.");
    }
    return {
      id: opaqueId(item.id, "Simulated export preview item id"),
      // Never preserve an adapter title in status state: it can contain PII or
      // prompt-injection text. A deterministic ordinal still supports consent.
      label: `Export item ${index + 1}`,
      category: typeof item.category === "string" && /^[a-z][a-z0-9-]{0,31}$/i.test(item.category) ? item.category : "general"
    };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new SourceStatusError("METADATA_PREVIEW_INVALID", "The simulated export preview contained ambiguous item identifiers, so I stopped safely.");
  }
  return {
    previewedAt: now,
    itemCount: items.length,
    items,
    message: wording(language).metadataOnly
  };
}

function requireEntry(records, sourceId) {
  const entry = records.entries[sourceId];
  if (!entry) {
    throw new SourceStatusError("SOURCE_STATUS_NOT_STARTED", "Start a metadata-only simulated export preview first, then I can show the next safe step.");
  }
  return entry;
}

function extractPermissionScope({ scope, selectedItemIds }) {
  if (scope === undefined) {
    return { selectedItemIds, acknowledgements: null };
  }
  assertAllowedKeys(scope, ["selectedItemIds", "acknowledgements"], "The granular permission scope");
  if (selectedItemIds !== undefined) {
    throw new SourceStatusError("SOURCE_STATUS_INPUT_INVALID", "Provide the selected export items either in the granular scope or as selectedItemIds, not both.");
  }
  return scope;
}

function normalizePermissionScope(input, entry) {
  assertAllowedKeys(input, ["selectedItemIds", "acknowledgements"], "The granular permission scope");
  const selectedItemIds = uniqueOpaqueIds(input.selectedItemIds, "this permission");
  const previewed = new Set(entry.metadataPreview?.items.map((item) => item.id) ?? []);
  if (selectedItemIds.some((id) => !previewed.has(id))) {
    throw new SourceStatusError("SCOPE_EXPANSION_BLOCKED", "One or more selected export items were not in the metadata-only preview, so I kept access denied.");
  }
  assertAllowedKeys(input.acknowledgements, ["metadataOnlyPreview", "untrustedSourceMaterial", "simulatedSnapshot"], "The permission acknowledgements");
  if (input.acknowledgements.metadataOnlyPreview !== true || input.acknowledgements.untrustedSourceMaterial !== true || input.acknowledgements.simulatedSnapshot !== true) {
    throw new SourceStatusError(
      "PERMISSION_ACKNOWLEDGEMENTS_REQUIRED",
      "Before granting this scope, confirm that you reviewed metadata only, that exports are untrusted reference material, and that this is a simulated snapshot—not a live connection."
    );
  }
  return {
    selectedItemIds,
    acknowledgements: {
      metadataOnlyPreview: true,
      untrustedSourceMaterial: true,
      simulatedSnapshot: true
    }
  };
}

function normalizeSnapshotResult(result, entry) {
  assertNoSourceBody(result, "snapshot import");
  if (!result || typeof result !== "object" || result.simulated !== true || result.sourceBodiesRead !== false || result.rawBodiesReturned !== false || result.snapshotLabel !== "simulated-export-snapshot" || !Array.isArray(result.records)) {
    throw new SourceStatusError("SNAPSHOT_BOUNDARY_INVALID", "The simulated export did not preserve the snapshot-only body boundary, so I stopped before saving or showing any import.");
  }
  const selectedItemIds = entry.permission.selectedItemIds.map((sourceRecordId) => opaqueId(sourceRecordId, "Approved simulated snapshot record id"));
  const selected = new Set(selectedItemIds);
  if (selected.size !== selectedItemIds.length) {
    throw new SourceStatusError("SNAPSHOT_SCOPE_VIOLATION", "The saved granular permission contained ambiguous item identifiers, so I stopped before saving an import.");
  }
  const returnedSourceRecordIds = [];
  const records = result.records.map((record) => {
    if (!record || typeof record !== "object") {
      throw new SourceStatusError("SNAPSHOT_BOUNDARY_INVALID", "The simulated snapshot returned an invalid record, so I stopped safely.");
    }
    const sourceRecordId = opaqueId(record.sourceRecordId, "Simulated snapshot record id");
    const snapshotRecordId = opaqueId(record.snapshotRecordId, "Simulated snapshot reference");
    returnedSourceRecordIds.push(sourceRecordId);
    if (!selected.has(sourceRecordId) || record.source !== entry.sourceId || record.processingDisposition !== "untrusted-inert-snapshot-reference") {
      throw new SourceStatusError("SNAPSHOT_SCOPE_VIOLATION", "The simulated snapshot included an item outside the granular permission, so I stopped before saving it.");
    }
    return {
      source: entry.sourceId,
      snapshotRecordId,
      processingDisposition: "untrusted-inert-snapshot-reference"
    };
  });
  const returned = new Set(returnedSourceRecordIds);
  const sourceRecordIdsExactlyMatch = returned.size === returnedSourceRecordIds.length
    && returned.size === selected.size
    && selectedItemIds.every((sourceRecordId) => returned.has(sourceRecordId));
  if (!sourceRecordIdsExactlyMatch
    || new Set(records.map((record) => record.snapshotRecordId)).size !== records.length) {
    throw new SourceStatusError("SNAPSHOT_SCOPE_VIOLATION", "The simulated snapshot did not exactly match the granular permission, so I stopped before saving it.");
  }
  return { snapshotLabel: "simulated-export-snapshot", records };
}

function safeErrorCode(error, fallback) {
  const value = typeof error?.code === "string" ? error.code : fallback;
  return /^[A-Z0-9_:-]{3,80}$/.test(value) ? value : fallback;
}

async function revokeAdapterPermission(adapter, grantId) {
  if (!adapter || typeof adapter.revokeSnapshotPermission !== "function") return false;
  const result = await adapter.revokeSnapshotPermission({ grantId });
  return result?.status === "revoked";
}

/**
 * An adapter can fail after accepting a grant or starting an import. Persist a
 * revocation-pending generation before asking it to clean up. That makes the
 * unresolved remote grant visible across a restart and prevents skip/retry
 * from turning a possible grant into an apparently harmless local state.
 */
async function failClosedAfterOperation({
  stateStore,
  adapter,
  sourceId,
  expectedRevision,
  grantId,
  expectedState,
  expectedPermissionStatuses,
  error,
  failureCode,
  failureStage,
  auditType,
  clock
}) {
  const staged = await withSourceStatusStateLock(stateStore, async () => {
    const beforeCleanup = await loadState(stateStore);
    const entry = requireEntry(rootLifecycle(beforeCleanup), sourceId);
    if (!operationStillCurrent(entry, {
      revision: expectedRevision,
      grantId,
      state: expectedState,
      permissionStatuses: expectedPermissionStatuses
    })) {
      return { entry, state: beforeCleanup, committed: false, cleanupRevision: null, failedAt: null, originalCode: null };
    }

    const failedAt = isoNow(clock);
    const originalCode = safeErrorCode(error, failureCode);
    entry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
    entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
    entry.permission.status = "revocation-pending";
    entry.permission.revocationConfirmed = false;
    entry.snapshotImport.status = "failed-safely";
    entry.lastSafeError = {
      code: originalCode,
      stage: failureStage,
      at: failedAt,
      sourceBodiesRead: false
    };
    entry.audit.push({
      type: `${auditType}-cleanup-started`,
      at: failedAt,
      code: originalCode,
      grantId,
      sourceBodiesRead: false
    });
    const cleanupRevision = bumpEntryRevision(entry);
    await stateStore.save(beforeCleanup);
    return { entry, state: beforeCleanup, committed: true, cleanupRevision, failedAt, originalCode };
  });

  if (!staged.committed) {
    // A durable revoke or other safe transition won while the adapter call was
    // in flight. Clean up the adapter best-effort, but never restore stale
    // local state over that newer decision.
    await revokeAdapterPermission(adapter, grantId).catch(() => false);
    return staged;
  }

  const revoked = await revokeAdapterPermission(adapter, grantId).catch(() => false);
  return withSourceStatusStateLock(stateStore, async () => {
    const afterCleanup = await loadState(stateStore);
    const refreshedEntry = requireEntry(rootLifecycle(afterCleanup), sourceId);
    if (!operationStillCurrent(refreshedEntry, {
      revision: staged.cleanupRevision,
      grantId,
      state: SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      permissionStatuses: ["revocation-pending"]
    })) {
      return { entry: refreshedEntry, state: afterCleanup, committed: false };
    }

    refreshedEntry.permission.status = revoked ? "revoked-after-failure" : "revocation-unconfirmed";
    refreshedEntry.permission.registrationOperationId = null;
    refreshedEntry.permission.revokedAt = revoked ? staged.failedAt : null;
    refreshedEntry.permission.revocationConfirmed = revoked;
    refreshedEntry.lastSafeError = revoked
      ? {
        code: staged.originalCode,
        stage: failureStage,
        at: staged.failedAt,
        sourceBodiesRead: false
      }
      : {
        code: "SIMULATED_EXPORT_REVOCATION_UNCONFIRMED",
        causeCode: staged.originalCode,
        stage: `${failureStage}-cleanup`,
        at: staged.failedAt,
        sourceBodiesRead: false
      };
    refreshedEntry.audit.push({
      type: auditType,
      at: staged.failedAt,
      code: staged.originalCode,
      permissionRevocationConfirmed: revoked,
      sourceBodiesRead: false
    });
    bumpEntryRevision(refreshedEntry);
    await stateStore.save(afterCleanup);
    return { entry: refreshedEntry, state: afterCleanup, committed: true };
  });
}

async function settleCompletedGrantRegistrationAfterRevocation({
  stateStore,
  adapter,
  sourceId,
  grantId,
  registrationOperationId,
  clock
}) {
  const staged = await withSourceStatusStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const records = rootLifecycle(state);
    const entry = requireEntry(records, sourceId);
    const sameRegistration = entry?.permission?.grantId === grantId
      && entry?.permission?.registrationOperationId === registrationOperationId;
    const revocationRequested = entry.state === SOURCE_STATUS_STATES.REVOKED
      || (entry.state === SOURCE_STATUS_STATES.NEEDS_ATTENTION && [
        "revocation-pending",
        "revocation-awaiting-registration",
        "revocation-unconfirmed"
      ].includes(entry.permission.status));
    if (!sameRegistration || !revocationRequested) {
      return { tracked: false, entry, state };
    }

    const now = isoNow(clock);
    entry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
    entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
    entry.permission.status = "revocation-pending";
    entry.permission.revocationConfirmed = false;
    entry.lastSafeError = {
      code: "SIMULATED_EXPORT_REGISTRATION_CLEANUP_PENDING",
      stage: "post-registration-revocation",
      at: now,
      sourceBodiesRead: false
    };
    entry.audit.push({
      type: "simulated-export-stale-registration-cleanup-started",
      at: now,
      grantId,
      sourceBodiesRead: false
    });
    const cleanupRevision = bumpEntryRevision(entry);
    await stateStore.save(state);
    return { tracked: true, entry, state, cleanupRevision, now };
  });

  if (!staged.tracked) return staged;
  const revoked = await revokeAdapterPermission(adapter, grantId).catch(() => false);

  return withSourceStatusStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const records = rootLifecycle(state);
    const entry = requireEntry(records, sourceId);
    if (!operationStillCurrent(entry, {
      revision: staged.cleanupRevision,
      grantId,
      state: SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      permissionStatuses: ["revocation-pending"]
    }) || entry.permission.registrationOperationId !== registrationOperationId) {
      return { tracked: false, entry, state };
    }

    entry.permission.registrationOperationId = null;
    if (revoked) {
      entry.permission.status = "revoked";
      entry.permission.revokedAt = staged.now;
      entry.permission.revocationConfirmed = true;
      entry.state = SOURCE_STATUS_STATES.REVOKED;
      entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
      entry.lastSafeError = null;
      entry.audit.push({
        type: "simulated-export-stale-registration-cleanup-confirmed",
        at: staged.now,
        grantId,
        sourceBodiesRead: false
      });
      records.audit.push({
        type: "simulated-export-permission-revoked",
        at: staged.now,
        sourceId,
        reviewId: entry.permission.reviewId,
        grantId,
        sourceBodiesRead: false
      });
    } else {
      entry.permission.status = "revocation-unconfirmed";
      entry.permission.revokedAt = null;
      entry.permission.revocationConfirmed = false;
      entry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
      entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
      entry.lastSafeError = {
        code: "SIMULATED_EXPORT_REVOCATION_UNCONFIRMED",
        stage: "post-registration-revocation",
        at: staged.now,
        sourceBodiesRead: false
      };
      entry.audit.push({
        type: "simulated-export-stale-registration-cleanup-unconfirmed",
        at: staged.now,
        grantId,
        sourceBodiesRead: false
      });
    }
    bumpEntryRevision(entry);
    await stateStore.save(state);
    return { tracked: true, entry, state, revoked };
  });
}

/** Creates a safe default scope that callers must explicitly acknowledge before granting. */
export function buildSimulatedExportPermissionScope({ metadataPreview, selectedItemIds } = {}) {
  const preview = metadataPreview?.items ?? metadataPreview?.metadataPreview?.items;
  const allowed = new Set((Array.isArray(preview) ? preview : []).map((item) => item?.id).filter((id) => typeof id === "string"));
  const selected = Array.isArray(selectedItemIds) ? selectedItemIds.filter((id) => allowed.has(id)) : [];
  return {
    selectedItemIds: [...new Set(selected)],
    acknowledgements: {
      metadataOnlyPreview: false,
      untrustedSourceMaterial: false,
      simulatedSnapshot: false
    }
  };
}

/**
 * Starts (or safely retries) a metadata-only simulated generic-export preview.
 * The adapter is required to return no source body fields; no real connector is
 * accepted by this API.
 */
export async function beginSimulatedExportPreview({
  message,
  stateStore,
  adapter,
  sourceId = "simulated-export",
  language,
  clock,
  reviewIdFactory
} = {}) {
  assertNaturalLanguage(message, "start");
  assertSourceId(sourceId);
  if (!adapter || adapter.isSimulation !== true || typeof adapter.previewMetadata !== "function") {
    throw new TypeError("A simulated generic-export adapter with previewMetadata() is required. Real source adapters are not accepted here.");
  }
  const staged = await withSourceStatusStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const records = rootLifecycle(state);
    const safeLanguage = languageFor(state, language);
    let entry = records.entries[sourceId];
    if (entry?.state === SOURCE_STATUS_STATES.SKIPPED || entry?.state === SOURCE_STATUS_STATES.UNSUPPORTED) {
      return { performPreview: false, entry, state, safeLanguage };
    }
    if (permissionMayRemainActive(entry)) {
      return { performPreview: false, entry, state, safeLanguage };
    }
    if ([
      SOURCE_STATUS_STATES.AWAITING_GRANT,
      SOURCE_STATUS_STATES.READY_TO_IMPORT,
      SOURCE_STATUS_STATES.IMPORTING,
      SOURCE_STATUS_STATES.IMPORTED
    ].includes(entry?.state)) {
      return { performPreview: false, entry, state, safeLanguage };
    }

    const now = isoNow(clock);
    if (!entry || entry.state === SOURCE_STATUS_STATES.REVOKED || entry.state === SOURCE_STATUS_STATES.NEEDS_ATTENTION) {
      const previousAudit = entry?.audit ?? [];
      const previousRevision = entryRevision(entry);
      entry = defaultEntry(sourceId, now);
      entry.revision = previousRevision;
      entry.audit.unshift(...previousAudit, { type: "fresh-simulated-preview-started", at: now, sourceBodiesRead: false });
      records.entries[sourceId] = entry;
    }
    entry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
    entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
    entry.snapshotImport.status = "preview-pending";
    entry.lastSafeError = null;
    entry.audit.push({ type: "metadata-only-simulated-export-preview-started", at: now, sourceBodiesRead: false });
    const previewRevision = bumpEntryRevision(entry);
    await stateStore.save(state);
    return { performPreview: true, previewRevision, now, entry, state, safeLanguage };
  });

  if (!staged.performPreview) return { sourceStatus: publicSourceStatus(staged.entry, staged.safeLanguage) };

  let preview = null;
  let previewError = null;
  try {
    preview = normalizePreview(await adapter.previewMetadata({ sourceId }), sourceId, staged.now, staged.safeLanguage);
  } catch (error) {
    previewError = error;
  }

  const finalized = await withSourceStatusStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const records = rootLifecycle(state);
    const entry = requireEntry(records, sourceId);
    if (!operationStillCurrent(entry, {
      revision: staged.previewRevision,
      grantId: null,
      state: SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      permissionStatuses: ["none"]
    }) || entry.snapshotImport.status !== "preview-pending") {
      return { entry, state };
    }

    if (previewError) {
      entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
      entry.snapshotImport.status = "not-started";
      entry.lastSafeError = { code: safeErrorCode(previewError, "SIMULATED_EXPORT_PREVIEW_FAILED"), stage: "metadata-preview", at: staged.now, sourceBodiesRead: false };
      entry.audit.push({ type: "simulated-export-preview-paused", at: staged.now, code: entry.lastSafeError.code, sourceBodiesRead: false });
      records.audit.push({ type: "simulated-export-preview-paused", at: staged.now, sourceId, sourceBodiesRead: false });
    } else {
      const reviewId = (reviewIdFactory ?? (() => `simulated-export-review-${randomUUID()}`))();
      opaqueId(reviewId, "Simulated export review id");
      entry.metadataPreview = { ...preview, reviewId };
      entry.state = SOURCE_STATUS_STATES.AWAITING_GRANT;
      entry.resumeState = SOURCE_STATUS_STATES.AWAITING_GRANT;
      entry.permission = {
        status: "none",
        reviewId,
        grantId: null,
        registrationOperationId: null,
        selectedItemIds: [],
        grantedAt: null,
        revokedAt: null,
        revocationConfirmed: null
      };
      entry.snapshotImport = { status: "not-started", snapshotLabel: null, importedAt: null, records: [] };
      entry.lastSafeError = null;
      entry.audit.push({ type: "metadata-only-simulated-export-preview", at: staged.now, reviewId, itemCount: preview.itemCount, sourceBodiesRead: false });
      records.audit.push({ type: "metadata-only-simulated-export-preview", at: staged.now, sourceId, sourceBodiesRead: false });
    }
    bumpEntryRevision(entry);
    await stateStore.save(state);
    return { entry, state };
  });
  return { sourceStatus: publicSourceStatus(finalized.entry, languageFor(finalized.state, language)) };
}

/** Saves a granular, one-time simulated-export permission; it never imports. */
export async function grantSimulatedExportPermission({
  message,
  stateStore,
  adapter,
  sourceId = "simulated-export",
  reviewId,
  scope,
  selectedItemIds,
  language,
  clock,
  grantIdFactory
} = {}) {
  assertNaturalLanguage(message, "grant");
  assertSourceId(sourceId);
  if (!adapter || adapter.isSimulation !== true || typeof adapter.registerSnapshotPermission !== "function") {
    throw new TypeError("A simulated generic-export adapter with registerSnapshotPermission() is required.");
  }
  const staged = await withSourceStatusStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const records = rootLifecycle(state);
    const entry = requireEntry(records, sourceId);
    const safeLanguage = languageFor(state, language);
    if (entry.state !== SOURCE_STATUS_STATES.AWAITING_GRANT || !entry.metadataPreview || entry.permission.reviewId !== reviewId) {
      throw new SourceStatusError("STALE_SIMULATED_EXPORT_REVIEW", "That simulated export review is not ready. Start or use the current metadata-only preview before approving anything.");
    }
    if (entry.permission.status === "active") {
      return { alreadyActive: true, entry, state, safeLanguage };
    }
    if (permissionMayRemainActive(entry)) {
      throw new SourceStatusError("REVOCATION_CONFIRMATION_REQUIRED", "I could not confirm that the earlier simulated export permission was revoked. Revoke it explicitly before approving another scope.");
    }
    const normalizedScope = normalizePermissionScope(extractPermissionScope({ scope, selectedItemIds }), entry);
    const now = isoNow(clock);
    const grant = {
      id: (grantIdFactory ?? (() => `simulated-export-grant-${randomUUID()}`))(),
      status: "active",
      sourceId,
      reviewId,
      approvedAt: now,
      scope: normalizedScope
    };
    opaqueId(grant.id, "Simulated export grant id");
    const registrationOperationId = `registration-${randomUUID()}`;

    // Record the durable pending generation before releasing the lock for the
    // adapter. A revoke from a reopened FileStateStore can now replace this
    // exact generation and the post-adapter step will observe that decision.
    entry.permission = {
      status: "grant-pending",
      reviewId,
      grantId: grant.id,
      registrationOperationId,
      selectedItemIds: normalizedScope.selectedItemIds,
      grantedAt: now,
      revokedAt: null,
      revocationConfirmed: false
    };
    entry.lastSafeError = null;
    entry.audit.push({ type: "simulated-export-granular-permission-registration-started", at: now, reviewId, grantId: grant.id, selectedItemCount: normalizedScope.selectedItemIds.length, sourceBodiesRead: false });
    const grantRevision = bumpEntryRevision(entry);
    await stateStore.save(state);
    return { alreadyActive: false, grant, grantRevision, registrationOperationId, state, safeLanguage, entry };
  });

  if (staged.alreadyActive) return { sourceStatus: publicSourceStatus(staged.entry, staged.safeLanguage) };

  inFlightGrantRegistrationOperations.add(staged.registrationOperationId);
  try {
    try {
      await adapter.registerSnapshotPermission({ grant: clone(staged.grant) });
    } catch (error) {
      const failed = await failClosedAfterOperation({
        stateStore,
        adapter,
        sourceId,
        expectedRevision: staged.grantRevision,
        grantId: staged.grant.id,
        expectedState: SOURCE_STATUS_STATES.AWAITING_GRANT,
        expectedPermissionStatuses: ["grant-pending"],
        error,
        failureCode: "SIMULATED_EXPORT_GRANT_FAILED",
        failureStage: "permission-grant",
        auditType: "simulated-export-grant-paused",
        clock
      });
      if (!failed.committed) {
        const settled = await settleCompletedGrantRegistrationAfterRevocation({
          stateStore,
          adapter,
          sourceId,
          grantId: staged.grant.id,
          registrationOperationId: staged.registrationOperationId,
          clock
        });
        return { sourceStatus: publicSourceStatus(settled.entry, languageFor(settled.state, language)) };
      }
      return { sourceStatus: publicSourceStatus(failed.entry, languageFor(failed.state, language)) };
    }

    const finalized = await withSourceStatusStateLock(stateStore, async () => {
      const refreshed = await loadState(stateStore);
      const refreshedRecords = rootLifecycle(refreshed);
      const refreshedEntry = requireEntry(refreshedRecords, sourceId);
      if (!operationStillCurrent(refreshedEntry, {
        revision: staged.grantRevision,
        grantId: staged.grant.id,
        state: SOURCE_STATUS_STATES.AWAITING_GRANT,
        permissionStatuses: ["grant-pending"]
      })) {
        return { stale: true, entry: refreshedEntry, state: refreshed };
      }
      refreshedEntry.permission.status = "active";
      refreshedEntry.permission.registrationOperationId = null;
      refreshedEntry.permission.revocationConfirmed = false;
      refreshedEntry.state = SOURCE_STATUS_STATES.READY_TO_IMPORT;
      refreshedEntry.resumeState = SOURCE_STATUS_STATES.READY_TO_IMPORT;
      refreshedEntry.lastSafeError = null;
      refreshedEntry.audit.push({ type: "simulated-export-granular-permission-granted", at: staged.grant.approvedAt, reviewId, grantId: staged.grant.id, selectedItemCount: staged.grant.scope.selectedItemIds.length, sourceBodiesRead: false });
      refreshedRecords.audit.push({ type: "simulated-export-granular-permission-granted", at: staged.grant.approvedAt, sourceId, reviewId, grantId: staged.grant.id, sourceBodiesRead: false });
      bumpEntryRevision(refreshedEntry);
      await stateStore.save(refreshed);
      return { stale: false, entry: refreshedEntry, state: refreshed };
    });
    if (!finalized.stale) {
      return { sourceStatus: publicSourceStatus(finalized.entry, languageFor(finalized.state, language)) };
    }

    const settled = await settleCompletedGrantRegistrationAfterRevocation({
      stateStore,
      adapter,
      sourceId,
      grantId: staged.grant.id,
      registrationOperationId: staged.registrationOperationId,
      clock
    });
    return { sourceStatus: publicSourceStatus(settled.entry, languageFor(settled.state, language)) };
  } finally {
    inFlightGrantRegistrationOperations.delete(staged.registrationOperationId);
  }
}

/** Imports exactly the approved opaque snapshot references, then closes the one-time permission. */
export async function importSimulatedExportSnapshot({
  message,
  stateStore,
  adapter,
  sourceId = "simulated-export",
  reviewId,
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "import");
  assertSourceId(sourceId);
  if (!adapter || adapter.isSimulation !== true || typeof adapter.importApprovedSnapshot !== "function") {
    throw new TypeError("A simulated generic-export adapter with importApprovedSnapshot() is required.");
  }
  const started = await withSourceStatusStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const records = rootLifecycle(state);
    const entry = requireEntry(records, sourceId);
    const safeLanguage = languageFor(state, language);
    if (entry.state !== SOURCE_STATUS_STATES.READY_TO_IMPORT || entry.permission.status !== "active" || entry.permission.reviewId !== reviewId) {
      throw new SourceStatusError("SIMULATED_EXPORT_GRANT_REQUIRED", "No simulated snapshot was imported because there is no active granular permission for this current review.");
    }
    const now = isoNow(clock);
    const grant = {
      id: entry.permission.grantId,
      status: "active",
      sourceId,
      reviewId,
      scope: { selectedItemIds: clone(entry.permission.selectedItemIds) }
    };
    entry.state = SOURCE_STATUS_STATES.IMPORTING;
    entry.snapshotImport.status = "importing";
    entry.audit.push({ type: "simulated-snapshot-import-started", at: now, reviewId, grantId: grant.id, sourceBodiesRead: false });
    const importRevision = bumpEntryRevision(entry);
    await stateStore.save(state);
    // Keep only the narrow fields needed to validate a later adapter result;
    // never retain an in-memory state object as authority after releasing the
    // lock for the adapter call.
    const validationEntry = {
      sourceId: entry.sourceId,
      permission: { selectedItemIds: clone(entry.permission.selectedItemIds) }
    };
    return { state, entry, safeLanguage, grant, importRevision, validationEntry };
  });
  let normalized;
  try {
    normalized = normalizeSnapshotResult(await adapter.importApprovedSnapshot({ sourceId, grant: clone(started.grant) }), started.validationEntry);
  } catch (error) {
    const failed = await failClosedAfterOperation({
      stateStore,
      adapter,
      sourceId,
      expectedRevision: started.importRevision,
      grantId: started.grant.id,
      expectedState: SOURCE_STATUS_STATES.IMPORTING,
      expectedPermissionStatuses: ["active"],
      error,
      failureCode: "SIMULATED_EXPORT_IMPORT_FAILED",
      failureStage: "snapshot-import",
      auditType: "simulated-snapshot-import-paused",
      clock
    });
    return { sourceStatus: publicSourceStatus(failed.entry, languageFor(failed.state, language)), snapshotRecords: [] };
  }

  const finalization = await withSourceStatusStateLock(stateStore, async () => {
    const beforeFinalization = await loadState(stateStore);
    const beforeFinalizationEntry = requireEntry(rootLifecycle(beforeFinalization), sourceId);
    if (!operationStillCurrent(beforeFinalizationEntry, {
      revision: started.importRevision,
      grantId: started.grant.id,
      state: SOURCE_STATUS_STATES.IMPORTING,
      permissionStatuses: ["active"]
    })) {
      return { stale: true, entry: beforeFinalizationEntry, state: beforeFinalization };
    }

    const finalizationAt = isoNow(clock);
    beforeFinalizationEntry.permission.status = "consuming-revocation-pending";
    beforeFinalizationEntry.permission.revocationConfirmed = false;
    beforeFinalizationEntry.snapshotImport = {
      status: "revocation-pending",
      snapshotLabel: null,
      importedAt: null,
      records: []
    };
    beforeFinalizationEntry.audit.push({ type: "simulated-snapshot-import-finalization-started", at: finalizationAt, grantId: started.grant.id, sourceBodiesRead: false });
    const finalizationRevision = bumpEntryRevision(beforeFinalizationEntry);
    await stateStore.save(beforeFinalization);
    return { stale: false, entry: beforeFinalizationEntry, state: beforeFinalization, finalizationRevision };
  });

  if (finalization.stale) {
    // A revoke persisted while the adapter was importing. Discard the stale
    // result before it reaches state or the caller, then make the adapter
    // grant unusable without taking the state lock.
    await revokeAdapterPermission(adapter, started.grant.id).catch(() => false);
    return {
      sourceStatus: publicSourceStatus(finalization.entry, languageFor(finalization.state, language)),
      snapshotRecords: []
    };
  }

  const revoked = await revokeAdapterPermission(adapter, started.grant.id).catch(() => false);
  const finalized = await withSourceStatusStateLock(stateStore, async () => {
    const afterFinalization = await loadState(stateStore);
    const finalizedEntry = requireEntry(rootLifecycle(afterFinalization), sourceId);
    if (!operationStillCurrent(finalizedEntry, {
      revision: finalization.finalizationRevision,
      grantId: started.grant.id,
      state: SOURCE_STATUS_STATES.IMPORTING,
      permissionStatuses: ["consuming-revocation-pending"]
    })) {
      return { stale: true, entry: finalizedEntry, state: afterFinalization };
    }

    const importedAt = isoNow(clock);
    if (!revoked) {
      // The adapter may still hold the one-time permission. Do not save or
      // return even opaque snapshot references until that closure is confirmed.
      finalizedEntry.snapshotImport = {
        status: "revocation-unconfirmed",
        snapshotLabel: null,
        importedAt: null,
        records: []
      };
      finalizedEntry.permission.status = "revocation-unconfirmed";
      finalizedEntry.permission.revokedAt = null;
      finalizedEntry.permission.revocationConfirmed = false;
      finalizedEntry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
      finalizedEntry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
      finalizedEntry.lastSafeError = { code: "SIMULATED_EXPORT_REVOCATION_UNCONFIRMED", stage: "post-import-revocation", at: importedAt, sourceBodiesRead: false };
      finalizedEntry.audit.push({ type: "simulated-snapshot-import-paused-for-unconfirmed-revocation", at: importedAt, recordCountDiscarded: normalized.records.length, sourceBodiesRead: false });
      bumpEntryRevision(finalizedEntry);
      await stateStore.save(afterFinalization);
      return { stale: false, entry: finalizedEntry, state: afterFinalization, snapshotRecords: [] };
    }

    finalizedEntry.snapshotImport = {
      status: "imported",
      snapshotLabel: normalized.snapshotLabel,
      importedAt,
      records: normalized.records
    };
    finalizedEntry.permission.status = "consumed-and-revoked";
    finalizedEntry.permission.registrationOperationId = null;
    finalizedEntry.permission.revokedAt = importedAt;
    finalizedEntry.permission.revocationConfirmed = true;
    finalizedEntry.state = SOURCE_STATUS_STATES.IMPORTED;
    finalizedEntry.resumeState = SOURCE_STATUS_STATES.IMPORTED;
    finalizedEntry.lastSafeError = null;
    finalizedEntry.audit.push({ type: "simulated-snapshot-imported", at: importedAt, recordCount: normalized.records.length, oneTimePermissionClosed: true, sourceBodiesRead: false });
    bumpEntryRevision(finalizedEntry);
    await stateStore.save(afterFinalization);
    return { stale: false, entry: finalizedEntry, state: afterFinalization, snapshotRecords: normalized.records.map((record) => ({ ...record })) };
  });
  return {
    sourceStatus: publicSourceStatus(finalized.entry, languageFor(finalized.state, language)),
    snapshotRecords: finalized.stale ? [] : finalized.snapshotRecords
  };
}

/** Revokes a saved simulated-export permission. It never writes to a source. */
export async function revokeSimulatedExportPermission({
  message,
  stateStore,
  adapter,
  sourceId = "simulated-export",
  reviewId,
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "revoke");
  assertSourceId(sourceId);
  const staged = await withSourceStatusStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const records = rootLifecycle(state);
    const entry = requireEntry(records, sourceId);
    const safeLanguage = languageFor(state, language);
    if (entry.permission.reviewId !== reviewId) {
      throw new SourceStatusError("STALE_SIMULATED_EXPORT_REVIEW", "That earlier review cannot revoke or change the current source state.");
    }
    if (entry.state === SOURCE_STATUS_STATES.REVOKED) {
      return { adapterCleanupRequired: false, entry, state, safeLanguage };
    }
    if (!permissionMayRemainActive(entry)) {
      const now = isoNow(clock);
      entry.permission.status = "revoked";
      entry.permission.registrationOperationId = null;
      entry.permission.revokedAt = now;
      entry.permission.revocationConfirmed = true;
      entry.state = SOURCE_STATUS_STATES.REVOKED;
      entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
      entry.lastSafeError = null;
      entry.audit.push({ type: "simulated-export-permission-revoked", at: now, reviewId, sourceBodiesRead: false });
      records.audit.push({ type: "simulated-export-permission-revoked", at: now, sourceId, reviewId, sourceBodiesRead: false });
      bumpEntryRevision(entry);
      await stateStore.save(state);
      return { adapterCleanupRequired: false, entry, state, safeLanguage };
    }
    if (!adapter || adapter.isSimulation !== true || typeof adapter.revokeSnapshotPermission !== "function") {
      throw new TypeError("A simulated generic-export adapter with revokeSnapshotPermission() is required to revoke an active or unresolved permission.");
    }

    const now = isoNow(clock);
    const grantId = entry.permission.grantId;
    const registrationOperationId = entry.permission.registrationOperationId ?? null;
    const registrationStillInFlight = typeof registrationOperationId === "string"
      && inFlightGrantRegistrationOperations.has(registrationOperationId);
    entry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
    entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
    entry.permission.status = "revocation-pending";
    entry.permission.revocationConfirmed = false;
    entry.audit.push({ type: "simulated-export-revocation-started", at: now, grantId, sourceBodiesRead: false });
    const revocationRevision = bumpEntryRevision(entry);
    await stateStore.save(state);
    return {
      adapterCleanupRequired: true,
      entry,
      state,
      safeLanguage,
      now,
      grantId,
      registrationOperationId,
      registrationStillInFlight,
      revocationRevision
    };
  });

  if (!staged.adapterCleanupRequired) {
    return { sourceStatus: publicSourceStatus(staged.entry, staged.safeLanguage) };
  }

  const revoked = typeof staged.grantId === "string" && OPAQUE_ID.test(staged.grantId)
    ? await revokeAdapterPermission(adapter, staged.grantId).catch(() => false)
    : false;
  const finalized = await withSourceStatusStateLock(stateStore, async () => {
    const refreshed = await loadState(stateStore);
    const refreshedRecords = rootLifecycle(refreshed);
    const refreshedEntry = requireEntry(refreshedRecords, sourceId);
    if (!operationStillCurrent(refreshedEntry, {
      revision: staged.revocationRevision,
      grantId: staged.grantId,
      state: SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      permissionStatuses: ["revocation-pending"]
    })) {
      return { entry: refreshedEntry, state: refreshed, stale: true };
    }
    if (revoked && staged.registrationStillInFlight) {
      refreshedEntry.permission.status = "revocation-awaiting-registration";
      refreshedEntry.permission.revocationConfirmed = false;
      refreshedEntry.lastSafeError = {
        code: "SIMULATED_EXPORT_REGISTRATION_SETTLEMENT_REQUIRED",
        stage: "permission-revocation",
        at: staged.now,
        sourceBodiesRead: false
      };
      refreshedEntry.audit.push({
        type: "simulated-export-revocation-awaiting-registration-settlement",
        at: staged.now,
        grantId: staged.grantId,
        sourceBodiesRead: false
      });
      bumpEntryRevision(refreshedEntry);
      await stateStore.save(refreshed);
      return { entry: refreshedEntry, state: refreshed, stale: false };
    }
    if (!revoked) {
      refreshedEntry.permission.status = "revocation-unconfirmed";
      refreshedEntry.permission.revocationConfirmed = false;
      refreshedEntry.lastSafeError = { code: "SIMULATED_EXPORT_REVOCATION_UNCONFIRMED", stage: "permission-revocation", at: staged.now, sourceBodiesRead: false };
      refreshedEntry.audit.push({ type: "simulated-export-revocation-unconfirmed", at: staged.now, grantId: staged.grantId, sourceBodiesRead: false });
      bumpEntryRevision(refreshedEntry);
      await stateStore.save(refreshed);
      return { entry: refreshedEntry, state: refreshed, stale: false };
    }

    refreshedEntry.permission.status = "revoked";
    refreshedEntry.permission.registrationOperationId = null;
    refreshedEntry.permission.revokedAt = staged.now;
    refreshedEntry.permission.revocationConfirmed = true;
    refreshedEntry.state = SOURCE_STATUS_STATES.REVOKED;
    refreshedEntry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
    refreshedEntry.lastSafeError = null;
    refreshedEntry.audit.push({ type: "simulated-export-permission-revoked", at: staged.now, reviewId, sourceBodiesRead: false });
    refreshedRecords.audit.push({ type: "simulated-export-permission-revoked", at: staged.now, sourceId, reviewId, sourceBodiesRead: false });
    bumpEntryRevision(refreshedEntry);
    await stateStore.save(refreshed);
    return { entry: refreshedEntry, state: refreshed, stale: false };
  });
  return { sourceStatus: publicSourceStatus(finalized.entry, languageFor(finalized.state, language)) };
}

/**
 * Reconciles a saved importing state after a process interruption. It never
 * resumes an unknown in-flight adapter call: it closes the possible one-time
 * permission first, then requires a fresh metadata-only preview before retry.
 */
export async function recoverInterruptedSimulatedExportImport({
  message,
  stateStore,
  adapter,
  sourceId = "simulated-export",
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "revoke");
  assertSourceId(sourceId);
  const saved = await withSourceStatusStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const entry = requireEntry(rootLifecycle(state), sourceId);
    if (entry.state !== SOURCE_STATUS_STATES.IMPORTING) {
      throw new SourceStatusError("SIMULATED_IMPORT_NOT_INTERRUPTED", "This source is not waiting on an interrupted simulated import, so there is no import permission to reconcile.");
    }
    if (!entry.permission.reviewId) {
      throw new SourceStatusError("SIMULATED_IMPORT_REVIEW_MISSING", "The interrupted import has no safe saved review reference, so I kept it blocked instead of guessing which permission to revoke.");
    }
    return { reviewId: entry.permission.reviewId };
  });
  const revoked = await revokeSimulatedExportPermission({
    message,
    stateStore,
    adapter,
    sourceId,
    reviewId: saved.reviewId,
    language,
    clock
  });
  return {
    ...revoked,
    recovery: {
      interruptedImportReconciled: revoked.sourceStatus.granularPermission.revocationConfirmed === true,
      retryRequiresFreshMetadataPreview: revoked.sourceStatus.state === SOURCE_STATUS_STATES.REVOKED
    }
  };
}

/** Skips an optional source only while it has no active permission. */
async function skipOptionalSourceInternal({
  message,
  stateStore,
  sourceId = "simulated-export",
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "skip");
  assertSourceId(sourceId);
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const safeLanguage = languageFor(state, language);
  const now = isoNow(clock);
  let entry = records.entries[sourceId];
  if (!entry) {
    entry = defaultEntry(sourceId, now);
    records.entries[sourceId] = entry;
  }
  if (permissionMayRemainActive(entry)) {
    throw new SourceStatusError("REVOKE_REQUIRED_BEFORE_SKIP", "This source has an active or unresolved granular permission. Revoke it explicitly before skipping so access is not left enabled.");
  }
  if (entry.state === SOURCE_STATUS_STATES.IMPORTED || entry.state === SOURCE_STATUS_STATES.REVOKED || entry.state === SOURCE_STATUS_STATES.UNSUPPORTED) {
    throw new SourceStatusError("SOURCE_STATE_FINAL", "This source is already in a final state. Start a fresh simulated preview if you want to begin again.");
  }
  if (entry.state !== SOURCE_STATUS_STATES.SKIPPED) {
    entry.resumeState = entry.state === SOURCE_STATUS_STATES.NEEDS_ATTENTION ? SOURCE_STATUS_STATES.NOT_STARTED : entry.state;
    entry.state = SOURCE_STATUS_STATES.SKIPPED;
    entry.audit.push({ type: "optional-source-skipped", at: now, resumeState: entry.resumeState, sourceBodiesRead: false });
    records.audit.push({ type: "optional-source-skipped", at: now, sourceId, sourceBodiesRead: false });
    bumpEntryRevision(entry);
    await stateStore.save(state);
  }
  return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
}

/** Skips only while the shared lifecycle confirms no permission may remain active. */
export async function skipOptionalSource(args = {}) {
  return withSourceStatusStateLock(args?.stateStore, () => skipOptionalSourceInternal(args));
}

/** Restores only the previously saved optional state; it never restores a grant. */
async function resumeOptionalSourceInternal({
  message,
  stateStore,
  sourceId = "simulated-export",
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "resume");
  assertSourceId(sourceId);
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const entry = requireEntry(records, sourceId);
  const safeLanguage = languageFor(state, language);
  if (entry.state !== SOURCE_STATUS_STATES.SKIPPED) {
    throw new SourceStatusError("SOURCE_NOT_SKIPPED", "This source is not currently skipped, so there is no saved optional source state to resume.");
  }
  if (permissionMayRemainActive(entry)) {
    throw new SourceStatusError("REVOCATION_CONFIRMATION_REQUIRED", "This source still has an unresolved permission. Confirm revocation before resuming it.");
  }
  const next = ALL_STATES.has(entry.resumeState) && !FINAL_STATES.has(entry.resumeState)
    ? entry.resumeState
    : SOURCE_STATUS_STATES.NOT_STARTED;
  entry.state = next;
  entry.audit.push({ type: "optional-source-resumed", at: isoNow(clock), restoredState: next, sourceBodiesRead: false });
  records.audit.push({ type: "optional-source-resumed", at: isoNow(clock), sourceId, restoredState: next, sourceBodiesRead: false });
  bumpEntryRevision(entry);
  await stateStore.save(state);
  return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
}

export async function resumeOptionalSource(args = {}) {
  return withSourceStatusStateLock(args?.stateStore, () => resumeOptionalSourceInternal(args));
}

/** Records an honest unsupported state without attempting an adapter connection. */
async function explainUnsupportedSourceInternal({
  message,
  stateStore,
  requestedSource,
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "unsupported");
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const sourceId = unsupportedSourceId(requestedSource);
  const now = isoNow(clock);
  if (!records.entries[sourceId]) {
    records.entries[sourceId] = {
      ...defaultEntry(sourceId, now),
      adapter: "unsupported-safe-explanation",
      state: SOURCE_STATUS_STATES.UNSUPPORTED,
      resumeState: SOURCE_STATUS_STATES.NOT_STARTED,
      audit: [{ type: "unsupported-source-explained-without-connection", at: now, sourceBodiesRead: false, realConnectionAttempted: false }]
    };
    records.audit.push({ type: "unsupported-source-explained-without-connection", at: now, sourceId, sourceBodiesRead: false });
    await stateStore.save(state);
  }
  return { sourceStatus: publicSourceStatus(records.entries[sourceId], languageFor(state, language)) };
}

export async function explainUnsupportedSource(args = {}) {
  return withSourceStatusStateLock(args?.stateStore, () => explainUnsupportedSourceInternal(args));
}

/** Read-only lookup. It never invokes an adapter. */
async function getSourceStatusInternal({ stateStore, sourceId = "simulated-export", language } = {}) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state?.[STATE_KEY]) return null;
  const entry = Object.hasOwn(state[STATE_KEY].entries ?? {}, sourceId)
    ? state[STATE_KEY].entries[sourceId]
    : null;
  return entry ? { sourceStatus: publicSourceStatus(entry, languageFor(state, language)) } : null;
}

export async function getSourceStatus(args = {}) {
  return withSourcePermissionStateReadLock(args?.stateStore, () => getSourceStatusInternal(args));
}

function normalizeAdapterName(adapter) {
  const normalized = typeof adapter === "string" ? adapter.trim().toLowerCase() : "";
  if (["gmail", "gmail-readonly"].includes(normalized)) return SOURCE_ADAPTER_NAMES.GMAIL;
  if (["calendar", "google-calendar", "google-calendar-readonly"].includes(normalized)) return SOURCE_ADAPTER_NAMES.GOOGLE_CALENDAR;
  if (["drive", "google-drive", "google-drive-folder-scope"].includes(normalized)) return SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE;
  if (["imessage", "imessage-beta", "i-message"].includes(normalized)) return SOURCE_ADAPTER_NAMES.IMESSAGE;
  if (["simulated-export", "simulated-generic-export", "generic-export"].includes(normalized)) return SOURCE_ADAPTER_NAMES.GENERIC_EXPORT;
  return "unsupported-safe-explanation";
}

function reportedStatusValue(adapterStatus) {
  const value = typeof adapterStatus === "string"
    ? adapterStatus
    : typeof adapterStatus?.status === "string"
      ? adapterStatus.status
      : null;
  // Status text is adapter-controlled input. Preserve only a compact state
  // token; never reflect an arbitrary provider error or source-derived text.
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function stateForAdapter(adapter, reported) {
  const maps = {
    [SOURCE_ADAPTER_NAMES.GMAIL]: {
      "selected-but-unfinished": SOURCE_STATUS_STATES.NOT_STARTED,
      "awaiting-privacy-review": SOURCE_STATUS_STATES.AWAITING_GRANT,
      "ready-to-verify": SOURCE_STATUS_STATES.READY_TO_IMPORT,
      importing: SOURCE_STATUS_STATES.IMPORTING,
      imported: SOURCE_STATUS_STATES.IMPORTED,
      skipped: SOURCE_STATUS_STATES.SKIPPED,
      revoked: SOURCE_STATUS_STATES.REVOKED,
      unsupported: SOURCE_STATUS_STATES.UNSUPPORTED,
      "needs-attention": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      "authorization-denied": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      "authorization-cancelled": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      // A reported live state alone is intentionally not treated as proof.
      "live-and-verified": SOURCE_STATUS_STATES.NEEDS_ATTENTION
    },
    [SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE]: {
      "awaiting-authorization": SOURCE_STATUS_STATES.NOT_STARTED,
      "awaiting-folder-review": SOURCE_STATUS_STATES.AWAITING_GRANT,
      "ready-to-fetch": SOURCE_STATUS_STATES.READY_TO_IMPORT,
      importing: SOURCE_STATUS_STATES.IMPORTING,
      imported: SOURCE_STATUS_STATES.IMPORTED,
      revoked: SOURCE_STATUS_STATES.REVOKED,
      "authorization-unavailable": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      // A provider denial/cancellation is not the customer's intentional
      // skip. Keep it unfinished and preserve the exact outcome below.
      "authorization-denied": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      "authorization-cancelled": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      "needs-attention": SOURCE_STATUS_STATES.NEEDS_ATTENTION
    },
    [SOURCE_ADAPTER_NAMES.GOOGLE_CALENDAR]: {
      "metadata-retry-required": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      "awaiting-grant": SOURCE_STATUS_STATES.AWAITING_GRANT,
      denied: SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      "grant-retry-required": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      "ready-to-import": SOURCE_STATUS_STATES.READY_TO_IMPORT,
      "fetch-retry-required": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      imported: SOURCE_STATUS_STATES.IMPORTED,
      "imported-partially": SOURCE_STATUS_STATES.IMPORTED,
      empty: SOURCE_STATUS_STATES.IMPORTED,
      "empty-partial": SOURCE_STATUS_STATES.IMPORTED,
      "access-revoked": SOURCE_STATUS_STATES.REVOKED,
      revoked: SOURCE_STATUS_STATES.REVOKED,
      unavailable: SOURCE_STATUS_STATES.NEEDS_ATTENTION
    },
    [SOURCE_ADAPTER_NAMES.IMESSAGE]: {
      "awaiting-macos-permission": SOURCE_STATUS_STATES.NOT_STARTED,
      "snapshot-available": SOURCE_STATUS_STATES.NOT_STARTED,
      "awaiting-content-grant": SOURCE_STATUS_STATES.AWAITING_GRANT,
      "ready-to-process": SOURCE_STATUS_STATES.READY_TO_IMPORT,
      processed: SOURCE_STATUS_STATES.IMPORTED,
      revoked: SOURCE_STATUS_STATES.REVOKED,
      unsupported: SOURCE_STATUS_STATES.UNSUPPORTED,
      "needs-attention": SOURCE_STATUS_STATES.NEEDS_ATTENTION
    },
    [SOURCE_ADAPTER_NAMES.GENERIC_EXPORT]: Object.fromEntries(Object.values(SOURCE_STATUS_STATES).map((state) => [state, state]))
  };
  return maps[adapter]?.[reported] ?? SOURCE_STATUS_STATES.NEEDS_ATTENTION;
}

function isKnownAdapterStatus(adapter, reported) {
  const known = {
    [SOURCE_ADAPTER_NAMES.GMAIL]: ["selected-but-unfinished", "awaiting-privacy-review", "ready-to-verify", "importing", "imported", "skipped", "revoked", "unsupported", "needs-attention", "live-and-verified", "authorization-denied", "authorization-cancelled"],
    [SOURCE_ADAPTER_NAMES.GOOGLE_CALENDAR]: ["metadata-retry-required", "awaiting-grant", "denied", "grant-retry-required", "ready-to-import", "fetch-retry-required", "imported", "imported-partially", "empty", "empty-partial", "access-revoked", "revoked", "unavailable"],
    [SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE]: ["awaiting-authorization", "awaiting-folder-review", "ready-to-fetch", "importing", "imported", "revoked", "authorization-unavailable", "authorization-denied", "authorization-cancelled", "needs-attention"],
    [SOURCE_ADAPTER_NAMES.IMESSAGE]: ["awaiting-macos-permission", "snapshot-available", "awaiting-content-grant", "ready-to-process", "processed", "revoked", "unsupported", "needs-attention"],
    [SOURCE_ADAPTER_NAMES.GENERIC_EXPORT]: Object.values(SOURCE_STATUS_STATES)
  };
  return known[adapter]?.includes(reported) ?? false;
}

/**
 * Normalizes an already-returned adapter status into the shared vocabulary.
 * This helper is deliberately pure: it does not invoke an adapter or trust a
 * claimed `live: true` field as independent verification.
 */
export function normalizeAdapterSourceStatus({ sourceId, adapter, adapterStatus, language = "en" } = {}) {
  const normalizedAdapter = normalizeAdapterName(adapter);
  const candidate = reportedStatusValue(adapterStatus);
  // Treat unknown provider status text as an opaque failure, not displayable
  // metadata. This avoids reflecting hostile or source-derived text.
  const reported = isKnownAdapterStatus(normalizedAdapter, candidate) ? candidate : null;
  const safeSourceId = typeof sourceId === "string" && /^[a-z][a-z0-9._:-]{0,127}$/i.test(sourceId)
    ? sourceId
    : "adapter-status";
  const state = normalizedAdapter === "unsupported-safe-explanation"
    ? SOURCE_STATUS_STATES.UNSUPPORTED
    : stateForAdapter(normalizedAdapter, reported);
  const entry = {
    ...defaultEntry(safeSourceId, "1970-01-01T00:00:00.000Z"),
    adapter: normalizedAdapter,
    state,
    resumeState: state,
    audit: [{ type: "adapter-status-normalized-without-connection", at: "1970-01-01T00:00:00.000Z", reportedState: reported, sourceBodiesRead: false }]
  };
  return publicSourceStatus(entry, language === "es" ? "es" : "en", { adapterReportedState: reported, external: true });
}

function persistedSourceInstanceId(adapter, accountId) {
  const prefix = {
    [SOURCE_ADAPTER_NAMES.GMAIL]: "gmail",
    [SOURCE_ADAPTER_NAMES.GOOGLE_CALENDAR]: "calendar",
    [SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE]: "drive",
    [SOURCE_ADAPTER_NAMES.IMESSAGE]: "imessage"
  }[adapter] ?? "adapter";
  return typeof accountId === "string" && OPAQUE_ID.test(accountId)
    ? `${prefix}:${accountId}`
    : prefix;
}

function persistedGmailAccountAlias(entry) {
  const rawAccountId = typeof entry?.accountId === "string" ? entry.accountId : null;
  const persisted = entry?.publicAliases?.account;
  if (typeof persisted === "string" && OPAQUE_ID.test(persisted) && persisted !== rawAccountId) return persisted;
  for (let index = 1; index <= 9; index += 1) {
    const candidate = `local-gmail-account-${index}`;
    if (candidate !== rawAccountId) return candidate;
  }
  return "local-gmail-account";
}

const PERSISTED_ALIAS_LIFECYCLES = Object.freeze([
  // Calendar's public aliases intentionally use the short `calendar`
  // namespace, but its real permission/lifecycle key is `google-calendar`.
  // Its reviewed event metadata also predates the generic export shape.
  {
    adapter: SOURCE_ADAPTER_NAMES.GOOGLE_CALENDAR,
    stateKey: "googleCalendarLifecycle",
    namespace: "calendar",
    permissionSource: "google-calendar",
    approvedRecordsKey: "reviewedRecordsById"
  },
  {
    adapter: SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE,
    stateKey: "googleDriveLifecycle",
    namespace: "drive",
    permissionSource: "drive",
    approvedRecordsKey: "normalizedMetadataById",
    sanitizeEntryFailureReasons: sanitizePersistedDriveFailureReasons
  },
  {
    adapter: SOURCE_ADAPTER_NAMES.IMESSAGE,
    stateKey: "imessageBetaLifecycle",
    namespace: "imessage",
    permissionSource: "imessage",
    approvedRecordsKey: "normalizedMetadataById",
    sanitizeEntryFailureReasons: sanitizePersistedIMessageEntryFailureReasons,
    sanitizeRootFailureReasons: sanitizePersistedIMessageRootFailureReasons
  }
]);

/**
 * Prepares durable local aliases and normalizes recognized legacy failure
 * events on an already-loaded shared root. The caller owns the root write lock
 * and must save the same root when this returns true. This is exported for
 * additive specialized-connector integration; it does not load or save state
 * and never invokes a source adapter.
 */
export function migratePersistedAdapterAliasesInState(state) {
  let changed = false;
  for (const {
    adapter,
    stateKey,
    namespace,
    permissionSource,
    approvedRecordsKey,
    sanitizeEntryFailureReasons,
    sanitizeRootFailureReasons
  } of PERSISTED_ALIAS_LIFECYCLES) {
    for (const entry of Object.values(state?.[stateKey]?.entries ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      try {
        changed = (sanitizeEntryFailureReasons?.(entry) ?? false) || changed;
      } catch {
        // Recognized failure fields are sanitized independently from alias
        // migration. A malformed failure record remains private and omitted.
      }
      if (typeof entry.accountId !== "string" || !entry.accountId) continue;
      try {
        const permission = getSourcePermissionStatusFromState({
          state,
          source: permissionSource,
          accountId: entry.accountId
        });
        const aliasesChanged = migrateStableLocalAliases(entry, namespace, {
          permissionReview: permission?.permissionReview,
          approvedRecords: Object.values(entry[approvedRecordsKey] ?? {})
        });
        changed = aliasesChanged || changed;
      } catch {
        // A malformed legacy entry is omitted from public handoff below. It
        // must never be repaired by guessing or by projecting its raw ID.
      }
    }
    try {
      changed = (sanitizeRootFailureReasons?.(state) ?? false) || changed;
    } catch {
      // A malformed lifecycle audit remains private and is not repaired by
      // inference. Public handoff continues to omit malformed entries.
    }
  }
  return changed;
}

function authorizationOutcomeFor(adapter, reported) {
  if (["authorization-denied", "authorization-cancelled"].includes(reported)) return reported;
  if (adapter === SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE && reported === "authorization-unavailable") return reported;
  return null;
}

/**
 * This simulated/local candidate cannot establish an official-host Gmail
 * verification. A future registered host-provider integration must publish
 * trusted evidence from outside this public API; persisted shapes and injected
 * plugin fields are never sufficient here.
 */
function trustedPersistedGmailLiveVerification() {
  return null;
}

function persistedAdapterSourceStatus({ sourceId, adapter, adapterStatus, language, trustedLiveVerification = null }) {
  const candidate = reportedStatusValue(adapterStatus);
  const reported = isKnownAdapterStatus(adapter, candidate) ? candidate : null;
  const state = trustedLiveVerification
    ? trustedLiveVerification.processingComplete ? SOURCE_STATUS_STATES.IMPORTED : SOURCE_STATUS_STATES.IMPORTING
    : stateForAdapter(adapter, reported);
  const entry = {
    ...defaultEntry(sourceId, "1970-01-01T00:00:00.000Z"),
    adapter,
    state,
    resumeState: state,
    audit: [{
      type: "persisted-adapter-lifecycle-normalized",
      at: "1970-01-01T00:00:00.000Z",
      reportedState: reported,
      sourceBodiesRead: false
    }]
  };
  const authorizationOutcome = authorizationOutcomeFor(adapter, reported);
  const result = publicSourceStatus(entry, language, {
    adapterReportedState: trustedLiveVerification ? null : reported,
    statusOrigin: trustedLiveVerification ? "trusted-persisted-gmail-lifecycle" : "persisted-local-lifecycle",
    authorizationOutcome,
    trustedLiveVerification
  });
  result.source.kind = "persisted-adapter-lifecycle";
  result.source.label = adapter === SOURCE_ADAPTER_NAMES.GMAIL
    ? "Gmail source status"
    : adapter === SOURCE_ADAPTER_NAMES.GOOGLE_CALENDAR
      ? "Google Calendar source status"
    : adapter === SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE
      ? "Google Drive source status"
      : "iMessage beta source status";
  if (trustedLiveVerification) {
    result.message = language === "es"
      ? "Gmail confirmó una lectura real y de solo lectura dentro del alcance aprobado. La conexión se muestra como en vivo y verificada."
      : "Gmail confirmed a real, read-only read within the approved scope. The connection is shown as live and verified.";
    result.snapshotImport = {
      status: trustedLiveVerification.processingComplete ? "verified-read-only-lifecycle" : "verified-read-only-checkpoint",
      snapshotLabel: null,
      simulated: false,
      importedAt: trustedLiveVerification.processingComplete ? trustedLiveVerification.verifiedAt : null,
      recordCount: 0,
      records: []
    };
    result.liveVerification = clone(trustedLiveVerification);
  }
  if (authorizationOutcome) {
    const isEs = language === "es";
    result.nextAction = {
      kind: "retry-or-leave-source-unfinished",
      instruction: isEs
        ? "La autorización no se completó. Esta fuente sigue sin terminar, no está omitida; puedes reintentarla cuando quieras."
        : "Authorization did not complete. This source remains unfinished, not skipped; you can retry it whenever you are ready."
    };
  }
  return result;
}

function persistedAdapterStatuses(state, language) {
  const statuses = [];
  const gmailEntry = state?.gmailReadOnlyLifecycle?.entry;
  if (gmailEntry && typeof gmailEntry === "object") {
    // A later explicit customer decision is authoritative. A stale plugin
    // cancellation remains useful only while Gmail is otherwise unfinished.
    const reported = ["skipped", "revoked", "unsupported"].includes(gmailEntry.status)
      ? gmailEntry.status
      : gmailEntry.plugin?.status === "cancelled"
        ? "authorization-cancelled"
        : gmailEntry.status;
    statuses.push(persistedAdapterSourceStatus({
      sourceId: persistedSourceInstanceId(SOURCE_ADAPTER_NAMES.GMAIL, persistedGmailAccountAlias(gmailEntry)),
      adapter: SOURCE_ADAPTER_NAMES.GMAIL,
      adapterStatus: reported,
      trustedLiveVerification: trustedPersistedGmailLiveVerification(),
      language
    }));
  }

  for (const descriptor of PERSISTED_ALIAS_LIFECYCLES) {
    const lifecycleEntries = Object.values(state?.[descriptor.stateKey]?.entries ?? {});
    for (const { entry, accountAlias } of validStableLocalAliasLifecycleEntries(
      lifecycleEntries,
      descriptor.namespace
    )) {
      statuses.push(persistedAdapterSourceStatus({
        sourceId: persistedSourceInstanceId(
          descriptor.adapter,
          accountAlias
        ),
        adapter: descriptor.adapter,
        adapterStatus: entry.status,
        language
      }));
    }
  }
  return statuses;
}

/**
 * A pure shared-status projection for the existing connector status APIs. It
 * reads their already persisted lifecycle entries and never calls an adapter,
 * accepts a caller-supplied status, or creates a live-connection claim.
 */
export function getPersistedAdapterSourceStatus({ state, adapter, accountId, language = "en" } = {}) {
  const normalizedAdapter = normalizeAdapterName(adapter);
  if (![SOURCE_ADAPTER_NAMES.GMAIL, SOURCE_ADAPTER_NAMES.GOOGLE_CALENDAR, SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE, SOURCE_ADAPTER_NAMES.IMESSAGE].includes(normalizedAdapter)) {
    return null;
  }
  const descriptor = PERSISTED_ALIAS_LIFECYCLES.find((candidate) => candidate.adapter === normalizedAdapter);
  let publicAccountContext = accountId;
  if (descriptor) {
    const entries = Object.values(state?.[descriptor.stateKey]?.entries ?? {})
      .filter((entry) => entry && typeof entry === "object");
    const matches = validStableLocalAliasLifecycleEntries(entries, descriptor.namespace)
      .filter(({ entry, accountAlias }) => entry.accountId === accountId || accountAlias === accountId);
    publicAccountContext = matches.length === 1 ? matches[0].accountAlias : null;
  }
  if (typeof publicAccountContext !== "string" || !publicAccountContext) return null;
  const expectedId = persistedSourceInstanceId(normalizedAdapter, publicAccountContext);
  return persistedAdapterStatuses(state, language === "es" ? "es" : "en")
    .find((status) => status.source.adapter === normalizedAdapter && status.source.id === expectedId) ?? null;
}

function persistedGenericSourceStatuses(state, language) {
  const entries = Object.values(state?.[STATE_KEY]?.entries ?? {});
  return entries.flatMap((entry) => {
    try {
      if (!entry || typeof entry !== "object" || typeof entry.sourceId !== "string" || !OPAQUE_ID.test(entry.sourceId)) return [];
      return [publicSourceStatus(entry, language)];
    } catch {
      // Do not let a malformed local record turn into an inferred source
      // status or expose its contents in a final handoff.
      return [];
    }
  });
}

function releaseGate(language, adapterStatuses) {
  const verifiedLiveConnectors = (Array.isArray(adapterStatuses) ? adapterStatuses : [])
    .filter((status) => (
      status?.connection?.live === true
      && status?.connection?.independentlyVerified === true
      && status?.connection?.readOnly === true
      && status?.liveVerification?.verificationMethod === "persisted-official-read-only-readback"
    ))
    .map((status) => ({
      connectorId: status.liveVerification.connectorId,
      source: status.liveVerification.source,
      accountContext: status.liveVerification.accountContext,
      readOnly: true,
      independentlyVerified: true,
      verificationMethod: status.liveVerification.verificationMethod,
      verifiedAt: status.liveVerification.verifiedAt
    }));
  const satisfied = verifiedLiveConnectors.length > 0;
  return {
    ...LIVE_CONNECTOR_RELEASE_GATE,
    status: satisfied ? "satisfied" : "unsatisfied",
    satisfied,
    verifiedLiveConnectors,
    message: satisfied ? wording(language).releaseGateSatisfied : wording(language).releaseGateUnsatisfied,
    note: satisfied
      ? "A future registered host-provider integration supplied separately reviewed trusted evidence."
      : "QWA-149 has no registered live connector integration. Caller-supplied evidence, injected plugin fields, persisted lifecycle shapes, and adapter status text are ignored; a separately reviewed host-provider lifecycle must satisfy this gate."
  };
}

/**
 * Final customer handoff: cleanly separates unfinished, skipped, imported,
 * revoked, and unsupported sources from local persisted state only. It never
 * invokes adapters and deliberately ignores caller-supplied adapter snapshots
 * or claimed live evidence.
 */
async function getSourceStatusHandoffInternal({ stateStore, language } = {}) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (migratePersistedAdapterAliasesInState(state)) await stateStore.save(state);
  const safeLanguage = languageFor(state, language);
  const entries = persistedGenericSourceStatuses(state, safeLanguage);
  const adapters = persistedAdapterStatuses(state, safeLanguage);
  const candidatesBySourceId = new Map();
  for (const item of [...entries, ...adapters]) {
    const participants = candidatesBySourceId.get(item.source.id) ?? [];
    participants.push(item);
    candidatesBySourceId.set(item.source.id, participants);
  }
  const sources = [...candidatesBySourceId.values()]
    .filter((participants) => participants.length === 1)
    .map(([item]) => item)
    .sort((a, b) => a.source.id.localeCompare(b.source.id));
  const sections = Object.fromEntries(Object.values(SOURCE_HANDOFF_CATEGORIES).map((category) => [category, []]));
  for (const source of sources) sections[source.handoffCategory].push(source);
  return {
    sourceStatusHandoff: {
      vocabulary: {
        states: Object.values(SOURCE_STATUS_STATES),
        finalCategories: Object.values(SOURCE_HANDOFF_CATEGORIES),
        explanation: "A source is never presented as live merely because an adapter reports a connection-like state. Final handoff entries are derived from persisted local lifecycle state only."
      },
      releaseGate: releaseGate(safeLanguage, adapters),
      sections,
      sources
    }
  };
}

export async function getSourceStatusHandoff(args = {}) {
  return withSourcePermissionStateLock(args?.stateStore, () => getSourceStatusHandoffInternal(args));
}
