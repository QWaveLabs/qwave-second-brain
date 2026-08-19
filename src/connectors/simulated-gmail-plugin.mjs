/**
 * Controlled QWA-145 Gmail plugin fixture.
 *
 * It models the official-plugin contract without authenticating to Google or
 * reading a mailbox. It intentionally exposes only opaque IDs and timestamps,
 * has no source-write methods, and marks every response as a simulation.
 */

function clone(value) {
  return structuredClone(value);
}

function matchesScope(record, scope) {
  if (scope?.dateRange?.from && record.timestamp) {
    const timestamp = Date.parse(record.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < Date.parse(scope.dateRange.from) || timestamp > Date.parse(scope.dateRange.to)) return false;
    if ((scope.exclusions?.dateRanges ?? []).some((range) => timestamp >= Date.parse(range.from) && timestamp <= Date.parse(range.to))) return false;
  }
  if (Array.isArray(scope?.areas) && scope.areas.length > 0 && !scope.areas.includes(record.area ?? "mail")) return false;
  if (Array.isArray(scope?.categories) && scope.categories.length > 0 && !scope.categories.includes(record.category ?? "email")) return false;
  return true;
}

function pageTokenFor(index) {
  return index === 0 ? null : `page-${index + 1}`;
}

function pageIndexFor(token) {
  if (token == null) return 0;
  const match = /^page-(\d+)$/.exec(token);
  return match ? Number(match[1]) - 1 : -1;
}

export class SimulatedGmailPlugin {
  constructor({
    account = { id: "gmail-work", label: "Work Gmail" },
    metadataItems,
    pages = [],
    connectionResults = ["connected"],
    estimatedItemCount,
    metadataFailures = 0,
    grantRegistrationFailures = 0,
    failuresByPageToken = {},
    revokedPageTokens = []
  } = {}) {
    this.isSimulation = true;
    this.account = clone(account);
    this.pages = clone(pages);
    this.metadataItems = clone(metadataItems ?? pages.flatMap((page) => page.records ?? []).slice(0, 8));
    this.connectionResults = [...connectionResults];
    this.estimatedItemCount = Number.isSafeInteger(estimatedItemCount) ? estimatedItemCount : this.pages.reduce((count, page) => count + (page.records?.length ?? 0), 0);
    this.metadataFailures = metadataFailures;
    this.grantRegistrationFailures = grantRegistrationFailures;
    this.failuresByPageToken = new Map(Object.entries(failuresByPageToken));
    this.revokedPageTokens = new Set(revokedPageTokens);
    this.authorizedGrantIds = new Set();
    this.connected = false;
    this.connectionCalls = 0;
    this.metadataPreflightCalls = 0;
    this.grantRegistrationCalls = 0;
    this.grantRevocationCalls = 0;
    this.approvedPageCalls = 0;
    this.bodyReads = 0;
    this.writeCalls = 0;
    this.requests = [];
  }

  async initiateReadOnlyConnection(request) {
    this.connectionCalls += 1;
    this.requests.push({ type: "connection", request: clone(request) });
    const configured = this.connectionResults[Math.min(this.connectionCalls - 1, this.connectionResults.length - 1)] ?? "connected";
    if (configured === "throw") throw new Error("Simulated Gmail plugin connection failure.");
    if (configured === "connected") this.connected = true;
    return {
      status: configured,
      readOnly: configured === "connected",
      simulated: true
    };
  }

  async discoverMetadata({ source }) {
    this.metadataPreflightCalls += 1;
    if (source !== "gmail" || !this.connected) throw new Error("Simulated Gmail metadata requires a completed plugin connection.");
    if (this.metadataFailures > 0) {
      this.metadataFailures -= 1;
      throw new Error("Simulated Gmail metadata interruption.");
    }
    return {
      source: "gmail",
      readOnly: true,
      simulated: true,
      account: clone(this.account),
      estimatedItemCount: this.estimatedItemCount,
      paginationExpected: this.pages.length > 1,
      items: this.metadataItems.map((item) => ({
        id: item.id,
        area: item.area ?? "mail",
        timestamp: item.timestamp ?? null
      }))
    };
  }

  async registerPermissionGrant({ grant }) {
    this.grantRegistrationCalls += 1;
    if (this.grantRegistrationFailures > 0) {
      this.grantRegistrationFailures -= 1;
      throw new Error("Simulated Gmail grant registration failure.");
    }
    if (grant?.source !== "gmail" || grant?.accountId !== this.account.id || grant?.status !== "active") {
      throw new Error("Simulated Gmail rejected a mismatched grant.");
    }
    this.authorizedGrantIds.add(grant.id);
  }

  async revokePermissionGrant({ grantId }) {
    this.grantRevocationCalls += 1;
    this.authorizedGrantIds.delete(grantId);
    return { status: "revoked", revoked: true, grantId };
  }

  async getPermissionGrantStatus({ grantId }) {
    return {
      grantId,
      status: this.authorizedGrantIds.has(grantId) ? "active" : "revoked",
      active: this.authorizedGrantIds.has(grantId),
      revoked: !this.authorizedGrantIds.has(grantId)
    };
  }

  async fetchApprovedPage({ source, accountId, grant, pageToken, pageSize }) {
    this.approvedPageCalls += 1;
    this.requests.push({ type: "approved-page", source, accountId, grantId: grant?.id, pageToken, pageSize });
    if (source !== "gmail" || accountId !== this.account.id || grant?.status !== "active" || !this.authorizedGrantIds.has(grant?.id)) {
      throw new Error("Simulated Gmail refused a fetch without an active matching grant.");
    }
    if (this.revokedPageTokens.has(pageToken ?? "initial")) {
      return { status: "revoked", readOnly: true, simulated: true };
    }
    const remainingFailures = Number(this.failuresByPageToken.get(pageToken ?? "initial") ?? 0);
    if (remainingFailures > 0) {
      this.failuresByPageToken.set(pageToken ?? "initial", remainingFailures - 1);
      throw new Error("Simulated Gmail page interruption.");
    }
    const index = pageIndexFor(pageToken);
    if (index < 0 || index >= this.pages.length) {
      return { readOnly: true, simulated: true, actualRead: false, records: [], nextPageToken: null };
    }
    const page = this.pages[index] ?? { records: [] };
    const nextPageToken = Object.hasOwn(page, "nextPageToken")
      ? page.nextPageToken
      : index + 1 < this.pages.length
        ? pageTokenFor(index + 1)
        : null;
    return {
      readOnly: true,
      rawBodiesReturned: false,
      simulated: true,
      actualRead: false,
      records: (page.records ?? [])
        .filter((record) => matchesScope(record, grant.scope))
        .slice(0, pageSize)
        .map((record) => ({
          id: record.id,
          threadId: record.threadId ?? record.id,
          area: record.area ?? "mail",
          category: record.category ?? "email",
          timestamp: record.timestamp ?? null
        })),
      nextPageToken
    };
  }
}
