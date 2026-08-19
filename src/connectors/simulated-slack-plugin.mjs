/**
 * Controlled Slack official-plugin seam for QWA-148.
 *
 * This adapter is intentionally offline and simulation-only. It accepts
 * fixture metadata, never retains or returns a message body, and deliberately
 * has no post, react, edit, archive, invite, or workspace-setting operation.
 * Its observable counters let the public Setup Session prove ordering without
 * touching a Slack workspace.
 */

import { SimulatedReadOnlyConnector } from "../permissions/simulated-connector.mjs";
import { SENSITIVE_CATEGORIES } from "../permissions/setup-source-permissions.mjs";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const AUTHORIZATION_STATES = new Set(["authorized", "denied", "unavailable", "revoked"]);
const PAGINATION_STATES = new Set(["complete", "incomplete"]);
const CONVERSATION_AREAS = new Set(["channels", "direct-messages", "group-messages"]);
const KNOWN_SENSITIVE_CATEGORIES = new Set(SENSITIVE_CATEGORIES);

export class SlackPluginError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "SlackPluginError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

function clone(value) {
  return structuredClone(value);
}

function safeOpaqueId(value, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new TypeError(`${field} must be an opaque Slack identifier.`);
  }
  return value;
}

function normalizePerson(person) {
  if (!person || typeof person !== "object") {
    throw new TypeError("A Slack metadata person is required.");
  }
  const id = safeOpaqueId(person.id, "Slack person id");
  if (!["allowed", "restricted", "blocked"].includes(person.accessLevel)) {
    throw new TypeError("A Slack person must have an explicit allowed, restricted, or blocked access level.");
  }
  // Never carry an untrusted workspace display name into public state. The
  // permission engine needs only an opaque, stable person boundary.
  return {
    id,
    label: `Reviewed Slack person ${id}`,
    accessLevel: person.accessLevel
  };
}

function normalizeItem(item) {
  if (!item || typeof item !== "object") {
    throw new TypeError("A Slack metadata item is required.");
  }
  const id = safeOpaqueId(item.id, "Slack item id");
  const area = CONVERSATION_AREAS.has(item.area) ? item.area : null;
  if (!area) {
    throw new TypeError("A Slack item must be a channel, direct-message, or group-message reference.");
  }
  const kind = item.kind === "conversation" ? "conversation" : "item";
  const channel = item.channel == null ? null : safeOpaqueId(item.channel, "Slack channel id");
  const conversation = item.conversation == null ? null : safeOpaqueId(item.conversation, "Slack conversation id");
  if (area === "channels" && !channel) {
    throw new TypeError("A Slack channel item must identify its channel.");
  }
  if (area !== "channels" && kind !== "conversation") {
    throw new TypeError("A direct or group Slack message must be represented as a bounded conversation.");
  }
  if ((area === "group-messages" && item.isGroup !== true) || (area !== "group-messages" && item.isGroup === true)) {
    throw new TypeError("A Slack group flag must match the declared conversation area exactly.");
  }
  const participantIds = (Array.isArray(item.participantIds) ? item.participantIds : [])
    .map((participantId) => safeOpaqueId(participantId, "Slack participant id"));
  if (typeof item.timestamp !== "string" || !Number.isFinite(Date.parse(item.timestamp))) {
    throw new TypeError("A Slack metadata item must include a valid timestamp so the date boundary can be enforced.");
  }
  const threadId = safeOpaqueId(item.threadId ?? id, "Slack thread id");
  const threadRootId = item.threadRootId == null ? threadId : safeOpaqueId(item.threadRootId, "Slack root thread id");
  const category = typeof item.category === "string" && /^[a-z][a-z0-9-]{0,63}$/i.test(item.category)
    ? item.category.toLowerCase()
    : "general";
  // If visibility is not known, do not treat a channel as public. Direct and
  // group messages are selected through their own explicit areas instead.
  const isPrivateChannel = area === "channels" && item.visibility !== "public";
  const sensitiveCategories = Array.isArray(item.sensitiveCategories)
    ? item.sensitiveCategories.filter((value) => typeof value === "string")
    : [];
  return {
    id,
    kind,
    area,
    channel,
    conversation,
    category,
    timestamp: item.timestamp,
    sensitiveCategories,
    uncertainSensitivity: item.uncertainSensitivity === true
      || sensitiveCategories.some((category) => !KNOWN_SENSITIVE_CATEGORIES.has(category.toLowerCase())),
    isGroup: area === "group-messages",
    participantIds: [...new Set(participantIds)].sort(),
    isPrivateChannel,
    threadId,
    threadRootId,
    // Preserve no title, permalink, body, attachment, member profile, or
    // workspace dump. The generic lifecycle only needs a neutral metadata
    // label to describe a countable approval choice.
    label: `Reviewed Slack ${area} reference ${id}`
  };
}

function opaqueReference(value) {
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : null;
}

function sameSortedStrings(left, right) {
  const safeLeft = Array.isArray(left) ? [...left].sort() : null;
  const safeRight = Array.isArray(right) ? [...right].sort() : null;
  return Boolean(safeLeft && safeRight)
    && safeLeft.length === safeRight.length
    && safeLeft.every((value, index) => value === safeRight[index]);
}

function approvedSnapshotRecordMatchesCurrent(expected, current, peopleById) {
  if (!expected || !current || expected.sourceRecordId !== current.id) return false;
  const expectedConversationId = current.area === "channels" ? current.channel : current.id;
  const suppliedSensitiveCategories = Array.isArray(current.sensitiveCategories)
    ? current.sensitiveCategories.filter((value) => typeof value === "string")
    : [];
  const currentSensitiveCategories = suppliedSensitiveCategories
    .map((category) => category.toLowerCase())
    .filter((category) => KNOWN_SENSITIVE_CATEGORIES.has(category));
  const currentUncertainSensitivity = current.uncertainSensitivity === true
    || suppliedSensitiveCategories.some((category) => !KNOWN_SENSITIVE_CATEGORIES.has(category.toLowerCase()));
  if (expected.kind !== current.kind
    || expected.area !== current.area
    || expected.channel !== (current.channel ?? null)
    || expected.conversationId !== expectedConversationId
    || expected.category !== current.category
    || expected.timestamp !== current.timestamp
    || expected.uncertainSensitivity !== currentUncertainSensitivity
    || expected.isGroup !== (current.isGroup === true)
    || expected.threadId !== current.threadId
    || expected.threadRootId !== current.threadRootId
    || (current.area === "channels" && current.isPrivateChannel !== false)
    || !sameSortedStrings(expected.participantIds, current.participantIds)
    || !sameSortedStrings(expected.sensitiveCategories, currentSensitiveCategories)) {
    return false;
  }
  return expected.participantIds.every((personId) => {
    const currentAccess = peopleById.get(personId);
    return ["allowed", "restricted", "blocked"].includes(currentAccess)
      && expected.participantAccess?.[personId] === currentAccess;
  });
}

function validateApprovedMetadataSnapshot(request, plugin) {
  const snapshot = request?.approvedMetadataSnapshot;
  const grant = request?.grant;
  if (!snapshot || snapshot.reviewId !== grant?.reviewId || !Array.isArray(snapshot.records)) {
    throw new SlackPluginError("SLACK_APPROVED_METADATA_SNAPSHOT_REQUIRED", "Slack did not receive the reviewed metadata snapshot at the approved-fetch boundary.");
  }
  const pagination = snapshot.pagination;
  if (pagination?.status !== "complete"
    || pagination.pagesReviewed !== plugin.pagesReviewed
    || pagination.pagesExpected !== plugin.metadataPages.length
    || plugin.paginationState !== "complete"
    || plugin.pagesReviewed < plugin.metadataPages.length) {
    throw new SlackPluginError("SLACK_PAGINATION_INCOMPLETE", "Slack metadata pagination changed before the approved fetch, so no message content was read.");
  }
  const delegate = plugin.delegate;
  const peopleById = new Map();
  for (const person of delegate.people) {
    if (!person?.id || peopleById.has(person.id) || !["allowed", "restricted", "blocked"].includes(person.accessLevel)) {
      throw new SlackPluginError("SLACK_REVIEWED_METADATA_CHANGED", "Slack participant metadata changed before the approved fetch, so no message content was read.");
    }
    peopleById.set(person.id, person.accessLevel);
  }
  const currentById = new Map();
  for (const item of delegate.items) {
    if (!item?.id || currentById.has(item.id)) {
      throw new SlackPluginError("SLACK_REVIEWED_METADATA_CHANGED", "Slack record metadata changed before the approved fetch, so no message content was read.");
    }
    currentById.set(item.id, item);
  }
  const approvedIds = new Set();
  for (const expected of snapshot.records) {
    if (!opaqueReference(expected?.sourceRecordId)
      || approvedIds.has(expected.sourceRecordId)
      || !approvedSnapshotRecordMatchesCurrent(expected, currentById.get(expected.sourceRecordId), peopleById)) {
      throw new SlackPluginError("SLACK_REVIEWED_METADATA_CHANGED", "Slack metadata changed after the privacy review, so no message content was read.");
    }
    approvedIds.add(expected.sourceRecordId);
  }
  return approvedIds;
}

/**
 * Simulates the exact boundary expected from an official Slack plugin. The
 * public lifecycle must still ask before invoking authorization; this class
 * never performs a network call or starts OAuth.
 */
export class SimulatedSlackOfficialPlugin {
  constructor({
    account = { id: "slack-workspace", label: "Selected Slack workspace" },
    people = [],
    items = [],
    metadataPages,
    authorizationState = "authorized",
    paginationState = "complete"
  } = {}) {
    const accountId = safeOpaqueId(account?.id, "Slack workspace id");
    if (!AUTHORIZATION_STATES.has(authorizationState)) {
      throw new TypeError("authorizationState must be authorized, denied, unavailable, or revoked.");
    }
    if (!PAGINATION_STATES.has(paginationState)) {
      throw new TypeError("paginationState must be complete or incomplete.");
    }
    const pages = metadataPages == null ? [items] : metadataPages;
    if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) {
      throw new TypeError("metadataPages must be a non-empty array of metadata-item pages.");
    }

    this.account = { id: accountId, label: "Selected Slack workspace" };
    this.people = people.map(normalizePerson);
    this.metadataPages = pages.map((page) => page.map(normalizeItem));
    this.items = this.metadataPages.flat();
    if (new Set(this.items.map((item) => item.id)).size !== this.items.length) {
      throw new TypeError("Slack metadata item ids must be unique across pages.");
    }
    if (new Set(this.people.map((person) => person.id)).size !== this.people.length) {
      throw new TypeError("Slack metadata person ids must be unique.");
    }
    this.visibleItems = this.items.filter((item) => !item.isPrivateChannel);
    this.visibleById = new Map(this.visibleItems.map((item) => [item.id, item]));
    this.visibleThreadIds = new Set(this.visibleItems.map((item) => item.threadId));
    this.delegate = new SimulatedReadOnlyConnector({
      source: "slack",
      account: this.account,
      people: this.people,
      items: this.visibleItems
    });
    this.authorizationState = authorizationState;
    this.paginationState = paginationState;
    this.authorizationRequests = 0;
    this.readOnlyVerificationCalls = 0;
    this.metadataDiscoveryAttempts = 0;
    this.pagesReviewed = 0;
    this.stableReferenceNormalizationCalls = 0;
    this.blockedGroupPolicyCalls = 0;
    this.blockedGroupPolicy = { reviewId: null, approvedConversationIds: [] };
    this.writeCalls = 0;
    this.requests = [];
  }

  get metadataPreflightCalls() { return this.delegate.metadataPreflightCalls; }
  get bodyFetchCalls() { return this.delegate.bodyFetchCalls; }
  get bodyAccesses() { return this.delegate.bodyAccesses; }
  get grantRegistrationCalls() { return this.delegate.grantRegistrationCalls; }
  get grantRevocationCalls() { return this.delegate.grantRevocationCalls; }

  async requestOfficialPluginAuthorization({ source, accountId, purpose }) {
    if (source !== "slack" || accountId !== this.account.id) {
      throw new SlackPluginError("SLACK_ACCOUNT_MISMATCH", "The selected Slack workspace did not match the saved setup.");
    }
    this.authorizationRequests += 1;
    this.requests.push({ type: "authorization", source, accountId, purpose: typeof purpose === "string" ? purpose.slice(0, 160) : "" });
    return {
      status: this.authorizationState,
      accountId: this.account.id,
      provider: "official-slack-plugin",
      readOnly: this.authorizationState === "authorized"
    };
  }

  async verifyReadOnlyConnection({ source, accountId }) {
    if (source !== "slack" || accountId !== this.account.id) {
      throw new SlackPluginError("SLACK_ACCOUNT_MISMATCH", "The selected Slack workspace did not match the saved setup.");
    }
    this.readOnlyVerificationCalls += 1;
    this.requests.push({ type: "read-only-verification", source, accountId });
    if (this.authorizationState === "revoked") {
      return { status: "revoked", readOnly: false };
    }
    if (this.authorizationState !== "authorized") {
      return { status: this.authorizationState, readOnly: false };
    }
    return {
      status: "verified",
      readOnly: true,
      operations: {
        canPost: false,
        canReact: false,
        canEdit: false,
        canArchive: false,
        canInvite: false,
        canChangeWorkspaceState: false
      }
    };
  }

  async discoverMetadata({ source }) {
    if (source !== "slack") {
      throw new SlackPluginError("SLACK_SOURCE_MISMATCH", "The Slack plugin request did not match Slack.");
    }
    this.metadataDiscoveryAttempts += 1;
    if (this.authorizationState === "revoked") {
      throw new SlackPluginError("SLACK_AUTHORIZATION_REVOKED", "Slack access was revoked before metadata could be reviewed.");
    }
    if (this.authorizationState !== "authorized") {
      throw new SlackPluginError("SLACK_AUTHORIZATION_REQUIRED", "Slack authorization is not available for a metadata review.");
    }
    if (this.paginationState !== "complete") {
      this.pagesReviewed = Math.min(1, this.metadataPages.length);
      throw new SlackPluginError("SLACK_PAGINATION_INCOMPLETE", "Slack metadata pagination did not finish, so no content review was created.");
    }
    this.pagesReviewed = this.metadataPages.length;
    const preflight = await this.delegate.discoverMetadata({ source });
    // The public permission engine intentionally ignores these extra fields,
    // but the Slack bounded connector retains them as the safe opaque
    // inventory used to bind a later fetch and stable reference exactly to
    // this metadata review. No labels or bodies are added back.
    return {
      ...preflight,
      items: preflight.items.map((item) => {
        const original = this.visibleById.get(item.id);
        return {
          ...item,
          visibility: original?.area === "channels" ? "public" : null,
          threadId: original?.threadId,
          threadRootId: original?.threadRootId
        };
      })
    };
  }

  async registerPermissionGrant({ grant }) {
    return this.delegate.registerPermissionGrant({ grant });
  }

  async revokePermissionGrant({ grantId }) {
    // This only removes an in-memory test grant. It never changes Slack state.
    return this.delegate.revokePermissionGrant({ grantId });
  }

  /**
   * The public Slack lifecycle persists a separate review before it supplies
   * this narrow policy. Keeping the policy in the connector means a generic
   * permission scope alone cannot make a blocked group readable.
   */
  async setSlackContentPolicy({ reviewId, approvedBlockedGroupConversationIds }) {
    const safeReviewId = safeOpaqueId(reviewId, "Slack permission review id");
    if (!Array.isArray(approvedBlockedGroupConversationIds)) {
      throw new SlackPluginError("SLACK_BLOCKED_GROUP_POLICY_INVALID", "Slack could not safely apply the blocked-group policy.");
    }
    this.blockedGroupPolicyCalls += 1;
    this.blockedGroupPolicy = {
      reviewId: safeReviewId,
      approvedConversationIds: [...new Set(approvedBlockedGroupConversationIds
        .map((conversationId) => safeOpaqueId(conversationId, "approved blocked Slack group")))].sort()
    };
  }

  async fetchApprovedContent(request) {
    if (this.authorizationState === "revoked") {
      throw new SlackPluginError("SLACK_AUTHORIZATION_REVOKED", "Slack access was revoked before the approved fetch.");
    }
    if (this.authorizationState !== "authorized") {
      throw new SlackPluginError("SLACK_AUTHORIZATION_REQUIRED", "Slack authorization is no longer available for the approved fetch.");
    }
    const requestedExceptions = Array.isArray(request?.grant?.scope?.blockedGroupConversationExceptions)
      ? request.grant.scope.blockedGroupConversationExceptions
      : [];
    const policyMatchesReview = this.blockedGroupPolicy.reviewId === request?.grant?.reviewId;
    if (requestedExceptions.some((conversationId) => !policyMatchesReview || !this.blockedGroupPolicy.approvedConversationIds.includes(conversationId))) {
      throw new SlackPluginError("SLACK_BLOCKED_GROUP_POLICY_REQUIRED", "A blocked Slack group was not separately approved for this review.");
    }

    // The wrapper's preflight recheck and the source read are separate awaits.
    // Revalidate the exact approved metadata snapshot inside this fetch method,
    // then restrict the body-capable delegate to those reviewed record IDs.
    // This makes participant/privacy drift at the fetch boundary fail before
    // the simulated body-access counter can advance.
    const approvedIds = validateApprovedMetadataSnapshot(request, this);
    if (approvedIds.size === 0) {
      return { rawBodiesReturned: false, records: [], contentBodiesRead: false };
    }

    const blockedPersonIds = new Set(this.delegate.people
      .filter((person) => person.accessLevel === "blocked")
      .map((person) => person.id));
    const originalItems = this.delegate.items;
    this.delegate.items = originalItems.filter((item) => {
      if (!approvedIds.has(item.id)) return false;
      const blockedGroup = item.kind === "conversation"
        && item.isGroup === true
        && item.participantIds.some((personId) => blockedPersonIds.has(personId));
      return !blockedGroup || (policyMatchesReview && this.blockedGroupPolicy.approvedConversationIds.includes(item.id));
    });
    try {
      const result = await this.delegate.fetchApprovedContent(request);
      return { ...result, contentBodiesRead: true };
    } finally {
      this.delegate.items = originalItems;
    }
  }

  async getSafeMetadataSummary() {
    const privateChannelIds = new Set(this.items
      .filter((item) => item.isPrivateChannel)
      .map((item) => item.channel)
      .filter(Boolean));
    return {
      pagination: {
        status: this.paginationState,
        pagesReviewed: this.pagesReviewed,
        pagesExpected: this.metadataPages.length
      },
      privateChannels: {
        status: "excluded-by-default",
        count: privateChannelIds.size
      }
    };
  }

  /** Converts only already-approved opaque ids into source references. */
  async normalizeStableThreadReferences({ source, accountId, records }) {
    if (source !== "slack" || accountId !== this.account.id || !Array.isArray(records)) {
      throw new SlackPluginError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack could not safely normalize the approved thread references.");
    }
    this.stableReferenceNormalizationCalls += 1;
    const approvedThreadIds = new Set(records
      .map((record) => opaqueReference(record?.sourceRecordId))
      .map((sourceRecordId) => sourceRecordId ? this.visibleById.get(sourceRecordId)?.threadId : null)
      .filter(Boolean));
    return records.map((record) => {
      const sourceRecordId = opaqueReference(record?.sourceRecordId);
      const item = sourceRecordId ? this.visibleById.get(sourceRecordId) : null;
      if (!item) {
        throw new SlackPluginError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack returned an unreviewed reference, so it was not exposed.");
      }
      const conversationId = item.area === "channels" ? item.channel : item.id;
      const threadId = item.threadId;
      // Do not expose even an opaque parent pointer when its root fell outside
      // the final scope. The bounded connector independently verifies this
      // same rule against the saved preflight inventory.
      const parentThreadId = item.threadRootId !== threadId && approvedThreadIds.has(item.threadRootId)
        ? item.threadRootId
        : null;
      return {
        source: "slack",
        sourceRecordId,
        processingDisposition: "untrusted-inert-reference",
        conversationType: item.area === "channels" ? "channel-thread" : item.area === "direct-messages" ? "direct-message" : "group-message",
        stableReference: `slack:${this.account.id}:${conversationId}:${threadId}`,
        threadContext: {
          conversationId,
          threadId,
          parentThreadId
        }
      };
    });
  }
}
