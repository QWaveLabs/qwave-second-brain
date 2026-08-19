/**
 * QWA-147 test-only WhatsApp snapshot adapter.
 *
 * It models a customer-supplied, one-time snapshot after the public lifecycle
 * has received explicit import approval. It never opens WhatsApp, reads a raw
 * message/media body, follows source text, or exposes a send/edit/delete API.
 */

import { SimulatedReadOnlyConnector } from "../permissions/simulated-connector.mjs";

export class SimulatedWhatsAppSnapshotConnector {
  constructor({
    account = { id: "personal-whatsapp", label: "Simulated personal WhatsApp snapshot" },
    people = [],
    items = [],
    failuresBeforeMetadata = 0,
    failuresBeforeApprovedFetch = 0
  } = {}) {
    this.delegate = new SimulatedReadOnlyConnector({ source: "whatsapp", account, people, items });
    this.contentPolicy = { includeMedia: false };
    this.policyCalls = 0;
    this.failuresBeforeMetadata = failuresBeforeMetadata;
    this.failuresBeforeApprovedFetch = failuresBeforeApprovedFetch;
    this.rawMessageBodiesRead = 0;
    this.rawMediaBodiesRead = 0;
    this.writeCalls = 0;
  }

  get account() { return this.delegate.account; }
  get metadataPreflightCalls() { return this.delegate.metadataPreflightCalls; }
  get bodyFetchCalls() { return this.delegate.bodyFetchCalls; }
  get bodyAccesses() { return this.delegate.bodyAccesses; }
  get grantRegistrationCalls() { return this.delegate.grantRegistrationCalls; }
  get grantRevocationCalls() { return this.delegate.grantRevocationCalls; }

  async discoverMetadata({ source }) {
    if (this.failuresBeforeMetadata > 0) {
      this.failuresBeforeMetadata -= 1;
      throw new Error("Simulated snapshot metadata review interruption.");
    }
    return this.delegate.discoverMetadata({ source });
  }

  async registerPermissionGrant({ grant }) {
    return this.delegate.registerPermissionGrant({ grant });
  }

  async revokePermissionGrant({ grantId }) {
    return this.delegate.revokePermissionGrant({ grantId });
  }

  async setWhatsAppSnapshotContentPolicy({ includeMedia }) {
    if (typeof includeMedia !== "boolean") {
      throw new Error("The WhatsApp snapshot media policy must be an explicit boolean.");
    }
    this.policyCalls += 1;
    this.contentPolicy = { includeMedia };
  }

  async fetchApprovedContent(request) {
    if (this.failuresBeforeApprovedFetch > 0) {
      this.failuresBeforeApprovedFetch -= 1;
      throw new Error("Simulated approved snapshot fetch interruption.");
    }
    // Filter before the generic bounded fetch. When the customer chose no
    // media, the generic grant boundary never receives a media record at all.
    const originalItems = this.delegate.items;
    this.delegate.items = originalItems.filter((item) => item.hasMedia !== true || this.contentPolicy.includeMedia);
    try {
      return await this.delegate.fetchApprovedContent(request);
    } finally {
      this.delegate.items = originalItems;
    }
  }
}
