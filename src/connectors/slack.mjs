/**
 * QWA-148 Slack setup lifecycle.
 *
 * The public Setup Session owns the customer conversation and invokes an
 * injected official-plugin seam only after explicit approval. This vertical
 * slice is deliberately simulation-only: `live` is always false, and source
 * records remain opaque stable references outside the injected adapter.
 */

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import {
  SENSITIVE_CATEGORIES,
  beginSpecializedSourcePermissionReview,
  denySpecializedSourcePermission,
  fetchApprovedSpecializedSourceContent,
  getSpecializedSourcePermissionStatus,
  getSpecializedSourcePermissionStatusFromState,
  grantSpecializedSourcePermission,
  revokeSpecializedSourcePermission,
  withSourcePermissionStateReadLock,
  withSourcePermissionStateLock
} from "../permissions/setup-source-permissions.mjs";

const SOURCE = "slack";
const STATE_KEY = "slackLifecycle";
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const WRITE_CAPABILITIES = Object.freeze([
  "canPost",
  "canReact",
  "canEdit",
  "canArchive",
  "canInvite",
  "canChangeWorkspaceState"
]);
const SLACK_AREAS = new Set(["channels", "direct-messages", "group-messages"]);
const SLACK_CONVERSATION_TYPES = Object.freeze({
  channels: "channel-thread",
  "direct-messages": "direct-message",
  "group-messages": "group-message"
});
const KNOWN_SENSITIVE_CATEGORIES = new Set(SENSITIVE_CATEGORIES);
// FileStateStore instances can be reconstructed between saved Setup Session
// calls. Use its private path as a stable in-process operation identity when
// present, while preserving an object-key fallback for other test adapters.
const slackOperationTails = new Map();
const slackRevocationGenerations = new Map();

export class SlackLifecycleError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "SlackLifecycleError";
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
    throw new SlackLifecycleError("SLACK_MESSAGE_REQUIRED", "Tell me in normal language whether you want to connect or review Slack.");
  }
  if (message.trim().startsWith("/")) {
    throw new SlackLifecycleError("NO_SLASH_COMMANDS", "You do not need a command. Tell me what you want to do with Slack in normal language.");
  }
}

function assertOpaqueId(value, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new SlackLifecycleError("SLACK_IDENTIFIER_INVALID", `I could not safely identify the ${field}, so I kept Slack access unchanged.`);
  }
  return value;
}

function languageFor(state, requestedLanguage) {
  return requestedLanguage === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function copy(language) {
  if (language === "es") {
    return {
      start: "Slack está seleccionado pero sin terminar. Esta prueba usa un punto de conexión simulado para el plugin oficial de Slack; no ha conectado un espacio de trabajo real ni leído mensajes.",
      awaitingAuthorization: "Para continuar, aprueba abrir el flujo de autorización de solo lectura del plugin oficial de Slack. No revisaré metadatos ni contenido hasta que lo apruebes.",
      verified: "El punto de conexión simulado verificó una conexión de solo lectura. No puede publicar, reaccionar, editar, archivar, invitar ni cambiar Slack. Ahora revisaré únicamente metadatos para que elijas canales, mensajes directos, grupos, personas y fechas.",
      metadataReady: "Revisé únicamente metadatos de Slack. No he leído ningún cuerpo de mensaje. Revisa el alcance antes de aprobar contenido.",
      ready: "El permiso limitado está listo. Solo puedo procesar referencias de hilos aprobadas y opacas; Slack permanece de solo lectura.",
      processed: "Procesé solo referencias de hilos aprobadas y opacas. Esta prueba no demuestra una conexión de Slack en vivo.",
      skipped: "No se concedió autorización de Slack. Se marcó como omitido y no se revisaron metadatos ni mensajes.",
      needsAttention: "Slack necesita atención antes de continuar. Detuve la revisión de forma segura y no procesé ningún cuerpo de mensaje. Puedes reintentar el paso guardado.",
      revoked: "El acceso de Slack fue revocado. Dejé de procesar la fuente y no afirmaré que está conectada. Inicia una revisión nueva si vuelves a autorizarla.",
      privateChannels: "Los canales privados se excluyen por defecto en esta revisión y no se muestran sus nombres ni identificadores.",
      blockedGroups: "Los grupos con una persona bloqueada se omiten por defecto. Requieren una revisión separada y limitada antes de que puedan incluirse.",
      groupReview: "Este grupo contiene una persona bloqueada. Puedes revisarlo por separado; no se incluirá hasta una confirmación explícita para este único grupo.",
      groupApproved: "La excepción limitada para ese único grupo se guardó. Sigue siendo de solo lectura y no amplía otros grupos ni personas bloqueadas.",
      readOnly: "La verificación y esta fuente son solo de lectura: no pueden publicar, reaccionar, editar, archivar, invitar ni cambiar Slack."
    };
  }
  return {
    start: "Slack is selected but unfinished. This proof uses a simulated official Slack-plugin seam; it has not connected a real workspace or read any messages.",
    awaitingAuthorization: "To continue, approve opening the official Slack plugin's read-only authorization flow. I will not review metadata or content until you approve it.",
    verified: "The simulated seam verified a read-only connection. It cannot post, react, edit, archive, invite, or change Slack. I can now review metadata only so you can choose channels, direct messages, groups, people, and dates.",
    metadataReady: "I reviewed Slack metadata only. I have not read any message body. Review the scope before approving content.",
    ready: "The narrowed permission is ready. I can process only approved opaque thread references; Slack remains read-only.",
    processed: "I processed only approved opaque thread references. This proof does not demonstrate a live Slack connection.",
    skipped: "Slack authorization was not granted. It is marked skipped, and no metadata or message was reviewed.",
    needsAttention: "Slack needs attention before it can continue. I stopped the review safely and did not process any message body. You can retry the saved step.",
    revoked: "Slack access was revoked. I stopped processing the source and will not claim it is connected. Start a new review if you authorize it again.",
    privateChannels: "Private channels are excluded by default from this review, and their names and identifiers are not shown.",
    blockedGroups: "Groups with a blocked person are skipped by default. They need a separate, narrow review before one group can be included.",
    groupReview: "This group includes a blocked person. You can review it separately; it will not be included until an explicit confirmation for this one group.",
    groupApproved: "The narrow exception for that one group is saved. It remains read-only and does not expand other groups or blocked people.",
    readOnly: "The verification and this source are read-only: they cannot post, react, edit, archive, invite, or change Slack."
  };
}

function entryKey(accountId) {
  return `${SOURCE}:${encodeURIComponent(assertOpaqueId(accountId, "Slack workspace"))}`;
}

function lifecycle(state) {
  if (!state[STATE_KEY]) {
    state[STATE_KEY] = { version: 1, entries: {}, audit: [] };
  }
  return state[STATE_KEY];
}

function requireSetup(state) {
  if (!state || typeof state !== "object" || typeof state.status !== "string") {
    throw new SlackLifecycleError("SETUP_SESSION_NOT_FOUND", "Start your second-brain setup first, then I can guide Slack in this same conversation.");
  }
}

function newEntry(accountId, now, priorAudit = []) {
  return {
    source: SOURCE,
    accountId,
    status: "selected-but-unfinished",
    phase: "awaiting-plugin-authorization",
    pluginAuthorization: { status: "not-started", attempts: 0, authorizedAt: null },
    verification: { status: "not-run", verifiedAt: null, readOnly: false },
    metadata: {
      pagination: { status: "not-started", pagesReviewed: 0, pagesExpected: 0 },
      privateChannels: { status: "excluded-by-default", count: 0 }
    },
    reviewId: null,
    // This contains only safe, opaque metadata needed to independently
    // enforce the exact preflight inventory later. It never stores a Slack
    // label, message body, attachment, member profile, or workspace dump.
    reviewedRecordsById: {},
    blockedGroupReviews: {},
    audit: [...priorAudit, { type: "slack-official-plugin-offered", at: now }]
  };
}

function assertEntry(state, accountId) {
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry) {
    throw new SlackLifecycleError("SLACK_NOT_STARTED", "Tell me you would like to connect Slack first, and I will guide the read-only plugin path.");
  }
  return entry;
}

function assertPlugin(plugin) {
  const required = [
    "requestOfficialPluginAuthorization",
    "verifyReadOnlyConnection",
    "discoverMetadata",
    "fetchApprovedContent",
    "registerPermissionGrant",
    "revokePermissionGrant",
    "getSafeMetadataSummary",
    "setSlackContentPolicy",
    "normalizeStableThreadReferences"
  ];
  if (!plugin || required.some((method) => typeof plugin[method] !== "function")) {
    throw new TypeError("A read-only Slack official-plugin seam with authorization, verification, metadata, grant, and bounded-reference methods is required.");
  }
}

function opaqueMetadataId(value, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new SlackLifecycleError("SLACK_METADATA_INVALID", `Slack could not safely identify the ${field}, so no message content was read.`);
  }
  return value;
}

function rawSlackIdentifier(value, field) {
  // Source identifiers are never safe to show verbatim: even an otherwise
  // valid Slack identifier can be adversarial text. Retain raw values only in
  // the injected connector seam, then expose deterministic local aliases.
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SlackLifecycleError("SLACK_METADATA_INVALID", `Slack could not safely identify the ${field}, so no message content was read.`);
  }
  return value;
}

function localSlackAlias(namespace, rawIdentifier) {
  const digest = createHash("sha256")
    .update(`qwave-slack-alias-v1:${namespace}:`)
    .update(rawIdentifier)
    .digest("hex")
    .slice(0, 32);
  return `slack-${namespace}-${digest}`;
}

function publicSlackAccountAlias(rawAccountId) {
  return localSlackAlias("account", rawSlackIdentifier(rawAccountId, "Slack workspace"));
}

function replaceExactIdentifier(value, rawIdentifier, publicAlias) {
  if (value === rawIdentifier) return publicAlias;
  if (Array.isArray(value)) return value.map((item) => replaceExactIdentifier(item, rawIdentifier, publicAlias));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceExactIdentifier(item, rawIdentifier, publicAlias)]));
  }
  return value;
}

// The setup-facing account ID comes from the plugin and is therefore untrusted
// metadata just like a record or person ID. The generic state machine keeps it
// only in private local state so the adapter can be called again; this boundary
// converts every public view to a deterministic local alias.
function redactPublicSlackAccountIdentifier(value, rawAccountId) {
  if (typeof rawAccountId !== "string" || !rawAccountId) return value;
  return replaceExactIdentifier(value, rawAccountId, publicSlackAccountAlias(rawAccountId));
}

function internalizePublicSlackScope(scope, rawAccountId) {
  if (!scope || typeof scope !== "object") return scope;
  const publicAlias = publicSlackAccountAlias(rawAccountId);
  const internal = clone(scope);
  if (internal.accountId === publicAlias) internal.accountId = rawAccountId;
  if (Array.isArray(internal.exclusions?.accounts)) {
    internal.exclusions.accounts = internal.exclusions.accounts.map((value) => value === publicAlias ? rawAccountId : value);
  }
  return internal;
}

class SlackMetadataAliases {
  constructor() {
    this.rawByAlias = new Map();
  }

  alias(namespace, value, field) {
    const raw = rawSlackIdentifier(value, field);
    const alias = localSlackAlias(namespace, raw);
    const key = `${namespace}:${alias}`;
    const existing = this.rawByAlias.get(key);
    if (existing && existing !== raw) {
      throw new SlackLifecycleError("SLACK_IDENTIFIER_ALIAS_COLLISION", "Slack returned an ambiguous metadata identifier, so no message content was read.");
    }
    this.rawByAlias.set(key, raw);
    return alias;
  }

  raw(namespace, alias, field) {
    if (typeof alias !== "string" || !OPAQUE_ID.test(alias)) {
      throw new SlackLifecycleError("SLACK_IDENTIFIER_INVALID", `Slack could not safely identify the ${field}, so no message content was read.`);
    }
    const raw = this.rawByAlias.get(`${namespace}:${alias}`);
    if (!raw) {
      throw new SlackLifecycleError("SLACK_IDENTIFIER_ALIAS_UNAVAILABLE", "Slack no longer has the reviewed identifier mapping, so no message content was read. Start a new review.");
    }
    return raw;
  }
}

function metadataTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new SlackLifecycleError("SLACK_METADATA_INVALID", "Slack metadata did not include a valid timestamp, so no message content was read.");
  }
  return new Date(timestamp).toISOString();
}

function sortedSlackAliases(values, field, aliases, namespace) {
  if (!Array.isArray(values)) {
    throw new SlackLifecycleError("SLACK_METADATA_INVALID", `Slack metadata did not safely describe ${field}, so no message content was read.`);
  }
  return [...new Set(values.map((value) => aliases.alias(namespace, value, field)))].sort();
}

function safeSlackCategory(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/i.test(value)) {
    throw new SlackLifecycleError("SLACK_METADATA_INVALID", "Slack metadata did not include a safe category, so no message content was read.");
  }
  return value.toLowerCase();
}

/**
 * Drops source labels and bodies while retaining the opaque fields needed to
 * bind a later fetch and stable thread reference to this exact preflight.
 */
function normalizeSlackMetadata(metadata, aliases = new SlackMetadataAliases()) {
  if (!metadata || typeof metadata !== "object" || metadata.source !== SOURCE || metadata.readOnly !== true) {
    throw new SlackLifecycleError("SLACK_METADATA_INVALID", "Slack metadata did not confirm a read-only Slack source, so no message content was read.");
  }
  const accountId = opaqueMetadataId(metadata.account?.id, "Slack workspace");
  const people = (Array.isArray(metadata.people) ? metadata.people : []).map((person) => {
    const accessLevel = person?.accessLevel;
    if (!["allowed", "restricted", "blocked"].includes(accessLevel)) {
      throw new SlackLifecycleError("SLACK_PERSON_ACCESS_UNCLASSIFIED", "Slack metadata did not include a valid privacy level for a person, so no message content was read.");
    }
    return {
      id: aliases.alias("person", person?.id, "Slack person"),
      accessLevel,
      label: "Reviewed Slack person"
    };
  });
  if (new Set(people.map((person) => person.id)).size !== people.length) {
    throw new SlackLifecycleError("SLACK_METADATA_INVALID", "Slack metadata had an ambiguous person reference, so no message content was read.");
  }
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const items = (Array.isArray(metadata.items) ? metadata.items : []).map((item) => {
    const rawRecordId = rawSlackIdentifier(item?.id, "Slack record");
    const id = aliases.alias("record", rawRecordId, "Slack record");
    const area = typeof item?.area === "string" ? item.area : "";
    if (!SLACK_AREAS.has(area)) {
      throw new SlackLifecycleError("SLACK_METADATA_INVALID", "Slack metadata did not identify a supported conversation area, so no message content was read.");
    }
    const kind = item?.kind === "conversation" ? "conversation" : "item";
    if (area === "channels" && kind !== "item") {
      throw new SlackLifecycleError("SLACK_METADATA_INVALID", "A Slack channel record was not safely bounded, so no message content was read.");
    }
    if (area !== "channels" && kind !== "conversation") {
      throw new SlackLifecycleError("SLACK_METADATA_INVALID", "A Slack direct or group record was not safely bounded, so no message content was read.");
    }
    if ((area === "group-messages" && item?.isGroup !== true) || (area !== "group-messages" && item?.isGroup === true)) {
      throw new SlackLifecycleError("SLACK_CONVERSATION_TYPE_INVALID", "Slack metadata did not safely distinguish a group from a direct message or channel, so no message content was read.");
    }
    const channel = area === "channels" ? aliases.alias("channel", item?.channel, "Slack channel") : null;
    // Only publicly visible channel metadata may enter this connector. Direct
    // and group conversations are bounded through their own explicit areas.
    if (area === "channels" && item?.visibility !== "public") {
      throw new SlackLifecycleError("SLACK_PRIVATE_CHANNEL_METADATA", "Slack did not prove that a channel was public, so it stayed excluded.");
    }
    if (area !== "channels" && item?.conversation != null && rawSlackIdentifier(item.conversation, "Slack conversation") !== rawRecordId) {
      throw new SlackLifecycleError("SLACK_METADATA_INVALID", "Slack returned an ambiguous conversation reference, so no message content was read.");
    }
    const participantIds = sortedSlackAliases(item?.participantIds ?? [], "Slack participant", aliases, "person");
    if (participantIds.length === 0 || participantIds.some((personId) => !peopleById.has(personId))) {
      throw new SlackLifecycleError("SLACK_PARTICIPANT_BOUNDARY_UNAVAILABLE", "Slack metadata did not safely identify the participants for a record, so no message content was read.");
    }
    const participantAccess = Object.fromEntries(participantIds.map((personId) => [personId, peopleById.get(personId)?.accessLevel ?? "unknown"]));
    const threadId = aliases.alias("thread", item?.threadId ?? rawRecordId, "Slack thread");
    const threadRootId = item?.threadRootId == null
      ? threadId
      : aliases.alias("thread", item.threadRootId, "Slack parent thread");
    const category = aliases.alias("category", safeSlackCategory(item?.category), "Slack category");
    const rawSensitiveCategories = item?.sensitiveCategories;
    const unclassifiedSensitivity = !Array.isArray(rawSensitiveCategories)
      ? rawSensitiveCategories != null
      : rawSensitiveCategories.some((value) => typeof value !== "string" || !KNOWN_SENSITIVE_CATEGORIES.has(value.toLowerCase()));
    const sensitiveCategories = [...new Set((Array.isArray(rawSensitiveCategories) ? rawSensitiveCategories : [])
      .filter((value) => typeof value === "string" && KNOWN_SENSITIVE_CATEGORIES.has(value.toLowerCase()))
      .map((value) => value.toLowerCase()))].sort();
    return {
      id,
      kind,
      area,
      channel,
      // Generic QWA-139 scopes direct/group conversations by the record id.
      conversation: area === "channels" ? null : id,
      conversationId: area === "channels" ? channel : id,
      category,
      timestamp: metadataTimestamp(item?.timestamp),
      participantIds,
      participantAccess,
      sensitiveCategories,
      // Unknown classification is an uncertainty signal, never an invitation
      // to omit it from the sensitive-review boundary.
      uncertainSensitivity: item?.uncertainSensitivity === true || unclassifiedSensitivity,
      isGroup: area === "group-messages",
      threadId,
      threadRootId,
      label: `Reviewed Slack ${area} reference ${id}`
    };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new SlackLifecycleError("SLACK_METADATA_INVALID", "Slack metadata had an ambiguous record reference, so no message content was read.");
  }
  return {
    source: SOURCE,
    account: { id: accountId, label: "Selected Slack workspace" },
    readOnly: true,
    people,
    items
  };
}

function reviewedSlackRecords(metadata) {
  return Object.fromEntries(metadata.items.map((item) => [item.id, {
    sourceRecordId: item.id,
    kind: item.kind,
    area: item.area,
    channel: item.channel,
    conversationId: item.conversationId,
    category: item.category,
    timestamp: item.timestamp,
    participantIds: item.participantIds,
    participantAccess: item.participantAccess,
    sensitiveCategories: item.sensitiveCategories,
    uncertainSensitivity: item.uncertainSensitivity,
    isGroup: item.isGroup,
    threadId: item.threadId,
    threadRootId: item.threadRootId
  }]));
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameParticipantAccess(left, right) {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([id, access], index) => id === rightEntries[index][0] && access === rightEntries[index][1]);
}

function reviewedSlackRecordMatchesCurrent(reviewed, current) {
  return Boolean(current)
    && reviewed.kind === current.kind
    && reviewed.area === current.area
    && reviewed.channel === current.channel
    && reviewed.conversationId === current.conversationId
    && reviewed.category === current.category
    && reviewed.timestamp === current.timestamp
    && reviewed.uncertainSensitivity === current.uncertainSensitivity
    && reviewed.isGroup === current.isGroup
    && reviewed.threadId === current.threadId
    && reviewed.threadRootId === current.threadRootId
    && sameStringArray(reviewed.participantIds, current.participantIds)
    && sameStringArray(reviewed.sensitiveCategories, current.sensitiveCategories)
    && sameParticipantAccess(reviewed.participantAccess, current.participantAccess);
}

function timestampFitsSlackGrant(timestamp, scope) {
  const value = Date.parse(timestamp);
  const from = Date.parse(scope?.dateRange?.from);
  const to = Date.parse(scope?.dateRange?.to);
  if (!Number.isFinite(value) || !Number.isFinite(from) || !Number.isFinite(to) || value < from || value > to) return false;
  return !(scope?.exclusions?.dateRanges ?? []).some((range) => {
    const excludedFrom = Date.parse(range?.from);
    const excludedTo = Date.parse(range?.to);
    return Number.isFinite(excludedFrom) && Number.isFinite(excludedTo) && value >= excludedFrom && value <= excludedTo;
  });
}

function recordFitsSlackGrant(record, grant, accountId) {
  const scope = grant?.scope;
  if (!scope || grant?.source !== SOURCE || grant?.accountId !== accountId || scope.accountId !== accountId || !timestampFitsSlackGrant(record?.timestamp, scope)) return false;
  if (!scope.areas?.includes(record.area) || scope.exclusions?.areas?.includes(record.area)) return false;
  if (!scope.categories?.includes(record.category) || scope.exclusions?.categories?.includes(record.category)) return false;
  if (record.area === "channels") {
    if (!scope.channels?.includes(record.channel) || scope.exclusions?.channels?.includes(record.channel)) return false;
  } else if (!scope.conversations?.includes(record.conversationId) || scope.exclusions?.conversations?.includes(record.conversationId)) {
    return false;
  }
  const excludedPeople = new Set(scope.exclusions?.people ?? []);
  const blockedGroupException = record.kind === "conversation"
    && record.isGroup === true
    && scope.blockedGroupConversationExceptions?.includes(record.conversationId);
  if (blockedGroupException) {
    if ((record.participantIds ?? []).some((personId) => excludedPeople.has(personId) && !scope.people?.blocked?.includes(personId))) return false;
  } else if ((record.participantIds ?? []).some((personId) => excludedPeople.has(personId))) {
    return false;
  }
  const excludedSensitivity = new Set([
    ...(scope.sensitiveGroups?.excluded ?? []),
    ...(scope.exclusions?.categories ?? [])
  ]);
  if (record.uncertainSensitivity === true && excludedSensitivity.has("uncertain-sensitivity")) return false;
  return !(record.sensitiveCategories ?? []).some((category) => excludedSensitivity.has(category));
}

/**
 * Binds every later record and stable thread reference to the opaque metadata
 * inventory shown before the customer grants content access. The plugin is an
 * injected seam, not a trust boundary.
 */
export class SlackBoundedConnector {
  constructor(plugin, { reviewedRecordsById = null } = {}) {
    assertPlugin(plugin);
    this.plugin = plugin;
    this.reviewedRecordsById = reviewedRecordsById === null ? null : new Map(Object.entries(reviewedRecordsById));
    this.lastMetadata = null;
    this.lastPagination = null;
    // Raw Slack identifiers live only for the lifetime of this injected
    // connector. The persisted review/grant and all public outputs contain
    // deterministic local aliases instead.
    this.aliases = new SlackMetadataAliases();
  }

  assertGrant(grant) {
    if (grant?.source !== SOURCE || !OPAQUE_ID.test(grant?.accountId) || grant?.scope?.accountId !== grant.accountId) {
      throw new SlackLifecycleError("SLACK_GRANT_INVALID", "The Slack grant did not match its reviewed workspace boundary, so no message content was read.");
    }
  }

  async assertCompletePagination({ afterDiscovery = false, reviewedRecordCount = 0 } = {}) {
    const summary = await safeMetadataSummary(this.plugin);
    if (!metadataPaginationComplete(summary, {
      requireReviewedPages: afterDiscovery,
      reviewedRecordCount
    })) {
      throw new SlackLifecycleError("SLACK_PAGINATION_INCOMPLETE", "Slack metadata pagination did not finish, so no content review or fetch can continue.");
    }
    this.lastPagination = clone(summary.pagination);
    return summary;
  }

  async discoverMetadata({ source }) {
    if (source !== SOURCE) {
      throw new SlackLifecycleError("SLACK_SOURCE_MISMATCH", "The source did not match the Slack review, so no message content was read.");
    }
    await this.assertCompletePagination();
    this.lastMetadata = normalizeSlackMetadata(await this.plugin.discoverMetadata({ source }), this.aliases);
    await this.assertCompletePagination({
      afterDiscovery: true,
      reviewedRecordCount: this.lastMetadata.items.length
    });
    return clone(this.lastMetadata);
  }

  rawAlias(namespace, alias, field) {
    return this.aliases.raw(namespace, alias, field);
  }

  rawCategories(values) {
    if (!Array.isArray(values)) return values;
    return values.map((value) => KNOWN_SENSITIVE_CATEGORIES.has(value)
      ? value
      : this.rawAlias("category", value, "Slack category"));
  }

  rawGrant(grant) {
    this.assertGrant(grant);
    const rawGrant = clone(grant);
    const scope = rawGrant.scope;
    const rawList = (namespace, values, field) => (Array.isArray(values)
      ? values.map((value) => this.rawAlias(namespace, value, field))
      : values);
    scope.channels = rawList("channel", scope.channels, "Slack channel");
    scope.conversations = rawList("record", scope.conversations, "Slack conversation");
    scope.categories = this.rawCategories(scope.categories);
    scope.people = {
      ...scope.people,
      allowed: rawList("person", scope.people?.allowed, "Slack person"),
      restricted: rawList("person", scope.people?.restricted, "Slack person"),
      blocked: rawList("person", scope.people?.blocked, "Slack person")
    };
    scope.exclusions = {
      ...scope.exclusions,
      channels: rawList("channel", scope.exclusions?.channels, "Slack channel"),
      conversations: rawList("record", scope.exclusions?.conversations, "Slack conversation"),
      categories: this.rawCategories(scope.exclusions?.categories),
      people: rawList("person", scope.exclusions?.people, "Slack person")
    };
    scope.blockedGroupConversationExceptions = rawList(
      "record",
      scope.blockedGroupConversationExceptions,
      "approved blocked Slack group"
    );
    return rawGrant;
  }

  rawApprovedMetadataSnapshot(grant, accountId) {
    const records = [...this.reviewedRecordsById.values()]
      .filter((record) => recordFitsSlackGrant(record, grant, accountId))
      .map((record) => {
        const rawParticipantIds = record.participantIds.map((personId) => this.rawAlias("person", personId, "Slack participant"));
        const rawParticipantAccess = Object.fromEntries(record.participantIds.map((personId, index) => [
          rawParticipantIds[index],
          record.participantAccess?.[personId] ?? "unknown"
        ]));
        return {
          sourceRecordId: this.rawAlias("record", record.sourceRecordId, "Slack reviewed record"),
          kind: record.kind,
          area: record.area,
          channel: record.channel == null ? null : this.rawAlias("channel", record.channel, "Slack channel"),
          conversationId: record.area === "channels"
            ? this.rawAlias("channel", record.conversationId, "Slack conversation")
            : this.rawAlias("record", record.conversationId, "Slack conversation"),
          category: this.rawAlias("category", record.category, "Slack category"),
          timestamp: record.timestamp,
          participantIds: rawParticipantIds,
          participantAccess: rawParticipantAccess,
          sensitiveCategories: this.rawCategories(record.sensitiveCategories),
          uncertainSensitivity: record.uncertainSensitivity === true,
          isGroup: record.isGroup === true,
          threadId: this.rawAlias("thread", record.threadId, "Slack thread"),
          threadRootId: this.rawAlias("thread", record.threadRootId, "Slack root thread")
        };
      })
      .sort((left, right) => left.sourceRecordId.localeCompare(right.sourceRecordId));
    return {
      reviewId: grant.reviewId,
      pagination: clone(this.lastPagination),
      records
    };
  }

  async assertReviewedRecordsStillMatch(grant, accountId) {
    const currentMetadata = await this.discoverMetadata({ source: SOURCE });
    if (currentMetadata.account.id !== accountId) {
      throw new SlackLifecycleError("SLACK_ACCOUNT_MISMATCH", "The current Slack metadata did not match the reviewed workspace, so no message content was read.");
    }
    if (!this.reviewedRecordsById) return currentMetadata;
    const currentById = new Map(Object.entries(reviewedSlackRecords(currentMetadata)));
    for (const reviewed of this.reviewedRecordsById.values()) {
      if (recordFitsSlackGrant(reviewed, grant, accountId) && !reviewedSlackRecordMatchesCurrent(reviewed, currentById.get(reviewed.sourceRecordId))) {
        throw new SlackLifecycleError("SLACK_REVIEWED_METADATA_CHANGED", "Slack metadata changed after the privacy review, so no message content was read. Start a new review before continuing.");
      }
    }
    return currentMetadata;
  }

  async rawBlockedGroupConversationIds(conversationIds) {
    await this.discoverMetadata({ source: SOURCE });
    if (!Array.isArray(conversationIds)) {
      throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_EXCEPTION_INVALID", "Slack could not safely identify the approved group exception, so it stayed excluded.");
    }
    return conversationIds.map((conversationId) => {
      const reviewed = this.reviewedRecordsById?.get(conversationId) ?? this.lastMetadata?.items.find((item) => item.id === conversationId);
      if (!reviewed?.isGroup || reviewed.area !== "group-messages") {
        throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_EXCEPTION_INVALID", "Slack could not safely identify the approved group exception, so it stayed excluded.");
      }
      return this.rawAlias("record", conversationId, "approved blocked Slack group");
    });
  }

  async registerPermissionGrant({ grant }) {
    this.assertGrant(grant);
    await this.discoverMetadata({ source: SOURCE });
    return this.plugin.registerPermissionGrant({ grant: this.rawGrant(grant) });
  }

  async revokePermissionGrant({ grantId }) {
    return this.plugin.revokePermissionGrant({ grantId });
  }

  async fetchApprovedContent({ source, accountId, grant }) {
    if (source !== SOURCE || !OPAQUE_ID.test(accountId)) {
      throw new SlackLifecycleError("SLACK_SOURCE_MISMATCH", "The source did not match the Slack review, so no message content was read.");
    }
    this.assertGrant(grant);
    if (grant.accountId !== accountId || !this.reviewedRecordsById) {
      throw new SlackLifecycleError("SLACK_REVIEWED_RECORDS_MISSING", "The saved Slack review no longer has a safe record inventory, so no message content was read. Start a new review.");
    }
    // Re-read only safe metadata before the approved fetch. The same reviewed
    // snapshot is then supplied to the adapter's fetch call so it can compare
    // source metadata atomically before reading any approved body. A separate
    // preflight check alone would leave a change-at-fetch TOCTOU gap.
    await this.assertReviewedRecordsStillMatch(grant, accountId);
    const result = await this.plugin.fetchApprovedContent({
      source,
      accountId,
      grant: this.rawGrant(grant),
      approvedMetadataSnapshot: this.rawApprovedMetadataSnapshot(grant, accountId)
    });
    if (result?.rawBodiesReturned === true || !Array.isArray(result?.records)) {
      throw new SlackLifecycleError("SLACK_BODY_BOUNDARY_INVALID", "The Slack plugin did not preserve the source-body boundary, so no message content was exposed.");
    }
    const seen = new Set();
    const records = result.records.map((record) => {
      const sourceRecordId = typeof record?.sourceRecordId === "string"
        ? this.aliases.alias("record", record.sourceRecordId, "Slack approved record")
        : null;
      if (!sourceRecordId || record?.source && record.source !== SOURCE) {
        throw new SlackLifecycleError("SLACK_RECORD_INVALID", "Slack returned an invalid approved reference, so no message content was exposed.");
      }
      if (seen.has(sourceRecordId)) {
        throw new SlackLifecycleError("SLACK_RECORD_DUPLICATE", "Slack returned a duplicate approved reference, so no message content was exposed.");
      }
      seen.add(sourceRecordId);
      const reviewed = this.reviewedRecordsById.get(sourceRecordId);
      if (!reviewed) {
        throw new SlackLifecycleError("SLACK_UNREVIEWED_RECORD", "Slack returned a record outside the metadata review, so no message content was exposed.");
      }
      if (!recordFitsSlackGrant(reviewed, grant, accountId)) {
        throw new SlackLifecycleError("SLACK_SCOPE_BYPASS", "Slack returned a record outside the final granted scope, so no message content was exposed.");
      }
      return { sourceRecordId, source: SOURCE };
    });
    return {
      rawBodiesReturned: false,
      records,
      contentBodiesRead: result.contentBodiesRead !== false
    };
  }

  async normalizeStableThreadReferences({ source, accountId, records }) {
    if (!Array.isArray(records)) {
      throw new SlackLifecycleError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack could not safely normalize the approved thread references, so none were exposed.");
    }
    const rawRecords = records.map((record) => ({
      sourceRecordId: this.rawAlias("record", record?.sourceRecordId, "Slack approved record"),
      source: SOURCE
    }));
    const rawReferences = await this.plugin.normalizeStableThreadReferences({ source, accountId, records: rawRecords });
    const references = (Array.isArray(rawReferences) ? rawReferences : []).map((reference) => {
      const sourceRecordId = this.aliases.alias("record", reference?.sourceRecordId, "Slack approved record");
      const reviewed = this.reviewedRecordsById?.get(sourceRecordId);
      const conversationNamespace = reviewed?.area === "channels" ? "channel" : "record";
      const conversationId = this.aliases.alias(conversationNamespace, reference?.threadContext?.conversationId, "Slack conversation");
      const threadId = this.aliases.alias("thread", reference?.threadContext?.threadId, "Slack thread");
      const parentThreadId = reference?.threadContext?.parentThreadId == null
        ? null
        : this.aliases.alias("thread", reference.threadContext.parentThreadId, "Slack parent thread");
      return {
        sourceRecordId,
        conversationType: reference?.conversationType,
        stableReference: `slack:${publicSlackAccountAlias(accountId)}:${conversationId}:${threadId}`,
        threadContext: { conversationId, threadId, parentThreadId }
      };
    });
    return safeStableReferences(references, records, accountId, this.reviewedRecordsById);
  }
}

const inMemorySlackOperationKeys = new WeakMap();

function canonicalStateStorePath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return typeof realpathSync.native === "function" ? realpathSync.native(resolved) : realpathSync(resolved);
  } catch {
    // The state file may not exist before the initial setup save. path.resolve
    // still collapses lexical aliases such as ../, and later calls upgrade to
    // the canonical real path once it exists.
    return resolved;
  }
}

function slackOperationKey(stateStore, accountId) {
  const safeAccountId = assertOpaqueId(accountId, "Slack workspace");
  if (typeof stateStore?.filePath === "string" && stateStore.filePath) {
    return `file:${canonicalStateStorePath(stateStore.filePath)}:${SOURCE}:${safeAccountId}`;
  }
  let accountKeys = inMemorySlackOperationKeys.get(stateStore);
  if (!accountKeys) {
    accountKeys = new Map();
    inMemorySlackOperationKeys.set(stateStore, accountKeys);
  }
  if (!accountKeys.has(safeAccountId)) accountKeys.set(safeAccountId, {});
  return accountKeys.get(safeAccountId);
}

function currentSlackRevocationGeneration(stateStore, accountId) {
  return slackRevocationGenerations.get(slackOperationKey(stateStore, accountId)) ?? 0;
}

function requestSlackRevocation(stateStore, accountId) {
  const key = slackOperationKey(stateStore, accountId);
  const next = (slackRevocationGenerations.get(key) ?? 0) + 1;
  slackRevocationGenerations.set(key, next);
  return next;
}

async function withSlackOperationLock(stateStore, accountId, operation) {
  // The Slack account gate preserves revoke generation semantics for one
  // account. It runs inside the shared full-Setup-Session gate because every
  // lifecycle writer saves the same root state document: a Gmail or another
  // Slack account must never be able to overwrite this account's revocation
  // with a stale root snapshot.
  return withSourcePermissionStateLock(stateStore, async () => {
    const key = slackOperationKey(stateStore, accountId);
    const previous = slackOperationTails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    slackOperationTails.set(key, previous.catch(() => undefined).then(() => gate));
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  });
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function safeMetadataSummary(plugin) {
  let summary;
  try {
    summary = await plugin.getSafeMetadataSummary();
  } catch {
    return {
      unavailable: true,
      pagination: { status: "incomplete", pagesReviewed: 0, pagesExpected: 0 },
      privateChannels: { status: "excluded-by-default", count: 0 }
    };
  }
  const paginationStatus = summary?.pagination?.status === "complete"
    ? "complete"
    : summary?.pagination?.status === "incomplete"
      ? "incomplete"
      : "not-started";
  return {
    unavailable: false,
    pagination: {
      status: paginationStatus,
      pagesReviewed: safeNonNegativeInteger(summary?.pagination?.pagesReviewed),
      pagesExpected: safeNonNegativeInteger(summary?.pagination?.pagesExpected)
    },
    privateChannels: {
      status: "excluded-by-default",
      count: safeNonNegativeInteger(summary?.privateChannels?.count)
    }
  };
}

function metadataPaginationComplete(summary, { requireReviewedPages = false, reviewedRecordCount = 0 } = {}) {
  const pagination = summary?.pagination;
  if (summary?.unavailable || pagination?.status !== "complete") return false;
  if (!requireReviewedPages) return true;
  if (!Number.isSafeInteger(reviewedRecordCount) || reviewedRecordCount < 0) return false;
  if (pagination.pagesExpected === 0) {
    // A provider cannot truthfully claim that it reviewed zero pages while
    // returning a non-empty inventory. Treat contradictory completion
    // summaries as incomplete before any content grant is offered.
    return pagination.pagesReviewed === 0 && reviewedRecordCount === 0;
  }
  return pagination.pagesReviewed > 0
    && pagination.pagesReviewed >= pagination.pagesExpected;
}

function publicPermissionReview(permissionReview) {
  if (!permissionReview) return null;
  const rawAccountId = permissionReview?.account?.id;
  const safe = redactPublicSlackAccountIdentifier(clone(permissionReview), rawAccountId);
  if (Array.isArray(safe?.metadataPreflight?.blockedGroupConversations)) {
    safe.metadataPreflight.blockedGroupConversations = safe.metadataPreflight.blockedGroupConversations
      .map((conversation) => ({ id: typeof conversation?.id === "string" && OPAQUE_ID.test(conversation.id) ? conversation.id : "unavailable" }));
  }
  // The simulation adapter gives the generic lifecycle only neutral account
  // labels, but remove one anyway so this wrapper cannot become a workspace
  // metadata dump if a future adapter changes its implementation.
  if (safe?.account) safe.account.label = "Selected Slack workspace";
  if (safe?.permissionRequest?.account) safe.permissionRequest.account.label = "Selected Slack workspace";
  return safe;
}

function currentBlockedGroupIds(permissionReview) {
  return new Set((permissionReview?.metadataPreflight?.blockedGroupConversations ?? [])
    .map((conversation) => conversation?.id)
    .filter((value) => typeof value === "string" && OPAQUE_ID.test(value)));
}

function reviewedExceptionSummaries(entry) {
  return Object.values(entry.blockedGroupReviews ?? {})
    .filter((review) => review && typeof review.conversationId === "string" && OPAQUE_ID.test(review.conversationId))
    .map((review) => ({
      conversationId: review.conversationId,
      reviewId: typeof review.id === "string" && OPAQUE_ID.test(review.id) ? review.id : "unavailable",
      status: review.status === "approved" || review.status === "awaiting-customer-confirmation" ? review.status : "unavailable"
    }))
    .sort((left, right) => left.conversationId.localeCompare(right.conversationId));
}

function publicView(entry, language, permissionReview = null) {
  const wording = copy(language);
  let message = wording.start;
  if (entry.status === "skipped") message = wording.skipped;
  else if (entry.status === "needs-attention") message = wording.needsAttention;
  else if (entry.status === "revoked") message = wording.revoked;
  else if (entry.phase === "awaiting-plugin-authorization") message = wording.awaitingAuthorization;
  else if (entry.phase === "metadata-preflight") message = wording.verified;
  else if (entry.phase === "awaiting-content-grant") message = wording.metadataReady;
  else if (entry.phase === "ready-to-process") message = wording.ready;
  else if (entry.phase === "processed-simulated") message = wording.processed;

  const safeReview = publicPermissionReview(permissionReview);
  const blockedGroups = safeReview?.metadataPreflight?.blockedGroupConversations ?? [];
  return {
    source: SOURCE,
    status: entry.status,
    phase: entry.phase,
    message,
    connection: {
      provider: "official-slack-plugin",
      simulationOnly: true,
      live: false,
      readOnly: entry.verification?.readOnly === true,
      verifiedReadOnly: entry.verification?.status === "verified",
      canPost: false,
      canReact: false,
      canEdit: false,
      canArchive: false,
      canInvite: false,
      canChangeWorkspaceState: false,
      message: wording.readOnly
    },
    metadata: {
      pagination: clone(entry.metadata?.pagination ?? { status: "not-started", pagesReviewed: 0, pagesExpected: 0 }),
      privateChannels: {
        ...clone(entry.metadata?.privateChannels ?? { status: "excluded-by-default", count: 0 }),
        message: wording.privateChannels
      }
    },
    privacy: {
      channelBoundary: "independently-enforceable",
      directMessageBoundary: "independently-enforceable",
      groupMessageBoundary: "independently-enforceable",
      peopleBoundary: "independently-enforceable",
      dateBoundary: "independently-enforceable",
      blockedGroupConversations: blockedGroups.map((conversation) => ({ id: conversation.id, status: "skipped-unless-separately-reviewed" })),
      blockedGroupMessage: wording.blockedGroups,
      blockedGroupReviews: reviewedExceptionSummaries(entry)
    },
    permissionReview: safeReview,
    audit: redactPublicSlackAccountIdentifier(clone(entry.audit), entry.accountId)
  };
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  requireSetup(state);
  return state;
}

function noWriteVerification(verification) {
  return verification?.status === "verified"
    && verification.readOnly === true
    && WRITE_CAPABILITIES.every((capability) => verification.operations?.[capability] === false);
}

function statusFromAuthorization(status) {
  if (status === "denied") return { status: "skipped", phase: "authorization-denied" };
  if (status === "revoked") return { status: "revoked", phase: "access-revoked" };
  return { status: "needs-attention", phase: "authorization-unavailable" };
}

async function permissionStatus(stateStore, accountId, language) {
  return getSpecializedSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
}

async function markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event }) {
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  const reviewId = entry.reviewId;
  let current = await permissionStatus(stateStore, accountId, languageFor(state, language));
  // A metadata-only generic review may have been created immediately before
  // the revoke request. Close it locally so Slack never presents a live
  // awaiting-grant request after its own lifecycle has become revoked.
  if (reviewId && current?.permissionReview?.status === "awaiting-grant") {
    try {
      await denySpecializedSourcePermission({
        message,
        stateStore,
        source: SOURCE,
        accountId,
        reviewId,
        language,
        clock
      });
    } catch {
      // The Slack state below remains fail-closed even if a concurrent cleanup
      // has already finalized the generic review.
    }
    state = await loadState(stateStore);
    entry = assertEntry(state, accountId);
    current = await permissionStatus(stateStore, accountId, languageFor(state, language));
  }
  entry.status = "revoked";
  entry.phase = "access-revoked";
  entry.pluginAuthorization = {
    ...entry.pluginAuthorization,
    status: "revoked",
    authorizedAt: null
  };
  entry.audit.push({
    type: "slack-authorization-revoked-before-completion",
    at: isoNow(clock),
    event,
    rawContentExposed: false
  });
  await stateStore.save(state);
  return { slack: publicView(entry, languageFor(state, language), current?.permissionReview) };
}

/** Begins the customer-visible, ordinary-language Slack choice in Setup Session. */
export async function beginSlackConnection({ message, stateStore, accountId = "slack-workspace", language, clock }) {
  assertNaturalLanguage(message);
  assertOpaqueId(accountId, "Slack workspace");
  return withSlackOperationLock(stateStore, accountId, () => beginSlackConnectionLocked({
    message, stateStore, accountId, language, clock
  }));
}

async function beginSlackConnectionLocked({ message, stateStore, accountId, language, clock }) {
  const revocationGenerationAtStart = currentSlackRevocationGeneration(stateStore, accountId);
  const state = await loadState(stateStore);
  const records = lifecycle(state);
  const key = entryKey(accountId);
  const existing = records.entries[key];
  if (!existing) {
    records.entries[key] = newEntry(accountId, isoNow(clock));
    records.audit.push({ type: "slack-official-plugin-offered", at: isoNow(clock), accountId });
    await stateStore.save(state);
  } else if (existing.status === "skipped" || existing.status === "revoked") {
    records.entries[key] = newEntry(accountId, isoNow(clock), existing.audit);
    records.audit.push({ type: "slack-official-plugin-restart-requested", at: isoNow(clock), accountId });
    await stateStore.save(state);
  }
  let entry = records.entries[key];
  let current = await permissionStatus(stateStore, accountId, languageFor(state, language));
  // A generic-deny/revoke call is exported for the shared QWA-139 engine. Do
  // not leave Slack's own state claiming an awaiting review after that final
  // decision; a new customer request starts a visibly fresh metadata review.
  if (current?.permissionReview?.status === "denied" || current?.permissionReview?.status === "revoked") {
    records.entries[key] = newEntry(accountId, isoNow(clock), entry.audit);
    records.audit.push({ type: "slack-permission-review-restart-requested", at: isoNow(clock), accountId });
    await stateStore.save(state);
    entry = records.entries[key];
    current = await permissionStatus(stateStore, accountId, languageFor(state, language));
  }
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({
      message,
      stateStore,
      accountId,
      language,
      clock,
      event: "begin"
    });
  }
  return { slack: publicView(entry, languageFor(state, language), current?.permissionReview) };
}

/**
 * Performs only the simulated official-plugin authorization and read-only
 * verification after explicit customer approval. It then starts QWA-139's
 * metadata-only review; it never asks the adapter to fetch message bodies.
 */
export async function authorizeSlackOfficialPlugin({
  message,
  stateStore,
  plugin,
  accountId = "slack-workspace",
  pluginAuthorizationApproved = false,
  language,
  clock,
  reviewIdFactory
}) {
  assertNaturalLanguage(message);
  assertOpaqueId(accountId, "Slack workspace");
  return withSlackOperationLock(stateStore, accountId, () => authorizeSlackOfficialPluginLocked({
    message,
    stateStore,
    plugin,
    accountId,
    pluginAuthorizationApproved,
    language,
    clock,
    reviewIdFactory
  }));
}

async function authorizeSlackOfficialPluginLocked({
  message,
  stateStore,
  plugin,
  accountId,
  pluginAuthorizationApproved,
  language,
  clock,
  reviewIdFactory
}) {
  const revocationGenerationAtStart = currentSlackRevocationGeneration(stateStore, accountId);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  const resolvedLanguage = languageFor(state, language);
  if (entry.phase === "local-grant-revocation-unconfirmed") {
    const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
    return { slack: publicView(entry, resolvedLanguage, current?.permissionReview) };
  }
  if (!["awaiting-plugin-authorization", "authorization-denied", "authorization-unavailable", "access-revoked"].includes(entry.phase)
    && entry.status !== "needs-attention") {
    const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
    return { slack: publicView(entry, resolvedLanguage, current?.permissionReview) };
  }
  if (pluginAuthorizationApproved !== true) {
    const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
    return { slack: publicView(entry, resolvedLanguage, current?.permissionReview) };
  }
  assertPlugin(plugin);

  const now = isoNow(clock);
  let authorization;
  try {
    authorization = await plugin.requestOfficialPluginAuthorization({
      source: SOURCE,
      accountId,
      purpose: "Prepare a metadata-only, read-only Slack permission review after explicit customer approval."
    });
  } catch (error) {
    authorization = { status: error?.code === "SLACK_AUTHORIZATION_REVOKED" ? "revoked" : "unavailable" };
  }
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "plugin-authorization" });
  }
  const authorizationStatus = ["authorized", "denied", "unavailable", "revoked"].includes(authorization?.status)
    ? authorization.status
    : "unavailable";
  entry.pluginAuthorization = {
    status: authorizationStatus,
    attempts: safeNonNegativeInteger(entry.pluginAuthorization?.attempts) + 1,
    authorizedAt: authorizationStatus === "authorized" ? now : null
  };
  if (authorizationStatus !== "authorized" || authorization.accountId !== accountId) {
    const next = authorization.accountId !== undefined && authorization.accountId !== accountId
      ? { status: "needs-attention", phase: "account-mismatch" }
      : statusFromAuthorization(authorizationStatus);
    entry.status = next.status;
    entry.phase = next.phase;
    entry.audit.push({ type: "slack-plugin-authorization-not-ready", at: now, result: next.phase });
    await stateStore.save(state);
    return { slack: publicView(entry, resolvedLanguage) };
  }

  let verification;
  try {
    verification = await plugin.verifyReadOnlyConnection({ source: SOURCE, accountId });
  } catch (error) {
    verification = { status: error?.code === "SLACK_AUTHORIZATION_REVOKED" ? "revoked" : "unavailable", readOnly: false };
  }
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "read-only-verification" });
  }
  if (!noWriteVerification(verification)) {
    const next = statusFromAuthorization(verification?.status);
    entry.status = next.status === "skipped" ? "needs-attention" : next.status;
    entry.phase = verification?.status === "revoked" ? "access-revoked" : "read-only-verification-failed";
    entry.verification = { status: verification?.status ?? "unavailable", verifiedAt: null, readOnly: false };
    entry.audit.push({ type: "slack-read-only-verification-failed", at: now, status: entry.verification.status });
    await stateStore.save(state);
    return { slack: publicView(entry, resolvedLanguage) };
  }

  entry.status = "selected-but-unfinished";
  entry.phase = "metadata-preflight";
  entry.verification = { status: "verified", verifiedAt: now, readOnly: true };
  const initialMetadata = await safeMetadataSummary(plugin);
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "metadata-summary" });
  }
  entry.metadata = initialMetadata;
  if (!metadataPaginationComplete(initialMetadata)) {
    entry.status = "needs-attention";
    entry.phase = initialMetadata.unavailable ? "metadata-summary-unavailable" : "metadata-pagination-incomplete";
    entry.audit.push({
      type: initialMetadata.unavailable ? "slack-metadata-summary-unavailable" : "slack-metadata-pagination-incomplete",
      at: now,
      contentBodiesRead: false
    });
    await stateStore.save(state);
    return { slack: publicView(entry, resolvedLanguage), metadataReviewUnavailable: true };
  }
  entry.audit.push({ type: "slack-read-only-verified", at: now, contentBodiesRead: false });
  await stateStore.save(state);
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "metadata-review-start" });
  }

  let review;
  let bounded;
  try {
    bounded = new SlackBoundedConnector(plugin);
    review = await beginSpecializedSourcePermissionReview({
      message: resolvedLanguage === "es" ? "Quiero revisar Slack para mi segundo cerebro" : "I want to review Slack for my second brain",
      stateStore,
      connector: bounded,
      source: SOURCE,
      language: resolvedLanguage,
      clock,
      reviewIdFactory
    });
    if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
      return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "metadata-review" });
    }
    if (review.permissionReview.account.id !== accountId) {
      throw new SlackLifecycleError("SLACK_ACCOUNT_MISMATCH", "The reviewed Slack workspace did not match the saved setup.");
    }
  } catch (error) {
    if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
      return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "metadata-review-failure" });
    }
    const failedState = await loadState(stateStore);
    const failedEntry = assertEntry(failedState, accountId);
    failedEntry.status = error?.code === "SLACK_AUTHORIZATION_REVOKED" ? "revoked" : "needs-attention";
    failedEntry.phase = error?.code === "SLACK_AUTHORIZATION_REVOKED"
      ? "access-revoked"
      : error?.code === "SLACK_PAGINATION_INCOMPLETE"
        ? "metadata-pagination-incomplete"
        : "metadata-review-unavailable";
    failedEntry.metadata = await safeMetadataSummary(plugin);
    failedEntry.audit.push({
      type: "slack-metadata-review-unavailable",
      at: isoNow(clock),
      reason: error?.code === "SLACK_PAGINATION_INCOMPLETE" ? "pagination-incomplete" : error?.code === "SLACK_AUTHORIZATION_REVOKED" ? "access-revoked" : "metadata-review-failed",
      contentBodiesRead: false
    });
    await stateStore.save(failedState);
    return { slack: publicView(failedEntry, languageFor(failedState, language)), metadataReviewUnavailable: true };
  }

  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "selected-but-unfinished";
  refreshedEntry.phase = "awaiting-content-grant";
  refreshedEntry.reviewId = review.permissionReview.permissionRequest.reviewId;
  refreshedEntry.reviewedRecordsById = reviewedSlackRecords(bounded.lastMetadata);
  const completedMetadata = await safeMetadataSummary(plugin);
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "metadata-completion" });
  }
  refreshedEntry.metadata = completedMetadata;
  if (!metadataPaginationComplete(completedMetadata, {
    requireReviewedPages: true,
    reviewedRecordCount: Object.keys(refreshedEntry.reviewedRecordsById).length
  })) {
    refreshedEntry.status = "needs-attention";
    refreshedEntry.phase = completedMetadata.unavailable ? "metadata-summary-unavailable" : "metadata-pagination-incomplete";
    refreshedEntry.audit.push({
      type: completedMetadata.unavailable ? "slack-metadata-summary-unavailable" : "slack-metadata-pagination-incomplete",
      at: isoNow(clock),
      contentBodiesRead: false
    });
    await stateStore.save(refreshed);
    return { slack: publicView(refreshedEntry, languageFor(refreshed, language), review.permissionReview), metadataReviewUnavailable: true };
  }
  refreshedEntry.audit.push({ type: "slack-metadata-only-reviewed", at: isoNow(clock), reviewId: refreshedEntry.reviewId, contentBodiesRead: false });
  await stateStore.save(refreshed);
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "metadata-review-save" });
  }
  return { slack: publicView(refreshedEntry, languageFor(refreshed, language), review.permissionReview) };
}

/** Starts the mandatory, one-conversation blocked-group exception review. */
export async function requestSlackBlockedGroupException({
  message,
  stateStore,
  accountId = "slack-workspace",
  reviewId,
  conversationId,
  language,
  clock,
  blockedGroupReviewIdFactory
}) {
  assertNaturalLanguage(message);
  assertOpaqueId(accountId, "Slack workspace");
  assertOpaqueId(conversationId, "blocked Slack group");
  return withSlackOperationLock(stateStore, accountId, () => requestSlackBlockedGroupExceptionLocked({
    message,
    stateStore,
    accountId,
    reviewId,
    conversationId,
    language,
    clock,
    blockedGroupReviewIdFactory
  }));
}

async function requestSlackBlockedGroupExceptionLocked({
  message,
  stateStore,
  accountId,
  reviewId,
  conversationId,
  language,
  clock,
  blockedGroupReviewIdFactory
}) {
  const revocationGenerationAtStart = currentSlackRevocationGeneration(stateStore, accountId);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  const resolvedLanguage = languageFor(state, language);
  const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
  if (entry.phase !== "awaiting-content-grant" || entry.reviewId !== reviewId || current?.permissionReview?.permissionRequest?.reviewId !== reviewId) {
    throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_REVIEW_NOT_READY", "Finish the saved metadata review before separately reviewing one blocked Slack group.");
  }
  if (!currentBlockedGroupIds(current.permissionReview).has(conversationId)) {
    throw new SlackLifecycleError("SLACK_GROUP_NOT_BLOCKED_OR_REVIEWED", "That group was not one of the blocked group conversations in this metadata review, so I kept it excluded.");
  }
  const reviewedRecord = entry.reviewedRecordsById?.[conversationId];
  const blockedParticipantIds = (reviewedRecord?.participantIds ?? [])
    .filter((personId) => reviewedRecord?.participantAccess?.[personId] === "blocked")
    .sort();
  if (!reviewedRecord?.isGroup || blockedParticipantIds.length === 0) {
    throw new SlackLifecycleError("SLACK_GROUP_REVIEW_SNAPSHOT_MISSING", "Slack no longer has the reviewed blocked-group snapshot, so the group stays excluded. Start a new review.");
  }
  const existing = entry.blockedGroupReviews?.[conversationId];
  if (!existing) {
    const blockedGroupReviewId = assertOpaqueId(
      (blockedGroupReviewIdFactory ?? (() => `slack-blocked-group-${randomUUID()}`))(),
      "blocked Slack group review"
    );
    entry.blockedGroupReviews[conversationId] = {
      id: blockedGroupReviewId,
      conversationId,
      // Approval is for this exact reviewed group snapshot, not a movable
      // group id whose blocked membership can drift after review.
      blockedParticipantIds,
      contentReviewId: reviewId,
      status: "awaiting-customer-confirmation",
      createdAt: isoNow(clock)
    };
    entry.audit.push({ type: "slack-blocked-group-exception-requested", at: isoNow(clock), reviewId, conversationId });
    if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
      return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "blocked-group-review-request" });
    }
    await stateStore.save(state);
  }
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "blocked-group-review-request" });
  }
  return {
    slack: publicView(entry, resolvedLanguage, current.permissionReview),
    message: copy(resolvedLanguage).groupReview
  };
}

/** Persists one explicit blocked-group exception; it never broadens another group or person. */
export async function approveSlackBlockedGroupException({
  message,
  stateStore,
  accountId = "slack-workspace",
  reviewId,
  conversationId,
  blockedGroupReviewId,
  explicitlyApproved = false,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  assertOpaqueId(accountId, "Slack workspace");
  assertOpaqueId(conversationId, "blocked Slack group");
  assertOpaqueId(blockedGroupReviewId, "blocked Slack group review");
  return withSlackOperationLock(stateStore, accountId, () => approveSlackBlockedGroupExceptionLocked({
    message,
    stateStore,
    accountId,
    reviewId,
    conversationId,
    blockedGroupReviewId,
    explicitlyApproved,
    language,
    clock
  }));
}

async function approveSlackBlockedGroupExceptionLocked({
  message,
  stateStore,
  accountId,
  reviewId,
  conversationId,
  blockedGroupReviewId,
  explicitlyApproved,
  language,
  clock
}) {
  const revocationGenerationAtStart = currentSlackRevocationGeneration(stateStore, accountId);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  const resolvedLanguage = languageFor(state, language);
  const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
  const groupReview = entry.blockedGroupReviews?.[conversationId];
  if (!groupReview || groupReview.id !== blockedGroupReviewId || groupReview.contentReviewId !== reviewId || entry.reviewId !== reviewId) {
    throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_REVIEW_NOT_FOUND", "I could not find that separate blocked-group review, so the group remains excluded.");
  }
  if (explicitlyApproved !== true) {
    return { slack: publicView(entry, resolvedLanguage, current?.permissionReview), message: copy(resolvedLanguage).groupReview };
  }
  groupReview.status = "approved";
  groupReview.approvedAt = isoNow(clock);
  entry.audit.push({ type: "slack-blocked-group-exception-approved", at: isoNow(clock), reviewId, conversationId, blockedGroupReviewId });
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "blocked-group-review-approval" });
  }
  await stateStore.save(state);
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "blocked-group-review-approval" });
  }
  return { slack: publicView(entry, resolvedLanguage, current?.permissionReview), message: copy(resolvedLanguage).groupApproved };
}

/** Cancels a pending Slack content review through the specialized lifecycle. */
export async function denySlackContentReview({ message, stateStore, accountId = "slack-workspace", reviewId, language, clock }) {
  assertNaturalLanguage(message);
  assertOpaqueId(accountId, "Slack workspace");
  return withSlackOperationLock(stateStore, accountId, () => denySlackContentReviewLocked({
    message, stateStore, accountId, reviewId, language, clock
  }));
}

async function denySlackContentReviewLocked({ message, stateStore, accountId, reviewId, language, clock }) {
  const revocationGenerationAtStart = currentSlackRevocationGeneration(stateStore, accountId);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  const resolvedLanguage = languageFor(state, language);
  const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
  if (entry.status !== "selected-but-unfinished" || entry.phase !== "awaiting-content-grant"
    || entry.reviewId !== reviewId || current?.permissionReview?.permissionRequest?.reviewId !== reviewId) {
    throw new SlackLifecycleError("SLACK_REVIEW_NOT_READY", "Continue the saved Slack metadata review before cancelling its content permission.");
  }
  const denied = await denySpecializedSourcePermission({
    message,
    stateStore,
    source: SOURCE,
    accountId,
    reviewId,
    language,
    clock
  });
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markAuthorizationRevokedBeforeCompletion({ message, stateStore, accountId, language, clock, event: "content-review-denial" });
  }
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "skipped";
  refreshedEntry.phase = "content-denied";
  refreshedEntry.audit.push({ type: "slack-content-review-denied", at: isoNow(clock), reviewId, contentBodiesRead: false });
  await stateStore.save(refreshed);
  return { slack: publicView(refreshedEntry, languageFor(refreshed, language), denied.permissionReview) };
}

function assertApprovedBlockedGroupExceptions(scope, entry, reviewId) {
  const requested = Array.isArray(scope?.blockedGroupConversationExceptions)
    ? scope.blockedGroupConversationExceptions
    : [];
  for (const conversationId of requested) {
    if (typeof conversationId !== "string" || !OPAQUE_ID.test(conversationId)) {
      throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_EXCEPTION_INVALID", "I could not safely identify a requested blocked group exception, so I kept it excluded.");
    }
    const reviewed = entry.blockedGroupReviews?.[conversationId];
    const reviewedRecord = entry.reviewedRecordsById?.[conversationId];
    const currentBlockedParticipantIds = (reviewedRecord?.participantIds ?? [])
      .filter((personId) => reviewedRecord?.participantAccess?.[personId] === "blocked")
      .sort();
    if (!reviewed
      || reviewed.status !== "approved"
      || reviewed.contentReviewId !== reviewId
      || !sameStringArray(reviewed.blockedParticipantIds, currentBlockedParticipantIds)
      || currentBlockedParticipantIds.length === 0) {
      throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_SEPARATE_REVIEW_REQUIRED", "A group with a blocked person stays excluded until you complete a separate, explicit review for that one group.");
    }
  }
}

function approvedBlockedGroupConversationIds(entry, reviewId) {
  return Object.values(entry.blockedGroupReviews ?? {})
    .filter((review) => review?.status === "approved" && review.contentReviewId === reviewId)
    .map((review) => review.conversationId)
    .filter((conversationId) => typeof conversationId === "string" && OPAQUE_ID.test(conversationId))
    .sort();
}

/** Grants only the QWA-139-reviewed Slack scope after Slack's extra group guard. */
export async function grantSlackContent({
  message,
  stateStore,
  plugin,
  accountId = "slack-workspace",
  reviewId,
  scope,
  language,
  clock,
  grantIdFactory
}) {
  assertNaturalLanguage(message);
  assertPlugin(plugin);
  assertOpaqueId(accountId, "Slack workspace");
  return withSlackOperationLock(stateStore, accountId, () => grantSlackContentLocked({
    message, stateStore, plugin, accountId, reviewId, scope, language, clock, grantIdFactory
  }));
}

async function grantSlackContentLocked({
  message,
  stateStore,
  plugin,
  accountId,
  reviewId,
  scope,
  language,
  clock,
  grantIdFactory
}) {
  const revocationGenerationAtStart = currentSlackRevocationGeneration(stateStore, accountId);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status !== "selected-but-unfinished" || entry.phase !== "awaiting-content-grant" || entry.reviewId !== reviewId) {
    throw new SlackLifecycleError("SLACK_REVIEW_NOT_READY", "Continue the saved Slack metadata review before approving any message content.");
  }
  assertApprovedBlockedGroupExceptions(scope, entry, reviewId);
  const internalScope = internalizePublicSlackScope(scope, accountId);
  const granted = await grantSpecializedSourcePermission({
    message,
    stateStore,
    connector: new SlackBoundedConnector(plugin, { reviewedRecordsById: entry.reviewedRecordsById }),
    source: SOURCE,
    accountId,
    reviewId,
    scope: internalScope,
    language,
    clock,
    grantIdFactory
  });
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markGrantRevokedBeforeCompletion({
      message, stateStore, plugin, accountId, reviewId, language, clock, event: "grant-registration"
    });
  }
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "selected-but-unfinished";
  refreshedEntry.phase = "ready-to-process";
  refreshedEntry.audit.push({ type: "slack-content-granted", at: isoNow(clock), reviewId, grantId: granted.permissionReview.activeGrant?.grantId ?? null });
  await stateStore.save(refreshed);
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markGrantRevokedBeforeCompletion({
      message, stateStore, plugin, accountId, reviewId, language, clock, event: "grant-final-save"
    });
  }
  return { slack: publicView(refreshedEntry, languageFor(refreshed, language), granted.permissionReview) };
}

function safeStableReferences(references, approvedRecords, accountId, reviewedRecordsById) {
  if (!Array.isArray(references) || references.length !== approvedRecords.length) {
    throw new SlackLifecycleError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack could not safely normalize the approved thread references, so none were exposed.");
  }
  if (!(reviewedRecordsById instanceof Map)) {
    throw new SlackLifecycleError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack no longer has the reviewed record inventory, so none were exposed.");
  }
  const approvedIds = approvedRecords.map((record) => record.sourceRecordId);
  const approvedThreadIds = new Set(approvedIds
    .map((sourceRecordId) => reviewedRecordsById.get(sourceRecordId)?.threadId)
    .filter((threadId) => typeof threadId === "string" && OPAQUE_ID.test(threadId)));
  const seen = new Set();
  return references.map((reference) => {
    const sourceRecordId = typeof reference?.sourceRecordId === "string" && OPAQUE_ID.test(reference.sourceRecordId)
      ? reference.sourceRecordId
      : null;
    const conversationId = typeof reference?.threadContext?.conversationId === "string" && OPAQUE_ID.test(reference.threadContext.conversationId)
      ? reference.threadContext.conversationId
      : null;
    const threadId = typeof reference?.threadContext?.threadId === "string" && OPAQUE_ID.test(reference.threadContext.threadId)
      ? reference.threadContext.threadId
      : null;
    const parentThreadId = reference?.threadContext?.parentThreadId == null
      ? null
      : typeof reference.threadContext.parentThreadId === "string" && OPAQUE_ID.test(reference.threadContext.parentThreadId)
        ? reference.threadContext.parentThreadId
        : undefined;
    const type = ["channel-thread", "direct-message", "group-message"].includes(reference?.conversationType)
      ? reference.conversationType
      : null;
    if (!sourceRecordId || !conversationId || !threadId || parentThreadId === undefined || !type || !approvedIds.includes(sourceRecordId) || seen.has(sourceRecordId)) {
      throw new SlackLifecycleError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack could not safely normalize the approved thread references, so none were exposed.");
    }
    const reviewed = reviewedRecordsById.get(sourceRecordId);
    const expectedType = reviewed ? SLACK_CONVERSATION_TYPES[reviewed.area] : null;
    const expectedParentThreadId = reviewed?.threadRootId === reviewed?.threadId
      ? null
      : approvedThreadIds.has(reviewed?.threadRootId)
        ? reviewed.threadRootId
        : null;
    if (!reviewed
      || type !== expectedType
      || conversationId !== reviewed.conversationId
      || threadId !== reviewed.threadId
      || parentThreadId !== expectedParentThreadId) {
      throw new SlackLifecycleError("SLACK_REFERENCE_SCOPE_BYPASS", "Slack returned a thread reference outside the reviewed scope, so none were exposed.");
    }
    const stableReference = `slack:${publicSlackAccountAlias(accountId)}:${conversationId}:${threadId}`;
    if (reference.stableReference !== stableReference) {
      throw new SlackLifecycleError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack returned an unsafe thread reference, so none were exposed.");
    }
    seen.add(sourceRecordId);
    return {
      source: SOURCE,
      sourceRecordId,
      processingDisposition: "untrusted-inert-reference",
      conversationType: type,
      stableReference,
      threadContext: { conversationId, threadId, parentThreadId }
    };
  });
}

const LOCAL_SLACK_GRANT_REVOCATION_CONNECTOR = Object.freeze({
  async revokePermissionGrant() {
    // This invalidates only the saved QWA-139 grant. It intentionally makes
    // no Slack request and never represents a Slack-side revocation claim.
  }
});

async function deactivateLocalGrant({ message, stateStore, plugin, accountId, reviewId, language, clock }) {
  try {
    await revokeSpecializedSourcePermission({ message, stateStore, connector: plugin, source: SOURCE, accountId, reviewId, language, clock });
    return true;
  } catch {
    // A Slack-side revoke failure cannot leave an active QWA-139 grant behind.
    // This fallback invalidates only saved local permission state; it does not
    // claim to revoke or mutate anything in Slack.
    try {
      await revokeSpecializedSourcePermission({
        message,
        stateStore,
        connector: LOCAL_SLACK_GRANT_REVOCATION_CONNECTOR,
        source: SOURCE,
        accountId,
        reviewId,
        language,
        clock
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function markGrantRevokedBeforeCompletion({
  message,
  stateStore,
  plugin,
  accountId,
  reviewId,
  language,
  clock,
  event
}) {
  const locallyDeactivated = await deactivateLocalGrant({
    message, stateStore, plugin, accountId, reviewId, language, clock
  });
  const changed = await loadState(stateStore);
  const changedEntry = assertEntry(changed, accountId);
  const current = await permissionStatus(stateStore, accountId, languageFor(changed, language));
  const safelyRevoked = locallyDeactivated || !current?.permissionReview?.activeGrant;
  changedEntry.status = safelyRevoked ? "revoked" : "needs-attention";
  changedEntry.phase = safelyRevoked ? "access-revoked" : "local-grant-revocation-unconfirmed";
  if (safelyRevoked) changedEntry.pluginAuthorization.status = "revoked";
  changedEntry.audit.push({
    type: "slack-grant-revoked-before-completion",
    at: isoNow(clock),
    event,
    reviewId,
    localGrantInvalidated: safelyRevoked,
    rawContentExposed: false
  });
  await stateStore.save(changed);
  return { slack: publicView(changedEntry, languageFor(changed, language), current?.permissionReview) };
}

async function markFetchUnavailable({ message, stateStore, plugin, accountId, reviewId, language, clock, error }) {
  let revoked = error?.code === "SLACK_AUTHORIZATION_REVOKED" || error?.code === "SLACK_REVOKE_REQUESTED";
  // The shared persistence layer deliberately wraps adapter failures while it
  // restores a grant. Re-check the read-only authorization seam so an actual
  // Slack revocation remains truthful rather than being mislabeled as a
  // generic fetch problem.
  if (!revoked) {
    try {
      const verification = await plugin.verifyReadOnlyConnection({ source: SOURCE, accountId });
      revoked = verification?.status === "revoked";
    } catch (verificationError) {
      revoked = verificationError?.code === "SLACK_AUTHORIZATION_REVOKED";
    }
  }
  const locallyDeactivated = await deactivateLocalGrant({ message, stateStore, plugin, accountId, reviewId, language, clock });
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  entry.status = revoked && locallyDeactivated ? "revoked" : "needs-attention";
  entry.phase = revoked && locallyDeactivated
    ? "access-revoked"
    : locallyDeactivated
      ? "approved-fetch-unavailable"
      : "local-grant-revocation-unconfirmed";
  if (revoked && locallyDeactivated) entry.pluginAuthorization.status = "revoked";
  entry.audit.push({
    type: revoked && locallyDeactivated ? "slack-access-revoked-during-fetch" : "slack-approved-fetch-unavailable",
    at: isoNow(clock),
    reviewId,
    reason: revoked && locallyDeactivated
      ? "access-revoked"
      : locallyDeactivated
        ? "safe-reference-or-plugin-failure"
        : "local-grant-revocation-unconfirmed",
    rawContentExposed: false
  });
  await stateStore.save(state);
  const current = await permissionStatus(stateStore, accountId, languageFor(state, language));
  return {
    slack: publicView(entry, languageFor(state, language), current?.permissionReview),
    approvedThreads: [],
    importUnavailable: true
  };
}

/**
 * Fetches the active, permission-bounded Slack records and exposes only
 * validated stable references and thread-parent ids. Source text and labels
 * never leave the injected plugin seam.
 */
export async function fetchApprovedSlackContent({
  message,
  stateStore,
  plugin,
  accountId = "slack-workspace",
  reviewId,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  assertPlugin(plugin);
  assertOpaqueId(accountId, "Slack workspace");
  return withSlackOperationLock(stateStore, accountId, () => fetchApprovedSlackContentLocked({
    message, stateStore, plugin, accountId, reviewId, language, clock
  }));
}

async function fetchApprovedSlackContentLocked({
  message,
  stateStore,
  plugin,
  accountId,
  reviewId,
  language,
  clock
}) {
  const revocationGenerationAtStart = currentSlackRevocationGeneration(stateStore, accountId);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status !== "selected-but-unfinished" || entry.phase !== "ready-to-process" || entry.reviewId !== reviewId) {
    throw new SlackLifecycleError("SLACK_GRANT_REQUIRED", "No Slack content was processed because the saved granular review is not ready.");
  }
  let fetched;
  let references;
  const bounded = new SlackBoundedConnector(plugin, { reviewedRecordsById: entry.reviewedRecordsById });
  try {
    const rawApprovedBlockedGroupConversationIds = await bounded.rawBlockedGroupConversationIds(
      approvedBlockedGroupConversationIds(entry, reviewId)
    );
    await plugin.setSlackContentPolicy({
      reviewId,
      approvedBlockedGroupConversationIds: rawApprovedBlockedGroupConversationIds
    });
    fetched = await fetchApprovedSpecializedSourceContent({
      message,
      stateStore,
      connector: bounded,
      source: SOURCE,
      accountId,
      reviewId,
      language,
      clock
    });
    references = await bounded.normalizeStableThreadReferences({
      source: SOURCE,
      accountId,
      records: fetched.approvedRecords
    });
    if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
      throw new SlackLifecycleError("SLACK_REVOKE_REQUESTED", "Slack was revoked while the approved fetch was finishing, so none of its references were exposed.");
    }
  } catch (error) {
    return markFetchUnavailable({ message, stateStore, plugin, accountId, reviewId, language, clock, error });
  }
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "selected-but-unfinished";
  refreshedEntry.phase = "processed-simulated";
  refreshedEntry.audit.push({ type: "slack-approved-threads-processed", at: isoNow(clock), reviewId, recordCount: references.length, rawContentExposed: false });
  await stateStore.save(refreshed);
  if (currentSlackRevocationGeneration(stateStore, accountId) !== revocationGenerationAtStart) {
    return markFetchUnavailable({
      message,
      stateStore,
      plugin,
      accountId,
      reviewId,
      language,
      clock,
      error: new SlackLifecycleError("SLACK_REVOKE_REQUESTED", "Slack was revoked while the approved fetch was finishing, so none of its references were exposed.")
    });
  }
  return {
    slack: publicView(refreshedEntry, languageFor(refreshed, language), fetched.permissionReview),
    approvedThreads: references
  };
}

/** Revokes the local read-only grant and clearly marks the simulated source revoked. */
export async function revokeSlackContent({ message, stateStore, plugin, accountId = "slack-workspace", reviewId, language, clock }) {
  assertNaturalLanguage(message);
  assertPlugin(plugin);
  assertOpaqueId(accountId, "Slack workspace");
  requestSlackRevocation(stateStore, accountId);
  return withSlackOperationLock(stateStore, accountId, () => revokeSlackContentLocked({
    message, stateStore, plugin, accountId, reviewId, language, clock
  }));
}

async function revokeSlackContentLocked({ message, stateStore, plugin, accountId, reviewId, language, clock }) {
  const current = await permissionStatus(stateStore, accountId, language);
  if (!current?.permissionReview?.activeGrant) {
    const state = await loadState(stateStore);
    const entry = assertEntry(state, accountId);
    entry.status = "revoked";
    entry.phase = "access-revoked";
    entry.pluginAuthorization.status = "revoked";
    entry.audit.push({ type: "slack-local-grant-already-revoked", at: isoNow(clock), reviewId });
    await stateStore.save(state);
    return { slack: publicView(entry, languageFor(state, language), current?.permissionReview) };
  }
  const locallyDeactivated = await deactivateLocalGrant({
    message, stateStore, plugin, accountId, reviewId, language, clock
  });
  const currentAfterRevoke = await permissionStatus(stateStore, accountId, language);
  const safelyRevoked = locallyDeactivated || !currentAfterRevoke?.permissionReview?.activeGrant;
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  entry.status = safelyRevoked ? "revoked" : "needs-attention";
  entry.phase = safelyRevoked ? "access-revoked" : "local-grant-revocation-unconfirmed";
  if (safelyRevoked) entry.pluginAuthorization.status = "revoked";
  entry.audit.push({
    type: safelyRevoked ? "slack-local-grant-revoked" : "slack-local-grant-revocation-unconfirmed",
    at: isoNow(clock),
    reviewId,
    localGrantInvalidated: safelyRevoked
  });
  await stateStore.save(state);
  return { slack: publicView(entry, languageFor(state, language), currentAfterRevoke?.permissionReview) };
}

/** Reads only saved lifecycle state; it never invokes the plugin or Slack. */
export async function getSlackConnectionStatus({ stateStore, accountId = "slack-workspace", language }) {
  assertOpaqueId(accountId, "Slack workspace");
  return withSourcePermissionStateReadLock(stateStore, () => getSlackConnectionStatusLocked({
    stateStore, accountId, language
  }));
}

async function getSlackConnectionStatusLocked({ stateStore, accountId, language }) {
  const state = await loadState(stateStore);
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry) return null;
  const current = getSpecializedSourcePermissionStatusFromState({
    state,
    source: SOURCE,
    accountId,
    language: languageFor(state, language)
  });
  return { slack: publicView(entry, languageFor(state, language), current?.permissionReview) };
}
