import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [root, batchId, , leaseId, workerId, claimNonce] = process.argv.slice(2);
const generationTag = createHash("sha256").update(leaseId).digest("hex").slice(0, 24);
const ownerPath = path.join(root, `batch-${batchId}.${generationTag}.owner.json`);
const owner = JSON.parse(await readFile(ownerPath, "utf8"));
const processStartedAt = new Date().toISOString();
const processNonce = `process-${randomUUID()}`;
await writeFile(ownerPath, `${JSON.stringify({
  ...owner,
  phase: "running",
  pid: process.pid,
  processNonce,
  processStartedAt,
  heartbeatAt: processStartedAt
})}\n`, { encoding: "utf8", mode: 0o600 });
await writeFile(path.join(root, `env-observation-${batchId}.json`), `${JSON.stringify({
  inheritedSentinel: Object.hasOwn(process.env, "QWA146_RETENTION_SENTINEL"),
  environmentKeys: Object.keys(process.env).sort()
})}\n`, { encoding: "utf8", mode: 0o600 });

await new Promise((resolveSend, rejectSend) => {
  process.send?.({
    type: "qwave-retention-armed",
    batchId,
    leaseId,
    workerId,
    claimNonce,
    pid: process.pid,
    processNonce,
    processStartedAt
  }, (error) => {
    if (error) rejectSend(error);
    else resolveSend();
  });
});
process.disconnect?.();
