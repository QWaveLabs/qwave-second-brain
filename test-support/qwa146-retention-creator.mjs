// This fixture deliberately exits immediately after durably creating the
// content-free generation marker and arming the independent cleanup worker. It
// never creates, reads, or logs staging content.

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DetachedLocalRetentionService } from "../src/knowledge/approved-record-compiler.mjs";

const [root, batchId, expiresAt, leaseId = "lease-fixture-worker"] = process.argv.slice(2);
const createdAt = new Date(Date.parse(expiresAt) - (24 * 60 * 60 * 1000)).toISOString();
const tag = createHash("sha256").update(leaseId).digest("hex").slice(0, 24);
const marker = join(root, `batch-${batchId}.${tag}.lease.json`);
const markerHandle = await open(marker, "wx", 0o600);
try {
  await markerHandle.writeFile(`${JSON.stringify({
    version: 1,
    batchId,
    leaseId,
    phase: "prepared",
    createdAt,
    expiresAt
  })}\n`, "utf8");
  await markerHandle.sync();
} finally {
  await markerHandle.close();
}
const rootHandle = await open(root, "r");
try { await rootHandle.sync(); } finally { await rootHandle.close(); }
await new DetachedLocalRetentionService().arm({ root, batchId, expiresAt, leaseId });
