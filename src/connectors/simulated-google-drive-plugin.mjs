/**
 * QWA-142 test doubles. These record authorization/revocation calls but do
 * not open Drive, return a file body, or mutate a file.
 */

import { SimulatedReadOnlyConnector } from "../permissions/simulated-connector.mjs";

function clone(value) {
  return structuredClone(value);
}

export class SimulatedGoogleDrivePlugin {
  constructor({
    authorization = {
      status: "authorized",
      accountId: "google-drive",
      readOnly: true,
      metadataOnly: true,
      approvedFolderIds: []
    },
    revocation = { status: "revoked" }
  } = {}) {
    this.authorization = clone(authorization);
    this.revocation = clone(revocation);
    this.authorizationCalls = 0;
    this.revocationCalls = 0;
    this.requests = [];
    this.writeCalls = 0;
  }

  async authorizeFolderScopedReadOnly(request) {
    this.authorizationCalls += 1;
    this.requests.push(clone(request));
    return clone(this.authorization);
  }

  async revokeFolderScopedReadOnly(request) {
    this.revocationCalls += 1;
    this.requests.push(clone(request));
    return clone(this.revocation);
  }
}

/** A read-only Drive fixture that intentionally never exposes raw file bodies. */
export class SimulatedGoogleDriveConnector extends SimulatedReadOnlyConnector {
  constructor({ account = { id: "google-drive", label: "Simulated Google Drive" }, folders = [], items = [], people = [] } = {}) {
    super({ source: "drive", account, items, people });
    this.folders = clone(folders);
  }

  async discoverMetadata({ source }) {
    const metadata = await super.discoverMetadata({ source });
    return {
      ...metadata,
      folders: clone(this.folders),
      items: this.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        area: item.area,
        folder: item.folder,
        category: item.category,
        sensitiveCategories: item.sensitiveCategories,
        uncertainSensitivity: item.uncertainSensitivity,
        participantIds: item.participantIds,
        label: item.label,
        mimeType: item.mimeType,
        modifiedAt: item.modifiedAt,
        webUrl: item.webUrl,
        timestamp: item.timestamp
      }))
    };
  }
}
