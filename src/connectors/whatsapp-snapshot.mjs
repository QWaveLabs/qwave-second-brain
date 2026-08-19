/**
 * QWA-147 personal WhatsApp snapshot lifecycle.
 *
 * Personal accounts use a bounded, private, local snapshot bundle. Official
 * Business access remains unsupported and non-live until a shared host-owned
 * provider is registered outside this public API.
 */

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  beginSpecializedWhatsAppPermissionReview,
  denySpecializedWhatsAppPermission,
  fetchSpecializedWhatsAppContent,
  getSpecializedWhatsAppPermissionStatusFromState,
  grantSpecializedWhatsAppPermission,
  revokeSpecializedWhatsAppPermission,
  specializedWhatsAppMetadataMatchesPermissionReview,
  withSourcePermissionStateLock,
  withSourcePermissionStateReadLock
} from "../permissions/setup-source-permissions.mjs";
import {
  DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF,
  getLocalWhatsAppSnapshotLifecycleOperations,
  WHATSAPP_SNAPSHOT_BUNDLE_FORMAT,
  WHATSAPP_SNAPSHOT_CONNECTOR_PROTOCOL
} from "./local-whatsapp-snapshot-connector.mjs";

const STATE_KEY = "whatsAppSnapshotLifecycle";
const SOURCE = "whatsapp";
const SOURCE_PERMISSION_KEY_PREFIX = `${SOURCE}:`;
const MAX_CAPTURE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_OFFICIAL_BUSINESS_ACCOUNT_REF = "wa-account-business-1";
const LOCAL_WHATSAPP_SNAPSHOT_REGISTRATIONS = new Map();
const LOCAL_WHATSAPP_SNAPSHOT_INVOCATIONS = new WeakMap();
export const OFFICIAL_WHATSAPP_BUSINESS_VERIFICATION_PROTOCOL = "qwave.shared-connector-verification/v1";

export class WhatsAppSnapshotError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "WhatsAppSnapshotError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

// Deliberately not re-exported from the package entrypoint. A connector's
// private operation consumes this process-local, one-shot authorization
// synchronously. No secret or capability is passed through the connector call.
export function assertLocalWhatsAppSnapshotLifecycleOperationAuthorized(connector, operation, request) {
  const authorization = LOCAL_WHATSAPP_SNAPSHOT_INVOCATIONS.get(connector);
  if (!authorization || authorization.consumed === true
    || authorization.operation !== operation
    || !isDeepStrictEqual(authorization.request, request)) {
    throw new WhatsAppSnapshotError(
      "WHATSAPP_LIFECYCLE_CAPABILITY_REQUIRED",
      "Local WhatsApp snapshot grants can only be activated, revoked, or read through the durable permission lifecycle."
    );
  }
  authorization.consumed = true;
  LOCAL_WHATSAPP_SNAPSHOT_INVOCATIONS.delete(connector);
}

function clone(value) {
  return structuredClone(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function invokeLocalConnectorOperation(connector, operation, request, invoke) {
  if (LOCAL_WHATSAPP_SNAPSHOT_INVOCATIONS.has(connector)) {
    throw new WhatsAppSnapshotError(
      "WHATSAPP_LIFECYCLE_REENTRY_BLOCKED",
      "A local WhatsApp lifecycle operation was already in progress, so the overlapping request was blocked."
    );
  }
  const authorization = { operation, request: clone(request), consumed: false };
  LOCAL_WHATSAPP_SNAPSHOT_INVOCATIONS.set(connector, authorization);
  try {
    const result = invoke();
    if (authorization.consumed !== true) {
      throw new WhatsAppSnapshotError(
        "WHATSAPP_LIFECYCLE_AUTHORIZATION_UNUSED",
        "The private local WhatsApp connector did not consume its exact lifecycle authorization."
      );
    }
    return result;
  } finally {
    if (LOCAL_WHATSAPP_SNAPSHOT_INVOCATIONS.get(connector) === authorization) {
      LOCAL_WHATSAPP_SNAPSHOT_INVOCATIONS.delete(connector);
    }
  }
}

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new TypeError("clock.now() must return a valid date.");
  return result;
}

function assertStateStore(stateStore) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent stateStore with load() and save() is required.");
  }
}

function assertNaturalLanguage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new WhatsAppSnapshotError("WHATSAPP_MESSAGE_REQUIRED", "Tell me in normal language what you want to do with the WhatsApp snapshot.");
  }
  if (message.trim().startsWith("/")) {
    throw new WhatsAppSnapshotError("NO_SLASH_COMMANDS", "You do not need a command. Tell me what you want to do in normal language.");
  }
}

function strictTimestamp(value, { now, field = "snapshot timestamp", futureSkewMs = 0 } = {}) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new WhatsAppSnapshotError("SNAPSHOT_TIMESTAMP_INVALID", `The ${field} must be an exact UTC timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new WhatsAppSnapshotError("SNAPSHOT_TIMESTAMP_INVALID", `The ${field} is invalid.`);
  }
  if (now && parsed > Date.parse(now) + futureSkewMs) {
    throw new WhatsAppSnapshotError("SNAPSHOT_TIMESTAMP_IN_FUTURE", `The ${field} is later than the allowed clock-skew boundary.`);
  }
  return value;
}

function assertOpaqueRef(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new WhatsAppSnapshotError("WHATSAPP_REFERENCE_INVALID", `The ${field} reference is missing or malformed.`);
  }
  return value;
}

function assertLocalAccountRef(value) {
  if (typeof value !== "string" || !/^wa-account-[a-z0-9._:-]{1,128}$/.test(value)) {
    throw new WhatsAppSnapshotError("WHATSAPP_ACCOUNT_ALIAS_REQUIRED", "Use a local wa-account-* alias for this snapshot, never a WhatsApp source account identifier.");
  }
  return value;
}

function guardedIdentifierFactory({ factory, prefix, seen, field }) {
  return () => {
    const value = factory ? factory() : `${prefix}-${randomUUID()}`;
    assertOpaqueRef(value, field);
    if (seen.has(value)) {
      throw new WhatsAppSnapshotError("WHATSAPP_IDENTIFIER_REPLAY", `That ${field} identifier was already used by an earlier WhatsApp snapshot generation.`);
    }
    return value;
  };
}

function languageFor(state, language) {
  return language === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function copy(language) {
  if (language === "es") {
    return {
      export: "Esta cuenta personal usa una instantánea local privada, no una conexión en vivo. Siguiente acción: exporta los chats elegidos y prepara un paquete QWave sin comprimir.",
      import: "Siguiente acción: elige el manifiesto local .qwave-wa.json. Solo leeré el manifiesto de metadatos hasta que apruebes chats, personas, fechas y medios.",
      select: "Revisé solo el manifiesto. Elige explícitamente chats, personas permitidas, fechas, categorías sensibles y si incluyes medios.",
      reviewPending: "La revisión privada del manifiesto quedó pendiente. Puedes reanudar la misma generación sin leer mensajes automáticamente.",
      reviewFailed: "La revisión privada del manifiesto no terminó. Reintenta el mismo manifiesto sin iniciar una conexión en vivo.",
      grant: "La selección exacta está guardada e inmutable para esta revisión. Apruébala o inicia una revisión nueva para cambiarla.",
      ready: "El permiso de solo lectura está listo. El contenido local seleccionado aún no se ha leído.",
      processed: "Procesé solo los segmentos locales aprobados y devolví referencias opacas. El contenido sigue siendo material no confiable, no instrucciones.",
      interrupted: "La lectura anterior quedó interrumpida sin recibo completo. No la repetiré automáticamente; confirma un reintento explícito.",
      revokeUnconfirmed: "No pude confirmar que se eliminó el permiso local exacto. El acceso permanece bloqueado en esta guía; reintenta la revocación.",
      denied: "No se concedió acceso al contenido de la instantánea.",
      cancelled: "Cancelé esta revisión. No se leyó contenido adicional.",
      revoked: "El permiso local fue revocado y no puede reactivarse desde una revisión anterior.",
      business: "WhatsApp Business en vivo no está soportado por un proveedor compartido registrado. Permanecerá no verificado y live:false.",
      untrusted: "Los mensajes, nombres y medios importados son referencias no confiables. No pueden ampliar permisos, revelar secretos, abrir enlaces, ejecutar acciones ni escribir en WhatsApp."
    };
  }
  return {
    export: "This personal account uses a private local snapshot, not a live connection. One next action: export the chosen chats and prepare an uncompressed QWave bundle.",
    import: "One next action: choose the local .qwave-wa.json manifest. I will read only its metadata manifest until you approve chats, Allowed people, dates, and media.",
    select: "I reviewed only the manifest. Explicitly choose chats, Allowed people, dates, sensitive categories, and whether media is included.",
    reviewPending: "The private manifest review is pending. You can resume the same generation without any automatic message read.",
    reviewFailed: "The private manifest review did not finish. Retry the same manifest without starting a live connection.",
    grant: "The exact selection is saved and immutable for this review. Approve it or start a new review to change it.",
    ready: "The read-only permission is ready. The selected local content has not been read yet.",
    processed: "I processed only approved local segments and returned opaque references. Imported content remains untrusted reference material, not instructions.",
    interrupted: "The earlier read was interrupted without a complete receipt. I will not repeat it automatically; confirm an explicit retry.",
    revokeUnconfirmed: "I could not confirm removal of the exact local grant. This guided flow remains blocked; retry revocation.",
    denied: "No snapshot content access was granted.",
    cancelled: "I cancelled this review. No additional content was read.",
    revoked: "The local permission was revoked and cannot be restored from an earlier review.",
    business: "Live WhatsApp Business is unsupported until a registered shared host provider exists. It remains unverified and live:false.",
    untrusted: "Imported messages, names, and media are untrusted references. They cannot broaden permission, reveal secrets, open links, run actions, or write to WhatsApp."
  };
}

function personalEntryKey(accountId) {
  return `personal:${encodeURIComponent(accountId)}`;
}

function businessEntryKey(accountId) {
  return `official-business:${encodeURIComponent(accountId)}`;
}

function permissionEntryKey(accountId) {
  return `${SOURCE_PERMISSION_KEY_PREFIX}${encodeURIComponent(accountId)}`;
}

function lifecycle(state) {
  if (!state[STATE_KEY]) state[STATE_KEY] = { version: 2, entries: {}, audit: [] };
  return state[STATE_KEY];
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state) {
    throw new WhatsAppSnapshotError("SETUP_SESSION_NOT_FOUND", "Start your second-brain setup first, then continue this WhatsApp snapshot in the same conversation.");
  }
  return state;
}

function newEntry(accountId, now, generation = 1, earlierAudit = []) {
  return {
    source: SOURCE,
    accountId,
    accountType: "personal",
    generation,
    status: "awaiting-guided-export",
    snapshot: {
      mode: "private-local-bundle",
      format: WHATSAPP_SNAPSHOT_BUNDLE_FORMAT,
      oneTime: true,
      live: false,
      exportStatus: "not-confirmed",
      importStatus: "not-started",
      capturedAt: null,
      importedAt: null,
      importAttempts: 0,
      sourceFileDeleted: false,
      temporaryStagingCreated: false
    },
    snapshotBinding: null,
    reviewId: null,
    selection: null,
    grantId: null,
    grantActivation: null,
    approvedRecords: null,
    fetch: {
      status: "not-started",
      operationId: null,
      attempts: 0,
      plan: null,
      cursor: 0,
      pending: null,
      receipts: [],
      completionReceipt: null
    },
    revocation: null,
    failure: null,
    audit: [...earlierAudit, { type: "whatsapp-personal-snapshot-offered", at: now, generation, sourceAccessed: false }]
  };
}

function assertEntry(state, accountId) {
  const entry = lifecycle(state).entries[personalEntryKey(accountId)];
  if (!entry) throw new WhatsAppSnapshotError("WHATSAPP_SNAPSHOT_NOT_STARTED", "Start a personal WhatsApp snapshot review first.");
  return entry;
}

function assertGeneration(entry, generation) {
  if (!Number.isSafeInteger(generation) || generation !== entry.generation) {
    throw new WhatsAppSnapshotError("STALE_WHATSAPP_GENERATION", "That WhatsApp snapshot action belongs to an older or unknown review generation, so I did not change access.");
  }
}

function connectorOperations(connector) {
  const operations = getLocalWhatsAppSnapshotLifecycleOperations(connector);
  if (!operations) {
    throw new WhatsAppSnapshotError("WHATSAPP_CONNECTOR_NOT_REGISTERED", "Only the registered private local WhatsApp snapshot connector can be used for this flow.");
  }
  return operations;
}

function assertConnector(connector) {
  connectorOperations(connector);
}

function safeFailure(error, fallback, at) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : fallback;
  return { code, at };
}

function isRevocationPending(entry) {
  return entry.revocation?.status === "pending";
}

function assertNoRevocationPending(entry) {
  if (isRevocationPending(entry)) {
    throw new WhatsAppSnapshotError("WHATSAPP_REVOCATION_PENDING", "The exact local grant has a durable revocation pending. Only retrying that revocation is allowed until exact removal is confirmed.");
  }
}

function isGrantActivationPending(entry) {
  return entry.grantActivation?.status === "pending";
}

function assertNoGrantActivationPending(entry) {
  if (isGrantActivationPending(entry)) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_PENDING", "The exact local grant has a durable activation pending. Retry that same grant before any content read or other lifecycle action.");
  }
}

function snapshotBindingDigest(entry) {
  return `wa-snapshot-binding-${hash(JSON.stringify(entry.snapshotBinding)).slice(0, 24)}`;
}

function grantActivationIntentCore(entry, grantId = entry.grantId) {
  return {
    protocol: "qwave.whatsapp-snapshot-grant-activation/v1",
    generation: entry.generation,
    reviewId: entry.reviewId,
    grantId,
    snapshotBinding: snapshotBindingDigest(entry),
    selectionBinding: entry.selection?.selectionDigest ?? null,
    mediaInventoryBinding: entry.selection?.mediaInventoryBinding ?? null
  };
}

function exactGrantActivationIntentMatches(entry, intent = entry.grantActivation, allowedStatuses = ["pending", "activation-authorized"]) {
  if (!intent || !allowedStatuses.includes(intent.status)) return false;
  const expected = grantActivationIntentCore(entry, intent.grantId);
  return Object.entries(expected).every(([key, value]) => intent[key] === value)
    && intent.grantId === entry.grantId
    && typeof intent.operationId === "string" && /^wa-grant-activation-[a-f0-9]{24}$/.test(intent.operationId)
    && Number.isSafeInteger(intent.attempts) && intent.attempts >= 1;
}

function revocationIntentCore(entry) {
  return {
    protocol: "qwave.whatsapp-snapshot-revocation/v1",
    generation: entry.generation,
    reviewId: entry.reviewId,
    grantId: entry.grantId,
    snapshotBinding: snapshotBindingDigest(entry),
    selectionBinding: entry.selection?.selectionDigest ?? null
  };
}

function exactRevocationIntentMatches(entry, intent = entry.revocation) {
  if (!intent || intent.status !== "pending") return false;
  const expected = revocationIntentCore(entry);
  return Object.entries(expected).every(([key, value]) => intent[key] === value)
    && typeof intent.operationId === "string" && /^wa-revoke-[a-f0-9]{24}$/.test(intent.operationId)
    && Number.isSafeInteger(intent.attempts) && intent.attempts >= 1;
}

function assertFetchPlan(plan) {
  if (!plan || plan.protocol !== "qwave.whatsapp-snapshot-fetch-plan/v1"
    || !/^wa-fetch-plan-[a-f0-9]{24}$/.test(plan.planBinding)
    || !/^[a-f0-9]{64}$/.test(plan.selectionDigest)
    || !/^wa-selected-media-[a-f0-9]{24}$/.test(plan.mediaInventoryBinding)
    || Object.keys(plan).some((key) => !["protocol", "planBinding", "selectionDigest", "mediaInventoryBinding", "units"].includes(key))
    || !Array.isArray(plan.units) || plan.units.length < 1
    || plan.units.some((unit, index) => unit?.index !== index
      || !["segment", "media"].includes(unit.phase)
      || !/^wa-(?:segment|media)-[a-f0-9]{20}$/.test(unit.unitRef))) {
    throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_PLAN_INVALID", "The connector did not produce a bounded immutable WhatsApp snapshot fetch plan.");
  }
  const firstMedia = plan.units.findIndex((unit) => unit.phase === "media");
  if (firstMedia >= 0 && plan.units.slice(firstMedia).some((unit) => unit.phase !== "media")) {
    throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_PLAN_INVALID", "The connector plan must durably validate every segment before any media unit.");
  }
  const segmentRefs = new Set();
  const unitRefs = new Set();
  for (const unit of plan.units) {
    if (unitRefs.has(unit.unitRef) || !/^wa-chat-[a-f0-9]{20}$/.test(unit.chatRef)
      || !/^wa-segment-[a-f0-9]{20}$/.test(unit.segmentRef)) {
      throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_PLAN_INVALID", "The connector plan contains duplicate or invalid opaque unit bindings.");
    }
    unitRefs.add(unit.unitRef);
    if (unit.phase === "segment") {
      if (unit.unitRef !== unit.segmentRef
        || Object.keys(unit).some((key) => !["phase", "unitRef", "chatRef", "segmentRef", "index"].includes(key))) {
        throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_PLAN_INVALID", "A segment unit is not exactly bound to its approved opaque segment.");
      }
      segmentRefs.add(unit.segmentRef);
    } else if (unit.unitRef !== unit.mediaRef || !segmentRefs.has(unit.segmentRef)
      || !/^wa-message-[a-f0-9]{20}$/.test(unit.messageRef)
      || !/^wa-media-[a-f0-9]{20}$/.test(unit.mediaRef)
      || Object.keys(unit).some((key) => !["phase", "unitRef", "chatRef", "segmentRef", "messageRef", "mediaRef", "index"].includes(key))) {
      throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_PLAN_INVALID", "A media unit is not exactly bound to a previously approved segment and message.");
    }
  }
  return plan;
}

function assertReceiptAgainstPlan(receipt, plan, index) {
  const unit = plan.units[index];
  if (!receipt || !unit || receipt.protocol !== "qwave.whatsapp-snapshot-fetch-receipt/v1"
    || receipt.planBinding !== plan.planBinding || receipt.index !== index
    || receipt.unitRef !== unit.unitRef || receipt.phase !== unit.phase
    || !Array.isArray(receipt.records)
    || Object.keys(receipt).some((key) => !["protocol", "planBinding", "index", "unitRef", "phase", "records", "receiptBinding"].includes(key))) {
    throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_RECEIPT_INVALID", "A durable WhatsApp snapshot receipt does not exactly match its immutable plan.");
  }
  for (const record of receipt.records) {
    const recordKeys = unit.phase === "media" ? ["sourceRecordId", "source", "mediaReferenceIds"] : ["sourceRecordId", "source"];
    if (!record || record.source !== SOURCE || !/^wa-message-[a-f0-9]{20}$/.test(record.sourceRecordId)
      || Object.keys(record).some((key) => !recordKeys.includes(key))) {
      throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_RECEIPT_INVALID", "A durable WhatsApp snapshot receipt contains an invalid opaque record.");
    }
    if (unit.phase === "media" && (receipt.records.length !== 1 || record.sourceRecordId !== unit.messageRef
      || !Array.isArray(record.mediaReferenceIds) || record.mediaReferenceIds.length !== 1
      || record.mediaReferenceIds[0] !== unit.mediaRef)) {
      throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_RECEIPT_INVALID", "A durable media receipt does not exactly match its approved message and media unit.");
    }
  }
  const core = {
    protocol: receipt.protocol,
    planBinding: receipt.planBinding,
    index: receipt.index,
    unitRef: receipt.unitRef,
    phase: receipt.phase,
    records: receipt.records
  };
  if (receipt.receiptBinding !== `wa-fetch-receipt-${hash(JSON.stringify(core)).slice(0, 24)}`) {
    throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_RECEIPT_INVALID", "A durable WhatsApp snapshot receipt binding is invalid.");
  }
  return receipt;
}

function finalApprovedRecords(receipts) {
  const ordered = [];
  const byMessage = new Map();
  for (const receipt of receipts) {
    for (const record of receipt.records) {
      let safe = byMessage.get(record.sourceRecordId);
      if (!safe) {
        safe = { sourceRecordId: record.sourceRecordId, processingDisposition: "untrusted-inert-reference", source: SOURCE, mediaReferenceIds: [] };
        byMessage.set(record.sourceRecordId, safe);
        ordered.push(safe);
      }
      for (const mediaRef of record.mediaReferenceIds ?? []) {
        if (!safe.mediaReferenceIds.includes(mediaRef)) safe.mediaReferenceIds.push(mediaRef);
      }
    }
  }
  return ordered.map((record) => ({
    sourceRecordId: record.sourceRecordId,
    processingDisposition: record.processingDisposition,
    source: record.source,
    ...(record.mediaReferenceIds.length ? { mediaReferenceIds: record.mediaReferenceIds } : {})
  }));
}

function finalizeFetch(entry, completedAt) {
  if (!entry.fetch.plan || entry.fetch.cursor !== entry.fetch.plan.units.length || entry.fetch.receipts.length !== entry.fetch.cursor) return false;
  const plan = assertFetchPlan(entry.fetch.plan);
  entry.fetch.receipts.forEach((receipt, index) => assertReceiptAgainstPlan(receipt, plan, index));
  const records = finalApprovedRecords(entry.fetch.receipts);
  const core = {
    protocol: "qwave.whatsapp-snapshot-completion/v1",
    planBinding: entry.fetch.plan.planBinding,
    unitCount: entry.fetch.cursor,
    receiptBindings: entry.fetch.receipts.map((receipt) => receipt.receiptBinding),
    records
  };
  entry.fetch.completionReceipt = {
    ...core,
    receiptBinding: `wa-completion-${hash(JSON.stringify(core)).slice(0, 24)}`,
    completedAt
  };
  entry.fetch.status = "completed";
  entry.fetch.pending = null;
  entry.status = "processed";
  entry.approvedRecords = clone(records);
  entry.failure = null;
  return true;
}

function assertCompletedFetchState(entry) {
  const plan = assertFetchPlan(entry.fetch?.plan);
  if (entry.fetch.cursor !== plan.units.length || entry.fetch.pending !== null
    || entry.fetch.receipts?.length !== plan.units.length || !entry.fetch.completionReceipt) {
    throw new WhatsAppSnapshotError("SNAPSHOT_COMPLETION_RECEIPT_INVALID", "The completed WhatsApp snapshot state is missing its exact durable unit receipts.");
  }
  entry.fetch.receipts.forEach((receipt, index) => assertReceiptAgainstPlan(receipt, plan, index));
  const records = finalApprovedRecords(entry.fetch.receipts);
  const completion = entry.fetch.completionReceipt;
  const core = {
    protocol: "qwave.whatsapp-snapshot-completion/v1",
    planBinding: plan.planBinding,
    unitCount: plan.units.length,
    receiptBindings: entry.fetch.receipts.map((receipt) => receipt.receiptBinding),
    records
  };
  if (completion.protocol !== core.protocol || completion.planBinding !== core.planBinding
    || completion.unitCount !== core.unitCount
    || JSON.stringify(completion.receiptBindings) !== JSON.stringify(core.receiptBindings)
    || JSON.stringify(completion.records) !== JSON.stringify(core.records)
    || completion.receiptBinding !== `wa-completion-${hash(JSON.stringify(core)).slice(0, 24)}`
    || JSON.stringify(entry.approvedRecords) !== JSON.stringify(records)) {
    throw new WhatsAppSnapshotError("SNAPSHOT_COMPLETION_RECEIPT_INVALID", "The completed WhatsApp snapshot receipt no longer matches the exact approved units.");
  }
}

function publicSelection(selection) {
  if (!selection) {
    return {
      complete: false,
      chatRefs: [],
      personRefs: [],
      dateRange: null,
      media: { selectionMade: false, included: false },
      sensitiveCategories: []
    };
  }
  return {
    complete: true,
    chatRefs: [...selection.chatRefs],
    personRefs: [...selection.personRefs],
    dateRange: { from: selection.from, to: selection.to },
    media: { selectionMade: true, included: selection.includeMedia },
    sensitiveCategories: [...selection.sensitiveCategories]
  };
}

function publicView(entry, language, permissionReview = null) {
  if (entry.status === "processed") assertCompletedFetchState(entry);
  const wording = copy(language);
  const message = {
    "awaiting-guided-export": wording.export,
    "awaiting-snapshot-import": wording.import,
    "snapshot-review-pending": wording.reviewPending,
    "snapshot-review-failed": wording.reviewFailed,
    "awaiting-selection": wording.select,
    "awaiting-content-grant": wording.grant,
    "ready-to-process": wording.ready,
    "fetch-interrupted": wording.interrupted,
    "revoke-unconfirmed": wording.revokeUnconfirmed,
    processed: wording.processed,
    denied: wording.denied,
    cancelled: wording.cancelled,
    revoked: wording.revoked
  }[entry.status] ?? wording.import;
  const nextAction = {
    "awaiting-guided-export": "prepare-private-uncompressed-export-bundle",
    "awaiting-snapshot-import": "approve-local-manifest-preflight",
    "snapshot-review-pending": "resume-local-manifest-preflight",
    "snapshot-review-failed": "retry-local-manifest-preflight",
    "awaiting-selection": "choose-chats-allowed-people-dates-sensitivity-and-media",
    "awaiting-content-grant": "approve-exact-immutable-selection",
    "ready-to-process": "process-approved-local-segments",
    "fetch-interrupted": "confirm-explicit-fetch-retry",
    "revoke-unconfirmed": "retry-local-revocation",
    denied: "start-new-snapshot-review",
    cancelled: "start-new-snapshot-review",
    revoked: "start-new-snapshot-review"
  }[entry.status] ?? null;
  return {
    source: SOURCE,
    accountType: "personal",
    accountRef: entry.accountId,
    generation: entry.generation,
    status: entry.status,
    message,
    nextAction,
    connection: {
      mode: "guided-private-local-snapshot",
      live: false,
      simulated: false,
      readOnly: true,
      oneActionAtATime: true,
      canOpenWhatsApp: false,
      canExportFromWhatsApp: false,
      canSendMessages: false,
      canAlterMessages: false,
      canMutateSource: false,
      canFollowImportedInstructions: false
    },
    snapshot: clone(entry.snapshot),
    binding: entry.snapshotBinding ? {
      protocol: entry.snapshotBinding.protocol,
      format: entry.snapshotBinding.format,
      snapshotRef: entry.snapshotBinding.snapshotId,
      capturedAt: entry.snapshotBinding.capturedAt,
      generationBound: true,
      digestBound: true
    } : null,
    selection: publicSelection(entry.selection),
    approvedRecords: entry.approvedRecords ? clone(entry.approvedRecords) : null,
    cleanup: {
      sourceFileDeleted: false,
      temporaryStagingCreated: false,
      byteBuffersZeroedAfterEachRead: true,
      rawBodiesPersisted: false,
      garbageCollectionTimingClaimed: false,
      processExitDeletesCustomerExport: false,
      customerRetainsExportUntilTheyDeleteIt: true
    },
    untrustedSourceMaterial: wording.untrusted,
    failure: entry.failure ? clone(entry.failure) : null,
    permissionReview: permissionReview ? clone(permissionReview) : null,
    audit: clone(entry.audit)
  };
}

function publicBusinessView(entry, language) {
  return {
    source: SOURCE,
    accountType: "official-business",
    status: "unsupported",
    message: copy(language).business,
    connection: {
      mode: "official-business-provider-unavailable",
      live: false,
      verified: false,
      simulated: false,
      readOnly: true,
      sourceAccessStarted: false,
      contentPermissionGranted: false,
      canSendMessages: false,
      canAlterMessages: false
    },
    verification: {
      protocol: OFFICIAL_WHATSAPP_BUSINESS_VERIFICATION_PROTOCOL,
      hostProviderRegistered: false,
      callerSuppliedAttestationsAccepted: false,
      lastVerifiedAt: null
    },
    audit: clone(entry?.audit ?? [])
  };
}

function currentPermission(state, accountId, language) {
  return getSpecializedWhatsAppPermissionStatusFromState({ state, source: SOURCE, accountId, language });
}

function sourcePermissionEntry(state, accountId) {
  return state.sourcePermissionLifecycle?.entries?.[permissionEntryKey(accountId)] ?? null;
}

function localConnectorRegistrationKey(entry, grantId = entry.grantId) {
  return `${entry.accountId}:${entry.reviewId}:${grantId}:${snapshotBindingDigest(entry)}`;
}

function localConnectorRegistration(entry, grantId = entry.grantId) {
  const key = localConnectorRegistrationKey(entry, grantId);
  let registration = LOCAL_WHATSAPP_SNAPSHOT_REGISTRATIONS.get(key);
  if (!registration) {
    registration = { connectors: new Set(), authoritative: null };
    LOCAL_WHATSAPP_SNAPSHOT_REGISTRATIONS.set(key, registration);
  }
  return { key, registration };
}

function trackLocalConnector(connector, entry, grantId = entry.grantId) {
  const tracked = localConnectorRegistration(entry, grantId);
  tracked.registration.connectors.add(connector);
  return tracked;
}

async function revokeTrackedConnector(connector, entry, grantId) {
  const snapshotBinding = clone(entry.snapshotBinding);
  const operations = connectorOperations(connector);
  const request = { grantId, snapshotBinding };
  await invokeLocalConnectorOperation(
    connector,
    "revokePermissionGrant",
    request,
    () => operations.revokePermissionGrant(request)
  );
  const readback = await operations.readPermissionGrantStatus({ grantId, snapshotBinding });
  if (readback?.grantId !== grantId || readback.active !== false
    || readback.pending === true || readback.revoked !== true) {
    throw new WhatsAppSnapshotError(
      "WHATSAPP_REVOCATION_UNCONFIRMED",
      "A possibly active local WhatsApp registration was not confirmed inactive, so revocation remains pending."
    );
  }
  return readback;
}

async function revokeEveryTrackedConnector(connector, entry, grantId) {
  const { key, registration } = trackLocalConnector(connector, entry, grantId);
  const failures = [];
  for (const candidate of registration.connectors) {
    try {
      await revokeTrackedConnector(candidate, entry, grantId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  registration.authoritative = null;
  LOCAL_WHATSAPP_SNAPSHOT_REGISTRATIONS.delete(key);
  return { revoked: true, registrationsConfirmedInactive: registration.connectors.size };
}

async function ensureConnectorBinding(connector, entry) {
  const operations = connectorOperations(connector);
  await operations.discoverMetadata({ source: SOURCE });
  const binding = operations.getSnapshotBinding();
  if (binding.accountRef !== entry.accountId || (entry.snapshotBinding && JSON.stringify(binding) !== JSON.stringify(entry.snapshotBinding))) {
    throw new WhatsAppSnapshotError("SNAPSHOT_CONNECTOR_SUBSTITUTION", "The local connector does not match this immutable snapshot generation.");
  }
  if (binding.capturedAt !== entry.snapshot.capturedAt) {
    throw new WhatsAppSnapshotError("SNAPSHOT_CAPTURE_BINDING_MISMATCH", "The manifest capture time does not match the customer-confirmed export time.");
  }
  return binding;
}

function permissionProxy(connector, entry, { fetchUnit = null, completedReceipts = [], registrationMode = "activate" } = {}) {
  const operations = connectorOperations(connector);
  const selection = clone(entry.selection);
  const snapshotBinding = clone(entry.snapshotBinding);
  const revocation = clone(entry.revocation);
  const grantActivation = clone(entry.grantActivation);
  return {
    discoverMetadata: (request) => operations.discoverMetadata(request),
    registerPermissionGrant: async ({ grant }) => {
      if (revocation?.status === "pending") {
        throw new WhatsAppSnapshotError("WHATSAPP_REVOCATION_PENDING", "A pending WhatsApp revocation cannot restore or register source access.");
      }
      if (!exactGrantActivationIntentMatches(entry, grantActivation)
        || grantActivation.grantId !== grant.id) {
        throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_INTENT_MISMATCH", "The adapter grant was blocked because its durable exact activation intent was missing or changed.");
      }
      if (registrationMode === "prepare") {
        if (grantActivation.status !== "pending") {
          throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_INTENT_MISMATCH", "Only a pending exact activation intent can prepare local source access.");
        }
        return prepareExactConnectorGrant(connector, entry, grant);
      }
      if (registrationMode !== "activate" || grantActivation.status !== "activation-authorized") {
        throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_INTENT_MISMATCH", "Local source access cannot activate before exact durable authorization is confirmed.");
      }
      return activateExactConnectorGrant(connector, entry, grant);
    },
    revokePermissionGrant: async ({ grantId }) => {
      if (!exactRevocationIntentMatches(entry, revocation) || revocation.grantId !== grantId) {
        throw new WhatsAppSnapshotError("WHATSAPP_REVOCATION_INTENT_MISMATCH", "The adapter revoke was blocked because its durable exact intent was missing or changed.");
      }
      return revokeEveryTrackedConnector(connector, entry, grantId);
    },
    fetchApprovedContent: ({ source, accountId, grant }) => {
      if (revocation?.status === "pending") {
        throw new WhatsAppSnapshotError("WHATSAPP_REVOCATION_PENDING", "A pending WhatsApp revocation blocks every content read.");
      }
      if (grantActivation?.status === "pending") {
        throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_PENDING", "A pending WhatsApp grant activation blocks every content read.");
      }
      const request = {
        source,
        accountId,
        grant,
        snapshotBinding,
        selection,
        fetchUnit: clone(fetchUnit),
        completedReceipts: clone(completedReceipts)
      };
      return invokeLocalConnectorOperation(
        connector,
        "fetchApprovedContent",
        request,
        () => operations.fetchApprovedContent(request)
      );
    }
  };
}

function permissionReviewProxy(connector) {
  const operations = connectorOperations(connector);
  return Object.freeze({
    discoverMetadata: (request) => operations.discoverMetadata(request),
    fetchApprovedContent: async () => {
      throw new WhatsAppSnapshotError(
        "WHATSAPP_GRANT_REQUIRED",
        "Metadata review cannot read WhatsApp snapshot content."
      );
    }
  });
}

function exactGrantScopeMatchesSelection(grantScope, exactScope) {
  if (!grantScope || !exactScope) return false;
  const exactArray = (left, right) => JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
  return grantScope.accountId === exactScope.accountId
    && exactArray(grantScope.conversations, exactScope.conversations)
    && exactArray(grantScope.people?.allowed, exactScope.people?.allowed)
    && exactArray(grantScope.sensitiveGroups?.included, exactScope.sensitiveGroups?.included)
    && JSON.stringify(grantScope.dateRange) === JSON.stringify(exactScope.dateRange)
    && JSON.stringify(grantScope.exclusions?.dateRanges ?? []) === JSON.stringify(exactScope.exclusions?.dateRanges ?? [])
    && grantScope.acknowledgements?.modelProcessing === true
    && grantScope.acknowledgements?.untrustedSourceMaterial === true;
}

function exactActivePermissionGrant(state, entry, exactScope) {
  const permission = sourcePermissionEntry(state, entry.accountId);
  const active = (permission?.grants ?? []).filter((grant) => grant.status === "active");
  if (permission?.review?.id !== entry.reviewId || active.length !== 1) {
    throw new WhatsAppSnapshotError("WHATSAPP_PERMISSION_REVIEW_MISMATCH", "The exact durable WhatsApp grant could not be reconciled safely.");
  }
  const grant = active[0];
  if (grant.id !== entry.grantId || grant.reviewId !== entry.reviewId
    || grant.accountId !== entry.accountId || grant.source !== SOURCE
    || !exactGrantScopeMatchesSelection(grant.scope, exactScope)) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_RECONCILIATION_MISMATCH", "The durable grant does not match the exact saved WhatsApp review, snapshot, and selection.");
  }
  return clone(grant);
}

async function prepareExactConnectorGrant(connector, entry, grant) {
  if (!exactGrantActivationIntentMatches(entry, entry.grantActivation, ["pending"])) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_INTENT_MISMATCH", "The exact durable pending activation intent could not be confirmed.");
  }
  trackLocalConnector(connector, entry, grant.id);
  const operations = connectorOperations(connector);
  const request = {
    grant,
    snapshotBinding: clone(entry.snapshotBinding),
    selection: clone(entry.selection)
  };
  const result = await invokeLocalConnectorOperation(
    connector,
    "preparePermissionGrant",
    request,
    () => operations.preparePermissionGrant(request)
  );
  const readback = await operations.readPermissionGrantStatus({ grantId: grant.id, snapshotBinding: clone(entry.snapshotBinding) });
  if (readback?.grantId !== grant.id || readback.active !== false
    || readback.revoked !== false || readback.pending !== true) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_PREPARATION_UNCONFIRMED", "The exact local WhatsApp grant was not confirmed pending and non-readable, so activation remains denied.");
  }
  return result;
}

async function activateExactConnectorGrant(connector, entry, grant) {
  if (!exactGrantActivationIntentMatches(entry, entry.grantActivation, ["activation-authorized"])) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_INTENT_MISMATCH", "The exact durable activation authorization could not be confirmed.");
  }
  const { registration } = trackLocalConnector(connector, entry, grant.id);
  const current = registration.authoritative;
  if (current && current !== connector) {
    await revokeTrackedConnector(current, entry, grant.id);
    registration.authoritative = null;
  }
  const operations = connectorOperations(connector);
  const request = {
    grant,
    snapshotBinding: clone(entry.snapshotBinding),
    selection: clone(entry.selection)
  };
  const result = await invokeLocalConnectorOperation(
    connector,
    "registerPermissionGrant",
    request,
    () => operations.registerPermissionGrant(request)
  );
  const readback = await operations.readPermissionGrantStatus({ grantId: grant.id, snapshotBinding: clone(entry.snapshotBinding) });
  if (readback?.grantId !== grant.id || readback.active !== true
    || readback.revoked !== false || readback.pending === true) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_UNCONFIRMED", "The exact local WhatsApp grant was not confirmed active, so content access remains denied.");
  }
  registration.authoritative = connector;
  return result;
}

async function ensureExactConnectorGrantActive(connector, entry, grant) {
  const snapshotBinding = clone(entry.snapshotBinding);
  const readback = await connectorOperations(connector).readPermissionGrantStatus({ grantId: grant.id, snapshotBinding });
  if (readback?.grantId !== grant.id || readback.revoked === true) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_UNCONFIRMED", "The exact local WhatsApp grant could not be reconciled as active, so content access remains denied.");
  }
  if (readback.active === true && readback.pending !== true) {
    const { registration } = trackLocalConnector(connector, entry, grant.id);
    if (registration.authoritative && registration.authoritative !== connector) {
      throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVE_ELSEWHERE", "That durable WhatsApp grant is already authoritative in another local connector instance.");
    }
    registration.authoritative = connector;
    return { registered: true, idempotent: true };
  }
  if (readback.active !== false) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_UNCONFIRMED", "The exact local WhatsApp grant readback was ambiguous, so content access remains denied.");
  }
  return activateExactConnectorGrant(connector, entry, grant);
}

function metadataMatchesPermissionReview(state, accountId, metadata) {
  return specializedWhatsAppMetadataMatchesPermissionReview({
    state,
    source: SOURCE,
    accountId,
    metadata
  });
}

function reconcileEntryFromPermissionState(state, entry, now) {
  const permission = sourcePermissionEntry(state, entry.accountId);
  if (!permission || permission.review?.id !== entry.reviewId) return false;
  const active = permission.grants?.find((grant) => grant.status === "active") ?? null;
  const revoked = permission.grants?.find((grant) => grant.status === "revoked"
    && grant.reviewId === entry.reviewId && grant.id === entry.grantId) ?? null;
  let changed = false;
  if (revoked && entry.status !== "revoked") {
    if (entry.revocation && !exactRevocationIntentMatches(entry)) return false;
    entry.status = "revoked";
    entry.grantId = revoked.id;
    if (entry.fetch.status !== "completed") entry.fetch.status = "revoked";
    if (entry.revocation) entry.revocation = { ...entry.revocation, status: "completed", completedAt: now };
    entry.failure = null;
    entry.audit.push({ type: "whatsapp-reconciled-revocation", at: now, reviewId: entry.reviewId });
    changed = true;
  } else if (isRevocationPending(entry)) {
    // A durable revoke intent is a one-way gate. Active grant and fetch
    // receipts cannot restore or advance this lifecycle while it is pending.
    return changed;
  } else if (isGrantActivationPending(entry)) {
    // A generic grant may already be durable while the exact connector grant
    // is still deliberately non-readable. Only the explicit grant retry may
    // reconcile and activate that exact journaled identifier.
    return changed;
  } else if (permission.status === "denied" && !["denied", "cancelled"].includes(entry.status)) {
    entry.status = "denied";
    if (entry.fetch.status === "pending") entry.fetch.status = "denied";
    entry.failure = null;
    entry.audit.push({ type: "whatsapp-reconciled-denial", at: now, reviewId: entry.reviewId });
    changed = true;
  } else if (active && entry.selection && ["awaiting-content-grant", "awaiting-selection"].includes(entry.status)) {
    entry.status = "ready-to-process";
    entry.grantId = active.id;
    entry.failure = null;
    entry.audit.push({ type: "whatsapp-reconciled-grant", at: now, reviewId: entry.reviewId });
    changed = true;
  }
  const receipt = permission.lastApprovedFetch;
  const checkpoint = receipt?.fetchCheckpoint;
  const pending = entry.fetch?.pending;
  const unit = entry.fetch?.plan?.units?.[entry.fetch?.cursor];
  const checkpointMatches = receipt?.reviewId === entry.reviewId
    && receipt?.grantId === (entry.grantId ?? active?.id)
    && pending && unit && checkpoint
    && pending.planBinding === entry.fetch.plan.planBinding
    && pending.index === entry.fetch.cursor
    && pending.unitRef === unit.unitRef
    && checkpoint.protocol === "qwave.whatsapp-snapshot-fetch-receipt/v1"
    && checkpoint.planBinding === entry.fetch.plan.planBinding
    && checkpoint.index === entry.fetch.cursor
    && checkpoint.unitRef === unit.unitRef
    && checkpoint.phase === unit.phase
    && Array.isArray(checkpoint.records)
    && /^wa-fetch-receipt-[a-f0-9]{24}$/.test(checkpoint.receiptBinding);
  if (checkpointMatches && !["revoked", "denied", "cancelled"].includes(entry.status)) {
    entry.fetch.receipts.push(clone(checkpoint));
    entry.fetch.cursor += 1;
    entry.fetch.pending = null;
    entry.fetch.status = "running";
    entry.status = "ready-to-process";
    entry.failure = null;
    entry.audit.push({
      type: "whatsapp-fetch-unit-receipt-reconciled",
      at: now,
      operationId: entry.fetch.operationId,
      unitRef: checkpoint.unitRef,
      unitIndex: checkpoint.index,
      phase: checkpoint.phase,
      recordCount: checkpoint.records.length
    });
    if (finalizeFetch(entry, receipt.completedAt ?? now)) {
      entry.audit.push({
        type: "whatsapp-fetch-completed",
        at: receipt.completedAt ?? now,
        operationId: entry.fetch.operationId,
        unitCount: entry.fetch.cursor,
        recordCount: entry.approvedRecords.length,
        rawBodiesReturned: false
      });
    }
    changed = true;
  } else if (pending && !["processed", "revoked", "denied", "cancelled"].includes(entry.status)) {
    entry.status = "fetch-interrupted";
    entry.fetch.status = "interrupted";
    entry.failure = { stage: "approved-content-unit-read", code: "SNAPSHOT_FETCH_OUTCOME_UNCONFIRMED", at: now };
    entry.audit.push({ type: "whatsapp-fetch-interrupted", at: now, operationId: entry.fetch.operationId, unitRef: pending.unitRef, unitIndex: pending.index, automaticRetry: false });
    changed = true;
  }
  return changed;
}

async function beginPersonalUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, language, clock }) {
  assertNaturalLanguage(message);
  assertLocalAccountRef(accountId);
  const state = await loadState(stateStore);
  const records = lifecycle(state);
  const key = personalEntryKey(accountId);
  if (!records.entries[key]) {
    const now = isoNow(clock);
    records.entries[key] = newEntry(accountId, now);
    records.audit.push({ type: "whatsapp-personal-snapshot-offered", at: now, accountRef: accountId, generation: 1, sourceAccessed: false });
    await stateStore.save(state);
  }
  return { whatsAppSnapshot: publicView(records.entries[key], languageFor(state, language)) };
}

export async function beginWhatsAppPersonalSnapshot(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => beginPersonalUnlocked(args));
}

async function confirmExportUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, exportCompleted = false, snapshotCapturedAt, language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (entry.status !== "awaiting-guided-export") return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
  if (exportCompleted !== true) return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
  const now = isoNow(clock);
  const capturedAt = strictTimestamp(snapshotCapturedAt, { now, field: "snapshot capture time", futureSkewMs: MAX_CAPTURE_FUTURE_SKEW_MS });
  entry.status = "awaiting-snapshot-import";
  entry.snapshot.exportStatus = "customer-confirmed";
  entry.snapshot.capturedAt = capturedAt;
  entry.audit.push({ type: "whatsapp-export-confirmed", at: now, capturedAt, generation: entry.generation, sourceAccessed: false });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
}

export async function confirmWhatsAppPersonalExport(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => confirmExportUnlocked(args));
}

async function beginImportUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, snapshotImportApproved = false, language, clock, reviewIdFactory }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  assertNoRevocationPending(entry);
  if (snapshotImportApproved !== true) return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
  if (["awaiting-selection", "awaiting-content-grant", "ready-to-process", "processed"].includes(entry.status)) {
    const permission = currentPermission(state, accountId, language);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview) };
  }
  if (!["awaiting-snapshot-import", "snapshot-review-failed", "snapshot-review-pending"].includes(entry.status)) {
    throw new WhatsAppSnapshotError("GUIDED_EXPORT_REQUIRED", "Confirm the private export before starting its local metadata preflight.");
  }
  assertConnector(connector);
  const operations = connectorOperations(connector);
  const now = isoNow(clock);
  entry.status = "snapshot-review-pending";
  entry.snapshot.importStatus = "metadata-preflight-pending";
  entry.snapshot.importAttempts += 1;
  entry.audit.push({ type: "whatsapp-local-preflight-approved", at: now, attempt: entry.snapshot.importAttempts, messageBodiesRead: false, mediaBodiesRead: false });
  // This durable save happens before discoverMetadata, so a failed save cannot
  // cause even manifest metadata to be opened.
  await stateStore.save(state);

  let recoverableReviewId = null;
  let recoverableBinding = null;
  try {
    const discoveredMetadata = await operations.discoverMetadata({ source: SOURCE });
    const currentRoot = await loadState(stateStore);
    const existing = currentPermission(currentRoot, accountId, language);
    let review = entry.reviewId && existing?.permissionReview?.status === "awaiting-grant"
      && existing.permissionReview.permissionRequest.reviewId === entry.reviewId
      ? existing
      : null;
    if (!review) {
      const currentPermissionEntry = sourcePermissionEntry(currentRoot, accountId);
      const seenReviewIds = new Set([
        ...entry.audit.map((event) => event.reviewId).filter(Boolean),
        ...(currentPermissionEntry?.audit ?? []).map((event) => event.reviewId).filter(Boolean)
      ]);
      review = await beginSpecializedWhatsAppPermissionReview({
        message: languageFor(state, language) === "es" ? "Quiero revisar la instantánea para mi segundo cerebro" : "I want to review the snapshot for my second brain",
        stateStore,
        connector: permissionReviewProxy(connector),
        source: SOURCE,
        language,
        clock,
        reviewIdFactory: guardedIdentifierFactory({ factory: reviewIdFactory, prefix: "wa-review", seen: seenReviewIds, field: "review" })
      });
    } else {
      // discoverMetadata above recreated the private alias map after process
      // restart without reading any selected message or media body.
    }
    if (review.permissionReview.account.id !== accountId || review.permissionReview.status !== "awaiting-grant") {
      throw new WhatsAppSnapshotError("WHATSAPP_PERMISSION_REVIEW_MISMATCH", "The saved permission review does not match this snapshot account.");
    }
    const reviewState = await loadState(stateStore);
    if (!metadataMatchesPermissionReview(reviewState, accountId, discoveredMetadata)) {
      throw new WhatsAppSnapshotError("SNAPSHOT_PERMISSION_METADATA_MISMATCH", "An existing permission review does not match this immutable local snapshot manifest.");
    }
    const binding = operations.getSnapshotBinding();
    if (binding.accountRef !== accountId || binding.capturedAt !== entry.snapshot.capturedAt) {
      throw new WhatsAppSnapshotError("SNAPSHOT_CAPTURE_BINDING_MISMATCH", "The immutable manifest does not match the confirmed account and capture time.");
    }
    recoverableReviewId = review.permissionReview.permissionRequest.reviewId;
    recoverableBinding = clone(binding);
    const refreshed = await loadState(stateStore);
    const refreshedEntry = assertEntry(refreshed, accountId);
    if (refreshedEntry.generation !== entry.generation) throw new WhatsAppSnapshotError("STALE_WHATSAPP_GENERATION", "A newer WhatsApp snapshot review replaced this one.");
    if (refreshedEntry.snapshotBinding && JSON.stringify(refreshedEntry.snapshotBinding) !== JSON.stringify(binding)) {
      throw new WhatsAppSnapshotError("SNAPSHOT_REPLAY_REJECTED", "A different snapshot cannot replace an in-progress immutable review.");
    }
    refreshedEntry.snapshotBinding = clone(binding);
    refreshedEntry.reviewId = review.permissionReview.permissionRequest.reviewId;
    refreshedEntry.status = "awaiting-selection";
    refreshedEntry.snapshot.importStatus = "metadata-reviewed";
    refreshedEntry.snapshot.importedAt = now;
    refreshedEntry.failure = null;
    refreshedEntry.audit.push({ type: "whatsapp-manifest-metadata-reviewed", at: now, reviewId: refreshedEntry.reviewId, generation: refreshedEntry.generation, messageBodiesRead: false, mediaBodiesRead: false });
    await stateStore.save(refreshed);
    return { whatsAppSnapshot: publicView(refreshedEntry, languageFor(refreshed, language), review.permissionReview) };
  } catch (error) {
    const fallback = await loadState(stateStore);
    const fallbackEntry = assertEntry(fallback, accountId);
    assertGeneration(fallbackEntry, generation);
    const permissionEntry = sourcePermissionEntry(fallback, accountId);
    if (recoverableReviewId && recoverableBinding
      && permissionEntry?.status === "awaiting-grant"
      && permissionEntry.review?.id === recoverableReviewId) {
      fallbackEntry.reviewId = recoverableReviewId;
      fallbackEntry.snapshotBinding = clone(recoverableBinding);
      fallbackEntry.audit.push({ type: "whatsapp-pending-review-bound", at: isoNow(clock), reviewId: recoverableReviewId, generation, contentBodiesRead: false });
    }
    fallbackEntry.status = "snapshot-review-failed";
    fallbackEntry.snapshot.importStatus = "metadata-review-failed";
    fallbackEntry.failure = { stage: "metadata-preflight", ...safeFailure(error, "SNAPSHOT_METADATA_REVIEW_FAILED", isoNow(clock)) };
    fallbackEntry.audit.push({ type: "whatsapp-manifest-review-failed", at: fallbackEntry.failure.at, code: fallbackEntry.failure.code, messageBodiesRead: false, mediaBodiesRead: false });
    await stateStore.save(fallback);
    return { whatsAppSnapshot: publicView(fallbackEntry, languageFor(fallback, language)), metadataReviewUnavailable: true };
  }
}

export async function beginWhatsAppSnapshotImport(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => beginImportUnlocked(args));
}

async function selectScopeUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, chatRefs, personRefs, from, to, includeMedia, sensitiveCategories, language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  assertNoRevocationPending(entry);
  assertNoGrantActivationPending(entry);
  if (entry.status !== "awaiting-selection" || entry.reviewId !== reviewId) {
    throw new WhatsAppSnapshotError("WHATSAPP_SELECTION_NOT_READY", "Complete the current manifest review before selecting snapshot content.");
  }
  await ensureConnectorBinding(connector, entry);
  const selection = connectorOperations(connector).validateSelection({ chatRefs, personRefs, from, to, includeMedia, sensitiveCategories });
  const permission = currentPermission(state, accountId, language);
  const requested = permission?.permissionReview?.permissionRequest?.requestedScope;
  if (!requested || Date.parse(selection.from) < Date.parse(requested.dateRange.from) || Date.parse(selection.to) > Date.parse(requested.dateRange.to)) {
    throw new WhatsAppSnapshotError("WHATSAPP_DATE_SCOPE_EXPANSION", "The selected dates must stay within this metadata review's visible communication window.");
  }
  entry.selection = clone(selection);
  entry.status = "awaiting-content-grant";
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-explicit-scope-selected", at: isoNow(clock), reviewId, chatCount: selection.chatRefs.length, personCount: selection.personRefs.length, mediaIncluded: selection.includeMedia });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission.permissionReview) };
}

export async function selectWhatsAppSnapshotScope(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => selectScopeUnlocked(args));
}

/** Compatibility boundary: a media-only choice is intentionally insufficient. */
export async function selectWhatsAppSnapshotMedia({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, includeMedia, language }) {
  assertNaturalLanguage(message);
  if (typeof includeMedia !== "boolean") throw new WhatsAppSnapshotError("MEDIA_SELECTION_REQUIRED", "Choose explicitly whether media is included.");
  return withSourcePermissionStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
    assertNoRevocationPending(entry);
    assertNoGrantActivationPending(entry);
    if (entry.reviewId !== reviewId || entry.status !== "awaiting-selection") throw new WhatsAppSnapshotError("WHATSAPP_SELECTION_NOT_READY", "Complete the current manifest review first.");
    return {
      whatsAppSnapshot: publicView(entry, languageFor(state, language)),
      mediaChoiceRecorded: false,
      explicitScopeRequired: true
    };
  });
}

function dateExclusions(requestedRange, selection) {
  const exclusions = [];
  if (Date.parse(selection.from) > Date.parse(requestedRange.from)) {
    exclusions.push({ from: requestedRange.from, to: new Date(Date.parse(selection.from) - 1).toISOString() });
  }
  if (Date.parse(selection.to) < Date.parse(requestedRange.to)) {
    exclusions.push({ from: new Date(Date.parse(selection.to) + 1).toISOString(), to: requestedRange.to });
  }
  return exclusions;
}

function scopeForSelection(permissionReview, selection) {
  const requested = clone(permissionReview.permissionRequest.requestedScope);
  const allPeople = [
    ...requested.people.allowed,
    ...requested.people.restricted,
    ...requested.people.blocked
  ];
  requested.conversations = [...selection.chatRefs];
  requested.people.allowed = [...selection.personRefs];
  requested.exclusions.people = [...new Set([...requested.exclusions.people, ...allPeople.filter((ref) => !selection.personRefs.includes(ref))])];
  requested.sensitiveGroups.included = [...selection.sensitiveCategories];
  requested.sensitiveGroups.excluded = requested.sensitiveGroups.excluded.filter((category) => !selection.sensitiveCategories.includes(category));
  requested.categories = [...new Set([...requested.categories, ...selection.sensitiveCategories])];
  requested.exclusions.categories = requested.exclusions.categories.filter((category) => !selection.sensitiveCategories.includes(category));
  requested.exclusions.dateRanges = dateExclusions(requested.dateRange, selection);
  requested.acknowledgements.modelProcessing = true;
  requested.acknowledgements.untrustedSourceMaterial = true;
  return requested;
}

async function grantUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, scope, language, clock, grantIdFactory }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (reconcileEntryFromPermissionState(state, entry, isoNow(clock))) await stateStore.save(state);
  assertNoRevocationPending(entry);
  if (entry.status === "ready-to-process" || entry.status === "processed") {
    const permission = currentPermission(state, accountId, language);
    if (!permission?.permissionReview || !entry.selection || !entry.grantId
      || !exactGrantActivationIntentMatches(entry, entry.grantActivation, ["activation-authorized"])) {
      throw new WhatsAppSnapshotError("WHATSAPP_GRANT_RECONCILIATION_MISMATCH", "The exact durable WhatsApp grant authorization could not be reconciled safely.");
    }
    await ensureConnectorBinding(connector, entry);
    const exactScope = scopeForSelection(permission.permissionReview, entry.selection);
    const activeGrant = exactActivePermissionGrant(state, entry, exactScope);
    await ensureExactConnectorGrantActive(connector, entry, activeGrant);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview) };
  }
  if (entry.status !== "awaiting-content-grant" || entry.reviewId !== reviewId || !entry.selection) {
    throw new WhatsAppSnapshotError("WHATSAPP_EXPLICIT_SELECTION_REQUIRED", "Choose chats, Allowed people, dates, sensitivity, and media before granting access.");
  }
  await ensureConnectorBinding(connector, entry);
  let permission = currentPermission(state, accountId, language);
  if (!permission?.permissionReview || !["awaiting-grant", "granted"].includes(permission.permissionReview.status)) {
    throw new WhatsAppSnapshotError("WHATSAPP_PERMISSION_REVIEW_MISMATCH", "The current permission review is not ready for this grant.");
  }
  const exactScope = scopeForSelection(permission.permissionReview, entry.selection);
  if (scope !== undefined && JSON.stringify(scope) !== JSON.stringify(exactScope)) {
    throw new WhatsAppSnapshotError("WHATSAPP_SCOPE_REBIND_REJECTED", "The grant must match the exact saved WhatsApp selection; start a new review to change it.");
  }

  const attemptAt = isoNow(clock);
  if (entry.grantActivation) {
    if (!exactGrantActivationIntentMatches(entry, entry.grantActivation, ["pending"])) {
      throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_INTENT_MISMATCH", "The saved grant activation no longer matches this exact generation, review, snapshot, and selection.");
    }
    entry.grantActivation = {
      ...entry.grantActivation,
      attempts: entry.grantActivation.attempts + 1,
      lastAttemptAt: attemptAt,
      failure: entry.grantActivation.failure ?? null
    };
  } else {
    const seenGrantIds = new Set([
      ...entry.audit.map((event) => event.grantId).filter(Boolean),
      ...(sourcePermissionEntry(state, accountId)?.grants ?? []).map((grant) => grant.id).filter(Boolean)
    ]);
    const exactGrantId = guardedIdentifierFactory({ factory: grantIdFactory, prefix: "wa-grant", seen: seenGrantIds, field: "grant" })();
    entry.grantId = exactGrantId;
    const intentCore = grantActivationIntentCore(entry, exactGrantId);
    entry.grantActivation = {
      ...intentCore,
      status: "pending",
      operationId: `wa-grant-activation-${hash(JSON.stringify(intentCore)).slice(0, 24)}`,
      attempts: 1,
      startedAt: attemptAt,
      lastAttemptAt: attemptAt,
      failure: null
    };
  }
  entry.audit.push({
    type: "whatsapp-grant-activation-pending",
    at: attemptAt,
    operationId: entry.grantActivation.operationId,
    reviewId,
    grantId: entry.grantId,
    attempt: entry.grantActivation.attempts,
    generation,
    bodyReadable: false
  });
  const expectedIntent = clone(entry.grantActivation);
  // This is the durable pre-activation boundary. The exact identifier and all
  // immutable review/selection bindings must round-trip before the adapter may
  // even prepare a deliberately non-readable grant.
  await stateStore.save(state);
  state = await loadState(stateStore);
  entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (entry.reviewId !== reviewId || !exactGrantActivationIntentMatches(entry, entry.grantActivation, ["pending"])
    || JSON.stringify(entry.grantActivation) !== JSON.stringify(expectedIntent)) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_INTENT_UNCONFIRMED", "The exact pending grant could not be read back durably, so the adapter was not invoked.");
  }

  const permissionWasAwaiting = permission.permissionReview.status === "awaiting-grant";
  if (permissionWasAwaiting) {
    await grantSpecializedWhatsAppPermission({
      message,
      stateStore,
      connector: permissionProxy(connector, entry, { registrationMode: "prepare" }),
      source: SOURCE,
      accountId,
      reviewId,
      scope: exactScope,
      language,
      clock,
      grantIdFactory: () => entry.grantId
    });
  }

  state = await loadState(stateStore);
  entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (entry.reviewId !== reviewId || !exactGrantActivationIntentMatches(entry, entry.grantActivation, ["pending"])) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_INTENT_MISMATCH", "The exact pending grant changed while durable permission was being recorded.");
  }
  const activeGrant = exactActivePermissionGrant(state, entry, exactScope);
  if (!permissionWasAwaiting) await prepareExactConnectorGrant(connector, entry, activeGrant);

  const authorizedAt = isoNow(clock);
  entry.status = "ready-to-process";
  entry.grantActivation = {
    ...entry.grantActivation,
    status: "activation-authorized",
    authorizedAt,
    failure: null
  };
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-content-granted", at: authorizedAt, reviewId, grantId: entry.grantId, generation });
  const expectedAuthorization = clone(entry.grantActivation);
  // Activation follows this save and exact readback. No durable mutation is
  // attempted after activation, so a save failure cannot orphan adapter access.
  await stateStore.save(state);
  state = await loadState(stateStore);
  entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (entry.status !== "ready-to-process"
    || !exactGrantActivationIntentMatches(entry, entry.grantActivation, ["activation-authorized"])
    || JSON.stringify(entry.grantActivation) !== JSON.stringify(expectedAuthorization)) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_AUTHORIZATION_UNCONFIRMED", "The exact durable grant authorization could not be read back, so local source access was not activated.");
  }
  const authorizedGrant = exactActivePermissionGrant(state, entry, exactScope);
  await ensureExactConnectorGrantActive(connector, entry, authorizedGrant);
  permission = currentPermission(state, accountId, language);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission.permissionReview) };
}

export async function grantWhatsAppSnapshotContent(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => grantUnlocked(args));
}

async function fetchUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (reconcileEntryFromPermissionState(state, entry, isoNow(clock))) await stateStore.save(state);
  assertNoRevocationPending(entry);
  assertNoGrantActivationPending(entry);
  if (entry.status === "processed" && Array.isArray(entry.approvedRecords)) {
    const permission = currentPermission(state, accountId, language);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview), approvedRecords: clone(entry.approvedRecords), idempotentReplay: true };
  }
  if (entry.status === "fetch-interrupted") {
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), fetchUnavailable: true, explicitRetryRequired: true };
  }
  if (entry.status !== "ready-to-process" || entry.reviewId !== reviewId || !entry.selection || !entry.grantId) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_REQUIRED", "An active exact WhatsApp snapshot grant is required before local content is read.");
  }
  await ensureConnectorBinding(connector, entry);
  const connectorPlan = assertFetchPlan(connectorOperations(connector).createApprovedFetchPlan({
    snapshotBinding: clone(entry.snapshotBinding),
    selection: clone(entry.selection)
  }));
  if (entry.fetch.plan && JSON.stringify(entry.fetch.plan) !== JSON.stringify(connectorPlan)) {
    throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_PLAN_CHANGED", "The immutable WhatsApp snapshot fetch plan changed, so no additional body was read.");
  }
  if (!entry.fetch.plan) {
    const startedAt = isoNow(clock);
    entry.fetch.plan = clone(connectorPlan);
    entry.fetch.cursor = 0;
    entry.fetch.receipts = [];
    entry.fetch.completionReceipt = null;
    entry.fetch.operationId = `wa-fetch-${hash(`${entry.snapshotBinding.snapshotId}:${entry.generation}:${entry.reviewId}:${entry.grantId}:${connectorPlan.planBinding}`).slice(0, 24)}`;
    entry.fetch.startedAt = startedAt;
    entry.audit.push({ type: "whatsapp-fetch-started", at: startedAt, operationId: entry.fetch.operationId, planBinding: connectorPlan.planBinding, unitCount: connectorPlan.units.length, generation: entry.generation });
  }
  entry.fetch.attempts += 1;
  entry.fetch.status = "running";
  await stateStore.save(state);

  let recoveredFromDurableReceipt = false;
  while (true) {
    state = await loadState(stateStore);
    entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
    assertNoRevocationPending(entry);
    assertNoGrantActivationPending(entry);
    if (entry.status === "processed") {
      const permission = currentPermission(state, accountId, language);
      return {
        whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview),
        approvedRecords: clone(entry.approvedRecords),
        ...(recoveredFromDurableReceipt ? { recoveredFromDurableReceipt: true } : {})
      };
    }
    const plan = assertFetchPlan(entry.fetch.plan);
    if (entry.fetch.cursor === plan.units.length) {
      if (!finalizeFetch(entry, isoNow(clock))) throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_CURSOR_INVALID", "The durable WhatsApp snapshot completion receipt could not be formed safely.");
      entry.audit.push({ type: "whatsapp-fetch-completed", at: entry.fetch.completionReceipt.completedAt, operationId: entry.fetch.operationId, unitCount: entry.fetch.cursor, recordCount: entry.approvedRecords.length, rawBodiesReturned: false });
      await stateStore.save(state);
      continue;
    }
    if (entry.fetch.pending) {
      entry.status = "fetch-interrupted";
      entry.fetch.status = "interrupted";
      entry.failure = { stage: "approved-content-unit-read", code: "SNAPSHOT_FETCH_OUTCOME_UNCONFIRMED", at: isoNow(clock) };
      await stateStore.save(state);
      return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), fetchUnavailable: true, explicitRetryRequired: true };
    }
    const unit = plan.units[entry.fetch.cursor];
    entry.fetch.pending = {
      protocol: "qwave.whatsapp-snapshot-pre-read/v1",
      planBinding: plan.planBinding,
      index: unit.index,
      unitRef: unit.unitRef,
      phase: unit.phase,
      attempt: entry.fetch.attempts,
      preparedAt: isoNow(clock)
    };
    entry.status = "processing";
    entry.fetch.status = "pending-unit";
    entry.audit.push({ type: "whatsapp-fetch-unit-pending", at: entry.fetch.pending.preparedAt, operationId: entry.fetch.operationId, unitRef: unit.unitRef, unitIndex: unit.index, phase: unit.phase });
    // This is the durable pre-read boundary. A failed save guarantees the
    // selected segment or media file is never opened.
    await stateStore.save(state);
    try {
      await fetchSpecializedWhatsAppContent({
        message,
        stateStore,
        connector: permissionProxy(connector, entry, {
          fetchUnit: { planBinding: plan.planBinding, index: unit.index, unit: clone(unit) },
          completedReceipts: clone(entry.fetch.receipts)
        }),
        source: SOURCE,
        accountId,
        reviewId,
        language,
        clock
      });
      state = await loadState(stateStore);
      entry = assertEntry(state, accountId);
      assertGeneration(entry, generation);
      const cursorBeforeReconcile = entry.fetch.cursor;
      reconcileEntryFromPermissionState(state, entry, isoNow(clock));
      if (entry.fetch.cursor !== cursorBeforeReconcile + 1 && entry.status !== "processed") {
        throw new WhatsAppSnapshotError("SNAPSHOT_FETCH_RECEIPT_MISSING", "The selected body read did not produce a matching durable unit receipt.");
      }
      await stateStore.save(state);
    } catch (error) {
      state = await loadState(stateStore);
      entry = assertEntry(state, accountId);
      assertGeneration(entry, generation);
      const cursorBeforeRecovery = entry.fetch.cursor;
      reconcileEntryFromPermissionState(state, entry, isoNow(clock));
      if (entry.fetch.cursor === cursorBeforeRecovery + 1 || entry.status === "processed") {
        recoveredFromDurableReceipt = true;
        await stateStore.save(state);
        continue;
      }
      entry.status = "fetch-interrupted";
      entry.fetch.status = "interrupted";
      entry.failure = { stage: "approved-content-unit-read", ...safeFailure(error, "SNAPSHOT_APPROVED_FETCH_FAILED", isoNow(clock)) };
      entry.audit.push({ type: "whatsapp-fetch-interrupted", at: entry.failure.at, operationId: entry.fetch.operationId, unitRef: entry.fetch.pending?.unitRef, unitIndex: entry.fetch.pending?.index, code: entry.failure.code, automaticRetry: false });
      await stateStore.save(state);
      return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), fetchUnavailable: true, explicitRetryRequired: true };
    }
  }
}

export async function fetchApprovedWhatsAppSnapshotContent(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => fetchUnlocked(args));
}

async function resumeFetchUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, confirmRetry = false, language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  assertNoRevocationPending(entry);
  assertNoGrantActivationPending(entry);
  if (entry.status !== "fetch-interrupted" || entry.reviewId !== reviewId) throw new WhatsAppSnapshotError("WHATSAPP_FETCH_RETRY_NOT_READY", "There is no interrupted current snapshot read to retry.");
  if (confirmRetry !== true) return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), explicitRetryRequired: true };
  entry.status = "ready-to-process";
  entry.fetch.status = "retry-confirmed";
  entry.fetch.pending = null;
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-fetch-retry-confirmed", at: isoNow(clock), previousOperationId: entry.fetch.operationId });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
}

export async function resumeWhatsAppSnapshotFetch(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => resumeFetchUnlocked(args));
}

async function revokeUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (reconcileEntryFromPermissionState(state, entry, isoNow(clock))) await stateStore.save(state);
  if (entry.status === "revoked") {
    const permission = currentPermission(state, accountId, language);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview), idempotentReplay: true };
  }
  assertNoGrantActivationPending(entry);
  if (!entry.grantId || entry.reviewId !== reviewId) throw new WhatsAppSnapshotError("WHATSAPP_ACTIVE_GRANT_NOT_FOUND", "There is no active current WhatsApp snapshot grant to revoke.");
  await ensureConnectorBinding(connector, entry);
  const intentCore = revocationIntentCore(entry);
  const intentAt = isoNow(clock);
  if (entry.revocation && !exactRevocationIntentMatches(entry)) {
    throw new WhatsAppSnapshotError("WHATSAPP_REVOCATION_INTENT_MISMATCH", "The saved revocation intent no longer matches this exact generation, review, grant, and snapshot binding.");
  }
  entry.revocation = {
    ...intentCore,
    status: "pending",
    operationId: entry.revocation?.operationId
      ?? `wa-revoke-${hash(JSON.stringify(intentCore)).slice(0, 24)}`,
    attempts: (entry.revocation?.attempts ?? 0) + 1,
    startedAt: entry.revocation?.startedAt ?? intentAt,
    lastAttemptAt: intentAt,
    failure: entry.revocation?.failure ?? null
  };
  entry.status = "revoke-unconfirmed";
  entry.audit.push({
    type: "whatsapp-revocation-intent-pending",
    at: intentAt,
    operationId: entry.revocation.operationId,
    reviewId,
    grantId: entry.grantId,
    attempt: entry.revocation.attempts,
    generation
  });
  const expectedIntent = clone(entry.revocation);
  // The exact intent must be durable before the adapter is invoked.
  await stateStore.save(state);
  state = await loadState(stateStore);
  entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (!exactRevocationIntentMatches(entry)
    || JSON.stringify(entry.revocation) !== JSON.stringify(expectedIntent)) {
    throw new WhatsAppSnapshotError("WHATSAPP_REVOCATION_INTENT_UNCONFIRMED", "The exact revocation intent could not be read back durably, so the adapter was not invoked.");
  }
  let revoked;
  try {
    revoked = await revokeSpecializedWhatsAppPermission({
      message,
      stateStore,
      connector: permissionProxy(connector, entry),
      source: SOURCE,
      accountId,
      reviewId,
      language,
      clock
    });
  } catch (error) {
    state = await loadState(stateStore);
    entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
    if (reconcileEntryFromPermissionState(state, entry, isoNow(clock)) && entry.status === "revoked") {
      await stateStore.save(state);
      return {
        whatsAppSnapshot: publicView(entry, languageFor(state, language)),
        revocationConfirmed: true,
        recoveredFromDurableReceipt: true
      };
    }
    entry.status = "revoke-unconfirmed";
    entry.failure = { stage: "grant-revocation-readback", ...safeFailure(error, "WHATSAPP_REVOCATION_UNCONFIRMED", isoNow(clock)) };
    entry.revocation = { ...entry.revocation, status: "pending", failure: clone(entry.failure) };
    entry.audit.push({
      type: "whatsapp-revocation-unconfirmed",
      at: entry.failure.at,
      reviewId,
      grantId: entry.grantId,
      code: entry.failure.code,
      sourceMutationConfirmed: false
    });
    await stateStore.save(state);
    return {
      whatsAppSnapshot: publicView(entry, languageFor(state, language)),
      revocationConfirmed: false,
      retryRequired: true
    };
  }
  state = await loadState(stateStore);
  entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  const completedAt = isoNow(clock);
  if (!reconcileEntryFromPermissionState(state, entry, completedAt) || entry.status !== "revoked") {
    throw new WhatsAppSnapshotError("WHATSAPP_REVOCATION_UNCONFIRMED", "The exact generic grant was not durably confirmed revoked after adapter readback.");
  }
  entry.revocation = { ...entry.revocation, status: "completed", completedAt, failure: null };
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-content-revoked", at: completedAt, reviewId, grantId: entry.grantId, sourceMutation: false });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language), revoked.permissionReview) };
}

export async function revokeWhatsAppSnapshotContent(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => revokeUnlocked(args));
}

async function denyUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  assertNoRevocationPending(entry);
  assertNoGrantActivationPending(entry);
  if (!["awaiting-selection", "awaiting-content-grant"].includes(entry.status) || entry.reviewId !== reviewId) {
    if (entry.status === "denied") return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), idempotentReplay: true };
    throw new WhatsAppSnapshotError("WHATSAPP_DENIAL_NOT_READY", "Only the current ungranted snapshot review can be denied.");
  }
  const denied = await denySpecializedWhatsAppPermission({ message, stateStore, source: SOURCE, accountId, reviewId, language, clock });
  state = await loadState(stateStore);
  entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  entry.status = "denied";
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-review-denied", at: isoNow(clock), reviewId, contentBodiesRead: false });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language), denied.permissionReview) };
}

export async function denyWhatsAppSnapshotContent(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => denyUnlocked(args));
}

async function cancelUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (isRevocationPending(entry)) {
    throw new WhatsAppSnapshotError("WHATSAPP_REVOCATION_PENDING", "Only retrying the pending exact revocation is allowed before this review can be cancelled.");
  }
  assertNoGrantActivationPending(entry);
  if (entry.status === "cancelled") return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), idempotentReplay: true };
  if (["ready-to-process", "processed", "fetch-interrupted", "revoke-unconfirmed"].includes(entry.status)) {
    if (!connector) throw new WhatsAppSnapshotError("WHATSAPP_REVOKE_REQUIRED", "Cancelling an active snapshot first requires its local grant to be revoked.");
    return revokeUnlocked({ message, stateStore, connector, accountId, generation, reviewId: reviewId ?? entry.reviewId, language, clock });
  }
  if (["awaiting-selection", "awaiting-content-grant", "snapshot-review-pending", "snapshot-review-failed"].includes(entry.status) && entry.reviewId) {
    await denySpecializedWhatsAppPermission({ message, stateStore, source: SOURCE, accountId, reviewId: reviewId ?? entry.reviewId, language, clock });
    state = await loadState(stateStore);
    entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
  }
  entry.status = "cancelled";
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-review-cancelled", at: isoNow(clock), reviewId: entry.reviewId, sourceMutation: false });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
}

export async function cancelWhatsAppSnapshotReview(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => cancelUnlocked(args));
}

async function restartUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const old = assertEntry(state, accountId);
  assertGeneration(old, generation);
  assertNoRevocationPending(old);
  assertNoGrantActivationPending(old);
  if (!["denied", "cancelled", "revoked", "snapshot-review-failed"].includes(old.status)) {
    throw new WhatsAppSnapshotError("WHATSAPP_RESTART_NOT_READY", "Finish, deny, cancel, or revoke the current snapshot review before starting a new generation.");
  }
  const now = isoNow(clock);
  const replacement = newEntry(accountId, now, old.generation + 1, old.audit);
  replacement.audit.push({ type: "whatsapp-new-review-generation", at: now, previousGeneration: old.generation, generation: replacement.generation });
  lifecycle(state).entries[personalEntryKey(accountId)] = replacement;
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(replacement, languageFor(state, language)) };
}

export async function restartWhatsAppSnapshotReview(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => restartUnlocked(args));
}

export async function cleanupWhatsAppSnapshotPrivateMemory({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, language, clock }) {
  assertNaturalLanguage(message);
  return withSourcePermissionStateLock(stateStore, async () => {
    assertConnector(connector);
    const state = await loadState(stateStore);
    const entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
    assertNoRevocationPending(entry);
    assertNoGrantActivationPending(entry);
    const result = connectorOperations(connector).cleanupPrivateMemory();
    entry.audit.push({ type: "whatsapp-private-memory-cleared", at: isoNow(clock), sourceFilesDeleted: false, stagingFilesCreated: false });
    await stateStore.save(state);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), cleanup: result };
  });
}

export async function getWhatsAppSnapshotStatus({ stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, language, clock }) {
  // The generic permission decision can be durable while a process exits before
  // its outer WhatsApp projection is saved. Reconcile that one-way handoff
  // under the shared root writer before showing status, using this same loaded
  // state object for both lifecycle projections. This performs no connector or
  // source-file access and cannot let a stale outer snapshot outrank a durable
  // terminal permission receipt.
  return withSourcePermissionStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const entry = state?.[STATE_KEY]?.entries?.[personalEntryKey(accountId)] ?? null;
    if (!entry) return null;
    if (reconcileEntryFromPermissionState(state, entry, isoNow(clock))) await stateStore.save(state);
    const permission = entry.reviewId ? currentPermission(state, accountId, language) : null;
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview) };
  });
}

export async function verifyWhatsAppOfficialBusinessConnection({ message, stateStore, verificationContract, accountId = DEFAULT_OFFICIAL_BUSINESS_ACCOUNT_REF, language, clock }) {
  assertNaturalLanguage(message);
  assertLocalAccountRef(accountId);
  return withSourcePermissionStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const records = lifecycle(state);
    const key = businessEntryKey(accountId);
    const entry = records.entries[key] ?? {
      source: SOURCE,
      accountId,
      accountType: "official-business",
      status: "unsupported",
      audit: []
    };
    records.entries[key] = entry;
    entry.status = "unsupported";
    entry.audit.push({
      type: "whatsapp-official-business-unsupported",
      at: isoNow(clock),
      reason: verificationContract ? "caller-supplied-attestation-rejected" : "registered-host-provider-unavailable",
      suppliedContractInvoked: false,
      sourceAccessed: false
    });
    await stateStore.save(state);
    return { officialWhatsAppBusiness: publicBusinessView(entry, languageFor(state, language)) };
  });
}

export async function getWhatsAppOfficialBusinessStatus({ stateStore, accountId = DEFAULT_OFFICIAL_BUSINESS_ACCOUNT_REF, language }) {
  assertLocalAccountRef(accountId);
  return withSourcePermissionStateReadLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const entry = state?.[STATE_KEY]?.entries?.[businessEntryKey(accountId)] ?? null;
    return { officialWhatsAppBusiness: publicBusinessView(entry, languageFor(state, language)) };
  });
}

export const WHATSAPP_LOCAL_SNAPSHOT_CONTRACT = Object.freeze({
  connectorProtocol: WHATSAPP_SNAPSHOT_CONNECTOR_PROTOCOL,
  bundleFormat: WHATSAPP_SNAPSHOT_BUNDLE_FORMAT,
  nativeZipSupported: false,
  sourceWritesSupported: false,
  livePersonalAccess: false,
  liveBusinessAccess: false
});
