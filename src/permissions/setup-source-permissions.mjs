/**
 * QWA-139 simulated, deny-by-default source permission lifecycle.
 *
 * This module is deliberately an additive public Setup Session extension. It
 * uses the same durable stateStore as QWA-138 but does not change the completed
 * bootstrap/vault state machine. Real OAuth, source accounts, source bodies,
 * and source writes are out of scope: callers inject a read-only simulated
 * connector contract.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export const PERMISSION_SOURCE_KINDS = Object.freeze({
  gmail: "communication",
  slack: "communication",
  imessage: "communication",
  whatsapp: "communication",
  calendar: "calendar",
  "google-calendar": "calendar",
  drive: "drive",
  "google-drive": "drive"
});

export const DEFAULT_PERMISSION_WINDOWS = Object.freeze({
  communication: Object.freeze({
    kind: "rolling",
    pastDays: 90,
    futureDays: 0,
    label: "Previous 90 days"
  }),
  calendar: Object.freeze({
    kind: "calendar-window",
    pastMonths: 6,
    futureDays: 90,
    label: "Previous 6 months and upcoming 90 days"
  }),
  drive: Object.freeze({
    kind: "selected-folders-only",
    label: "Selected folders only",
    dateRangeAllowed: false
  })
});

export const SENSITIVE_CATEGORIES = Object.freeze([
  "credentials",
  "security-codes",
  "financial-identifiers",
  "identity-documents",
  "medical-information",
  "legal-matters",
  "hr-payroll",
  "intimate-communications",
  "minors",
  "private-restricted-labels",
  "uncertain-sensitivity"
]);

const STATE_KEY = "sourcePermissionLifecycle";
const REVIEW_STATUSES = new Set(["awaiting-grant", "denied", "granted", "revoked"]);
const ACCESS_LEVELS = new Set(["allowed", "restricted", "blocked"]);
const METADATA_DIGEST = /^[a-f0-9]{64}$/;
const WHATSAPP_ACCOUNT_REFERENCE = /^wa-account-[a-z0-9._:-]{1,128}$/;
const WHATSAPP_PERSON_REFERENCE = /^wa-person-[a-f0-9]{20}$/;
const WHATSAPP_CHAT_REFERENCE = /^wa-chat-[a-f0-9]{20}$/;
const WHATSAPP_PERSON_LABEL = /^WhatsApp person [1-9]\d{0,3}$/;
const WHATSAPP_CHAT_LABEL = /^(?:Direct|Group) WhatsApp chat [1-9]\d{0,3}$/;
const WHATSAPP_ACCOUNT_LABEL = "Personal WhatsApp snapshot";
// Every lifecycle writer persists the same Setup Session root object. A
// source/account-scoped lock cannot protect that shared document: an unrelated
// source could otherwise save an older root and resurrect a revoked grant.
// FileStateStore instances can also be reconstructed with equivalent lexical
// paths, so derive one in-process lock identity from the canonical backing
// file. Public writers are deliberately not re-entrant: a connector or
// state-store callback must never mutate the root and then let an outer stale
// snapshot overwrite that mutation. Trusted connector lifecycles use the
// explicit lock-held primitives below instead of re-entering a public writer.
const stateStoreOperationTails = new Map();
const inMemoryStateStoreOperationKeys = new WeakMap();
const stateStoreLockContext = new AsyncLocalStorage();

export class PermissionLifecycleError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "PermissionLifecycleError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
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

function canonicalStateStorePath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return typeof realpathSync.native === "function" ? realpathSync.native(resolved) : realpathSync(resolved);
  } catch {
    // The file itself is absent before bootstrap. Canonicalizing an existing
    // parent still handles symlinked state directories; path.resolve handles
    // lexical aliases such as ../ until that parent exists.
    const parent = path.dirname(resolved);
    try {
      const canonicalParent = typeof realpathSync.native === "function"
        ? realpathSync.native(parent)
        : realpathSync(parent);
      return path.join(canonicalParent, path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function stateStoreOperationKey(stateStore) {
  if (typeof stateStore?.filePath === "string" && stateStore.filePath) {
    return `file:${canonicalStateStorePath(stateStore.filePath)}`;
  }
  let key = inMemoryStateStoreOperationKeys.get(stateStore);
  if (!key) {
    key = {};
    inMemoryStateStoreOperationKeys.set(stateStore, key);
  }
  return key;
}

/**
 * Serializes full read-modify-write lifecycle operations for one persisted
 * Setup Session, including distinct FileStateStore instances for the same
 * file. This is intentionally wider than a source or account: stateStore.save
 * writes the entire root document, so any concurrent lifecycle writer could
 * otherwise restore stale entries for a different source.
 */
async function withSourcePermissionStateLockMode(stateStore, operation, mode) {
  assertStateStore(stateStore);
  if (typeof operation !== "function") throw new TypeError("A state-store operation function is required.");
  const key = stateStoreOperationKey(stateStore);
  const inherited = stateStoreLockContext.getStore();
  const inheritedMode = inherited?.modes?.get(key);
  if (inheritedMode) {
    if (mode === "read") return operation();
    if (inheritedMode === "read") {
      const upgradedModes = new Map(inherited.modes);
      upgradedModes.set(key, "write");
      return stateStoreLockContext.run({ modes: upgradedModes }, operation);
    }
    throw new PermissionLifecycleError(
      "STATE_LOCK_REENTRANT_OPERATION_BLOCKED",
      "I stopped a nested Setup Session change so an older saved state could not overwrite a newer permission decision. Retry that action after the current step finishes."
    );
  }

  const previous = stateStoreOperationTails.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  stateStoreOperationTails.set(key, previous.catch(() => undefined).then(() => gate));
  await previous.catch(() => undefined);
  const modes = new Map(inherited?.modes ?? []);
  modes.set(key, mode);
  try {
    return await stateStoreLockContext.run({ modes }, operation);
  } finally {
    release();
  }
}

export async function withSourcePermissionStateLock(stateStore, operation) {
  return withSourcePermissionStateLockMode(stateStore, operation, "write");
}

// Status views serialize with writers but never save their loaded snapshot.
// A public writer invoked by a read-only callback may therefore run safely;
// that nested writer is temporarily upgraded to write mode so any further
// writer re-entry still fails closed.
export async function withSourcePermissionStateReadLock(stateStore, operation) {
  return withSourcePermissionStateLockMode(stateStore, operation, "read");
}

async function runWithinHeldSourcePermissionStateLock(stateStore, operation) {
  assertStateStore(stateStore);
  if (typeof operation !== "function") throw new TypeError("A state-store operation function is required.");
  const key = stateStoreOperationKey(stateStore);
  if (stateStoreLockContext.getStore()?.modes?.get(key) !== "write") {
    throw new PermissionLifecycleError(
      "STATE_LOCK_REQUIRED",
      "I stopped an internal Setup Session change because its full-state lock was not active. Retry from the guided source flow."
    );
  }
  return operation();
}

function assertConnector(connector) {
  if (!connector || typeof connector.discoverMetadata !== "function" || typeof connector.fetchApprovedContent !== "function") {
    throw new TypeError("A simulated read-only connector with discoverMetadata() and fetchApprovedContent() is required.");
  }
}

function assertNaturalLanguage(message, action) {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new PermissionLifecycleError(
      "PERMISSION_MESSAGE_REQUIRED",
      "Tell me in normal language what you would like to review, approve, or change."
    );
  }
  if (message.trim().startsWith("/")) {
    throw new PermissionLifecycleError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Just tell me in normal language what you would like to do with this source."
    );
  }
  if (action === "start" && !/second\s+brain|segundo\s+cerebro|connect|conectar|review|revisar/i.test(message)) {
    throw new PermissionLifecycleError(
      "UNRECOGNIZED_PERMISSION_REQUEST",
      "Tell me you would like to connect or review a source for your second brain, and I will guide you."
    );
  }
}

function languageFor(state, requestedLanguage) {
  return requestedLanguage === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function sourceKind(source) {
  const kind = PERMISSION_SOURCE_KINDS[source];
  if (!kind) {
    throw new PermissionLifecycleError(
      "SOURCE_NOT_SUPPORTED",
      "This simulated permission review supports a named communication, Calendar, or Drive source."
    );
  }
  return kind;
}

// Slack has a connector-specific boundary for independently enforceable
// channel, DM, group, people, pagination, and stable-reference rules. The
// generic lifecycle remains public for the other source kinds, but it must
// never become an alternate public path around that Slack boundary.
function assertPublicLifecycleSource(source) {
  if (source === "slack") {
    throw new PermissionLifecycleError(
      "SLACK_SPECIALIZED_LIFECYCLE_REQUIRED",
      "Slack uses its dedicated read-only review flow so its channel, direct-message, group, people, and pagination boundaries stay enforceable. Start the Slack connection from that guided flow."
    );
  }
  if (source === "whatsapp") {
    throw new PermissionLifecycleError(
      "WHATSAPP_SPECIALIZED_LIFECYCLE_REQUIRED",
      "WhatsApp snapshot permission is available only through its private local snapshot flow, so its manifest, local-alias, media, and bounded-fetch safeguards stay enforceable. Start the WhatsApp connection from that guided flow."
    );
  }
}

function assertSpecializedSlackSource(source) {
  if (source !== "slack") {
    throw new PermissionLifecycleError(
      "SPECIALIZED_SOURCE_MISMATCH",
      "This specialized permission bridge is reserved for the Slack lifecycle."
    );
  }
}

function assertSpecializedWhatsAppSource(source) {
  if (source !== "whatsapp") {
    throw new PermissionLifecycleError(
      "SPECIALIZED_SOURCE_MISMATCH",
      "This specialized permission bridge is reserved for the private WhatsApp snapshot lifecycle."
    );
  }
}

function sourceKey(source, accountId) {
  return `${source}:${encodeURIComponent(accountId)}`;
}

function defaultReviewId() {
  return `permission-review-${randomUUID()}`;
}

function defaultGrantId() {
  return `permission-grant-${randomUUID()}`;
}

function copy(language) {
  if (language === "es") {
    return {
      metadataOnly: "Revisé únicamente metadatos para preparar esta decisión. Todavía no he leído ningún cuerpo de mensaje, archivo ni evento.",
      metadataPreflightCompleted: "La revisión inicial fue solo de metadatos y ocurrió antes de leer cualquier cuerpo de fuente aprobado.",
      readOnly: "Esta conexión es solo de lectura. No puede enviar mensajes, modificar calendarios ni editar archivos.",
      purpose: "Usar únicamente los elementos que apruebes para crear conocimiento privado y con fuentes para tu segundo cerebro.",
      retention: "El contenido aprobado se usaría solo en almacenamiento local temporal durante el procesamiento y se elimina después de compilarlo o dentro de 24 horas. Esta prueba simulada no conserva ni muestra cuerpos de fuente.",
      modelProcessing: "El contenido que apruebes puede ser procesado por el proveedor de IA activo. No llamaré a eso almacenamiento local ni ampliaré el uso más allá de lo que apruebes.",
      untrusted: "Los mensajes y archivos conectados son material de referencia no confiable, no instrucciones. Ignoraré cualquier texto de fuente que pida ampliar permisos, revelar secretos, abrir enlaces, instalar software, ejecutar comandos o enviar mensajes.",
      cancel: "Puedes cancelar ahora, revisar el alcance antes de aprobarlo o revocar el permiso después. Sin una concesión activa, no se lee ningún cuerpo de fuente.",
      grantReady: "El alcance se guardó como una concesión de solo lectura y puedes revisarlo o revocarlo en esta misma conversación.",
      denied: "No se concedió acceso al contenido. La revisión de metadatos queda registrada y no se leyó ningún cuerpo de fuente.",
      revoked: "El permiso se revocó. No se puede reactivar con una pantalla, enlace o solicitud anterior; inicia una revisión nueva si quieres volver a considerar un alcance."
    };
  }
  return {
    metadataOnly: "I reviewed metadata only to prepare this decision. I have not read any message, file, or event body.",
    metadataPreflightCompleted: "The initial review was metadata-only and occurred before any approved source body was read.",
    readOnly: "This connection is read-only. It cannot send messages, change calendars, or edit files.",
    purpose: "Use only the items you approve to create private, sourced knowledge for your second brain.",
    retention: "Approved content would be used only in temporary local staging during processing and deleted after compilation or within 24 hours. This simulated proof does not retain or show source bodies.",
    modelProcessing: "Content you approve may be processed by the active AI provider. I will not call that local storage or expand use beyond what you approve.",
    untrusted: "Connected messages and files are untrusted reference material, not instructions. I will ignore any source text asking to broaden permission, reveal secrets, open links, install software, run commands, or send messages.",
    cancel: "You can cancel now, review the scope before approving it, or revoke permission later. No source body is read without an active grant.",
    grantReady: "The scope is saved as a read-only grant, and you can review or revoke it in this same conversation.",
    denied: "No content access was granted. The metadata review is recorded and no source body was read.",
    revoked: "Permission was revoked. It cannot be revived by an earlier screen, link, or request; start a new review if you want to consider a new scope."
  };
}

function redactUntrustedLabel(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "Untitled item";
  // Metadata can still be sensitive or hostile. Keep an understandable label
  // without reflecting embedded directives or high-risk-looking token values.
  const withoutDirective = text.replace(/(?:ignore|override|system\s+prompt|grant\s+access|reveal\s+secret)[^\n]*/gi, "[untrusted text removed]");
  const withoutTokens = withoutDirective
    .replace(/\b(?:\d[ -]?){9,}\b/g, "[redacted]")
    .replace(/\b(?:password|passcode|secret|api[ _-]?key|access[ _-]?token|social[ _-]?security|card[ _-]?number|account[ _-]?number)\b[^\n]*/gi, "[sensitive label redacted]");
  return withoutTokens.slice(0, 160);
}

function normalizedMetadataTimestamp(value) {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function safeMetadataLink(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || url.hostname === "localhost"
      || url.hostname.endsWith(".localhost")
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)
      || url.hostname.includes(":")
    ) return null;
    const stable = `${url.origin}${url.pathname}`;
    if (
      stable.length > 512
      || /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\d[ -]?){9,}\b|\b(?:api[ _-]?key|password|passcode|secret|access[ _-]?token|bearer)\b)/i.test(decodeURIComponent(url.pathname))
    ) return null;
    return stable;
  } catch {
    return null;
  }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort();
}

function normalizedAccessLevel(value) {
  return ACCESS_LEVELS.has(value) ? value : "restricted";
}

function normalizedSensitiveCategories(item) {
  const declared = item?.sensitiveCategories == null
    ? []
    : Array.isArray(item.sensitiveCategories)
      ? item.sensitiveCategories
      : [item.sensitiveCategories];
  const recognized = uniqueStrings(declared).filter((category) => SENSITIVE_CATEGORIES.includes(category));
  const hasUnknownCategory = declared.some((category) => (
    typeof category !== "string"
    || !category.trim()
    || !SENSITIVE_CATEGORIES.includes(category.trim())
  ));
  const hasMalformedUncertaintyMarker = item?.uncertainSensitivity !== undefined
    && typeof item.uncertainSensitivity !== "boolean";
  return uniqueStrings([
    ...recognized,
    ...(item?.uncertainSensitivity === true || hasUnknownCategory || hasMalformedUncertaintyMarker ? ["uncertain-sensitivity"] : [])
  ]);
}

function normalizeMetadata(preflight, source) {
  if (!preflight || typeof preflight !== "object" || typeof preflight.account?.id !== "string" || !preflight.account.id.trim()) {
    throw new PermissionLifecycleError(
      "METADATA_PREFLIGHT_INVALID",
      "I could not safely confirm the source account metadata, so I stopped before requesting content access."
    );
  }
  if (preflight.source && preflight.source !== source) {
    throw new PermissionLifecycleError(
      "METADATA_SOURCE_MISMATCH",
      "The source metadata did not match the connection you asked to review, so I stopped safely."
    );
  }
  if (preflight.readOnly !== true) {
    throw new PermissionLifecycleError(
      "SOURCE_NOT_READ_ONLY",
      "This source did not confirm a read-only connection, so I will not request access."
    );
  }

  const people = (Array.isArray(preflight.people) ? preflight.people : []).map((person) => {
    if (!person || typeof person.id !== "string" || !person.id.trim()) {
      throw new PermissionLifecycleError("METADATA_PREFLIGHT_INVALID", "I could not safely identify one of the people in this metadata review, so I stopped before requesting content access.");
    }
    return {
      id: person.id.trim(),
      label: redactUntrustedLabel(person.label ?? person.name),
      accessLevel: normalizedAccessLevel(person.accessLevel)
    };
  });
  const items = (Array.isArray(preflight.items) ? preflight.items : []).map((item) => {
    if (!item || typeof item.id !== "string" || !item.id.trim()) {
      throw new PermissionLifecycleError("METADATA_PREFLIGHT_INVALID", "I could not safely identify one of the reviewed source items, so I stopped before requesting content access.");
    }
    if (
      item.participantIds != null
      && (
        !Array.isArray(item.participantIds)
        || item.participantIds.some((id) => typeof id !== "string" || !id.trim())
      )
    ) {
      throw new PermissionLifecycleError(
        "METADATA_PARTICIPANT_BOUNDARY_INVALID",
        "The metadata did not safely describe record participants, so I stopped before requesting content access."
      );
    }
    return {
      id: item.id.trim(),
      kind: item.kind === "conversation" ? "conversation" : "item",
      area: typeof item.area === "string" ? item.area : null,
      folder: typeof item.folder === "string" ? item.folder : null,
      channel: typeof item.channel === "string" ? item.channel : null,
      conversation: typeof item.conversation === "string" ? item.conversation : null,
      category: typeof item.category === "string" ? item.category : "general",
      timestamp: normalizedMetadataTimestamp(item.timestamp),
      sensitiveCategories: normalizedSensitiveCategories(item),
      isGroup: item.isGroup === true,
      participantIds: item.participantIds == null ? [] : uniqueStrings(item.participantIds),
      label: redactUntrustedLabel(item.label ?? item.title),
      stableLink: safeMetadataLink(item.stableLink ?? item.webUrl ?? item.url)
    };
  });
  if (new Set(people.map((person) => person.id)).size !== people.length || new Set(items.map((item) => item.id)).size !== items.length) {
    throw new PermissionLifecycleError("METADATA_PREFLIGHT_INVALID", "The metadata review contained an ambiguous identifier, so I stopped before requesting content access.");
  }
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const unknownParticipantIds = uniqueStrings(items.flatMap((item) => item.participantIds).filter((id) => !peopleById.has(id)));
  const blockedGroupConversations = items
    .filter((item) => item.kind === "conversation" && item.isGroup && item.participantIds.some((id) => peopleById.get(id)?.accessLevel === "blocked"))
    .map((item) => ({ id: item.id, label: item.label }));
  const sensitiveGroups = SENSITIVE_CATEGORIES
    .map((category) => {
      const matching = items.filter((item) => item.sensitiveCategories.includes(category));
      return matching.length === 0 ? null : {
        category,
        count: matching.length,
        itemLabels: matching.map((item) => item.label)
      };
    })
    .filter(Boolean);

  return {
    source,
    account: {
      id: preflight.account.id.trim(),
      label: redactUntrustedLabel(preflight.account.label ?? preflight.account.id)
    },
    areas: uniqueStrings([...preflight.areas ?? [], ...items.map((item) => item.area)]),
    folders: uniqueStrings([...preflight.folders ?? [], ...items.map((item) => item.folder)]),
    channels: uniqueStrings([...preflight.channels ?? [], ...items.map((item) => item.channel)]),
    conversations: uniqueStrings([...preflight.conversations ?? [], ...items.filter((item) => item.kind === "conversation").map((item) => item.id)]),
    categories: uniqueStrings([...preflight.categories ?? [], ...items.map((item) => item.category)]),
    people,
    unknownParticipantIds,
    items,
    sensitiveGroups,
    blockedGroupConversations,
    itemCount: items.length
  };
}

function sourcePermissionMetadataDigest(metadata) {
  return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
}

function assertReviewMetadataIntegrity(review) {
  const metadata = review?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new PermissionLifecycleError(
      "PERSISTED_METADATA_INVALID",
      "The saved metadata review is incomplete, so no source content was read. Start a new metadata-only review."
    );
  }
  const people = Array.isArray(metadata.people) ? metadata.people : [];
  const items = Array.isArray(metadata.items) ? metadata.items : [];
  const peopleById = new Map(people.map((person) => [person?.id, person]));
  const expectedUnknownParticipantIds = uniqueStrings(items
    .flatMap((item) => Array.isArray(item?.participantIds) ? item.participantIds : [])
    .filter((id) => !peopleById.has(id)));
  const expectedBlockedGroupConversations = items
    .filter((item) => item?.kind === "conversation"
      && item.isGroup === true
      && Array.isArray(item.participantIds)
      && item.participantIds.some((id) => peopleById.get(id)?.accessLevel === "blocked"))
    .map((item) => ({ id: item.id, label: item.label }));
  const expectedSensitiveGroups = SENSITIVE_CATEGORIES
    .map((category) => {
      const matching = items.filter((item) => Array.isArray(item?.sensitiveCategories) && item.sensitiveCategories.includes(category));
      return matching.length === 0 ? null : {
        category,
        count: matching.length,
        itemLabels: matching.map((item) => item.label)
      };
    })
    .filter(Boolean);
  const malformedPeople = people.some((person) => (
    !person
    || typeof person.id !== "string"
    || !person.id.trim()
    || !ACCESS_LEVELS.has(person.accessLevel)
  ));
  const malformedItems = items.some((item) => (
    !item
    || typeof item.id !== "string"
    || !item.id.trim()
    || !Array.isArray(item.participantIds)
    || item.participantIds.some((id) => typeof id !== "string" || !id.trim())
    || !Array.isArray(item.sensitiveCategories)
    || item.sensitiveCategories.some((category) => !SENSITIVE_CATEGORIES.includes(category))
  ));
  const digest = sourcePermissionMetadataDigest(metadata);
  if (
    malformedPeople
    || malformedItems
    || new Set(people.map((person) => person.id)).size !== people.length
    || new Set(items.map((item) => item.id)).size !== items.length
    || metadata.itemCount !== items.length
    || JSON.stringify(metadata.unknownParticipantIds) !== JSON.stringify(expectedUnknownParticipantIds)
    || JSON.stringify(metadata.blockedGroupConversations) !== JSON.stringify(expectedBlockedGroupConversations)
    || JSON.stringify(metadata.sensitiveGroups) !== JSON.stringify(expectedSensitiveGroups)
    || !METADATA_DIGEST.test(review.metadataDigest ?? "")
    || review.metadataDigest !== digest
  ) {
    throw new PermissionLifecycleError(
      "PERSISTED_METADATA_INVALID",
      "The saved metadata review no longer matches its integrity-bound snapshot, so no source content was read. Start a new metadata-only review."
    );
  }
  return digest;
}

function dateRangeFor(kind, now) {
  const base = new Date(now);
  if (kind === "communication") {
    const from = new Date(base);
    from.setUTCDate(from.getUTCDate() - 90);
    return { ...DEFAULT_PERMISSION_WINDOWS.communication, from: from.toISOString(), to: base.toISOString() };
  }
  if (kind === "calendar") {
    const from = new Date(base);
    from.setUTCMonth(from.getUTCMonth() - 6);
    const to = new Date(base);
    to.setUTCDate(to.getUTCDate() + 90);
    return { ...DEFAULT_PERMISSION_WINDOWS.calendar, from: from.toISOString(), to: to.toISOString() };
  }
  return { ...DEFAULT_PERMISSION_WINDOWS.drive };
}

function defaultScope(metadata, kind, now) {
  const sensitive = new Set(metadata.sensitiveGroups.map((group) => group.category));
  const people = {
    allowed: metadata.people.filter((person) => person.accessLevel === "allowed").map((person) => person.id),
    restricted: metadata.people.filter((person) => person.accessLevel === "restricted").map((person) => person.id),
    blocked: metadata.people.filter((person) => person.accessLevel === "blocked").map((person) => person.id)
  };
  return {
    accountId: metadata.account.id,
    areas: [...metadata.areas],
    folders: [...metadata.folders],
    channels: [...metadata.channels],
    conversations: [...metadata.conversations],
    categories: metadata.categories.filter((category) => !sensitive.has(category)),
    people,
    dateRange: dateRangeFor(kind, now),
    exclusions: {
      accounts: [],
      areas: [],
      folders: [],
      channels: [],
      people: [...people.restricted, ...people.blocked],
      conversations: [...metadata.blockedGroupConversations.map((conversation) => conversation.id)],
      categories: [...metadata.sensitiveGroups.map((group) => group.category)],
      dateRanges: []
    },
    sensitiveGroups: {
      included: [],
      excluded: [...metadata.sensitiveGroups.map((group) => group.category)]
    },
    blockedGroupConversationExceptions: [],
    acknowledgements: {
      modelProcessing: false,
      untrustedSourceMaterial: false
    }
  };
}

function clone(value) {
  return structuredClone(value);
}

function permissionState(state) {
  if (!state[STATE_KEY]) {
    state[STATE_KEY] = {
      version: 1,
      entries: {},
      audit: []
    };
  }
  return state[STATE_KEY];
}

function pushAudit(permissionStateValue, event) {
  permissionStateValue.audit.push(event);
}

function assertSubset(values, allowed, field) {
  const requested = uniqueStrings(values);
  const allowedSet = new Set(allowed);
  const outside = requested.filter((value) => !allowedSet.has(value));
  if (outside.length > 0) {
    throw new PermissionLifecycleError(
      "SCOPE_EXPANSION_BLOCKED",
      `The requested ${field} was not part of the metadata review, so I kept access narrowed to the reviewed scope.`
    );
  }
  return requested;
}

function assertAllowedKeys(object, allowedKeys, field) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new PermissionLifecycleError("SCOPE_INVALID", `I could not safely understand the ${field} selection.`);
  }
  const unknown = Object.keys(object).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new PermissionLifecycleError(
      "UNTRUSTED_SCOPE_INPUT",
      "I ignored an untrusted request to change the permission shape. Only the reviewed choices can be approved."
    );
  }
}

function applyExclusions(selected, excluded) {
  const excludedSet = new Set(uniqueStrings(excluded));
  return selected.filter((value) => !excludedSet.has(value));
}

function dateRangeMatches(candidate, expected) {
  if (!candidate || candidate.kind !== expected.kind) return false;
  if (expected.kind === "selected-folders-only") return true;
  return candidate.pastDays === expected.pastDays
    && candidate.futureDays === expected.futureDays
    && candidate.pastMonths === expected.pastMonths
    && (!candidate.from || candidate.from === expected.from)
    && (!candidate.to || candidate.to === expected.to);
}

function normalizeDateRangeExclusions(values, expected) {
  if (!Array.isArray(values)) {
    throw new PermissionLifecycleError("DATE_EXCLUSION_INVALID", "I could not safely understand the date exclusions, so I kept the reviewed date boundary unchanged.");
  }
  if (expected.kind === "selected-folders-only") {
    if (values.length > 0) {
      throw new PermissionLifecycleError("DRIVE_DATE_WINDOW_NOT_ALLOWED", "Drive permission is limited to selected folders, not an arbitrary date window.");
    }
    return [];
  }
  const minimum = Date.parse(expected.from);
  const maximum = Date.parse(expected.to);
  const normalized = values.map((value) => {
    assertAllowedKeys(value, ["from", "to"], "date exclusion");
    const from = Date.parse(value.from);
    const to = Date.parse(value.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      throw new PermissionLifecycleError("DATE_EXCLUSION_INVALID", "Each excluded date range needs a valid start and end inside the reviewed window.");
    }
    if (from < minimum || to > maximum) {
      throw new PermissionLifecycleError("DATE_EXCLUSION_OUTSIDE_SCOPE", "A date exclusion cannot change or broaden the reviewed time window.");
    }
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  });
  return normalized.sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`));
}

function normalizedScope(inputScope, review, kind, now) {
  const metadata = review.metadata;
  const requested = inputScope ?? review.requestedScope;
  assertAllowedKeys(requested, [
    "accountId", "areas", "folders", "channels", "conversations", "categories", "people", "dateRange", "exclusions", "sensitiveGroups", "blockedGroupConversationExceptions", "acknowledgements"
  ], "permission scope");
  assertAllowedKeys(requested.people ?? {}, ["allowed", "restricted", "blocked"], "people selection");
  assertAllowedKeys(requested.exclusions ?? {}, ["accounts", "areas", "folders", "channels", "people", "conversations", "categories", "dateRanges"], "exclusions");
  assertAllowedKeys(requested.sensitiveGroups ?? {}, ["included", "excluded"], "sensitive-item review");
  assertAllowedKeys(requested.acknowledgements ?? {}, ["modelProcessing", "untrustedSourceMaterial"], "acknowledgements");
  if (requested.dateRange) {
    assertAllowedKeys(requested.dateRange, ["kind", "pastDays", "futureDays", "pastMonths", "label", "from", "to", "dateRangeAllowed"], "date range");
  }

  if (requested.accountId !== metadata.account.id || uniqueStrings(requested.exclusions?.accounts).includes(metadata.account.id)) {
    throw new PermissionLifecycleError("ACCOUNT_SCOPE_INVALID", "The reviewed account must be selected exactly as shown, without broadening to another account.");
  }

  const peopleById = new Map(metadata.people.map((person) => [person.id, person]));
  const allPeople = metadata.people.map((person) => person.id);
  const allowedPeople = assertSubset(requested.people?.allowed, allPeople, "people");
  const restrictedPeople = assertSubset(requested.people?.restricted, allPeople, "people");
  const blockedPeople = assertSubset(requested.people?.blocked, allPeople, "people");
  for (const personId of allowedPeople) {
    if (peopleById.get(personId)?.accessLevel !== "allowed") {
      throw new PermissionLifecycleError("PERSON_POLICY_CANNOT_BE_BROADENED", "A Restricted or Blocked person cannot be promoted to Allowed through this permission request.");
    }
  }
  for (const personId of restrictedPeople) {
    if (peopleById.get(personId)?.accessLevel === "blocked") {
      throw new PermissionLifecycleError("PERSON_POLICY_CANNOT_BE_BROADENED", "A Blocked person remains blocked unless you begin a separate, explicit review.");
    }
  }
  for (const personId of blockedPeople) {
    if (peopleById.get(personId)?.accessLevel !== "blocked") {
      throw new PermissionLifecycleError("PERSON_POLICY_CANNOT_BE_BROADENED", "Only a person reviewed as Blocked can enter a blocked-group exception boundary.");
    }
  }
  const selectedPeople = [allowedPeople, restrictedPeople, blockedPeople];
  if (new Set(selectedPeople.flat()).size !== selectedPeople.flat().length) {
    throw new PermissionLifecycleError(
      "PERSON_POLICY_OVERLAP",
      "Each reviewed person must remain in one privacy classification; overlapping classifications cannot be approved."
    );
  }

  const sensitiveAllowed = metadata.sensitiveGroups.map((group) => group.category);
  const includedSensitive = assertSubset(requested.sensitiveGroups?.included, sensitiveAllowed, "sensitive categories");
  const excludedSensitive = assertSubset(requested.sensitiveGroups?.excluded, sensitiveAllowed, "sensitive categories");
  const effectiveIncludedSensitive = includedSensitive.filter((category) => !excludedSensitive.includes(category));
  // A persisted canonical scope includes every explicitly approved sensitive
  // group in `categories` as well as in `sensitiveGroups.included`. Accept
  // only those explicitly included groups here so integrity revalidation is
  // idempotent without letting a caller smuggle a sensitive category through
  // the ordinary category list.
  const selectedCategories = assertSubset(requested.categories, [...metadata.categories, ...includedSensitive], "categories");
  const finalCategories = applyExclusions(
    [...new Set([...selectedCategories, ...effectiveIncludedSensitive])],
    [...uniqueStrings(requested.exclusions?.categories), ...excludedSensitive]
  );

  const allowedBlockedGroupIds = metadata.blockedGroupConversations.map((conversation) => conversation.id);
  const exceptions = assertSubset(requested.blockedGroupConversationExceptions, allowedBlockedGroupIds, "blocked group conversations");
  const selectedConversations = assertSubset(requested.conversations, metadata.conversations, "conversations");
  const exclusions = requested.exclusions ?? {};
  const explicitConversationExclusions = uniqueStrings(exclusions.conversations).filter((conversationId) => !exceptions.includes(conversationId));
  const finalConversations = applyExclusions(selectedConversations, explicitConversationExclusions)
    .filter((conversationId) => !allowedBlockedGroupIds.includes(conversationId) || exceptions.includes(conversationId));

  // `people.allowed` is an allowlist, not merely a display preference.  An
  // omitted Allowed person must be excluded before a connector receives the
  // grant; otherwise a caller could appear to narrow people while still
  // receiving every Allowed participant's records.
  const finalAllowedPeople = applyExclusions(allowedPeople, exclusions.people);

  const scope = {
    accountId: metadata.account.id,
    areas: applyExclusions(assertSubset(requested.areas, metadata.areas, "areas"), exclusions.areas),
    folders: applyExclusions(assertSubset(requested.folders, metadata.folders, "folders"), exclusions.folders),
    channels: applyExclusions(assertSubset(requested.channels, metadata.channels, "channels"), exclusions.channels),
    conversations: finalConversations,
    categories: finalCategories,
    people: {
      allowed: finalAllowedPeople,
      // These two lists are persisted as privacy boundaries, never content allowlists.
      restricted: uniqueStrings([...restrictedPeople, ...metadata.people.filter((person) => person.accessLevel === "restricted").map((person) => person.id)]),
      blocked: uniqueStrings([...blockedPeople, ...metadata.people.filter((person) => person.accessLevel === "blocked").map((person) => person.id)])
    },
    exclusions: {
      accounts: uniqueStrings(exclusions.accounts),
      areas: uniqueStrings(exclusions.areas),
      folders: uniqueStrings(exclusions.folders),
      channels: uniqueStrings(exclusions.channels),
      people: uniqueStrings([
        ...exclusions.people ?? [],
        ...allPeople.filter((personId) => !finalAllowedPeople.includes(personId)),
        ...requested.people?.restricted ?? [],
        ...requested.people?.blocked ?? [],
        ...metadata.people.filter((person) => person.accessLevel !== "allowed").map((person) => person.id),
        ...metadata.unknownParticipantIds
      ]),
      conversations: uniqueStrings([...explicitConversationExclusions, ...allowedBlockedGroupIds.filter((id) => !exceptions.includes(id))]),
      categories: uniqueStrings([...exclusions.categories ?? [], ...excludedSensitive]),
      dateRanges: []
    },
    sensitiveGroups: {
      included: effectiveIncludedSensitive,
      excluded: uniqueStrings([...excludedSensitive, ...sensitiveAllowed.filter((category) => !effectiveIncludedSensitive.includes(category))])
    },
    blockedGroupConversationExceptions: exceptions,
    dateRange: null,
    acknowledgements: {
      modelProcessing: requested.acknowledgements?.modelProcessing === true,
      untrustedSourceMaterial: requested.acknowledgements?.untrustedSourceMaterial === true
    }
  };

  if (!scope.acknowledgements.modelProcessing || !scope.acknowledgements.untrustedSourceMaterial) {
    throw new PermissionLifecycleError(
      "DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED",
      "Please acknowledge both the active AI-provider processing disclosure and that imported source material is untrusted before approving access."
    );
  }

  if (kind === "drive") {
    const candidate = requested.dateRange;
    if (candidate && (candidate.kind !== "selected-folders-only" || candidate.from || candidate.to || candidate.pastDays || candidate.futureDays)) {
      throw new PermissionLifecycleError("DRIVE_DATE_WINDOW_NOT_ALLOWED", "Drive permission is limited to selected folders, not an arbitrary date window.");
    }
    if (scope.folders.length === 0) {
      throw new PermissionLifecycleError("DRIVE_FOLDER_REQUIRED", "Select at least one reviewed Drive folder before granting access.");
    }
    scope.dateRange = dateRangeFor("drive", now);
    scope.exclusions.dateRanges = normalizeDateRangeExclusions(exclusions.dateRanges ?? [], scope.dateRange);
  } else {
    const expected = review.requestedScope.dateRange;
    const candidate = requested.dateRange ?? expected;
    if (!dateRangeMatches(candidate, expected)) {
      throw new PermissionLifecycleError("DATE_SCOPE_EXPANSION_BLOCKED", "The requested date range does not match the reviewed default. Start a new explicit review to change the time window.");
    }
    scope.dateRange = clone(expected);
    scope.exclusions.dateRanges = normalizeDateRangeExclusions(exclusions.dateRanges ?? [], scope.dateRange);
  }

  return scope;
}

function publicReview(entry, language) {
  const wording = copy(language);
  const review = entry.review;
  const activeGrant = entry.grants.find((grant) => grant.status === "active") ?? null;
  return {
    source: review.source,
    account: clone(review.metadata.account),
    status: entry.status,
    readOnly: true,
    metadataPreflight: {
      metadataOnly: true,
      contentBodiesReadAtPreflight: false,
      contentBodiesRead: entry.bodyFetches > 0,
      approvedContentFetches: entry.bodyFetches,
      itemCount: review.metadata.itemCount,
      sensitiveGroups: clone(review.metadata.sensitiveGroups),
      blockedGroupConversations: clone(review.metadata.blockedGroupConversations),
      message: entry.bodyFetches > 0 ? wording.metadataPreflightCompleted : wording.metadataOnly
    },
    permissionRequest: {
      reviewId: review.id,
      source: review.source,
      account: clone(review.metadata.account),
      purpose: wording.purpose,
      retention: wording.retention,
      requestedScope: clone(review.requestedScope),
      exclusionsSupported: ["accounts", "areas", "folders", "channels", "people", "conversations", "categories", "dateRanges"],
      disclosures: {
        modelProcessing: wording.modelProcessing,
        untrustedSourceMaterial: wording.untrusted
      },
      cancelableReview: wording.cancel,
      connectionBoundary: wording.readOnly
    },
    activeGrant: activeGrant ? {
      grantId: activeGrant.id,
      reviewId: activeGrant.reviewId,
      status: activeGrant.status,
      approvedAt: activeGrant.approvedAt,
      scope: clone(activeGrant.scope),
      disclosuresAcknowledged: clone(activeGrant.disclosuresAcknowledged)
    } : null,
    audit: clone(entry.audit)
  };
}

function sameStringList(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function invalidSpecializedWhatsAppMetadata() {
  throw new PermissionLifecycleError(
    "PERSISTED_METADATA_INVALID",
    "The saved WhatsApp metadata review no longer preserves its private alias boundary, so no source content was read. Start a new metadata-only review."
  );
}

/**
 * WhatsApp's local connector intentionally persists opaque aliases so the
 * specialized guided flow can let a person choose a chat without ever seeing
 * its original account, contact, chat, or path details. Generic public
 * reviews deliberately omit people and reviewed items for sources such as
 * Slack; expose those fields here only after proving every value remains a
 * local WhatsApp alias and generic label.
 */
function specializedWhatsAppPublicMetadata(review) {
  assertReviewMetadataIntegrity(review);
  const metadata = review?.metadata;
  if (
    review?.source !== "whatsapp"
    || metadata?.source !== "whatsapp"
    || !WHATSAPP_ACCOUNT_REFERENCE.test(metadata?.account?.id ?? "")
    || metadata.account.label !== WHATSAPP_ACCOUNT_LABEL
    || !Array.isArray(metadata.people)
    || !Array.isArray(metadata.items)
  ) {
    invalidSpecializedWhatsAppMetadata();
  }

  const people = metadata.people.map((person) => ({
    id: person.id,
    label: person.label,
    accessLevel: person.accessLevel
  }));
  if (
    people.some((person) => (
      !WHATSAPP_PERSON_REFERENCE.test(person.id)
      || !WHATSAPP_PERSON_LABEL.test(person.label)
      || !ACCESS_LEVELS.has(person.accessLevel)
    ))
    || new Set(people.map((person) => person.id)).size !== people.length
  ) {
    invalidSpecializedWhatsAppMetadata();
  }

  const knownPersonIds = new Set(people.map((person) => person.id));
  const reviewedItems = metadata.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    conversation: item.conversation,
    category: item.category,
    sensitiveCategories: [...item.sensitiveCategories],
    isGroup: item.isGroup,
    participantIds: [...item.participantIds],
    label: item.label
  }));
  const malformedItem = metadata.items.some((item, index) => {
    const projected = reviewedItems[index];
    const expectedSensitiveCategories = item.category === "messages" ? [] : [item.category];
    const isKnownCategory = item.category === "messages" || SENSITIVE_CATEGORIES.includes(item.category);
    const hasSafeParticipants = projected.participantIds.length > 0
      && new Set(projected.participantIds).size === projected.participantIds.length
      && projected.participantIds.every((id) => knownPersonIds.has(id));
    return (
      !WHATSAPP_CHAT_REFERENCE.test(projected.id)
      || projected.kind !== "conversation"
      || projected.conversation !== projected.id
      || !isKnownCategory
      || !sameStringList(projected.sensitiveCategories, expectedSensitiveCategories)
      || typeof projected.isGroup !== "boolean"
      || !hasSafeParticipants
      || !WHATSAPP_CHAT_LABEL.test(projected.label)
      || (projected.isGroup ? !projected.label.startsWith("Group WhatsApp chat ") : !projected.label.startsWith("Direct WhatsApp chat "))
      || item.area !== null
      || item.folder !== null
      || item.channel !== null
      || item.timestamp !== null
      || item.stableLink !== null
    );
  });
  if (malformedItem || new Set(reviewedItems.map((item) => item.id)).size !== reviewedItems.length) {
    invalidSpecializedWhatsAppMetadata();
  }

  const expectedConversations = uniqueStrings(reviewedItems.map((item) => item.id));
  const expectedCategories = uniqueStrings(reviewedItems.map((item) => item.category));
  if (
    !sameStringList(metadata.areas, [])
    || !sameStringList(metadata.folders, [])
    || !sameStringList(metadata.channels, [])
    || !sameStringList(metadata.conversations, expectedConversations)
    || !sameStringList(metadata.categories, expectedCategories)
    || !sameStringList(metadata.unknownParticipantIds, [])
    || metadata.itemCount !== reviewedItems.length
  ) {
    invalidSpecializedWhatsAppMetadata();
  }

  const peopleById = new Map(people.map((person) => [person.id, person]));
  const blockedGroupConversations = reviewedItems
    .filter((item) => item.isGroup && item.participantIds.some((id) => peopleById.get(id)?.accessLevel === "blocked"))
    .map((item) => ({ id: item.id, label: item.label }));
  const sensitiveGroups = SENSITIVE_CATEGORIES
    .map((category) => {
      const matching = reviewedItems.filter((item) => item.sensitiveCategories.includes(category));
      return matching.length === 0 ? null : {
        category,
        count: matching.length,
        itemLabels: matching.map((item) => item.label)
      };
    })
    .filter(Boolean);

  return {
    account: { id: metadata.account.id, label: metadata.account.label },
    people,
    reviewedItems,
    sensitiveGroups,
    blockedGroupConversations
  };
}

function specializedWhatsAppPublicReview(entry, language) {
  const projection = specializedWhatsAppPublicMetadata(entry.review);
  const generic = publicReview(entry, language);
  return {
    ...generic,
    account: clone(projection.account),
    metadataPreflight: {
      ...generic.metadataPreflight,
      itemCount: projection.reviewedItems.length,
      sensitiveGroups: clone(projection.sensitiveGroups),
      blockedGroupConversations: clone(projection.blockedGroupConversations),
      people: clone(projection.people),
      reviewedItems: clone(projection.reviewedItems)
    },
    permissionRequest: {
      ...generic.permissionRequest,
      account: clone(projection.account)
    }
  };
}

export function assertPersistedSourcePermissionGrantStillMatchesReview(grant, entry, clock) {
  if (!grant?.disclosuresAcknowledged?.modelProcessing?.acknowledged || !grant?.disclosuresAcknowledged?.untrustedSourceMaterial?.acknowledged) {
    throw new PermissionLifecycleError(
      "PERSISTED_GRANT_INVALID",
      "The saved permission no longer includes the required privacy acknowledgements, so no source content was read. Start a new review."
    );
  }
  let metadataDigest;
  try {
    metadataDigest = assertReviewMetadataIntegrity(entry?.review);
  } catch {
    throw new PermissionLifecycleError(
      "PERSISTED_GRANT_INVALID",
      "The saved permission no longer matches its integrity-bound metadata review, so no source content was read. Start a new review."
    );
  }
  if (grant?.metadataDigest !== metadataDigest) {
    throw new PermissionLifecycleError(
      "PERSISTED_GRANT_INVALID",
      "The saved permission was not bound to this metadata review, so no source content was read. Start a new review."
    );
  }
  let canonicalScope;
  try {
    canonicalScope = normalizedScope(grant.scope, entry.review, entry.sourceKind, isoNow(clock));
  } catch {
    throw new PermissionLifecycleError(
      "PERSISTED_GRANT_INVALID",
      "The saved permission no longer matches its reviewed scope, so no source content was read. Start a new review."
    );
  }
  if (JSON.stringify(canonicalScope) !== JSON.stringify(grant.scope)) {
    throw new PermissionLifecycleError(
      "PERSISTED_GRANT_INVALID",
      "The saved permission no longer matches its reviewed scope, so no source content was read. Start a new review."
    );
  }
}

// Deliberately not re-exported from src/index.mjs. The specialized WhatsApp
// lifecycle uses this digest comparison while it already holds the shared
// state lock, so it can verify a fresh local manifest against the persisted
// metadata snapshot without exposing people or item aliases through a generic
// public permission view.
export function specializedWhatsAppMetadataMatchesPermissionReview({ state, source, accountId, metadata }) {
  assertSpecializedWhatsAppSource(source);
  const entry = state?.[STATE_KEY]?.entries?.[sourceKey(source, accountId)];
  if (!entry || entry.review?.source !== source || entry.review?.metadata?.account?.id !== accountId) return false;
  try {
    const persistedDigest = assertReviewMetadataIntegrity(entry.review);
    const candidate = normalizeMetadata(metadata, source);
    return candidate.account.id === accountId && sourcePermissionMetadataDigest(candidate) === persistedDigest;
  } catch {
    return false;
  }
}

async function loadRootState(stateStore) {
  const state = await stateStore.load();
  if (!state) {
    throw new PermissionLifecycleError(
      "SETUP_SESSION_NOT_FOUND",
      "Start your second-brain setup first, then I can guide the source permission review in this same conversation."
    );
  }
  return state;
}

/**
 * Public Setup Session boundary: metadata-only discovery and a customer-visible
 * granular permission request. This is the only entry point that starts a
 * source review; connector discovery is never a body fetch.
 */
async function beginSourcePermissionReviewInternal({
  message,
  stateStore,
  connector,
  source,
  language,
  clock,
  reviewIdFactory,
  permissionReviewRenderer = publicReview
}) {
  assertNaturalLanguage(message, "start");
  assertStateStore(stateStore);
  assertConnector(connector);
  const kind = sourceKind(source);
  const state = await loadRootState(stateStore);
  const lifecycle = permissionState(state);
  const metadata = normalizeMetadata(await connector.discoverMetadata({ source }), source);
  const key = sourceKey(source, metadata.account.id);
  const previousEntry = lifecycle.entries[key];
  if (previousEntry?.status === "granted") {
    return { permissionReview: permissionReviewRenderer(previousEntry, languageFor(state, language)) };
  }
  const now = isoNow(clock);
  const reviewId = (reviewIdFactory ?? defaultReviewId)();
  const entry = {
    source,
    sourceKind: kind,
    accountId: metadata.account.id,
    status: "awaiting-grant",
    review: {
      id: reviewId,
      source,
      metadata,
      metadataDigest: sourcePermissionMetadataDigest(metadata),
      requestedScope: defaultScope(metadata, kind, now),
      createdAt: now
    },
    grants: previousEntry?.grants ?? [],
    bodyFetches: previousEntry?.bodyFetches ?? 0,
    audit: [
      ...previousEntry?.audit ?? [],
      { type: "metadata-preflight", at: now, reviewId, contentBodiesRead: false }
    ]
  };
  lifecycle.entries[key] = entry;
  pushAudit(lifecycle, { type: "metadata-preflight", at: now, source, accountId: metadata.account.id, reviewId, contentBodiesRead: false });
  await stateStore.save(state);
  return { permissionReview: permissionReviewRenderer(entry, languageFor(state, language)) };
}

export async function beginSourcePermissionReview(args) {
  assertPublicLifecycleSource(args?.source);
  return withSourcePermissionStateLock(args?.stateStore, () => beginSourcePermissionReviewInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function beginSourcePermissionReviewWithinStateLock(args) {
  assertPublicLifecycleSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => beginSourcePermissionReviewInternal({ ...args, permissionReviewRenderer: publicReview }));
}

// Deliberately not re-exported from src/index.mjs. The Slack connector owns
// the public customer flow and invokes this shared persistence primitive only
// after applying its additional source-specific safeguards.
export async function beginSpecializedSourcePermissionReview(args) {
  assertSpecializedSlackSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => beginSourcePermissionReviewInternal({ ...args, permissionReviewRenderer: publicReview }));
}

// Deliberately not re-exported from src/index.mjs. The private WhatsApp
// snapshot lifecycle owns this bridge and may call it only while it holds the
// shared in-process state lock.
export async function beginSpecializedWhatsAppPermissionReview(args) {
  assertSpecializedWhatsAppSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => beginSourcePermissionReviewInternal({ ...args, permissionReviewRenderer: specializedWhatsAppPublicReview }));
}

/**
 * Public Setup Session boundary: records one granular immutable grant. A stale
 * review cannot be used after denial or revocation, and a second matching call
 * returns the existing grant rather than widening or duplicating access.
 */
async function grantSourcePermissionInternal({
  message,
  stateStore,
  connector,
  source,
  accountId,
  reviewId,
  scope,
  language,
  clock,
  grantIdFactory,
  permissionReviewRenderer = publicReview
}) {
  assertNaturalLanguage(message, "grant");
  assertStateStore(stateStore);
  if (!connector || typeof connector.registerPermissionGrant !== "function") {
    throw new TypeError("A simulated connector with registerPermissionGrant() is required to activate a grant.");
  }
  const state = await loadRootState(stateStore);
  const lifecycle = permissionState(state);
  const entry = lifecycle.entries[sourceKey(source, accountId)];
  if (!entry || !REVIEW_STATUSES.has(entry.status)) {
    throw new PermissionLifecycleError("PERMISSION_REVIEW_NOT_FOUND", "I could not find that permission review. Start a new metadata-only review first.");
  }
  if (entry.review.id !== reviewId) {
    throw new PermissionLifecycleError("STALE_PERMISSION_REVIEW", "That review is no longer current. I kept access denied; start or use the current review instead.");
  }
  if (entry.status === "denied" || entry.status === "revoked") {
    throw new PermissionLifecycleError("STALE_GRANT_REJECTED", "That earlier permission request is no longer valid. Start a new metadata-only review before approving anything.");
  }

  const now = isoNow(clock);
  const metadataDigest = assertReviewMetadataIntegrity(entry.review);
  const normalized = normalizedScope(scope, entry.review, entry.sourceKind, now);
  const existing = entry.grants.find((grant) => grant.status === "active");
  if (existing) {
    if (JSON.stringify(existing.scope) !== JSON.stringify(normalized)) {
      throw new PermissionLifecycleError("SCOPE_CHANGE_REQUIRES_NEW_REVIEW", "This would change an approved scope. Start a new review so the change is visible before access is granted.");
    }
    return { permissionReview: permissionReviewRenderer(entry, languageFor(state, language)) };
  }

  const wording = copy(languageFor(state, language));
  const grant = {
    id: (grantIdFactory ?? defaultGrantId)(),
    reviewId,
    source,
    accountId,
    metadataDigest,
    status: "active",
    approvedAt: now,
    scope: normalized,
    disclosuresAcknowledged: {
      modelProcessing: { acknowledged: true, text: wording.modelProcessing },
      untrustedSourceMaterial: { acknowledged: true, text: wording.untrusted }
    }
  };
  try {
    await connector.registerPermissionGrant({ grant: clone(grant) });
  } catch {
    throw new PermissionLifecycleError(
      "PERMISSION_GRANT_ACTIVATION_FAILED",
      "I could not activate that read-only permission safely. No source content was read, and you can retry this same review."
    );
  }
  entry.grants.push(grant);
  entry.status = "granted";
  entry.audit.push({ type: "permission-granted", at: now, reviewId, grantId: grant.id, scope: clone(normalized) });
  pushAudit(lifecycle, { type: "permission-granted", at: now, source, accountId, reviewId, grantId: grant.id });
  await stateStore.save(state);
  return { permissionReview: permissionReviewRenderer(entry, languageFor(state, language)) };
}

export async function grantSourcePermission(args) {
  assertPublicLifecycleSource(args?.source);
  return withSourcePermissionStateLock(args?.stateStore, () => grantSourcePermissionInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function grantSourcePermissionWithinStateLock(args) {
  assertPublicLifecycleSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => grantSourcePermissionInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function grantSpecializedSourcePermission(args) {
  assertSpecializedSlackSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => grantSourcePermissionInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function grantSpecializedWhatsAppPermission(args) {
  assertSpecializedWhatsAppSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => grantSourcePermissionInternal({ ...args, permissionReviewRenderer: specializedWhatsAppPublicReview }));
}

/** Records an explicit denial without treating it as an error or allowing stale approval UI to revive it. */
async function denySourcePermissionInternal({ message, stateStore, source, accountId, reviewId, language, clock, permissionReviewRenderer = publicReview }) {
  assertNaturalLanguage(message, "deny");
  assertStateStore(stateStore);
  const state = await loadRootState(stateStore);
  const lifecycle = permissionState(state);
  const entry = lifecycle.entries[sourceKey(source, accountId)];
  if (!entry || entry.review.id !== reviewId) {
    throw new PermissionLifecycleError("STALE_PERMISSION_REVIEW", "That permission review is no longer current, so I kept access denied.");
  }
  if (entry.status === "granted" || entry.status === "revoked") {
    throw new PermissionLifecycleError("PERMISSION_DECISION_FINAL", "That permission decision is already final. Start a new review to make a different choice.");
  }
  const now = isoNow(clock);
  entry.status = "denied";
  entry.audit.push({ type: "permission-denied", at: now, reviewId, contentBodiesRead: false });
  pushAudit(lifecycle, { type: "permission-denied", at: now, source, accountId, reviewId, contentBodiesRead: false });
  await stateStore.save(state);
  return {
    permissionReview: permissionReviewRenderer(entry, languageFor(state, language)),
    message: copy(languageFor(state, language)).denied
  };
}

export async function denySourcePermission(args) {
  assertPublicLifecycleSource(args?.source);
  return withSourcePermissionStateLock(args?.stateStore, () => denySourcePermissionInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function denySourcePermissionWithinStateLock(args) {
  assertPublicLifecycleSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => denySourcePermissionInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function denySpecializedSourcePermission(args) {
  assertSpecializedSlackSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => denySourcePermissionInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function denySpecializedWhatsAppPermission(args) {
  assertSpecializedWhatsAppSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => denySourcePermissionInternal({ ...args, permissionReviewRenderer: specializedWhatsAppPublicReview }));
}

/** Revokes local permission state only; it never writes to a connected source application. */
async function revokeSourcePermissionInternal({ message, stateStore, connector, source, accountId, reviewId, language, clock, permissionReviewRenderer = publicReview }) {
  assertNaturalLanguage(message, "revoke");
  assertStateStore(stateStore);
  if (!connector || typeof connector.revokePermissionGrant !== "function") {
    throw new TypeError("A simulated connector with revokePermissionGrant() is required to revoke a grant.");
  }
  const state = await loadRootState(stateStore);
  const lifecycle = permissionState(state);
  const entry = lifecycle.entries[sourceKey(source, accountId)];
  if (!entry || entry.review.id !== reviewId) {
    throw new PermissionLifecycleError("STALE_PERMISSION_REVIEW", "That permission review is no longer current, so I did not change access.");
  }
  const activeGrant = entry.grants.find((grant) => grant.status === "active");
  if (!activeGrant) {
    throw new PermissionLifecycleError("ACTIVE_GRANT_NOT_FOUND", "There is no active permission grant to revoke.");
  }
  const now = isoNow(clock);
  try {
    await connector.revokePermissionGrant({ grantId: activeGrant.id });
  } catch {
    throw new PermissionLifecycleError(
      "PERMISSION_REVOCATION_FAILED",
      "I could not confirm revocation with the simulated connector, so the existing permission remains unchanged and can be retried safely."
    );
  }
  activeGrant.status = "revoked";
  activeGrant.revokedAt = now;
  entry.status = "revoked";
  entry.audit.push({ type: "permission-revoked", at: now, reviewId, grantId: activeGrant.id });
  pushAudit(lifecycle, { type: "permission-revoked", at: now, source, accountId, reviewId, grantId: activeGrant.id });
  await stateStore.save(state);
  return {
    permissionReview: permissionReviewRenderer(entry, languageFor(state, language)),
    message: copy(languageFor(state, language)).revoked
  };
}

export async function revokeSourcePermission(args) {
  assertPublicLifecycleSource(args?.source);
  return withSourcePermissionStateLock(args?.stateStore, () => revokeSourcePermissionInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function revokeSourcePermissionWithinStateLock(args) {
  assertPublicLifecycleSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => revokeSourcePermissionInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function revokeSpecializedSourcePermission(args) {
  assertSpecializedSlackSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => revokeSourcePermissionInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function revokeSpecializedWhatsAppPermission(args) {
  assertSpecializedWhatsAppSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => revokeSourcePermissionInternal({ ...args, permissionReviewRenderer: specializedWhatsAppPublicReview }));
}

/**
 * Public Setup Session boundary for the first bounded content fetch. It sends
 * only a durable active grant to the adapter and returns opaque source refs;
 * it never returns raw source bodies to the conversation, proof, or tests.
 */
async function fetchApprovedSourceContentInternal({ message, stateStore, connector, source, accountId, reviewId, language, clock, permissionReviewRenderer = publicReview }) {
  assertNaturalLanguage(message, "fetch");
  assertStateStore(stateStore);
  assertConnector(connector);
  const state = await loadRootState(stateStore);
  const lifecycle = permissionState(state);
  const entry = lifecycle.entries[sourceKey(source, accountId)];
  if (!entry || entry.review.id !== reviewId) {
    throw new PermissionLifecycleError("STALE_PERMISSION_REVIEW", "That permission review is no longer current, so no source content was read.");
  }
  const grant = entry.grants.find((candidate) => candidate.status === "active");
  if (!grant || entry.status !== "granted") {
    throw new PermissionLifecycleError("ACTIVE_GRANT_REQUIRED", "No source content was read because there is no active permission grant for this reviewed scope.");
  }
  assertPersistedSourcePermissionGrantStillMatchesReview(grant, entry, clock);

  if (typeof connector.registerPermissionGrant !== "function") {
    throw new PermissionLifecycleError("PERMISSION_GRANT_RESTORE_FAILED", "I could not restore the saved read-only permission safely, so no source content was read.");
  }
  try {
    // Registration is idempotent. Reapplying the persisted active grant lets a
    // resumed simulated connector enforce the same durable, narrowed scope.
    await connector.registerPermissionGrant({ grant: clone(grant) });
  } catch {
    throw new PermissionLifecycleError("PERMISSION_GRANT_RESTORE_FAILED", "I could not restore the saved read-only permission safely, so no source content was read.");
  }

  const result = await connector.fetchApprovedContent({
    source,
    accountId,
    grant: clone(grant)
  });
  if (!result || result.rawBodiesReturned === true || !Array.isArray(result.records)) {
    throw new PermissionLifecycleError("CONNECTOR_BODY_BOUNDARY_INVALID", "The simulated connector did not preserve the safe source-body boundary, so I stopped before exposing any content.");
  }
  const approvedRecords = result.records.map((record) => {
    if (record?.source !== undefined && record.source !== source) {
      throw new PermissionLifecycleError("CONNECTOR_SOURCE_SUBSTITUTION", "The connector returned a record for a different source, so I stopped before exposing it.");
    }
    const mediaReferenceIds = record?.mediaReferenceIds;
    if (mediaReferenceIds !== undefined && (source !== "whatsapp" || !Array.isArray(mediaReferenceIds)
      || mediaReferenceIds.some((value) => typeof value !== "string" || !/^wa-media-[a-f0-9]{20}$/.test(value))
      || new Set(mediaReferenceIds).size !== mediaReferenceIds.length)) {
      throw new PermissionLifecycleError("CONNECTOR_MEDIA_BOUNDARY_INVALID", "The connector did not preserve the private media-reference boundary, so I stopped before exposing it.");
    }
    const sourceRecordId = String(record.sourceRecordId ?? record.id);
    if (source === "whatsapp" && !/^wa-message-[a-f0-9]{20}$/.test(sourceRecordId)) {
      throw new PermissionLifecycleError("CONNECTOR_RECORD_ALIAS_INVALID", "The WhatsApp connector returned a non-local message identifier, so I stopped before exposing it.");
    }
    return {
      sourceRecordId,
      processingDisposition: "untrusted-inert-reference",
      source: record.source ?? source,
      ...(mediaReferenceIds?.length ? { mediaReferenceIds: [...mediaReferenceIds] } : {})
    };
  });
  const contentBodiesRead = result.contentBodiesRead !== false;
  if (!contentBodiesRead && result.records.length > 0) {
    throw new PermissionLifecycleError("CONNECTOR_BODY_BOUNDARY_INVALID", "The simulated connector reported approved records without reading their source bodies, so I stopped before exposing any content.");
  }
  let fetchCheckpoint;
  if (source === "whatsapp") {
    const checkpoint = result.fetchCheckpoint;
    const allowedKeys = ["protocol", "planBinding", "index", "unitRef", "phase", "records", "receiptBinding"];
    const checkpointKeys = checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) ? Object.keys(checkpoint) : [];
    if (!checkpoint || checkpoint.protocol !== "qwave.whatsapp-snapshot-fetch-receipt/v1"
      || !/^wa-fetch-plan-[a-f0-9]{24}$/.test(checkpoint.planBinding)
      || !Number.isSafeInteger(checkpoint.index) || checkpoint.index < 0
      || !/^wa-(?:segment|media)-[a-f0-9]{20}$/.test(checkpoint.unitRef)
      || !["segment", "media"].includes(checkpoint.phase)
      || !/^wa-fetch-receipt-[a-f0-9]{24}$/.test(checkpoint.receiptBinding)
      || checkpointKeys.some((key) => !allowedKeys.includes(key))
      || JSON.stringify(checkpoint.records) !== JSON.stringify(result.records)) {
      throw new PermissionLifecycleError("CONNECTOR_FETCH_CHECKPOINT_INVALID", "The WhatsApp connector did not return an exact safe unit receipt, so I stopped before advancing its durable cursor.");
    }
    fetchCheckpoint = clone(checkpoint);
  }
  const now = isoNow(clock);
  if (contentBodiesRead) entry.bodyFetches += 1;
  if (source === "whatsapp") {
    // Persist only opaque aliases and the exact bounded-unit receipt. A
    // specialized local wrapper can resume an interrupted outer save without
    // re-reading a completed private source unit after restart.
    entry.lastApprovedFetch = {
      reviewId,
      grantId: grant.id,
      completedAt: now,
      records: clone(approvedRecords),
      fetchCheckpoint
    };
  }
  entry.audit.push({
    type: "approved-content-fetch",
    at: now,
    reviewId,
    grantId: grant.id,
    recordCount: result.records.length,
    contentBodiesRead,
    ...(fetchCheckpoint ? { unitRef: fetchCheckpoint.unitRef } : {})
  });
  pushAudit(lifecycle, {
    type: "approved-content-fetch",
    at: now,
    source,
    accountId,
    reviewId,
    grantId: grant.id,
    recordCount: result.records.length,
    contentBodiesRead,
    ...(fetchCheckpoint ? { unitRef: fetchCheckpoint.unitRef } : {})
  });
  await stateStore.save(state);

  return {
    permissionReview: permissionReviewRenderer(entry, languageFor(state, language)),
    approvedRecords,
    ...(fetchCheckpoint ? { fetchCheckpoint: clone(fetchCheckpoint) } : {})
  };
}

export async function fetchApprovedSourceContent(args) {
  assertPublicLifecycleSource(args?.source);
  return withSourcePermissionStateLock(args?.stateStore, () => fetchApprovedSourceContentInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function fetchApprovedSourceContentWithinStateLock(args) {
  assertPublicLifecycleSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => fetchApprovedSourceContentInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function fetchApprovedSpecializedSourceContent(args) {
  assertSpecializedSlackSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => fetchApprovedSourceContentInternal({ ...args, permissionReviewRenderer: publicReview }));
}

export async function fetchSpecializedWhatsAppContent(args) {
  assertSpecializedWhatsAppSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () => fetchApprovedSourceContentInternal({ ...args, permissionReviewRenderer: specializedWhatsAppPublicReview }));
}

function getSourcePermissionStatusFromStateInternal({
  state,
  source,
  accountId,
  language,
  permissionReviewRenderer = publicReview,
}) {
  if (!state?.[STATE_KEY]) return null;
  const entry = state[STATE_KEY].entries[sourceKey(source, accountId)];
  return entry
    ? { permissionReview: permissionReviewRenderer(entry, languageFor(state, language)) }
    : null;
}

/** Shared read-only primitive for public generic and Slack-specialized status views. */
async function getSourcePermissionStatusInternal({
  stateStore,
  source,
  accountId,
  language,
  permissionReviewRenderer = publicReview,
}) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  return getSourcePermissionStatusFromStateInternal({
    state,
    source,
    accountId,
    language,
    permissionReviewRenderer,
  });
}

/** Read-only public status boundary for non-Slack reviews, grants, and revocations. */
export async function getSourcePermissionStatus(args) {
  assertPublicLifecycleSource(args?.source);
  return getSourcePermissionStatusInternal({ ...args, permissionReviewRenderer: publicReview });
}

// Connector writer flows that already own the shared Setup Session write lock
// may need a fresh, local permission view while preserving one serialized
// lifecycle. This deliberately does not acquire a second lock and is not
// re-exported from src/index.mjs.
export async function getSourcePermissionStatusWithinStateLock(args) {
  assertPublicLifecycleSource(args?.source);
  return runWithinHeldSourcePermissionStateLock(args?.stateStore, () =>
    getSourcePermissionStatusInternal({ ...args, permissionReviewRenderer: publicReview })
  );
}

// Connector lifecycles that already hold the full Setup Session lock use this
// pure view to compose one truthful status from the exact root snapshot they
// loaded. It is intentionally not re-exported from src/index.mjs.
export function getSourcePermissionStatusFromState(args) {
  assertPublicLifecycleSource(args?.source);
  return getSourcePermissionStatusFromStateInternal({
    ...args,
    permissionReviewRenderer: publicReview,
  });
}

// Deliberately not re-exported from src/index.mjs. Slack owns the public
// status view so adapter identifiers cannot bypass its local opaque aliases.
export async function getSpecializedSourcePermissionStatus(args) {
  assertSpecializedSlackSource(args?.source);
  return getSourcePermissionStatusInternal({ ...args, permissionReviewRenderer: publicReview });
}

// Deliberately not re-exported from src/index.mjs. Slack uses this pure view to
// compose its public status from the exact same already-loaded root snapshot,
// avoiding a second read that could otherwise race a re-entrant revoke.
export function getSpecializedSourcePermissionStatusFromState(args) {
  assertSpecializedSlackSource(args?.source);
  return getSourcePermissionStatusFromStateInternal({
    ...args,
    permissionReviewRenderer: publicReview,
  });
}

// Deliberately not re-exported from src/index.mjs. The WhatsApp connector owns
// its public status surface so raw local snapshot aliases and generalized
// permission endpoints cannot bypass its private lifecycle boundary.
export async function getSpecializedWhatsAppPermissionStatus(args) {
  assertSpecializedWhatsAppSource(args?.source);
  return getSourcePermissionStatusInternal({
    ...args,
    permissionReviewRenderer: specializedWhatsAppPublicReview,
  });
}

// This pure variant lets the WhatsApp connector compose its status from the
// exact root snapshot already loaded under its shared lock. It must not save,
// reconcile, create an adapter, or take a second state snapshot.
export function getSpecializedWhatsAppPermissionStatusFromState(args) {
  assertSpecializedWhatsAppSource(args?.source);
  return getSourcePermissionStatusFromStateInternal({
    ...args,
    permissionReviewRenderer: specializedWhatsAppPublicReview,
  });
}
