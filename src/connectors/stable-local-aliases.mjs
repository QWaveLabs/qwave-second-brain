import { randomUUID } from "node:crypto";

const IDENTIFIER_KINDS = new Set(["account", "review", "grant", "reference", "generation"]);
const REFERENCE_ARRAY_KEYS = new Set([
  "authorizedFolderIds",
  "blockedGroupConversationExceptions",
  "channels",
  "conversations",
  "folderIds",
  "folders",
  "participantIds",
  "people",
  "referenceIds",
  "selectedItemIds",
  "unknownParticipantIds"
]);
const REFERENCE_SCALAR_KEYS = new Set([
  "channelId",
  "conversationId",
  "folderId",
  "itemId",
  "participantId",
  "personId",
  "snapshotRecordId",
  "sourceRecordId",
  "stableDriveId"
]);
const GENERATION_SCALAR_KEYS = new Set([
  "generationId",
  "operationId",
  "pageGenerationId"
]);
const UUID_SUFFIX = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export class StableLocalAliasError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StableLocalAliasError";
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function assertNamespace(namespace) {
  if (typeof namespace !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) {
    throw new TypeError("A short local alias namespace is required.");
  }
}

function assertKind(kind) {
  if (!IDENTIFIER_KINDS.has(kind)) throw new TypeError("A supported local identifier kind is required.");
}

function assertRawIdentifier(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new StableLocalAliasError(
      "LOCAL_IDENTIFIER_INVALID",
      "I could not create a safe local source reference, so I stopped before exposing an adapter identifier."
    );
  }
  return value;
}

export function isStableLocalAlias(namespace, kind, value) {
  try {
    assertNamespace(namespace);
    assertKind(kind);
  } catch {
    return false;
  }
  return typeof value === "string"
    && new RegExp(`^local-${namespace}-${kind}-${UUID_SUFFIX}$`).test(value);
}

function assertAliasMappings(state, namespace) {
  const seenRaw = new Set();
  const seenAliases = new Set();
  for (const mapping of state.mappings) {
    const valid = mapping
      && typeof mapping === "object"
      && IDENTIFIER_KINDS.has(mapping.kind)
      && typeof mapping.raw === "string"
      && mapping.raw.length > 0
      && isStableLocalAlias(namespace, mapping.kind, mapping.alias)
      && mapping.alias !== mapping.raw;
    const rawKey = valid ? `${mapping.kind}\u0000${mapping.raw}` : null;
    if (!valid || seenRaw.has(rawKey) || seenAliases.has(mapping.alias)) {
      throw new StableLocalAliasError(
        "LOCAL_ALIAS_STATE_INVALID",
        "The saved local source-reference map is invalid, so I stopped before exposing or resolving an adapter identifier."
      );
    }
    seenRaw.add(rawKey);
    seenAliases.add(mapping.alias);
  }
}

function persistedAliasState(entry, namespace) {
  assertNamespace(namespace);
  if (!entry || typeof entry !== "object") throw new TypeError("A persisted connector entry is required.");
  const existing = entry.publicIdentifierAliases;
  if (
    !existing
    || typeof existing !== "object"
    || existing.version !== 1
    || existing.namespace !== namespace
    || !Array.isArray(existing.mappings)
  ) {
    throw new StableLocalAliasError(
      "LOCAL_ALIAS_STATE_INVALID",
      "The saved local source-reference map is invalid, so I stopped before exposing or resolving an adapter identifier."
    );
  }
  assertAliasMappings(existing, namespace);
  return existing;
}

function aliasState(entry, namespace) {
  assertNamespace(namespace);
  if (!entry || typeof entry !== "object") throw new TypeError("A persisted connector entry is required.");
  const existing = entry.publicIdentifierAliases;
  if (existing === undefined || existing === null) {
    entry.publicIdentifierAliases = { version: 1, namespace, mappings: [] };
  }
  return persistedAliasState(entry, namespace);
}

/**
 * Validates the complete persisted alias map for every entry in one connector
 * lifecycle, then removes every participant in an account-id or public-alias
 * collision. This is intentionally read-only: malformed state is never
 * repaired by guessing and a collision never becomes first/last-match wins.
 */
export function validStableLocalAliasLifecycleEntries(entries, namespace) {
  assertNamespace(namespace);
  const participants = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const participant = {
      entry,
      accountId: typeof entry?.accountId === "string" && entry.accountId.trim()
        ? entry.accountId
        : null,
      claimedAliases: new Set(),
      accountAlias: null,
      valid: false
    };
    for (const mapping of Array.isArray(entry?.publicIdentifierAliases?.mappings)
      ? entry.publicIdentifierAliases.mappings
      : []) {
      for (const kind of IDENTIFIER_KINDS) {
        if (isStableLocalAlias(namespace, kind, mapping?.alias)) {
          participant.claimedAliases.add(mapping.alias);
          break;
        }
      }
    }
    try {
      const accountId = assertRawIdentifier(entry?.accountId);
      const state = persistedAliasState(entry, namespace);
      const accountMappings = state.mappings.filter((mapping) => mapping.kind === "account");
      if (accountMappings.length !== 1 || accountMappings[0].raw !== accountId) {
        throw new StableLocalAliasError(
          "LOCAL_ALIAS_STATE_INVALID",
          "The saved local source-reference map is invalid, so I stopped before exposing or resolving an adapter identifier."
        );
      }
      participant.accountId = accountId;
      participant.accountAlias = accountMappings[0].alias;
      participant.valid = true;
    } catch {
      // A malformed participant is omitted. Other valid, non-colliding
      // entries in the lifecycle remain independently usable.
    }
    participants.push(participant);
  }

  const participantsByIdentifier = new Map();
  for (const participant of participants) {
    if (participant.accountId) {
      const identifierParticipants = participantsByIdentifier.get(participant.accountId) ?? [];
      identifierParticipants.push(participant);
      participantsByIdentifier.set(participant.accountId, identifierParticipants);
    }
    for (const alias of participant.claimedAliases) {
      const identifierParticipants = participantsByIdentifier.get(alias) ?? [];
      identifierParticipants.push(participant);
      participantsByIdentifier.set(alias, identifierParticipants);
    }
  }

  const invalid = new Set();
  for (const collidingParticipants of participantsByIdentifier.values()) {
    if (collidingParticipants.length > 1) {
      collidingParticipants.forEach((participant) => invalid.add(participant));
    }
  }
  return participants
    .filter((participant) => participant.valid && !invalid.has(participant))
    .map(({ entry, accountAlias }) => ({ entry, accountAlias }));
}

function newAlias(state, namespace, kind) {
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const candidate = `local-${namespace}-${kind}-${randomUUID()}`;
    if (!state.mappings.some((mapping) => mapping.alias === candidate)) return candidate;
  }
  throw new StableLocalAliasError(
    "LOCAL_ALIAS_UNAVAILABLE",
    "I could not create a safe local source reference, so I stopped before exposing an adapter identifier."
  );
}

export function registerStableLocalAlias(entry, namespace, kind, rawValue) {
  assertKind(kind);
  const raw = assertRawIdentifier(rawValue);
  const state = aliasState(entry, namespace);
  const existing = state.mappings.find((mapping) => mapping.kind === kind && mapping.raw === raw);
  if (existing) return existing.alias;
  const alias = newAlias(state, namespace, kind);
  state.mappings.push({ kind, raw, alias });
  return alias;
}

export function getStableLocalAlias(entry, namespace, kind, rawValue) {
  assertKind(kind);
  const raw = assertRawIdentifier(rawValue);
  const mapping = aliasState(entry, namespace).mappings
    .find((candidate) => candidate.kind === kind && candidate.raw === raw);
  if (!mapping) {
    throw new StableLocalAliasError(
      "LOCAL_ALIAS_NOT_REGISTERED",
      "I stopped before exposing an adapter identifier that does not have a saved local reference. Retry the guided source step."
    );
  }
  return mapping.alias;
}

export function getRawIdentifierForAlias(entry, namespace, kind, aliasValue) {
  assertKind(kind);
  const alias = assertRawIdentifier(aliasValue);
  const mapping = aliasState(entry, namespace).mappings
    .find((candidate) => candidate.kind === kind && candidate.alias === alias);
  if (!mapping) {
    throw new StableLocalAliasError(
      "LOCAL_ALIAS_NOT_FOUND",
      "That local source reference is not current, so I kept source access denied. Continue from the latest guided review."
    );
  }
  return mapping.raw;
}

export function registerStableAccountAlias(entry, namespace, rawAccountId) {
  return registerStableLocalAlias(entry, namespace, "account", rawAccountId);
}

export function stableAccountAlias(entry, namespace, rawAccountId = entry?.accountId) {
  return getStableLocalAlias(entry, namespace, "account", rawAccountId);
}

function scopeReferenceValues(scope) {
  if (!scope || typeof scope !== "object") return [];
  return [
    ...scope.folders ?? [],
    ...scope.channels ?? [],
    ...scope.conversations ?? [],
    ...scope.blockedGroupConversationExceptions ?? [],
    ...scope.people?.allowed ?? [],
    ...scope.people?.restricted ?? [],
    ...scope.people?.blocked ?? [],
    ...scope.exclusions?.folders ?? [],
    ...scope.exclusions?.channels ?? [],
    ...scope.exclusions?.people ?? [],
    ...scope.exclusions?.conversations ?? []
  ].filter((value) => typeof value === "string" && value);
}

function registerAuditAliases(entry, namespace, audit) {
  const visit = (value, key = null) => {
    if (typeof value === "string") {
      if (key === "accountId") registerStableLocalAlias(entry, namespace, "account", value);
      else if (key === "reviewId") registerStableLocalAlias(entry, namespace, "review", value);
      else if (key === "grantId") registerStableLocalAlias(entry, namespace, "grant", value);
      else if (REFERENCE_SCALAR_KEYS.has(key)) registerStableLocalAlias(entry, namespace, "reference", value);
      else if (GENERATION_SCALAR_KEYS.has(key)) registerStableLocalAlias(entry, namespace, "generation", value);
      return;
    }
    if (Array.isArray(value)) {
      if (REFERENCE_ARRAY_KEYS.has(key)) {
        value.forEach((candidate) => {
          if (typeof candidate === "string" && candidate) registerStableLocalAlias(entry, namespace, "reference", candidate);
        });
        return;
      }
      value.forEach((candidate) => visit(candidate));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (key === "scope" || key === "requestedScope") {
      scopeReferenceValues(value).forEach((candidate) => registerStableLocalAlias(entry, namespace, "reference", candidate));
      if (typeof value.accountId === "string") registerStableLocalAlias(entry, namespace, "account", value.accountId);
    }
    Object.entries(value).forEach(([nestedKey, nested]) => visit(nested, nestedKey));
  };
  visit(audit);
}

export function registerPermissionReviewAliases(entry, namespace, permissionReview) {
  if (!permissionReview || typeof permissionReview !== "object") return;
  for (const accountId of [
    permissionReview.account?.id,
    permissionReview.permissionRequest?.account?.id,
    permissionReview.permissionRequest?.requestedScope?.accountId,
    permissionReview.activeGrant?.scope?.accountId
  ]) {
    if (typeof accountId === "string" && accountId) registerStableLocalAlias(entry, namespace, "account", accountId);
  }
  for (const reviewId of [permissionReview.permissionRequest?.reviewId, permissionReview.activeGrant?.reviewId]) {
    if (typeof reviewId === "string" && reviewId) registerStableLocalAlias(entry, namespace, "review", reviewId);
  }
  if (typeof permissionReview.activeGrant?.grantId === "string" && permissionReview.activeGrant.grantId) {
    registerStableLocalAlias(entry, namespace, "grant", permissionReview.activeGrant.grantId);
  }
  for (const scope of [permissionReview.permissionRequest?.requestedScope, permissionReview.activeGrant?.scope]) {
    scopeReferenceValues(scope).forEach((candidate) => registerStableLocalAlias(entry, namespace, "reference", candidate));
  }
  for (const conversation of permissionReview.metadataPreflight?.blockedGroupConversations ?? []) {
    if (typeof conversation?.id === "string" && conversation.id) {
      registerStableLocalAlias(entry, namespace, "reference", conversation.id);
    }
  }
  registerAuditAliases(entry, namespace, permissionReview.audit);
}

export function registerApprovedReferenceAliases(entry, namespace, records) {
  for (const record of Array.isArray(records) ? records : []) {
    for (const candidate of [
      record?.sourceRecordId,
      record?.snapshotRecordId,
      record?.stableDriveId,
      record?.folderId
    ]) {
      if (typeof candidate === "string" && candidate) {
        registerStableLocalAlias(entry, namespace, "reference", candidate);
      }
    }
  }
}

/**
 * Durably upgrades a valid connector entry created before local public aliases
 * existed. The migration is prepared on a clone so a malformed legacy value
 * cannot leave a partially populated alias map that a later save might expose.
 * Callers still own the shared root lock and the single root-state save.
 */
export function migrateStableLocalAliases(entry, namespace, {
  permissionReview = null,
  approvedRecords = []
} = {}) {
  if (!entry || typeof entry !== "object") throw new TypeError("A persisted connector entry is required.");
  const before = JSON.stringify(entry.publicIdentifierAliases ?? null);
  const migrated = clone(entry);
  if (typeof migrated.accountId === "string" && migrated.accountId) {
    registerStableAccountAlias(migrated, namespace, migrated.accountId);
  }
  if (typeof migrated.reviewId === "string" && migrated.reviewId) {
    registerStableLocalAlias(migrated, namespace, "review", migrated.reviewId);
  }
  registerAuditAliases(migrated, namespace, migrated);
  registerPermissionReviewAliases(migrated, namespace, permissionReview);
  registerApprovedReferenceAliases(migrated, namespace, approvedRecords);
  const after = JSON.stringify(migrated.publicIdentifierAliases ?? null);
  if (before === after) return false;
  entry.publicIdentifierAliases = migrated.publicIdentifierAliases;
  return true;
}

function projectReferenceArray(entry, namespace, values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => getStableLocalAlias(entry, namespace, "reference", value));
}

function projectScope(entry, namespace, scope) {
  if (!scope || typeof scope !== "object") return clone(scope);
  const projected = clone(scope);
  if (typeof projected.accountId === "string") {
    projected.accountId = getStableLocalAlias(entry, namespace, "account", projected.accountId);
  }
  for (const key of ["folders", "channels", "conversations", "blockedGroupConversationExceptions"]) {
    if (Array.isArray(projected[key])) projected[key] = projectReferenceArray(entry, namespace, projected[key]);
  }
  if (projected.people && typeof projected.people === "object") {
    for (const key of ["allowed", "restricted", "blocked"]) {
      if (Array.isArray(projected.people[key])) projected.people[key] = projectReferenceArray(entry, namespace, projected.people[key]);
    }
  }
  if (projected.exclusions && typeof projected.exclusions === "object") {
    if (Array.isArray(projected.exclusions.accounts)) {
      projected.exclusions.accounts = projected.exclusions.accounts.map((value) => (
        getStableLocalAlias(entry, namespace, "account", value)
      ));
    }
    for (const key of ["folders", "channels", "people", "conversations"]) {
      if (Array.isArray(projected.exclusions[key])) {
        projected.exclusions[key] = projectReferenceArray(entry, namespace, projected.exclusions[key]);
      }
    }
  }
  return projected;
}

function projectAuditValue(entry, namespace, value, key = null) {
  if (typeof value === "string") {
    if (key === "accountId") return getStableLocalAlias(entry, namespace, "account", value);
    if (key === "reviewId") return getStableLocalAlias(entry, namespace, "review", value);
    if (key === "grantId") return getStableLocalAlias(entry, namespace, "grant", value);
    if (REFERENCE_SCALAR_KEYS.has(key)) return getStableLocalAlias(entry, namespace, "reference", value);
    if (GENERATION_SCALAR_KEYS.has(key)) return getStableLocalAlias(entry, namespace, "generation", value);
    return value;
  }
  if (Array.isArray(value)) {
    if (REFERENCE_ARRAY_KEYS.has(key)) return projectReferenceArray(entry, namespace, value);
    return value.map((candidate) => projectAuditValue(entry, namespace, candidate));
  }
  if (!value || typeof value !== "object") return value;
  if (key === "scope" || key === "requestedScope") return projectScope(entry, namespace, value);
  return Object.fromEntries(Object.entries(value)
    .map(([nestedKey, nested]) => [nestedKey, projectAuditValue(entry, namespace, nested, nestedKey)]));
}

export function projectAuditWithStableAliases(entry, namespace, audit) {
  return projectAuditValue(entry, namespace, Array.isArray(audit) ? audit : []);
}

export function projectPermissionReviewWithStableAliases(entry, namespace, permissionReview) {
  if (!permissionReview) return null;
  const projected = clone(permissionReview);
  if (projected.account?.id) {
    projected.account.id = getStableLocalAlias(entry, namespace, "account", projected.account.id);
  }
  if (projected.permissionRequest) {
    if (projected.permissionRequest.reviewId) {
      projected.permissionRequest.reviewId = getStableLocalAlias(entry, namespace, "review", projected.permissionRequest.reviewId);
    }
    if (projected.permissionRequest.account?.id) {
      projected.permissionRequest.account.id = getStableLocalAlias(entry, namespace, "account", projected.permissionRequest.account.id);
    }
    projected.permissionRequest.requestedScope = projectScope(entry, namespace, projected.permissionRequest.requestedScope);
  }
  if (projected.metadataPreflight?.blockedGroupConversations) {
    projected.metadataPreflight.blockedGroupConversations = projected.metadataPreflight.blockedGroupConversations.map((conversation) => ({
      ...conversation,
      id: getStableLocalAlias(entry, namespace, "reference", conversation.id)
    }));
  }
  if (projected.activeGrant) {
    projected.activeGrant.grantId = getStableLocalAlias(entry, namespace, "grant", projected.activeGrant.grantId);
    projected.activeGrant.reviewId = getStableLocalAlias(entry, namespace, "review", projected.activeGrant.reviewId);
    projected.activeGrant.scope = projectScope(entry, namespace, projected.activeGrant.scope);
  }
  projected.audit = projectAuditWithStableAliases(entry, namespace, projected.audit);
  return projected;
}

function rawReferenceArray(entry, namespace, values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => getRawIdentifierForAlias(entry, namespace, "reference", value));
}

export function internalPermissionScopeFromStableAliases(entry, namespace, scope) {
  if (!scope || typeof scope !== "object") return clone(scope);
  const internal = clone(scope);
  internal.accountId = getRawIdentifierForAlias(entry, namespace, "account", internal.accountId);
  for (const key of ["folders", "channels", "conversations", "blockedGroupConversationExceptions"]) {
    if (Array.isArray(internal[key])) internal[key] = rawReferenceArray(entry, namespace, internal[key]);
  }
  if (internal.people && typeof internal.people === "object") {
    for (const key of ["allowed", "restricted", "blocked"]) {
      if (Array.isArray(internal.people[key])) internal.people[key] = rawReferenceArray(entry, namespace, internal.people[key]);
    }
  }
  if (internal.exclusions && typeof internal.exclusions === "object") {
    if (Array.isArray(internal.exclusions.accounts)) {
      internal.exclusions.accounts = internal.exclusions.accounts.map((value) => (
        getRawIdentifierForAlias(entry, namespace, "account", value)
      ));
    }
    for (const key of ["folders", "channels", "people", "conversations"]) {
      if (Array.isArray(internal.exclusions[key])) {
        internal.exclusions[key] = rawReferenceArray(entry, namespace, internal.exclusions[key]);
      }
    }
  }
  return internal;
}

export function projectApprovedReferencesWithStableAliases(entry, namespace, records, { removeStableLink = false } = {}) {
  return (Array.isArray(records) ? records : []).map((record) => {
    const projected = clone(record);
    if (typeof projected.accountId === "string") {
      projected.accountId = getStableLocalAlias(entry, namespace, "account", projected.accountId);
    }
    for (const key of ["sourceRecordId", "snapshotRecordId", "stableDriveId", "folderId"]) {
      if (typeof projected[key] === "string") {
        projected[key] = getStableLocalAlias(entry, namespace, "reference", projected[key]);
      }
    }
    if (removeStableLink && Object.hasOwn(projected, "stableLink")) projected.stableLink = null;
    return projected;
  });
}
