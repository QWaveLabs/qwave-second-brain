/**
 * QWA-139 simulated, deny-by-default source permission lifecycle.
 *
 * This module is deliberately an additive public Setup Session extension. It
 * uses the same durable stateStore as QWA-138 but does not change the completed
 * bootstrap/vault state machine. Real OAuth, source accounts, source bodies,
 * and source writes are out of scope: callers inject a read-only simulated
 * connector contract.
 */

import { randomUUID } from "node:crypto";

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

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort();
}

function normalizedAccessLevel(value) {
  return ACCESS_LEVELS.has(value) ? value : "allowed";
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
    return {
      id: item.id.trim(),
      kind: item.kind === "conversation" ? "conversation" : "item",
      area: typeof item.area === "string" ? item.area : null,
      folder: typeof item.folder === "string" ? item.folder : null,
      channel: typeof item.channel === "string" ? item.channel : null,
      conversation: typeof item.conversation === "string" ? item.conversation : null,
      category: typeof item.category === "string" ? item.category : "general",
      sensitiveCategories: uniqueStrings([
        ...item.sensitiveCategories ?? [],
        ...(item.uncertainSensitivity === true ? ["uncertain-sensitivity"] : [])
      ]).filter((category) => SENSITIVE_CATEGORIES.includes(category)),
      isGroup: item.isGroup === true,
      participantIds: uniqueStrings(item.participantIds),
      label: redactUntrustedLabel(item.label ?? item.title)
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

  const sensitiveAllowed = metadata.sensitiveGroups.map((group) => group.category);
  const includedSensitive = assertSubset(requested.sensitiveGroups?.included, sensitiveAllowed, "sensitive categories");
  const excludedSensitive = assertSubset(requested.sensitiveGroups?.excluded, sensitiveAllowed, "sensitive categories");
  const effectiveIncludedSensitive = includedSensitive.filter((category) => !excludedSensitive.includes(category));
  const selectedCategories = assertSubset(requested.categories, metadata.categories, "categories");
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

  const scope = {
    accountId: metadata.account.id,
    areas: applyExclusions(assertSubset(requested.areas, metadata.areas, "areas"), exclusions.areas),
    folders: applyExclusions(assertSubset(requested.folders, metadata.folders, "folders"), exclusions.folders),
    channels: applyExclusions(assertSubset(requested.channels, metadata.channels, "channels"), exclusions.channels),
    conversations: finalConversations,
    categories: finalCategories,
    people: {
      allowed: applyExclusions(allowedPeople, exclusions.people),
      // These two lists are persisted as privacy boundaries, never content allowlists.
      restricted: uniqueStrings([...restrictedPeople, ...metadata.people.filter((person) => person.accessLevel === "restricted").map((person) => person.id)]),
      blocked: uniqueStrings([...blockedPeople, ...metadata.people.filter((person) => person.accessLevel === "blocked").map((person) => person.id)])
    },
    exclusions: {
      accounts: uniqueStrings(exclusions.accounts),
      areas: uniqueStrings(exclusions.areas),
      folders: uniqueStrings(exclusions.folders),
      channels: uniqueStrings(exclusions.channels),
      people: uniqueStrings([...exclusions.people ?? [], ...requested.people?.restricted ?? [], ...requested.people?.blocked ?? [], ...metadata.people.filter((person) => person.accessLevel !== "allowed").map((person) => person.id), ...metadata.unknownParticipantIds]),
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

function assertPersistedGrantStillMatchesReview(grant, entry, clock) {
  if (!grant?.disclosuresAcknowledged?.modelProcessing?.acknowledged || !grant?.disclosuresAcknowledged?.untrustedSourceMaterial?.acknowledged) {
    throw new PermissionLifecycleError(
      "PERSISTED_GRANT_INVALID",
      "The saved permission no longer includes the required privacy acknowledgements, so no source content was read. Start a new review."
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
export async function beginSourcePermissionReview({
  message,
  stateStore,
  connector,
  source,
  language,
  clock,
  reviewIdFactory
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
    return { permissionReview: publicReview(previousEntry, languageFor(state, language)) };
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
  return { permissionReview: publicReview(entry, languageFor(state, language)) };
}

/**
 * Public Setup Session boundary: records one granular immutable grant. A stale
 * review cannot be used after denial or revocation, and a second matching call
 * returns the existing grant rather than widening or duplicating access.
 */
export async function grantSourcePermission({
  message,
  stateStore,
  connector,
  source,
  accountId,
  reviewId,
  scope,
  language,
  clock,
  grantIdFactory
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
  const normalized = normalizedScope(scope, entry.review, entry.sourceKind, now);
  const existing = entry.grants.find((grant) => grant.status === "active");
  if (existing) {
    if (JSON.stringify(existing.scope) !== JSON.stringify(normalized)) {
      throw new PermissionLifecycleError("SCOPE_CHANGE_REQUIRES_NEW_REVIEW", "This would change an approved scope. Start a new review so the change is visible before access is granted.");
    }
    return { permissionReview: publicReview(entry, languageFor(state, language)) };
  }

  const wording = copy(languageFor(state, language));
  const grant = {
    id: (grantIdFactory ?? defaultGrantId)(),
    reviewId,
    source,
    accountId,
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
  return { permissionReview: publicReview(entry, languageFor(state, language)) };
}

/** Records an explicit denial without treating it as an error or allowing stale approval UI to revive it. */
export async function denySourcePermission({ message, stateStore, source, accountId, reviewId, language, clock }) {
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
    permissionReview: publicReview(entry, languageFor(state, language)),
    message: copy(languageFor(state, language)).denied
  };
}

/** Revokes local permission state only; it never writes to a connected source application. */
export async function revokeSourcePermission({ message, stateStore, connector, source, accountId, reviewId, language, clock }) {
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
    permissionReview: publicReview(entry, languageFor(state, language)),
    message: copy(languageFor(state, language)).revoked
  };
}

/**
 * Public Setup Session boundary for the first bounded content fetch. It sends
 * only a durable active grant to the adapter and returns opaque source refs;
 * it never returns raw source bodies to the conversation, proof, or tests.
 */
export async function fetchApprovedSourceContent({ message, stateStore, connector, source, accountId, reviewId, language, clock }) {
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
  assertPersistedGrantStillMatchesReview(grant, entry, clock);

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
  const now = isoNow(clock);
  entry.bodyFetches += 1;
  entry.audit.push({ type: "approved-content-fetch", at: now, reviewId, grantId: grant.id, recordCount: result.records.length });
  pushAudit(lifecycle, { type: "approved-content-fetch", at: now, source, accountId, reviewId, grantId: grant.id, recordCount: result.records.length });
  await stateStore.save(state);

  return {
    permissionReview: publicReview(entry, languageFor(state, language)),
    approvedRecords: result.records.map((record) => ({
      sourceRecordId: String(record.sourceRecordId ?? record.id),
      processingDisposition: "untrusted-inert-reference",
      source: record.source ?? source
    }))
  };
}

/** Read-only public status boundary for reviews, grants, and revocations. */
export async function getSourcePermissionStatus({ stateStore, source, accountId, language }) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state?.[STATE_KEY]) return null;
  const entry = state[STATE_KEY].entries[sourceKey(source, accountId)];
  return entry ? { permissionReview: publicReview(entry, languageFor(state, language)) } : null;
}
