/**
 * QWA-142 folder-scoped Google Drive lifecycle.
 *
 * This is an additive public Setup Session extension. It only asks an
 * injected desktop plugin for a read-only, selected-folder authorization after
 * the customer makes that normal-language choice. The QWA-139 permission
 * lifecycle then owns metadata preflight, granular folder review, grants, and
 * bounded opaque source references.
 */

import {
  beginSourcePermissionReview,
  fetchApprovedSourceContent,
  getSourcePermissionStatus,
  grantSourcePermission,
  PermissionLifecycleError,
  revokeSourcePermission
} from "../permissions/setup-source-permissions.mjs";

const STATE_KEY = "googleDriveLifecycle";
const SOURCE = "drive";
const AUTHORIZATION_STATUSES = new Set(["authorized", "partial", "cancelled", "denied", "revoked", "unavailable"]);
const OPAQUE_GOOGLE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const REVOKED_AUTHORIZATION_CODES = new Set([
  "AUTHORIZATION_REVOKED",
  "AUTHORIZATION_EXPIRED",
  "DRIVE_AUTHORIZATION_REVOKED",
  "DRIVE_AUTHORIZATION_EXPIRED",
  "TOKEN_REVOKED",
  "TOKEN_EXPIRED",
  "ACCESS_TOKEN_REVOKED",
  "ACCESS_TOKEN_EXPIRED",
  "OAUTH_TOKEN_REVOKED",
  "OAUTH_TOKEN_EXPIRED",
  "INVALID_GRANT",
  "INVALID_TOKEN",
  "UNAUTHENTICATED",
  "UNAUTHORIZED"
]);

export class GoogleDriveLifecycleError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "GoogleDriveLifecycleError";
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

function assertNaturalLanguage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new GoogleDriveLifecycleError("DRIVE_MESSAGE_REQUIRED", "Tell me in normal language that you would like to review Drive for your second brain.");
  }
  if (message.trim().startsWith("/")) {
    throw new GoogleDriveLifecycleError("NO_SLASH_COMMANDS", "You do not need a command. Tell me what you want to do with Google Drive in normal language.");
  }
}

function languageFor(state, language) {
  return language === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function copy(language) {
  if (language === "es") {
    return {
      start: "Google Drive se conecta por separado de Gmail y Calendario. Puedes autorizar solo las carpetas que elijas; no pediré acceso general a Workspace.",
      awaitingAuthorization: "Aún no inicié autorización de Drive. Confirma que quieres conectar solo las carpetas seleccionadas y abriré el flujo de solo lectura.",
      folderReview: "La autorización de Drive es solo de lectura. Revisé metadatos únicamente para que incluyas o excluyas carpetas antes de leer contenido.",
      partial: "Drive concedió acceso parcial de solo lectura. Solo las carpetas confirmadas aparecen en esta revisión; las demás siguen excluidas.",
      cancelled: "La autorización de Drive se canceló o no estuvo disponible. No leí contenido y puedes reintentar cuando quieras.",
      revoked: "El acceso de Drive está revocado. No se leerá contenido hasta una nueva autorización y revisión de carpetas.",
      revocationUnconfirmed: "Se revocó el permiso local de Drive, pero no pude confirmar la revocación con el complemento de Drive. No se leerá contenido hasta una nueva autorización y revisión de carpetas.",
      needsAttention: "Drive necesita atención antes de continuar. Detuve el procesamiento y puedes volver a autorizar las carpetas seleccionadas.",
      ready: "La selección de carpetas se guardó como permiso de solo lectura. Puedes procesar únicamente las referencias aprobadas.",
      imported: "Importé solo referencias opacas aprobadas de las carpetas seleccionadas. Drive sigue siendo de solo lectura.",
      metadataOnly: "Nunca edito, muevo, comparto ni elimino archivos de Drive durante la verificación."
    };
  }
  return {
    start: "Google Drive connects separately from Gmail and Calendar. You can authorize only the folders you choose; I will not request blanket Workspace access.",
    awaitingAuthorization: "I have not started Drive authorization. Confirm that you want to connect only selected folders and I will open the read-only flow.",
    folderReview: "Drive authorization is read-only. I reviewed metadata only so you can include or exclude folders before any content is read.",
    partial: "Drive granted partial read-only access. Only the confirmed folders appear in this review; all others remain excluded.",
    cancelled: "Drive authorization was cancelled or unavailable. I did not read content, and you can retry whenever you are ready.",
    revoked: "Drive access is revoked. No content will be read until a new authorization and folder review are completed.",
    revocationUnconfirmed: "The local Drive permission was revoked, but I could not confirm revocation with the Drive plugin. No content will be read until a new authorization and folder review are completed.",
    needsAttention: "Drive needs attention before it can continue. I stopped processing, and you can reauthorize the selected folders.",
    ready: "The folder selection is saved as a read-only grant. You can process only approved references.",
    imported: "I imported only approved opaque references from selected folders. Drive remains read-only.",
    metadataOnly: "I never edit, move, share, or delete Drive files during verification."
  };
}

function entryKey(accountId) {
  return `${SOURCE}:${encodeURIComponent(accountId)}`;
}

function lifecycle(state) {
  if (!state[STATE_KEY]) state[STATE_KEY] = { version: 1, entries: {}, audit: [] };
  return state[STATE_KEY];
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state) {
    throw new GoogleDriveLifecycleError("SETUP_SESSION_NOT_FOUND", "Start your second-brain setup first, then I can guide the separate Google Drive connection here.");
  }
  return state;
}

function newEntry(accountId, now) {
  return {
    source: SOURCE,
    accountId,
    status: "awaiting-authorization",
    authorization: { status: "not-started", readOnly: false, metadataOnly: false, attempts: 0 },
    authorizedFolderIds: [],
    reviewId: null,
    normalizedMetadataById: {},
    audit: [{ type: "drive-connection-offered", at: now }]
  };
}

function assertEntry(state, accountId) {
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry) {
    throw new GoogleDriveLifecycleError("DRIVE_CONNECTION_NOT_STARTED", "Tell me you would like to connect Google Drive first, and I will guide the folder-scoped review.");
  }
  return entry;
}

function assertPlugin(plugin) {
  if (!plugin || typeof plugin.authorizeFolderScopedReadOnly !== "function") {
    throw new TypeError("A Drive desktop plugin with authorizeFolderScopedReadOnly() is required after the customer approves authorization.");
  }
}

function assertConnector(connector) {
  if (!connector || typeof connector.discoverMetadata !== "function" || typeof connector.fetchApprovedContent !== "function") {
    throw new TypeError("A read-only Drive connector with metadata discovery and bounded fetch is required.");
  }
}

function redactMetadataLabel(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "Untitled Drive item";
  return text
    .replace(/(?:ignore|override|system\s+prompt|grant\s+access|reveal\s+secret)[^\n]*/gi, "[untrusted text removed]")
    .replace(/\b(?:password|passcode|secret|api[ _-]?key|access[ _-]?token|social[ _-]?security|card[ _-]?number|account[ _-]?number)\b[^\n]*/gi, "[sensitive label redacted]")
    .replace(/\b(?:\d[ -]?){9,}\b/g, "[redacted]")
    .slice(0, 160);
}

function safeDriveLink(value, expectedDriveId) {
  if (typeof value !== "string" || !isOpaqueGoogleId(expectedDriveId)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || !["drive.google.com", "docs.google.com"].includes(url.hostname)
      || url.username
      || url.password
      || url.port
    ) return null;
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const linkedIdMatches = pathSegments.some((segment, index) => (
      (segment === "d" || segment === "folders") && pathSegments[index + 1] === expectedDriveId
    ));
    if (!linkedIdMatches) return null;
    // Metadata is untrusted too. Resource keys, auth tokens, and fragments
    // can grant or reveal access, while the canonical Google path remains a
    // stable customer-visible source pointer.
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort();
}

function isOpaqueGoogleId(value) {
  return typeof value === "string" && OPAQUE_GOOGLE_ID.test(value);
}

function uniqueOpaqueGoogleIds(values) {
  return uniqueStrings(values).filter(isOpaqueGoogleId);
}

function safeFailureCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : "CONNECTOR_FETCH_FAILED";
}

function fetchFailureStatus(error) {
  return REVOKED_AUTHORIZATION_CODES.has(safeFailureCode(error)) ? "revoked" : "needs-attention";
}

function isRecoverableConnectorFailure(error) {
  return !(error instanceof GoogleDriveLifecycleError)
    && (!(error instanceof PermissionLifecycleError) || error.code === "PERMISSION_GRANT_RESTORE_FAILED");
}

const LOCAL_GRANT_REVOCATION_CONNECTOR = Object.freeze({
  async revokePermissionGrant() {
    // This only invalidates the saved QWA-139 grant. It neither invokes the
    // Drive connector nor represents a remote revocation claim.
  }
});

async function revokeLocalDriveGrantAfterFailure({ stateStore, accountId, reviewId, language, clock }) {
  try {
    return await revokeSourcePermission({
      message: language === "es"
        ? "Revoca el permiso local de Drive después de una interrupción de conexión"
        : "Revoke the local Drive permission after a connection interruption",
      stateStore,
      connector: LOCAL_GRANT_REVOCATION_CONNECTOR,
      source: SOURCE,
      accountId,
      reviewId,
      language,
      clock
    });
  } catch {
    // The Drive entry below remains fail-closed even if the generic local
    // state had already been removed or could not be inspected.
    return null;
  }
}

function normalizeDriveMetadata(preflight, allowedFolders, accountId) {
  const allowed = new Set(allowedFolders);
  const rawItems = Array.isArray(preflight?.items) ? preflight.items : [];
  const entries = rawItems
    .filter((item) => item && isOpaqueGoogleId(item.id) && allowed.has(item.folder))
    .map((item) => ({
      source: SOURCE,
      accountId,
      sourceRecordId: item.id,
      stableDriveId: item.id,
      folderId: item.folder,
      fileName: redactMetadataLabel(item.label ?? item.title),
      mimeType: typeof item.mimeType === "string" ? item.mimeType.slice(0, 160) : null,
      modifiedAt: typeof item.modifiedAt === "string" && Number.isFinite(Date.parse(item.modifiedAt)) ? new Date(item.modifiedAt).toISOString() : null,
      stableLink: safeDriveLink(item.webUrl ?? item.url, item.id)
    }));
  return Object.fromEntries(entries.map((entry) => [entry.sourceRecordId, entry]));
}

/** Restricts an injected connector to the exact plugin-approved folder IDs. */
export class FolderBoundedDriveConnector {
  constructor(connector, allowedFolderIds, { reviewedRecordFolders = null } = {}) {
    assertConnector(connector);
    this.connector = connector;
    this.allowedFolderIds = uniqueOpaqueGoogleIds(allowedFolderIds);
    this.reviewedRecordFolders = reviewedRecordFolders === null
      ? null
      : new Map(Object.entries(reviewedRecordFolders)
        .filter(([recordId, folderId]) => isOpaqueGoogleId(recordId) && this.allowedFolderIds.includes(folderId)));
    this.lastMetadata = null;
  }

  assertGrantFolders(grant) {
    const folders = grant?.scope?.folders;
    if (!Array.isArray(folders) || folders.length === 0 || folders.some((folder) => !this.allowedFolderIds.includes(folder))) {
      throw new GoogleDriveLifecycleError("UNAPPROVED_DRIVE_FOLDER", "That Drive request included a folder that was not authorized for this review, so no content was read.");
    }
  }

  async discoverMetadata({ source }) {
    if (source !== SOURCE) throw new GoogleDriveLifecycleError("DRIVE_SOURCE_MISMATCH", "The source did not match the Drive review, so I stopped before reading content.");
    const metadata = await this.connector.discoverMetadata({ source });
    const items = (Array.isArray(metadata?.items) ? metadata.items : [])
      .filter((item) => isOpaqueGoogleId(item?.id) && this.allowedFolderIds.includes(item?.folder));
    const participantIds = new Set(items.flatMap((item) => Array.isArray(item?.participantIds) ? item.participantIds : []));
    const people = (Array.isArray(metadata?.people) ? metadata.people : [])
      .filter((person) => participantIds.has(person?.id));
    // Do not carry aggregate metadata from unselected folders into the review.
    // The parent lifecycle derives all selectable dimensions from this bounded
    // inventory, before a content grant exists.
    this.lastMetadata = {
      source: metadata?.source,
      account: clone(metadata?.account),
      readOnly: metadata?.readOnly === true,
      people: clone(people),
      folders: uniqueOpaqueGoogleIds(items.map((item) => item.folder)),
      areas: uniqueStrings(items.map((item) => item.area)),
      channels: uniqueStrings(items.map((item) => item.channel)),
      conversations: uniqueStrings(items.filter((item) => item?.kind === "conversation").map((item) => item.id)),
      categories: uniqueStrings(items.map((item) => item.category)),
      items: clone(items)
    };
    return clone(this.lastMetadata);
  }

  async registerPermissionGrant({ grant }) {
    this.assertGrantFolders(grant);
    if (typeof this.connector.registerPermissionGrant !== "function") {
      throw new GoogleDriveLifecycleError("DRIVE_GRANT_REGISTRATION_UNAVAILABLE", "I could not activate the saved Drive read-only grant safely, so no file content was read.");
    }
    return this.connector.registerPermissionGrant({ grant });
  }

  async revokePermissionGrant({ grantId }) {
    if (typeof this.connector.revokePermissionGrant !== "function") {
      throw new GoogleDriveLifecycleError("DRIVE_REVOCATION_UNAVAILABLE", "I could not confirm revocation with this Drive connector.");
    }
    return this.connector.revokePermissionGrant({ grantId });
  }

  async fetchApprovedContent({ source, accountId, grant }) {
    if (source !== SOURCE) throw new GoogleDriveLifecycleError("DRIVE_SOURCE_MISMATCH", "The source did not match the Drive review, so no content was read.");
    this.assertGrantFolders(grant);
    const result = await this.connector.fetchApprovedContent({ source, accountId, grant });
    if (result?.rawBodiesReturned === true) {
      throw new GoogleDriveLifecycleError("DRIVE_BODY_BOUNDARY_INVALID", "The Drive connector did not preserve the source-body boundary, so no file content was exposed.");
    }
    if (!Array.isArray(result?.records)) return result;
    const records = result.records.map((record) => {
      const sourceRecordId = typeof record?.sourceRecordId === "string" ? record.sourceRecordId : record?.id;
      if (!isOpaqueGoogleId(sourceRecordId)) {
        throw new GoogleDriveLifecycleError("DRIVE_RECORD_INVALID", "The Drive connector returned an invalid approved reference, so no file content was exposed.");
      }
      if (this.reviewedRecordFolders) {
        const reviewedFolderId = this.reviewedRecordFolders.get(sourceRecordId);
        if (!reviewedFolderId || !grant.scope.folders.includes(reviewedFolderId)) {
          throw new GoogleDriveLifecycleError("UNREVIEWED_DRIVE_RECORD", "The Drive connector returned a file outside the final granted folders, so no file content was exposed.");
        }
      }
      return { sourceRecordId, source: SOURCE };
    });
    return { rawBodiesReturned: false, records };
  }
}

function publicView(entry, language, permissionReview = null) {
  const wording = copy(language);
  const partial = entry.authorization.status === "partial";
  const message = entry.status === "awaiting-authorization"
    ? wording.awaitingAuthorization
    : entry.status === "awaiting-folder-review"
      ? (partial ? wording.partial : wording.folderReview)
      : entry.status === "authorization-cancelled" || entry.status === "authorization-denied" || entry.status === "authorization-unavailable"
        ? wording.cancelled
        : entry.status === "revoked"
          ? wording.revoked
        : entry.status === "revocation-unconfirmed"
            ? wording.revocationUnconfirmed
          : entry.status === "needs-attention"
            ? wording.needsAttention
          : entry.status === "ready-to-fetch"
            ? wording.ready
            : entry.status === "imported"
              ? wording.imported
              : wording.start;
  return {
    source: SOURCE,
    status: entry.status,
    message,
    connection: {
      separateFrom: ["gmail", "calendar"],
      authorizationStatus: entry.authorization.status,
      verifiedReadOnly: !["authorization-unavailable", "needs-attention", "revoked", "revocation-unconfirmed"].includes(entry.status) && entry.authorization.readOnly === true,
      metadataOnlyAuthorization: !["authorization-unavailable", "needs-attention", "revoked", "revocation-unconfirmed"].includes(entry.status) && entry.authorization.metadataOnly === true,
      remoteRevocationVerified: entry.status === "revoked",
      partial,
      live: false,
      canEditFiles: false,
      canMoveFiles: false,
      canShareFiles: false,
      canDeleteFiles: false
    },
    folderBoundary: {
      authorizedFolderIds: clone(entry.authorizedFolderIds),
      selectionRequired: true,
      dateWindow: "selected-folders-only"
    },
    verificationBoundary: wording.metadataOnly,
    permissionReview: permissionReview ? clone(permissionReview) : null,
    audit: clone(entry.audit)
  };
}

function pluginStatus(result) {
  return AUTHORIZATION_STATUSES.has(result?.status) ? result.status : "unavailable";
}

function nextStatusForAuthorization(status) {
  if (status === "cancelled") return "authorization-cancelled";
  if (status === "denied") return "authorization-denied";
  if (status === "revoked") return "revoked";
  return "authorization-unavailable";
}

async function startFolderReview({ stateStore, connector, accountId, entry, language, clock, reviewIdFactory }) {
  const bounded = new FolderBoundedDriveConnector(connector, entry.authorizedFolderIds);
  let review;
  try {
    review = await beginSourcePermissionReview({
      message: language === "es" ? "Quiero revisar Google Drive para mi segundo cerebro" : "I want to review Google Drive for my second brain",
      stateStore,
      connector: bounded,
      source: SOURCE,
      language,
      clock,
      reviewIdFactory
    });
    if (review.permissionReview.account.id !== accountId) {
      throw new GoogleDriveLifecycleError("DRIVE_ACCOUNT_MISMATCH", "The Drive account did not match this saved connection, so no file content was requested.");
    }
  } catch (error) {
    const failedState = await loadState(stateStore);
    const failedEntry = assertEntry(failedState, accountId);
    failedEntry.status = "authorization-unavailable";
    failedEntry.authorization = {
      ...failedEntry.authorization,
      status: "unavailable",
      readOnly: false,
      metadataOnly: false
    };
    failedEntry.authorizedFolderIds = [];
    failedEntry.reviewId = null;
    failedEntry.normalizedMetadataById = {};
    failedEntry.audit.push({ type: "drive-metadata-review-unavailable", at: isoNow(clock), reason: error?.code ?? "metadata-review-failed", contentBodiesRead: false });
    await stateStore.save(failedState);
    return { drive: publicView(failedEntry, languageFor(failedState, language)), metadataReviewUnavailable: true };
  }

  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "awaiting-folder-review";
  refreshedEntry.reviewId = review.permissionReview.permissionRequest.reviewId;
  refreshedEntry.normalizedMetadataById = normalizeDriveMetadata(bounded.lastMetadata, refreshedEntry.authorizedFolderIds, refreshedEntry.accountId);
  refreshedEntry.audit.push({ type: "drive-folder-metadata-reviewed", at: isoNow(clock), reviewId: refreshedEntry.reviewId, contentBodiesRead: false });
  await stateStore.save(refreshed);
  return { drive: publicView(refreshedEntry, languageFor(refreshed, language), review.permissionReview) };
}

/** Starts the separate, normal-language Drive connection; it does not authorize or read anything. */
export async function beginGoogleDriveConnection({ message, stateStore, accountId = "google-drive", language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const records = lifecycle(state);
  const key = entryKey(accountId);
  if (!records.entries[key]) {
    const now = isoNow(clock);
    records.entries[key] = newEntry(accountId, now);
    records.audit.push({ type: "drive-connection-offered", at: now, accountId });
    await stateStore.save(state);
  }
  return { drive: publicView(records.entries[key], languageFor(state, language)) };
}

/** Opens an injected official desktop-plugin authorization only after explicit customer approval. */
export async function authorizeGoogleDriveReadOnly({
  message,
  stateStore,
  plugin,
  connector,
  accountId = "google-drive",
  authorizationApproved = false,
  language,
  clock,
  reviewIdFactory
}) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status === "awaiting-folder-review" || entry.status === "ready-to-fetch" || entry.status === "imported") {
    const existing = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
    return { drive: publicView(entry, languageFor(state, language), existing?.permissionReview) };
  }
  if (authorizationApproved !== true) return { drive: publicView(entry, languageFor(state, language)) };
  assertPlugin(plugin);
  assertConnector(connector);

  const now = isoNow(clock);
  let result;
  try {
    result = await plugin.authorizeFolderScopedReadOnly({
      source: SOURCE,
      accountId,
      purpose: "Review only selected Google Drive folders for a private second brain.",
      requestedAccess: "metadata-only-read-only"
    });
  } catch {
    result = { status: "unavailable" };
  }
  const status = pluginStatus(result);
  const folders = uniqueOpaqueGoogleIds(result?.approvedFolderIds);
  entry.authorization = {
    status,
    readOnly: result?.readOnly === true,
    metadataOnly: result?.metadataOnly === true,
    attempts: entry.authorization.attempts + 1,
    attemptedAt: now
  };
  entry.audit.push({
    type: "drive-plugin-authorization-attempt",
    at: now,
    status,
    readOnly: result?.readOnly === true,
    metadataOnly: result?.metadataOnly === true
  });
  if (!["authorized", "partial"].includes(status) || result?.readOnly !== true || result?.metadataOnly !== true || folders.length === 0 || result?.accountId !== accountId) {
    entry.status = result?.accountId && result.accountId !== accountId ? "authorization-unavailable" : nextStatusForAuthorization(status);
    entry.authorizedFolderIds = [];
    await stateStore.save(state);
    return { drive: publicView(entry, languageFor(state, language)) };
  }
  entry.authorizedFolderIds = folders;
  entry.status = "authorizing-folder-review";
  await stateStore.save(state);
  return startFolderReview({ stateStore, connector, accountId, entry, language: languageFor(state, language), clock, reviewIdFactory });
}

/** Saves a selected-folder-only grant; a folder outside the plugin allowlist cannot be added. */
export async function grantGoogleDriveFolderContent({
  message,
  stateStore,
  connector,
  accountId = "google-drive",
  reviewId,
  scope,
  language,
  clock,
  grantIdFactory
}) {
  assertNaturalLanguage(message);
  assertConnector(connector);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status !== "awaiting-folder-review" || entry.reviewId !== reviewId) {
    throw new GoogleDriveLifecycleError("DRIVE_FOLDER_REVIEW_NOT_READY", "Continue the saved Drive folder review before approving file content.");
  }
  const bounded = new FolderBoundedDriveConnector(connector, entry.authorizedFolderIds);
  const granted = await grantSourcePermission({
    message,
    stateStore,
    connector: bounded,
    source: SOURCE,
    accountId,
    reviewId,
    scope,
    language,
    clock,
    grantIdFactory
  });
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "ready-to-fetch";
  refreshedEntry.audit.push({ type: "drive-folder-grant-saved", at: isoNow(clock), reviewId, grantId: granted.permissionReview.activeGrant?.grantId ?? null });
  await stateStore.save(refreshed);
  return { drive: publicView(refreshedEntry, languageFor(refreshed, language), granted.permissionReview) };
}

/** Fetches only approved opaque Drive references, enriching them with safe preflight metadata. */
export async function fetchApprovedGoogleDriveContent({ message, stateStore, connector, accountId = "google-drive", reviewId, language, clock }) {
  assertNaturalLanguage(message);
  assertConnector(connector);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status !== "ready-to-fetch" || entry.reviewId !== reviewId) {
    throw new GoogleDriveLifecycleError("DRIVE_GRANT_REQUIRED", "No Drive file content was read because the saved selected-folder grant is not ready.");
  }
  const bounded = new FolderBoundedDriveConnector(connector, entry.authorizedFolderIds, {
    reviewedRecordFolders: Object.fromEntries(
      Object.entries(entry.normalizedMetadataById).map(([recordId, metadata]) => [recordId, metadata.folderId])
    )
  });
  let fetched;
  try {
    fetched = await fetchApprovedSourceContent({ message, stateStore, connector: bounded, source: SOURCE, accountId, reviewId, language, clock });
  } catch (error) {
    if (!isRecoverableConnectorFailure(error)) throw error;
    const safeLanguage = languageFor(state, language);
    const localRevocation = await revokeLocalDriveGrantAfterFailure({ stateStore, accountId, reviewId, language: safeLanguage, clock });
    const failedState = await loadState(stateStore);
    const failedEntry = assertEntry(failedState, accountId);
    const status = fetchFailureStatus(error);
    failedEntry.status = status;
    failedEntry.authorization = {
      ...failedEntry.authorization,
      status: status === "revoked" ? "revoked" : "unavailable",
      readOnly: false,
      metadataOnly: false
    };
    failedEntry.authorizedFolderIds = [];
    failedEntry.reviewId = null;
    failedEntry.normalizedMetadataById = {};
    failedEntry.audit.push({
      type: "drive-approved-reference-fetch-interrupted",
      at: isoNow(clock),
      reason: safeFailureCode(error),
      localGrantInvalidated: localRevocation !== null,
      bodyAccessState: "unconfirmed-after-connector-failure"
    });
    await stateStore.save(failedState);
    return {
      drive: publicView(failedEntry, languageFor(failedState, language), localRevocation?.permissionReview),
      importUnavailable: true,
      recoveryRequired: true
    };
  }
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  const normalizedSourceRecords = fetched.approvedRecords
    .map((record) => refreshedEntry.normalizedMetadataById[record.sourceRecordId])
    .filter(Boolean)
    .map((metadata) => ({ ...clone(metadata), processingDisposition: "untrusted-inert-reference" }));
  refreshedEntry.status = "imported";
  refreshedEntry.audit.push({ type: "drive-approved-references-imported", at: isoNow(clock), reviewId, recordCount: normalizedSourceRecords.length });
  await stateStore.save(refreshed);
  return {
    drive: publicView(refreshedEntry, languageFor(refreshed, language), fetched.permissionReview),
    approvedRecords: fetched.approvedRecords,
    normalizedSourceRecords
  };
}

/** Revokes the local grant and asks the plugin to revoke its read-only authorization when supported. */
export async function revokeGoogleDriveConnection({ message, stateStore, connector, plugin, accountId = "google-drive", reviewId, language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  let permissionReview = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
  if (entry.reviewId && permissionReview?.permissionReview?.activeGrant) {
    assertConnector(connector);
    const bounded = new FolderBoundedDriveConnector(connector, entry.authorizedFolderIds);
    permissionReview = await revokeSourcePermission({ message, stateStore, connector: bounded, source: SOURCE, accountId, reviewId, language, clock });
  }
  const remoteAuthorizationWasGranted = ["authorized", "partial"].includes(entry.authorization.status);
  let pluginRevoked = false;
  if (plugin && typeof plugin.revokeFolderScopedReadOnly === "function") {
    try {
      const result = await plugin.revokeFolderScopedReadOnly({ source: SOURCE, accountId });
      pluginRevoked = result?.status === "revoked";
    } catch {
      pluginRevoked = false;
    }
  }
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = pluginRevoked || !remoteAuthorizationWasGranted ? "revoked" : "revocation-unconfirmed";
  refreshedEntry.authorization.status = pluginRevoked ? "revoked" : refreshedEntry.authorization.status;
  refreshedEntry.audit.push({ type: "drive-connection-revocation-requested", at: isoNow(clock), reviewId: reviewId ?? null, pluginRevoked });
  await stateStore.save(refreshed);
  return { drive: publicView(refreshedEntry, languageFor(refreshed, language), permissionReview?.permissionReview) };
}

/** Read-only status lookup; never invokes a Drive plugin or connector. */
export async function getGoogleDriveConnectionStatus({ stateStore, accountId = "google-drive", language }) {
  const state = await loadState(stateStore);
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry) return null;
  const permission = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
  return { drive: publicView(entry, languageFor(state, language), permission?.permissionReview) };
}
