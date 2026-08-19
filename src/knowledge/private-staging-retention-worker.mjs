/**
 * Private local retention worker for QWA-146 staging.
 *
 * It receives only a dedicated private root, opaque batch/generation IDs, and
 * a fixed deadline. Generation-specific filenames make an old worker unable
 * to unlink a later reuse of the same batch ID. It never reads staged records,
 * logs content, or inherits the compiler's environment.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink, utimes } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const STAGING_DIRECTORY_NAME = ".qwave-second-brain-staging";
const STAGING_FILE_PREFIX = "batch-";
const STAGING_VERSION = 1;
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const POLL_MS = 250;
const HEARTBEAT_MS = 1_000;
const MAX_STAGING_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_REASONS = new Set([
  "compiled",
  "discarded",
  "expired",
  "explicit-delete",
  "invalid-generation",
  "orphaned-generation",
  "retention-unavailable",
  "stage-write-failed",
  "verified-early-absence"
]);

function boundedCleanupReason(value) {
  return typeof value === "string" && CLEANUP_REASONS.has(value) ? value : "unknown-cleanup";
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  const canonical = new Date(value).toISOString();
  return canonical === value ? canonical : null;
}

function generationTag(leaseId) {
  return createHash("sha256").update(leaseId).digest("hex").slice(0, 24);
}

function artifactPaths(root, batchId, leaseId) {
  const base = `${STAGING_FILE_PREFIX}${batchId}.${generationTag(leaseId)}`;
  return {
    data: resolve(root, `${base}.json`),
    lease: resolve(root, `${base}.lease.json`),
    receipt: resolve(root, `${base}.receipt.json`),
    tombstone: resolve(root, `${base}.tombstone.json`),
    owner: resolve(root, `${base}.owner.json`)
  };
}

function safeArguments(argv) {
  const [rootInput, batchId, expiresAt, leaseId, workerId, claimNonce] = argv;
  if (
    typeof rootInput !== "string"
    || !isAbsolute(rootInput)
    || basename(resolve(rootInput)) !== STAGING_DIRECTORY_NAME
    || typeof batchId !== "string"
    || !BATCH_ID.test(batchId)
    || !canonicalTimestamp(expiresAt)
    || typeof leaseId !== "string"
    || !OPAQUE_ID.test(leaseId)
    || typeof workerId !== "string"
    || !OPAQUE_ID.test(workerId)
    || typeof claimNonce !== "string"
    || !OPAQUE_ID.test(claimNonce)
  ) return null;
  return { root: resolve(rootInput), batchId, expiresAt, leaseId, workerId, claimNonce };
}

async function pathAbsent(target) {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!["EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
  } finally {
    try { await handle?.close(); } catch {}
  }
}

async function durableJsonWrite(target, value, { exclusive = false } = {}) {
  const temporary = exclusive ? target : `${target}.${process.pid}.tmp`;
  let handle;
  let created = false;
  let failure = null;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    created = true;
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  if (handle) {
    try { await handle.close(); } catch (error) { failure ??= error; }
  }
  if (failure) {
    if (created) try { await unlink(temporary); } catch {}
    throw failure;
  }
  if (!exclusive) {
    try {
      await rename(temporary, target);
    } catch (error) {
      try { await unlink(temporary); } catch {}
      throw error;
    }
  }
  await syncDirectory(dirname(target));
}

async function readJson(target) {
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024) throw new Error("unsafe retention artifact");
  return JSON.parse(await readFile(target, "utf8"));
}

function ownerMatches(owner, job) {
  return Boolean(owner?.version === STAGING_VERSION
    && owner.batchId === job.batchId
    && owner.leaseId === job.leaseId
    && owner.expiresAt === job.expiresAt
    && owner.workerId === job.workerId
    && owner.claimNonce === job.claimNonce
    && owner.phase === "running"
    && owner.pid === process.pid
    && owner.processNonce === job.processNonce
    && owner.processStartedAt === job.processStartedAt
    && canonicalTimestamp(owner.startedAt)
    && canonicalTimestamp(owner.heartbeatAt));
}

async function bindOwnership(job) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  const claimed = await readJson(paths.owner).catch(() => null);
  if (
    claimed?.version !== STAGING_VERSION
    || claimed.batchId !== job.batchId
    || claimed.leaseId !== job.leaseId
    || claimed.expiresAt !== job.expiresAt
    || claimed.workerId !== job.workerId
    || claimed.claimNonce !== job.claimNonce
    || claimed.phase !== "claimed"
    || !canonicalTimestamp(claimed.startedAt)
    || !canonicalTimestamp(claimed.heartbeatAt)
  ) return null;
  const processStartedAt = new Date().toISOString();
  const processNonce = `process-${randomUUID()}`;
  const running = {
    ...claimed,
    phase: "running",
    pid: process.pid,
    processNonce,
    processStartedAt,
    heartbeatAt: processStartedAt
  };
  await durableJsonWrite(paths.owner, running);
  job.processNonce = processNonce;
  job.processStartedAt = processStartedAt;
  return running;
}

async function readOwnedRecord(job) {
  const owner = await readJson(artifactPaths(job.root, job.batchId, job.leaseId).owner).catch(() => null);
  return ownerMatches(owner, job) ? owner : null;
}

async function refreshHeartbeat(job, owner) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  if (!ownerMatches(await readOwnedRecord(job), job)) return false;
  try {
    const now = new Date();
    await utimes(paths.owner, now, now);
    return true;
  } catch {
    return false;
  }
}

async function unlinkAndSync(target) {
  try {
    await unlink(target);
    await syncDirectory(dirname(target));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function markTombstoneBlocked(job) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  const existing = await readJson(paths.tombstone).catch(() => null);
  const deleteStartedAt = canonicalTimestamp(existing?.deleteStartedAt) ?? new Date().toISOString();
  await durableJsonWrite(paths.tombstone, {
    version: STAGING_VERSION,
    batchId: job.batchId,
    leaseId: job.leaseId,
    deleteStartedAt,
    dataUnlinkVerified: false,
    reason: boundedCleanupReason(existing?.reason),
    cleanupBlockedReason: "multiple-links-after-unlink",
    detectedAt: new Date().toISOString()
  });
}

async function markTombstoneUnlinkVerified(job) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  const existing = await readJson(paths.tombstone).catch(() => null);
  if (!validTombstoneBase(existing, job) || existing.cleanupBlockedReason != null) return false;
  try {
    await durableJsonWrite(paths.tombstone, {
      ...existing,
      dataUnlinkVerified: true,
      dataUnlinkVerifiedAt: new Date().toISOString()
    });
    return true;
  } catch {
    return false;
  }
}

async function unlinkSingleLinkData(job, tombstone) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  let before;
  try {
    before = await lstat(paths.data);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (tombstone.value.dataUnlinkVerified === true) return "absent";
      return "needs-attention";
    }
    return "retry";
  }
  if (before.isSymbolicLink()) {
    // Remove only the generation-specific directory entry without following
    // the invalid link or touching its target.
    try {
      await unlinkAndSync(paths.data);
      return await markTombstoneUnlinkVerified(job) ? "deleted" : "needs-attention";
    } catch {
      return "retry";
    }
  }
  if (!before.isFile() || before.nlink !== 1) return "needs-attention";
  let handle;
  let outcome = "retry";
  try {
    handle = await open(paths.data, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(before, opened)) return "needs-attention";
    await unlinkAndSync(paths.data);
    const remainingLinks = (await handle.stat()).nlink;
    if (remainingLinks !== 0) {
      await markTombstoneBlocked(job).catch(() => undefined);
      return "needs-attention";
    }
    outcome = "deleted";
  } catch {
    outcome = "retry";
  } finally {
    try { await handle?.close(); } catch { outcome = "retry"; }
  }
  if (outcome === "deleted" && !await markTombstoneUnlinkVerified(job)) return "needs-attention";
  return outcome;
}

function validTombstoneBase(value, job) {
  return Boolean(value?.version === STAGING_VERSION
    && value.batchId === job.batchId
    && value.leaseId === job.leaseId
    && [true, false].includes(value.dataUnlinkVerified)
    && (value.dataUnlinkVerified === false || canonicalTimestamp(value.dataUnlinkVerifiedAt))
    && canonicalTimestamp(value.deleteStartedAt));
}

async function ensureTombstone(job, reason) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  const existing = await readJson(paths.tombstone).catch(() => null);
  if (existing) return validTombstoneBase(existing, job) && existing.cleanupBlockedReason == null
    ? { created: false, value: existing }
    : null;
  const tombstone = {
    version: STAGING_VERSION,
    batchId: job.batchId,
    leaseId: job.leaseId,
    deleteStartedAt: new Date().toISOString(),
    dataUnlinkVerified: false,
    reason: boundedCleanupReason(reason)
  };
  try {
    await durableJsonWrite(paths.tombstone, tombstone, { exclusive: true });
    return { created: true, value: tombstone };
  } catch {
    return null;
  }
}

async function removeOwnership(job) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  if (!await readOwnedRecord(job)) return;
  try { await unlinkAndSync(paths.owner); } catch {}
}

async function finalizeGenerationDeletion(job, reason) {
  const rootStats = await lstat(job.root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return "superseded";
  const rootReal = await realpath(job.root).catch(() => null);
  if (!rootReal || rootReal !== job.root) return "superseded";
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  if (Object.values(paths).some((target) => dirname(target) !== job.root)) return "superseded";
  const existingTombstone = await readJson(paths.tombstone).catch(() => null);
  const dataAbsentBeforeMarker = await pathAbsent(paths.data).catch(() => false);
  const leaseAbsentBeforeMarker = await pathAbsent(paths.lease).catch(() => false);
  if (dataAbsentBeforeMarker && leaseAbsentBeforeMarker && !existingTombstone) {
    // The generation paths were removed outside this worker and there is no
    // durable unlink proof. Exit stale ownership without fabricating a
    // deletion receipt for data that could have been moved or linked away.
    await removeOwnership(job);
    return "superseded";
  }
  const tombstone = await ensureTombstone(job, reason);
  if (!tombstone) return "retry";

  const dataOutcome = await unlinkSingleLinkData(job, tombstone);
  if (dataOutcome === "needs-attention") return "needs-attention";
  if (dataOutcome === "retry") return "retry";
  if (!await pathAbsent(paths.data).catch(() => false)) return "retry";
  try { await unlinkAndSync(paths.lease); } catch { return "retry"; }
  if (!await pathAbsent(paths.lease).catch(() => false)) return "retry";

  try {
    await durableJsonWrite(paths.receipt, {
      version: STAGING_VERSION,
      batchId: job.batchId,
      leaseId: job.leaseId,
      deletedAt: new Date().toISOString(),
      reason: boundedCleanupReason(tombstone.value.reason),
      writer: "retention-worker",
      workerId: job.workerId,
      claimNonce: job.claimNonce,
      pid: process.pid,
      processNonce: job.processNonce,
      processStartedAt: job.processStartedAt
    });
  } catch {
    // Paths are already absent and the durable tombstone is content-free.
    // Keep ownership and retry until startup/resume acknowledges the tombstone
    // or the transient host failure clears.
    return "retry";
  }
  await removeOwnership(job);
  return "deleted";
}

async function cleanupReasonFor(job) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  const lease = await readJson(paths.lease).catch(() => null);
  const dataAbsent = await pathAbsent(paths.data).catch(() => false);
  if (!lease && dataAbsent) return "verified-early-absence";
  const createdAt = canonicalTimestamp(lease?.createdAt);
  const expiresAt = canonicalTimestamp(lease?.expiresAt);
  const validLease = lease?.version === STAGING_VERSION
    && lease.batchId === job.batchId
    && lease.leaseId === job.leaseId
    && expiresAt === job.expiresAt
    && createdAt
    && Date.parse(expiresAt) - Date.parse(createdAt) === MAX_STAGING_AGE_MS
    && ["prepared", "ready"].includes(lease.phase);
  if (!validLease) return Date.now() >= Date.parse(job.expiresAt) ? "invalid-generation" : null;
  if (Date.now() >= Date.parse(job.expiresAt)) return "expired";
  return lease.phase === "ready" && dataAbsent ? "verified-early-absence" : null;
}

async function confirmSchedule(job) {
  if (typeof process.send !== "function") return false;
  try {
    await new Promise((resolveConfirmation, rejectConfirmation) => {
      process.send({
        type: "qwave-retention-armed",
        batchId: job.batchId,
        leaseId: job.leaseId,
        workerId: job.workerId,
        claimNonce: job.claimNonce,
        pid: process.pid,
        processNonce: job.processNonce,
        processStartedAt: job.processStartedAt
      }, (error) => error ? rejectConfirmation(error) : resolveConfirmation());
    });
    process.disconnect?.();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const job = safeArguments(process.argv.slice(2));
  if (!job || !await bindOwnership(job) || !await readOwnedRecord(job) || !await confirmSchedule(job)) return;
  let owner = await readOwnedRecord(job);
  let lastHeartbeat = Date.now();
  while (owner) {
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      if (!await refreshHeartbeat(job, owner)) return;
      owner = await readOwnedRecord(job);
      lastHeartbeat = Date.now();
      if (!owner) return;
    }
    const cleanupReason = await cleanupReasonFor(job);
    if (cleanupReason) {
      const outcome = await finalizeGenerationDeletion(job, cleanupReason).catch(() => "retry");
      if (outcome === "deleted" || outcome === "superseded") return;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_MS));
    owner = await readOwnedRecord(job);
  }
}

await main();
