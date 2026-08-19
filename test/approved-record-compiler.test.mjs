import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdtemp, mkdir, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANONICAL_SUBJECT_TYPES,
  DetachedLocalRetentionService,
  FileStateStore,
  KnowledgeCompilationError,
  LocalTemporaryStaging,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedObsidianAdapter,
  SimulatedReadOnlyConnector,
  beginSourcePermissionReview,
  cleanupExpiredKnowledgeStaging,
  compileApprovedRecords,
  fetchApprovedSourceContent,
  getKnowledgeCompilationStatus,
  grantSourcePermission,
  revokeSourcePermission,
  startSetupSession
} from "../src/index.mjs";

const fixtureEpoch = Date.now() + (60 * 60 * 1000);
const historicalFixtureEpoch = Date.parse("2026-08-17T12:00:00.000Z");
const liveFixtureTimestamps = new Set();

function fixtureTimestamp(value) {
  const timestamp = new Date(
    fixtureEpoch + (Date.parse(value) - historicalFixtureEpoch)
  ).toISOString();
  liveFixtureTimestamps.add(timestamp);
  return timestamp;
}

const startedAt = fixtureTimestamp("2026-08-17T12:00:00.000Z");
const laterToday = fixtureTimestamp("2026-08-17T13:00:00.000Z");

function generationTag(leaseId) {
  return createHash("sha256").update(leaseId).digest("hex").slice(0, 24);
}

function stagingArtifacts(root, batchId, leaseId) {
  const base = path.join(root, `batch-${batchId}.${generationTag(leaseId)}`);
  return {
    data: `${base}.json`,
    lease: `${base}.lease.json`,
    receipt: `${base}.receipt.json`,
    tombstone: `${base}.tombstone.json`,
    owner: `${base}.owner.json`
  };
}

function exactGenerationWorkerTempNames(names, artifacts) {
  const prefixes = [artifacts.receipt, artifacts.tombstone, artifacts.owner]
    .map((target) => `${path.basename(target)}.`);
  return names.filter((name) => prefixes.some((prefix) => (
    name.startsWith(prefix)
    && /^[0-9]+\.tmp$/.test(name.slice(prefix.length))
  )));
}

async function stagedDataNames(root) {
  return (await readdir(root)).filter((name) => (
    name.endsWith(".json")
    && !name.endsWith(".lease.json")
    && !name.endsWith(".receipt.json")
    && !name.endsWith(".tombstone.json")
    && !name.endsWith(".owner.json")
  )).sort();
}

function simulatedIoError(message) {
  const error = new Error(message);
  error.code = "EIO";
  return error;
}

function isStagingDataPath(target) {
  const name = path.basename(String(target));
  return name.startsWith("batch-")
    && name.endsWith(".json")
    && ![".lease.json", ".receipt.json", ".tombstone.json", ".owner.json"].some((suffix) => name.endsWith(suffix));
}

function proxyFileHandle(handle, overrides) {
  return new Proxy(handle, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function oneShotReadFailureFileSystem(target, message) {
  // macOS can expose the same temporary root through /var and /private/var.
  // The generation artifact basename is immutable and unique for this fixture,
  // so it remains the stable injection point across that realpath rewrite.
  const expectedName = path.basename(String(target));
  let pendingFailures = 0;
  let injections = 0;
  return {
    arm() {
      pendingFailures += 1;
    },
    get injections() {
      return injections;
    },
    fileSystem: {
      async open(candidate, flags, mode) {
        const handle = await open(candidate, flags, mode);
        if (
          pendingFailures <= 0
          || path.basename(String(candidate)) !== expectedName
        ) return handle;
        pendingFailures -= 1;
        injections += 1;
        return proxyFileHandle(handle, {
          async readFile() {
            throw simulatedIoError(message);
          }
        });
      }
    }
  };
}

async function assertStagedGenerationUntouched({
  stateStore,
  beforeState,
  artifacts,
  originalData,
  originalLease
}) {
  assert.equal(await readFile(artifacts.data, "utf8"), originalData);
  assert.equal(await readFile(artifacts.lease, "utf8"), originalLease);
  await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
  await assert.rejects(() => lstat(artifacts.tombstone), (error) => error?.code === "ENOENT");
  assert.deepEqual(await stateStore.load(), beforeState);
}

function clockAt(value) {
  const timestamp = typeof value === "string"
    && !liveFixtureTimestamps.has(value)
    && /^2026-08-(?:17|18)T/.test(value)
    ? fixtureTimestamp(value)
    : value;
  return { now: () => new Date(timestamp) };
}

function scopeForApproval(review) {
  const scope = structuredClone(review.permissionReview.permissionRequest.requestedScope);
  scope.acknowledgements.modelProcessing = true;
  scope.acknowledgements.untrustedSourceMaterial = true;
  return scope;
}

async function approveFixtureSource({
  stateStore,
  source,
  accountId,
  sourceRecordId,
  language = "en",
  sourceTimestamp = startedAt,
  participantRefs = [],
  sourceLabel = "Fixture metadata only",
  stableLink = null
}) {
  const connector = new SimulatedReadOnlyConnector({
    source,
    account: { id: accountId, label: "Fixture account" },
    people: participantRefs.map((id) => ({ id, label: `Fixture ${id}`, accessLevel: "allowed" })),
    items: [{
      id: sourceRecordId,
      kind: "item",
      area: "fixture-area",
      category: "planning",
      timestamp: sourceTimestamp,
      participantIds: participantRefs,
      label: sourceLabel,
      stableLink
    }]
  });
  const reviewId = `${source}-fixture-review`;
  const grantId = `${source}-fixture-grant`;
  const review = await beginSourcePermissionReview({
    message: language === "es" ? "Quiero revisar esta fuente para mi segundo cerebro" : "I want to review this source for my second brain",
    stateStore,
    connector,
    source,
    language,
    clock: clockAt(startedAt),
    reviewIdFactory: () => reviewId
  });
  await grantSourcePermission({
    message: language === "es" ? "Apruebo este alcance de solo lectura" : "I approve this read-only scope",
    stateStore,
    connector,
    source,
    accountId,
    reviewId,
    scope: scopeForApproval(review),
    language,
    clock: clockAt(startedAt),
    grantIdFactory: () => grantId
  });
  return {
    connector,
    source,
    accountId,
    sourceRecordId,
    reviewId,
    grantId,
    sourceTimestamp,
    participantRefs,
    sourceLabel,
    stableLink
  };
}

async function withCompilerFixture(run, { language = "en" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-"));
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  const staging = fixtureStaging(path.join(directory, ".qwave-second-brain-staging"));
  const adapters = {
    environment: new SimulatedEnvironmentAdapter(),
    obsidian: new SimulatedObsidianAdapter(),
    vault: new SimulatedDesktopVaultAdapter()
  };
  try {
    await startSetupSession({
      message: language === "es" ? "Configura mi segundo cerebro" : "Set up my second brain",
      answers: { displayName: "Fixture", focus: "exercise a safe compilation contract" },
      decisions: { vaultName: "Fixture Second Brain", language },
      stateStore,
      adapters,
      clock: clockAt(startedAt),
      installationIdFactory: () => "fixture-installation"
    });
    const gmail = await approveFixtureSource({
      stateStore,
      source: "gmail",
      accountId: "fixture-gmail-account",
      sourceRecordId: "fixture-mail-001",
      participantRefs: ["person-fixture-alex"],
      stableLink: "https://fixture.example.test/mail/fixture-mail-001",
      language
    });
    const calendar = await approveFixtureSource({
      stateStore,
      source: "calendar",
      accountId: "fixture-calendar-account",
      sourceRecordId: "fixture-event-001",
      language
    });
    await run({ directory, stateStore, staging, gmail, calendar });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function approvedRecord(permission, assertions, overrides = {}) {
  return {
    source: permission.source,
    accountId: permission.accountId,
    sourceRecordId: permission.sourceRecordId,
    reviewId: permission.reviewId,
    grantId: permission.grantId,
    processingDisposition: "untrusted-inert-reference",
    sourceTimestamp: permission.sourceTimestamp,
    approvedParticipantRefs: permission.participantRefs,
    sourceLabel: permission.sourceLabel,
    stableLink: permission.stableLink,
    observedAt: startedAt,
    verifiedAt: laterToday,
    privacyRestrictions: ["private", "no-external-sharing"],
    assertions,
    ...overrides
  };
}

function inertStagingRecord(overrides = {}) {
  return {
    source: "fixture",
    accountId: "fixture-account",
    sourceRecordId: "fixture-record",
    reviewId: "fixture-review",
    grantId: "fixture-grant",
    processingDisposition: "untrusted-inert-reference",
    sourceTimestamp: startedAt,
    approvedParticipantRefs: [],
    sourceLabel: null,
    stableLink: null,
    observedAt: startedAt,
    verifiedAt: laterToday,
    privacyRestrictions: ["private"],
    assertions: [assertion("knowledge", "knowledge-fixture-staging", "Staging", "The direct staging contract is normalized.")],
    ...overrides
  };
}

function assertion(subjectType, subjectId, subjectLabel, value, confidence = "confirmed", privacyRestrictions = ["private"]) {
  return {
    subjectType,
    subjectId,
    subjectLabel,
    assertion: value,
    confidence,
    privacyRestrictions
  };
}

function allApprovedRecords(gmail, calendar) {
  return [
    approvedRecord(gmail, [
      assertion("people", "person-fixture-alex", "Fixture Alex", "Fixture Alex owns the Atlas project."),
      assertion("organizations", "organization-fixture-qwave", "Fixture QWave", "Fixture QWave sponsors the Atlas project."),
      assertion("projects", "project-fixture-atlas", "Atlas", "Atlas has a bounded planning scope."),
      assertion("decisions", "decision-fixture-focus", "Focus decision", "The team chose a privacy-first compilation path.")
    ]),
    approvedRecord(calendar, [
      assertion("priorities", "priority-fixture-review", "Privacy review", "Privacy review is the current priority."),
      assertion("areas", "area-fixture-operations", "Operations", "Operations owns the fixture follow-up."),
      assertion("meetings", "meeting-fixture-kickoff", "Fixture kickoff", "The fixture kickoff recorded the approved scope."),
      assertion("knowledge", "knowledge-fixture-boundary", "Boundary note", "Only approved normalized references are compiled.")
    ])
  ];
}

class FailOnceReadStaging {
  constructor(delegate) {
    this.delegate = delegate;
    this.remainingReadFailures = 1;
  }

  async stage(input) { return this.delegate.stage(input); }

  async read(input) {
    if (this.remainingReadFailures > 0) {
      this.remainingReadFailures -= 1;
      throw new Error("Simulated transient staging interruption.");
    }
    return this.delegate.read(input);
  }

  async delete(input) { return this.delegate.delete(input); }

  async cleanupExpired(input) { return this.delegate.cleanupExpired(input); }

  async acknowledgeCleanupReceipt(input, internalToken) {
    return this.delegate.acknowledgeCleanupReceipt(input, internalToken);
  }
}

class ControlledFailureStaging {
  constructor(delegate) {
    this.delegate = delegate;
    this.readFailures = 0;
    this.deleteFailures = 0;
    this.deleteCalls = 0;
    this.afterRead = null;
  }

  async stage(input) { return this.delegate.stage(input); }

  async read(input) {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("Simulated transient staging read interruption.");
    }
    const result = await this.delegate.read(input);
    await this.afterRead?.(result);
    return result;
  }

  async delete(input) {
    this.deleteCalls += 1;
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error("Simulated transient staging deletion interruption.");
    }
    return this.delegate.delete(input);
  }

  async cleanupExpired(input) { return this.delegate.cleanupExpired(input); }

  async acknowledgeCleanupReceipt(input, internalToken) {
    return this.delegate.acknowledgeCleanupReceipt(input, internalToken);
  }
}

class HookedStateStore {
  constructor(delegate) {
    this.delegate = delegate;
    this.filePath = delegate.filePath;
    this.hook = null;
    this.hookResult = null;
    this.hookError = null;
    this.hookInvoked = false;
  }

  async load() { return this.delegate.load(); }

  async save(state) {
    if (this.hook && !this.hookInvoked) {
      this.hookInvoked = true;
      try { this.hookResult = await this.hook(); } catch (error) { this.hookError = error; }
    }
    return this.delegate.save(state);
  }
}

class AfterCompiledResultSaveStateStore {
  constructor(delegate, { batchId, afterSave }) {
    this.delegate = delegate;
    this.filePath = delegate.filePath;
    this.batchId = batchId;
    this.afterSave = afterSave;
    this.invoked = false;
  }

  async load() { return this.delegate.load(); }

  async save(state) {
    const entry = state.knowledgeCompilationLifecycle?.batches?.[this.batchId];
    const shouldInvoke = !this.invoked
      && entry?.status === "compiled"
      && entry.result
      && entry.staging?.status === "result-persisted-pending-deletion";
    await this.delegate.save(state);
    if (shouldInvoke) {
      this.invoked = true;
      await this.afterSave(entry);
    }
  }
}

class FailNextSaveStateStore {
  constructor(delegate) {
    this.delegate = delegate;
    this.filePath = delegate.filePath;
    this.failNextSave = false;
  }

  async load() { return this.delegate.load(); }

  async save(state) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("Simulated private state save interruption.");
    }
    return this.delegate.save(state);
  }
}

class FailCompiledResultSaveStateStore {
  constructor(delegate) {
    this.delegate = delegate;
    this.filePath = delegate.filePath;
    this.failCompiledResultSaves = true;
  }

  async load() { return this.delegate.load(); }

  async save(state) {
    const isCompiledResultSave = Object.values(state.knowledgeCompilationLifecycle?.batches ?? {})
      .some((entry) => entry.status === "compiled" && entry.result);
    if (this.failCompiledResultSaves && isCompiledResultSave) {
      throw new Error("Simulated persistent compiled-result save interruption.");
    }
    return this.delegate.save(state);
  }
}

class FailCompiledCleanupReceiptSaveStateStore {
  constructor(delegate) {
    this.delegate = delegate;
    this.filePath = delegate.filePath;
    this.compiledSaveAttempts = 0;
  }

  async load() { return this.delegate.load(); }

  async save(state) {
    const hasCompiledResult = Object.values(state.knowledgeCompilationLifecycle?.batches ?? {})
      .some((entry) => entry.status === "compiled" && entry.result);
    if (hasCompiledResult) {
      this.compiledSaveAttempts += 1;
      if (this.compiledSaveAttempts === 2) {
        throw new Error("Simulated compiled cleanup-receipt save interruption.");
      }
    }
    return this.delegate.save(state);
  }
}

class PauseBeforeCompiledResultSaveStateStore {
  constructor(delegate) {
    this.delegate = delegate;
    this.filePath = delegate.filePath;
    this.paused = false;
    this.resultSaveReached = new Promise((resolveReached) => { this.resolveReached = resolveReached; });
    this.releaseResultSave = new Promise((resolveRelease) => { this.resolveRelease = resolveRelease; });
  }

  async load() { return this.delegate.load(); }

  async save(state) {
    const isCompiledResultSave = Object.values(state.knowledgeCompilationLifecycle?.batches ?? {})
      .some((entry) => entry.status === "compiled" && entry.result);
    if (!this.paused && isCompiledResultSave) {
      this.paused = true;
      this.resolveReached();
      await this.releaseResultSave;
    }
    return this.delegate.save(state);
  }
}

class FixtureRetentionService {
  constructor({ onArm = null, onDisarm = null } = {}) {
    this.armed = [];
    this.disarmed = [];
    this.onArm = onArm;
    this.onDisarm = onDisarm;
  }

  async arm({ root, batchId, expiresAt, leaseId }) {
    const filesBeforeWrite = await readdir(root);
    const leaseName = filesBeforeWrite.find((name) => name.endsWith(".lease.json"));
    const manifestBeforeWrite = leaseName ? JSON.parse(await readFile(path.join(root, leaseName), "utf8")) : null;
    await this.onArm?.({ root, batchId, expiresAt, leaseId, filesBeforeWrite, manifestBeforeWrite });
    this.armed.push({ root, batchId, expiresAt, leaseId, filesBeforeWrite, manifestBeforeWrite });
  }

  async disarm({ root, batchId, leaseId }) {
    await this.onDisarm?.({ root, batchId, leaseId });
    this.disarmed.push({ root, batchId, leaseId });
  }
}

function fixtureStaging(root, options = {}) {
  const configuration = {
    root,
    ...options,
    clock: options.clock ?? clockAt(startedAt)
  };
  if (!Object.hasOwn(options, "retentionService")) {
    configuration.retentionService = new DetachedLocalRetentionService();
  }
  return new LocalTemporaryStaging(configuration);
}

function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const check = async () => {
      try {
        if (await predicate()) return resolveWait();
      } catch {
        // The next bounded poll can still observe the expected cleanup state.
      }
      if (Date.now() >= deadline) {
        rejectWait(new Error("Timed out waiting for the independently supervised retention worker."));
        return;
      }
      setTimeout(check, 25);
    };
    void check();
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject, seen: false };
}

function runRetentionCreator({ root, batchId, expiresAt }) {
  const fixture = path.join(process.cwd(), "test-support", "qwa146-retention-creator.mjs");
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [fixture, root, batchId, expiresAt], { stdio: "ignore" });
    child.once("error", rejectChild);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolveChild();
      else rejectChild(new Error(`Retention creator exited unexpectedly (${code ?? "null"}/${signal ?? "none"}).`));
    });
  });
}

function processCommands() {
  return new Promise((resolveCommands, rejectCommands) => {
    const child = spawn("/bin/ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectCommands);
    child.once("exit", (code) => {
      if (code === 0) resolveCommands(output.split("\n").filter(Boolean));
      else rejectCommands(new Error(`ps exited with ${code}`));
    });
  });
}

async function retentionWorkerCommands(batchId) {
  return (await processCommands()).filter((line) => (
    line.includes("private-staging-retention-worker.mjs") && line.includes(batchId)
  ));
}

function retentionWorkerPid(command) {
  const match = /^\s*(\d+)\s+/.exec(command);
  assert.ok(match, `Expected a leading PID in process command: ${command}`);
  return Number(match[1]);
}

async function exactRetentionWorkerExists(pid, batchId) {
  return (await retentionWorkerCommands(batchId)).some(
    (command) => retentionWorkerPid(command) === pid
  );
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function signalExactProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function processState(pid) {
  return new Promise((resolveState, rejectState) => {
    const child = spawn("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });
    child.once("error", rejectState);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveState(output.trim());
      } else if (code === 1 && output.trim() === "") {
        resolveState("");
      } else {
        rejectState(new Error(`ps exited with code ${code}: ${errorOutput.trim()}`));
      }
    });
  });
}

async function ensureExactWorkerStoppedForTeardown(pid, batchId) {
  const exactPids = new Set(
    (await retentionWorkerCommands(batchId)).map(retentionWorkerPid)
  );
  for (const exactPid of exactPids) {
    if (await exactRetentionWorkerExists(exactPid, batchId)) {
      signalExactProcess(exactPid, "SIGCONT");
    }
    try {
      await waitFor(async () => !await exactRetentionWorkerExists(exactPid, batchId), 1_500);
    } catch {
      if (await exactRetentionWorkerExists(exactPid, batchId)) {
        signalExactProcess(exactPid, "SIGTERM");
      }
    }
    try {
      await waitFor(async () => !await exactRetentionWorkerExists(exactPid, batchId), 1_500);
    } catch {
      if (await exactRetentionWorkerExists(exactPid, batchId)) {
        signalExactProcess(exactPid, "SIGKILL");
      }
    }
    await waitFor(async () => !await exactRetentionWorkerExists(exactPid, batchId), 2_000);
  }
  await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 0);
}

test("approved references compile into sourced canonical notes for every QWA-146 subject category without retaining staging", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail, calendar }) => {
    const result = await compileApprovedRecords({
      message: "Compile my approved canonical notes",
      stateStore,
      staging,
      batchId: "fixture-full-batch",
      approvedRecords: allApprovedRecords(gmail, calendar),
      clock: clockAt(laterToday)
    });

    assert.equal(result.compilation.status, "compiled");
    assert.equal(result.compilation.live, false);
    assert.equal(result.compilation.simulated, true);
    assert.equal(result.compilation.rawSourceBodiesRetained, false);
    assert.equal(result.compilation.staging.status, "deleted-after-compilation");
    assert.equal(result.compilation.staging.deletedAt, laterToday);
    assert.equal(result.claims.length, 8);
    assert.deepEqual(
      result.canonicalNotes.map((note) => note.subject.type).sort(),
      [...CANONICAL_SUBJECT_TYPES].sort()
    );
    assert.equal(result.sourceIndexes.length, 2);
    assert.equal(gmail.connector.bodyFetchCalls, 0, "the compiler does not fetch a source body");
    assert.equal(calendar.connector.bodyFetchCalls, 0, "the compiler does not fetch a source body");

    for (const claim of result.claims) {
      assert.match(claim.id, /^claim-[a-f0-9]{20}$/);
      assert.equal(claim.confidence, "confirmed");
      assert.equal(claim.observedAt, startedAt);
      assert.equal(claim.verifiedAt, laterToday);
      assert.deepEqual(claim.privacyRestrictions, ["no-external-sharing", "private"]);
      assert.equal(claim.sourceReferences.length, 1);
      const reference = claim.sourceReferences[0];
      assert.match(reference.sourceRecordId, /^fixture-(mail|event)-001$/);
      assert.equal(reference.sourceTimestamp, startedAt);
      assert.equal(reference.processedAt, laterToday);
      assert.equal(reference.sourceLabel, "Fixture metadata only");
      if (reference.source === "gmail") {
        assert.deepEqual(reference.approvedParticipantRefs, ["person-fixture-alex"]);
        assert.equal(reference.stableLink, "https://fixture.example.test/mail/fixture-mail-001");
      } else {
        assert.deepEqual(reference.approvedParticipantRefs, []);
        assert.equal(reference.stableLink, null);
      }
    }

    const personNote = result.canonicalNotes.find((note) => note.subject.type === "people");
    assert.match(personNote.path, /^People\/person-fixture-alex\.md$/);
    assert.match(personNote.content, /Generated canonical claims/);
    assert.match(personNote.content, /Your notes/);
    assert.match(personNote.content, /user-owned and is never overwritten/);
    assert.match(personNote.content, /Fixture Alex owns the Atlas project/);
    assert.match(personNote.content, /claim-[a-f0-9]{20}/);
    assert.match(personNote.content, /Approved participant references: `person-fixture-alex`/);
    assert.match(personNote.content, /Stable link/);

    const gmailIndex = result.sourceIndexes.find((index) => index.source === "gmail");
    assert.match(gmailIndex.path, /^Sources\/gmail--fixture-gmail-account\.md$/);
    assert.match(gmailIndex.content, /Authoritative claims remain in the linked canonical notes/);
    assert.match(gmailIndex.content, /\[\[People\/person-fixture-alex\]\]/);
    assert.equal(gmailIndex.content.includes("Fixture Alex owns the Atlas project."), false, "source indexes navigate but do not duplicate claim authority");
    assert.equal(Object.hasOwn(gmailIndex.entries[0], "assertion"), false);
    assert.equal(gmailIndex.entries[0].sourceTimestamp, startedAt);
    assert.deepEqual(gmailIndex.entries[0].approvedParticipantRefs, ["person-fixture-alex"]);
    assert.equal(gmailIndex.entries[0].stableLink, "https://fixture.example.test/mail/fixture-mail-001");

    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
    assert.equal(JSON.stringify(result).includes(directory), false, "public output never exposes a local staging path");

    const status = await getKnowledgeCompilationStatus({ stateStore, batchId: "fixture-full-batch" });
    assert.equal(status.compilation.status, "compiled");
    assert.equal(status.result.claimCount, 8);
  });
});

test("Spanish output renders unknown evidence explicitly instead of inventing a fact", async () => {
  await withCompilerFixture(async ({ stateStore, staging, gmail }) => {
    const result = await compileApprovedRecords({
      message: "Compila mis notas canónicas aprobadas",
      stateStore,
      staging,
      batchId: "fixture-spanish-unknown",
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-fixture-unknown", "Nota pendiente", null, "uncertain", ["private"])
      ], { verifiedAt: null, sourceLabel: null })],
      language: "es",
      clock: clockAt(laterToday)
    });

    assert.equal(result.claims[0].assertion, null);
    assert.equal(result.claims[0].confidence, "uncertain");
    assert.equal(result.claims[0].verifiedAt, null);
    assert.match(result.canonicalNotes[0].content, /Afirmaciones canónicas generadas/);
    assert.match(result.canonicalNotes[0].content, /Desconocido \(sin evidencia aprobada\)/);
    assert.match(result.canonicalNotes[0].content, /Tus notas/);
    assert.match(result.canonicalNotes[0].content, /Approved gmail reference/);
    assert.match(result.compilation.message, /notas canónicas/i);
  }, { language: "es" });
});

test("raw fields, slash commands, and records without an active granular grant fail before staging", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const safeRecord = approvedRecord(gmail, [
      assertion("knowledge", "knowledge-fixture-guard", "Guard", "The record is normalized.")
    ]);
    await assert.rejects(
      () => compileApprovedRecords({
        message: "/compile approved notes",
        stateStore,
        staging,
        batchId: "fixture-slash-command",
        approvedRecords: [safeRecord],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "NO_SLASH_COMMANDS"
    );
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile approved notes",
        stateStore,
        staging,
        batchId: "fixture-raw-field",
        approvedRecords: [{ ...safeRecord, body: "fixture raw body is blocked" }],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "RAW_SOURCE_FIELD_BLOCKED"
    );
    const noGrantRecord = { ...safeRecord, grantId: "missing-grant" };
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile approved notes",
        stateStore,
        staging,
        batchId: "fixture-no-grant",
        approvedRecords: [noGrantRecord],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "ACTIVE_GRANT_REQUIRED"
    );
    const stagingRoot = path.join(directory, ".qwave-second-brain-staging");
    assert.deepEqual(await readdir(stagingRoot), [], "validation may create the protected root, but it never stages a batch");
  });
});

test("safe per-source provenance must exactly match the reviewed QWA-139 metadata before staging", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const base = approvedRecord(gmail, [
      assertion("knowledge", "knowledge-fixture-provenance", "Provenance", "Only reviewed provenance reaches a canonical note.")
    ]);
    const mismatches = [
      { batchId: "fixture-source-time-mismatch", record: { ...base, sourceTimestamp: laterToday } },
      { batchId: "fixture-participant-mismatch", record: { ...base, approvedParticipantRefs: ["person-fixture-other"] } },
      { batchId: "fixture-label-mismatch", record: { ...base, sourceLabel: "Different safe metadata label" } },
      { batchId: "fixture-link-mismatch", record: { ...base, stableLink: "https://fixture.example.test/mail/different-reference" } }
    ];
    for (const mismatch of mismatches) {
      await assert.rejects(
        () => compileApprovedRecords({
          message: "Compile my approved notes",
          stateStore,
          staging,
          batchId: mismatch.batchId,
          approvedRecords: [mismatch.record],
          clock: clockAt(laterToday)
        }),
        (error) => error instanceof KnowledgeCompilationError && error.code === "SOURCE_PROVENANCE_INVALID"
      );
    }
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("temporary staging rejects repository roots and symlink escapes", async () => {
  await assert.rejects(
    async () => new LocalTemporaryStaging({ root: path.join(process.cwd(), ".qwave-second-brain-staging") }),
    (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_PUBLIC_REPOSITORY_BLOCKED"
  );
  await assert.rejects(
    async () => new LocalTemporaryStaging({ root: path.parse(process.cwd()).root }),
    (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_ROOT_TOO_BROAD"
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-security-"));
  try {
    const symlinkParent = path.join(directory, "symlink-parent");
    const symlinkRoot = path.join(symlinkParent, ".qwave-second-brain-staging");
    const target = path.join(directory, "target-directory");
    await mkdir(symlinkParent);
    await mkdir(target);
    await symlink(target, symlinkRoot);
    const linked = fixtureStaging(symlinkRoot);
    await assert.rejects(
      () => linked.stage({ batchId: "linked-batch", records: [inertStagingRecord()], createdAt: startedAt }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_SYMLINK_BLOCKED"
    );

    const safeRoot = path.join(directory, "safe-parent", ".qwave-second-brain-staging");
    await mkdir(path.dirname(safeRoot));
    const safeStaging = fixtureStaging(safeRoot);
    await safeStaging.initialize();
    await assert.rejects(
      () => safeStaging.stage({ batchId: "raw-shape-batch", records: [{ body: "blocked" }], createdAt: startedAt }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "RAW_SOURCE_FIELD_BLOCKED"
    );
    await assert.rejects(
      () => safeStaging.stage({ batchId: "missing-schema-batch", records: [{}], createdAt: startedAt }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "SOURCE_REFERENCE_INVALID"
    );
    await assert.rejects(
      () => safeStaging.stage({
        batchId: "missing-provenance-batch",
        records: [inertStagingRecord({ sourceTimestamp: undefined })],
        createdAt: startedAt
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "SOURCE_TIMESTAMP_REQUIRED"
    );
    const outside = path.join(directory, "outside.json");
    await writeFile(outside, "{}\n", "utf8");
    const symlinkReceipt = await safeStaging.stage({ batchId: "symlink-batch", records: [inertStagingRecord()], createdAt: startedAt });
    const symlinkArtifacts = stagingArtifacts(safeRoot, "symlink-batch", symlinkReceipt.leaseId);
    await unlink(symlinkArtifacts.data);
    await symlink(outside, symlinkArtifacts.data);
    await assert.rejects(
      () => safeStaging.read({ batchId: "symlink-batch", leaseId: symlinkReceipt.leaseId }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_SYMLINK_BLOCKED"
    );

    const tamperedReceipt = await safeStaging.stage({ batchId: "tampered-expiry", records: [inertStagingRecord()], createdAt: startedAt });
    const tamperedArtifacts = stagingArtifacts(safeRoot, "tampered-expiry", tamperedReceipt.leaseId);
    const tamperedPayload = JSON.parse(await readFile(tamperedArtifacts.data, "utf8"));
    tamperedPayload.expiresAt = "2030-01-01T00:00:00.000Z";
    await writeFile(tamperedArtifacts.data, `${JSON.stringify(tamperedPayload)}\n`, "utf8");
    const tamperCleanup = await safeStaging.cleanupExpired({ now: laterToday });
    assert.deepEqual(tamperCleanup.removedBatchIds, ["symlink-batch", "tampered-expiry"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-root initialization serializes lexical aliases and releases the queue after rejection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-initialize-lock-"));
  try {
    const canonicalDirectory = await realpath(directory);
    const root = path.join(canonicalDirectory, ".qwave-second-brain-staging");
    const alias = path.join(canonicalDirectory, "unused", "..", ".qwave-second-brain-staging");
    const entered = deferred();
    const release = deferred();
    let secondEntered = false;
    const first = fixtureStaging(root, {
      fileSystem: {
        async lstat(target) {
          if (path.resolve(String(target)) === canonicalDirectory && !entered.seen) {
            entered.seen = true;
            entered.resolve();
            await release.promise;
          }
          return lstat(target);
        }
      }
    });
    const second = fixtureStaging(alias, {
      fileSystem: {
        async lstat(target) {
          secondEntered = true;
          return lstat(target);
        }
      }
    });
    Object.defineProperty(first, "root", {
      configurable: true,
      value: path.join(canonicalDirectory, "hostile-first-root")
    });
    Object.defineProperty(second, "root", {
      configurable: true,
      value: path.join(canonicalDirectory, "hostile-second-root")
    });

    const firstInitialization = first.initialize();
    await entered.promise;
    const secondInitialization = second.initialize();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    assert.equal(secondEntered, false);
    release.resolve();
    assert.equal(await firstInitialization, root);
    assert.equal(await secondInitialization, root);
    assert.equal(secondEntered, true);

    const failureParent = path.join(canonicalDirectory, "failure-parent");
    await mkdir(failureParent);
    const canonicalFailureParent = await realpath(failureParent);
    const failureRoot = path.join(canonicalFailureParent, ".qwave-second-brain-staging");
    const failureAlias = path.join(canonicalFailureParent, "unused", "..", ".qwave-second-brain-staging");
    const failureEntered = deferred();
    const failureRelease = deferred();
    let recoveryEntered = false;
    const failing = fixtureStaging(failureRoot, {
      fileSystem: {
        async lstat(target) {
          if (path.resolve(String(target)) === canonicalFailureParent && !failureEntered.seen) {
            failureEntered.seen = true;
            failureEntered.resolve();
            await failureRelease.promise;
            throw simulatedIoError("Simulated initialization parent read failure.");
          }
          return lstat(target);
        }
      }
    });
    const recovering = fixtureStaging(failureAlias, {
      fileSystem: {
        async lstat(target) {
          recoveryEntered = true;
          return lstat(target);
        }
      }
    });
    Object.defineProperty(failing, "root", {
      configurable: true,
      value: path.join(canonicalFailureParent, "hostile-failing-root")
    });
    Object.defineProperty(recovering, "root", {
      configurable: true,
      value: path.join(canonicalFailureParent, "hostile-recovering-root")
    });

    const failedInitialization = assert.rejects(
      failing.initialize(),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_PARENT_INVALID"
    );
    await failureEntered.promise;
    const recoveredInitialization = recovering.initialize();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    assert.equal(recoveryEntered, false);
    failureRelease.resolve();
    await failedInitialization;
    assert.equal(await recoveredInitialization, failureRoot);
    assert.equal(recoveryEntered, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exact local staging snapshots authority-critical dependencies and ignores hostile public shadows", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-private-snapshots-"));
  const batchId = "fixture-private-dependency-snapshots";
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    let capturedLstatCalls = 0;
    let capturedUnlinkCalls = 0;
    let hostileCalls = 0;
    const sourceFileSystem = {
      async lstat(target) {
        capturedLstatCalls += 1;
        return lstat(target);
      },
      async unlink(target) {
        capturedUnlinkCalls += 1;
        return unlink(target);
      }
    };
    const sourceClock = clockAt(startedAt);
    const retentionService = new FixtureRetentionService();
    const staging = fixtureStaging(root, {
      clock: sourceClock,
      fileSystem: sourceFileSystem,
      retentionService
    });

    sourceFileSystem.lstat = async () => {
      hostileCalls += 1;
      throw simulatedIoError("A replaced source filesystem must not be consulted.");
    };
    sourceFileSystem.unlink = sourceFileSystem.lstat;
    sourceClock.now = () => {
      hostileCalls += 1;
      throw simulatedIoError("A replaced source clock must not be consulted.");
    };
    retentionService.arm = async () => {
      hostileCalls += 1;
      throw simulatedIoError("A replaced retention arm method must not be consulted.");
    };
    retentionService.disarm = async () => {
      hostileCalls += 1;
      throw simulatedIoError("A replaced retention disarm method must not be consulted.");
    };
    Object.defineProperties(staging, {
      root: { configurable: true, value: path.join(directory, "hostile-root") },
      fileSystem: { configurable: true, value: sourceFileSystem },
      clock: { configurable: true, value: sourceClock },
      retentionService: { configurable: true, value: retentionService },
      expiryTimers: { configurable: true, value: new Map([["hostile", setTimeout(() => {}, 1)]]) },
      startupRemovedBatches: { configurable: true, value: [{ batchId: "fabricated" }] }
    });

    const receipt = await staging.stage({
      batchId,
      records: [inertStagingRecord()],
      createdAt: startedAt
    });
    const artifacts = stagingArtifacts(root, batchId, receipt.leaseId);
    assert.equal(await staging.delete({ batchId, leaseId: receipt.leaseId }), true);
    await assert.rejects(() => lstat(artifacts.data), (error) => error?.code === "ENOENT");
    await assert.rejects(() => lstat(artifacts.lease), (error) => error?.code === "ENOENT");
    assert.equal(hostileCalls, 0);
    assert.equal(capturedLstatCalls > 0, true);
    assert.equal(capturedUnlinkCalls > 0, true);
    assert.equal(retentionService.armed.length, 1);
    assert.equal(retentionService.disarmed.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authority constructors reject coercible paths and limits without invoking caller conversion hooks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-noncoercing-limits-"));
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    let coercionCalls = 0;
    const coercible = {
      valueOf() {
        coercionCalls += 1;
        return 1;
      },
      toString() {
        coercionCalls += 1;
        return "1";
      },
      [Symbol.toPrimitive]() {
        coercionCalls += 1;
        return 1;
      }
    };

    assert.throws(
      () => new FileStateStore(coercible),
      (error) => error instanceof TypeError && /non-empty local file path string/i.test(error.message)
    );
    assert.throws(
      () => new LocalTemporaryStaging({ root, maxRecords: coercible }),
      (error) => error instanceof TypeError && /maxRecords must be a positive safe integer/i.test(error.message)
    );
    assert.throws(
      () => new LocalTemporaryStaging({ root, maxBytes: coercible }),
      (error) => error instanceof TypeError && /maxBytes must be a positive safe integer/i.test(error.message)
    );
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new LocalTemporaryStaging({ root, maxRecords: invalid }),
        (error) => error instanceof TypeError && /maxRecords must be a positive safe integer/i.test(error.message)
      );
      assert.throws(
        () => new LocalTemporaryStaging({ root, maxBytes: invalid }),
        (error) => error instanceof TypeError && /maxBytes must be a positive safe integer/i.test(error.message)
      );
    }
    assert.equal(coercionCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exact state authority ignores hostile public path and method shadows through terminal readback", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const batchId = "fixture-private-state-store-shadows";
    const statePath = stateStore.filePath;
    let hostileCalls = 0;
    Object.defineProperties(stateStore, {
      filePath: {
        configurable: true,
        get() {
          hostileCalls += 1;
          throw simulatedIoError("A public state path shadow must not be consulted.");
        }
      },
      load: {
        configurable: true,
        value: async () => {
          hostileCalls += 1;
          throw simulatedIoError("A public state load shadow must not be consulted.");
        }
      },
      save: {
        configurable: true,
        value: async () => {
          hostileCalls += 1;
          throw simulatedIoError("A public state save shadow must not be consulted.");
        }
      }
    });

    const result = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-private-state-store-shadows", "Private state authority", "Public state-store shadows cannot replace exact durable authority.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(result.compilation.status, "compiled");
    assert.equal(result.compilation.staging.status, "deleted-after-compilation");
    assert.equal(result.compilation.rawSourceBodiesRetained, false);

    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "compiled");
    assert.equal(status.compilation.staging.status, "deleted-after-compilation");
    assert.equal(status.compilation.rawSourceBodiesRetained, false);
    assert.equal(hostileCalls, 0);

    const durable = await new FileStateStore(statePath).load();
    assert.equal(durable.knowledgeCompilationLifecycle.batches[batchId].status, "compiled");
    assert.equal(durable.knowledgeCompilationLifecycle.batches[batchId].staging.status, "deleted-after-compilation");
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("stateful filesystem proxies cannot hide configured methods and regain terminal cleanup authority", async () => {
  for (const dependency of ["staging", "retention"]) {
    await withCompilerFixture(async ({ directory, stateStore, gmail }) => {
      const batchId = `fixture-stateful-${dependency}-filesystem-proxy`;
      const root = path.join(directory, ".qwave-second-brain-staging");
      let ownKeysCalls = 0;
      let unlinkCalls = 0;
      const proxy = new Proxy({
        async unlink(target) {
          unlinkCalls += 1;
          return unlink(target);
        }
      }, {
        ownKeys() {
          ownKeysCalls += 1;
          return ownKeysCalls === 1 ? ["unlink"] : [];
        }
      });
      const staging = dependency === "staging"
        ? new LocalTemporaryStaging({
          root,
          fileSystem: proxy,
          retentionService: new DetachedLocalRetentionService(),
          clock: clockAt(startedAt)
        })
        : new LocalTemporaryStaging({
          root,
          retentionService: new DetachedLocalRetentionService({ fileSystem: proxy }),
          clock: clockAt(startedAt)
        });

      const first = await compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore,
        staging,
        batchId,
        approvedRecords: [approvedRecord(gmail, [
          assertion("knowledge", `knowledge-stateful-${dependency}-filesystem-proxy`, "Stateful dependency proxy", "Configured dependency methods cannot disappear during trust selection.")
        ])],
        clock: clockAt(laterToday)
      });
      assert.equal(first.compilation.status, "compiled");
      assert.equal(first.compilation.staging.status, "result-persisted-pending-deletion");
      assert.equal(first.compilation.retryable, true);
      assert.equal(first.compilation.needsAttention, true);
      assert.equal(first.compilation.rawSourceBodiesRetained, true);
      assert.match(first.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
      assert.equal(ownKeysCalls, 1);
      assert.equal(unlinkCalls, 0);

      const durable = await stateStore.load();
      const artifacts = stagingArtifacts(root, batchId, durable.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId);
      assert.equal((await lstat(artifacts.data)).isFile(), true);
      assert.equal((await lstat(artifacts.lease)).isFile(), true);

      const recovered = await compileApprovedRecords({
        message: "Continue compiling my approved notes",
        stateStore,
        staging: fixtureStaging(root),
        batchId,
        clock: clockAt("2026-08-17T13:05:00.000Z")
      });
      assert.equal(recovered.compilation.status, "compiled");
      assert.equal(recovered.compilation.staging.status, "deleted-after-compilation");
      assert.equal(recovered.compilation.rawSourceBodiesRetained, false);
      assert.deepEqual(await readdir(root), []);
      await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 0);
    });
  }
});

test("configured filesystem hooks cannot certify deletion while native staging paths still exist", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-native-delete-certifier-"));
  const batchId = "fixture-native-delete-certifier";
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    let artifacts = null;
    let fabricateAbsence = false;
    let noOpDeletion = false;
    let interceptedDeletes = 0;
    const staging = fixtureStaging(root, {
      fileSystem: {
        async lstat(target) {
          if (
            fabricateAbsence
            && artifacts
            && [artifacts.data, artifacts.lease]
              .some((candidate) => path.basename(candidate) === path.basename(String(target)))
          ) {
            const error = new Error("Fabricated absence from a configured staging hook.");
            error.code = "ENOENT";
            throw error;
          }
          return lstat(target);
        },
        async unlink(target) {
          if (
            noOpDeletion
            && artifacts
            && [artifacts.data, artifacts.lease]
              .some((candidate) => path.basename(candidate) === path.basename(String(target)))
          ) {
            interceptedDeletes += 1;
            fabricateAbsence = true;
            return;
          }
          return unlink(target);
        }
      }
    });
    const receipt = await staging.stage({
      batchId,
      records: [inertStagingRecord()],
      createdAt: startedAt
    });
    artifacts = stagingArtifacts(root, batchId, receipt.leaseId);
    noOpDeletion = true;

    await assert.rejects(
      () => staging.delete({ batchId, leaseId: receipt.leaseId }),
      (error) => error instanceof KnowledgeCompilationError
        && ["STAGING_DELETE_FAILED", "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION"].includes(error.code)
    );
    assert.equal(interceptedDeletes > 0, true);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention disarm cannot restore a deleted generation behind a terminal result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-disarm-restoration-"));
  const batchId = "fixture-disarm-restoration";
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const retentionService = new FixtureRetentionService();
    const staging = fixtureStaging(root, { retentionService });
    const receipt = await staging.stage({
      batchId,
      records: [inertStagingRecord()],
      createdAt: startedAt
    });
    const artifacts = stagingArtifacts(root, batchId, receipt.leaseId);
    const originalData = await readFile(artifacts.data, "utf8");
    const originalLease = await readFile(artifacts.lease, "utf8");
    retentionService.onDisarm = async () => {
      await writeFile(artifacts.data, originalData, { encoding: "utf8", mode: 0o600 });
      await writeFile(artifacts.lease, originalLease, { encoding: "utf8", mode: 0o600 });
    };

    await assert.rejects(
      () => staging.delete({ batchId, leaseId: receipt.leaseId }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_DELETE_FAILED"
    );
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    assert.deepEqual((await staging.read({ batchId, leaseId: receipt.leaseId })).records, [inertStagingRecord()]);

    retentionService.onDisarm = null;
    assert.equal(await staging.delete({ batchId, leaseId: receipt.leaseId }), true);
    await assert.rejects(() => lstat(artifacts.data), (error) => error?.code === "ENOENT");
    await assert.rejects(() => lstat(artifacts.lease), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a broadened persisted QWA-139 scope fails closed before any batch is staged", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const state = await stateStore.load();
    const entry = state.sourcePermissionLifecycle.entries[`gmail:${encodeURIComponent(gmail.accountId)}`];
    const activeGrant = entry.grants.find((grant) => grant.status === "active");
    activeGrant.scope.categories = ["planning", "unreviewed-category"];
    await stateStore.save(state);

    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore,
        staging,
        batchId: "fixture-tampered-grant",
        approvedRecords: [approvedRecord(gmail, [
          assertion("knowledge", "knowledge-fixture-tampered", "Tampered grant", "A broadened grant is rejected before compilation.")
        ])],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "PERSISTED_GRANT_INVALID"
    );
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("an approved record with a participant omitted from the selected allowlist fails closed before staging", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging }) => {
    const connector = new SimulatedReadOnlyConnector({
      source: "gmail",
      account: { id: "fixture-allowlist-account", label: "Allowlist fixture" },
      people: [
        { id: "person-selected", label: "Selected", accessLevel: "allowed" },
        { id: "person-omitted", label: "Omitted", accessLevel: "allowed" }
      ],
      items: [{
        id: "fixture-allowlist-record",
        kind: "item",
        area: "fixture-area",
        category: "planning",
        timestamp: startedAt,
        participantIds: ["person-selected", "person-omitted"],
        label: "Allowlist record",
        stableLink: "https://fixture.example.test/mail/fixture-allowlist-record"
      }]
    });
    const reviewId = "gmail-allowlist-review";
    const grantId = "gmail-allowlist-grant";
    const review = await beginSourcePermissionReview({
      message: "Review this Gmail source for my second brain",
      stateStore,
      source: "gmail",
      connector,
      clock: clockAt(startedAt),
      reviewIdFactory: () => reviewId
    });
    const scope = scopeForApproval(review);
    scope.people.allowed = ["person-selected"];
    await grantSourcePermission({
      message: "Approve only the selected person in this read-only scope",
      stateStore,
      connector,
      source: "gmail",
      accountId: "fixture-allowlist-account",
      reviewId,
      scope,
      clock: clockAt(startedAt),
      grantIdFactory: () => grantId
    });
    const permission = {
      source: "gmail",
      accountId: "fixture-allowlist-account",
      sourceRecordId: "fixture-allowlist-record",
      reviewId,
      grantId,
      sourceTimestamp: startedAt,
      participantRefs: ["person-selected", "person-omitted"],
      sourceLabel: "Allowlist record",
      stableLink: "https://fixture.example.test/mail/fixture-allowlist-record"
    };

    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore,
        staging,
        batchId: "fixture-omitted-person",
        approvedRecords: [approvedRecord(permission, [
          assertion("people", "person-fixture-omitted", "Omitted person", "This must remain outside the narrowed allowlist.")
        ])],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "RECORD_OUTSIDE_APPROVED_SCOPE"
    );
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("integrity-bound metadata rejects persisted Blocked-to-Allowed promotion before compilation", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging }) => {
    const accountId = "fixture-blocked-integrity-account";
    const sourceRecordId = "fixture-blocked-integrity-group";
    const connector = new SimulatedReadOnlyConnector({
      source: "gmail",
      account: { id: accountId, label: "Blocked integrity fixture" },
      people: [
        { id: "person-allowed", label: "Allowed", accessLevel: "allowed" },
        { id: "person-blocked", label: "Blocked", accessLevel: "blocked" }
      ],
      items: [{
        id: sourceRecordId,
        kind: "conversation",
        isGroup: true,
        area: "inbox",
        category: "planning",
        timestamp: startedAt,
        participantIds: ["person-allowed", "person-blocked"],
        label: "Blocked group record"
      }]
    });
    const reviewId = "blocked-integrity-review";
    const grantId = "blocked-integrity-grant";
    const review = await beginSourcePermissionReview({
      message: "Review this bounded Gmail group",
      stateStore,
      connector,
      source: "gmail",
      clock: clockAt(startedAt),
      reviewIdFactory: () => reviewId
    });
    const scope = scopeForApproval(review);
    scope.blockedGroupConversationExceptions = [sourceRecordId];
    await grantSourcePermission({
      message: "Approve only this separately reviewed group",
      stateStore,
      connector,
      source: "gmail",
      accountId,
      reviewId,
      scope,
      clock: clockAt(startedAt),
      grantIdFactory: () => grantId
    });

    const state = await stateStore.load();
    const entry = state.sourcePermissionLifecycle.entries[`gmail:${encodeURIComponent(accountId)}`];
    const grant = entry.grants.find((candidate) => candidate.status === "active");
    entry.review.metadata.people.find((person) => person.id === "person-blocked").accessLevel = "allowed";
    for (const boundary of [entry.review.requestedScope, grant.scope]) {
      boundary.people.allowed = [...new Set([...boundary.people.allowed, "person-blocked"])].sort();
      boundary.people.blocked = boundary.people.blocked.filter((id) => id !== "person-blocked");
      boundary.exclusions.people = boundary.exclusions.people.filter((id) => id !== "person-blocked");
    }
    await stateStore.save(state);

    const permission = {
      source: "gmail",
      accountId,
      sourceRecordId,
      reviewId,
      grantId,
      sourceTimestamp: startedAt,
      participantRefs: ["person-allowed", "person-blocked"],
      sourceLabel: "Blocked group record",
      stableLink: null
    };
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore,
        staging,
        batchId: "fixture-blocked-integrity",
        approvedRecords: [approvedRecord(permission, [
          assertion("knowledge", "knowledge-blocked-integrity", "Blocked integrity", "This forged promotion must never compile.")
        ])],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "PERSISTED_GRANT_INVALID"
    );
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("metadata, review, and grant corruption cannot promote a Restricted person through fetch or compilation", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging }) => {
    const accountId = "fixture-restricted-integrity-account";
    const sourceRecordId = "fixture-restricted-integrity-record";
    const connector = new SimulatedReadOnlyConnector({
      source: "gmail",
      account: { id: accountId, label: "Restricted integrity fixture" },
      people: [
        { id: "person-allowed", label: "Allowed", accessLevel: "allowed" },
        { id: "person-restricted", label: "Restricted", accessLevel: "restricted" }
      ],
      items: [{
        id: sourceRecordId,
        kind: "item",
        area: "inbox",
        category: "planning",
        timestamp: startedAt,
        participantIds: ["person-allowed"],
        label: "Restricted integrity record"
      }]
    });
    const reviewId = "restricted-integrity-review";
    const grantId = "restricted-integrity-grant";
    const review = await beginSourcePermissionReview({
      message: "Review this bounded Gmail source",
      stateStore,
      connector,
      source: "gmail",
      clock: clockAt(startedAt),
      reviewIdFactory: () => reviewId
    });
    await grantSourcePermission({
      message: "Approve only the default Allowed person",
      stateStore,
      connector,
      source: "gmail",
      accountId,
      reviewId,
      scope: scopeForApproval(review),
      clock: clockAt(startedAt),
      grantIdFactory: () => grantId
    });

    const state = await stateStore.load();
    const entry = state.sourcePermissionLifecycle.entries[`gmail:${encodeURIComponent(accountId)}`];
    const grant = entry.grants.find((candidate) => candidate.status === "active");
    entry.review.metadata.people.find((person) => person.id === "person-restricted").accessLevel = "allowed";
    entry.review.metadata.items[0].participantIds.push("person-restricted");
    for (const boundary of [entry.review.requestedScope, grant.scope]) {
      boundary.people.allowed = [...new Set([...boundary.people.allowed, "person-restricted"])].sort();
      boundary.people.restricted = boundary.people.restricted.filter((id) => id !== "person-restricted");
      boundary.exclusions.people = boundary.exclusions.people.filter((id) => id !== "person-restricted");
    }
    await stateStore.save(state);

    await assert.rejects(
      () => fetchApprovedSourceContent({
        message: "Import the approved Gmail source",
        stateStore,
        connector,
        source: "gmail",
        accountId,
        reviewId,
        clock: clockAt(laterToday)
      }),
      (error) => error?.code === "PERSISTED_GRANT_INVALID"
    );

    const permission = {
      source: "gmail",
      accountId,
      sourceRecordId,
      reviewId,
      grantId,
      sourceTimestamp: startedAt,
      participantRefs: ["person-allowed", "person-restricted"],
      sourceLabel: "Restricted integrity record",
      stableLink: null
    };
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore,
        staging,
        batchId: "fixture-restricted-integrity",
        approvedRecords: [approvedRecord(permission, [
          assertion("knowledge", "knowledge-restricted-integrity", "Restricted integrity", "This forged promotion must never compile.")
        ])],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "PERSISTED_GRANT_INVALID"
    );
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("grant activation rejects a metadata snapshot changed after review", async () => {
  await withCompilerFixture(async ({ directory, stateStore }) => {
    const accountId = "fixture-grant-metadata-integrity-account";
    const connector = new SimulatedReadOnlyConnector({
      source: "gmail",
      account: { id: accountId, label: "Grant integrity fixture" },
      items: [{
        id: "fixture-grant-integrity-record",
        kind: "item",
        area: "inbox",
        category: "planning",
        timestamp: startedAt,
        participantIds: [],
        label: "Grant integrity record"
      }]
    });
    const reviewId = "grant-metadata-integrity-review";
    const review = await beginSourcePermissionReview({
      message: "Review this bounded Gmail source",
      stateStore,
      connector,
      source: "gmail",
      clock: clockAt(startedAt),
      reviewIdFactory: () => reviewId
    });
    const state = await stateStore.load();
    state.sourcePermissionLifecycle.entries[`gmail:${encodeURIComponent(accountId)}`]
      .review.metadata.items[0].sensitiveCategories = ["medical-information"];
    await stateStore.save(state);

    await assert.rejects(
      () => grantSourcePermission({
        message: "Approve this unchanged reviewed scope",
        stateStore,
        connector,
        source: "gmail",
        accountId,
        reviewId,
        scope: scopeForApproval(review),
        clock: clockAt(startedAt),
        grantIdFactory: () => "grant-metadata-integrity-grant"
      }),
      (error) => error?.code === "PERSISTED_METADATA_INVALID"
    );
    await assert.rejects(
      () => lstat(path.join(directory, ".qwave-second-brain-staging")),
      (error) => error?.code === "ENOENT"
    );
  });
});

test("missing or unknown access, sensitivity, and participant metadata fail closed before staging", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const baseline = await stateStore.load();
    const key = `gmail:${encodeURIComponent(gmail.accountId)}`;
    const cases = [
      ["missing-access", (entry) => { delete entry.review.metadata.people[0].accessLevel; }],
      ["unknown-access", (entry) => { entry.review.metadata.people[0].accessLevel = "mystery"; }],
      ["missing-sensitivity", (entry) => { delete entry.review.metadata.items[0].sensitiveCategories; }],
      ["unknown-sensitivity", (entry) => { entry.review.metadata.items[0].sensitiveCategories = ["unknown-private-class"]; }],
      ["malformed-participants", (entry) => { entry.review.metadata.items[0].participantIds = "person-fixture-alex"; }]
    ];
    for (const [label, mutate] of cases) {
      const corrupted = structuredClone(baseline);
      mutate(corrupted.sourcePermissionLifecycle.entries[key]);
      await stateStore.save(corrupted);
      await assert.rejects(
        () => compileApprovedRecords({
          message: "Compile my approved notes",
          stateStore,
          staging,
          batchId: `fixture-${label}`,
          approvedRecords: [approvedRecord(gmail, [
            assertion("knowledge", `knowledge-${label}`, "Metadata integrity", "Malformed metadata must remain outside compilation.")
          ])],
          clock: clockAt(laterToday)
        }),
        (error) => error instanceof KnowledgeCompilationError
          && ["PERSISTED_GRANT_INVALID", "RECORD_OUTSIDE_APPROVED_SCOPE", "SOURCE_PROVENANCE_INVALID"].includes(error.code)
      );
      assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
    }
    await stateStore.save(baseline);
  });
});

test("a recognized sensitive category compiles only when it is explicitly included in the durable grant", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging }) => {
    const accountId = "fixture-explicit-sensitive-account";
    const sourceRecordId = "fixture-explicit-sensitive-record";
    const connector = new SimulatedReadOnlyConnector({
      source: "gmail",
      account: { id: accountId, label: "Explicit sensitive fixture" },
      items: [{
        id: sourceRecordId,
        kind: "item",
        area: "inbox",
        category: "planning",
        timestamp: startedAt,
        participantIds: [],
        sensitiveCategories: ["medical-information"],
        label: "Explicitly reviewed sensitive record"
      }]
    });
    const reviewId = "explicit-sensitive-review";
    const grantId = "explicit-sensitive-grant";
    const review = await beginSourcePermissionReview({
      message: "Review this bounded Gmail source",
      stateStore,
      connector,
      source: "gmail",
      clock: clockAt(startedAt),
      reviewIdFactory: () => reviewId
    });
    const scope = scopeForApproval(review);
    scope.sensitiveGroups.included = ["medical-information"];
    scope.sensitiveGroups.excluded = scope.sensitiveGroups.excluded.filter((category) => category !== "medical-information");
    await grantSourcePermission({
      message: "I explicitly approve the reviewed medical-information category",
      stateStore,
      connector,
      source: "gmail",
      accountId,
      reviewId,
      scope,
      clock: clockAt(startedAt),
      grantIdFactory: () => grantId
    });
    const permission = {
      source: "gmail",
      accountId,
      sourceRecordId,
      reviewId,
      grantId,
      sourceTimestamp: startedAt,
      participantRefs: [],
      sourceLabel: "Explicitly reviewed sensitive record",
      stableLink: null
    };
    const result = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging,
      batchId: "fixture-explicit-sensitive",
      approvedRecords: [approvedRecord(permission, [
        assertion("knowledge", "knowledge-explicit-sensitive", "Explicit sensitive approval", "The recognized category was separately and explicitly approved.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(result.compilation.status, "compiled");
    assert.equal(result.compilation.staging.status, "deleted-after-compilation");
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("recognized sensitivity added after staging invalidates resume instead of becoming ordinary content", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const batchId = "fixture-sensitive-resume-integrity";
    const interrupted = new FailOnceReadStaging(staging);
    const first = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: interrupted,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-sensitive-resume", "Sensitive resume integrity", "A changed metadata snapshot must invalidate resume.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(first.compilation.status, "staged");

    const state = await stateStore.load();
    const entry = state.sourcePermissionLifecycle.entries[`gmail:${encodeURIComponent(gmail.accountId)}`];
    entry.review.metadata.items[0].sensitiveCategories = ["medical-information"];
    entry.review.metadata.sensitiveGroups = [{
      category: "medical-information",
      count: 1,
      itemLabels: [entry.review.metadata.items[0].label]
    }];
    await stateStore.save(state);

    await assert.rejects(
      () => compileApprovedRecords({
        message: "Continue compiling my approved notes",
        stateStore,
        staging,
        batchId,
        clock: clockAt("2026-08-17T13:05:00.000Z")
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "PERSISTED_GRANT_INVALID"
    );
    const durable = await stateStore.load();
    assert.equal(durable.knowledgeCompilationLifecycle.batches[batchId].status, "discarded");
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.rawSourceBodiesRetained, false);
  });
});

test("a descendant public revoke cannot re-enter the compiler lock and overwrite a stale full-root state", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-reentrant-revoke";
    const hookedStore = new HookedStateStore(stateStore);
    hookedStore.hook = () => revokeSourcePermission({
      message: "Revoke this source permission",
      stateStore: hookedStore,
      connector: gmail.connector,
      source: gmail.source,
      accountId: gmail.accountId,
      reviewId: gmail.reviewId,
      clock: clockAt("2026-08-17T13:00:30.000Z")
    });
    const result = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore: hookedStore,
      staging,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-reentrant-revoke", "Re-entry guard", "A descendant callback cannot write through an ancestor transaction.")
      ])],
      clock: clockAt(laterToday)
    });

    assert.equal(result.compilation.status, "compiled");
    assert.equal(hookedStore.hookResult, null);
    assert.equal(hookedStore.hookError?.code, "STATE_LOCK_REENTRANT_OPERATION_BLOCKED");
    const durable = await stateStore.load();
    const entry = durable.sourcePermissionLifecycle.entries[`gmail:${encodeURIComponent(gmail.accountId)}`];
    assert.equal(entry.status, "granted");
    assert.equal(entry.grants.find((grant) => grant.id === gmail.grantId).status, "active");
    const durableBatch = durable.knowledgeCompilationLifecycle.batches[batchId];
    assert.equal(durableBatch.status, "compiled");
    assert.equal(result.compilation.staging.status, "result-persisted-pending-deletion");
    assert.equal(result.compilation.retryable, true);
    assert.equal(result.compilation.needsAttention, true);
    assert.equal(result.compilation.rawSourceBodiesRetained, true);
    assert.match(result.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    const artifacts = stagingArtifacts(root, batchId, durableBatch.staging.leaseId);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);

    const recovered = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(recovered.compilation.status, "compiled");
    assert.equal(recovered.compilation.staging.status, "deleted-after-compilation");
    assert.equal(recovered.compilation.retryable, false);
    assert.equal(recovered.compilation.needsAttention, false);
    assert.equal(recovered.compilation.rawSourceBodiesRetained, false);
    assert.deepEqual(recovered.claims, result.claims);
    assert.deepEqual(await readdir(root), []);
  });
});

test("a transient staging interruption resumes the same protected batch and deletes it after success", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStaging = new FailOnceReadStaging(staging);
    const records = [approvedRecord(gmail, [
      assertion("projects", "project-fixture-resume", "Resume project", "The protected batch can resume after a temporary interruption.")
    ])];
    const interrupted = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId: "fixture-resume-batch",
      approvedRecords: records,
      clock: clockAt(laterToday)
    });
    assert.equal(interrupted.compilation.status, "staged");
    assert.equal(interrupted.interruption.retryable, true);
    assert.equal((await stagedDataNames(path.join(directory, ".qwave-second-brain-staging"))).length, 1);

    const resumed = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging,
      batchId: "fixture-resume-batch",
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(resumed.compilation.status, "compiled");
    assert.equal(resumed.claims.length, 1);
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);

    const idempotent = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging,
      batchId: "fixture-resume-batch",
      clock: clockAt("2026-08-17T13:06:00.000Z")
    });
    assert.deepEqual(idempotent.claims, resumed.claims);
  });
});

test("a disk-staged batch reconciles after a private state-save interruption instead of reporting STAGING_BATCH_EXISTS", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-state-save-retry";
    const interruptedStore = new FailNextSaveStateStore(stateStore);
    interruptedStore.failNextSave = true;
    const records = [approvedRecord(gmail, [
      assertion("projects", "project-fixture-state-retry", "State retry project", "The durable stage can reconcile after a private state interruption.")
    ])];

    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore: interruptedStore,
        staging,
        batchId,
        approvedRecords: records,
        clock: clockAt(laterToday)
      }),
      /Simulated private state save interruption/
    );
    assert.equal((await stagedDataNames(root)).length, 1);

    // Recreate the adapter to model a restart: recovery comes from the
    // bounded on-disk batch, not from the prior instance's memory.
    const restartedStaging = fixtureStaging(root);
    const resumed = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore: interruptedStore,
      staging: restartedStaging,
      batchId,
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(resumed.compilation.status, "compiled");
    assert.equal(resumed.claims.length, 1);
    assert.equal(resumed.compilation.staging.status, "result-persisted-pending-deletion");
    assert.equal(resumed.compilation.retryable, true);
    assert.equal(resumed.compilation.needsAttention, true);
    assert.equal(resumed.compilation.rawSourceBodiesRetained, true);
    assert.match(resumed.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);

    const state = await stateStore.load();
    const entry = state.knowledgeCompilationLifecycle.batches[batchId];
    assert.equal(entry.audit.some((event) => event.type === "approved-normalized-records-reconciled-after-state-save-interruption"), true);
    assert.equal(entry.audit.some((event) => event.reason === "STAGING_BATCH_EXISTS"), false);
    const artifacts = stagingArtifacts(root, batchId, entry.staging.leaseId);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);

    const recovered = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:06:00.000Z")
    });
    assert.equal(recovered.compilation.staging.status, "deleted-after-compilation");
    assert.equal(recovered.compilation.retryable, false);
    assert.equal(recovered.compilation.needsAttention, false);
    assert.equal(recovered.compilation.rawSourceBodiesRetained, false);
    assert.deepEqual(recovered.claims, resumed.claims);
    assert.deepEqual(await readdir(root), []);
  });
});

test("a persistent final result-save failure retains the protected stage and resumes without discarding it", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const interruptedStore = new FailCompiledResultSaveStateStore(stateStore);
    const batchId = "fixture-result-save-retry";
    const first = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore: interruptedStore,
      staging,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("projects", "project-fixture-result-save", "Result save", "The source batch stays private until its compiled result is durable.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(first.compilation.status, "staged");
    assert.equal(first.interruption.code, "RESULT_STATE_SAVE_FAILED");
    assert.equal((await stagedDataNames(root)).length, 1);

    interruptedStore.failCompiledResultSaves = false;
    const resumed = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore: interruptedStore,
      staging,
      batchId,
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(resumed.compilation.status, "compiled");
    assert.equal(resumed.claims.length, 1);
    assert.equal(resumed.compilation.staging.status, "result-persisted-pending-deletion");
    assert.equal(resumed.compilation.retryable, true);
    assert.equal(resumed.compilation.needsAttention, true);
    assert.equal(resumed.compilation.rawSourceBodiesRetained, true);
    assert.match(resumed.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);

    const durable = await stateStore.load();
    const artifacts = stagingArtifacts(root, batchId, durable.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);

    const recovered = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:06:00.000Z")
    });
    assert.equal(recovered.compilation.staging.status, "deleted-after-compilation");
    assert.equal(recovered.compilation.retryable, false);
    assert.equal(recovered.compilation.needsAttention, false);
    assert.equal(recovered.compilation.rawSourceBodiesRetained, false);
    assert.deepEqual(recovered.claims, resumed.claims);
    assert.deepEqual(await readdir(root), []);
  });
});

test("a wrapped cleanup-receipt state store keeps the durable result pending for exact-authority recovery", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const interruptedStore = new FailCompiledCleanupReceiptSaveStateStore(stateStore);
    const batchId = "fixture-cleanup-receipt-retry";
    const first = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore: interruptedStore,
      staging,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-fixture-cleanup-receipt", "Cleanup receipt", "A durable result survives cleanup bookkeeping interruption.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(first.compilation.status, "compiled");
    assert.equal(first.compilation.staging.status, "result-persisted-pending-deletion");
    assert.equal(first.compilation.retryable, true);
    assert.equal(first.compilation.needsAttention, true);
    assert.equal(first.compilation.rawSourceBodiesRetained, true);
    assert.match(first.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    assert.deepEqual(first.interruption, {
      code: "TEMPORARY_STAGING_UNAVAILABLE",
      retryable: true
    });
    assert.equal(first.compilation.claimCount, 1);

    const durableAfterFailure = await stateStore.load();
    const durableEntry = durableAfterFailure.knowledgeCompilationLifecycle.batches[batchId];
    assert.equal(durableEntry.status, "compiled");
    assert.equal(durableEntry.result.claims.length, 1);
    assert.equal(durableEntry.staging.status, "result-persisted-pending-deletion");
    const artifacts = stagingArtifacts(root, batchId, durableEntry.staging.leaseId);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
    await assert.rejects(() => lstat(artifacts.tombstone), (error) => error?.code === "ENOENT");

    const resumed = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(resumed.compilation.status, "compiled");
    assert.equal(resumed.compilation.staging.status, "deleted-after-compilation");
    assert.deepEqual(resumed.claims, durableEntry.result.claims);
    const durableAfterResume = await stateStore.load();
    assert.equal(durableAfterResume.knowledgeCompilationLifecycle.batches[batchId].staging.status, "deleted-after-compilation");
    assert.deepEqual(await readdir(root), []);
  });
});

test("forged completion receipts cannot change lifecycle truth while the exact generation still exists", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const controlled = new ControlledFailureStaging(staging);
    controlled.readFailures = 1;
    const batchId = "fixture-forged-receipts";
    const first = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: controlled,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-forged-receipts", "Receipt integrity", "Only an exact durable cleanup receipt may change lifecycle truth.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(first.compilation.status, "staged");

    const durable = await stateStore.load();
    const leaseId = durable.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const root = path.join(directory, ".qwave-second-brain-staging");
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const forgeries = [
      { version: 999, batchId, leaseId, deletedAt: laterToday },
      { version: 1, batchId, leaseId: "lease-forged-other", deletedAt: laterToday },
      { version: 1, batchId, leaseId, deletedAt: "2026-08-17 13:00:00Z" },
      { version: 1, batchId, leaseId, deletedAt: "2030-01-01T00:00:00.000Z" }
    ];
    for (const forged of forgeries) {
      await writeFile(artifacts.receipt, `${JSON.stringify(forged)}\n`, "utf8");
      await cleanupExpiredKnowledgeStaging({
        stateStore,
        staging: controlled,
        clock: clockAt("2026-08-17T13:01:00.000Z")
      });
      const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
      assert.equal(status.compilation.status, "staged");
      assert.equal(status.compilation.retryable, true);
      assert.equal((await lstat(artifacts.data)).isFile(), true);
      assert.equal((await lstat(artifacts.lease)).isFile(), true);
    }
    await staging.delete({ batchId, leaseId });
  });
});

test("a custom receipt-rename hook cannot certify deletion and exact authority recovers the retained generation", async () => {
  await withCompilerFixture(async ({ directory, stateStore, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    let failReceiptRename = true;
    const staging = fixtureStaging(root, {
      fileSystem: {
        async rename(from, to) {
          if (failReceiptRename && String(to).endsWith(".receipt.json")) {
            failReceiptRename = false;
            throw simulatedIoError("Simulated completion-receipt rename failure.");
          }
          return rename(from, to);
        }
      }
    });
    const batchId = "fixture-receipt-rename-retry";
    const first = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-receipt-rename", "Receipt rename", "A content-free tombstone makes deletion bookkeeping resumable.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(first.compilation.status, "compiled");
    assert.equal(first.compilation.staging.status, "result-persisted-pending-deletion");
    assert.equal(first.compilation.retryable, true);
    assert.equal(first.compilation.needsAttention, true);
    assert.equal(first.compilation.rawSourceBodiesRetained, true);
    assert.match(first.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    assert.equal(failReceiptRename, true, "the untrusted filesystem hook is not invoked to certify terminal cleanup");
    const durable = await stateStore.load();
    const leaseId = durable.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    await assert.rejects(() => lstat(artifacts.tombstone), (error) => error?.code === "ENOENT");
    await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");

    const resumedAt = fixtureTimestamp("2026-08-17T13:02:00.000Z");
    const resumed = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt(resumedAt)
    });
    assert.equal(resumed.compilation.staging.status, "deleted-after-compilation");
    assert.equal(resumed.compilation.staging.deletedAt, resumedAt);
    assert.equal(resumed.compilation.retryable, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("custom staging and wrapped state callbacks remain pending until exact-authority normal-language resume", async () => {
  await withCompilerFixture(async ({ directory, stateStore, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    let failNextRootSync = false;
    const base = fixtureStaging(root, {
      fileSystem: {
        async open(target, flags, mode) {
          if (failNextRootSync && path.basename(String(target)) === ".qwave-second-brain-staging") {
            failNextRootSync = false;
            throw simulatedIoError("Simulated staging-directory fsync failure.");
          }
          return open(target, flags, mode);
        }
      }
    });
    const batchId = "fixture-tombstone-dir-sync-retry";
    const postSaveStore = new AfterCompiledResultSaveStateStore(stateStore, {
      batchId,
      afterSave: async () => { failNextRootSync = true; }
    });
    const first = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore: postSaveStore,
      staging: base,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-tombstone-dir-sync", "Tombstone durability", "Directory durability failures remain explicit and retryable.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(first.compilation.status, "compiled");
    assert.equal(first.compilation.staging.status, "result-persisted-pending-deletion");
    assert.equal(first.compilation.retryable, true);
    assert.equal(first.compilation.needsAttention, true);
    assert.equal(first.compilation.rawSourceBodiesRetained, true);
    assert.match(first.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    assert.equal(postSaveStore.invoked, true);
    assert.equal(failNextRootSync, true, "the custom filesystem hook cannot be invoked to certify deletion");

    const durable = await stateStore.load();
    const leaseId = durable.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    await assert.rejects(() => lstat(artifacts.tombstone), (error) => error?.code === "ENOENT");
    await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");

    const resumed = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:03:00.000Z")
    });
    assert.equal(resumed.compilation.staging.status, "deleted-after-compilation");
    assert.equal(resumed.compilation.retryable, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("discarded pending deletion stays retryable and normal-language resume performs cleanup only", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const controlled = new ControlledFailureStaging(staging);
    controlled.readFailures = 1;
    const batchId = "fixture-discard-cleanup-resume";
    const interrupted = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: controlled,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-discard-cleanup", "Discard cleanup", "Revoked staging remains inert and cleanup-only.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(interrupted.compilation.status, "staged");
    await revokeSourcePermission({
      message: "Revoke this source permission",
      stateStore,
      connector: gmail.connector,
      source: gmail.source,
      accountId: gmail.accountId,
      reviewId: gmail.reviewId,
      clock: clockAt("2026-08-17T13:01:00.000Z")
    });
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Continue compiling my approved notes",
        stateStore,
        staging: controlled,
        batchId,
        clock: clockAt("2026-08-17T13:02:00.000Z")
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "ACTIVE_GRANT_REQUIRED"
    );
    const pending = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(pending.compilation.status, "discarded");
    assert.equal(pending.compilation.staging.status, "discarded-pending-deletion");
    assert.equal(pending.compilation.retryable, true);
    assert.equal(pending.compilation.needsAttention, true);
    assert.equal(pending.compilation.rawSourceBodiesRetained, true);
    assert.match(pending.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    assert.equal(controlled.deleteCalls, 0);

    const resumed = await compileApprovedRecords({
      message: "Continue cleanup of my approved notes",
      stateStore,
      staging,
      batchId,
      clock: clockAt("2026-08-17T13:03:00.000Z")
    });
    assert.equal(resumed.compilation.status, "discarded");
    assert.equal(resumed.compilation.staging.status, "discarded");
    assert.equal(resumed.compilation.retryable, false);
    assert.deepEqual(resumed.cleanup, { completed: true, retryable: false });
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("canonical compilation and a lexical-alias revocation serialize without restoring an active grant", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-revoke-race";
    const pausingStore = new PauseBeforeCompiledResultSaveStateStore(stateStore);
    const compilation = compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore: pausingStore,
      staging,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("decisions", "decision-fixture-revoke-race", "Revoke race", "A stale compiler state cannot restore a revoked grant.")
      ])],
      clock: clockAt(laterToday)
    });
    await pausingStore.resultSaveReached;

    const aliasedStore = new FileStateStore(path.join(directory, "private-state", "..", "private-state", "setup-session.json"));
    let revokeSettled = false;
    const revocation = revokeSourcePermission({
      message: "Revoke this source permission",
      stateStore: aliasedStore,
      connector: gmail.connector,
      source: gmail.source,
      accountId: gmail.accountId,
      reviewId: gmail.reviewId,
      clock: clockAt("2026-08-17T13:01:00.000Z")
    }).finally(() => { revokeSettled = true; });
    try {
      await new Promise((resolvePause) => setTimeout(resolvePause, 40));
      assert.equal(revokeSettled, false, "the competing revoke waits for the compiler's full-root state transaction");
    } finally {
      pausingStore.resolveRelease();
    }
    const [compiled] = await Promise.all([compilation, revocation]);
    assert.equal(compiled.compilation.status, "compiled");
    assert.equal(compiled.compilation.staging.status, "result-persisted-pending-deletion");
    assert.equal(compiled.compilation.retryable, true);
    assert.equal(compiled.compilation.needsAttention, true);
    assert.equal(compiled.compilation.rawSourceBodiesRetained, true);
    assert.match(compiled.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);

    const state = await stateStore.load();
    const permissionEntry = state.sourcePermissionLifecycle.entries[`gmail:${encodeURIComponent(gmail.accountId)}`];
    assert.equal(permissionEntry.status, "revoked");
    assert.equal(permissionEntry.grants.find((grant) => grant.id === gmail.grantId).status, "revoked");
    const durableBatch = state.knowledgeCompilationLifecycle.batches[batchId];
    assert.equal(durableBatch.status, "compiled");
    const artifacts = stagingArtifacts(root, batchId, durableBatch.staging.leaseId);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);

    const recovered = await compileApprovedRecords({
      message: "Continue cleanup of my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(recovered.compilation.status, "compiled");
    assert.equal(recovered.compilation.staging.status, "deleted-after-compilation");
    assert.equal(recovered.compilation.retryable, false);
    assert.equal(recovered.compilation.needsAttention, false);
    assert.equal(recovered.compilation.rawSourceBodiesRetained, false);
    assert.deepEqual(recovered.claims, compiled.claims);
    const recoveredState = await stateStore.load();
    const recoveredPermission = recoveredState.sourcePermissionLifecycle.entries[`gmail:${encodeURIComponent(gmail.accountId)}`];
    assert.equal(recoveredPermission.status, "revoked");
    assert.equal(recoveredPermission.grants.find((grant) => grant.id === gmail.grantId).status, "revoked");
    assert.deepEqual(await readdir(root), []);
  });
});

test("an untracked disk stage is discarded if its QWA-139 grant is revoked before recovery", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const interruptedStore = new FailNextSaveStateStore(stateStore);
    interruptedStore.failNextSave = true;
    const batchId = "fixture-untracked-revoked";
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore: interruptedStore,
        staging,
        batchId,
        approvedRecords: [approvedRecord(gmail, [
          assertion("decisions", "decision-fixture-untracked-revoked", "Untracked revoked", "A revoked grant cannot recover an untracked stage.")
        ])],
        clock: clockAt(laterToday)
      }),
      /Simulated private state save interruption/
    );
    await revokeSourcePermission({
      message: "Revoke this source permission",
      stateStore,
      connector: gmail.connector,
      source: gmail.source,
      accountId: gmail.accountId,
      reviewId: gmail.reviewId,
      clock: clockAt("2026-08-17T13:01:00.000Z")
    });

    await assert.rejects(
      () => compileApprovedRecords({
        message: "Continue compiling my approved notes",
        stateStore: interruptedStore,
        staging: fixtureStaging(root),
        batchId,
        clock: clockAt("2026-08-17T13:02:00.000Z")
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "ACTIVE_GRANT_REQUIRED"
    );
    const pending = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(pending.compilation.status, "discarded");
    assert.equal(pending.compilation.staging.status, "discarded-pending-deletion");
    assert.equal(pending.compilation.retryable, true);
    assert.equal(pending.compilation.needsAttention, true);
    assert.equal(pending.compilation.rawSourceBodiesRetained, true);
    assert.match(pending.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    const durable = await stateStore.load();
    const durableBatch = durable.knowledgeCompilationLifecycle.batches[batchId];
    const artifacts = stagingArtifacts(root, batchId, durableBatch.staging.leaseId);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);

    const recovered = await compileApprovedRecords({
      message: "Continue cleanup of my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:03:00.000Z")
    });
    assert.equal(recovered.compilation.status, "discarded");
    assert.equal(recovered.compilation.staging.status, "discarded");
    assert.equal(recovered.compilation.retryable, false);
    assert.equal(recovered.compilation.rawSourceBodiesRetained, false);
    assert.deepEqual(recovered.cleanup, { completed: true, retryable: false });
    assert.deepEqual(await readdir(root), []);
  });
});

test("a QWA-139 revocation between interruption and resume deletes staged references before compilation", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStaging = new FailOnceReadStaging(staging);
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId: "fixture-revoked-resume",
      approvedRecords: [approvedRecord(gmail, [
        assertion("decisions", "decision-fixture-revoked", "Revoked decision", "The grant must still be active at resume time.")
      ])],
      clock: clockAt(laterToday)
    });
    await revokeSourcePermission({
      message: "Revoke this source permission",
      stateStore,
      connector: gmail.connector,
      source: gmail.source,
      accountId: gmail.accountId,
      reviewId: gmail.reviewId,
      clock: clockAt("2026-08-17T13:01:00.000Z")
    });
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Continue compiling my approved notes",
        stateStore,
        staging,
        batchId: "fixture-revoked-resume",
        clock: clockAt("2026-08-17T13:02:00.000Z")
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "ACTIVE_GRANT_REQUIRED"
    );
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
    const status = await getKnowledgeCompilationStatus({ stateStore, batchId: "fixture-revoked-resume" });
    assert.equal(status.compilation.status, "discarded");
    assert.equal(status.compilation.rawSourceBodiesRetained, false);
  });
});

test("the 24-hour cleanup deletes interrupted staging and makes resume fail closed", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStaging = new FailOnceReadStaging(staging);
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId: "fixture-expiry-batch",
      approvedRecords: [approvedRecord(gmail, [
        assertion("meetings", "meeting-fixture-expiry", "Expiry meeting", "The temporary batch expires after one day.")
      ])],
      clock: clockAt(startedAt)
    });
    assert.equal((await stagedDataNames(path.join(directory, ".qwave-second-brain-staging"))).length, 1);

    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging,
      clock: clockAt("2026-08-18T12:00:00.000Z")
    });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, ["fixture-expiry-batch"]);
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Continue compiling my approved notes",
        stateStore,
        staging,
        batchId: "fixture-expiry-batch",
        clock: clockAt("2026-08-18T12:00:00.000Z")
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_EXPIRED"
    );
  });
});

test("a fresh staging adapter removes an expired durable batch on restart and leaves an expiry tombstone", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStaging = new FailOnceReadStaging(staging);
    const batchId = "fixture-restart-expiry";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("meetings", "meeting-fixture-restart-expiry", "Restart expiry", "The durable staging expiry is checked after a restart.")
      ])],
      clock: clockAt(startedAt)
    });

    const durable = await stateStore.load();
    const leaseId = durable.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const root = path.join(directory, ".qwave-second-brain-staging");
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const stale = JSON.parse(await readFile(artifacts.data, "utf8"));
    stale.createdAt = "2020-01-01T00:00:00.000Z";
    stale.expiresAt = "2020-01-02T00:00:00.000Z";
    await writeFile(artifacts.data, `${JSON.stringify(stale)}\n`, "utf8");
    const staleLease = JSON.parse(await readFile(artifacts.lease, "utf8"));
    staleLease.createdAt = stale.createdAt;
    staleLease.expiresAt = stale.expiresAt;
    await writeFile(artifacts.lease, `${JSON.stringify(staleLease)}\n`, "utf8");

    const restartedStaging = fixtureStaging(root);
    await restartedStaging.initialize();
    assert.deepEqual(await stagedDataNames(root), []);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".tombstone.json")), true);

    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: restartedStaging,
      clock: clockAt("2026-08-17T13:00:00.000Z")
    });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, [batchId]);
    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "expired");
    assert.equal(status.compilation.staging.status, "expired-deleted");
    assert.equal(status.compilation.staging.cause, null);
    assert.match(status.compilation.message, /expired/i);
    assert.doesNotMatch(status.compilation.message, /available/i);
    assert.deepEqual(await readdir(root), []);
  });
});

test("restart preserves a staged generation when its lease marker has a transient read failure", async () => {
  await withCompilerFixture(async ({ directory, stateStore, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-restart-lease-eio";
    const durableStaging = fixtureStaging(root, { retentionService: new FixtureRetentionService() });
    const first = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(durableStaging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-restart-lease-eio", "Lease recovery", "A transient lease read failure preserves the staged generation.")
      ])],
      clock: clockAt(startedAt)
    });
    assert.equal(first.compilation.status, "staged");

    const beforeState = structuredClone(await stateStore.load());
    const leaseId = beforeState.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const originalData = await readFile(artifacts.data, "utf8");
    const originalLease = await readFile(artifacts.lease, "utf8");

    const initializationFailure = oneShotReadFailureFileSystem(
      artifacts.lease,
      "simulated transient lease-marker read failure"
    );
    const failedInitialization = fixtureStaging(root, {
      retentionService: new FixtureRetentionService(),
      fileSystem: initializationFailure.fileSystem
    });
    initializationFailure.arm();
    await assert.rejects(
      () => failedInitialization.initialize(),
      (error) => error?.code === "EIO"
    );
    assert.equal(initializationFailure.injections, 1);
    await assertStagedGenerationUntouched({ stateStore, beforeState, artifacts, originalData, originalLease });

    const cleanupFailure = oneShotReadFailureFileSystem(
      artifacts.lease,
      "simulated transient lease-marker cleanup failure"
    );
    const failedCleanup = fixtureStaging(root, {
      retentionService: new FixtureRetentionService(),
      fileSystem: cleanupFailure.fileSystem
    });
    await failedCleanup.initialize();
    cleanupFailure.arm();
    await assert.rejects(
      () => failedCleanup.cleanupExpired({ now: laterToday }),
      (error) => error?.code === "EIO"
    );
    assert.equal(cleanupFailure.injections, 1);
    await assertStagedGenerationUntouched({ stateStore, beforeState, artifacts, originalData, originalLease });

    const recovered = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(recovered.compilation.status, "compiled");
    assert.equal(recovered.compilation.staging.status, "deleted-after-compilation");
    assert.deepEqual(await readdir(root), []);
  });
});

test("restart preserves a staged generation when its payload has a transient read failure", async () => {
  await withCompilerFixture(async ({ directory, stateStore, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-restart-payload-eio";
    const durableStaging = fixtureStaging(root, { retentionService: new FixtureRetentionService() });
    const first = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(durableStaging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-restart-payload-eio", "Payload recovery", "A transient payload read failure preserves the staged generation.")
      ])],
      clock: clockAt(startedAt)
    });
    assert.equal(first.compilation.status, "staged");

    const beforeState = structuredClone(await stateStore.load());
    const leaseId = beforeState.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const originalData = await readFile(artifacts.data, "utf8");
    const originalLease = await readFile(artifacts.lease, "utf8");

    const initializationFailure = oneShotReadFailureFileSystem(
      artifacts.data,
      "simulated transient payload read failure"
    );
    const failedInitialization = fixtureStaging(root, {
      retentionService: new FixtureRetentionService(),
      fileSystem: initializationFailure.fileSystem
    });
    initializationFailure.arm();
    await assert.rejects(
      () => failedInitialization.initialize(),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_READ_FAILED"
    );
    assert.equal(initializationFailure.injections, 1);
    await assertStagedGenerationUntouched({ stateStore, beforeState, artifacts, originalData, originalLease });

    const cleanupFailure = oneShotReadFailureFileSystem(
      artifacts.data,
      "simulated transient payload cleanup failure"
    );
    const failedCleanup = fixtureStaging(root, {
      retentionService: new FixtureRetentionService(),
      fileSystem: cleanupFailure.fileSystem
    });
    await failedCleanup.initialize();
    cleanupFailure.arm();
    await assert.rejects(
      () => failedCleanup.cleanupExpired({ now: laterToday }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_READ_FAILED"
    );
    assert.equal(cleanupFailure.injections, 1);
    await assertStagedGenerationUntouched({ stateStore, beforeState, artifacts, originalData, originalLease });

    const malformedPayload = fixtureStaging(root, { retentionService: new FixtureRetentionService() });
    await malformedPayload.initialize();
    await writeFile(artifacts.data, "{not valid JSON", "utf8");
    await assert.rejects(
      () => malformedPayload.read({ batchId, leaseId }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_PAYLOAD_INVALID"
    );
    await writeFile(artifacts.data, originalData, "utf8");
    await assertStagedGenerationUntouched({ stateStore, beforeState, artifacts, originalData, originalLease });

    const recovered = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(recovered.compilation.status, "compiled");
    assert.equal(recovered.compilation.staging.status, "deleted-after-compilation");
    assert.deepEqual(await readdir(root), []);
  });
});

test("restart keeps unexplained prepared-file absence and hard-link residue armed without false cleanup receipts", async () => {
  for (const scenario of ["absent", "hard-linked"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `qwave-second-brain-qwa146-restart-${scenario}-`));
    try {
      const root = path.join(directory, ".qwave-second-brain-staging");
      const batchId = `fixture-restart-${scenario}`;
      const staged = fixtureStaging(root);
      const receipt = await staged.stage({
        batchId,
        records: [inertStagingRecord({ sourceRecordId: `fixture-restart-${scenario}-record` })],
        createdAt: new Date().toISOString()
      });
      const artifacts = stagingArtifacts(root, batchId, receipt.leaseId);
      const survivor = path.join(directory, `${scenario}-survivor.json`);
      if (scenario === "absent") {
        await unlink(artifacts.data);
        const preparedLease = JSON.parse(await readFile(artifacts.lease, "utf8"));
        preparedLease.phase = "prepared";
        await writeFile(artifacts.lease, `${JSON.stringify(preparedLease)}\n`, "utf8");
      } else {
        await link(artifacts.data, survivor);
      }

      const restartedRetention = new FixtureRetentionService();
      const restarted = fixtureStaging(root, { retentionService: restartedRetention });
      await restarted.initialize();
      const cleanup = await restarted.cleanupExpired({
        now: new Date(Date.now() + (scenario === "absent" ? 25 * 60 * 60 * 1_000 : 60_000)).toISOString()
      });

      assert.deepEqual(cleanup.removedBatchIds, []);
      assert.deepEqual(cleanup.completionReceipts, []);
      assert.equal(restartedRetention.armed.length >= 1, true);
      assert.equal(restartedRetention.armed.every((entry) => (
        entry.batchId === batchId && entry.leaseId === receipt.leaseId
      )), true);
      assert.equal((await lstat(artifacts.lease)).isFile(), true);
      await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
      const tombstone = JSON.parse(await readFile(artifacts.tombstone, "utf8"));
      assert.equal(tombstone.dataUnlinkVerified, false);

      if (scenario === "absent") {
        await assert.rejects(() => lstat(artifacts.data), (error) => error?.code === "ENOENT");
      } else {
        assert.equal((await lstat(artifacts.data)).nlink, 2);
        assert.equal((await lstat(survivor)).nlink, 2);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("valid-generation hard-link residue survives restart as exact public needs-attention and clears only after verified cleanup", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-restart-hardlink-public-attention";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-restart-hardlink-public-attention", "Restart hard-link truth", "A valid generation remains needs-attention until its extra filesystem link is removed.")
      ])],
      clock: clockAt(startedAt)
    });

    const stagedState = await stateStore.load();
    const leaseId = stagedState.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const survivor = path.join(directory, "restart-hardlink-public-survivor.json");
    await link(artifacts.data, survivor);

    const restarted = fixtureStaging(root);
    const blockedCleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: restarted,
      clock: clockAt("2026-08-18T13:00:00.000Z")
    });
    assert.deepEqual(blockedCleanup.cleanup.expiredBatchIds, []);
    assert.deepEqual(blockedCleanup.cleanup.needsAttentionBatchIds, [batchId]);

    const blockedStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(blockedStatus.compilation.status, "staged");
    assert.equal(blockedStatus.compilation.staging.status, "cleanup-needs-attention");
    assert.equal(blockedStatus.compilation.staging.needsAttention, true);
    assert.equal(blockedStatus.compilation.needsAttention, true);
    assert.equal(blockedStatus.compilation.retryable, true);
    assert.match(blockedStatus.compilation.message, /filesystem link/i);
    assert.doesNotMatch(blockedStatus.compilation.message, /24 hours/i);

    const blockedState = await stateStore.load();
    const blockedEntry = blockedState.knowledgeCompilationLifecycle.batches[batchId];
    assert.equal(blockedEntry.staging.leaseId, leaseId);
    assert.equal(blockedEntry.staging.cleanupNeedsAttention, "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION");
    assert.equal((await lstat(artifacts.data)).nlink, 2);
    assert.equal((await lstat(survivor)).nlink, 2);
    await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
    assert.equal(JSON.parse(await readFile(artifacts.tombstone, "utf8")).dataUnlinkVerified, false);

    await unlink(survivor);
    const recoveredCleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: restarted,
      clock: clockAt("2026-08-18T13:05:00.000Z")
    });
    assert.deepEqual(recoveredCleanup.cleanup.needsAttentionBatchIds, []);
    assert.deepEqual(recoveredCleanup.cleanup.expiredBatchIds, [batchId]);
    const recoveredStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(recoveredStatus.compilation.status, "expired");
    assert.equal(recoveredStatus.compilation.staging.status, "expired-deleted");
    assert.equal(recoveredStatus.compilation.staging.needsAttention, false);
    assert.equal(recoveredStatus.compilation.needsAttention, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("valid-generation unexplained absence survives restart as exact public needs-attention and clears only after verified recovery", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-restart-absence-public-attention";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-restart-absence-public-attention", "Restart absence truth", "An unexplained valid-generation absence remains needs-attention until exact cleanup can be verified.")
      ])],
      clock: clockAt(startedAt)
    });

    const stagedState = await stateStore.load();
    const leaseId = stagedState.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const originalData = await readFile(artifacts.data, "utf8");
    await unlink(artifacts.data);
    const preparedLease = JSON.parse(await readFile(artifacts.lease, "utf8"));
    preparedLease.phase = "prepared";
    await writeFile(artifacts.lease, `${JSON.stringify(preparedLease)}\n`, "utf8");

    const restarted = fixtureStaging(root);
    const blockedCleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: restarted,
      clock: clockAt("2026-08-18T13:00:00.000Z")
    });
    assert.deepEqual(blockedCleanup.cleanup.expiredBatchIds, []);
    assert.deepEqual(blockedCleanup.cleanup.needsAttentionBatchIds, [batchId]);

    const blockedStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(blockedStatus.compilation.status, "staged");
    assert.equal(blockedStatus.compilation.staging.status, "cleanup-needs-attention");
    assert.equal(blockedStatus.compilation.staging.needsAttention, true);
    assert.equal(blockedStatus.compilation.needsAttention, true);
    assert.equal(blockedStatus.compilation.retryable, true);
    assert.match(blockedStatus.compilation.message, /could not verify deletion/i);
    assert.doesNotMatch(blockedStatus.compilation.message, /24 hours/i);

    const blockedState = await stateStore.load();
    const blockedEntry = blockedState.knowledgeCompilationLifecycle.batches[batchId];
    assert.equal(blockedEntry.staging.leaseId, leaseId);
    assert.equal(blockedEntry.staging.cleanupNeedsAttention, "STAGING_FILE_IDENTITY_CHANGED");
    await assert.rejects(() => lstat(artifacts.data), (error) => error?.code === "ENOENT");
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
    assert.equal(JSON.parse(await readFile(artifacts.tombstone, "utf8")).dataUnlinkVerified, false);

    await writeFile(artifacts.data, originalData, { encoding: "utf8", mode: 0o600 });
    const recoveredCleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: restarted,
      clock: clockAt("2026-08-18T13:05:00.000Z")
    });
    assert.deepEqual(recoveredCleanup.cleanup.needsAttentionBatchIds, []);
    assert.deepEqual(recoveredCleanup.cleanup.expiredBatchIds, [batchId]);
    const recoveredStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(recoveredStatus.compilation.status, "expired");
    assert.equal(recoveredStatus.compilation.staging.status, "expired-deleted");
    assert.equal(recoveredStatus.compilation.staging.needsAttention, false);
    assert.equal(recoveredStatus.compilation.needsAttention, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("tracked missing-lease restart cleanup binds the filename generation to the persisted lifecycle", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-tracked-missing-lease";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-tracked-missing-lease", "Tracked missing lease", "A missing lease is reconciled only through the exact persisted generation tag.")
      ])],
      clock: clockAt(startedAt)
    });

    const stagedState = await stateStore.load();
    const leaseId = stagedState.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    await unlink(artifacts.lease);

    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: fixtureStaging(root),
      clock: clockAt(laterToday)
    });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, []);
    assert.deepEqual(cleanup.cleanup.needsAttentionBatchIds, []);
    for (const target of [artifacts.data, artifacts.lease]) {
      await assert.rejects(() => lstat(target), (error) => error?.code === "ENOENT");
    }

    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "discarded");
    assert.equal(status.compilation.staging.status, "discarded-orphaned-generation");
    assert.equal(status.compilation.staging.cause, "orphaned-generation");
    assert.equal(status.compilation.staging.needsAttention, false);
    assert.equal(status.compilation.retryable, false);
    assert.equal(typeof status.compilation.staging.deletedAt, "string");
    assert.doesNotMatch(status.compilation.message, /expired|available/i);
    await waitFor(async () => (await readdir(root)).length === 0);
    assert.deepEqual(await readdir(root), []);
  });
});

test("wrapped cleanup callbacks cannot delete, restore, or certify a tracked generation", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-wrapped-cleanup-authority";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-wrapped-cleanup-authority", "Wrapped cleanup authority", "A protocol-shaped adapter cannot certify deletion of private staging.")
      ])],
      clock: clockAt(startedAt)
    });

    const stagedState = await stateStore.load();
    const leaseId = stagedState.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const originalData = await readFile(artifacts.data, "utf8");
    const originalLease = await readFile(artifacts.lease, "utf8");
    const calls = { delete: 0, cleanupExpired: 0, acknowledgeCleanupReceipt: 0 };
    const hostileWrapper = {
      stage: (input) => staging.stage(input),
      read: (input) => staging.read(input),
      async delete(input) {
        calls.delete += 1;
        await staging.delete(input);
        await writeFile(artifacts.data, originalData, { encoding: "utf8", mode: 0o600 });
        await writeFile(artifacts.lease, originalLease, { encoding: "utf8", mode: 0o600 });
        throw simulatedIoError("A hostile wrapper restored the deleted generation.");
      },
      async cleanupExpired(input) {
        calls.cleanupExpired += 1;
        await staging.cleanupExpired(input);
        await writeFile(artifacts.data, originalData, { encoding: "utf8", mode: 0o600 });
        await writeFile(artifacts.lease, originalLease, { encoding: "utf8", mode: 0o600 });
        return {
          removedBatches: [{ batchId, leaseId, reason: "expired" }],
          cleanupNeedsAttentionBatches: [],
          completionReceipts: []
        };
      },
      async acknowledgeCleanupReceipt(input) {
        calls.acknowledgeCleanupReceipt += 1;
        return staging.acknowledgeCleanupReceipt(input);
      }
    };
    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: hostileWrapper,
      clock: clockAt("2026-08-18T12:00:00.000Z")
    });
    assert.deepEqual(calls, { delete: 0, cleanupExpired: 0, acknowledgeCleanupReceipt: 0 });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(cleanup.cleanup.needsAttentionBatchIds, [batchId]);
    assert.equal(cleanup.cleanup.rawSourceBodiesRetained, true);

    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "expired");
    assert.equal(status.compilation.staging.status, "expired-pending-deletion");
    assert.equal(status.compilation.staging.deletedAt, null);
    assert.equal(status.compilation.staging.needsAttention, true);
    assert.equal(status.compilation.needsAttention, true);
    assert.equal(status.compilation.retryable, true);
    assert.equal(status.compilation.rawSourceBodiesRetained, true);
    assert.match(status.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);

    const recovered = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging,
      clock: clockAt("2026-08-18T12:05:00.000Z")
    });
    assert.deepEqual(recovered.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(recovered.cleanup.needsAttentionBatchIds, []);
    assert.equal(recovered.cleanup.rawSourceBodiesRetained, false);
    const recoveredStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(recoveredStatus.compilation.status, "expired");
    assert.equal(recoveredStatus.compilation.staging.status, "expired-deleted");
    assert.equal(recoveredStatus.compilation.staging.needsAttention, false);
    assert.equal(recoveredStatus.compilation.retryable, false);
    assert.equal(recoveredStatus.compilation.rawSourceBodiesRetained, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("a protocol-shaped legacy cleanup result cannot certify deletion without exact local authority", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-legacy-wrapper-cleanup";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-legacy-wrapper-cleanup", "Legacy wrapper cleanup", "Exact lease-shaped output is not deletion authority.")
      ])],
      clock: clockAt(startedAt)
    });

    const stagedState = await stateStore.load();
    const leaseId = stagedState.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    let cleanupCalls = 0;
    const legacyCleanupAdapter = {
      stage: (input) => staging.stage(input),
      read: (input) => staging.read(input),
      delete: (input) => staging.delete(input),
      async cleanupExpired() {
        cleanupCalls += 1;
        return {
          removedBatches: [{ batchId, leaseId, reason: "expired" }],
          cleanupNeedsAttentionBatches: [],
          completionReceipts: []
        };
      }
    };

    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: legacyCleanupAdapter,
      clock: clockAt("2026-08-18T12:00:00.000Z")
    });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(cleanup.cleanup.needsAttentionBatchIds, [batchId]);
    assert.equal(cleanup.cleanup.rawSourceBodiesRetained, true);
    assert.equal(cleanupCalls, 0);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);

    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "expired");
    assert.equal(status.compilation.staging.status, "expired-pending-deletion");
    assert.equal(status.compilation.staging.deletedAt, null);
    assert.equal(status.compilation.staging.needsAttention, true);
    assert.equal(status.compilation.needsAttention, true);
    assert.equal(status.compilation.rawSourceBodiesRetained, true);
    assert.match(status.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);

    const recovered = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging,
      clock: clockAt("2026-08-18T12:05:00.000Z")
    });
    assert.deepEqual(recovered.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(recovered.cleanup.needsAttentionBatchIds, []);
    const recoveredStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(recoveredStatus.compilation.status, "expired");
    assert.equal(recoveredStatus.compilation.staging.status, "expired-deleted");
    assert.equal(recoveredStatus.compilation.staging.needsAttention, false);
    assert.equal(recoveredStatus.compilation.rawSourceBodiesRetained, false);
    assert.equal(recoveredStatus.compilation.retryable, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("a custom cleanup EIO hook cannot certify deletion and exact authority recovers the retained generation", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(await realpath(directory), ".qwave-second-brain-staging");
    const batchId = "fixture-exact-cleanup-readback-eio";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-exact-cleanup-readback-eio", "Cleanup readback error", "A transient exact cleanup readback error preserves conservative lifecycle truth.")
      ])],
      clock: clockAt(startedAt)
    });

    const before = await stateStore.load();
    const entry = before.knowledgeCompilationLifecycle.batches[batchId];
    const artifacts = stagingArtifacts(root, batchId, entry.staging.leaseId);
    let failReadback = false;
    const customCalls = { unlink: 0, lstat: 0 };
    const untrustedStaging = fixtureStaging(root, {
      fileSystem: {
        async unlink(target) {
          customCalls.unlink += 1;
          const result = await unlink(target);
          if (path.resolve(String(target)) === path.resolve(artifacts.lease)) failReadback = true;
          return result;
        },
        async lstat(target) {
          customCalls.lstat += 1;
          if (failReadback && path.resolve(String(target)) === path.resolve(artifacts.data)) {
            failReadback = false;
            throw simulatedIoError("Simulated EIO during exact cleanup reconciliation readback.");
          }
          return lstat(target);
        }
      }
    });

    const pending = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: untrustedStaging,
      clock: clockAt("2026-08-18T12:00:00.000Z")
    });
    assert.deepEqual(pending.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(pending.cleanup.needsAttentionBatchIds, [batchId]);
    assert.equal(pending.cleanup.rawSourceBodiesRetained, true);
    assert.deepEqual(customCalls, { unlink: 0, lstat: 0 });
    assert.equal(failReadback, false);
    const interruptedStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(interruptedStatus.compilation.status, "expired");
    assert.equal(interruptedStatus.compilation.staging.status, "expired-pending-deletion");
    assert.equal(interruptedStatus.compilation.staging.deletedAt, null);
    assert.equal(interruptedStatus.compilation.retryable, true);
    assert.equal(interruptedStatus.compilation.needsAttention, true);
    assert.equal(interruptedStatus.compilation.rawSourceBodiesRetained, true);
    assert.match(interruptedStatus.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    assert.equal(before.knowledgeCompilationLifecycle.audit.some((event) => (
      event.type === "temporary-staging-expired" && event.batchId === batchId
    )), false);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);

    const recovered = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: fixtureStaging(root),
      clock: clockAt("2026-08-18T12:05:00.000Z")
    });
    assert.deepEqual(recovered.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(recovered.cleanup.needsAttentionBatchIds, []);
    const recoveredStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(recoveredStatus.compilation.status, "expired");
    assert.equal(recoveredStatus.compilation.staging.status, "expired-deleted");
    assert.equal(recoveredStatus.compilation.staging.needsAttention, false);
    assert.equal(recoveredStatus.compilation.rawSourceBodiesRetained, false);
    assert.equal(recoveredStatus.compilation.retryable, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("a custom restoration callback cannot certify deletion and exact authority recovers the retained generation", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(await realpath(directory), ".qwave-second-brain-staging");
    const batchId = "fixture-exact-cleanup-readback-restoration";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-exact-cleanup-readback-restoration", "Cleanup restoration", "A restored exact generation supersedes earlier local removal evidence.")
      ])],
      clock: clockAt(startedAt)
    });

    const before = await stateStore.load();
    const entry = before.knowledgeCompilationLifecycle.batches[batchId];
    const artifacts = stagingArtifacts(root, batchId, entry.staging.leaseId);
    const originalData = await readFile(artifacts.data, "utf8");
    const originalLease = await readFile(artifacts.lease, "utf8");
    let restoreAtReadback = false;
    let restorationInjected = false;
    const customCalls = { unlink: 0, lstat: 0 };
    const untrustedStaging = fixtureStaging(root, {
      fileSystem: {
        async unlink(target) {
          customCalls.unlink += 1;
          const result = await unlink(target);
          if (!restorationInjected && path.resolve(String(target)) === path.resolve(artifacts.lease)) {
            restoreAtReadback = true;
          }
          return result;
        },
        async lstat(target) {
          customCalls.lstat += 1;
          if (restoreAtReadback && path.resolve(String(target)) === path.resolve(artifacts.data)) {
            restoreAtReadback = false;
            restorationInjected = true;
            await writeFile(artifacts.data, originalData, { encoding: "utf8", mode: 0o600 });
            await writeFile(artifacts.lease, originalLease, { encoding: "utf8", mode: 0o600 });
          }
          return lstat(target);
        }
      }
    });

    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: untrustedStaging,
      clock: clockAt("2026-08-18T12:00:00.000Z")
    });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(cleanup.cleanup.needsAttentionBatchIds, [batchId]);
    assert.equal(cleanup.cleanup.rawSourceBodiesRetained, true);
    assert.deepEqual(customCalls, { unlink: 0, lstat: 0 });
    assert.equal(restoreAtReadback, false);
    assert.equal(restorationInjected, false);
    const retainedStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(retainedStatus.compilation.status, "expired");
    assert.equal(retainedStatus.compilation.staging.status, "expired-pending-deletion");
    assert.equal(retainedStatus.compilation.staging.deletedAt, null);
    assert.equal(retainedStatus.compilation.retryable, true);
    assert.equal(retainedStatus.compilation.needsAttention, true);
    assert.equal(retainedStatus.compilation.rawSourceBodiesRetained, true);
    assert.match(retainedStatus.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    assert.equal(await readFile(artifacts.data, "utf8"), originalData);
    assert.equal(await readFile(artifacts.lease, "utf8"), originalLease);

    const recovered = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: fixtureStaging(root),
      clock: clockAt("2026-08-18T12:05:00.000Z")
    });
    assert.deepEqual(recovered.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(recovered.cleanup.needsAttentionBatchIds, []);
    const recoveredStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(recoveredStatus.compilation.status, "expired");
    assert.equal(recoveredStatus.compilation.staging.status, "expired-deleted");
    assert.equal(recoveredStatus.compilation.staging.needsAttention, false);
    assert.equal(recoveredStatus.compilation.rawSourceBodiesRetained, false);
    assert.equal(recoveredStatus.compilation.retryable, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("tracked malformed-lease restart cleanup binds the filename generation to the persisted lifecycle", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-tracked-malformed-lease";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-tracked-malformed-lease", "Tracked malformed lease", "A malformed lease is reconciled only through the exact persisted generation tag.")
      ])],
      clock: clockAt(startedAt)
    });

    const stagedState = await stateStore.load();
    const leaseId = stagedState.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    await writeFile(artifacts.lease, "{not-valid-json\n", "utf8");

    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: fixtureStaging(root),
      clock: clockAt(laterToday)
    });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, []);
    assert.deepEqual(cleanup.cleanup.needsAttentionBatchIds, []);
    for (const target of [artifacts.data, artifacts.lease]) {
      await assert.rejects(() => lstat(target), (error) => error?.code === "ENOENT");
    }

    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "discarded");
    assert.equal(status.compilation.staging.status, "discarded-invalid-generation");
    assert.equal(status.compilation.staging.cause, "invalid-generation");
    assert.equal(status.compilation.staging.needsAttention, false);
    assert.equal(status.compilation.retryable, false);
    assert.equal(typeof status.compilation.staging.deletedAt, "string");
    assert.doesNotMatch(status.compilation.message, /expired|available/i);
    await waitFor(async () => (await readdir(root)).length === 0);
    assert.deepEqual(await readdir(root), []);
  });
});

for (const leaseCase of [
  {
    label: "missing lease",
    batchId: "fixture-stopped-worker-missing-lease",
    terminalStatus: "discarded-orphaned-generation",
    terminalCause: "orphaned-generation",
    async corrupt(artifacts) {
      await unlink(artifacts.lease);
    },
    async assertCorruptionApplied(artifacts) {
      await assert.rejects(() => lstat(artifacts.lease), (error) => error?.code === "ENOENT");
    }
  },
  {
    label: "malformed lease",
    batchId: "fixture-stopped-worker-malformed-lease",
    terminalStatus: "discarded-invalid-generation",
    terminalCause: "invalid-generation",
    async corrupt(artifacts) {
      await writeFile(artifacts.lease, "{not-valid-json\n", "utf8");
    },
    async assertCorruptionApplied(artifacts) {
      assert.equal(await readFile(artifacts.lease, "utf8"), "{not-valid-json\n");
    }
  }
]) {
  test(`stopped exact retention worker keeps tracked ${leaseCase.label} cleanup nonterminal until retry`, async () => {
    await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
      const root = path.join(directory, ".qwave-second-brain-staging");
      const { batchId } = leaseCase;
      let workerPid = null;
      let teardownError = null;
      try {
        const staged = await compileApprovedRecords({
          message: "Compile my approved notes",
          stateStore,
          staging: new FailOnceReadStaging(staging),
          batchId,
          approvedRecords: [approvedRecord(gmail, [
            assertion(
              "knowledge",
              `knowledge-${batchId}`,
              `Stopped worker ${leaseCase.label}`,
              "Cleanup must remain nonterminal while the exact generation worker cannot confirm quiescence."
            )
          ])],
          clock: clockAt(startedAt)
        });
        assert.equal(staged.compilation.status, "staged");
        assert.equal(staged.compilation.simulated, true);
        assert.equal(staged.compilation.live, false);
        assert.equal(staged.compilation.rawSourceBodiesRetained, true);
        assert.equal(staged.interruption.retryable, true);

        const stagedState = await stateStore.load();
        const stagedEntry = stagedState.knowledgeCompilationLifecycle.batches[batchId];
        const leaseId = stagedEntry.staging.leaseId;
        const artifacts = stagingArtifacts(root, batchId, leaseId);
        await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 1);
        const workerCommands = await retentionWorkerCommands(batchId);
        workerPid = retentionWorkerPid(workerCommands[0]);
        const owner = JSON.parse(await readFile(artifacts.owner, "utf8"));
        assert.equal(owner.phase, "running");
        assert.equal(owner.batchId, batchId);
        assert.equal(owner.leaseId, leaseId);
        assert.equal(owner.pid, workerPid);
        assert.equal(Number.isSafeInteger(workerPid) && workerPid > 1, true);

        assert.equal(signalExactProcess(workerPid, "SIGSTOP"), true);
        await waitFor(async () => (await processState(workerPid)).startsWith("T"));
        await leaseCase.corrupt(artifacts);
        await leaseCase.assertCorruptionApplied(artifacts);

        const restarted = fixtureStaging(root);
        const blockedCleanup = await cleanupExpiredKnowledgeStaging({
          stateStore,
          staging: restarted,
          clock: clockAt(laterToday)
        });
        assert.equal(blockedCleanup.cleanup.simulated, true);
        assert.deepEqual(blockedCleanup.cleanup.expiredBatchIds, []);
        assert.deepEqual(blockedCleanup.cleanup.needsAttentionBatchIds, [batchId]);
        assert.equal(blockedCleanup.cleanup.rawSourceBodiesRetained, false);

        const blockedStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
        assert.equal(blockedStatus.compilation.status, "staged");
        assert.equal(blockedStatus.compilation.simulated, true);
        assert.equal(blockedStatus.compilation.live, false);
        assert.equal(blockedStatus.compilation.rawSourceBodiesRetained, false);
        assert.equal(blockedStatus.compilation.staging.status, "cleanup-needs-attention");
        assert.equal(blockedStatus.compilation.staging.cause, null);
        assert.equal(blockedStatus.compilation.staging.deletedAt, null);
        assert.equal(
          new Date(blockedStatus.compilation.staging.rawSourceBodiesDeletedAt).toISOString(),
          blockedStatus.compilation.staging.rawSourceBodiesDeletedAt
        );
        assert.equal(blockedStatus.compilation.staging.needsAttention, true);
        assert.equal(blockedStatus.compilation.needsAttention, true);
        assert.equal(blockedStatus.compilation.retryable, true);
        assert.match(blockedStatus.compilation.message, /source bodies are deleted/i);

        const blockedState = await stateStore.load();
        const blockedEntry = blockedState.knowledgeCompilationLifecycle.batches[batchId];
        assert.equal(blockedEntry.staging.leaseId, leaseId);
        assert.equal(blockedEntry.staging.cleanupNeedsAttention, "RETENTION_SERVICE_UNAVAILABLE");
        assert.equal(
          blockedEntry.staging.rawSourceBodiesDeletedAt,
          blockedStatus.compilation.staging.rawSourceBodiesDeletedAt
        );
        await assert.rejects(() => lstat(artifacts.data), (error) => error?.code === "ENOENT");
        await assert.rejects(() => lstat(artifacts.lease), (error) => error?.code === "ENOENT");
        const blockedOwner = JSON.parse(await readFile(artifacts.owner, "utf8"));
        assert.deepEqual(blockedOwner, owner);
        await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
        const terminalAuditTypes = new Set([
          "temporary-batch-discarded",
          "temporary-staging-expired",
          "temporary-staging-deleted-after-result-persistence",
          "temporary-discarded-staging-deleted",
          "temporary-expired-staging-deleted",
          "temporary-staging-deletion-receipt-consumed",
          "temporary-discarded-staging-deletion-receipt-consumed",
          "temporary-expired-staging-deletion-receipt-consumed"
        ]);
        assert.deepEqual(
          blockedEntry.audit.filter((event) => terminalAuditTypes.has(event.type)),
          []
        );
        assert.deepEqual(
          blockedState.knowledgeCompilationLifecycle.audit.filter((event) => (
            event.batchId === batchId && terminalAuditTypes.has(event.type)
          )),
          []
        );
        const blockedWorkerCommands = await retentionWorkerCommands(batchId);
        assert.equal(blockedWorkerCommands.length, 1);
        assert.equal(retentionWorkerPid(blockedWorkerCommands[0]), workerPid);
        assert.equal(processExists(workerPid), true);
        assert.match(await processState(workerPid), /^T/);

        assert.equal(signalExactProcess(workerPid, "SIGCONT"), true);
        await waitFor(async () => !await exactRetentionWorkerExists(workerPid, batchId), 6_000);
        const recoveredCleanup = await cleanupExpiredKnowledgeStaging({
          stateStore,
          staging: restarted,
          clock: clockAt("2026-08-17T13:05:00.000Z")
        });
        assert.equal(recoveredCleanup.cleanup.simulated, true);
        assert.deepEqual(recoveredCleanup.cleanup.expiredBatchIds, []);
        assert.deepEqual(recoveredCleanup.cleanup.needsAttentionBatchIds, []);
        assert.equal(recoveredCleanup.cleanup.rawSourceBodiesRetained, false);

        const recoveredStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
        assert.equal(recoveredStatus.compilation.status, "discarded");
        assert.equal(recoveredStatus.compilation.simulated, true);
        assert.equal(recoveredStatus.compilation.live, false);
        assert.equal(recoveredStatus.compilation.rawSourceBodiesRetained, false);
        assert.equal(recoveredStatus.compilation.staging.status, leaseCase.terminalStatus);
        assert.equal(recoveredStatus.compilation.staging.cause, leaseCase.terminalCause);
        assert.equal(typeof recoveredStatus.compilation.staging.deletedAt, "string");
        assert.equal(
          recoveredStatus.compilation.staging.rawSourceBodiesDeletedAt,
          blockedStatus.compilation.staging.rawSourceBodiesDeletedAt
        );
        assert.equal(recoveredStatus.compilation.staging.needsAttention, false);
        assert.equal(recoveredStatus.compilation.needsAttention, false);
        assert.equal(recoveredStatus.compilation.retryable, false);

        await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 0);
        for (const target of [artifacts.owner, artifacts.data, artifacts.lease]) {
          await assert.rejects(() => lstat(target), (error) => error?.code === "ENOENT");
        }
        await waitFor(async () => (await readdir(root)).length === 0);
        const remaining = await readdir(root);
        assert.deepEqual(exactGenerationWorkerTempNames(remaining, artifacts), []);
        assert.deepEqual(remaining, []);
      } finally {
        try {
          await ensureExactWorkerStoppedForTeardown(workerPid, batchId);
        } catch (error) {
          teardownError = error;
        }
      }
      if (teardownError) throw teardownError;
    });
  });
}

test("tracked hardlink with a missing lease survives restart as exact public needs-attention", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-tracked-hardlink-missing-lease";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-tracked-hardlink-missing-lease", "Tracked hard link without lease", "Hard-linked bytes with a missing lease remain needs-attention for the exact persisted generation.")
      ])],
      clock: clockAt(startedAt)
    });

    const stagedState = await stateStore.load();
    const leaseId = stagedState.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const survivor = path.join(directory, "tracked-hardlink-missing-lease-survivor.json");
    await link(artifacts.data, survivor);
    await unlink(artifacts.lease);

    const restarted = fixtureStaging(root);
    const blockedCleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: restarted,
      clock: clockAt(laterToday)
    });
    assert.deepEqual(blockedCleanup.cleanup.expiredBatchIds, []);
    assert.deepEqual(blockedCleanup.cleanup.needsAttentionBatchIds, [batchId]);

    const blockedStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(blockedStatus.compilation.status, "staged");
    assert.equal(blockedStatus.compilation.staging.status, "cleanup-needs-attention");
    assert.equal(blockedStatus.compilation.staging.needsAttention, true);
    assert.equal(blockedStatus.compilation.needsAttention, true);
    assert.equal(blockedStatus.compilation.retryable, true);
    assert.match(blockedStatus.compilation.message, /filesystem link/i);
    assert.doesNotMatch(blockedStatus.compilation.message, /24 hours/i);

    const blockedState = await stateStore.load();
    const blockedEntry = blockedState.knowledgeCompilationLifecycle.batches[batchId];
    assert.equal(blockedEntry.staging.leaseId, leaseId);
    assert.equal(blockedEntry.staging.cleanupNeedsAttention, "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION");
    assert.equal((await lstat(artifacts.data)).nlink, 2);
    assert.equal((await lstat(survivor)).nlink, 2);
    await assert.rejects(() => lstat(artifacts.lease), (error) => error?.code === "ENOENT");

    await unlink(survivor);
    const recoveredCleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: restarted,
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.deepEqual(recoveredCleanup.cleanup.expiredBatchIds, []);
    assert.deepEqual(recoveredCleanup.cleanup.needsAttentionBatchIds, []);
    const recoveredStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(recoveredStatus.compilation.status, "discarded");
    assert.equal(recoveredStatus.compilation.staging.status, "discarded-orphaned-generation");
    assert.equal(recoveredStatus.compilation.staging.cause, "orphaned-generation");
    assert.equal(recoveredStatus.compilation.staging.needsAttention, false);
    assert.equal(recoveredStatus.compilation.needsAttention, false);
    assert.equal(recoveredStatus.compilation.retryable, false);
    await waitFor(async () => (await readdir(root)).length === 0);
    assert.deepEqual(await readdir(root), []);
  });
});

test("restart keeps a hard-linked orphan generation as needs-attention without expired truth", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-orphan-hardlink-"));
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-orphan-hardlink";
    const tag = "a".repeat(24);
    const dataPath = path.join(root, `batch-${batchId}.${tag}.json`);
    const survivor = path.join(directory, "orphan-survivor.json");
    await mkdir(root, { mode: 0o700 });
    await writeFile(dataPath, "SECRET-ORPHAN-STAGED-BYTES\n", "utf8");
    await link(dataPath, survivor);

    const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
    await startSetupSession({
      message: "Set up my second brain",
      answers: { displayName: "Fixture", focus: "verify orphan cleanup truth" },
      decisions: { vaultName: "Fixture Second Brain", language: "en" },
      stateStore,
      adapters: {
        environment: new SimulatedEnvironmentAdapter(),
        obsidian: new SimulatedObsidianAdapter(),
        vault: new SimulatedDesktopVaultAdapter()
      },
      clock: clockAt(startedAt),
      installationIdFactory: () => "fixture-orphan-cleanup-installation"
    });
    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: fixtureStaging(root),
      clock: clockAt(laterToday)
    });

    assert.deepEqual(cleanup.cleanup.expiredBatchIds, []);
    assert.deepEqual(cleanup.cleanup.needsAttentionBatchIds, [batchId]);
    assert.equal(await readFile(dataPath, "utf8"), "SECRET-ORPHAN-STAGED-BYTES\n");
    assert.equal(await readFile(survivor, "utf8"), "SECRET-ORPHAN-STAGED-BYTES\n");
    assert.equal((await lstat(dataPath)).nlink, 2);
    assert.equal((await lstat(survivor)).nlink, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart keeps a hard-linked malformed generation and its lease as needs-attention", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-malformed-hardlink-"));
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-malformed-hardlink";
    const tag = "b".repeat(24);
    const base = path.join(root, `batch-${batchId}.${tag}`);
    const dataPath = `${base}.json`;
    const leasePath = `${base}.lease.json`;
    const survivor = path.join(directory, "malformed-survivor.json");
    await mkdir(root, { mode: 0o700 });
    await writeFile(dataPath, "SECRET-MALFORMED-STAGED-BYTES\n", "utf8");
    await writeFile(leasePath, "{not-valid-json\n", "utf8");
    await link(dataPath, survivor);

    const staging = fixtureStaging(root);
    await staging.initialize();
    const cleanup = await staging.cleanupExpired({ now: laterToday });

    assert.deepEqual(cleanup.removedBatchIds, []);
    assert.deepEqual(cleanup.cleanupNeedsAttentionBatchIds, [batchId]);
    assert.deepEqual(cleanup.cleanupNeedsAttentionBatches, [{
      batchId,
      generationTag: tag,
      leaseId: null,
      reason: "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION"
    }]);
    assert.equal(await readFile(dataPath, "utf8"), "SECRET-MALFORMED-STAGED-BYTES\n");
    assert.equal(await readFile(survivor, "utf8"), "SECRET-MALFORMED-STAGED-BYTES\n");
    assert.equal(await readFile(leasePath, "utf8"), "{not-valid-json\n");
    assert.equal((await lstat(dataPath)).nlink, 2);
    assert.equal((await lstat(survivor)).nlink, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh restarts keep standalone cleanup residue visible without accepting deletion evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-residue-restarts-"));
  try {
    const variants = [
      {
        label: "malformed-receipt",
        suffix: ".receipt.json",
        contents: "{not-valid-json\n",
        reason: "STAGING_CLEANUP_EVIDENCE_REQUIRED"
      },
      {
        label: "malformed-tombstone",
        suffix: ".tombstone.json",
        contents: "{not-valid-json\n",
        reason: "STAGING_CLEANUP_EVIDENCE_REQUIRED"
      },
      {
        label: "malformed-owner",
        suffix: ".owner.json",
        contents: "{not-valid-json\n",
        reason: "RETENTION_SERVICE_UNAVAILABLE"
      },
      {
        label: "receipt-worker-temp",
        suffix: ".receipt.json.4242.tmp",
        contents: "unfinished-receipt-write\n",
        reason: "RETENTION_SERVICE_UNAVAILABLE"
      },
      {
        label: "tombstone-worker-temp",
        suffix: ".tombstone.json.4243.tmp",
        contents: "unfinished-tombstone-write\n",
        reason: "RETENTION_SERVICE_UNAVAILABLE"
      },
      {
        label: "owner-worker-temp",
        suffix: ".owner.json.4244.tmp",
        contents: "unfinished-owner-write\n",
        reason: "RETENTION_SERVICE_UNAVAILABLE"
      }
    ];

    for (const [index, variant] of variants.entries()) {
      const root = path.join(directory, variant.label, ".qwave-second-brain-staging");
      const batchId = `fixture-${variant.label}`;
      const tag = (index + 1).toString(16).repeat(24);
      const residuePath = path.join(root, `batch-${batchId}.${tag}${variant.suffix}`);
      await mkdir(root, { mode: 0o700, recursive: true });
      await writeFile(residuePath, variant.contents, { encoding: "utf8", mode: 0o600 });

      for (let restart = 0; restart < 3; restart += 1) {
        const staging = fixtureStaging(root);
        await staging.initialize();
        const cleanup = await staging.cleanupExpired({ now: laterToday });
        assert.deepEqual(cleanup.removedBatchIds, [], `${variant.label} restart ${restart} removed residue`);
        assert.deepEqual(cleanup.cleanupNeedsAttentionBatchIds, [batchId]);
        assert.deepEqual(cleanup.cleanupNeedsAttentionBatches, [{
          batchId,
          generationTag: tag,
          leaseId: null,
          reason: variant.reason
        }]);
        assert.equal(await readFile(residuePath, "utf8"), variant.contents);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh restarts preserve unsafe standalone completion artifacts as cleanup attention", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-unsafe-residue-"));
  try {
    const variants = [
      {
        label: "symlinked-receipt",
        suffix: ".receipt.json",
        async create({ residuePath, variantDirectory }) {
          const outside = path.join(variantDirectory, "outside-receipt.json");
          await writeFile(outside, '{"not":"staging evidence"}\n', { encoding: "utf8", mode: 0o600 });
          await symlink(outside, residuePath);
          return async () => {
            assert.equal(await readFile(outside, "utf8"), '{"not":"staging evidence"}\n');
            assert.equal((await lstat(residuePath)).isSymbolicLink(), true);
          };
        }
      },
      {
        label: "oversized-tombstone",
        suffix: ".tombstone.json",
        async create({ residuePath }) {
          const contents = `${"x".repeat((16 * 1024) + 1)}\n`;
          await writeFile(residuePath, contents, { encoding: "utf8", mode: 0o600 });
          return async () => {
            assert.equal(await readFile(residuePath, "utf8"), contents);
          };
        }
      }
    ];

    for (const [index, variant] of variants.entries()) {
      const variantDirectory = path.join(directory, variant.label);
      const root = path.join(variantDirectory, ".qwave-second-brain-staging");
      const batchId = `fixture-${variant.label}`;
      const tag = (index + 9).toString(16).repeat(24);
      const residuePath = path.join(root, `batch-${batchId}.${tag}${variant.suffix}`);
      await mkdir(root, { mode: 0o700, recursive: true });
      const assertStillPresent = await variant.create({ residuePath, variantDirectory });

      for (let restart = 0; restart < 3; restart += 1) {
        const staging = fixtureStaging(root);
        await staging.initialize();
        const cleanup = await staging.cleanupExpired({ now: laterToday });
        assert.deepEqual(cleanup.removedBatchIds, [], `${variant.label} restart ${restart} removed unsafe residue`);
        assert.deepEqual(cleanup.cleanupNeedsAttentionBatches, [{
          batchId,
          generationTag: tag,
          leaseId: null,
          reason: "STAGING_CLEANUP_EVIDENCE_REQUIRED"
        }]);
        await assertStillPresent();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh restarts ignore nonnumeric worker-temp lookalikes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-residue-lookalike-"));
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-nonnumeric-worker-temp";
    const tag = "e".repeat(24);
    const lookalikePath = path.join(root, `batch-${batchId}.${tag}.receipt.json.worker.tmp`);
    await mkdir(root, { mode: 0o700 });
    await writeFile(lookalikePath, "unrelated-lookalike\n", { encoding: "utf8", mode: 0o600 });

    for (let restart = 0; restart < 3; restart += 1) {
      const staging = fixtureStaging(root);
      await staging.initialize();
      const cleanup = await staging.cleanupExpired({ now: laterToday });
      assert.deepEqual(cleanup.removedBatchIds, []);
      assert.deepEqual(cleanup.cleanupNeedsAttentionBatchIds, []);
      assert.deepEqual(cleanup.cleanupNeedsAttentionBatches, []);
      assert.equal(await readFile(lookalikePath, "utf8"), "unrelated-lookalike\n");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart removes single-link orphan and malformed generations only after verified absence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-untracked-cleanup-"));
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const orphanBatchId = "fixture-orphan-single-link";
    const malformedBatchId = "fixture-malformed-single-link";
    const orphanPath = path.join(root, `batch-${orphanBatchId}.${"c".repeat(24)}.json`);
    const malformedBase = path.join(root, `batch-${malformedBatchId}.${"d".repeat(24)}`);
    const malformedDataPath = `${malformedBase}.json`;
    const malformedLeasePath = `${malformedBase}.lease.json`;
    await mkdir(root, { mode: 0o700 });
    await writeFile(orphanPath, "SAFE-ORPHAN-CLEANUP\n", "utf8");
    await writeFile(malformedDataPath, "SAFE-MALFORMED-CLEANUP\n", "utf8");
    await writeFile(malformedLeasePath, "{not-valid-json\n", "utf8");

    const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
    await startSetupSession({
      message: "Set up my second brain",
      answers: { displayName: "Fixture", focus: "verify untracked cleanup truth" },
      decisions: { vaultName: "Fixture Second Brain", language: "en" },
      stateStore,
      adapters: {
        environment: new SimulatedEnvironmentAdapter(),
        obsidian: new SimulatedObsidianAdapter(),
        vault: new SimulatedDesktopVaultAdapter()
      },
      clock: clockAt(startedAt),
      installationIdFactory: () => "fixture-untracked-cleanup-installation"
    });
    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: fixtureStaging(root),
      clock: clockAt(laterToday)
    });

    assert.deepEqual(cleanup.cleanup.expiredBatchIds, []);
    assert.deepEqual(cleanup.cleanup.needsAttentionBatchIds, []);
    for (const target of [orphanPath, malformedDataPath, malformedLeasePath]) {
      await assert.rejects(() => lstat(target), (error) => error?.code === "ENOENT");
    }
    for (const [batchId, expectedStatus, expectedCause] of [
      [orphanBatchId, "discarded-orphaned-generation", "orphaned-generation"],
      [malformedBatchId, "discarded-invalid-generation", "invalid-generation"]
    ]) {
      const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
      assert.equal(status.compilation.status, "discarded");
      assert.equal(status.compilation.staging.status, expectedStatus);
      assert.equal(status.compilation.staging.cause, expectedCause);
      assert.equal(status.compilation.staging.needsAttention, false);
      assert.equal(status.compilation.retryable, false);
      assert.equal(typeof status.compilation.staging.deletedAt, "string");
      assert.doesNotMatch(status.compilation.message, /expired|available/i);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tracked invalid generation is discarded across restart without public expiry truth", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const batchId = "fixture-tracked-invalid-restart";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-fixture-tracked-invalid", "Tracked invalid generation", "An invalid tracked generation is discarded without expiry truth.")
      ])],
      clock: clockAt(startedAt)
    });

    const durable = await stateStore.load();
    const leaseId = durable.knowledgeCompilationLifecycle.batches[batchId].staging.leaseId;
    const root = path.join(directory, ".qwave-second-brain-staging");
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const invalidPayload = JSON.parse(await readFile(artifacts.data, "utf8"));
    invalidPayload.createdAt = "2026-08-17T11:59:59.000Z";
    await writeFile(artifacts.data, `${JSON.stringify(invalidPayload)}\n`, "utf8");

    const cleanupProcess = fixtureStaging(root);
    await cleanupProcess.initialize();
    for (const target of [artifacts.data, artifacts.lease]) {
      await assert.rejects(() => lstat(target), (error) => error?.code === "ENOENT");
    }
    assert.equal((await lstat(artifacts.receipt)).isFile(), true);

    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: fixtureStaging(root),
      clock: clockAt(laterToday)
    });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, []);
    assert.deepEqual(cleanup.cleanup.needsAttentionBatchIds, []);
    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "discarded");
    assert.equal(status.compilation.staging.status, "discarded-invalid-generation");
    assert.equal(status.compilation.staging.cause, "invalid-generation");
    assert.equal(status.compilation.staging.needsAttention, false);
    assert.equal(status.compilation.retryable, false);
    assert.equal(typeof status.compilation.staging.deletedAt, "string");
    assert.doesNotMatch(status.compilation.message, /expired|available/i);
    assert.deepEqual(await readdir(root), []);
  });
});

test("retention arming occurs before a temporary batch write and fails closed when the service is unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-retention-arm-"));
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const durabilityEvents = [];
    const retentionService = new FixtureRetentionService({
      onArm({ manifestBeforeWrite }) {
        durabilityEvents.push("retention-armed");
        assert.equal(manifestBeforeWrite.phase, "prepared");
      }
    });
    const staging = fixtureStaging(root, {
      retentionService,
      fileSystem: {
        async open(target, flags, mode) {
          if (isStagingDataPath(target)) durabilityEvents.push("data-opened");
          const handle = await open(target, flags, mode);
          if (String(target).endsWith(".lease.json") && (flags & constants.O_WRONLY) === constants.O_WRONLY) {
            return proxyFileHandle(handle, {
              async sync() {
                await handle.sync();
                durabilityEvents.push("lease-file-synced");
              }
            });
          }
          if (path.basename(String(target)) === ".qwave-second-brain-staging") {
            return proxyFileHandle(handle, {
              async sync() {
                await handle.sync();
                durabilityEvents.push("lease-parent-synced");
              }
            });
          }
          return handle;
        }
      }
    });
    const receipt = await staging.stage({ batchId: "fixture-retention-arm", records: [inertStagingRecord()], createdAt: startedAt });
    assert.equal(retentionService.armed[0].filesBeforeWrite.length, 1);
    assert.equal(retentionService.armed[0].filesBeforeWrite[0].endsWith(".lease.json"), true);
    assert.equal(retentionService.armed[0].filesBeforeWrite.some((name) => !name.endsWith(".lease.json") && name.endsWith(".json")), false);
    assert.deepEqual(durabilityEvents.slice(0, 4), [
      "lease-file-synced",
      "lease-parent-synced",
      "retention-armed",
      "data-opened"
    ]);
    await staging.delete({ batchId: "fixture-retention-arm", leaseId: receipt.leaseId });
    const completedArtifacts = stagingArtifacts(root, "fixture-retention-arm", receipt.leaseId);

    const unavailable = fixtureStaging(root, {
      retentionService: {
        async arm() { throw new Error("simulated retention service unavailable"); },
        async disarm() {}
      }
    });
    await assert.rejects(
      () => unavailable.stage({ batchId: "fixture-retention-unavailable", records: [inertStagingRecord()], createdAt: startedAt }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "RETENTION_SERVICE_UNAVAILABLE"
    );
    const unavailableWorker = new DetachedLocalRetentionService({ workerPath: path.join(directory, "missing-retention-worker.mjs") });
    const realRoot = await realpath(root);
    await assert.rejects(
      () => unavailableWorker.arm({
        root: realRoot,
        batchId: "fixture-missing-worker",
        expiresAt: new Date(Date.now() + 1_000).toISOString()
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "RETENTION_SERVICE_UNAVAILABLE"
    );
    assert.deepEqual((await readdir(root)).sort(), [
      path.basename(completedArtifacts.receipt),
      path.basename(completedArtifacts.tombstone)
    ].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public cleanup acknowledgement cannot disarm retention before exact completion evidence exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-cleanup-ack-"));
  const batchId = "fixture-premature-cleanup-ack";
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    let hostileCalls = 0;
    const retentionService = new DetachedLocalRetentionService();
    Object.defineProperties(retentionService, {
      workerPath: { configurable: true, value: path.join(directory, "hostile-missing-worker.mjs") },
      fileSystem: {
        configurable: true,
        value: {
          async lstat() { hostileCalls += 1; throw simulatedIoError("Hostile public filesystem shadow."); },
          async open() { hostileCalls += 1; throw simulatedIoError("Hostile public filesystem shadow."); },
          async rename() { hostileCalls += 1; throw simulatedIoError("Hostile public filesystem shadow."); },
          async unlink() { hostileCalls += 1; throw simulatedIoError("Hostile public filesystem shadow."); }
        }
      },
      workers: { configurable: true, value: new Map() }
    });
    Object.defineProperties(retentionService, {
      arm: {
        configurable: true,
        value: async () => { hostileCalls += 1; throw simulatedIoError("Replaced retention arm method."); }
      },
      disarm: {
        configurable: true,
        value: async () => { hostileCalls += 1; throw simulatedIoError("Replaced retention disarm method."); }
      }
    });
    const staging = new LocalTemporaryStaging({ root, retentionService });
    const receipt = await staging.stage({
      batchId,
      records: [inertStagingRecord()],
      createdAt: new Date().toISOString()
    });
    const artifacts = stagingArtifacts(root, batchId, receipt.leaseId);
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 1);
    assert.equal(hostileCalls, 0);

    await assert.rejects(
      () => staging.acknowledgeCleanupReceipt({ batchId, leaseId: receipt.leaseId }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_CLEANUP_ACK_INTERNAL_ONLY"
    );
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    assert.equal((await lstat(artifacts.owner)).isFile(), true);
    assert.equal((await retentionWorkerCommands(batchId)).length, 1);

    await staging.delete({ batchId, leaseId: receipt.leaseId });
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 0);
    assert.equal(hostileCalls, 0);
    assert.deepEqual((await readdir(root)).sort(), [
      path.basename(artifacts.receipt),
      path.basename(artifacts.tombstone)
    ].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an external hard link keeps cleanup armed and cannot produce a false deletion receipt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-hardlink-"));
  const batchId = "fixture-external-hardlink";
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const staging = new LocalTemporaryStaging({ root, retentionService: new DetachedLocalRetentionService() });
    const receipt = await staging.stage({
      batchId,
      records: [inertStagingRecord()],
      createdAt: new Date().toISOString()
    });
    const artifacts = stagingArtifacts(root, batchId, receipt.leaseId);
    const survivor = path.join(directory, "retained-fixture-link.json");
    await link(artifacts.data, survivor);
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 1);

    await assert.rejects(
      () => staging.read({ batchId, leaseId: receipt.leaseId }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_HARDLINK_BLOCKED"
    );
    await assert.rejects(
      () => staging.delete({ batchId, leaseId: receipt.leaseId }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION"
    );
    assert.equal((await lstat(artifacts.data)).nlink, 2);
    assert.equal((await lstat(survivor)).nlink, 2);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    assert.equal((await lstat(artifacts.owner)).isFile(), true);
    await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
    assert.equal((await retentionWorkerCommands(batchId)).length, 1);

    await unlink(survivor);
    assert.equal(await staging.delete({ batchId, leaseId: receipt.leaseId }), true);
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 0);
    assert.deepEqual((await readdir(root)).sort(), [
      path.basename(artifacts.receipt),
      path.basename(artifacts.tombstone)
    ].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a hard link added after open cannot become a false receipt after the private path is unlinked", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-hardlink-race-"));
  const batchId = "fixture-post-open-hardlink";
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const survivor = path.join(directory, "post-open-survivor.json");
    let injectLink = false;
    const staging = fixtureStaging(root, {
      fileSystem: {
        async unlink(target) {
          if (injectLink && isStagingDataPath(target)) {
            injectLink = false;
            await link(target, survivor);
          }
          return unlink(target);
        }
      }
    });
    const receipt = await staging.stage({
      batchId,
      records: [inertStagingRecord()],
      createdAt: startedAt
    });
    const artifacts = stagingArtifacts(root, batchId, receipt.leaseId);
    injectLink = true;

    await assert.rejects(
      () => staging.delete({ batchId, leaseId: receipt.leaseId }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION"
    );
    await assert.rejects(() => lstat(artifacts.data), (error) => error?.code === "ENOENT");
    assert.equal((await lstat(survivor)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
    const tombstone = JSON.parse(await readFile(artifacts.tombstone, "utf8"));
    assert.equal(tombstone.cleanupBlockedReason, "multiple-links-after-unlink");

    await unlink(survivor);
    await assert.rejects(
      () => staging.delete({ batchId, leaseId: receipt.leaseId }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION"
    );
    await assert.rejects(() => lstat(artifacts.receipt), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a wrapped post-save hard-link callback cannot certify deletion and exact authority resumes after the link is removed", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const survivor = path.join(directory, "compiled-cleanup-survivor.json");
    const batchId = "fixture-compiled-hardlink-attention";
    const instrumentedStateStore = new AfterCompiledResultSaveStateStore(stateStore, {
      batchId,
      async afterSave(entry) {
        const artifacts = stagingArtifacts(root, batchId, entry.staging.leaseId);
        await link(artifacts.data, survivor);
      }
    });
    const first = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore: instrumentedStateStore,
      staging,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-hardlink-attention", "Cleanup attention", "Cleanup status remains truthful until the additional link is removed.")
      ])],
      clock: clockAt(laterToday)
    });
    assert.equal(first.compilation.status, "compiled");
    assert.equal(first.compilation.staging.status, "result-persisted-pending-deletion");
    assert.equal(first.compilation.staging.needsAttention, true);
    assert.equal(first.compilation.needsAttention, true);
    assert.equal(first.compilation.retryable, true);
    assert.equal(first.compilation.rawSourceBodiesRetained, true);
    assert.match(first.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    assert.equal(instrumentedStateStore.invoked, true);
    assert.equal((await lstat(survivor)).isFile(), true);

    const durablePending = await stateStore.load();
    const pendingEntry = durablePending.knowledgeCompilationLifecycle.batches[batchId];
    const artifacts = stagingArtifacts(root, batchId, pendingEntry.staging.leaseId);
    assert.equal(
      pendingEntry.staging.cleanupNeedsAttention,
      "STAGING_AUTHORITATIVE_CLEANUP_REQUIRED"
    );
    assert.equal((await lstat(artifacts.data)).nlink, 2);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    await unlink(survivor);

    const resumed = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: fixtureStaging(root),
      batchId,
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(resumed.compilation.staging.status, "deleted-after-compilation");
    assert.equal(resumed.compilation.staging.needsAttention, false);
    assert.equal(resumed.compilation.needsAttention, false);
    assert.equal(resumed.compilation.retryable, false);
    assert.equal(resumed.compilation.rawSourceBodiesRetained, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("post-open write, fsync, and close failures never leave untracked staging data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-post-open-"));
  try {
    for (const operation of ["writeFile", "sync", "close"]) {
      const parent = path.join(directory, operation);
      const root = path.join(parent, ".qwave-second-brain-staging");
      await mkdir(parent);
      let injected = false;
      const staging = fixtureStaging(root, {
        fileSystem: {
          async open(target, flags, mode) {
            const handle = await open(target, flags, mode);
            if (!isStagingDataPath(target)) return handle;
            return proxyFileHandle(handle, {
              async writeFile(...args) {
                if (!injected && operation === "writeFile") {
                  injected = true;
                  throw simulatedIoError("Simulated post-open staging write failure.");
                }
                return handle.writeFile(...args);
              },
              async sync() {
                if (!injected && operation === "sync") {
                  injected = true;
                  throw simulatedIoError("Simulated post-open staging fsync failure.");
                }
                return handle.sync();
              },
              async close() {
                if (!injected && operation === "close") {
                  await handle.close();
                  injected = true;
                  throw simulatedIoError("Simulated post-open staging close failure.");
                }
                return handle.close();
              }
            });
          }
        }
      });
      await assert.rejects(
        () => staging.stage({
          batchId: `fixture-post-open-${operation}`,
          records: [inertStagingRecord()],
          createdAt: startedAt
        }),
        (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_WRITE_FAILED"
      );
      assert.equal(injected, true);
      assert.deepEqual(await readdir(root), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transient data-unlink failure keeps generation-bound cleanup retryable until verified absence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-unlink-retry-"));
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    let failTarget = null;
    let unlinkFailed = false;
    const staging = fixtureStaging(root, {
      fileSystem: {
        async unlink(target) {
          if (!unlinkFailed && failTarget && path.basename(String(target)) === path.basename(failTarget)) {
            unlinkFailed = true;
            throw simulatedIoError("Simulated transient staged-data unlink failure.");
          }
          return unlink(target);
        }
      }
    });
    const batchId = "fixture-transient-unlink";
    const receipt = await staging.stage({ batchId, records: [inertStagingRecord()], createdAt: startedAt });
    const artifacts = stagingArtifacts(root, batchId, receipt.leaseId);
    failTarget = artifacts.data;
    await assert.rejects(
      () => staging.delete({ batchId, leaseId: receipt.leaseId }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_DELETE_FAILED"
    );
    assert.equal(unlinkFailed, true);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);
    assert.equal((await lstat(artifacts.tombstone)).isFile(), true);

    assert.equal(await staging.delete({ batchId, leaseId: receipt.leaseId }), true);
    assert.deepEqual((await readdir(root)).sort(), [
      path.basename(artifacts.receipt),
      path.basename(artifacts.tombstone)
    ].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a custom restarted retention service cannot certify cleanup and exact authority expires the retained batch", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const batchId = "fixture-restart-retention-unavailable";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: new FailOnceReadStaging(staging),
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-fixture-retention-restart", "Retention restart", "A batch without restored retention coverage is discarded.")
      ])],
      clock: clockAt(laterToday)
    });
    const retentionCalls = { arm: 0, disarm: 0 };
    const restarted = fixtureStaging(root, {
      retentionService: {
        async arm() {
          retentionCalls.arm += 1;
          throw new Error("simulated restarted retention service unavailable");
        },
        async disarm() {
          retentionCalls.disarm += 1;
        }
      }
    });
    const pending = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: restarted,
      clock: clockAt("2026-08-18T13:05:00.000Z")
    });
    assert.deepEqual(pending.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(pending.cleanup.needsAttentionBatchIds, [batchId]);
    assert.equal(pending.cleanup.rawSourceBodiesRetained, true);
    assert.deepEqual(retentionCalls, { arm: 0, disarm: 0 });
    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "expired");
    assert.equal(status.compilation.staging.status, "expired-pending-deletion");
    assert.equal(status.compilation.staging.needsAttention, true);
    assert.equal(status.compilation.retryable, true);
    assert.equal(status.compilation.rawSourceBodiesRetained, true);
    assert.match(status.compilation.message, /exact local temporary staging engine|custom or wrapped adapter/i);
    const entry = (await stateStore.load()).knowledgeCompilationLifecycle.batches[batchId];
    const artifacts = stagingArtifacts(root, batchId, entry.staging.leaseId);
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await lstat(artifacts.lease)).isFile(), true);

    const recovered = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: fixtureStaging(root),
      clock: clockAt("2026-08-18T13:06:00.000Z")
    });
    assert.deepEqual(recovered.cleanup.expiredBatchIds, [batchId]);
    assert.deepEqual(recovered.cleanup.needsAttentionBatchIds, []);
    assert.equal(recovered.cleanup.rawSourceBodiesRetained, false);
    const recoveredStatus = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(recoveredStatus.compilation.status, "expired");
    assert.equal(recoveredStatus.compilation.staging.status, "expired-deleted");
    assert.equal(recoveredStatus.compilation.staging.needsAttention, false);
    assert.equal(recoveredStatus.compilation.retryable, false);
    assert.equal(recoveredStatus.compilation.rawSourceBodiesRetained, false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("the detached private retention worker removes a pre-armed batch after its creator process exits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-retention-crash-"));
  try {
    const rootPath = path.join(directory, ".qwave-second-brain-staging");
    await mkdir(rootPath, { mode: 0o700 });
    const root = await realpath(rootPath);
    const batchId = "fixture-creator-exit";
    const leaseId = "lease-fixture-worker";
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    // The creator only arms the detached worker and exits. The test writes a
    // non-sensitive placeholder after that exit to prove the worker, not the
    // creator's in-memory timer, performs the scheduled cleanup.
    await runRetentionCreator({ root, batchId, expiresAt });
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const manifest = JSON.parse(await readFile(artifacts.lease, "utf8"));
    await writeFile(artifacts.data, `${JSON.stringify({ batchId, leaseId, expiresAt })}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(artifacts.lease, `${JSON.stringify({ ...manifest, phase: "ready" })}\n`, { encoding: "utf8", mode: 0o600 });
    await waitFor(async () => {
      const names = await readdir(root);
      return !names.includes(path.basename(artifacts.data))
        && !names.includes(path.basename(artifacts.owner))
        && names.includes(path.basename(artifacts.receipt));
    });
    const remaining = (await readdir(root)).sort();
    assert.deepEqual(remaining, [path.basename(artifacts.receipt), path.basename(artifacts.tombstone)].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a restarted staging adapter adopts one generation owner and early deletion leaves zero worker processes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-adoption-"));
  const batchId = "fixture-restart-adoption-owner";
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const firstService = new DetachedLocalRetentionService();
    const first = new LocalTemporaryStaging({ root, retentionService: firstService });
    const receipt = await first.stage({ batchId, records: [inertStagingRecord()], createdAt: new Date().toISOString() });
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 1);

    const restarted = new LocalTemporaryStaging({
      root,
      retentionService: new DetachedLocalRetentionService()
    });
    await restarted.initialize();
    assert.equal((await readdir(root)).filter((name) => name.endsWith(".owner.json")).length, 1);
    assert.equal((await retentionWorkerCommands(batchId)).length, 1);

    await restarted.delete({ batchId, leaseId: receipt.leaseId });
    assert.equal((await retentionWorkerCommands(batchId)).length, 0);
    const artifacts = stagingArtifacts(root, batchId, receipt.leaseId);
    const remaining = (await readdir(root)).sort();
    assert.deepEqual(exactGenerationWorkerTempNames(remaining, artifacts), []);
    assert.deepEqual(remaining, [
      path.basename(artifacts.receipt),
      path.basename(artifacts.tombstone)
    ].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart replaces a static protocol-shaped owner that names an unrelated live PID", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-crashed-owner-"));
  const batchId = "fixture-crashed-owner-restart";
  const leaseId = "lease-crashed-owner-restart";
  try {
    const rootPath = path.join(directory, ".qwave-second-brain-staging");
    await mkdir(rootPath, { mode: 0o700 });
    const root = await realpath(rootPath);
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + (24 * 60 * 60 * 1000)).toISOString();
    await writeFile(artifacts.lease, `${JSON.stringify({
      version: 1,
      batchId,
      leaseId,
      phase: "prepared",
      createdAt,
      expiresAt
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(artifacts.owner, `${JSON.stringify({
      version: 1,
      batchId,
      leaseId,
      expiresAt,
      workerId: "worker-crashed-fixture",
      claimNonce: "claim-unrelated-live-fixture",
      phase: "running",
      pid: process.pid,
      processNonce: "process-unrelated-live-fixture",
      processStartedAt: createdAt,
      startedAt: createdAt,
      heartbeatAt: createdAt
    })}\n`, { encoding: "utf8", mode: 0o600 });

    const service = new DetachedLocalRetentionService();
    const armed = await service.arm({ root, batchId, leaseId, expiresAt });
    assert.equal(armed.adopted, false);
    const replacement = JSON.parse(await readFile(artifacts.owner, "utf8"));
    assert.notEqual(replacement.workerId, "worker-crashed-fixture");
    assert.notEqual(replacement.processNonce, "process-unrelated-live-fixture");
    assert.notEqual(replacement.pid, process.pid);
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 1);

    await service.disarm({ root, batchId, leaseId });
    await unlink(artifacts.lease);
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale old-generation worker exits without forging a receipt or deleting a later same-ID stage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-generation-reuse-"));
  const batchId = "fixture-generation-reuse";
  try {
    const root = path.join(directory, ".qwave-second-brain-staging");
    const staging = new LocalTemporaryStaging({ root, retentionService: new DetachedLocalRetentionService() });
    const oldReceipt = await staging.stage({ batchId, records: [inertStagingRecord()], createdAt: new Date().toISOString() });
    const oldArtifacts = stagingArtifacts(root, batchId, oldReceipt.leaseId);
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 1);

    // Model the creator crashing after another recovery path removed the old
    // generation but before it could cancel the detached worker.
    await unlink(oldArtifacts.data);
    await unlink(oldArtifacts.lease);
    const newReceipt = await staging.stage({
      batchId,
      records: [inertStagingRecord({ sourceRecordId: "fixture-new-generation-record" })],
      createdAt: new Date(Date.now() + 1_000).toISOString()
    });
    const newArtifacts = stagingArtifacts(root, batchId, newReceipt.leaseId);
    assert.notEqual(newArtifacts.data, oldArtifacts.data);

    await waitFor(async () => !(await readdir(root)).includes(path.basename(oldArtifacts.owner)));
    await assert.rejects(() => lstat(oldArtifacts.receipt), (error) => error?.code === "ENOENT");
    await assert.rejects(() => lstat(oldArtifacts.tombstone), (error) => error?.code === "ENOENT");
    const newStage = await staging.read({ batchId, leaseId: newReceipt.leaseId });
    assert.equal(newStage.records[0].sourceRecordId, "fixture-new-generation-record");
    assert.equal((await lstat(newArtifacts.data)).isFile(), true);
    assert.equal((await lstat(newArtifacts.lease)).isFile(), true);

    await staging.delete({ batchId, leaseId: newReceipt.leaseId });
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 0);
    assert.deepEqual((await readdir(root)).filter((name) => (
      name.endsWith(".receipt.json") || name.endsWith(".tombstone.json")
    )).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the detached worker retries a transient directory-permission deletion failure and exits after cleanup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-worker-retry-"));
  const batchId = "fixture-worker-unlink-retry";
  const leaseId = "lease-worker-unlink-retry";
  try {
    const rootPath = path.join(directory, ".qwave-second-brain-staging");
    await mkdir(rootPath, { mode: 0o700 });
    const root = await realpath(rootPath);
    const artifacts = stagingArtifacts(root, batchId, leaseId);
    const expiresAt = new Date(Date.now() + 500).toISOString();
    const createdAt = new Date(Date.parse(expiresAt) - (24 * 60 * 60 * 1000)).toISOString();
    await writeFile(artifacts.lease, `${JSON.stringify({
      version: 1,
      batchId,
      leaseId,
      phase: "ready",
      createdAt,
      expiresAt
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(artifacts.data, `${JSON.stringify({ batchId, leaseId, createdAt, expiresAt })}\n`, { encoding: "utf8", mode: 0o600 });
    const service = new DetachedLocalRetentionService();
    await service.arm({ root, batchId, leaseId, expiresAt });
    await chmod(root, 0o500);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    assert.equal((await lstat(artifacts.data)).isFile(), true);
    assert.equal((await retentionWorkerCommands(batchId)).length, 1);

    await chmod(root, 0o700);
    await waitFor(async () => {
      const names = await readdir(root);
      return names.includes(path.basename(artifacts.receipt))
        && !names.includes(path.basename(artifacts.owner));
    });
    await waitFor(async () => (await retentionWorkerCommands(batchId)).length === 0);
    assert.deepEqual(
      (await readdir(root)).sort(),
      [path.basename(artifacts.receipt), path.basename(artifacts.tombstone)].sort()
    );
  } finally {
    try { await chmod(path.join(directory, ".qwave-second-brain-staging"), 0o700); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test("detached cleanup workers inherit no caller sentinel or ambient environment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-worker-env-"));
  const previousSentinel = process.env.QWA146_RETENTION_SENTINEL;
  try {
    const rootPath = path.join(directory, ".qwave-second-brain-staging");
    await mkdir(rootPath, { mode: 0o700 });
    const root = await realpath(rootPath);
    const batchId = "fixture-worker-minimal-env";
    const leaseId = "lease-worker-minimal-env";
    const workerPath = path.join(process.cwd(), "test-support", "qwa146-env-observer-worker.mjs");
    const service = new DetachedLocalRetentionService({ workerPath });
    process.env.QWA146_RETENTION_SENTINEL = "must-not-cross-worker-boundary";
    await service.arm({
      root,
      batchId,
      leaseId,
      expiresAt: new Date(Date.now() + 5_000).toISOString()
    });
    const observationPath = path.join(root, `env-observation-${batchId}.json`);
    await waitFor(async () => (await lstat(observationPath)).isFile());
    const observation = JSON.parse(await readFile(observationPath, "utf8"));
    assert.equal(observation.inheritedSentinel, false);
    assert.deepEqual(
      observation.environmentKeys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"),
      [],
      "macOS may add its non-secret text-encoding marker; no caller environment is inherited"
    );
    await service.disarm({ root, batchId, leaseId });
    await unlink(observationPath);
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (previousSentinel === undefined) delete process.env.QWA146_RETENTION_SENTINEL;
    else process.env.QWA146_RETENTION_SENTINEL = previousSentinel;
    await rm(directory, { recursive: true, force: true });
  }
});
