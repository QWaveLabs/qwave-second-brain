/**
 * QWA-149 controlled generic-export fixture.
 *
 * This adapter is intentionally incapable of connecting to Gmail, Drive,
 * Calendar, Slack, iMessage, WhatsApp, or any other real source. It accepts
 * only pre-supplied simulated metadata and can produce only opaque,
 * snapshot-labelled references after a saved granular permission. It has no
 * body-read and no source-write method.
 */

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function clone(value) {
  return structuredClone(value);
}

function assertOpaqueId(value, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new TypeError(`${field} must be a short opaque identifier.`);
  }
  return value;
}

function normalizeItems(items) {
  const normalized = (Array.isArray(items) ? items : []).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new TypeError("Each simulated export item must be an object.");
    }
    return {
      id: assertOpaqueId(item.id ?? `export-item-${index + 1}`, "Simulated export item id"),
      category: typeof item.category === "string" && /^[a-z][a-z0-9-]{0,31}$/i.test(item.category)
        ? item.category
        : "general"
    };
  });
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) {
    throw new TypeError("Simulated export item ids must be unique.");
  }
  return normalized;
}

/**
 * Test and demonstration adapter. Deliberately use this instead of a source
 * SDK until a separately reviewed live connector is available.
 */
export class SimulatedGenericExportAdapter {
  constructor({ exportId = "demo-export", items = [], previewFailures = 0, importFailures = 0 } = {}) {
    this.isSimulation = true;
    this.exportId = assertOpaqueId(exportId, "Simulated export id");
    this.items = normalizeItems(items);
    this.previewFailures = Number.isSafeInteger(previewFailures) && previewFailures > 0 ? previewFailures : 0;
    this.importFailures = Number.isSafeInteger(importFailures) && importFailures > 0 ? importFailures : 0;
    this.metadataPreviewCalls = 0;
    this.permissionGrantCalls = 0;
    this.snapshotImportCalls = 0;
    this.permissionRevocationCalls = 0;
    this.bodyReads = 0;
    this.writeCalls = 0;
    this.activeGrantIds = new Set();
    this.requests = [];
  }

  /** Returns only generic labels, opaque ids, and categories. */
  async previewMetadata({ sourceId }) {
    this.metadataPreviewCalls += 1;
    this.requests.push({ type: "metadata-preview", sourceId });
    if (this.previewFailures > 0) {
      this.previewFailures -= 1;
      throw new Error("Simulated export metadata preview interrupted.");
    }
    return {
      sourceId,
      exportId: this.exportId,
      simulated: true,
      metadataOnly: true,
      contentBodiesRead: false,
      itemCount: this.items.length,
      items: this.items.map((item, index) => ({
        id: item.id,
        // Do not accept or replay a user-supplied title: titles can be PII or
        // hostile prompt text. The ordinal is sufficient for granular consent.
        label: `Export item ${index + 1}`,
        category: item.category
      }))
    };
  }

  async registerSnapshotPermission({ grant }) {
    this.permissionGrantCalls += 1;
    if (!grant || grant.status !== "active" || !OPAQUE_ID.test(grant.id ?? "")) {
      throw new Error("Simulated export rejected an invalid granular permission.");
    }
    this.activeGrantIds.add(grant.id);
    this.requests.push({ type: "permission-granted", grantId: grant.id, selectedItemCount: grant.scope?.selectedItemIds?.length ?? 0 });
  }

  /**
   * Produces opaque snapshot references only. There is intentionally no raw
   * export body in this contract, even in a simulation.
   */
  async importApprovedSnapshot({ sourceId, grant }) {
    this.snapshotImportCalls += 1;
    this.requests.push({ type: "snapshot-import", sourceId, grantId: grant?.id ?? null });
    if (this.importFailures > 0) {
      this.importFailures -= 1;
      throw new Error("Simulated export snapshot import interrupted.");
    }
    if (!grant || grant.status !== "active" || !this.activeGrantIds.has(grant.id)) {
      throw new Error("Simulated export refused an import without an active granular permission.");
    }
    const selectedItemIds = Array.isArray(grant.scope?.selectedItemIds) ? grant.scope.selectedItemIds : [];
    const selected = this.items.filter((item) => selectedItemIds.includes(item.id));
    return {
      simulated: true,
      snapshotLabel: "simulated-export-snapshot",
      sourceBodiesRead: false,
      rawBodiesReturned: false,
      records: selected.map((item) => ({
        source: sourceId,
        sourceRecordId: item.id,
        snapshotRecordId: `snapshot:${item.id}`,
        processingDisposition: "untrusted-inert-snapshot-reference"
      }))
    };
  }

  async revokeSnapshotPermission({ grantId }) {
    this.permissionRevocationCalls += 1;
    this.activeGrantIds.delete(grantId);
    this.requests.push({ type: "permission-revoked", grantId });
    return { status: "revoked", simulated: true };
  }
}
