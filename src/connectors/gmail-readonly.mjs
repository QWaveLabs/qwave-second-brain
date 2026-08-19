/**
 * QWA-145 Gmail read-only vertical slice.
 *
 * This adapter intentionally has no Gmail SDK or live app dependency. A host
 * injects the official plugin contract when it is genuinely available; the
 * included simulated plugin exercises the same contract without accessing a
 * mailbox. The public lifecycle never calls a source write operation and it
 * refuses to expose message bodies, snippets, headers, or raw payloads.
 */

import { randomUUID } from "node:crypto";

import {
  beginSourcePermissionReviewWithinStateLock,
  denySourcePermissionWithinStateLock,
  fetchApprovedSourceContentWithinStateLock,
  getSourcePermissionStatusFromState,
  getSourcePermissionStatusWithinStateLock,
  grantSourcePermissionWithinStateLock,
  revokeSourcePermissionWithinStateLock,
  withSourcePermissionStateLock,
  withSourcePermissionStateReadLock
} from "../permissions/setup-source-permissions.mjs";
import { getPersistedAdapterSourceStatus, SOURCE_ADAPTER_NAMES } from "../source-status.mjs";

const SOURCE = "gmail";
const STATE_KEY = "gmailReadOnlyLifecycle";
const DEFAULT_PAGE_BUDGET = 2;
const MAX_PAGE_BUDGET = 5;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GMAIL_AREAS = new Set(["inbox", "sent", "archive", "all-mail", "starred", "mail"]);
const BODY_FIELD_NAMES = new Set([
  "body",
  "html",
  "text",
  "content",
  "snippet",
  "raw",
  "payload",
  "headers",
  "mime",
  "attachment",
  "attachments",
  "messagebody",
  "emailbody"
]);
export const GMAIL_CONNECTION_STATES = Object.freeze({
  SELECTED_BUT_UNFINISHED: "selected-but-unfinished",
  NEEDS_ATTENTION: "needs-attention",
  LIVE_AND_VERIFIED: "live-and-verified",
  SKIPPED: "skipped",
  UNSUPPORTED: "unsupported",
  REVOKED: "revoked"
});

/** The one exact desktop fallback when Codex cannot initiate the plugin. */
export const GMAIL_IN_APP_FALLBACK_ACTION = Object.freeze({
  id: "open-gmail-plugin-connect",
  kind: "in-app-plugin-action"
});

export class GmailReadOnlyError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "GmailReadOnlyError";
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
    throw new GmailReadOnlyError(
      "GMAIL_MESSAGE_REQUIRED",
      "Tell me in normal language that you would like to connect or review Gmail for your second brain."
    );
  }
  if (message.trim().startsWith("/")) {
    throw new GmailReadOnlyError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Tell me normally what you would like to do with Gmail."
    );
  }
  if (action === "start" && !/gmail|correo|email|second\s+brain|segundo\s+cerebro|connect|conectar|review|revisar/i.test(message)) {
    throw new GmailReadOnlyError(
      "UNRECOGNIZED_GMAIL_REQUEST",
      "Tell me you would like to connect or review Gmail for your second brain, and I will guide you."
    );
  }
}

function languageFor(state, requestedLanguage) {
  return requestedLanguage === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function copy(language) {
  if (language === "es") {
    return {
      start: "Gmail se conectará por separado y solo con lectura. No enviaré, etiquetaré, archivaré, eliminaré ni modificaré ningún correo.",
      connected: "La ruta de Gmail está lista para una revisión de metadatos. Todavía no he leído el cuerpo de ningún correo.",
      fallback: "En Codex Desktop, abre Apps, selecciona Gmail y elige Connect.",
      cancelled: "La conexión de Gmail se canceló. No se leyó ningún correo y puedes reanudarla aquí cuando quieras.",
      needsAttention: "Gmail necesita atención antes de continuar. Detuve el procesamiento y no modifiqué ningún correo. Puedes reintentar el paso guardado en esta misma conversación.",
      reviewReady: "Revisé solo metadatos de Gmail para preparar el alcance de los últimos 90 días. Todavía no he leído ningún cuerpo de correo.",
      scopeGranted: "El alcance de Gmail se guardó como permiso granular y de solo lectura. Ahora puedo verificar una lectura aprobada sin modificar Gmail.",
      simulatedVerified: "La simulación de Gmail procesó referencias opacas aprobadas. Esto no verificó una cuenta real de Gmail, así que Gmail no se muestra como conexión en vivo.",
      simulatedEmpty: "La simulación de Gmail no encontró referencias aprobadas. Esto no verificó una cuenta real de Gmail, así que Gmail no se muestra como conexión en vivo.",
      liveVerified: "Gmail confirmó una lectura real y de solo lectura dentro del alcance aprobado. Ahora se muestra como conexión en vivo y verificada.",
      empty: "Gmail respondió correctamente, pero no había correos aprobados dentro de este alcance. La conexión se verificó sin modificar Gmail.",
      checkpoint: "Pausé esta importación en un punto de control seguro para no procesar una cuenta grande de una vez. Di que continúe Gmail para retomar exactamente desde aquí.",
      permissionCancelled: "No se concedió acceso al contenido de Gmail. La revisión de metadatos queda guardada y no se leyó ningún cuerpo de correo.",
      revoked: "El acceso de Gmail está revocado. No leeré más correos con este permiso anterior; inicia una revisión nueva si quieres volver a considerarlo.",
      skipped: "Gmail quedó omitido por ahora. Puedes volver a conectarlo desde esta misma conversación más adelante.",
      unsupported: "La conexión de Gmail no está disponible en este entorno. No se leyó ningún correo.",
      actualReadRequired: "No pude probar una lectura real y de solo lectura de Gmail, por lo que no la marcaré como conexión en vivo.",
      retrySavedStep: "Reintenta el paso guardado de Gmail en esta misma conversación.",
      continueImport: "Continúa la importación guardada de Gmail en esta misma conversación.",
      uncertainRead: "Una lectura de página de Gmail pudo haber ocurrido, pero su punto de control externo no quedó guardado. No volveré a leer esa página. Revoca este permiso guardado de Gmail e inicia una revisión nueva de metadatos para continuar de forma segura.",
      preReadCheckpointFailed: "No pude guardar el punto de control de seguridad previo a la lectura, así que no solicité ninguna página de Gmail. Puedes reintentar este paso guardado."
    };
  }
  return {
    start: "Gmail will be connected separately and read-only. I will not send, label, archive, delete, or modify any mail.",
    connected: "The Gmail path is ready for a metadata review. I have not read any email body yet.",
    fallback: "In Codex Desktop, open Apps, select Gmail, and choose Connect.",
    cancelled: "The Gmail connection was cancelled. No mail was read, and you can resume it here whenever you are ready.",
    needsAttention: "Gmail needs attention before it can continue. I stopped processing and did not change any mail. You can retry the saved step in this same conversation.",
    reviewReady: "I reviewed Gmail metadata only to prepare the previous-90-days scope. I have not read any email body.",
    scopeGranted: "The Gmail scope is saved as a granular read-only permission. I can now verify an approved read without changing Gmail.",
    simulatedVerified: "The Gmail simulation processed approved opaque references. It did not verify a real Gmail account, so Gmail is not shown as live.",
    simulatedEmpty: "The Gmail simulation found no approved references. It did not verify a real Gmail account, so Gmail is not shown as live.",
    liveVerified: "Gmail confirmed a real, read-only read inside the approved scope. It is now shown as live and verified.",
    empty: "Gmail responded successfully, but there was no approved mail in this scope. The connection was verified without changing Gmail.",
    checkpoint: "I paused this import at a safe checkpoint instead of processing a large account all at once. Say to continue Gmail to resume exactly here.",
    permissionCancelled: "No Gmail content access was granted. The metadata review is saved, and no email body was read.",
    revoked: "Gmail access is revoked. I will not read more mail through the earlier permission; start a new review if you want to consider it again.",
    skipped: "Gmail is skipped for now. You can return to connect it in this same conversation later.",
    unsupported: "Gmail connection is not available in this environment. No mail was read.",
    actualReadRequired: "I could not prove a real, read-only Gmail read, so I will not label it as live.",
    retrySavedStep: "Retry the saved Gmail step in this same conversation.",
    continueImport: "Continue the saved Gmail import in this same conversation.",
    uncertainRead: "A Gmail page read may have occurred, but its outer checkpoint was not saved. I will not read that page again. Revoke this saved Gmail permission and start a fresh metadata review to continue safely.",
    preReadCheckpointFailed: "I could not save the pre-read safety checkpoint, so no Gmail page was requested. You can retry this saved step."
  };
}

function fallbackAction(language) {
  return {
    ...GMAIL_IN_APP_FALLBACK_ACTION,
    instruction: copy(language).fallback
  };
}

function safeErrorCode(error, fallback) {
  const code = typeof error?.code === "string" ? error.code : fallback;
  return /^[A-Z0-9_:-]{3,80}$/.test(code) ? code : fallback;
}

function opaqueIdentifier(value, field, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !OPAQUE_IDENTIFIER.test(value)) {
    throw new GmailReadOnlyError(
      "GMAIL_OPAQUE_REFERENCE_REQUIRED",
      `I could not safely normalize the Gmail ${field}, so I stopped before exposing or processing source data.`
    );
  }
  return value;
}

function safeTimestamp(value) {
  if (value == null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new GmailReadOnlyError(
      "GMAIL_TIMESTAMP_INVALID",
      "I could not safely normalize one Gmail timestamp, so I stopped before exposing or processing source data."
    );
  }
  return new Date(timestamp).toISOString();
}

function assertNoBodyFields(value, location, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (BODY_FIELD_NAMES.has(normalizedKey)) {
      throw new GmailReadOnlyError(
        "GMAIL_BODY_BOUNDARY_VIOLATION",
        `The Gmail ${location} included source-body data, so I stopped before exposing it.`
      );
    }
    assertNoBodyFields(nested, location, seen);
  }
}

function safeArea(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GMAIL_AREAS.has(normalized) ? normalized : "mail";
}

function requiredApprovedArea(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!GMAIL_AREAS.has(normalized)) {
    throw new GmailReadOnlyError("GMAIL_SCOPE_BOUNDARY_VIOLATION", "Gmail returned a record without a reviewed area, so I stopped before exposing it.");
  }
  return normalized;
}

function requiredApprovedCategory(value) {
  if (value !== "email") {
    throw new GmailReadOnlyError("GMAIL_SCOPE_BOUNDARY_VIOLATION", "Gmail returned a record without the reviewed email category, so I stopped before exposing it.");
  }
  return value;
}

function timestampIsInApprovedRange(timestamp, scope) {
  const timestampMs = Date.parse(timestamp);
  const dateRange = scope?.dateRange;
  const from = Date.parse(dateRange?.from);
  const to = Date.parse(dateRange?.to);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(from) || !Number.isFinite(to) || timestampMs < from || timestampMs > to) return false;
  return !(Array.isArray(scope?.exclusions?.dateRanges) && scope.exclusions.dateRanges.some((range) => {
    const excludedFrom = Date.parse(range?.from);
    const excludedTo = Date.parse(range?.to);
    return Number.isFinite(excludedFrom) && Number.isFinite(excludedTo) && timestampMs >= excludedFrom && timestampMs <= excludedTo;
  }));
}

function normalizeApprovedPageRecord(record, grant) {
  assertNoBodyFields(record, "approved record");
  const scope = grant?.scope;
  const id = opaqueIdentifier(record?.id ?? record?.sourceRecordId, "source reference");
  const threadId = opaqueIdentifier(record?.threadId ?? id, "thread reference");
  const timestamp = safeTimestamp(record?.timestamp);
  const area = requiredApprovedArea(record?.area);
  const category = requiredApprovedCategory(record?.category);
  if (!timestamp || !scope || !timestampIsInApprovedRange(timestamp, scope)
    || (Array.isArray(scope.areas) && scope.areas.length > 0 && !scope.areas.includes(area))
    || scope?.exclusions?.areas?.includes(area)
    || (Array.isArray(scope.categories) && scope.categories.length > 0 && !scope.categories.includes(category))
    || scope?.exclusions?.categories?.includes(category)) {
    throw new GmailReadOnlyError("GMAIL_SCOPE_BOUNDARY_VIOLATION", "Gmail returned a record outside the approved scope, so I stopped before exposing it.");
  }
  return { id, threadId, timestamp };
}

function rootLifecycle(state) {
  if (!state?.installationId) {
    throw new GmailReadOnlyError(
      "SETUP_SESSION_NOT_FOUND",
      "Start your second-brain setup first, then I can guide Gmail in this same conversation."
    );
  }
  if (!state[STATE_KEY]) {
    state[STATE_KEY] = { version: 1, entry: null, audit: [] };
  }
  return state[STATE_KEY];
}

function newEntry(now) {
  return {
    source: SOURCE,
    status: GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED,
    accountId: null,
    reviewId: null,
    publicAliases: {
      account: `local-gmail-account-${randomUUID()}`,
      review: `local-gmail-review-${randomUUID()}`,
      grant: `local-gmail-grant-${randomUUID()}`
    },
    plugin: {
      status: "not-started",
      attempts: 0,
      simulated: null
    },
    grantActivation: {
      status: "not-started",
      grantId: null,
      reviewId: null,
      revocationConfirmed: null,
      updatedAt: now
    },
    connection: {
      readOnly: true,
      live: false,
      state: GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED,
      verifiedAt: null,
      simulationOnly: false
    },
    import: {
      status: "not-started",
      operationRevision: 0,
      pendingPageRead: null,
      pagesCompleted: 0,
      recordsProcessed: 0,
      nextPageToken: null,
      complete: false,
      empty: false,
      processedReferenceIds: [],
      processedPageCheckpoints: [],
      estimatedItemCount: null
    },
    pendingAction: null,
    lastSafeError: null,
    audit: [{ type: "gmail-selected", at: now }]
  };
}

function safeLocalAlias(kind, rawValues, current) {
  const raw = new Set(rawValues.filter((value) => typeof value === "string" && value));
  if (typeof current === "string" && OPAQUE_IDENTIFIER.test(current) && !raw.has(current)) return current;
  for (let index = 1; index <= 9; index += 1) {
    const candidate = `local-gmail-${kind}-${index}`;
    if (!raw.has(candidate)) return candidate;
  }
  throw new GmailReadOnlyError("GMAIL_PUBLIC_ALIAS_UNAVAILABLE", "I could not create a safe local Gmail reference, so I stopped before exposing an adapter identifier.");
}

function gmailPublicAliases(entry, permissionReview = null) {
  const rawAccountId = entry?.accountId ?? permissionReview?.account?.id ?? null;
  const rawReviewId = entry?.reviewId ?? permissionReview?.permissionRequest?.reviewId ?? null;
  const rawGrantId = grantActivation(entry).grantId ?? permissionReview?.activeGrant?.grantId ?? null;
  const rawValues = [
    rawAccountId,
    permissionReview?.account?.id,
    rawReviewId,
    permissionReview?.permissionRequest?.reviewId,
    rawGrantId,
    permissionReview?.activeGrant?.grantId
  ];
  return {
    account: safeLocalAlias("account", rawValues, entry?.publicAliases?.account),
    review: safeLocalAlias("review", rawValues, entry?.publicAliases?.review),
    grant: safeLocalAlias("grant", rawValues, entry?.publicAliases?.grant)
  };
}

function persistGmailPublicAliases(entry, permissionReview = null) {
  entry.publicAliases = gmailPublicAliases(entry, permissionReview);
  return entry.publicAliases;
}

function publicGmailPermissionReview(permissionReview, entry) {
  if (!permissionReview) return null;
  const aliases = gmailPublicAliases(entry, permissionReview);
  const replace = (value, key = null) => {
    if (typeof value === "string") {
      if (key === "accountId") return aliases.account;
      if (key === "reviewId") return aliases.review;
      if (key === "grantId") return aliases.grant;
      return value;
    }
    if (Array.isArray(value)) {
      if (key === "accounts") return value.map(() => aliases.account);
      return value.map((nested) => replace(nested));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([nestedKey, nested]) => [nestedKey, replace(nested, nestedKey)]));
    }
    return value;
  };
  const projected = replace(permissionReview);
  if (projected.account) projected.account.id = aliases.account;
  if (projected.permissionRequest?.account) projected.permissionRequest.account.id = aliases.account;
  return projected;
}

function internalGmailScope(scope, entry) {
  const aliases = gmailPublicAliases(entry);
  const internal = clone(scope);
  if (!internal || typeof internal !== "object" || internal.accountId !== aliases.account) {
    throw new GmailReadOnlyError(
      "GMAIL_PUBLIC_ACCOUNT_REFERENCE_REQUIRED",
      "The Gmail approval did not match the current local account reference, so I kept content access denied."
    );
  }
  internal.accountId = entry.accountId;
  if (Array.isArray(internal.exclusions?.accounts)) {
    internal.exclusions.accounts = internal.exclusions.accounts.map((accountRef) => (
      accountRef === aliases.account ? entry.accountId : accountRef
    ));
  }
  return internal;
}

function getEntry(state) {
  return rootLifecycle(state).entry;
}

function requireEntry(state) {
  const entry = getEntry(state);
  if (!entry) {
    throw new GmailReadOnlyError(
      "GMAIL_NOT_STARTED",
      "Tell me you would like to connect Gmail first, and I will guide the next safe step."
    );
  }
  return entry;
}

function grantActivation(entry, clock) {
  if (!entry.grantActivation || typeof entry.grantActivation !== "object") {
    entry.grantActivation = {
      status: "not-started",
      grantId: null,
      reviewId: null,
      revocationConfirmed: null,
      updatedAt: isoNow(clock)
    };
  }
  return entry.grantActivation;
}

function activationMayRemainActive(entry) {
  return ["pending", "active", "revocation-pending", "revocation-unconfirmed"]
    .includes(grantActivation(entry).status);
}

function setFailure(state, entry, { code, stage, clock, language = "en", externalRevocation = false }) {
  const now = isoNow(clock);
  const revoked = externalRevocation === true || code === "GMAIL_ACCESS_REVOKED";
  entry.status = revoked ? GMAIL_CONNECTION_STATES.REVOKED : GMAIL_CONNECTION_STATES.NEEDS_ATTENTION;
  entry.connection.state = entry.status;
  entry.connection.live = false;
  entry.import.status = revoked ? "revoked" : "paused-after-error";
  entry.pendingAction = revoked ? null : { kind: "retry-saved-gmail-step", message: copy(language).retrySavedStep };
  entry.lastSafeError = { code, stage, at: now };
  entry.audit.push({ type: revoked ? "gmail-access-revoked" : "gmail-safe-failure", at: now, code, stage, bodiesExposed: false });
  rootLifecycle(state).audit.push({ type: revoked ? "gmail-access-revoked" : "gmail-safe-failure", at: now, code, stage, bodiesExposed: false });
}

function importOperationRevision(entry) {
  return Number.isSafeInteger(entry?.import?.operationRevision) && entry.import.operationRevision >= 0
    ? entry.import.operationRevision
    : 0;
}

function pendingPageRead(entry) {
  const pending = entry?.import?.pendingPageRead;
  return pending && typeof pending === "object" && !Array.isArray(pending) ? pending : null;
}

function unresolvedPendingPageRead(entry) {
  if (!pendingPageRead(entry)) return false;
  return ![
    GMAIL_CONNECTION_STATES.REVOKED,
    GMAIL_CONNECTION_STATES.SKIPPED,
    GMAIL_CONNECTION_STATES.UNSUPPORTED
  ].includes(entry.status);
}

function pendingReadRecoveryAction(language) {
  return {
    kind: "revoke-and-start-fresh-gmail-review",
    message: copy(language).uncertainRead
  };
}

function pendingReadError(entry) {
  const pending = pendingPageRead(entry);
  return {
    code: "GMAIL_PAGE_READ_CHECKPOINT_UNCERTAIN",
    stage: "approved-read-checkpoint",
    at: pending?.startedAt ?? null,
    readMayHaveOccurred: true
  };
}

const PUBLIC_GMAIL_AUDIT_FIELDS = new Set([
  "type",
  "at",
  "code",
  "bodiesExposed",
  "simulated",
  "actualRead",
  "page",
  "recordCount",
  "nextCheckpoint",
  "estimatedItemCount",
  "readMayHaveOccurred",
  "sourceReadAttempted",
  "permissionRevocationConfirmed"
]);

function publicAudit(events) {
  return events.map((event) => Object.fromEntries(
    Object.entries(event)
      .filter(([key]) => PUBLIC_GMAIL_AUDIT_FIELDS.has(key))
      .map(([key, value]) => [key, clone(value)])
  ));
}

function pendingGenerationMatches(entry, expected) {
  const current = pendingPageRead(entry);
  return Boolean(current
    && expected
    && importOperationRevision(entry) === expected.operationRevision
    && current.operationId === expected.operationId
    && current.operationRevision === expected.operationRevision
    && current.reviewId === expected.reviewId
    && current.grantId === expected.grantId
    && current.checkpoint === expected.checkpoint
    && current.startedAt === expected.startedAt);
}

function setPendingPageReadFailure(state, entry, { error, code, stage, clock, language }) {
  const pending = pendingPageRead(entry);
  const now = isoNow(clock);
  const failureCode = code ?? safeErrorCode(error, "GMAIL_PAGE_READ_CHECKPOINT_UNCERTAIN");
  entry.status = GMAIL_CONNECTION_STATES.NEEDS_ATTENTION;
  entry.connection.state = GMAIL_CONNECTION_STATES.NEEDS_ATTENTION;
  entry.connection.live = false;
  entry.import.status = "read-may-have-occurred";
  entry.pendingAction = pendingReadRecoveryAction(language);
  entry.lastSafeError = {
    code: failureCode,
    ...(failureCode === "GMAIL_PAGE_READ_CHECKPOINT_UNCERTAIN" && error ? { causeCode: safeErrorCode(error, "GMAIL_PAGE_CHECKPOINT_SAVE_FAILED") } : {}),
    stage,
    at: now,
    readMayHaveOccurred: true
  };
  if (!entry.audit.some((event) => event.type === "gmail-page-read-checkpoint-uncertain" && event.operationId === pending?.operationId)) {
    entry.audit.push({
      type: "gmail-page-read-checkpoint-uncertain",
      at: now,
      operationId: pending?.operationId ?? null,
      operationRevision: pending?.operationRevision ?? null,
      code: failureCode,
      readMayHaveOccurred: true,
      bodiesExposed: false
    });
    rootLifecycle(state).audit.push({
      type: "gmail-page-read-checkpoint-uncertain",
      at: now,
      operationRevision: pending?.operationRevision ?? null,
      code: failureCode,
      readMayHaveOccurred: true,
      bodiesExposed: false
    });
  }
}

function statusMessage(entry, language) {
  const wording = copy(language);
  if (unresolvedPendingPageRead(entry)) return wording.uncertainRead;
  if (entry.status === GMAIL_CONNECTION_STATES.REVOKED) return wording.revoked;
  if (entry.status === GMAIL_CONNECTION_STATES.SKIPPED) return wording.skipped;
  if (entry.status === GMAIL_CONNECTION_STATES.UNSUPPORTED) return wording.unsupported;
  if (entry.status === GMAIL_CONNECTION_STATES.NEEDS_ATTENTION) return wording.needsAttention;
  if (entry.plugin.status === "cancelled") return wording.cancelled;
  if (entry.import.status === "checkpoint-required") return wording.checkpoint;
  if (entry.connection.simulationOnly && entry.import.status === "complete" && entry.import.empty) return wording.simulatedEmpty;
  if (entry.import.status === "complete" && entry.import.empty) return wording.empty;
  if (entry.connection.simulationOnly && entry.import.recordsProcessed > 0) return wording.simulatedVerified;
  if (entry.import.status === "ready-to-verify") return wording.scopeGranted;
  if (entry.reviewId) return wording.reviewReady;
  if (entry.plugin.status === "connected") return wording.connected;
  return wording.start;
}

function publicView(entry, language, permissionReview = null) {
  // This candidate deliberately has no registered official-host integration.
  // Persisted or injected fields must therefore never turn its Gmail view into
  // a live verification claim. A future host-owned integration must expose its
  // evidence through a separately reviewed, non-public boundary.
  const readMayHaveOccurred = unresolvedPendingPageRead(entry);
  const status = readMayHaveOccurred
    ? GMAIL_CONNECTION_STATES.NEEDS_ATTENTION
    : entry.status === GMAIL_CONNECTION_STATES.LIVE_AND_VERIFIED
    ? GMAIL_CONNECTION_STATES.NEEDS_ATTENTION
    : entry.status;
  const aliases = gmailPublicAliases(entry, permissionReview);
  return {
    source: SOURCE,
    status,
    message: statusMessage(entry, language),
    connection: {
      state: status,
      live: false,
      readOnly: true,
      verifiedAt: null,
      simulationOnly: true,
      canSendMail: false,
      canLabelMail: false,
      canArchiveMail: false,
      canDeleteMail: false,
      canModifyMail: false
    },
    plugin: {
      status: entry.plugin.status,
      simulated: true
    },
    grantLifecycle: {
      status: grantActivation(entry).status,
      cleanupRequired: activationMayRemainActive(entry),
      revocationConfirmed: grantActivation(entry).revocationConfirmed === true
    },
    account: entry.accountId ? { context: aliases.account } : null,
    import: {
      status: readMayHaveOccurred ? "read-may-have-occurred" : entry.import.status,
      pagesCompleted: entry.import.pagesCompleted,
      recordsProcessed: entry.import.recordsProcessed,
      estimatedItemCount: entry.import.estimatedItemCount,
      checkpointPending: typeof entry.import.nextPageToken === "string",
      readMayHaveOccurred,
      recoveryRequiresFreshReview: readMayHaveOccurred,
      complete: entry.import.complete,
      empty: entry.import.empty
    },
    nextAction: readMayHaveOccurred ? pendingReadRecoveryAction(language) : entry.pendingAction ? clone(entry.pendingAction) : null,
    lastSafeError: readMayHaveOccurred ? clone(entry.lastSafeError ?? pendingReadError(entry)) : entry.lastSafeError ? clone(entry.lastSafeError) : null,
    permissionReview: publicGmailPermissionReview(permissionReview, entry),
    // Review ids, grant ids, pending operation ids/revisions, and raw page
    // checkpoints remain private lifecycle state rather than status output.
    audit: publicAudit(entry.audit)
  };
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  rootLifecycle(state);
  return state;
}

function assertPluginMethod(plugin, method, message) {
  if (!plugin || typeof plugin[method] !== "function") {
    throw new GmailReadOnlyError("GMAIL_PLUGIN_CONTRACT_REQUIRED", message);
  }
}

function exactGrantRevocationConfirmation(value, grantId) {
  const status = typeof value?.status === "string" ? value.status : null;
  return Boolean(
    value
    && typeof value === "object"
    && value.grantId === grantId
    && !["active", "authorized", "granted"].includes(status)
    && value.active !== true
    && value.revoked !== false
    && (
      value.revoked === true
      || value.active === false
      || ["revoked", "not-found", "inactive"].includes(status)
    )
  );
}

async function revokePluginGrantWithExactConfirmation(plugin, grantId) {
  assertPluginMethod(plugin, "revokePermissionGrant", "A Gmail plugin with grant revocation is required.");
  const result = await plugin.revokePermissionGrant({ grantId });
  if (exactGrantRevocationConfirmation(result, grantId)) return true;
  if (typeof plugin.getPermissionGrantStatus === "function") {
    const readback = await plugin.getPermissionGrantStatus({ grantId });
    if (exactGrantRevocationConfirmation(readback, grantId)) return true;
  }
  throw new GmailReadOnlyError(
    "GMAIL_PLUGIN_REVOCATION_UNCONFIRMED",
    "Gmail did not explicitly confirm that the exact saved permission was revoked, so I kept this source in needs-attention state."
  );
}

function pluginIsSimulated() {
  // All injectable plugins in this simulation/local contract are deliberately
  // non-live, even when their caller-controlled fields claim otherwise.
  return true;
}

function normalizeMetadataResult(result) {
  if (!result || typeof result !== "object" || result.readOnly !== true) {
    throw new GmailReadOnlyError(
      "GMAIL_READ_ONLY_METADATA_REQUIRED",
      "Gmail did not confirm a read-only metadata response, so I stopped before requesting content access."
    );
  }
  assertNoBodyFields(result, "metadata response");
  const accountId = opaqueIdentifier(result.account?.id, "account context");
  const samples = Array.isArray(result.items) ? result.items : [];
  const items = samples.map((item, index) => {
    assertNoBodyFields(item, "metadata item");
    return {
      id: opaqueIdentifier(item?.id, "metadata reference"),
      kind: "item",
      area: safeArea(item?.area),
      category: "email",
      timestamp: safeTimestamp(item?.timestamp),
      // Do not carry a source title, participant, address, label, or snippet
      // into the public metadata review. This slice only needs counts/scopes.
      label: `Gmail item ${index + 1}`
    };
  });
  const estimated = Number.isSafeInteger(result.estimatedItemCount) && result.estimatedItemCount >= items.length
    ? result.estimatedItemCount
    : items.length;
  return {
    accountId,
    items,
    estimatedItemCount: estimated,
    paginationExpected: result.paginationExpected === true || estimated > items.length
  };
}

function normalizePageResult(result, { accountId, accountAlias, grant }) {
  if (!result || typeof result !== "object") {
    throw new GmailReadOnlyError("GMAIL_PAGE_INVALID", "Gmail did not return a safe approved page, so I stopped before exposing source data.");
  }
  if (result.status === "revoked" || result.access === "revoked") {
    throw new GmailReadOnlyError("GMAIL_ACCESS_REVOKED", "Gmail access was revoked before this approved read could finish.");
  }
  if (result.readOnly !== true || result.rawBodiesReturned === true) {
    throw new GmailReadOnlyError("GMAIL_BODY_BOUNDARY_VIOLATION", "Gmail did not preserve the read-only source-body boundary, so I stopped before exposing source data.");
  }
  assertNoBodyFields(result, "approved-page response");
  const simulated = pluginIsSimulated();
  if (!Array.isArray(result.records)) {
    throw new GmailReadOnlyError("GMAIL_PAGE_INVALID", "Gmail did not return a safe approved page, so I stopped before exposing source data.");
  }
  const references = result.records.map((record) => {
    const { id, threadId, timestamp } = normalizeApprovedPageRecord(record, grant);
    return {
      source: SOURCE,
      sourceRecordId: `gmail:${id}`,
      accountContext: accountAlias,
      threadReference: `gmail-thread:${threadId}`,
      timestamp,
      processingDisposition: "untrusted-inert-reference"
    };
  });
  return {
    simulated,
    actualRead: result.actualRead === true,
    references,
    nextPageToken: opaqueIdentifier(result.nextPageToken, "page checkpoint", { nullable: true })
  };
}

/**
 * Narrow adapter handed to QWA-139. Its only fetch primitive is one bounded
 * approved page; lifecycle code persists the checkpoint between pages.
 */
export class GmailReadOnlyConnector {
  constructor({ plugin, pageToken = null, pageSize = 50, publicAccountAlias = "local-gmail-account-1" } = {}) {
    this.plugin = plugin;
    this.pageToken = opaqueIdentifier(pageToken, "page checkpoint", { nullable: true });
    this.publicAccountAlias = opaqueIdentifier(publicAccountAlias, "local account reference");
    this.pageSize = Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 100 ? pageSize : 50;
    this.lastMetadata = null;
    this.lastPage = null;
  }

  async discoverMetadata({ source }) {
    if (source !== SOURCE) throw new GmailReadOnlyError("GMAIL_SOURCE_MISMATCH", "The Gmail metadata source did not match the requested connection.");
    assertPluginMethod(this.plugin, "discoverMetadata", "A Gmail plugin with metadata discovery is required.");
    const metadata = normalizeMetadataResult(await this.plugin.discoverMetadata({ source: SOURCE }));
    this.lastMetadata = metadata;
    return {
      source: SOURCE,
      account: { id: metadata.accountId, label: "Selected Gmail account" },
      readOnly: true,
      people: [],
      items: metadata.items
    };
  }

  async registerPermissionGrant({ grant }) {
    assertPluginMethod(this.plugin, "registerPermissionGrant", "A Gmail plugin with grant registration is required.");
    await this.plugin.registerPermissionGrant({ grant: clone(grant) });
  }

  async revokePermissionGrant({ grantId }) {
    await revokePluginGrantWithExactConfirmation(this.plugin, grantId);
  }

  async fetchApprovedContent({ source, accountId, grant }) {
    if (source !== SOURCE || grant?.source !== SOURCE || grant?.accountId !== accountId || grant?.status !== "active") {
      throw new GmailReadOnlyError("GMAIL_GRANT_MISMATCH", "The saved Gmail approval did not match this read-only request, so no mail was read.");
    }
    assertPluginMethod(this.plugin, "fetchApprovedPage", "A Gmail plugin with bounded approved-page fetch is required.");
    const page = normalizePageResult(
      await this.plugin.fetchApprovedPage({
        source: SOURCE,
        accountId,
        grant: clone(grant),
        pageToken: this.pageToken,
        pageSize: this.pageSize
      }),
      { accountId, accountAlias: this.publicAccountAlias, grant }
    );
    this.lastPage = page;
    return {
      rawBodiesReturned: false,
      records: page.references.map((reference) => ({
        source: SOURCE,
        sourceRecordId: reference.sourceRecordId
      }))
    };
  }
}

function prepareFreshEntry(state, clock) {
  const records = rootLifecycle(state);
  const existing = records.entry;
  if (!existing || existing.status === GMAIL_CONNECTION_STATES.REVOKED || existing.status === GMAIL_CONNECTION_STATES.SKIPPED) {
    const entry = newEntry(isoNow(clock));
    if (existing) entry.audit.unshift(...existing.audit, { type: "gmail-new-review-after-final-state", at: isoNow(clock) });
    records.entry = entry;
  }
  return records.entry;
}

function validateConnectionResult(result) {
  const status = result?.status;
  if (status === "connected") {
    if (result.readOnly !== true) {
      throw new GmailReadOnlyError("GMAIL_PLUGIN_NOT_READ_ONLY", "The Gmail plugin did not confirm read-only access, so I stopped before reviewing metadata.");
    }
    return "connected";
  }
  if (status === "cancelled") return "cancelled";
  if (status === "action-required" || status === "unavailable") return "action-required";
  if (status === "unsupported") return "unsupported";
  throw new GmailReadOnlyError("GMAIL_PLUGIN_CONNECTION_FAILED", "I could not safely start the Gmail connection. No mail was read or changed.");
}

/**
 * Starts only the Gmail plugin connection. Without a host-provided initiation
 * function it gives exactly one in-app fallback action and performs no source
 * access. A successful plugin connection still is not a live verification.
 */
async function beginGmailConnectionInternal({ message, stateStore, plugin, language, clock } = {}) {
  assertNaturalLanguage(message, "start");
  const state = await loadState(stateStore);
  const entry = prepareFreshEntry(state, clock);
  const locale = languageFor(state, language);

  if (entry.plugin.status === "connected") {
    const permission = entry.accountId ? await getSourcePermissionStatusWithinStateLock({ stateStore, source: SOURCE, accountId: entry.accountId, language: locale }) : null;
    return { gmail: publicView(entry, locale, permission?.permissionReview) };
  }

  entry.plugin.attempts += 1;
  entry.pendingAction = null;
  entry.lastSafeError = null;
  try {
    if (!plugin || typeof plugin.initiateReadOnlyConnection !== "function") {
      entry.plugin.status = "action-required";
      entry.plugin.simulated = null;
      entry.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
      entry.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
      entry.pendingAction = fallbackAction(locale);
      entry.audit.push({ type: "gmail-in-app-fallback-presented", at: isoNow(clock), bodiesExposed: false });
    } else {
      const result = await plugin.initiateReadOnlyConnection({ source: SOURCE, purpose: "Start a Gmail metadata-only review after customer request." });
      const connectionStatus = validateConnectionResult(result);
      entry.plugin.status = connectionStatus;
      entry.plugin.simulated = pluginIsSimulated();
      entry.connection.simulationOnly = entry.plugin.simulated === true;
      if (connectionStatus === "connected") {
        entry.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
        entry.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
        entry.audit.push({ type: "gmail-plugin-connected", at: isoNow(clock), simulated: entry.plugin.simulated, bodiesExposed: false });
      } else if (connectionStatus === "cancelled") {
        entry.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
        entry.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
        entry.pendingAction = fallbackAction(locale);
        entry.audit.push({ type: "gmail-plugin-connection-cancelled", at: isoNow(clock), bodiesExposed: false });
      } else if (connectionStatus === "unsupported") {
        entry.status = GMAIL_CONNECTION_STATES.UNSUPPORTED;
        entry.connection.state = GMAIL_CONNECTION_STATES.UNSUPPORTED;
        entry.audit.push({ type: "gmail-plugin-unsupported", at: isoNow(clock), bodiesExposed: false });
      } else {
        entry.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
        entry.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
        entry.pendingAction = fallbackAction(locale);
        entry.audit.push({ type: "gmail-in-app-fallback-presented", at: isoNow(clock), bodiesExposed: false });
      }
    }
  } catch (error) {
    setFailure(state, entry, { code: safeErrorCode(error, "GMAIL_PLUGIN_CONNECTION_FAILED"), stage: "plugin-connection", clock, language: locale });
  }
  await stateStore.save(state);
  return { gmail: publicView(entry, locale) };
}

export async function beginGmailConnection(args = {}) {
  return withSourcePermissionStateLock(args?.stateStore, () => beginGmailConnectionInternal(args));
}

/** Runs the QWA-139 metadata-only preflight after a saved Gmail plugin connection. */
async function beginGmailPrivacyReviewInternal({ message, stateStore, plugin, language, clock, reviewIdFactory } = {}) {
  assertNaturalLanguage(message, "start");
  const initial = await loadState(stateStore);
  const entry = requireEntry(initial);
  const locale = languageFor(initial, language);
  if (entry.plugin.status !== "connected") {
    entry.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    entry.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    entry.pendingAction = fallbackAction(locale);
    await stateStore.save(initial);
    return { gmail: publicView(entry, locale) };
  }

  const connector = new GmailReadOnlyConnector({ plugin });
  try {
    const review = await beginSourcePermissionReviewWithinStateLock({
      message,
      stateStore,
      connector,
      source: SOURCE,
      language: locale,
      clock,
      reviewIdFactory
    });
    const state = await loadState(stateStore);
    const updated = requireEntry(state);
    updated.accountId = review.permissionReview.account.id;
    updated.reviewId = review.permissionReview.permissionRequest.reviewId;
    updated.publicAliases = {
      account: updated.publicAliases?.account,
      review: `local-gmail-review-${randomUUID()}`,
      grant: `local-gmail-grant-${randomUUID()}`
    };
    persistGmailPublicAliases(updated, review.permissionReview);
    updated.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    updated.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    updated.import.estimatedItemCount = connector.lastMetadata?.estimatedItemCount ?? null;
    updated.import.status = "awaiting-grant";
    updated.pendingAction = null;
    updated.lastSafeError = null;
    updated.audit.push({
      type: "gmail-metadata-preflight",
      at: isoNow(clock),
      reviewId: updated.reviewId,
      estimatedItemCount: updated.import.estimatedItemCount,
      bodiesExposed: false
    });
    await stateStore.save(state);
    return { gmail: publicView(updated, locale, review.permissionReview) };
  } catch (error) {
    const state = await loadState(stateStore);
    const updated = requireEntry(state);
    setFailure(state, updated, { code: safeErrorCode(error, "GMAIL_METADATA_REVIEW_FAILED"), stage: "metadata-preflight", clock, language: locale });
    await stateStore.save(state);
    return { gmail: publicView(updated, locale), recoverable: true };
  }
}

export async function beginGmailPrivacyReview(args = {}) {
  return withSourcePermissionStateLock(args?.stateStore, () => beginGmailPrivacyReviewInternal(args));
}

/** Saves a granular QWA-139 grant; it does not read Gmail itself. */
async function grantGmailReadOnlyScopeInternal({ message, stateStore, plugin, scope, language, clock, grantIdFactory } = {}) {
  assertNaturalLanguage(message, "grant");
  const initial = await loadState(stateStore);
  const entry = requireEntry(initial);
  const locale = languageFor(initial, language);
  if (!entry.accountId || !entry.reviewId || entry.status === GMAIL_CONNECTION_STATES.REVOKED) {
    throw new GmailReadOnlyError("GMAIL_REVIEW_REQUIRED", "Complete the saved Gmail metadata review before approving content access.");
  }
  const approvedInternalScope = internalGmailScope(scope, entry);
  const existingPermission = await getSourcePermissionStatusWithinStateLock({
    stateStore,
    source: SOURCE,
    accountId: entry.accountId,
    language: locale
  });
  const activation = grantActivation(entry, clock);
  if (activation.status === "active"
    && existingPermission?.permissionReview?.activeGrant?.grantId === activation.grantId) {
    return { gmail: publicView(entry, locale, existingPermission.permissionReview) };
  }
  if (existingPermission?.permissionReview?.activeGrant && activation.status === "not-started") {
    // Upgrade an earlier persisted generic grant into the durable Gmail
    // activation record without minting or registering a second identifier.
    entry.grantActivation = {
      status: "active",
      grantId: existingPermission.permissionReview.activeGrant.grantId,
      reviewId: entry.reviewId,
      revocationConfirmed: false,
      updatedAt: isoNow(clock)
    };
    entry.import.status = "ready-to-verify";
    entry.pendingAction = null;
    entry.lastSafeError = null;
    entry.audit.push({
      type: "gmail-existing-grant-activation-checkpoint-migrated",
      at: isoNow(clock),
      reviewId: entry.reviewId,
      bodiesExposed: false
    });
    await stateStore.save(initial);
    return { gmail: publicView(entry, locale, existingPermission.permissionReview) };
  }
  if (existingPermission?.permissionReview?.activeGrant) {
    setFailure(initial, entry, {
      code: "GMAIL_GRANT_GENERATION_MISMATCH",
      stage: "grant-recovery",
      clock,
      language: locale
    });
    await stateStore.save(initial);
    return { gmail: publicView(entry, locale, existingPermission.permissionReview), recoverable: true };
  }
  if (activationMayRemainActive(entry)) {
    setFailure(initial, entry, {
      code: "GMAIL_GRANT_CLEANUP_REQUIRED",
      stage: "grant-recovery",
      clock,
      language: locale
    });
    await stateStore.save(initial);
    return { gmail: publicView(entry, locale, existingPermission?.permissionReview), recoverable: true };
  }

  const durableGrantId = opaqueIdentifier(
    (grantIdFactory ?? (() => `permission-grant-${randomUUID()}`))(),
    "permission grant"
  );
  const activationStartedAt = isoNow(clock);
  entry.grantActivation = {
    status: "pending",
    grantId: durableGrantId,
    reviewId: entry.reviewId,
    revocationConfirmed: false,
    updatedAt: activationStartedAt
  };
  entry.audit.push({
    type: "gmail-grant-activation-checkpoint-saved",
    at: activationStartedAt,
    reviewId: entry.reviewId,
    bodiesExposed: false
  });
  try {
    // The adapter receives only an identifier that was already durably saved.
    // If any later full-root save fails, recovery can still revoke this exact
    // plugin-side activation instead of losing its identity.
    await stateStore.save(initial);
  } catch (error) {
    setFailure(initial, entry, {
      code: safeErrorCode(error, "GMAIL_GRANT_CHECKPOINT_SAVE_FAILED"),
      stage: "grant-checkpoint",
      clock,
      language: locale
    });
    return { gmail: publicView(entry, locale, existingPermission?.permissionReview), recoverable: true };
  }

  const connector = new GmailReadOnlyConnector({ plugin });
  let cleanupGrantId = durableGrantId;
  try {
    const granted = await grantSourcePermissionWithinStateLock({
      message,
      stateStore,
      connector,
      source: SOURCE,
      accountId: entry.accountId,
      reviewId: entry.reviewId,
      scope: approvedInternalScope,
      language: locale,
      clock,
      grantIdFactory: () => durableGrantId
    });
    const state = await loadState(stateStore);
    const updated = requireEntry(state);
    const activeGrantId = granted.permissionReview?.activeGrant?.grantId ?? durableGrantId;
    cleanupGrantId = activeGrantId;
    updated.grantActivation = {
      status: "active",
      grantId: activeGrantId,
      reviewId: updated.reviewId,
      revocationConfirmed: false,
      updatedAt: isoNow(clock)
    };
    persistGmailPublicAliases(updated, granted.permissionReview);
    updated.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    updated.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    updated.import.status = "ready-to-verify";
    updated.pendingAction = null;
    updated.lastSafeError = null;
    updated.audit.push({ type: "gmail-read-only-grant-active", at: isoNow(clock), reviewId: updated.reviewId, bodiesExposed: false });
    await stateStore.save(state);
    return { gmail: publicView(updated, locale, granted.permissionReview) };
  } catch (error) {
    const cleanup = await deactivatePersistedGmailGrant({
      stateStore,
      plugin,
      accountId: entry.accountId,
      reviewId: entry.reviewId,
      grantId: cleanupGrantId,
      language: locale,
      clock
    });
    const state = await loadState(stateStore);
    const updated = requireEntry(state);
    updated.grantActivation = {
      status: cleanup.confirmed ? "revoked-after-failure" : "revocation-unconfirmed",
      grantId: cleanupGrantId,
      reviewId: entry.reviewId,
      revocationConfirmed: cleanup.confirmed,
      updatedAt: isoNow(clock)
    };
    setFailure(state, updated, {
      code: cleanup.confirmed
        ? safeErrorCode(error, "GMAIL_GRANT_FAILED")
        : "GMAIL_GRANT_REVOCATION_UNCONFIRMED",
      stage: cleanup.confirmed ? "grant" : "grant-cleanup",
      clock,
      language: locale
    });
    updated.audit.push({
      type: cleanup.confirmed ? "gmail-failed-grant-cleanup-confirmed" : "gmail-failed-grant-cleanup-unconfirmed",
      at: isoNow(clock),
      reviewId: entry.reviewId,
      bodiesExposed: false
    });
    await stateStore.save(state);
    return { gmail: publicView(updated, locale, cleanup.permissionReview), recoverable: true };
  }
}

export async function grantGmailReadOnlyScope(args = {}) {
  return withSourcePermissionStateLock(args?.stateStore, () => grantGmailReadOnlyScopeInternal(args));
}

/** Cancels the saved review without reading mail; a later retry must start a fresh metadata review. */
async function cancelGmailReadOnlyScopeInternal({ message, stateStore, language, clock } = {}) {
  assertNaturalLanguage(message, "cancel");
  const initial = await loadState(stateStore);
  const entry = requireEntry(initial);
  const locale = languageFor(initial, language);
  if (!entry.accountId || !entry.reviewId) {
    throw new GmailReadOnlyError("GMAIL_REVIEW_REQUIRED", "There is no saved Gmail review to cancel yet.");
  }
  const denied = await denySourcePermissionWithinStateLock({
    message,
    stateStore,
    source: SOURCE,
    accountId: entry.accountId,
    reviewId: entry.reviewId,
    language: locale,
    clock
  });
  const state = await loadState(stateStore);
  const updated = requireEntry(state);
  updated.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
  updated.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
  updated.import.status = "cancelled";
  updated.pendingAction = null;
  updated.audit.push({ type: "gmail-permission-cancelled", at: isoNow(clock), reviewId: updated.reviewId, bodiesExposed: false });
  await stateStore.save(state);
  return { gmail: publicView(updated, locale, denied.permissionReview), message: copy(locale).permissionCancelled };
}

export async function cancelGmailReadOnlyScope(args = {}) {
  return withSourcePermissionStateLock(args?.stateStore, () => cancelGmailReadOnlyScopeInternal(args));
}

function pageBudget(value) {
  if (value == null) return DEFAULT_PAGE_BUDGET;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_BUDGET) {
    throw new GmailReadOnlyError("GMAIL_PAGE_BUDGET_INVALID", "Use a small bounded Gmail page budget so a large account is processed in checkpoints.");
  }
  return value;
}

function appendUniqueReferences(entry, references) {
  const seen = new Set(entry.import.processedReferenceIds);
  const newlyProcessed = [];
  for (const reference of references) {
    if (seen.has(reference.sourceRecordId)) continue;
    seen.add(reference.sourceRecordId);
    entry.import.processedReferenceIds.push(reference.sourceRecordId);
    newlyProcessed.push(reference);
  }
  entry.import.recordsProcessed = entry.import.processedReferenceIds.length;
  return newlyProcessed;
}

function pageCheckpointHistory(entry) {
  if (!Array.isArray(entry.import.processedPageCheckpoints)) entry.import.processedPageCheckpoints = [];
  return entry.import.processedPageCheckpoints;
}

function pageMatchesGenericBoundary(page, approvedRecords) {
  const expected = page.references.map((reference) => reference.sourceRecordId).sort();
  const actual = approvedRecords.map((record) => record.sourceRecordId).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new GmailReadOnlyError("GMAIL_REFERENCE_NORMALIZATION_FAILED", "The approved Gmail reference boundary changed unexpectedly, so I stopped before exposing any source data.");
  }
}

const LOCAL_GMAIL_GRANT_REVOCATION_CONNECTOR = Object.freeze({
  async revokePermissionGrant() {
    // This only invalidates the local QWA-139 grant. It does not invoke Gmail
    // or represent a remote revocation claim.
  }
});

/**
 * Closes the plugin-side identifier first, then reconciles the generic local
 * grant if it was durably saved. Success means both boundaries were observed
 * closed; an exception or unverifiable readback remains retryable and is never
 * presented as confirmed revocation.
 */
async function deactivatePersistedGmailGrant({
  stateStore,
  plugin,
  accountId,
  reviewId,
  grantId,
  language,
  clock
}) {
  if (!plugin || typeof plugin.revokePermissionGrant !== "function" || typeof grantId !== "string") {
    return { confirmed: false, permissionReview: null, code: "GMAIL_PLUGIN_REVOCATION_REQUIRED" };
  }

  try {
    await revokePluginGrantWithExactConfirmation(plugin, grantId);
  } catch (error) {
    return {
      confirmed: false,
      permissionReview: null,
      code: safeErrorCode(error, "GMAIL_PLUGIN_REVOCATION_FAILED")
    };
  }

  if (!accountId || !reviewId) {
    return { confirmed: true, permissionReview: null, code: null };
  }

  let current;
  try {
    current = await getSourcePermissionStatusWithinStateLock({ stateStore, source: SOURCE, accountId, language });
  } catch (error) {
    return {
      confirmed: false,
      permissionReview: null,
      code: safeErrorCode(error, "GMAIL_LOCAL_REVOCATION_READBACK_FAILED")
    };
  }

  if (current?.permissionReview?.activeGrant
    && current.permissionReview.activeGrant.grantId !== grantId) {
    try {
      // Both identifiers can be real after an interrupted migration. Close
      // the generic generation too; never clear its local record after only
      // revoking the separately checkpointed plugin generation.
      await revokePluginGrantWithExactConfirmation(plugin, current.permissionReview.activeGrant.grantId);
    } catch (error) {
      return {
        confirmed: false,
        permissionReview: current.permissionReview,
        code: safeErrorCode(error, "GMAIL_GRANT_GENERATION_MISMATCH")
      };
    }
  }

  if (current?.permissionReview?.activeGrant) {
    try {
      await revokeSourcePermissionWithinStateLock({
        message: language === "es" ? "Revocar el permiso guardado de Gmail" : "Revoke the saved Gmail permission",
        stateStore,
        connector: LOCAL_GMAIL_GRANT_REVOCATION_CONNECTOR,
        source: SOURCE,
        accountId,
        reviewId,
        language,
        clock
      });
    } catch (error) {
      // A save can fail after the in-memory transition. Always read the
      // durable state again rather than inferring success from the exception.
      let afterFailure = null;
      try {
        afterFailure = await getSourcePermissionStatusWithinStateLock({ stateStore, source: SOURCE, accountId, language });
      } catch {
        // The caller will retain the identifier as revocation-unconfirmed.
      }
      if (afterFailure?.permissionReview?.activeGrant) {
        return {
          confirmed: false,
          permissionReview: afterFailure.permissionReview,
          code: safeErrorCode(error, "GMAIL_LOCAL_REVOCATION_FAILED")
        };
      }
      if (!afterFailure) {
        return {
          confirmed: false,
          permissionReview: null,
          code: safeErrorCode(error, "GMAIL_LOCAL_REVOCATION_READBACK_FAILED")
        };
      }
    }
  }

  try {
    const after = await getSourcePermissionStatusWithinStateLock({ stateStore, source: SOURCE, accountId, language });
    return {
      confirmed: !after?.permissionReview?.activeGrant,
      permissionReview: after?.permissionReview ?? null,
      code: after?.permissionReview?.activeGrant ? "GMAIL_LOCAL_REVOCATION_UNCONFIRMED" : null
    };
  } catch (error) {
    return {
      confirmed: false,
      permissionReview: null,
      code: safeErrorCode(error, "GMAIL_LOCAL_REVOCATION_READBACK_FAILED")
    };
  }
}

async function synchronizeExternalRevocation({ stateStore, plugin, entry, language, clock }) {
  if (!entry.accountId || !entry.reviewId) return { confirmed: true, permissionReview: null, grantId: null };
  let permission = null;
  try {
    permission = await getSourcePermissionStatusWithinStateLock({
      stateStore,
      source: SOURCE,
      accountId: entry.accountId,
      language
    });
  } catch {
    return { confirmed: false, permissionReview: null, grantId: null, code: "GMAIL_LOCAL_REVOCATION_READBACK_FAILED" };
  }
  const activation = grantActivation(entry, clock);
  const grantId = (activationMayRemainActive(entry) ? activation.grantId : null)
    ?? permission?.permissionReview?.activeGrant?.grantId
    ?? null;
  if (!grantId) return { confirmed: true, permissionReview: permission?.permissionReview ?? null, grantId: null };
  const cleanup = await deactivatePersistedGmailGrant({
    stateStore,
    plugin,
    accountId: entry.accountId,
    reviewId: entry.reviewId,
    grantId,
    language,
    clock
  });
  return { ...cleanup, grantId };
}

async function persistPendingPageReadFailure({
  stateStore,
  expectedPending,
  error,
  code,
  stage,
  language,
  clock
}) {
  const state = await loadState(stateStore);
  const entry = requireEntry(state);
  if (!pendingGenerationMatches(entry, expectedPending)) {
    code = "GMAIL_PAGE_READ_GENERATION_MISMATCH";
    stage = "approved-read-generation";
  }
  setPendingPageReadFailure(state, entry, { error, code, stage, clock, language });
  let persisted = false;
  try {
    // Do not clear or rewrite pendingPageRead. This save only makes the
    // customer-facing needs-attention state explicit. If it also fails, the
    // already durable pending generation still projects the same safe truth.
    await stateStore.save(state);
    persisted = true;
  } catch {
    // The immutable pre-read generation is itself the durable recovery marker.
  }
  return { state, entry, persisted };
}

async function gmailPermissionReview({ stateStore, entry, language }) {
  if (!entry.accountId) return null;
  try {
    return await getSourcePermissionStatusWithinStateLock({
      stateStore,
      source: SOURCE,
      accountId: entry.accountId,
      language
    });
  } catch {
    return null;
  }
}

function pendingReadResult({ entry, language, permissionReview, approvedReferences = [] }) {
  return {
    gmail: publicView(entry, language, permissionReview?.permissionReview),
    approvedReferences,
    complete: false,
    checkpointRequired: false,
    recoverable: true,
    recoveryRequired: true
  };
}

/**
 * Fetches bounded opaque references only after QWA-139 has persisted a grant.
 * Each page is committed as a checkpoint, so a later interruption resumes from
 * the exact next opaque page token instead of restarting a large account.
 */
async function fetchApprovedGmailReferencesInternal({ message, stateStore, plugin, language, clock, maxPages } = {}) {
  assertNaturalLanguage(message, "fetch");
  const budget = pageBudget(maxPages);
  let state = await loadState(stateStore);
  let entry = requireEntry(state);
  const locale = languageFor(state, language);
  if (!entry.accountId || !entry.reviewId || entry.status === GMAIL_CONNECTION_STATES.REVOKED) {
    throw new GmailReadOnlyError("GMAIL_ACTIVE_GRANT_REQUIRED", "No Gmail content was read because the saved granular review is not ready.");
  }
  if (unresolvedPendingPageRead(entry)) {
    const pending = clone(pendingPageRead(entry));
    const failed = await persistPendingPageReadFailure({
      stateStore,
      expectedPending: pending,
      code: "GMAIL_PAGE_READ_CHECKPOINT_UNCERTAIN",
      stage: "approved-read-recovery",
      language: locale,
      clock
    });
    const permission = await gmailPermissionReview({ stateStore, entry: failed.entry, language: locale });
    return pendingReadResult({ entry: failed.entry, language: locale, permissionReview: permission });
  }
  if (entry.import.complete) {
    const permission = await getSourcePermissionStatusWithinStateLock({ stateStore, source: SOURCE, accountId: entry.accountId, language: locale });
    return { gmail: publicView(entry, locale, permission?.permissionReview), approvedReferences: [], complete: true, checkpointRequired: false };
  }

  const newlyProcessed = [];
  for (let pageIndex = 0; pageIndex < budget; pageIndex += 1) {
    const currentCheckpoint = entry.import.nextPageToken ?? "initial";
    if (pageCheckpointHistory(entry).includes(currentCheckpoint)) {
      setFailure(state, entry, {
        code: "GMAIL_CHECKPOINT_LOOP",
        stage: "approved-read",
        clock,
        language: locale
      });
      await stateStore.save(state);
      const permission = await gmailPermissionReview({ stateStore, entry, language: locale });
      return {
        gmail: publicView(entry, locale, permission?.permissionReview),
        approvedReferences: newlyProcessed,
        complete: false,
        checkpointRequired: false,
        recoverable: true
      };
    }

    const permissionBeforeRead = await gmailPermissionReview({ stateStore, entry, language: locale });
    const activeGrantId = permissionBeforeRead?.permissionReview?.activeGrant?.grantId ?? null;
    const activation = grantActivation(entry, clock);
    if (!activeGrantId || activation.status !== "active" || activation.grantId !== activeGrantId) {
      setFailure(state, entry, {
        code: "GMAIL_GRANT_GENERATION_MISMATCH",
        stage: "approved-read-grant",
        clock,
        language: locale
      });
      await stateStore.save(state);
      return {
        gmail: publicView(entry, locale, permissionBeforeRead?.permissionReview),
        approvedReferences: newlyProcessed,
        complete: false,
        checkpointRequired: false,
        recoverable: true
      };
    }

    const operationRevision = importOperationRevision(entry) + 1;
    const pending = Object.freeze({
      operationId: `gmail-page-read-${randomUUID()}`,
      operationRevision,
      reviewId: opaqueIdentifier(entry.reviewId, "review"),
      grantId: opaqueIdentifier(activeGrantId, "permission grant"),
      checkpoint: opaqueIdentifier(currentCheckpoint, "page checkpoint"),
      startedAt: isoNow(clock)
    });
    entry.import.operationRevision = operationRevision;
    entry.import.pendingPageRead = clone(pending);
    entry.import.status = "page-read-pending";
    entry.pendingAction = null;
    entry.lastSafeError = null;
    entry.audit.push({
      type: "gmail-page-read-checkpoint-saved",
      at: pending.startedAt,
      operationId: pending.operationId,
      operationRevision,
      reviewId: pending.reviewId,
      grantId: pending.grantId,
      checkpoint: pending.checkpoint,
      readMayHaveOccurred: false,
      bodiesExposed: false
    });
    try {
      // No adapter page call is allowed until this exact generation is durable.
      await stateStore.save(state);
    } catch (error) {
      entry.import.pendingPageRead = null;
      if (entry.audit.at(-1)?.type === "gmail-page-read-checkpoint-saved"
        && entry.audit.at(-1)?.operationId === pending.operationId) {
        entry.audit.pop();
      }
      setFailure(state, entry, {
        code: safeErrorCode(error, "GMAIL_PRE_READ_CHECKPOINT_SAVE_FAILED"),
        stage: "pre-read-checkpoint",
        clock,
        language: locale
      });
      entry.import.status = "paused-before-read";
      entry.pendingAction = { kind: "retry-saved-gmail-step", message: copy(locale).preReadCheckpointFailed };
      entry.lastSafeError.sourceReadAttempted = false;
      entry.audit.push({
        type: "gmail-pre-read-checkpoint-save-failed",
        at: isoNow(clock),
        operationRevision,
        sourceReadAttempted: false,
        bodiesExposed: false
      });
      return {
        gmail: publicView(entry, locale, permissionBeforeRead?.permissionReview),
        approvedReferences: newlyProcessed,
        complete: false,
        checkpointRequired: false,
        recoverable: true
      };
    }

    const connector = new GmailReadOnlyConnector({
      plugin,
      pageToken: entry.import.nextPageToken,
      publicAccountAlias: gmailPublicAliases(entry).account
    });
    let fetched;
    try {
      fetched = await fetchApprovedSourceContentWithinStateLock({
        message,
        stateStore,
        connector,
        source: SOURCE,
        accountId: entry.accountId,
        reviewId: entry.reviewId,
        language: locale,
        clock
      });
      if (!connector.lastPage) {
        throw new GmailReadOnlyError("GMAIL_PAGE_INVALID", "Gmail did not return a safe approved page, so I stopped before exposing source data.");
      }
      pageMatchesGenericBoundary(connector.lastPage, fetched.approvedRecords);
    } catch (error) {
      const code = safeErrorCode(error, "GMAIL_FETCH_FAILED");
      let externalCleanup = null;
      if (code === "GMAIL_ACCESS_REVOKED") {
        externalCleanup = await synchronizeExternalRevocation({ stateStore, plugin, entry, language: locale, clock });
      }
      if (code === "GMAIL_ACCESS_REVOKED" && externalCleanup?.confirmed === true) {
        const refreshed = await loadState(stateStore);
        const updated = requireEntry(refreshed);
        updated.grantActivation = {
          status: "revoked",
          grantId: externalCleanup.grantId ?? grantActivation(updated, clock).grantId,
          reviewId: updated.reviewId,
          revocationConfirmed: true,
          updatedAt: isoNow(clock)
        };
        setFailure(refreshed, updated, {
          code,
          stage: "approved-read",
          clock,
          language: locale,
          externalRevocation: true
        });
        try { await stateStore.save(refreshed); } catch { /* the durable pending generation remains fail-closed */ }
        const permission = await gmailPermissionReview({ stateStore, entry: updated, language: locale });
        return {
          gmail: publicView(updated, locale, permission?.permissionReview),
          approvedReferences: newlyProcessed,
          complete: false,
          checkpointRequired: false,
          recoverable: false
        };
      }

      const failed = await persistPendingPageReadFailure({
        stateStore,
        expectedPending: pending,
        error,
        code: code === "GMAIL_ACCESS_REVOKED"
          ? "GMAIL_EXTERNAL_REVOCATION_RECONCILIATION_FAILED"
          : code,
        stage: code === "GMAIL_ACCESS_REVOKED"
          ? "external-revocation-cleanup"
          : "approved-read",
        language: locale,
        clock
      });
      if (code === "GMAIL_ACCESS_REVOKED") {
        failed.entry.grantActivation = {
          status: "revocation-unconfirmed",
          grantId: externalCleanup?.grantId ?? grantActivation(failed.entry, clock).grantId,
          reviewId: failed.entry.reviewId,
          revocationConfirmed: false,
          updatedAt: isoNow(clock)
        };
        try { await stateStore.save(failed.state); } catch { /* pending generation remains durable */ }
      }
      const permission = await gmailPermissionReview({ stateStore, entry: failed.entry, language: locale });
      return {
        gmail: publicView(failed.entry, locale, permission?.permissionReview),
        approvedReferences: newlyProcessed,
        complete: false,
        checkpointRequired: false,
        recoverable: true,
        recoveryRequired: true
      };
    }

    state = await loadState(stateStore);
    entry = requireEntry(state);
    if (!pendingGenerationMatches(entry, pending)) {
      const failed = await persistPendingPageReadFailure({
        stateStore,
        expectedPending: pending,
        code: "GMAIL_PAGE_READ_GENERATION_MISMATCH",
        stage: "approved-read-generation",
        language: locale,
        clock
      });
      const permission = await gmailPermissionReview({ stateStore, entry: failed.entry, language: locale });
      return pendingReadResult({
        entry: failed.entry,
        language: locale,
        permissionReview: permission,
        approvedReferences: newlyProcessed
      });
    }
    const page = connector.lastPage;
    pageCheckpointHistory(entry).push(currentCheckpoint);
    const pageReferences = appendUniqueReferences(entry, page.references);
    entry.import.pagesCompleted += 1;
    entry.import.nextPageToken = page.nextPageToken;
    entry.import.empty = entry.import.recordsProcessed === 0 && page.nextPageToken == null;
    entry.import.complete = page.nextPageToken == null;
    entry.import.status = entry.import.complete ? "complete" : "checkpoint-required";
    entry.pendingAction = entry.import.complete ? null : { kind: "continue-gmail-import", message: copy(locale).continueImport };
    entry.lastSafeError = null;
    entry.import.pendingPageRead = null;
    entry.connection.simulationOnly = page.simulated;
    if (page.simulated) {
      entry.connection.live = false;
      entry.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
      entry.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    }
    entry.audit.push({
      type: "gmail-approved-page-processed",
      at: isoNow(clock),
      page: entry.import.pagesCompleted,
      recordCount: page.references.length,
      nextCheckpoint: page.nextPageToken != null,
      simulated: page.simulated,
      actualRead: page.actualRead,
      bodiesExposed: false
    });
    try {
      // The page checkpoint and removal of pendingPageRead are one durable root
      // save. Until it succeeds, a retry must never request this page again.
      await stateStore.save(state);
    } catch (error) {
      const failed = await persistPendingPageReadFailure({
        stateStore,
        expectedPending: pending,
        error,
        code: "GMAIL_PAGE_READ_CHECKPOINT_UNCERTAIN",
        stage: "approved-read-checkpoint",
        language: locale,
        clock
      });
      const permission = await gmailPermissionReview({ stateStore, entry: failed.entry, language: locale });
      return pendingReadResult({
        entry: failed.entry,
        language: locale,
        permissionReview: permission,
        approvedReferences: newlyProcessed
      });
    }
    newlyProcessed.push(...pageReferences);
    if (entry.import.complete) break;
  }

  const permission = await getSourcePermissionStatusWithinStateLock({ stateStore, source: SOURCE, accountId: entry.accountId, language: locale });
  return {
    gmail: publicView(entry, locale, permission?.permissionReview),
    approvedReferences: newlyProcessed,
    complete: entry.import.complete,
    checkpointRequired: !entry.import.complete
  };
}

export async function fetchApprovedGmailReferences(args = {}) {
  return withSourcePermissionStateLock(args?.stateStore, () => fetchApprovedGmailReferencesInternal(args));
}

/** Revokes only the persisted local grant; it cannot change any Gmail message. */
async function revokeGmailReadOnlyConnectionInternal({ message, stateStore, plugin, language, clock } = {}) {
  assertNaturalLanguage(message, "revoke");
  let state = await loadState(stateStore);
  let entry = requireEntry(state);
  const locale = languageFor(state, language);
  if (!entry.accountId || !entry.reviewId) {
    throw new GmailReadOnlyError("GMAIL_REVIEW_REQUIRED", "There is no saved Gmail permission to revoke yet.");
  }
  const permission = await getSourcePermissionStatusWithinStateLock({ stateStore, source: SOURCE, accountId: entry.accountId, language: locale });
  const activeGrant = permission?.permissionReview?.activeGrant;
  const activation = grantActivation(entry, clock);
  const grantId = (activationMayRemainActive(entry) ? activation.grantId : null) ?? activeGrant?.grantId ?? null;
  if (!grantId) {
    throw new GmailReadOnlyError("GMAIL_ACTIVE_GRANT_REQUIRED", "There is no saved Gmail permission grant to revoke.");
  }

  entry.grantActivation = {
    status: "revocation-pending",
    grantId,
    reviewId: entry.reviewId,
    revocationConfirmed: false,
    updatedAt: isoNow(clock)
  };
  entry.pendingAction = { kind: "retry-saved-gmail-step", message: copy(locale).retrySavedStep };
  await stateStore.save(state);

  const cleanup = await deactivatePersistedGmailGrant({
    stateStore,
    plugin,
    accountId: entry.accountId,
    reviewId: entry.reviewId,
    grantId,
    language: locale,
    clock
  });
  state = await loadState(stateStore);
  entry = requireEntry(state);
  entry.grantActivation = {
    status: cleanup.confirmed ? "revoked" : "revocation-unconfirmed",
    grantId,
    reviewId: entry.reviewId,
    revocationConfirmed: cleanup.confirmed,
    updatedAt: isoNow(clock)
  };
  if (!cleanup.confirmed) {
    setFailure(state, entry, {
      code: cleanup.code ?? "GMAIL_REVOCATION_UNCONFIRMED",
      stage: "revocation",
      clock,
      language: locale
    });
    await stateStore.save(state);
    return { gmail: publicView(entry, locale, cleanup.permissionReview), recoverable: true };
  }

  entry.status = GMAIL_CONNECTION_STATES.REVOKED;
  entry.connection.state = GMAIL_CONNECTION_STATES.REVOKED;
  entry.connection.live = false;
  entry.import.status = "revoked";
  entry.import.nextPageToken = null;
  entry.pendingAction = null;
  entry.lastSafeError = null;
  entry.audit.push({ type: "gmail-read-only-grant-revoked", at: isoNow(clock), reviewId: entry.reviewId, bodiesExposed: false });
  await stateStore.save(state);
  return { gmail: publicView(entry, locale, cleanup.permissionReview) };
}

export async function revokeGmailReadOnlyConnection(args = {}) {
  return withSourcePermissionStateLock(args?.stateStore, () => revokeGmailReadOnlyConnectionInternal(args));
}

/**
 * Skipping Gmail is non-destructive only after an existing granular permission
 * is closed. A skip must never turn an active local/plugin grant into a
 * customer-visible "skipped" state.
 */
async function skipGmailConnectionInternal({ message, stateStore, plugin, language, clock } = {}) {
  assertNaturalLanguage(message, "skip");
  let state = await loadState(stateStore);
  let entry = getEntry(state);
  if (!entry) {
    entry = newEntry(isoNow(clock));
    rootLifecycle(state).entry = entry;
  }
  const locale = languageFor(state, language);
  const permission = entry.accountId
    ? await getSourcePermissionStatusWithinStateLock({ stateStore, source: SOURCE, accountId: entry.accountId, language: locale })
    : null;
  const activeGrant = permission?.permissionReview?.activeGrant;
  const activation = grantActivation(entry, clock);
  const grantId = (activationMayRemainActive(entry) ? activation.grantId : null) ?? activeGrant?.grantId ?? null;

  if (grantId) {
    if (!plugin) {
      entry.status = GMAIL_CONNECTION_STATES.NEEDS_ATTENTION;
      entry.connection.state = GMAIL_CONNECTION_STATES.NEEDS_ATTENTION;
      entry.connection.live = false;
      entry.import.status = "paused-after-error";
      entry.pendingAction = { kind: "revoke-active-gmail-grant-before-skip", message: copy(locale).retrySavedStep };
      entry.lastSafeError = { code: "GMAIL_SKIP_REVOCATION_REQUIRED", stage: "skip-revocation", at: isoNow(clock) };
      entry.grantActivation = {
        status: "revocation-unconfirmed",
        grantId,
        reviewId: activation.reviewId ?? entry.reviewId,
        revocationConfirmed: false,
        updatedAt: isoNow(clock)
      };
      entry.audit.push({ type: "gmail-skip-blocked-active-grant", at: isoNow(clock), bodiesExposed: false });
      await stateStore.save(state);
      return { gmail: publicView(entry, locale, permission?.permissionReview), recoverable: true };
    }

    entry.grantActivation = {
      status: "revocation-pending",
      grantId,
      reviewId: activation.reviewId ?? entry.reviewId,
      revocationConfirmed: false,
      updatedAt: isoNow(clock)
    };
    await stateStore.save(state);
    const cleanup = await deactivatePersistedGmailGrant({
      stateStore,
      plugin,
      accountId: entry.accountId,
      reviewId: activation.reviewId ?? entry.reviewId,
      grantId,
      language: locale,
      clock
    });
    state = await loadState(stateStore);
    entry = requireEntry(state);
    entry.grantActivation = {
      status: cleanup.confirmed ? "revoked" : "revocation-unconfirmed",
      grantId,
      reviewId: activation.reviewId ?? entry.reviewId,
      revocationConfirmed: cleanup.confirmed,
      updatedAt: isoNow(clock)
    };
    if (!cleanup.confirmed) {
      setFailure(state, entry, {
        code: cleanup.code ?? "GMAIL_SKIP_REVOCATION_FAILED",
        stage: "skip-revocation",
        clock,
        language: locale
      });
      await stateStore.save(state);
      return { gmail: publicView(entry, locale, cleanup.permissionReview), recoverable: true };
    }

    entry.status = GMAIL_CONNECTION_STATES.SKIPPED;
    entry.connection.state = GMAIL_CONNECTION_STATES.SKIPPED;
    entry.connection.live = false;
    entry.import.status = "skipped";
    entry.pendingAction = null;
    entry.lastSafeError = null;
    entry.audit.push({ type: "gmail-skipped-after-grant-revocation", at: isoNow(clock), bodiesExposed: false });
    await stateStore.save(state);
    return { gmail: publicView(entry, locale, cleanup.permissionReview) };
  }

  entry.status = GMAIL_CONNECTION_STATES.SKIPPED;
  entry.connection.state = GMAIL_CONNECTION_STATES.SKIPPED;
  entry.connection.live = false;
  entry.import.status = "skipped";
  entry.pendingAction = null;
  entry.lastSafeError = null;
  entry.audit.push({ type: "gmail-skipped", at: isoNow(clock), bodiesExposed: false });
  await stateStore.save(state);
  return { gmail: publicView(entry, locale) };
}

export async function skipGmailConnection(args = {}) {
  return withSourcePermissionStateLock(args?.stateStore, () => skipGmailConnectionInternal(args));
}

/** Status is local-state-only and never invokes a Gmail plugin or source read. */
async function getGmailReadOnlyStatusInternal({ stateStore, language } = {}) {
  const state = await loadState(stateStore);
  const entry = getEntry(state);
  if (!entry) return null;
  const locale = languageFor(state, language);
  const permission = entry.accountId
    ? getSourcePermissionStatusFromState({ state, source: SOURCE, accountId: entry.accountId, language: locale })
    : null;
  return {
    gmail: publicView(entry, locale, permission?.permissionReview),
    sourceStatus: getPersistedAdapterSourceStatus({ state, adapter: SOURCE_ADAPTER_NAMES.GMAIL, accountId: gmailPublicAliases(entry).account, language: locale })
  };
}

export async function getGmailReadOnlyStatus(args = {}) {
  return withSourcePermissionStateReadLock(args?.stateStore, () => getGmailReadOnlyStatusInternal(args));
}
