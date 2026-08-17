/**
 * QWA-150 iMessage beta lifecycle.
 *
 * iMessage is never presented as an ordinary cloud connection. A customer
 * explicitly approves an attempted local, read-only macOS access path; if that
 * is unavailable, the same Setup Session can continue with a clearly labeled
 * one-time snapshot. Message content is delegated to the QWA-139 granular
 * permission lifecycle and remains opaque outside the injected connector.
 */

import {
  beginSourcePermissionReview,
  fetchApprovedSourceContent,
  getSourcePermissionStatus,
  grantSourcePermission,
  revokeSourcePermission
} from "../permissions/setup-source-permissions.mjs";

const STATE_KEY = "imessageBetaLifecycle";
const SOURCE = "imessage";
const LOCAL_STATUSES = new Set(["granted", "denied", "unavailable"]);

export class IMessageBetaError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "IMessageBetaError";
    this.code = code;
    this.customerMessage = customerMessage;
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
    throw new IMessageBetaError("IMESSAGE_MESSAGE_REQUIRED", "Tell me in normal language whether you want to try iMessage or import a snapshot.");
  }
  if (message.trim().startsWith("/")) {
    throw new IMessageBetaError("NO_SLASH_COMMANDS", "You do not need a command. Tell me what you want to do with iMessage in normal language.");
  }
}

function languageFor(state, language) {
  return language === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function copy(language) {
  if (language === "es") {
    return {
      start: "iMessage es una función beta local, no un conector de nube. Primero puedo pedir permiso de macOS para intentar acceso de solo lectura a tu base local. Si no es seguro o no está disponible, puedes continuar con una importación marcada como instantánea.",
      awaiting: "iMessage es una función beta local, no un conector de nube. No he intentado leer tu base local de iMessage. Revisa la explicación y aprueba el intento local de solo lectura, o elige una instantánea.",
      localReady: "El acceso local beta confirmó solo metadatos. Ahora puedes revisar contactos, grupos, exclusiones y el alcance antes de que se procese cualquier mensaje.",
      snapshotReady: "El acceso local beta no está disponible. Esto no bloquea la configuración; puedes continuar con una importación de iMessage marcada como instantánea, no como conexión en vivo.",
      snapshotReview: "Esta importación de iMessage es una instantánea única y beta, no una conexión en vivo. Revisé solo metadatos para preparar tus límites de contacto y conversación.",
      readonly: "iMessage permanece solo de lectura. Esta configuración no puede enviar, editar ni eliminar mensajes.",
      attachment: "Los adjuntos permanecen excluidos hasta que los apruebes por separado.",
      identifiers: "Los identificadores de alto riesgo permanecen excluidos hasta que los apruebes por separado.",
      processed: "Procesé únicamente referencias opacas aprobadas. La fuente sigue siendo beta y de solo lectura."
    };
  }
  return {
    start: "iMessage is a local beta feature, not a cloud connector. I can first ask macOS permission to attempt read-only access to your local database. If that is not safe or available, you can continue with an import labeled as a snapshot.",
    awaiting: "iMessage is a local beta feature, not a cloud connector. I have not attempted to read your local iMessage database. Review the explanation and approve the read-only local attempt, or choose a snapshot.",
    localReady: "The local beta access confirmed metadata only. You can now review contacts, groups, exclusions, and scope before any message is processed.",
    snapshotReady: "Local beta access is not available. This does not block setup; you can continue with an iMessage import labeled as a snapshot, not a live connection.",
    snapshotReview: "This iMessage import is a one-time beta snapshot, not a live connection. I reviewed metadata only to prepare your contact and conversation boundaries.",
    readonly: "iMessage remains read-only. This setup cannot send, edit, or delete messages.",
    attachment: "Attachments remain excluded until you approve them separately.",
    identifiers: "High-risk identifiers remain excluded until you approve them separately.",
    processed: "I processed only approved opaque references. The source remains beta and read-only."
  };
}

function entryKey(accountId) {
  return `${SOURCE}:${encodeURIComponent(accountId)}`;
}

function lifecycle(state) {
  if (!state[STATE_KEY]) {
    state[STATE_KEY] = { version: 1, entries: {}, audit: [] };
  }
  return state[STATE_KEY];
}

function requireSetup(state) {
  if (!state) {
    throw new IMessageBetaError("SETUP_SESSION_NOT_FOUND", "Start your second-brain setup first, then I can guide the iMessage beta in this same conversation.");
  }
}

function newEntry(accountId, now) {
  return {
    source: SOURCE,
    accountId,
    status: "awaiting-macos-permission",
    mode: null,
    connectionTruth: "beta",
    localAccess: { status: "not-attempted", attempts: 0 },
    snapshot: { available: true, started: false, oneTime: true, live: false },
    contactAndGroupPrivacyApplied: false,
    sensitiveApprovals: {
      attachments: { approved: false, approvedAt: null },
      highRiskIdentifiers: { approved: false, approvedAt: null }
    },
    reviewId: null,
    audit: [{ type: "imessage-beta-offered", at: now }]
  };
}

function assertEntry(state, accountId) {
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry) {
    throw new IMessageBetaError("IMESSAGE_BETA_NOT_STARTED", "Tell me you would like to try iMessage first, and I will explain the local beta and snapshot choices.");
  }
  return entry;
}

function isHighRiskIncluded(scope) {
  return Array.isArray(scope?.sensitiveGroups?.included) && scope.sensitiveGroups.included.length > 0;
}

function publicView(entry, language, permissionReview = null) {
  const wording = copy(language);
  const isSnapshot = entry.mode === "snapshot";
  const isLocal = entry.mode === "local-macos-beta";
  const message = entry.status === "awaiting-macos-permission"
    ? wording.awaiting
    : entry.status === "snapshot-available"
      ? wording.snapshotReady
      : entry.status === "awaiting-content-grant" && isSnapshot
        ? wording.snapshotReview
        : entry.status === "awaiting-content-grant" && isLocal
          ? wording.localReady
          : entry.status === "processed"
            ? wording.processed
            : entry.status === "ready-to-process"
              ? wording.readonly
              : wording.start;
  return {
    source: SOURCE,
    status: entry.status,
    message,
    connection: {
      mode: isSnapshot ? "snapshot" : isLocal ? "local-macos-beta" : "beta-offered",
      beta: true,
      live: false,
      oneTimeSnapshot: isSnapshot,
      readOnly: true,
      canSendMessages: false,
      canAlterMessages: false
    },
    localAccess: clone(entry.localAccess),
    snapshot: clone(entry.snapshot),
    privacy: {
      contactAndGroupPrivacyApplied: entry.contactAndGroupPrivacyApplied,
      attachments: {
        status: entry.sensitiveApprovals.attachments.approved ? "separately-approved" : "excluded-unless-separately-approved",
        message: wording.attachment
      },
      highRiskIdentifiers: {
        status: entry.sensitiveApprovals.highRiskIdentifiers.approved ? "separately-approved" : "excluded-unless-separately-approved",
        message: wording.identifiers
      }
    },
    permissionReview: permissionReview ? clone(permissionReview) : null,
    audit: clone(entry.audit)
  };
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  requireSetup(state);
  return state;
}

function assertLocalAdapter(adapter) {
  if (!adapter || typeof adapter.requestReadOnlyDatabaseAccess !== "function") {
    throw new TypeError("A local iMessage adapter with requestReadOnlyDatabaseAccess() is required.");
  }
}

function assertIMessageConnector(connector) {
  if (!connector || typeof connector.discoverMetadata !== "function" || typeof connector.fetchApprovedContent !== "function") {
    throw new TypeError("A read-only iMessage connector with metadata discovery and bounded fetch is required.");
  }
}

async function beginContentPrivacyReview({
  stateStore,
  connector,
  accountId,
  language,
  clock,
  reviewIdFactory,
  mode
}) {
  let review;
  try {
    review = await beginSourcePermissionReview({
      message: language === "es"
        ? "Quiero conectar iMessage a mi segundo cerebro"
        : "I want to connect iMessage to my second brain",
      stateStore,
      connector,
      source: SOURCE,
      language,
      clock,
      reviewIdFactory
    });
    if (review.permissionReview.account.id !== accountId) {
      throw new IMessageBetaError(
        "IMESSAGE_ACCOUNT_MISMATCH",
        "I could not confirm that the reviewed iMessage account matches this saved setup, so no message content was requested. You can safely retry with the correct snapshot."
      );
    }
  } catch (error) {
    const fallbackState = await loadState(stateStore);
    const fallbackEntry = assertEntry(fallbackState, accountId);
    const now = isoNow(clock);
    fallbackEntry.status = "snapshot-available";
    fallbackEntry.mode = "snapshot";
    fallbackEntry.audit.push({
      type: "imessage-metadata-review-unavailable",
      at: now,
      mode,
      reason: error?.code ?? "metadata-review-failed",
      contentBodiesRead: false
    });
    lifecycle(fallbackState).audit.push({
      type: "imessage-snapshot-fallback-available",
      at: now,
      accountId,
      reason: error?.code ?? "metadata-review-failed"
    });
    await stateStore.save(fallbackState);
    return {
      iMessageBeta: publicView(fallbackEntry, languageFor(fallbackState, language)),
      metadataReviewUnavailable: true
    };
  }

  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.reviewId = review.permissionReview.permissionRequest.reviewId;
  refreshedEntry.contactAndGroupPrivacyApplied = true;
  refreshedEntry.audit.push({
    type: "contact-and-group-metadata-reviewed",
    at: isoNow(clock),
    reviewId: refreshedEntry.reviewId,
    mode
  });
  await stateStore.save(refreshed);
  return { iMessageBeta: publicView(refreshedEntry, languageFor(refreshed, language), review.permissionReview) };
}

/** Starts the non-blocking, customer-visible choice between local beta and snapshot import. */
export async function beginIMessageBeta({ message, stateStore, accountId = "local-imessage", language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const records = lifecycle(state);
  const now = isoNow(clock);
  const key = entryKey(accountId);
  if (!records.entries[key]) {
    records.entries[key] = newEntry(accountId, now);
    records.audit.push({ type: "imessage-beta-offered", at: now, accountId });
    await stateStore.save(state);
  }
  return { iMessageBeta: publicView(records.entries[key], languageFor(state, language)) };
}

/**
 * Attempts local database access only after the caller records explicit macOS
 * approval. A denial, unavailable adapter, or local failure moves to the
 * snapshot path without changing the Setup Session's completion state.
 */
export async function attemptIMessageLocalAccess({
  message,
  stateStore,
  localAdapter,
  connector,
  accountId = "local-imessage",
  macOSPermissionApproved = false,
  language,
  clock,
  reviewIdFactory
}) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  const now = isoNow(clock);
  if (entry.status !== "awaiting-macos-permission") {
    const existing = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
    return { iMessageBeta: publicView(entry, languageFor(state, language), existing?.permissionReview) };
  }
  if (macOSPermissionApproved !== true) {
    return { iMessageBeta: publicView(entry, languageFor(state, language)) };
  }
  assertLocalAdapter(localAdapter);
  assertIMessageConnector(connector);

  let result;
  try {
    result = await localAdapter.requestReadOnlyDatabaseAccess({
      purpose: "Prepare a metadata-only iMessage beta privacy review after explicit customer approval.",
      source: SOURCE
    });
  } catch {
    result = { status: "unavailable" };
  }
  const localStatus = LOCAL_STATUSES.has(result?.status) ? result.status : "unavailable";
  entry.localAccess = { status: localStatus, attempts: entry.localAccess.attempts + 1, attemptedAt: now };
  entry.audit.push({ type: "local-read-only-access-attempt", at: now, result: localStatus });

  if (localStatus !== "granted") {
    entry.status = "snapshot-available";
    entry.mode = "snapshot";
    lifecycle(state).audit.push({ type: "imessage-snapshot-fallback-available", at: now, accountId, reason: localStatus });
    await stateStore.save(state);
    return { iMessageBeta: publicView(entry, languageFor(state, language)) };
  }

  entry.status = "awaiting-content-grant";
  entry.mode = "local-macos-beta";
  await stateStore.save(state);
  return beginContentPrivacyReview({
    stateStore,
    connector,
    accountId,
    language: languageFor(state, language),
    clock,
    reviewIdFactory,
    mode: "local-macos-beta"
  });
}

/** Starts a one-time snapshot privacy review. It reads metadata only and never calls the local adapter. */
export async function beginIMessageSnapshotImport({
  message,
  stateStore,
  connector,
  accountId = "local-imessage",
  language,
  clock,
  reviewIdFactory
}) {
  assertNaturalLanguage(message);
  assertIMessageConnector(connector);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status === "awaiting-content-grant" && entry.mode === "snapshot") {
    const current = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
    return { iMessageBeta: publicView(entry, languageFor(state, language), current?.permissionReview) };
  }
  if (entry.status !== "snapshot-available" && entry.status !== "awaiting-macos-permission") {
    throw new IMessageBetaError("SNAPSHOT_NOT_AVAILABLE", "This iMessage path is already in progress. Continue the saved review instead of starting a second import.");
  }
  const now = isoNow(clock);
  entry.mode = "snapshot";
  entry.status = "awaiting-content-grant";
  entry.snapshot = { available: true, started: true, oneTime: true, live: false, startedAt: now };
  entry.audit.push({ type: "snapshot-import-started", at: now });
  await stateStore.save(state);
  const result = await beginContentPrivacyReview({
    stateStore,
    connector,
    accountId,
    language: languageFor(state, language),
    clock,
    reviewIdFactory,
    mode: "snapshot"
  });
  if (result.metadataReviewUnavailable) {
    throw new IMessageBetaError(
      "SNAPSHOT_METADATA_REVIEW_UNAVAILABLE",
      "I could not safely review this snapshot's metadata, so no iMessage content was requested. You can retry this saved snapshot review."
    );
  }
  return result;
}

/** Records separately requested attachment/high-risk handling without touching a message source. */
export async function approveIMessageSensitiveContent({
  message,
  stateStore,
  accountId = "local-imessage",
  reviewId,
  attachments = false,
  highRiskIdentifiers = false,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (!entry.contactAndGroupPrivacyApplied || !entry.reviewId || entry.reviewId !== reviewId) {
    throw new IMessageBetaError("CONTACT_PRIVACY_REVIEW_REQUIRED", "Review contacts and group-thread privacy before separately approving attachments or high-risk identifiers.");
  }
  const now = isoNow(clock);
  entry.sensitiveApprovals = {
    attachments: { approved: attachments === true, approvedAt: attachments === true ? now : null },
    highRiskIdentifiers: { approved: highRiskIdentifiers === true, approvedAt: highRiskIdentifiers === true ? now : null }
  };
  entry.audit.push({
    type: "imessage-sensitive-content-reviewed",
    at: now,
    reviewId,
    attachmentsApproved: attachments === true,
    highRiskIdentifiersApproved: highRiskIdentifiers === true
  });
  await stateStore.save(state);
  const current = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
  return { iMessageBeta: publicView(entry, languageFor(state, language), current?.permissionReview) };
}

/** Grants the normal QWA-139 message-body scope while enforcing iMessage's separate high-risk gate. */
export async function grantIMessageContent({
  message,
  stateStore,
  connector,
  accountId = "local-imessage",
  reviewId,
  scope,
  language,
  clock,
  grantIdFactory
}) {
  assertNaturalLanguage(message);
  assertIMessageConnector(connector);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status !== "awaiting-content-grant" || entry.reviewId !== reviewId) {
    throw new IMessageBetaError("IMESSAGE_REVIEW_NOT_READY", "Continue the saved iMessage privacy review before approving any message content.");
  }
  if (isHighRiskIncluded(scope) && !entry.sensitiveApprovals.highRiskIdentifiers.approved) {
    throw new IMessageBetaError("HIGH_RISK_APPROVAL_REQUIRED", "High-risk identifiers remain excluded. Review and approve them separately before including that category in this iMessage scope.");
  }
  const granted = await grantSourcePermission({
    message,
    stateStore,
    connector,
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
  refreshedEntry.status = "ready-to-process";
  refreshedEntry.audit.push({ type: "imessage-content-granted", at: isoNow(clock), reviewId, grantId: granted.permissionReview.activeGrant?.grantId ?? null });
  await stateStore.save(refreshed);
  return { iMessageBeta: publicView(refreshedEntry, languageFor(refreshed, language), granted.permissionReview) };
}

/**
 * Fetches only opaque approved records. The connector receives the persisted
 * separate-content policy before the QWA-139 fetch, so attachments and high
 * risk records are excluded structurally rather than filtered after access.
 */
export async function fetchApprovedIMessageContent({
  message,
  stateStore,
  connector,
  accountId = "local-imessage",
  reviewId,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  assertIMessageConnector(connector);
  if (typeof connector.setIMessageContentPolicy !== "function") {
    throw new TypeError("An iMessage connector with setIMessageContentPolicy() is required to enforce attachment and identifier exclusions.");
  }
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status !== "ready-to-process" || entry.reviewId !== reviewId) {
    throw new IMessageBetaError("IMESSAGE_GRANT_REQUIRED", "No iMessage content was processed because the saved granular review is not ready.");
  }
  await connector.setIMessageContentPolicy({
    attachmentsApproved: entry.sensitiveApprovals.attachments.approved,
    highRiskIdentifiersApproved: entry.sensitiveApprovals.highRiskIdentifiers.approved
  });
  const fetched = await fetchApprovedSourceContent({
    message,
    stateStore,
    connector,
    source: SOURCE,
    accountId,
    reviewId,
    language,
    clock
  });
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "processed";
  refreshedEntry.audit.push({ type: "imessage-approved-content-processed", at: isoNow(clock), reviewId, recordCount: fetched.approvedRecords.length });
  await stateStore.save(refreshed);
  return {
    iMessageBeta: publicView(refreshedEntry, languageFor(refreshed, language), fetched.permissionReview),
    approvedRecords: fetched.approvedRecords
  };
}

/** Revokes the standard read-only grant; it cannot send, alter, or delete an iMessage. */
export async function revokeIMessageContent({ message, stateStore, connector, accountId = "local-imessage", reviewId, language, clock }) {
  assertNaturalLanguage(message);
  const revoked = await revokeSourcePermission({ message, stateStore, connector, source: SOURCE, accountId, reviewId, language, clock });
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  entry.status = "snapshot-available";
  entry.mode = "snapshot";
  entry.audit.push({ type: "imessage-content-revoked", at: isoNow(clock), reviewId });
  await stateStore.save(state);
  return { iMessageBeta: publicView(entry, languageFor(state, language), revoked.permissionReview) };
}

/** Read-only status lookup; it never invokes a local adapter or connector. */
export async function getIMessageBetaStatus({ stateStore, accountId = "local-imessage", language }) {
  const state = await loadState(stateStore);
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry) return null;
  const permission = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
  return { iMessageBeta: publicView(entry, languageFor(state, language), permission?.permissionReview) };
}
