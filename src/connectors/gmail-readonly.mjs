/**
 * QWA-145 Gmail read-only vertical slice.
 *
 * This adapter intentionally has no Gmail SDK or live app dependency. A host
 * injects the official plugin contract when it is genuinely available; the
 * included simulated plugin exercises the same contract without accessing a
 * mailbox. The public lifecycle never calls a source write operation and it
 * refuses to expose message bodies, snippets, headers, or raw payloads.
 */

import {
  beginSourcePermissionReview,
  denySourcePermission,
  fetchApprovedSourceContent,
  getSourcePermissionStatus,
  grantSourcePermission,
  revokeSourcePermission
} from "../permissions/setup-source-permissions.mjs";

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
  "attachments"
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
      continueImport: "Continúa la importación guardada de Gmail en esta misma conversación."
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
    continueImport: "Continue the saved Gmail import in this same conversation."
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
    if (BODY_FIELD_NAMES.has(key.toLowerCase())) {
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
    plugin: {
      status: "not-started",
      attempts: 0,
      simulated: null
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

function statusMessage(entry, language) {
  const wording = copy(language);
  if (entry.status === GMAIL_CONNECTION_STATES.REVOKED) return wording.revoked;
  if (entry.status === GMAIL_CONNECTION_STATES.SKIPPED) return wording.skipped;
  if (entry.status === GMAIL_CONNECTION_STATES.UNSUPPORTED) return wording.unsupported;
  if (entry.status === GMAIL_CONNECTION_STATES.NEEDS_ATTENTION) return wording.needsAttention;
  if (entry.plugin.status === "cancelled") return wording.cancelled;
  if (entry.import.status === "checkpoint-required") return wording.checkpoint;
  if (entry.connection.simulationOnly && entry.import.status === "complete" && entry.import.empty) return wording.simulatedEmpty;
  if (entry.import.status === "complete" && entry.import.empty) return wording.empty;
  if (entry.connection.simulationOnly && entry.import.recordsProcessed > 0) return wording.simulatedVerified;
  if (entry.connection.live) return wording.liveVerified;
  if (entry.import.status === "ready-to-verify") return wording.scopeGranted;
  if (entry.reviewId) return wording.reviewReady;
  if (entry.plugin.status === "connected") return wording.connected;
  return wording.start;
}

function publicView(entry, language, permissionReview = null) {
  return {
    source: SOURCE,
    status: entry.status,
    message: statusMessage(entry, language),
    connection: {
      state: entry.connection.state,
      live: entry.connection.live,
      readOnly: true,
      verifiedAt: entry.connection.verifiedAt,
      simulationOnly: entry.connection.simulationOnly,
      canSendMail: false,
      canLabelMail: false,
      canArchiveMail: false,
      canDeleteMail: false,
      canModifyMail: false
    },
    plugin: {
      status: entry.plugin.status,
      simulated: entry.plugin.simulated === true
    },
    account: entry.accountId ? { context: `gmail:${entry.accountId}` } : null,
    import: {
      status: entry.import.status,
      pagesCompleted: entry.import.pagesCompleted,
      recordsProcessed: entry.import.recordsProcessed,
      estimatedItemCount: entry.import.estimatedItemCount,
      checkpointPending: typeof entry.import.nextPageToken === "string",
      complete: entry.import.complete,
      empty: entry.import.empty
    },
    nextAction: entry.pendingAction ? clone(entry.pendingAction) : null,
    lastSafeError: entry.lastSafeError ? clone(entry.lastSafeError) : null,
    permissionReview: permissionReview ? clone(permissionReview) : null,
    audit: clone(entry.audit)
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

function pluginIsSimulated(plugin, result = {}) {
  return plugin?.isSimulation === true || result?.simulated === true;
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

function normalizePageResult(result, { accountId, plugin, grant }) {
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
  const simulated = pluginIsSimulated(plugin, result);
  if (!simulated && result.actualRead !== true) {
    throw new GmailReadOnlyError("GMAIL_ACTUAL_READ_NOT_PROVEN", "Gmail did not prove a real, read-only read, so I will not label it as live.");
  }
  if (!Array.isArray(result.records)) {
    throw new GmailReadOnlyError("GMAIL_PAGE_INVALID", "Gmail did not return a safe approved page, so I stopped before exposing source data.");
  }
  const references = result.records.map((record) => {
    const { id, threadId, timestamp } = normalizeApprovedPageRecord(record, grant);
    return {
      source: SOURCE,
      sourceRecordId: `gmail:${id}`,
      accountContext: `gmail:${accountId}`,
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
  constructor({ plugin, pageToken = null, pageSize = 50 } = {}) {
    this.plugin = plugin;
    this.pageToken = opaqueIdentifier(pageToken, "page checkpoint", { nullable: true });
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
    assertPluginMethod(this.plugin, "revokePermissionGrant", "A Gmail plugin with grant revocation is required.");
    await this.plugin.revokePermissionGrant({ grantId });
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
      { accountId, plugin: this.plugin, grant }
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
export async function beginGmailConnection({ message, stateStore, plugin, language, clock } = {}) {
  assertNaturalLanguage(message, "start");
  const state = await loadState(stateStore);
  const entry = prepareFreshEntry(state, clock);
  const locale = languageFor(state, language);

  if (entry.plugin.status === "connected") {
    const permission = entry.accountId ? await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId: entry.accountId, language: locale }) : null;
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
      entry.plugin.simulated = pluginIsSimulated(plugin, result);
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

/** Runs the QWA-139 metadata-only preflight after a saved Gmail plugin connection. */
export async function beginGmailPrivacyReview({ message, stateStore, plugin, language, clock, reviewIdFactory } = {}) {
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
    const review = await beginSourcePermissionReview({
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

/** Saves a granular QWA-139 grant; it does not read Gmail itself. */
export async function grantGmailReadOnlyScope({ message, stateStore, plugin, scope, language, clock, grantIdFactory } = {}) {
  assertNaturalLanguage(message, "grant");
  const initial = await loadState(stateStore);
  const entry = requireEntry(initial);
  const locale = languageFor(initial, language);
  if (!entry.accountId || !entry.reviewId || entry.status === GMAIL_CONNECTION_STATES.REVOKED) {
    throw new GmailReadOnlyError("GMAIL_REVIEW_REQUIRED", "Complete the saved Gmail metadata review before approving content access.");
  }
  const connector = new GmailReadOnlyConnector({ plugin });
  try {
    const granted = await grantSourcePermission({
      message,
      stateStore,
      connector,
      source: SOURCE,
      accountId: entry.accountId,
      reviewId: entry.reviewId,
      scope,
      language: locale,
      clock,
      grantIdFactory
    });
    const state = await loadState(stateStore);
    const updated = requireEntry(state);
    updated.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    updated.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    updated.import.status = "ready-to-verify";
    updated.pendingAction = null;
    updated.lastSafeError = null;
    updated.audit.push({ type: "gmail-read-only-grant-active", at: isoNow(clock), reviewId: updated.reviewId, bodiesExposed: false });
    await stateStore.save(state);
    return { gmail: publicView(updated, locale, granted.permissionReview) };
  } catch (error) {
    const state = await loadState(stateStore);
    const updated = requireEntry(state);
    setFailure(state, updated, { code: safeErrorCode(error, "GMAIL_GRANT_FAILED"), stage: "grant", clock, language: locale });
    await stateStore.save(state);
    return { gmail: publicView(updated, locale), recoverable: true };
  }
}

/** Cancels the saved review without reading mail; a later retry must start a fresh metadata review. */
export async function cancelGmailReadOnlyScope({ message, stateStore, language, clock } = {}) {
  assertNaturalLanguage(message, "cancel");
  const initial = await loadState(stateStore);
  const entry = requireEntry(initial);
  const locale = languageFor(initial, language);
  if (!entry.accountId || !entry.reviewId) {
    throw new GmailReadOnlyError("GMAIL_REVIEW_REQUIRED", "There is no saved Gmail review to cancel yet.");
  }
  const denied = await denySourcePermission({
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

async function synchronizeExternalRevocation({ stateStore, plugin, entry, language, clock }) {
  if (!entry.accountId || !entry.reviewId) return;
  const request = {
    message: language === "es" ? "Revocar el permiso guardado de Gmail" : "Revoke the saved Gmail permission",
    stateStore,
    source: SOURCE,
    accountId: entry.accountId,
    reviewId: entry.reviewId,
    language,
    clock
  };
  try {
    await revokeSourcePermission({
      connector: new GmailReadOnlyConnector({ plugin }),
      ...request
    });
  } catch {
    try {
      await revokeSourcePermission({
        connector: LOCAL_GMAIL_GRANT_REVOCATION_CONNECTOR,
        ...request
      });
    } catch {
      // The Gmail wrapper remains fail-closed even if its generic local state
      // was already absent or could not be inspected. Its own entry is still
      // reset before another review can begin.
    }
  }
}

/**
 * Fetches bounded opaque references only after QWA-139 has persisted a grant.
 * Each page is committed as a checkpoint, so a later interruption resumes from
 * the exact next opaque page token instead of restarting a large account.
 */
export async function fetchApprovedGmailReferences({ message, stateStore, plugin, language, clock, maxPages } = {}) {
  assertNaturalLanguage(message, "fetch");
  const budget = pageBudget(maxPages);
  let state = await loadState(stateStore);
  let entry = requireEntry(state);
  const locale = languageFor(state, language);
  if (!entry.accountId || !entry.reviewId || entry.status === GMAIL_CONNECTION_STATES.REVOKED) {
    throw new GmailReadOnlyError("GMAIL_ACTIVE_GRANT_REQUIRED", "No Gmail content was read because the saved granular review is not ready.");
  }
  if (entry.import.complete) {
    const permission = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId: entry.accountId, language: locale });
    return { gmail: publicView(entry, locale, permission?.permissionReview), approvedReferences: [], complete: true, checkpointRequired: false };
  }

  const newlyProcessed = [];
  for (let pageIndex = 0; pageIndex < budget; pageIndex += 1) {
    const currentCheckpoint = entry.import.nextPageToken ?? "initial";
    const connector = new GmailReadOnlyConnector({ plugin, pageToken: entry.import.nextPageToken });
    let fetched;
    try {
      if (pageCheckpointHistory(entry).includes(currentCheckpoint)) {
        throw new GmailReadOnlyError("GMAIL_CHECKPOINT_LOOP", "Gmail repeated a saved page checkpoint, so I stopped instead of looping through the same source page.");
      }
      fetched = await fetchApprovedSourceContent({
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
      if (code === "GMAIL_ACCESS_REVOKED") {
        await synchronizeExternalRevocation({ stateStore, plugin, entry, language: locale, clock });
      }
      const refreshed = await loadState(stateStore);
      const updated = requireEntry(refreshed);
      setFailure(refreshed, updated, {
        code,
        stage: "approved-read",
        clock,
        language: locale,
        externalRevocation: code === "GMAIL_ACCESS_REVOKED"
      });
      await stateStore.save(refreshed);
      const permission = updated.accountId ? await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId: updated.accountId, language: locale }) : null;
      return {
        gmail: publicView(updated, locale, permission?.permissionReview),
        approvedReferences: newlyProcessed,
        complete: false,
        checkpointRequired: false,
        recoverable: updated.status !== GMAIL_CONNECTION_STATES.REVOKED
      };
    }

    state = await loadState(stateStore);
    entry = requireEntry(state);
    const page = connector.lastPage;
    pageCheckpointHistory(entry).push(currentCheckpoint);
    newlyProcessed.push(...appendUniqueReferences(entry, page.references));
    entry.import.pagesCompleted += 1;
    entry.import.nextPageToken = page.nextPageToken;
    entry.import.empty = entry.import.recordsProcessed === 0 && page.nextPageToken == null;
    entry.import.complete = page.nextPageToken == null;
    entry.import.status = entry.import.complete ? "complete" : "checkpoint-required";
    entry.pendingAction = entry.import.complete ? null : { kind: "continue-gmail-import", message: copy(locale).continueImport };
    entry.lastSafeError = null;
    entry.connection.simulationOnly = page.simulated;
    if (page.simulated) {
      entry.connection.live = false;
      entry.connection.state = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
      entry.status = GMAIL_CONNECTION_STATES.SELECTED_BUT_UNFINISHED;
    } else if (page.actualRead) {
      entry.connection.live = true;
      entry.connection.state = GMAIL_CONNECTION_STATES.LIVE_AND_VERIFIED;
      entry.connection.verifiedAt = isoNow(clock);
      entry.status = GMAIL_CONNECTION_STATES.LIVE_AND_VERIFIED;
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
    await stateStore.save(state);
    if (entry.import.complete) break;
  }

  const permission = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId: entry.accountId, language: locale });
  return {
    gmail: publicView(entry, locale, permission?.permissionReview),
    approvedReferences: newlyProcessed,
    complete: entry.import.complete,
    checkpointRequired: !entry.import.complete
  };
}

/** Revokes only the persisted local grant; it cannot change any Gmail message. */
export async function revokeGmailReadOnlyConnection({ message, stateStore, plugin, language, clock } = {}) {
  assertNaturalLanguage(message, "revoke");
  const initial = await loadState(stateStore);
  const entry = requireEntry(initial);
  const locale = languageFor(initial, language);
  if (!entry.accountId || !entry.reviewId) {
    throw new GmailReadOnlyError("GMAIL_REVIEW_REQUIRED", "There is no saved Gmail permission to revoke yet.");
  }
  const connector = new GmailReadOnlyConnector({ plugin });
  try {
    const revoked = await revokeSourcePermission({
      message,
      stateStore,
      connector,
      source: SOURCE,
      accountId: entry.accountId,
      reviewId: entry.reviewId,
      language: locale,
      clock
    });
    const state = await loadState(stateStore);
    const updated = requireEntry(state);
    updated.status = GMAIL_CONNECTION_STATES.REVOKED;
    updated.connection.state = GMAIL_CONNECTION_STATES.REVOKED;
    updated.connection.live = false;
    updated.import.status = "revoked";
    updated.import.nextPageToken = null;
    updated.pendingAction = null;
    updated.audit.push({ type: "gmail-read-only-grant-revoked", at: isoNow(clock), reviewId: updated.reviewId, bodiesExposed: false });
    await stateStore.save(state);
    return { gmail: publicView(updated, locale, revoked.permissionReview) };
  } catch (error) {
    const state = await loadState(stateStore);
    const updated = requireEntry(state);
    setFailure(state, updated, { code: safeErrorCode(error, "GMAIL_REVOCATION_FAILED"), stage: "revocation", clock, language: locale });
    await stateStore.save(state);
    return { gmail: publicView(updated, locale), recoverable: true };
  }
}

/** Skipping Gmail is non-destructive and keeps the rest of setup resumable. */
export async function skipGmailConnection({ message, stateStore, language, clock } = {}) {
  assertNaturalLanguage(message, "skip");
  const state = await loadState(stateStore);
  const entry = prepareFreshEntry(state, clock);
  const locale = languageFor(state, language);
  entry.status = GMAIL_CONNECTION_STATES.SKIPPED;
  entry.connection.state = GMAIL_CONNECTION_STATES.SKIPPED;
  entry.connection.live = false;
  entry.import.status = "skipped";
  entry.pendingAction = null;
  entry.audit.push({ type: "gmail-skipped", at: isoNow(clock), bodiesExposed: false });
  await stateStore.save(state);
  return { gmail: publicView(entry, locale) };
}

/** Status is local-state-only and never invokes a Gmail plugin or source read. */
export async function getGmailReadOnlyStatus({ stateStore, language } = {}) {
  const state = await loadState(stateStore);
  const entry = getEntry(state);
  if (!entry) return null;
  const locale = languageFor(state, language);
  const permission = entry.accountId ? await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId: entry.accountId, language: locale }) : null;
  return { gmail: publicView(entry, locale, permission?.permissionReview) };
}
