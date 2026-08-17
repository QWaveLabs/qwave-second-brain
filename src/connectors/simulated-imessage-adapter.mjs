/**
 * Controlled QWA-150 test adapters. They never expose raw message bodies and
 * have no send/edit/delete operation. Their counters make privacy ordering
 * observable without accessing a customer Messages database.
 */

import { SimulatedReadOnlyConnector } from "../permissions/simulated-connector.mjs";

function clone(value) {
  return structuredClone(value);
}

export class SimulatedIMessageLocalAdapter {
  constructor({ accessResult = "denied" } = {}) {
    this.accessResult = accessResult;
    this.permissionRequests = 0;
    this.localDatabaseReads = 0;
    this.bodyReads = 0;
    this.writeCalls = 0;
    this.requests = [];
  }

  async requestReadOnlyDatabaseAccess(request) {
    this.permissionRequests += 1;
    this.requests.push(clone(request));
    return { status: this.accessResult, readOnly: true };
  }
}

export class SimulatedIMessageSnapshotConnector {
  constructor({
    account = { id: "local-imessage", label: "Local iMessage" },
    people = [],
    items = []
  } = {}) {
    this.delegate = new SimulatedReadOnlyConnector({ source: "imessage", account, people, items });
    this.contentPolicy = { attachmentsApproved: false, highRiskIdentifiersApproved: false };
    this.policyCalls = 0;
    this.writeCalls = 0;
  }

  get metadataPreflightCalls() { return this.delegate.metadataPreflightCalls; }
  get bodyFetchCalls() { return this.delegate.bodyFetchCalls; }
  get bodyAccesses() { return this.delegate.bodyAccesses; }
  get grantRegistrationCalls() { return this.delegate.grantRegistrationCalls; }
  get grantRevocationCalls() { return this.delegate.grantRevocationCalls; }
  get account() { return this.delegate.account; }

  async discoverMetadata({ source }) {
    return this.delegate.discoverMetadata({ source });
  }

  async registerPermissionGrant({ grant }) {
    return this.delegate.registerPermissionGrant({ grant });
  }

  async revokePermissionGrant({ grantId }) {
    return this.delegate.revokePermissionGrant({ grantId });
  }

  async setIMessageContentPolicy({ attachmentsApproved, highRiskIdentifiersApproved }) {
    if (typeof attachmentsApproved !== "boolean" || typeof highRiskIdentifiersApproved !== "boolean") {
      throw new Error("The iMessage content policy must be explicit booleans.");
    }
    this.policyCalls += 1;
    this.contentPolicy = { attachmentsApproved, highRiskIdentifiersApproved };
  }

  async fetchApprovedContent(request) {
    // Exclude sensitive records before delegating the approved fetch. The
    // delegate never sees an attachment/high-risk record until its separate
    // approval has been persisted and supplied through the public lifecycle.
    const originalItems = this.delegate.items;
    const filtered = originalItems.filter((item) => {
      if (item.hasAttachments === true && !this.contentPolicy.attachmentsApproved) return false;
      const highRisk = Array.isArray(item.sensitiveCategories) && item.sensitiveCategories.length > 0;
      return !highRisk || this.contentPolicy.highRiskIdentifiersApproved;
    });
    this.delegate.items = filtered;
    try {
      return await this.delegate.fetchApprovedContent(request);
    } finally {
      this.delegate.items = originalItems;
    }
  }
}
