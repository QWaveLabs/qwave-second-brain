import { SENSITIVE_CATEGORIES } from "./setup-source-permissions.mjs";

/**
 * Test-only read-only connector for QWA-139. It holds opaque source records and
 * exposes metadata first. It never returns a raw body, even after a permitted
 * fetch, so test/proof output cannot leak fixture content or secrets.
 */

function clone(value) {
  return structuredClone(value);
}

function inList(value, list) {
  return value == null || list.includes(value);
}

function recordFitsScope(record, scope) {
  if (record.timestamp) {
    const timestamp = Date.parse(record.timestamp);
    if (!Number.isFinite(timestamp)) return false;
    if (scope.dateRange.kind !== "selected-folders-only") {
      if (timestamp < Date.parse(scope.dateRange.from) || timestamp > Date.parse(scope.dateRange.to)) return false;
      if (scope.exclusions.dateRanges.some((range) => timestamp >= Date.parse(range.from) && timestamp <= Date.parse(range.to))) return false;
    }
  }
  if (!inList(record.area, scope.areas)) return false;
  if (!inList(record.folder, scope.folders)) return false;
  if (!inList(record.channel, scope.channels)) return false;
  const conversationId = record.kind === "conversation" ? record.id : (record.conversation ?? null);
  if (!inList(conversationId, scope.conversations)) return false;
  if (!inList(record.category, scope.categories)) return false;
  if (record.participantIds != null && !Array.isArray(record.participantIds)) return false;
  const participants = record.participantIds ?? [];
  const allowedPeople = new Set(scope.people?.allowed ?? []);
  const blockedPeople = new Set(scope.people?.blocked ?? []);
  const isExplicitBlockedGroupException = record.kind === "conversation"
    && record.isGroup === true
    && scope.blockedGroupConversationExceptions.includes(record.id);
  const excludedParticipants = participants.filter((id) => scope.exclusions.people.includes(id));
  if (isExplicitBlockedGroupException) {
    // A narrow group exception can bypass only the explicitly Blocked member;
    // a Restricted participant remains a hard content exclusion.
    if (participants.some((id) => !allowedPeople.has(id) && !blockedPeople.has(id))) return false;
    if (excludedParticipants.some((id) => !blockedPeople.has(id))) return false;
  } else if (excludedParticipants.length > 0 || participants.some((id) => !allowedPeople.has(id))) {
    return false;
  }
  const declaredSensitive = record.sensitiveCategories == null
    ? []
    : Array.isArray(record.sensitiveCategories)
      ? record.sensitiveCategories
      : [record.sensitiveCategories];
  const knownSensitive = declaredSensitive
    .filter((category) => typeof category === "string" && category.trim() && SENSITIVE_CATEGORIES.includes(category.trim()))
    .map((category) => category.trim());
  // Keep the simulated fetch path aligned with metadata normalization: an
  // unknown or malformed sensitivity declaration is uncertainty, not approval.
  const hasUnknownSensitivity = declaredSensitive.some((category) => (
    typeof category !== "string"
    || !category.trim()
    || !SENSITIVE_CATEGORIES.includes(category.trim())
  ));
  const hasMalformedUncertaintyMarker = record.uncertainSensitivity !== undefined
    && typeof record.uncertainSensitivity !== "boolean";
  const sensitiveCategories = [
    ...knownSensitive,
    ...(record.uncertainSensitivity === true || hasUnknownSensitivity || hasMalformedUncertaintyMarker
      ? ["uncertain-sensitivity"]
      : [])
  ];
  if (sensitiveCategories.some((category) => (
    scope.sensitiveGroups.excluded.includes(category)
    || !scope.sensitiveGroups.included.includes(category)
  ))) return false;
  return true;
}

export class SimulatedReadOnlyConnector {
  constructor({ source = "gmail", account = { id: "simulated-account", label: "Simulated account" }, items = [], people = [], failuresBeforeGrantRegistration = 0 } = {}) {
    this.source = source;
    this.account = clone(account);
    this.items = clone(items);
    this.people = clone(people);
    this.metadataPreflightCalls = 0;
    this.bodyFetchCalls = 0;
    this.bodyAccesses = 0;
    this.writeCalls = 0;
    this.grantsSeen = [];
    this.authorizedGrantIds = new Set();
    this.grantRegistrationCalls = 0;
    this.grantRevocationCalls = 0;
    this.failuresBeforeGrantRegistration = failuresBeforeGrantRegistration;
  }

  async discoverMetadata({ source }) {
    if (source !== this.source) throw new Error("Simulated connector source mismatch.");
    this.metadataPreflightCalls += 1;
    return {
      source: this.source,
      account: clone(this.account),
      readOnly: true,
      people: this.people.map(({ id, label, name, accessLevel }) => ({ id, label, name, accessLevel })),
      items: this.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        area: item.area,
        folder: item.folder,
        channel: item.channel,
        conversation: item.conversation,
        timestamp: item.timestamp,
        category: item.category,
        sensitiveCategories: item.sensitiveCategories,
        uncertainSensitivity: item.uncertainSensitivity,
        isGroup: item.isGroup,
        participantIds: item.participantIds,
        label: item.label,
        stableLink: item.stableLink,
        webUrl: item.webUrl,
        url: item.url
      }))
    };
  }

  async fetchApprovedContent({ source, accountId, grant }) {
    this.bodyFetchCalls += 1;
    if (source !== this.source || accountId !== this.account.id || grant?.status !== "active" || grant?.scope?.accountId !== this.account.id || !this.authorizedGrantIds.has(grant?.id)) {
      throw new Error("Simulated connector refused a fetch without a matching active read-only grant.");
    }
    this.grantsSeen.push(clone(grant));
    this.bodyAccesses += 1;
    return {
      rawBodiesReturned: false,
      records: this.items
        .filter((item) => recordFitsScope(item, grant.scope))
        .map((item) => ({ sourceRecordId: item.id, source: this.source }))
    };
  }

  async registerPermissionGrant({ grant }) {
    this.grantRegistrationCalls += 1;
    if (this.failuresBeforeGrantRegistration > 0) {
      this.failuresBeforeGrantRegistration -= 1;
      throw new Error("Simulated grant registration failed before activation.");
    }
    if (grant?.source !== this.source || grant?.accountId !== this.account.id || grant?.status !== "active" || !grant?.id) {
      throw new Error("Simulated connector refused to register an invalid grant.");
    }
    this.authorizedGrantIds.add(grant.id);
  }

  async revokePermissionGrant({ grantId }) {
    this.grantRevocationCalls += 1;
    this.authorizedGrantIds.delete(grantId);
  }
}
