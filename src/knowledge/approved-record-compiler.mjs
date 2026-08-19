/**
 * QWA-146 approved-record compiler.
 *
 * This is deliberately a simulation/contract boundary. It accepts only
 * bounded, already-approved normalized references from the QWA-139 grant
 * lifecycle. It neither connects to a source nor accepts source bodies. The
 * only filesystem persistence in this slice is a short-lived, private staging
 * batch; derived canonical projections are returned to the caller and may be
 * saved by that caller's already-private state store.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  readFile,
  rename,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath } from "node:url";
import { trustedFileStateStoreFacade } from "../adapters/simulated-dependencies.mjs";
import {
  assertPersistedSourcePermissionGrantStillMatchesReview,
  SENSITIVE_CATEGORIES,
  withSourcePermissionStateLock
} from "../permissions/setup-source-permissions.mjs";

const STATE_KEY = "knowledgeCompilationLifecycle";
const STAGING_DIRECTORY_NAME = ".qwave-second-brain-staging";
const STAGING_FILE_PREFIX = "batch-";
const STAGING_FILE_SUFFIX = ".json";
const STAGING_LEASE_SUFFIX = ".lease.json";
const STAGING_RECEIPT_SUFFIX = ".receipt.json";
const STAGING_TOMBSTONE_SUFFIX = ".tombstone.json";
const STAGING_OWNER_SUFFIX = ".owner.json";
const STAGING_VERSION = 1;
const RETENTION_ARTIFACT_VERSION = 1;
const INTERNAL_CLEANUP_ACKNOWLEDGEMENT = Symbol("qwave-internal-cleanup-acknowledgement");
const INTERNAL_LOCAL_STAGING_OPERATION = Symbol("qwave-internal-local-staging-operation");
const LOCAL_STAGING_OPERATION_TAILS = new Map();
const LOCAL_STAGING_AUTHORITIES = new WeakMap();
const TRUSTED_LOCAL_STAGING_FACADES = new WeakSet();
const TRUSTED_DETACHED_RETENTION_FACADES = new WeakMap();
let LOCAL_TEMPORARY_STAGING_METHODS = null;
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
const COMPLETION_CLOCK_SKEW_MS = 60_000;
const GENERATION_TAG = /^[a-f0-9]{24}$/;
const RETENTION_OWNER_FRESH_MS = 5_000;
const RETENTION_OWNER_PROBE_MS = 1_250;
const RETENTION_QUIESCENCE_POLL_MS = 25;
const RETENTION_QUIESCENCE_TIMEOUT_MS = 5_000;
const RETENTION_SIGNAL_GRACE_MS = 500;
const RETENTION_SIGNAL_TIMEOUT_MS = 2_000;
const MAX_STAGING_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH_RECORDS = 100;
const MAX_STAGING_BYTES = 256 * 1024;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RETENTION_WORKER_PATH = fileURLToPath(new URL("./private-staging-retention-worker.mjs", import.meta.url));
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SOURCE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const CONFIDENCE_LEVELS = new Set(["confirmed", "likely", "uncertain"]);
const PRIVACY_RESTRICTIONS = new Set([
  "private",
  "restricted",
  "owner-only",
  "no-external-sharing",
  "sensitive",
  "generated-only"
]);
const SUBJECT_TYPES = Object.freeze({
  people: { directory: "People", en: "People", es: "Personas" },
  organizations: { directory: "Organizations", en: "Organizations", es: "Organizaciones" },
  projects: { directory: "Projects", en: "Projects", es: "Proyectos" },
  decisions: { directory: "Decisions", en: "Decisions", es: "Decisiones" },
  priorities: { directory: "Priorities", en: "Priorities", es: "Prioridades" },
  areas: { directory: "Areas", en: "Areas", es: "Áreas" },
  meetings: { directory: "Meetings", en: "Meetings", es: "Reuniones" },
  knowledge: { directory: "Knowledge", en: "Knowledge", es: "Conocimiento" }
});
const RECORD_FIELDS = new Set([
  "source",
  "accountId",
  "sourceRecordId",
  "reviewId",
  "grantId",
  "processingDisposition",
  "sourceTimestamp",
  "approvedParticipantRefs",
  "sourceLabel",
  "stableLink",
  "observedAt",
  "verifiedAt",
  "privacyRestrictions",
  "assertions"
]);
const ASSERTION_FIELDS = new Set([
  "subjectType",
  "subjectId",
  "subjectLabel",
  "assertion",
  "confidence",
  "privacyRestrictions"
]);

async function runLocalStagingOperation(root, operation) {
  const previous = LOCAL_STAGING_OPERATION_TAILS.get(root) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const tail = previous.catch(() => {}).then(() => gate);
  LOCAL_STAGING_OPERATION_TAILS.set(root, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (LOCAL_STAGING_OPERATION_TAILS.get(root) === tail) {
      LOCAL_STAGING_OPERATION_TAILS.delete(root);
    }
  }
}

function localStagingAuthority(staging) {
  return LOCAL_STAGING_AUTHORITIES.get(staging) ?? null;
}

function isTrustedLocalStagingFacade(staging) {
  return TRUSTED_LOCAL_STAGING_FACADES.has(staging);
}
const RAW_STAGING_FIELDS = /^(?:body|html|text|content|snippet|raw|payload|headers?|attachments?|config(?:uration)?|secrets?|tokens?|passwords?)$/i;
const DANGEROUS_TEXT = /\b(?:ignore\s+(?:all\s+)?(?:previous|prior)|system\s+prompt|developer\s+message|reveal\s+(?:a\s+)?secret|grant\s+access|run\s+(?:a\s+)?command|execute\s+(?:a\s+)?command|curl\s+https?:|powershell|bash\s+-c)\b/i;
const SENSITIVE_TEXT = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\d[ -]?){9,}\b|\b(?:api[ _-]?key|password|passcode|secret|access[ _-]?token|bearer)\b)/i;
const DEFAULT_STAGING_FILE_SYSTEM = Object.freeze({
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  readFile,
  rename,
  unlink,
  utimes,
  writeFile
});

export class KnowledgeCompilationError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "KnowledgeCompilationError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

class UnsafeRetentionArtifactError extends Error {
  constructor() {
    super("unsafe retention artifact");
    this.name = "UnsafeRetentionArtifactError";
  }
}

function clone(value) {
  return structuredClone(value);
}

function boundedCleanupReason(value) {
  return typeof value === "string" && CLEANUP_REASONS.has(value) ? value : "unknown-cleanup";
}

function discardedCleanupStatus(reason, { tracked = true } = {}) {
  if (!tracked && reason === "expired") return "discarded-untracked-generation";
  if (reason === "invalid-generation") return "discarded-invalid-generation";
  if (reason === "orphaned-generation") return "discarded-orphaned-generation";
  if (reason === "retention-unavailable") return "discarded-retention-unavailable";
  if (reason === "verified-early-absence") return "discarded-verified-early-absence";
  return tracked ? "discarded-non-expiry-cleanup" : "discarded-untracked-generation";
}

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function addHours(iso, hours) {
  return new Date(Date.parse(iso) + (hours * 60 * 60 * 1000)).toISOString();
}

function assertStateStore(stateStore) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent private stateStore with load() and save() is required.");
  }
}

function assertNaturalLanguage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new KnowledgeCompilationError(
      "COMPILATION_MESSAGE_REQUIRED",
      "Tell me in normal language that you want to compile your approved notes."
    );
  }
  if (message.trim().startsWith("/")) {
    throw new KnowledgeCompilationError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Tell me in normal language that you want to compile the approved notes."
    );
  }
  if (!/(compile|canonical|notes?|resume|continue|compila|can[oó]nic|notas?|contin[uú]a)/i.test(message)) {
    throw new KnowledgeCompilationError(
      "UNRECOGNIZED_COMPILATION_REQUEST",
      "Tell me you would like to compile or continue your approved notes, and I will keep the source boundary private."
    );
  }
}

function languageFor(state, language) {
  return language === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function wording(language) {
  if (language === "es") {
    return {
      ready: "Las notas canónicas se compilaron solo a partir de referencias normalizadas aprobadas. No se conservó ningún lote de fuente después de la compilación.",
      compiledCleanupPending: "Las notas canónicas ya están guardadas. La eliminación confirmada del lote privado sigue pendiente; di que continúe para volver a intentar solo la limpieza.",
      cleanupAuthorityRequired: "El lote privado sigue retenido porque solo el almacenamiento temporal local exacto puede confirmar su eliminación. Vuelve a intentar con ese almacenamiento local; un adaptador personalizado o envuelto no puede informar que se eliminó.",
      cleanupNeedsAttention: "La limpieza no pudo verificar la eliminación de este lote privado porque otro enlace del sistema de archivos o una discrepancia de identidad/evidencia podría conservarlo. No se informó como eliminado: solicita una revisión local segura y luego di que continúe.",
      cleanupFinalizationNeedsAttention: "Los cuerpos privados de la fuente ya se eliminaron, pero la limpieza local todavía necesita atención segura antes de poder informar que el proceso y sus artefactos duraderos terminaron por completo. Di que continúe para volver a intentarlo.",
      discardedCleanupPending: "El lote privado se descartó y sigue pendiente de eliminación confirmada; di que continúe para volver a intentar solo la limpieza.",
      discarded: "El lote temporal se descartó de forma segura y no se puede reanudar.",
      interrupted: "La compilación se interrumpió antes de producir notas. El lote temporal protegido sigue disponible para reanudarlo durante un máximo de 24 horas.",
      expiredCleanupPending: "El lote temporal venció y ya no se puede compilar, pero su eliminación confirmada sigue pendiente. Vuelve a intentar la limpieza con el almacenamiento temporal local exacto.",
      expired: "El lote temporal venció y se eliminó. Para proteger tu privacidad, necesitarás aprobar un lote nuevo antes de continuar.",
      generatedHeading: "Afirmaciones canónicas generadas",
      yourNotesHeading: "Tus notas",
      generatedBoundary: "Este bloque es generado por QWave a partir de evidencia aprobada. No es una fuente original.",
      yourNotesBoundary: "Escribe tus notas aquí. Este bloque pertenece a la persona usuaria y no se sobrescribe.",
      sourceHeading: "Referencias de fuente",
      sourceIndexHeading: "Índice de fuentes",
      sourceIndexBoundary: "Navegación generada solamente. Las afirmaciones autorizadas permanecen en las notas canónicas enlazadas.",
      unknown: "Desconocido (sin evidencia aprobada)",
      observed: "Observado",
      verified: "Verificado",
      notVerified: "Aún no verificado",
      confidence: "Confianza",
      privacy: "Restricciones de privacidad",
      claim: "Afirmación",
      claimIds: "IDs de afirmación",
      sourceReference: "Referencia de fuente",
      review: "revisión",
      grant: "concesión",
      sourceTimestamp: "Fecha de la fuente",
      participants: "Referencias de participantes aprobadas",
      sourceLabel: "Etiqueta de fuente aprobada",
      stableLink: "Enlace estable",
      noStableLink: "Sin enlace estable aprobado",
      processed: "Procesado",
      simulated: "Simulación local; no se leyó ninguna fuente real."
    };
  }
  return {
    ready: "Canonical notes were compiled only from approved normalized references. No source batch was retained after compilation.",
    compiledCleanupPending: "Canonical notes are already saved. Confirmed deletion of the private batch is still pending; say continue to retry cleanup only.",
    cleanupAuthorityRequired: "The private batch is still retained because only the exact local temporary staging engine can confirm its deletion. Retry with that local staging engine; a custom or wrapped adapter cannot report it deleted.",
    cleanupNeedsAttention: "Cleanup could not verify deletion of this private batch because another filesystem link or an identity/evidence mismatch may retain it. It was not reported deleted: request safe local review, then say continue.",
    cleanupFinalizationNeedsAttention: "The private source bodies are deleted, but local cleanup still needs safe attention before the worker and durable artifacts can be reported fully finished. Say continue to retry cleanup.",
    discardedCleanupPending: "The private batch was discarded and still awaits confirmed deletion; say continue to retry cleanup only.",
    discarded: "The temporary batch was safely discarded and cannot be resumed.",
    interrupted: "Compilation stopped before notes were produced. The protected temporary batch remains available to resume for no more than 24 hours.",
    expiredCleanupPending: "The temporary batch expired and can no longer be compiled, but confirmed deletion is still pending. Retry cleanup with the exact local temporary staging engine.",
    expired: "The temporary batch expired and was deleted. To protect your privacy, approve a new batch before continuing.",
    generatedHeading: "Generated canonical claims",
    yourNotesHeading: "Your notes",
    generatedBoundary: "This block is generated by QWave from approved evidence. It is not an original source.",
    yourNotesBoundary: "Write your notes here. This block is user-owned and is never overwritten.",
    sourceHeading: "Source references",
    sourceIndexHeading: "Source index",
    sourceIndexBoundary: "Generated navigation only. Authoritative claims remain in the linked canonical notes.",
    unknown: "Unknown (no approved evidence)",
    observed: "Observed",
    verified: "Verified",
    notVerified: "Not yet verified",
    confidence: "Confidence",
    privacy: "Privacy restrictions",
    claim: "Claim",
    claimIds: "Claim IDs",
    sourceReference: "Source reference",
    review: "review",
    grant: "grant",
    sourceTimestamp: "Source timestamp",
    participants: "Approved participant references",
    sourceLabel: "Approved source label",
    stableLink: "Stable link",
    noStableLink: "No approved stable link",
    processed: "Processed",
    simulated: "Local simulation; no real source was read."
  };
}

function isWithin(candidate, root) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function assertDedicatedStagingRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new KnowledgeCompilationError(
      "STAGING_ROOT_INVALID",
      "Temporary staging must use one dedicated absolute local directory."
    );
  }
  const normalized = resolve(root);
  if (normalized === resolve(sep) || basename(normalized) !== STAGING_DIRECTORY_NAME) {
    throw new KnowledgeCompilationError(
      "STAGING_ROOT_TOO_BROAD",
      "Temporary staging must use only the dedicated .qwave-second-brain-staging directory, never a broad filesystem root."
    );
  }
  if (isWithin(normalized, REPOSITORY_ROOT)) {
    throw new KnowledgeCompilationError(
      "STAGING_PUBLIC_REPOSITORY_BLOCKED",
      "Temporary source staging cannot be placed in this repository. Choose a private local temporary directory."
    );
  }
  return normalized;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

async function repositoryRealRoot() {
  try {
    return await realpath(REPOSITORY_ROOT);
  } catch {
    return REPOSITORY_ROOT;
  }
}

async function hasGitRepositoryAncestor(start) {
  let current = start;
  while (true) {
    try {
      // A worktree may use a .git file while a conventional clone uses a
      // directory. Either means staging here would put private material in a
      // repository, including a public installer repository.
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new KnowledgeCompilationError(
          "STAGING_PARENT_INVALID",
          "I could not safely inspect the temporary staging parent, so no source batch was staged."
        );
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function assertBatchId(batchId) {
  if (typeof batchId !== "string" || !BATCH_ID.test(batchId)) {
    throw new KnowledgeCompilationError(
      "BATCH_ID_INVALID",
      "Use a short opaque batch ID with letters, numbers, dots, underscores, or hyphens."
    );
  }
  return batchId;
}

function generationTagForLease(leaseId) {
  const safeLeaseId = assertOpaqueId(leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
  return createHash("sha256").update(safeLeaseId).digest("hex").slice(0, 24);
}

function assertGenerationTag(generationTag) {
  if (typeof generationTag !== "string" || !GENERATION_TAG.test(generationTag)) {
    throw new KnowledgeCompilationError(
      "STAGING_CLEANUP_EVIDENCE_REQUIRED",
      "Cleanup evidence did not identify one exact protected staging generation."
    );
  }
  return generationTag;
}

function generationArtifactBaseForTag(batchId, generationTag) {
  return `${STAGING_FILE_PREFIX}${assertBatchId(batchId)}.${assertGenerationTag(generationTag)}`;
}

function generationArtifactBase(batchId, leaseId) {
  return generationArtifactBaseForTag(batchId, generationTagForLease(leaseId));
}

function stagingFileName(batchId, leaseId) { return `${generationArtifactBase(batchId, leaseId)}${STAGING_FILE_SUFFIX}`; }
function stagingLeaseFileName(batchId, leaseId) { return `${generationArtifactBase(batchId, leaseId)}${STAGING_LEASE_SUFFIX}`; }
function stagingReceiptFileName(batchId, leaseId) { return `${generationArtifactBase(batchId, leaseId)}${STAGING_RECEIPT_SUFFIX}`; }
function stagingTombstoneFileName(batchId, leaseId) { return `${generationArtifactBase(batchId, leaseId)}${STAGING_TOMBSTONE_SUFFIX}`; }
function stagingOwnerFileName(batchId, leaseId) { return `${generationArtifactBase(batchId, leaseId)}${STAGING_OWNER_SUFFIX}`; }

function generationWorkerArtifactNames(batchId, leaseId) {
  return generationWorkerArtifactNamesForTag(batchId, generationTagForLease(leaseId));
}

function generationWorkerArtifactNamesForTag(batchId, generationTag) {
  const base = generationArtifactBaseForTag(batchId, generationTag);
  return [
    `${base}${STAGING_RECEIPT_SUFFIX}`,
    `${base}${STAGING_TOMBSTONE_SUFFIX}`,
    `${base}${STAGING_OWNER_SUFFIX}`
  ];
}

function isGenerationWorkerTemp(name, artifactNames) {
  if (typeof name !== "string") return false;
  return artifactNames.some((artifactName) => {
    if (!name.startsWith(`${artifactName}.`) || !name.endsWith(".tmp")) return false;
    return /^[0-9]+$/.test(name.slice(artifactName.length + 1, -4));
  });
}

async function nativeGenerationWorkerTempNames(root, batchId, leaseId) {
  return nativeGenerationWorkerTempNamesForTag(root, batchId, generationTagForLease(leaseId));
}

async function nativeGenerationWorkerTempNamesForTag(root, batchId, generationTag) {
  const artifactNames = generationWorkerArtifactNamesForTag(batchId, generationTag);
  const entries = await readdir(root);
  return entries.filter((entry) => isGenerationWorkerTemp(entry, artifactNames));
}

async function assertNativeGenerationWorkerTempsAbsent(root, batchId, leaseId) {
  return assertNativeGenerationWorkerTempsAbsentForTag(root, batchId, generationTagForLease(leaseId));
}

async function assertNativeGenerationWorkerTempsAbsentForTag(root, batchId, generationTag) {
  if ((await nativeGenerationWorkerTempNamesForTag(root, batchId, generationTag)).length > 0) {
    throw new KnowledgeCompilationError(
      "RETENTION_SERVICE_UNAVAILABLE",
      "The exact cleanup worker still has an unfinished durable write, so deletion remains pending."
    );
  }
}

function parseGenerationArtifact(name, suffix) {
  if (typeof name !== "string" || !name.startsWith(STAGING_FILE_PREFIX) || !name.endsWith(suffix)) return null;
  const stem = name.slice(STAGING_FILE_PREFIX.length, -suffix.length);
  const separator = stem.lastIndexOf(".");
  if (separator <= 0) return null;
  const batchId = stem.slice(0, separator);
  const generationTag = stem.slice(separator + 1);
  return BATCH_ID.test(batchId) && GENERATION_TAG.test(generationTag) ? { batchId, generationTag } : null;
}

function parseGenerationWorkerTempArtifact(name) {
  if (typeof name !== "string" || !name.endsWith(".tmp")) return null;
  const withoutTemp = name.slice(0, -4);
  const pidSeparator = withoutTemp.lastIndexOf(".");
  if (pidSeparator <= 0) return null;
  const pidText = withoutTemp.slice(pidSeparator + 1);
  if (!/^[0-9]+$/.test(pidText)) return null;
  const artifactName = withoutTemp.slice(0, pidSeparator);
  for (const [kind, suffix] of [
    ["receipt", STAGING_RECEIPT_SUFFIX],
    ["tombstone", STAGING_TOMBSTONE_SUFFIX],
    ["owner", STAGING_OWNER_SUFFIX]
  ]) {
    const parsed = parseGenerationArtifact(artifactName, suffix);
    if (parsed) return { ...parsed, kind, pid: Number(pidText) };
  }
  return null;
}

function exactCanonicalTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  const canonical = new Date(value).toISOString();
  return canonical === value ? canonical : null;
}

function unsupportedDirectorySync(error) {
  return new Set(["EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"]).has(error?.code);
}

async function syncDirectoryEntry(fileSystem, directory) {
  let handle;
  try {
    handle = await fileSystem.open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    try { await handle?.close(); } catch (error) { if (!unsupportedDirectorySync(error)) throw error; }
  }
}

async function durableWrite(fileSystem, target, serialized, { exclusive = false } = {}) {
  const directory = dirname(target);
  const writePath = exclusive ? target : `${target}.${randomUUID()}.tmp`;
  let handle;
  let created = false;
  let failure = null;
  try {
    handle = await fileSystem.open(
      writePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    created = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  if (handle) {
    try { await handle.close(); } catch (error) { failure ??= error; }
  }
  if (failure) {
    if (created) {
      try { await fileSystem.unlink(writePath); } catch {}
      try { await syncDirectoryEntry(fileSystem, directory); } catch {}
    }
    throw failure;
  }
  if (!exclusive) {
    try {
      await fileSystem.rename(writePath, target);
    } catch (error) {
      try { await fileSystem.unlink(writePath); } catch {}
      throw error;
    }
  }
  await syncDirectoryEntry(fileSystem, directory);
}

async function durableJsonWrite(fileSystem, target, value, options) {
  return durableWrite(fileSystem, target, `${JSON.stringify(value)}\n`, options);
}

async function readSmallJson(fileSystem, target, maxBytes = 16 * 1024) {
  const stats = await fileSystem.lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
    throw new UnsafeRetentionArtifactError();
  }
  let handle;
  try {
    handle = await fileSystem.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return JSON.parse(await handle.readFile({ encoding: "utf8" }));
  } finally {
    await handle?.close();
  }
}

async function pathIsAbsent(fileSystem, target) {
  try {
    await fileSystem.lstat(target);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function assertNativePathsAbsent(targets, customerMessage) {
  for (const target of targets) {
    if (!await pathIsAbsent(DEFAULT_STAGING_FILE_SYSTEM, target)) {
      throw new KnowledgeCompilationError(
        "STAGING_DELETE_FAILED",
        customerMessage
      );
    }
  }
}

async function nativeDeletionWitness(target, multipleLinksCode = "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION") {
  const before = await lstat(target);
  if (before.isSymbolicLink?.()) return { handle: null, symbolicLink: true };
  assertSingleLinkRegularFile(before, multipleLinksCode);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    assertSingleLinkRegularFile(opened, multipleLinksCode);
    if (!sameFileIdentity(before, opened)) {
      throw new KnowledgeCompilationError(
        "STAGING_FILE_IDENTITY_CHANGED",
        "The protected generation changed immediately before deletion. Cleanup remains armed and needs a safe retry."
      );
    }
    return { handle, symbolicLink: false };
  } catch (error) {
    try { await handle?.close(); } catch {}
    throw error;
  }
}

async function closeNativeDeletionWitness(witness) {
  if (!witness?.handle) return;
  const handle = witness.handle;
  witness.handle = null;
  await handle.close();
}

async function finishNativeDeletionWitness(witness, target, customerMessage) {
  let linksAfterUnlink = null;
  let failure = null;
  if (witness.handle) {
    try { linksAfterUnlink = (await witness.handle.stat()).nlink; } catch (error) { failure = error; }
    try { await closeNativeDeletionWitness(witness); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  if (linksAfterUnlink !== null && linksAfterUnlink !== 0) {
    throw new KnowledgeCompilationError(
      "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION",
      customerMessage
    );
  }
  await assertNativePathsAbsent([target], customerMessage);
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function assertSingleLinkRegularFile(stats, code = "STAGING_HARDLINK_BLOCKED") {
  if (!stats?.isFile?.() || stats.isSymbolicLink?.()) {
    throw new KnowledgeCompilationError(
      "STAGING_SYMLINK_BLOCKED",
      "Temporary staging refused a symbolic link or non-file batch."
    );
  }
  if (stats.nlink !== 1) {
    throw new KnowledgeCompilationError(
      code,
      "The protected generation has another filesystem link or is not a private regular file. Processing stopped and retention remains armed pending safe review."
    );
  }
}

async function unlinkAndSync(fileSystem, target, { ignoreMissing = true } = {}) {
  try {
    await fileSystem.unlink(target);
    await syncDirectoryEntry(fileSystem, dirname(target));
    return true;
  } catch (error) {
    if (ignoreMissing && error?.code === "ENOENT") return false;
    throw error;
  }
}

function validatedRetentionOwner(value, { batchId, leaseId, expiresAt }) {
  const baseValid = (
    value?.version !== RETENTION_ARTIFACT_VERSION
  ) ? false : (
    value.batchId === batchId
    && value.leaseId === leaseId
    && value.expiresAt === expiresAt
    && generationTagForLease(value.leaseId) === generationTagForLease(leaseId)
    && typeof value.workerId === "string"
    && OPAQUE_ID.test(value.workerId)
    && typeof value.claimNonce === "string"
    && OPAQUE_ID.test(value.claimNonce)
    && exactCanonicalTimestamp(value.startedAt)
    && exactCanonicalTimestamp(value.heartbeatAt)
    && ["claimed", "running"].includes(value.phase)
  );
  if (!baseValid) return null;
  if (value.phase === "claimed") {
    if (value.pid !== undefined || value.processNonce !== undefined || value.processStartedAt !== undefined) return null;
    return value;
  }
  if (
    !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.processNonce !== "string"
    || !OPAQUE_ID.test(value.processNonce)
    || !exactCanonicalTimestamp(value.processStartedAt)
  ) return null;
  return value;
}

function assertNoRawStagingMaterial(value, depth = 0) {
  if (depth > 16) {
    throw new KnowledgeCompilationError("STAGING_PAYLOAD_TOO_DEEP", "The temporary batch is too deeply nested to inspect safely.");
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoRawStagingMaterial(item, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (RAW_STAGING_FIELDS.test(key)) {
      throw new KnowledgeCompilationError(
        "RAW_SOURCE_FIELD_BLOCKED",
        "Temporary staging never accepts raw source bodies, headers, attachments, configuration, or secrets."
      );
    }
    assertNoRawStagingMaterial(nested, depth + 1);
  }
}

function validatedStagingPayload(payload, batchId, maxRecords) {
  if (
    !payload
    || payload.version !== STAGING_VERSION
    || payload.batchId !== batchId
    || !Array.isArray(payload.records)
    || payload.records.length === 0
    || payload.records.length > maxRecords
  ) {
    throw new KnowledgeCompilationError(
      "STAGING_BATCH_INVALID",
      "The protected temporary batch was not valid, so it was not compiled."
    );
  }
  assertNoRawStagingMaterial(payload.records);
  const records = normalizeInertStagingRecords(payload.records, { maxRecords });
  const leaseId = assertOpaqueId(payload.leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
  const createdAt = canonicalTimestamp(payload.createdAt, "STAGING_TIMESTAMP_INVALID");
  const expiresAt = canonicalTimestamp(payload.expiresAt, "STAGING_TIMESTAMP_INVALID");
  if (expiresAt !== addHours(createdAt, 24)) {
    throw new KnowledgeCompilationError(
      "STAGING_TIMESTAMP_INVALID",
      "The protected temporary batch did not preserve its fixed 24-hour expiry, so it was not compiled."
    );
  }
  return { batchId, leaseId, createdAt, expiresAt, records };
}

function retentionWorkerKey(root, batchId, leaseId) {
  return `${root}\u0000${batchId}\u0000${leaseId}`;
}

/**
 * Arms one detached, local-only expiry worker before a staging file is
 * created. The worker receives only the staging root, opaque batch ID, and
 * fixed deadline — never records, source bodies, credentials, or logging
 * destinations — and remains alive if the creating compiler process exits.
 */
export class DetachedLocalRetentionService {
  #workerPath;
  #fileSystem;
  #workers = new Map();

  constructor({ workerPath = RETENTION_WORKER_PATH, fileSystem = {} } = {}) {
    const fileSystemOverrides = Object.freeze({ ...fileSystem });
    this.#workerPath = workerPath;
    this.#fileSystem = Object.freeze({ ...DEFAULT_STAGING_FILE_SYSTEM, ...fileSystemOverrides });
    if (
      new.target === DetachedLocalRetentionService
      && workerPath === RETENTION_WORKER_PATH
      && Object.keys(fileSystemOverrides).length === 0
    ) {
      const instance = this;
      TRUSTED_DETACHED_RETENTION_FACADES.set(this, Object.freeze({
        arm(input) {
          return instance.#arm(input);
        },
        disarm(input) {
          return instance.#disarm(input);
        },
        finalizeDeletion(input) {
          return instance.#disarm(input, true);
        }
      }));
    }
  }

  async #removeOwnerIfMatches({ root, batchId, leaseId, workerId = null }) {
    const ownerPath = join(root, stagingOwnerFileName(batchId, leaseId));
    let owner;
    try { owner = await readSmallJson(this.#fileSystem, ownerPath); } catch { return false; }
    if (owner?.batchId !== batchId || owner?.leaseId !== leaseId || (workerId && owner?.workerId !== workerId)) return false;
    try { await unlinkAndSync(this.#fileSystem, ownerPath); } catch { return false; }
    return true;
  }

  #sameRunningOwner(left, right) {
    return Boolean(
      left?.phase === "running"
      && right?.phase === "running"
      && left.batchId === right.batchId
      && left.leaseId === right.leaseId
      && left.expiresAt === right.expiresAt
      && left.workerId === right.workerId
      && left.claimNonce === right.claimNonce
      && left.pid === right.pid
      && left.processNonce === right.processNonce
      && left.processStartedAt === right.processStartedAt
    );
  }

  async #currentMatchingOwner({ root, batchId, leaseId, expectedOwner }) {
    const ownerPath = join(root, stagingOwnerFileName(batchId, leaseId));
    let current;
    try {
      current = validatedRetentionOwner(
        await readSmallJson(this.#fileSystem, ownerPath),
        { batchId, leaseId, expiresAt: expectedOwner.expiresAt }
      );
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    return this.#sameRunningOwner(current, expectedOwner) ? current : false;
  }

  async #matchingWorkerReceipt({ root, batchId, leaseId, owner }) {
    const receiptPath = join(root, stagingReceiptFileName(batchId, leaseId));
    let receipt;
    try { receipt = await readSmallJson(this.#fileSystem, receiptPath); } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const valid = (
      receipt?.version === RETENTION_ARTIFACT_VERSION
      && receipt.batchId === batchId
      && receipt.leaseId === leaseId
      && exactCanonicalTimestamp(receipt.deletedAt)
      && receipt.writer === "retention-worker"
      && typeof receipt.workerId === "string"
      && OPAQUE_ID.test(receipt.workerId)
      && typeof receipt.claimNonce === "string"
      && OPAQUE_ID.test(receipt.claimNonce)
      && Number.isSafeInteger(receipt.pid)
      && receipt.pid > 0
      && typeof receipt.processNonce === "string"
      && OPAQUE_ID.test(receipt.processNonce)
      && exactCanonicalTimestamp(receipt.processStartedAt)
    );
    if (!valid) return null;
    if (!owner) return receipt;
    return (
      receipt.workerId === owner.workerId
      && receipt.claimNonce === owner.claimNonce
      && receipt.pid === owner.pid
      && receipt.processNonce === owner.processNonce
      && receipt.processStartedAt === owner.processStartedAt
    ) ? receipt : null;
  }

  #childExited(descriptor) {
    if (!descriptor?.child) return Boolean(descriptor?.exited);
    return Boolean(
      descriptor.exited
      || descriptor.child.exitCode !== null
      || descriptor.child.signalCode !== null
    );
  }

  async #waitForChildExit(descriptor, timeoutMs) {
    if (!descriptor?.child || this.#childExited(descriptor)) return true;
    const child = descriptor.child;
    return new Promise((resolveExit) => {
      let settled = false;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.removeListener("exit", onExit);
        child.removeListener("close", onExit);
        if (exited) descriptor.exited = true;
        resolveExit(exited);
      };
      const onExit = () => finish(true);
      const timeout = setTimeout(() => finish(this.#childExited(descriptor)), timeoutMs);
      child.once("exit", onExit);
      child.once("close", onExit);
    });
  }

  #pidIsGone(pid) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      if (error?.code === "EPERM") return false;
      throw error;
    }
  }

  async #waitForPidExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (this.#pidIsGone(pid)) return true;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, RETENTION_QUIESCENCE_POLL_MS));
    }
    return this.#pidIsGone(pid);
  }

  async #cleanupExactWorkerTemps({ root, batchId, leaseId, pid }) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "Private cleanup could not validate its worker process identity, so deletion remains pending."
      );
    }
    const artifactNames = generationWorkerArtifactNames(batchId, leaseId);
    for (const name of artifactNames) {
      const target = join(root, `${name}.${pid}.tmp`);
      if (dirname(target) !== root) {
        throw new KnowledgeCompilationError(
          "RETENTION_SERVICE_UNAVAILABLE",
          "Private cleanup could not validate its worker artifacts, so deletion remains pending."
        );
      }
      await unlinkAndSync(this.#fileSystem, target);
      await assertNativePathsAbsent(
        [target],
        "An exact cleanup-worker temporary artifact still exists, so deletion remains pending."
      );
    }
    await assertNativeGenerationWorkerTempsAbsent(root, batchId, leaseId);
  }

  async #removeExpectedOwner({ root, batchId, leaseId, owner }) {
    const current = await this.#currentMatchingOwner({ root, batchId, leaseId, expectedOwner: owner });
    if (current === false) {
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "Private cleanup ownership changed unexpectedly, so deletion remains pending."
      );
    }
    if (!current) return false;
    await unlinkAndSync(this.#fileSystem, join(root, stagingOwnerFileName(batchId, leaseId)), { ignoreMissing: false });
    return true;
  }

  async #stopKnownWorker(descriptor, { root, batchId, leaseId }) {
    if (this.#childExited(descriptor)) return;
    if (await this.#waitForChildExit(descriptor, RETENTION_SIGNAL_GRACE_MS)) return;
    try { descriptor.child.kill("SIGTERM"); } catch {}
    if (await this.#waitForChildExit(descriptor, RETENTION_SIGNAL_TIMEOUT_MS)) return;
    try { descriptor.child.kill("SIGKILL"); } catch {}
    if (await this.#waitForChildExit(descriptor, RETENTION_SIGNAL_TIMEOUT_MS)) return;
    throw new KnowledgeCompilationError(
      "RETENTION_SERVICE_UNAVAILABLE",
      `The private cleanup worker for ${batchId} did not stop cleanly; deletion remains pending for its exact generation.`
    );
  }

  async #runningOwnerForGeneration({ root, batchId, leaseId }) {
    const ownerPath = join(root, stagingOwnerFileName(batchId, leaseId));
    let raw;
    try {
      raw = await readSmallJson(this.#fileSystem, ownerPath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const expiresAt = exactCanonicalTimestamp(raw?.expiresAt);
    const owner = expiresAt
      ? validatedRetentionOwner(raw, { batchId, leaseId, expiresAt })
      : null;
    if (owner?.phase !== "running") {
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "Private cleanup ownership was not valid, so deletion remains pending."
      );
    }
    return owner;
  }

  async #quiescedTombstoneExists({ root, batchId, leaseId }) {
    const target = join(root, stagingTombstoneFileName(batchId, leaseId));
    let tombstone;
    try {
      tombstone = await readSmallJson(this.#fileSystem, target);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      if (error?.code) throw error;
      return false;
    }
    return Boolean(
      tombstone?.version === RETENTION_ARTIFACT_VERSION
      && tombstone.batchId === batchId
      && tombstone.leaseId === leaseId
      && tombstone.dataUnlinkVerified === true
      && exactCanonicalTimestamp(tombstone.dataUnlinkVerifiedAt)
      && exactCanonicalTimestamp(tombstone.retentionQuiescedAt)
    );
  }

  async #rawGenerationExists({ root, batchId, leaseId }) {
    const targets = [
      join(root, stagingFileName(batchId, leaseId)),
      join(root, stagingLeaseFileName(batchId, leaseId))
    ];
    for (const target of targets) {
      if (!await pathIsAbsent(DEFAULT_STAGING_FILE_SYSTEM, target)) return true;
    }
    return false;
  }

  async #finishQuiescedWorker({ root, batchId, leaseId, owner, descriptor, receiptAvailable }) {
    if (descriptor?.child && !await this.#waitForChildExit(descriptor, RETENTION_SIGNAL_TIMEOUT_MS)) {
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "The private cleanup worker finished its durable receipt but did not exit cleanly, so deletion remains pending."
      );
    }
    if (!descriptor?.child && !await this.#waitForPidExit(owner.pid, RETENTION_SIGNAL_TIMEOUT_MS)) {
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "The adopted private cleanup worker finished its durable receipt but did not exit cleanly, so deletion remains pending."
      );
    }
    await this.#cleanupExactWorkerTemps({ root, batchId, leaseId, pid: owner.pid });
    return { completionReceiptAvailable: receiptAvailable };
  }

  async #confirmWorkerProtocol({ root, batchId, leaseId, expiresAt, workerId, claimNonce, message }) {
    const ownerPath = join(root, stagingOwnerFileName(batchId, leaseId));
    const owner = validatedRetentionOwner(
      await readSmallJson(this.#fileSystem, ownerPath),
      { batchId, leaseId, expiresAt }
    );
    if (
      owner?.phase !== "running"
      || owner.workerId !== workerId
      || owner.claimNonce !== claimNonce
      || message?.claimNonce !== claimNonce
      || owner.pid !== message?.pid
      || owner.processNonce !== message?.processNonce
      || owner.processStartedAt !== message?.processStartedAt
    ) throw new Error("retention worker protocol confirmation did not match durable ownership");
    return owner;
  }

  async #ownerShowsLiveProtocol({ ownerPath, owner, batchId, leaseId, expiresAt }) {
    if (!owner) return false;
    let before;
    try { before = await this.#fileSystem.lstat(ownerPath); } catch { return false; }
    await new Promise((resolveProbe) => setTimeout(resolveProbe, RETENTION_OWNER_PROBE_MS));
    let current;
    let after;
    try {
      current = validatedRetentionOwner(
        await readSmallJson(this.#fileSystem, ownerPath),
        { batchId, leaseId, expiresAt }
      );
      after = await this.#fileSystem.lstat(ownerPath);
    } catch {
      return false;
    }
    if (
      current?.phase !== "running"
      || current.workerId !== owner.workerId
      || current.claimNonce !== owner.claimNonce
      || !current.processNonce
      || (owner.phase === "running" && (
        current.pid !== owner.pid
        || current.processNonce !== owner.processNonce
        || current.processStartedAt !== owner.processStartedAt
      ))
      || after.mtimeMs <= before.mtimeMs
    ) return false;
    const heartbeatAge = Date.now() - after.mtimeMs;
    return heartbeatAge >= -RETENTION_OWNER_FRESH_MS && heartbeatAge <= RETENTION_OWNER_FRESH_MS;
  }

  async #claimOrAdoptOwner({ root, batchId, leaseId, expiresAt }) {
    const ownerPath = join(root, stagingOwnerFileName(batchId, leaseId));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const now = new Date().toISOString();
      const workerId = `worker-${randomUUID()}`;
      const claimNonce = `claim-${randomUUID()}`;
      const owner = {
        version: RETENTION_ARTIFACT_VERSION,
        batchId,
        leaseId,
        expiresAt,
        workerId,
        claimNonce,
        phase: "claimed",
        startedAt: now,
        heartbeatAt: now
      };
      try {
        await durableJsonWrite(this.#fileSystem, ownerPath, owner, { exclusive: true });
        return { adopted: false, owner };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      let existing = null;
      try {
        existing = validatedRetentionOwner(await readSmallJson(this.#fileSystem, ownerPath), { batchId, leaseId, expiresAt });
      } catch {}
      if (await this.#ownerShowsLiveProtocol({ ownerPath, owner: existing, batchId, leaseId, expiresAt })) {
        return { adopted: true, owner: existing };
      }

      const stalePath = `${ownerPath}.${randomUUID()}.stale`;
      try {
        await this.#fileSystem.rename(ownerPath, stalePath);
        await syncDirectoryEntry(this.#fileSystem, root);
        try { await unlinkAndSync(this.#fileSystem, stalePath); } catch {}
      } catch (error) {
        if (error?.code !== "ENOENT") continue;
      }
    }
    throw new KnowledgeCompilationError(
      "RETENTION_SERVICE_UNAVAILABLE",
      "I could not claim private cleanup ownership, so no temporary batch was staged."
    );
  }

  async arm(input) {
    return this.#arm(input);
  }

  async #arm({ root, batchId, expiresAt, leaseId = batchId }) {
    const safeRoot = assertDedicatedStagingRoot(root);
    const safeBatchId = assertBatchId(batchId);
    const safeExpiresAt = canonicalTimestamp(expiresAt, "STAGING_TIMESTAMP_INVALID");
    const safeLeaseId = assertOpaqueId(leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
    const key = retentionWorkerKey(safeRoot, safeBatchId, safeLeaseId);
    const local = this.#workers.get(key);
    if (local?.child && !this.#childExited(local)) return { armed: true, adopted: true };
    if (
      local
      && !local.child
      && await this.#ownerShowsLiveProtocol({
        ownerPath: join(safeRoot, stagingOwnerFileName(safeBatchId, safeLeaseId)),
        owner: local.owner,
        batchId: safeBatchId,
        leaseId: safeLeaseId,
        expiresAt: safeExpiresAt
      })
    ) return { armed: true, adopted: true };
    if (local) this.#workers.delete(key);

    const ownership = await this.#claimOrAdoptOwner({
      root: safeRoot,
      batchId: safeBatchId,
      leaseId: safeLeaseId,
      expiresAt: safeExpiresAt
    });
    if (ownership.adopted) {
      this.#workers.set(key, {
        child: null,
        owner: ownership.owner,
        adopted: true,
        exited: false
      });
      return { armed: true, adopted: true };
    }
    const workerId = ownership.owner.workerId;
    const claimNonce = ownership.owner.claimNonce;

    return new Promise((resolveArm, rejectArm) => {
      let settled = false;
      let child;
      const cleanupPreArmListeners = () => {
        child?.removeListener("error", failBeforeArm);
        child?.removeListener("exit", exitBeforeArm);
        child?.removeListener("message", confirmArm);
      };
      const failBeforeArm = async () => {
        if (settled) return;
        settled = true;
        cleanupPreArmListeners();
        try {
          child?.kill("SIGTERM");
        } catch {
          // The child already exited before confirming its schedule.
        }
        await this.#removeOwnerIfMatches({ root: safeRoot, batchId: safeBatchId, leaseId: safeLeaseId, workerId });
        rejectArm(new KnowledgeCompilationError(
          "RETENTION_SERVICE_UNAVAILABLE",
          "I could not arm the private 24-hour cleanup service, so no temporary batch was staged."
        ));
      };
      const exitBeforeArm = () => { void failBeforeArm(); };
      const confirmArm = (message) => {
        if (
          message?.type !== "qwave-retention-armed"
          || message?.batchId !== safeBatchId
          || message?.leaseId !== safeLeaseId
          || message?.workerId !== workerId
          || settled
        ) return;
        void this.#confirmWorkerProtocol({
          root: safeRoot,
          batchId: safeBatchId,
          leaseId: safeLeaseId,
          expiresAt: safeExpiresAt,
          workerId,
          claimNonce,
          message
        }).then((confirmedOwner) => {
          if (settled) return;
          settled = true;
          cleanupPreArmListeners();
          const descriptor = {
            child,
            owner: confirmedOwner,
            adopted: false,
            exited: false
          };
          child.once("exit", () => { descriptor.exited = true; });
          child.unref();
          this.#workers.set(key, descriptor);
          resolveArm({ armed: true, adopted: false });
        }, () => { void failBeforeArm(); });
      };
      try {
        child = spawn(process.execPath, [this.#workerPath, safeRoot, safeBatchId, safeExpiresAt, safeLeaseId, workerId, claimNonce], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
          // Do not carry caller secrets or ambient process configuration into
          // a detached deletion worker.
          env: {}
        });
      } catch {
        void failBeforeArm();
        return;
      }
      child.once("error", failBeforeArm);
      child.once("exit", exitBeforeArm);
      child.on("message", confirmArm);
    });
  }

  async disarm(input) {
    return this.#disarm(input);
  }

  async #disarm({ root, batchId, leaseId }, deletionFinalization = false) {
    const safeRoot = assertDedicatedStagingRoot(root);
    const safeBatchId = assertBatchId(batchId);
    const safeLeaseId = assertOpaqueId(leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
    const key = retentionWorkerKey(safeRoot, safeBatchId, safeLeaseId);
    let descriptor = this.#workers.get(key) ?? null;
    const ownerOnDisk = await this.#runningOwnerForGeneration({
      root: safeRoot,
      batchId: safeBatchId,
      leaseId: safeLeaseId
    });
    if (descriptor?.owner && ownerOnDisk && !this.#sameRunningOwner(descriptor.owner, ownerOnDisk)) {
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "Private cleanup ownership changed unexpectedly, so deletion remains pending."
      );
    }
    const expectedOwner = descriptor?.owner ?? ownerOnDisk;
    if (!descriptor && expectedOwner) {
      descriptor = {
        child: null,
        owner: expectedOwner,
        adopted: true,
        exited: false
      };
      this.#workers.set(key, descriptor);
    }

    const rawGenerationExists = await this.#rawGenerationExists({
      root: safeRoot,
      batchId: safeBatchId,
      leaseId: safeLeaseId
    });

    if (rawGenerationExists) {
      if (deletionFinalization) {
        throw new KnowledgeCompilationError(
          "RETENTION_SERVICE_UNAVAILABLE",
          "The exact protected generation reappeared before its retention worker was quiescent, so deletion remains pending."
        );
      }
      if (!expectedOwner) {
        if (
          await this.#quiescedTombstoneExists({ root: safeRoot, batchId: safeBatchId, leaseId: safeLeaseId })
          && (await nativeGenerationWorkerTempNames(safeRoot, safeBatchId, safeLeaseId)).length === 0
        ) {
          this.#workers.delete(key);
          return { completionReceiptAvailable: false };
        }
        throw new KnowledgeCompilationError(
          "RETENTION_SERVICE_UNAVAILABLE",
          "Private cleanup could not prove that its retention worker stopped, so deletion remains pending."
        );
      }
      await this.#removeExpectedOwner({
        root: safeRoot,
        batchId: safeBatchId,
        leaseId: safeLeaseId,
        owner: expectedOwner
      });
      if (descriptor?.child) {
        await this.#stopKnownWorker(descriptor, {
          root: safeRoot,
          batchId: safeBatchId,
          leaseId: safeLeaseId
        });
      } else if (!await this.#waitForPidExit(expectedOwner.pid, RETENTION_QUIESCENCE_TIMEOUT_MS)) {
        throw new KnowledgeCompilationError(
          "RETENTION_SERVICE_UNAVAILABLE",
          "The adopted private cleanup worker did not stop after its exact ownership was removed, so deletion remains pending."
        );
      }
      await this.#cleanupExactWorkerTemps({
        root: safeRoot,
        batchId: safeBatchId,
        leaseId: safeLeaseId,
        pid: expectedOwner.pid
      });
      this.#workers.delete(key);
      return { completionReceiptAvailable: false };
    }

    const deadline = Date.now() + RETENTION_QUIESCENCE_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const currentOwner = expectedOwner
        ? await this.#currentMatchingOwner({
            root: safeRoot,
            batchId: safeBatchId,
            leaseId: safeLeaseId,
            expectedOwner
          })
        : await this.#runningOwnerForGeneration({
            root: safeRoot,
            batchId: safeBatchId,
            leaseId: safeLeaseId
          });
      if (currentOwner === false) {
        throw new KnowledgeCompilationError(
          "RETENTION_SERVICE_UNAVAILABLE",
          "Private cleanup ownership changed unexpectedly, so deletion remains pending."
        );
      }
      const receipt = await this.#matchingWorkerReceipt({
        root: safeRoot,
        batchId: safeBatchId,
        leaseId: safeLeaseId,
        owner: expectedOwner
      });
      if (receipt && !currentOwner) {
        const owner = expectedOwner ?? receipt;
        const result = await this.#finishQuiescedWorker({
          root: safeRoot,
          batchId: safeBatchId,
          leaseId: safeLeaseId,
          owner,
          descriptor,
          receiptAvailable: true
        });
        this.#workers.delete(key);
        return result;
      }

      if (descriptor?.child && this.#childExited(descriptor)) {
        if (currentOwner && expectedOwner) {
          await this.#removeExpectedOwner({
            root: safeRoot,
            batchId: safeBatchId,
            leaseId: safeLeaseId,
            owner: expectedOwner
          });
        }
        await this.#cleanupExactWorkerTemps({
          root: safeRoot,
          batchId: safeBatchId,
          leaseId: safeLeaseId,
          pid: expectedOwner.pid
        });
        this.#workers.delete(key);
        return { completionReceiptAvailable: false };
      }

      if (!descriptor?.child && expectedOwner && this.#pidIsGone(expectedOwner.pid)) {
        if (currentOwner) {
          await this.#removeExpectedOwner({
            root: safeRoot,
            batchId: safeBatchId,
            leaseId: safeLeaseId,
            owner: expectedOwner
          });
        }
        await this.#cleanupExactWorkerTemps({
          root: safeRoot,
          batchId: safeBatchId,
          leaseId: safeLeaseId,
          pid: expectedOwner.pid
        });
        this.#workers.delete(key);
        return { completionReceiptAvailable: false };
      }

      if (!expectedOwner && !currentOwner) {
        if (
          await this.#quiescedTombstoneExists({ root: safeRoot, batchId: safeBatchId, leaseId: safeLeaseId })
          && (await nativeGenerationWorkerTempNames(safeRoot, safeBatchId, safeLeaseId)).length === 0
        ) {
          this.#workers.delete(key);
          return { completionReceiptAvailable: false };
        }
        throw new KnowledgeCompilationError(
          "RETENTION_SERVICE_UNAVAILABLE",
          "Private cleanup could not bind a worker identity to this exact generation, so deletion remains pending."
        );
      }
      await new Promise((resolvePoll) => setTimeout(resolvePoll, RETENTION_QUIESCENCE_POLL_MS));
    }
    throw new KnowledgeCompilationError(
      "RETENTION_SERVICE_UNAVAILABLE",
      "The private cleanup worker did not finish its exact durable cleanup before the bounded deadline, so deletion remains pending."
    );
  }
}

/**
 * A concrete private local staging adapter. It is intentionally narrow:
 * files are limited to a dedicated root, never follow a staging symlink, and
 * use opaque batch IDs so callers cannot select arbitrary paths.
 */
export class LocalTemporaryStaging {
  #root;
  #maxRecords;
  #maxBytes;
  #fileSystem;
  #clock;
  #retentionService;
  #realRoot = null;
  #initialization = null;
  #expiryTimers = new Map();
  #startupRemovedBatches = [];
  #startupCleanupNeedsAttentionBatches = [];
  #retentionCoverageUnavailableBatches = [];

  constructor({
    root,
    maxRecords = MAX_BATCH_RECORDS,
    maxBytes = MAX_STAGING_BYTES,
    retentionService = new DetachedLocalRetentionService(),
    fileSystem = {},
    clock = null
  } = {}) {
    const fileSystemOverrides = Object.freeze({ ...fileSystem });
    this.#root = assertDedicatedStagingRoot(root);
    this.#maxRecords = assertPositiveSafeInteger(maxRecords, "maxRecords");
    this.#maxBytes = assertPositiveSafeInteger(maxBytes, "maxBytes");
    this.#fileSystem = Object.freeze({ ...DEFAULT_STAGING_FILE_SYSTEM, ...fileSystemOverrides });
    // A caller-provided clock is a deterministic timestamp seam, not a
    // retained callback. Snapshot it once before authority is assigned so no
    // caller code is reachable from later staging or cleanup operations.
    const capturedClock = clock && typeof clock.now === "function"
      ? isoNow({ now: clock.now.bind(clock) })
      : null;
    this.#clock = capturedClock
      ? Object.freeze({ now: () => capturedClock })
      : null;
    const trustedRetentionFacade = retentionService && typeof retentionService === "object"
      ? TRUSTED_DETACHED_RETENTION_FACADES.get(retentionService) ?? null
      : null;
    if (trustedRetentionFacade) {
      this.#retentionService = trustedRetentionFacade;
    } else {
      if (!retentionService || typeof retentionService.arm !== "function" || typeof retentionService.disarm !== "function") {
        throw new TypeError("A private retentionService with arm() and disarm() is required for temporary staging.");
      }
      this.#retentionService = Object.freeze({
        arm: retentionService.arm.bind(retentionService),
        disarm: retentionService.disarm.bind(retentionService),
        finalizeDeletion: retentionService.disarm.bind(retentionService)
      });
    }
    const hasCallerFileSystemMethods = Object.keys(fileSystemOverrides).length > 0;
    if (
      new.target === LocalTemporaryStaging
      && !hasCallerFileSystemMethods
      && trustedRetentionFacade
    ) {
      const instance = this;
      const trusted = Object.freeze({
        stage(input) {
          return LOCAL_TEMPORARY_STAGING_METHODS.stage.call(instance, input, INTERNAL_LOCAL_STAGING_OPERATION);
        },
        read(input) {
          return LOCAL_TEMPORARY_STAGING_METHODS.read.call(instance, input, INTERNAL_LOCAL_STAGING_OPERATION);
        },
        delete(input) {
          return LOCAL_TEMPORARY_STAGING_METHODS.delete.call(instance, input, INTERNAL_LOCAL_STAGING_OPERATION);
        },
        cleanupExpired(input) {
          return LOCAL_TEMPORARY_STAGING_METHODS.cleanupExpired.call(instance, input, INTERNAL_LOCAL_STAGING_OPERATION);
        },
        rawDeletionEvidence(input) {
          return LOCAL_TEMPORARY_STAGING_METHODS.rawDeletionEvidence.call(
            instance,
            input,
            INTERNAL_LOCAL_STAGING_OPERATION
          );
        },
        acknowledgeCleanupReceipt(input, internalToken) {
          return LOCAL_TEMPORARY_STAGING_METHODS.acknowledgeCleanupReceipt.call(
            instance,
            input,
            internalToken,
            INTERNAL_LOCAL_STAGING_OPERATION
          );
        }
      });
      TRUSTED_LOCAL_STAGING_FACADES.add(trusted);
      LOCAL_STAGING_AUTHORITIES.set(this, Object.freeze({
        run(operation) {
          return runLocalStagingOperation(instance.#root, () => operation(trusted));
        }
      }));
    }
  }

  async initialize(operationToken = null) {
    if (operationToken !== INTERNAL_LOCAL_STAGING_OPERATION) {
      return runLocalStagingOperation(this.#root, () => (
        LOCAL_TEMPORARY_STAGING_METHODS.initialize.call(this, INTERNAL_LOCAL_STAGING_OPERATION)
      ));
    }
    if (!this.#initialization) this.#initialization = this.#initialize();
    return this.#initialization;
  }

  async #initialize() {
    const parent = dirname(this.#root);
    let parentStats;
    try {
      parentStats = await this.#fileSystem.lstat(parent);
    } catch {
      throw new KnowledgeCompilationError(
        "STAGING_PARENT_INVALID",
        "The private temporary staging parent is unavailable, so no source batch was staged."
      );
    }
    if (!parentStats.isDirectory()) {
      throw new KnowledgeCompilationError(
        "STAGING_PARENT_INVALID",
        "The private temporary staging parent is not a directory, so no source batch was staged."
      );
    }
    const parentReal = await this.#fileSystem.realpath(parent);
    if (await hasGitRepositoryAncestor(parentReal)) {
      throw new KnowledgeCompilationError(
        "STAGING_PUBLIC_REPOSITORY_BLOCKED",
        "Temporary source staging cannot be created inside a repository. Choose a private local temporary directory."
      );
    }

    try {
      await this.#fileSystem.mkdir(this.#root, { mode: 0o700 });
      await syncDirectoryEntry(this.#fileSystem, parent);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new KnowledgeCompilationError(
          "STAGING_ROOT_UNAVAILABLE",
          "I could not create the protected temporary staging directory, so no source batch was staged."
        );
      }
    }

    const rootStats = await this.#fileSystem.lstat(this.#root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new KnowledgeCompilationError(
        "STAGING_SYMLINK_BLOCKED",
        "Temporary staging cannot use a symbolic link or non-directory path."
      );
    }
    try {
      await this.#fileSystem.chmod(this.#root, 0o700);
    } catch {
      throw new KnowledgeCompilationError(
        "STAGING_PERMISSIONS_UNSAFE",
        "I could not protect the temporary staging directory, so no source batch was staged."
      );
    }

    const [rootReal, repositoryReal] = await Promise.all([this.#fileSystem.realpath(this.#root), repositoryRealRoot()]);
    if (!isWithin(rootReal, parentReal) || isWithin(rootReal, repositoryReal)) {
      throw new KnowledgeCompilationError(
        "STAGING_PUBLIC_REPOSITORY_BLOCKED",
        "Temporary source staging cannot resolve inside this repository."
      );
    }
    this.#realRoot = rootReal;
    // The expiry is durable in each staged file. Re-check it whenever this
    // adapter starts so a restart does not depend on an old in-memory timer.
    const startupCleanup = await this.#cleanupExpiredInRoot(rootReal, isoNow(this.#clock));
    this.#startupRemovedBatches.push(...startupCleanup.removedBatches);
    this.#startupCleanupNeedsAttentionBatches.push(...startupCleanup.cleanupNeedsAttentionBatches);
    return rootReal;
  }

  #pathsForGenerationTag(root, batchId, generationTag) {
    const base = generationArtifactBaseForTag(batchId, generationTag);
    const paths = {
      data: resolve(root, `${base}${STAGING_FILE_SUFFIX}`),
      lease: resolve(root, `${base}${STAGING_LEASE_SUFFIX}`),
      receipt: resolve(root, `${base}${STAGING_RECEIPT_SUFFIX}`),
      tombstone: resolve(root, `${base}${STAGING_TOMBSTONE_SUFFIX}`),
      owner: resolve(root, `${base}${STAGING_OWNER_SUFFIX}`)
    };
    if (Object.values(paths).some((candidate) => dirname(candidate) !== root || !isWithin(candidate, root))) {
      throw new KnowledgeCompilationError("STAGING_PATH_ESCAPE_BLOCKED", "Temporary staging refused a path outside its dedicated directory.");
    }
    return paths;
  }

  #paths(root, batchId, leaseId) {
    return this.#pathsForGenerationTag(root, batchId, generationTagForLease(leaseId));
  }

  async #retentionLeaseForGeneration(root, batchId, generationTag) {
    const paths = this.#pathsForGenerationTag(root, batchId, generationTag);
    let owner;
    try {
      owner = await readSmallJson(this.#fileSystem, paths.owner);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "The generation-bound cleanup owner could not be read safely, so cleanup remains pending."
      );
    }
    const leaseId = typeof owner?.leaseId === "string" && OPAQUE_ID.test(owner.leaseId)
      ? owner.leaseId
      : null;
    const expiresAt = exactCanonicalTimestamp(owner?.expiresAt);
    if (
      !leaseId
      || !expiresAt
      || generationTagForLease(leaseId) !== generationTag
      || !validatedRetentionOwner(owner, { batchId, leaseId, expiresAt })
      || owner.phase !== "running"
    ) {
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "The generation-bound cleanup owner could not prove one exact running worker, so cleanup remains pending."
      );
    }
    return leaseId;
  }

  async #assertUntrackedGenerationArtifactsAbsent(root, batchId, generationTag, message) {
    const paths = this.#pathsForGenerationTag(root, batchId, generationTag);
    await assertNativePathsAbsent(Object.values(paths), message);
    await assertNativeGenerationWorkerTempsAbsentForTag(root, batchId, generationTag);
  }

  async #trustedRoot() {
    const root = await this.initialize(INTERNAL_LOCAL_STAGING_OPERATION);
    let stats;
    try {
      stats = await this.#fileSystem.lstat(root);
    } catch {
      throw new KnowledgeCompilationError("STAGING_ROOT_UNAVAILABLE", "The protected temporary staging directory is unavailable.");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new KnowledgeCompilationError("STAGING_SYMLINK_BLOCKED", "Temporary staging cannot use a symbolic link or non-directory path.");
    }
    const [resolved, repositoryReal] = await Promise.all([this.#fileSystem.realpath(root), repositoryRealRoot()]);
    if (resolved !== root || isWithin(resolved, repositoryReal) || await hasGitRepositoryAncestor(resolved)) {
      throw new KnowledgeCompilationError("STAGING_PUBLIC_REPOSITORY_BLOCKED", "Temporary staging no longer resolves to its dedicated private directory.");
    }
    return root;
  }

  #timerKey(batchId, leaseId) { return `${batchId}\u0000${leaseId}`; }

  #nowMs() { return Date.parse(isoNow(this.#clock)); }

  #scheduleExpiry(batchId, leaseId, expiresAt) {
    const timerKey = this.#timerKey(batchId, leaseId);
    const existing = this.#expiryTimers.get(timerKey);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, Date.parse(expiresAt) - this.#nowMs());
    const timer = setTimeout(async () => {
      this.#expiryTimers.delete(timerKey);
      try {
        const staged = await this.read({ batchId, leaseId });
        if (Date.parse(staged.expiresAt) <= this.#nowMs() && await this.delete({ batchId, leaseId, reason: "expired" })) {
          this.#startupRemovedBatches.push({
            batchId,
            generationTag: generationTagForLease(leaseId),
            leaseId,
            reason: "expired"
          });
        }
      } catch (error) {
        if (error instanceof KnowledgeCompilationError && error.code === "STAGING_BATCH_MISSING") return;
        // Keep retrying on a running host. A refusal to unlink must never
        // silently disarm the only local cleanup coverage.
        this.#scheduleExpiry(batchId, leaseId, new Date(this.#nowMs() + 250).toISOString());
      }
    }, delay);
    timer.unref?.();
    this.#expiryTimers.set(timerKey, timer);
  }

  async #armRetention(batchId, expiresAt, leaseId, knownTrustedRoot = null) {
    const root = knownTrustedRoot ?? await this.#trustedRoot();
    try {
      await this.#retentionService.arm({ root, batchId, expiresAt, leaseId });
    } catch (error) {
      if (error instanceof KnowledgeCompilationError) throw error;
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "I could not arm the private 24-hour cleanup service, so no temporary batch was staged."
      );
    }
  }

  async #disarmGenerationRetention(batchId, leaseId, knownTrustedRoot = null) {
    try {
      const root = knownTrustedRoot ?? await this.#trustedRoot();
      return await this.#retentionService.finalizeDeletion({ root, batchId, leaseId });
    } catch (error) {
      if (error instanceof KnowledgeCompilationError) throw error;
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "The private cleanup worker could not be proven stopped, so deletion remains pending."
      );
    }
  }

  #validatedManifest(value, batchId, leaseId) {
    const createdAt = exactCanonicalTimestamp(value?.createdAt);
    const expiresAt = exactCanonicalTimestamp(value?.expiresAt);
    if (
      value?.version !== RETENTION_ARTIFACT_VERSION
      || value.batchId !== batchId
      || value.leaseId !== leaseId
      || !["prepared", "ready"].includes(value.phase)
      || !createdAt
      || !expiresAt
      || expiresAt !== addHours(createdAt, 24)
    ) {
      throw new KnowledgeCompilationError("STAGING_LEASE_INVALID", "The protected temporary batch generation marker was not valid, so it was not compiled.");
    }
    return { ...value, createdAt, expiresAt };
  }

  async #readManifest(root, batchId, leaseId) {
    const paths = this.#paths(root, batchId, leaseId);
    const value = await readSmallJson(this.#fileSystem, paths.lease);
    return this.#validatedManifest(value, batchId, leaseId);
  }

  async #activeGeneration(root, batchId, expectedLeaseId = null) {
    if (expectedLeaseId) {
      const leaseId = assertOpaqueId(expectedLeaseId, "STAGING_LEASE_INVALID", "staging lease identity");
      return { batchId, leaseId, paths: this.#paths(root, batchId, leaseId) };
    }
    const entries = await this.#fileSystem.readdir(root, { withFileTypes: true });
    const generationTags = new Set();
    for (const entry of entries) {
      const leaseArtifact = parseGenerationArtifact(entry.name, STAGING_LEASE_SUFFIX);
      const isSpecial = [STAGING_LEASE_SUFFIX, STAGING_RECEIPT_SUFFIX, STAGING_TOMBSTONE_SUFFIX, STAGING_OWNER_SUFFIX]
        .some((suffix) => entry.name.endsWith(suffix));
      const dataArtifact = isSpecial ? null : parseGenerationArtifact(entry.name, STAGING_FILE_SUFFIX);
      const artifact = leaseArtifact ?? dataArtifact;
      if (artifact?.batchId === batchId) generationTags.add(artifact.generationTag);
    }
    if (generationTags.size === 0) return null;
    if (generationTags.size > 1) {
      throw new KnowledgeCompilationError("STAGING_BATCH_INVALID", "More than one protected generation exists for this batch, so none was compiled.");
    }
    const [generationTag] = generationTags;
    const leaseEntry = entries.find((entry) => {
      const parsed = parseGenerationArtifact(entry.name, STAGING_LEASE_SUFFIX);
      return parsed?.batchId === batchId && parsed.generationTag === generationTag;
    });
    if (!leaseEntry) {
      throw new KnowledgeCompilationError("STAGING_LEASE_INVALID", "The protected temporary batch has no durable generation marker, so it was not compiled.");
    }
    let raw;
    try {
      raw = await readSmallJson(this.#fileSystem, join(root, leaseEntry.name));
    } catch (error) {
      if (isIntrinsicRetentionArtifactError(error)) {
        throw new KnowledgeCompilationError("STAGING_LEASE_INVALID", "The protected temporary batch generation marker was not readable, so it was not compiled.");
      }
      throw error;
    }
    const leaseId = assertOpaqueId(raw?.leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
    if (generationTagForLease(leaseId) !== generationTag) {
      throw new KnowledgeCompilationError("STAGING_LEASE_INVALID", "The protected temporary batch generation marker did not match its immutable filename.");
    }
    this.#validatedManifest(raw, batchId, leaseId);
    return { batchId, leaseId, paths: this.#paths(root, batchId, leaseId) };
  }

  async #readPayloadAt(root, batchId, leaseId) {
    const paths = this.#paths(root, batchId, leaseId);
    const stats = await this.#fileSystem.lstat(paths.data);
    assertSingleLinkRegularFile(stats);
    if (stats.size > this.#maxBytes) {
      throw new KnowledgeCompilationError("STAGING_SIZE_LIMIT", "The protected temporary batch exceeded its safe size limit and was not compiled.");
    }
    let handle;
    try {
      handle = await this.#fileSystem.open(paths.data, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const openStats = await handle.stat();
      assertSingleLinkRegularFile(openStats);
      if (!sameFileIdentity(stats, openStats)) {
        throw new KnowledgeCompilationError(
          "STAGING_FILE_IDENTITY_CHANGED",
          "The protected generation changed while it was being opened, so processing stopped and retention remains armed."
        );
      }
      if (openStats.size > this.#maxBytes) {
        throw new KnowledgeCompilationError("STAGING_SIZE_LIMIT", "The protected temporary batch exceeded its safe size limit and was not compiled.");
      }
      const serialized = await handle.readFile({ encoding: "utf8" });
      const afterRead = await handle.stat();
      assertSingleLinkRegularFile(afterRead);
      if (!sameFileIdentity(openStats, afterRead)) {
        throw new KnowledgeCompilationError(
          "STAGING_FILE_IDENTITY_CHANGED",
          "The protected generation changed while it was being read, so processing stopped and retention remains armed."
        );
      }
      if (afterRead.size > this.#maxBytes) {
        throw new KnowledgeCompilationError("STAGING_SIZE_LIMIT", "The protected temporary batch exceeded its safe size limit and was not compiled.");
      }
      let payload;
      try {
        payload = JSON.parse(serialized);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new KnowledgeCompilationError(
            "STAGING_PAYLOAD_INVALID",
            "The protected temporary batch was not valid JSON, so it was not compiled."
          );
        }
        throw error;
      }
      const validated = validatedStagingPayload(payload, batchId, this.#maxRecords);
      if (validated.leaseId !== leaseId) {
        throw new KnowledgeCompilationError("STAGING_LEASE_INVALID", "The protected batch did not match its immutable generation marker.");
      }
      return validated;
    } catch (error) {
      if (error instanceof KnowledgeCompilationError) throw error;
      throw new KnowledgeCompilationError("STAGING_READ_FAILED", "I could not safely read the protected temporary batch.");
    } finally {
      await handle?.close();
    }
  }

  async stage(input, operationToken = null) {
    if (operationToken !== INTERNAL_LOCAL_STAGING_OPERATION) {
      return runLocalStagingOperation(this.#root, () => (
        LOCAL_TEMPORARY_STAGING_METHODS.stage.call(this, input, INTERNAL_LOCAL_STAGING_OPERATION)
      ));
    }
    const { batchId, records, createdAt } = input;
    const safeBatchId = assertBatchId(batchId);
    if (!Array.isArray(records) || records.length === 0 || records.length > this.#maxRecords) {
      throw new KnowledgeCompilationError(
        "STAGING_RECORD_LIMIT",
        `A temporary batch must contain between 1 and ${this.#maxRecords} approved records.`
      );
    }
    assertNoRawStagingMaterial(records);
    const normalizedRecords = normalizeInertStagingRecords(records, { maxRecords: this.#maxRecords });
    const normalizedCreatedAt = canonicalTimestamp(createdAt, "STAGING_TIMESTAMP_INVALID");
    const leaseId = `lease-${randomUUID()}`;
    const payload = {
      version: STAGING_VERSION,
      batchId: safeBatchId,
      leaseId,
      createdAt: normalizedCreatedAt,
      expiresAt: addHours(normalizedCreatedAt, 24),
      records: normalizedRecords
    };
    const serialized = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.#maxBytes) {
      throw new KnowledgeCompilationError(
        "STAGING_SIZE_LIMIT",
        "The approved batch is too large for protected temporary staging. Split it into a smaller approved batch."
      );
    }

    const root = await this.#trustedRoot();
    try {
      const active = await this.#activeGeneration(root, safeBatchId);
      if (active) {
        throw new KnowledgeCompilationError(
          "STAGING_BATCH_EXISTS",
          "A protected temporary batch with that ID already exists. Resume it instead of replacing it."
        );
      }
    } catch (error) {
      if (error instanceof KnowledgeCompilationError && error.code !== "STAGING_BATCH_MISSING") throw error;
    }
    const paths = this.#paths(root, safeBatchId, leaseId);
    const manifest = {
      version: RETENTION_ARTIFACT_VERSION,
      batchId: safeBatchId,
      leaseId,
      phase: "prepared",
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt
    };
    try {
      await durableJsonWrite(this.#fileSystem, paths.lease, manifest, { exclusive: true });
    } catch (error) {
      if (error?.code === "EEXIST") {
      throw new KnowledgeCompilationError(
        "STAGING_BATCH_EXISTS",
        "A protected temporary batch with that ID already exists. Resume it instead of replacing it."
      );
      }
      throw new KnowledgeCompilationError("STAGING_WRITE_FAILED", "I could not durably create the protected staging generation marker.");
    }

    // The content-free generation marker is durable before retention is armed,
    // and the worker is armed before any data path can exist. A crash in either
    // gap therefore leaves no untracked source references.
    try {
      await this.#armRetention(safeBatchId, payload.expiresAt, leaseId, root);
    } catch (error) {
      try { await unlinkAndSync(this.#fileSystem, paths.lease); } catch {}
      throw error;
    }
    let handle;
    let failure = null;
    try {
      handle = await this.#fileSystem.open(
        paths.data,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectoryEntry(this.#fileSystem, root);
      await durableJsonWrite(this.#fileSystem, paths.lease, { ...manifest, phase: "ready" });
    } catch (error) {
      failure = error;
    }
    if (handle) {
      try { await handle.close(); } catch (error) { failure ??= error; }
    }
    if (failure) {
      try {
        await this.#deleteGenerationWithVerification(safeBatchId, leaseId, root, {
          allowNewlyAbsentData: true,
          reason: "stage-write-failed"
        });
        await this.acknowledgeCleanupReceipt(
          { batchId: safeBatchId, leaseId },
          INTERNAL_CLEANUP_ACKNOWLEDGEMENT,
          INTERNAL_LOCAL_STAGING_OPERATION
        );
      } catch {
        // The durable marker and independent worker remain responsible for a
        // partial file if immediate cleanup itself was interrupted.
      }
      throw failure instanceof KnowledgeCompilationError
        ? failure
        : new KnowledgeCompilationError("STAGING_WRITE_FAILED", "I could not save the protected temporary batch. Generation-bound cleanup remains armed and retryable.");
    }
    const receipt = {
      batchId: safeBatchId,
      leaseId,
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt,
      retention: "delete-after-compilation-or-within-24-hours"
    };
    this.#scheduleExpiry(safeBatchId, leaseId, payload.expiresAt);
    return receipt;
  }

  async read(input, operationToken = null) {
    if (operationToken !== INTERNAL_LOCAL_STAGING_OPERATION) {
      return runLocalStagingOperation(this.#root, () => (
        LOCAL_TEMPORARY_STAGING_METHODS.read.call(this, input, INTERNAL_LOCAL_STAGING_OPERATION)
      ));
    }
    const { batchId, leaseId = null } = input;
    const safeBatchId = assertBatchId(batchId);
    const root = await this.#trustedRoot();
    let generation;
    try {
      generation = await this.#activeGeneration(root, safeBatchId, leaseId);
    } catch (error) {
      if (error instanceof KnowledgeCompilationError) throw error;
      throw new KnowledgeCompilationError("STAGING_READ_FAILED", "I could not safely resolve the protected temporary batch generation.");
    }
    if (!generation || await pathIsAbsent(this.#fileSystem, generation.paths.data)) {
      throw new KnowledgeCompilationError("STAGING_BATCH_MISSING", "The protected temporary batch is no longer available. Approve a new batch before continuing.");
    }
    const manifest = await this.#readManifest(root, safeBatchId, generation.leaseId);
    const validated = await this.#readPayloadAt(root, safeBatchId, generation.leaseId);
    if (validated.createdAt !== manifest.createdAt || validated.expiresAt !== manifest.expiresAt) {
      throw new KnowledgeCompilationError("STAGING_LEASE_INVALID", "The protected batch timestamps did not match its durable generation marker.");
    }
    if (manifest.phase === "prepared") {
      await durableJsonWrite(this.#fileSystem, generation.paths.lease, { ...manifest, phase: "ready" });
    }
    return validated;
  }

  #validatedCompletionArtifact(value, { batchId, leaseId, kind }) {
    const timestampField = kind === "receipt" ? "deletedAt" : "deleteStartedAt";
    const timestamp = exactCanonicalTimestamp(value?.[timestampField]);
    const unlinkVerifiedAt = kind === "tombstone" ? exactCanonicalTimestamp(value?.dataUnlinkVerifiedAt) : null;
    const retentionQuiescedAt = kind === "tombstone" ? exactCanonicalTimestamp(value?.retentionQuiescedAt) : null;
    if (
      value?.version !== RETENTION_ARTIFACT_VERSION
      || value.batchId !== batchId
      || value.leaseId !== leaseId
      || !timestamp
      || Date.parse(timestamp) > Date.now() + COMPLETION_CLOCK_SKEW_MS
      || (kind === "tombstone" && (
        value.cleanupBlockedReason != null
        || value.dataUnlinkVerified !== true
        || !unlinkVerifiedAt
        || !retentionQuiescedAt
        || Date.parse(unlinkVerifiedAt) > Date.now() + COMPLETION_CLOCK_SKEW_MS
        || Date.parse(retentionQuiescedAt) > Date.now() + COMPLETION_CLOCK_SKEW_MS
      ))
    ) return null;
    const reason = boundedCleanupReason(value.reason);
    return kind === "receipt"
      ? { version: value.version, batchId, leaseId, deletedAt: timestamp, deleteStartedAt: null, reason, source: kind }
      : { version: value.version, batchId, leaseId, deletedAt: null, deleteStartedAt: timestamp, reason, source: kind };
  }

  async #completionArtifactAt(root, batchId, leaseId, kind) {
    const paths = this.#paths(root, batchId, leaseId);
    const target = kind === "receipt" ? paths.receipt : paths.tombstone;
    let value;
    try {
      value = await readSmallJson(this.#fileSystem, target);
    } catch (error) {
      if (error?.code === "ENOENT" || !error?.code) return null;
      throw error;
    }
    const validated = this.#validatedCompletionArtifact(value, { batchId, leaseId, kind });
    if (!validated) return null;
    await assertNativePathsAbsent(
      [paths.data, paths.lease, paths.owner],
      "The protected generation or its cleanup worker still exists, so its cleanup artifact cannot certify deletion."
    );
    await assertNativeGenerationWorkerTempsAbsent(root, batchId, leaseId);
    return validated;
  }

  async #writeCompletionReceipt(root, batchId, leaseId, deletedAt, reason) {
    const paths = this.#paths(root, batchId, leaseId);
    await durableJsonWrite(this.#fileSystem, paths.receipt, {
      version: RETENTION_ARTIFACT_VERSION,
      batchId,
      leaseId,
      deletedAt,
      reason: boundedCleanupReason(reason),
      writer: "compiler"
    });
  }

  async #markTombstoneRetentionQuiesced(root, batchId, leaseId) {
    const paths = this.#paths(root, batchId, leaseId);
    const existing = await readSmallJson(this.#fileSystem, paths.tombstone);
    const unlinkVerifiedAt = exactCanonicalTimestamp(existing?.dataUnlinkVerifiedAt);
    if (
      existing?.version !== RETENTION_ARTIFACT_VERSION
      || existing.batchId !== batchId
      || existing.leaseId !== leaseId
      || existing.cleanupBlockedReason != null
      || existing.dataUnlinkVerified !== true
      || !unlinkVerifiedAt
    ) {
      throw new KnowledgeCompilationError(
        "STAGING_DELETE_RECEIPT_PENDING",
        "The private batch is absent, but its exact cleanup marker could not be finalized safely."
      );
    }
    await durableJsonWrite(this.#fileSystem, paths.tombstone, {
      ...existing,
      retentionQuiescedAt: new Date().toISOString()
    });
  }

  async #ensureTombstone(root, batchId, leaseId, deleteStartedAt, reason) {
    const paths = this.#paths(root, batchId, leaseId);
    try {
      const existing = await readSmallJson(this.#fileSystem, paths.tombstone);
      if (existing?.cleanupBlockedReason === "multiple-links-after-unlink") {
        throw new KnowledgeCompilationError(
          "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION",
          "The original staging path is gone but another filesystem link still retains this generation. Cleanup needs local review and cannot be reported complete."
        );
      }
      const existingStartedAt = exactCanonicalTimestamp(existing?.deleteStartedAt);
      if (
        existing?.version === RETENTION_ARTIFACT_VERSION
        && existing.batchId === batchId
        && existing.leaseId === leaseId
        && existingStartedAt
        && Date.parse(existingStartedAt) <= Date.now() + COMPLETION_CLOCK_SKEW_MS
        && [true, false].includes(existing.dataUnlinkVerified)
        && (existing.dataUnlinkVerified === false || exactCanonicalTimestamp(existing.dataUnlinkVerifiedAt))
      ) return { created: false, value: existing };
      throw new Error("invalid tombstone");
    } catch (error) {
      if (error instanceof KnowledgeCompilationError) throw error;
      if (error?.code !== "ENOENT") {
        try {
          const stats = await this.#fileSystem.lstat(paths.tombstone);
          if (stats) throw new KnowledgeCompilationError("STAGING_DELETE_FAILED", "The durable cleanup tombstone was invalid; no generation was removed.");
        } catch (statsError) {
          if (statsError instanceof KnowledgeCompilationError) throw statsError;
          if (statsError?.code !== "ENOENT") throw statsError;
        }
      }
    }
    const tombstone = {
      version: RETENTION_ARTIFACT_VERSION,
      batchId,
      leaseId,
      deleteStartedAt,
      dataUnlinkVerified: false,
      reason: boundedCleanupReason(reason)
    };
    await durableJsonWrite(this.#fileSystem, paths.tombstone, tombstone, { exclusive: true });
    return { created: true, value: tombstone };
  }

  async #markTombstoneUnlinkVerified(root, batchId, leaseId) {
    const paths = this.#paths(root, batchId, leaseId);
    const existing = await readSmallJson(this.#fileSystem, paths.tombstone);
    const deleteStartedAt = exactCanonicalTimestamp(existing?.deleteStartedAt);
    if (
      existing?.version !== RETENTION_ARTIFACT_VERSION
      || existing.batchId !== batchId
      || existing.leaseId !== leaseId
      || !deleteStartedAt
      || existing.cleanupBlockedReason != null
    ) {
      throw new KnowledgeCompilationError(
        "STAGING_DELETE_FAILED",
        "The cleanup marker could not confirm this exact generation's unlink result."
      );
    }
    await durableJsonWrite(this.#fileSystem, paths.tombstone, {
      ...existing,
      dataUnlinkVerified: true,
      dataUnlinkVerifiedAt: new Date().toISOString()
    });
  }

  async #markTombstoneNeedsAttention(root, batchId, leaseId, deleteStartedAt, reason) {
    const paths = this.#paths(root, batchId, leaseId);
    await durableJsonWrite(this.#fileSystem, paths.tombstone, {
      version: RETENTION_ARTIFACT_VERSION,
      batchId,
      leaseId,
      deleteStartedAt,
      dataUnlinkVerified: false,
      reason: boundedCleanupReason(reason),
      cleanupBlockedReason: "multiple-links-after-unlink",
      detectedAt: new Date().toISOString()
    });
  }

  async #unlinkSingleLinkData(root, batchId, leaseId, deleteStartedAt, tombstone, { allowNewlyAbsentData = false } = {}) {
    const paths = this.#paths(root, batchId, leaseId);
    let before;
    try {
      before = await this.#fileSystem.lstat(paths.data);
    } catch (error) {
      if (error?.code === "ENOENT") {
        await assertNativePathsAbsent(
          [paths.data],
          "The protected generation still exists even though the configured staging adapter reported it absent. Cleanup remains armed and needs local review."
        );
        if (tombstone.value.dataUnlinkVerified === true) return false;
        if (tombstone.created && allowNewlyAbsentData) {
          await this.#markTombstoneUnlinkVerified(root, batchId, leaseId);
          return false;
        }
        throw new KnowledgeCompilationError(
          "STAGING_FILE_IDENTITY_CHANGED",
          "The private staging path disappeared before its unlink result was durably verified. Cleanup needs local review and was not reported complete."
        );
      }
      throw error;
    }
    if (!before.isSymbolicLink?.()) {
      assertSingleLinkRegularFile(before, "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION");
    }
    let nativeWitness = null;
    let operationFailure = null;
    try {
      nativeWitness = await nativeDeletionWitness(paths.data);
      if (before.isSymbolicLink?.()) {
        // This removes only the private-root directory entry. It never follows
        // the link or treats the linked target as a staged generation.
        await unlinkAndSync(this.#fileSystem, paths.data, { ignoreMissing: false });
      } else {
        let handle;
        let failure = null;
        let linksAfterUnlink = null;
        try {
          handle = await this.#fileSystem.open(paths.data, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const opened = await handle.stat();
          assertSingleLinkRegularFile(opened, "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION");
          if (!sameFileIdentity(before, opened)) {
            throw new KnowledgeCompilationError(
              "STAGING_FILE_IDENTITY_CHANGED",
              "The protected generation changed immediately before deletion. Cleanup remains armed and needs a safe retry."
            );
          }
          await unlinkAndSync(this.#fileSystem, paths.data, { ignoreMissing: false });
          linksAfterUnlink = (await handle.stat()).nlink;
        } catch (error) {
          failure = error;
        }
        if (handle) {
          try { await handle.close(); } catch (error) { failure ??= error; }
        }
        if (linksAfterUnlink !== null && linksAfterUnlink !== 0) {
          throw new KnowledgeCompilationError(
            "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION",
            "Another filesystem link retained the generation after its private staging path was removed. Cleanup needs local review and was not reported complete."
          );
        }
        if (failure) throw failure;
      }
      await finishNativeDeletionWitness(
        nativeWitness,
        paths.data,
        "Another filesystem link retained the generation after its private staging path was removed. Cleanup needs local review and was not reported complete."
      );
      await this.#markTombstoneUnlinkVerified(root, batchId, leaseId);
      return true;
    } catch (error) {
      operationFailure = error;
      if (error?.code === "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION") {
        try {
          await this.#markTombstoneNeedsAttention(
            root,
            batchId,
            leaseId,
            deleteStartedAt,
            tombstone.value.reason
          );
        } catch {
          // Preserve the authoritative multiple-link failure.
        }
      }
      throw error;
    } finally {
      try {
        await closeNativeDeletionWitness(nativeWitness);
      } catch (error) {
        if (!operationFailure) throw error;
      }
    }
  }

  async #unlinkUntrackedDataWithVerification(target) {
    let before;
    try {
      before = await this.#fileSystem.lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new KnowledgeCompilationError(
          "STAGING_FILE_IDENTITY_CHANGED",
          "Untracked staging data disappeared before its unlink result was verified. Cleanup needs local review and was not reported complete."
        );
      }
      throw error;
    }

    if (!before.isSymbolicLink?.()) {
      assertSingleLinkRegularFile(before, "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION");
    }
    let nativeWitness = null;
    let operationFailure = null;
    try {
      nativeWitness = await nativeDeletionWitness(target);
      if (before.isSymbolicLink?.()) {
        await unlinkAndSync(this.#fileSystem, target, { ignoreMissing: false });
      } else {
        let handle;
        let failure = null;
        let linksAfterUnlink = null;
        try {
          handle = await this.#fileSystem.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const opened = await handle.stat();
          assertSingleLinkRegularFile(opened, "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION");
          if (!sameFileIdentity(before, opened)) {
            throw new KnowledgeCompilationError(
              "STAGING_FILE_IDENTITY_CHANGED",
              "Untracked staging data changed identity immediately before deletion. Cleanup needs local review and was not reported complete."
            );
          }
          await unlinkAndSync(this.#fileSystem, target, { ignoreMissing: false });
          linksAfterUnlink = (await handle.stat()).nlink;
        } catch (error) {
          failure = error;
        }
        if (handle) {
          try { await handle.close(); } catch (error) { failure ??= error; }
        }
        if (linksAfterUnlink !== null && linksAfterUnlink !== 0) {
          throw new KnowledgeCompilationError(
            "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION",
            "Another filesystem link retained untracked staging bytes after the private path was removed. Cleanup needs local review and was not reported complete."
          );
        }
        if (failure) throw failure;
      }
      await finishNativeDeletionWitness(
        nativeWitness,
        target,
        "Another filesystem link retained untracked staging bytes after the private path was removed. Cleanup needs local review and was not reported complete."
      );
    } catch (error) {
      operationFailure = error;
      throw error;
    } finally {
      try {
        await closeNativeDeletionWitness(nativeWitness);
      } catch (error) {
        if (!operationFailure) throw error;
      }
    }
  }

  async #deleteGenerationWithVerification(batchId, leaseId, knownRoot = null, options = {}) {
    const root = knownRoot ?? await this.#trustedRoot();
    const paths = this.#paths(root, batchId, leaseId);
    const deleteStartedAt = new Date().toISOString();
    const cleanupReason = boundedCleanupReason(options.reason);
    const tombstone = await this.#ensureTombstone(root, batchId, leaseId, deleteStartedAt, cleanupReason);
    await this.#unlinkSingleLinkData(root, batchId, leaseId, deleteStartedAt, tombstone, options);
    if (!await pathIsAbsent(this.#fileSystem, paths.data)) {
      throw new KnowledgeCompilationError("STAGING_DELETE_FAILED", "The protected temporary batch still exists; cleanup remains armed and can be retried.");
    }
    await assertNativePathsAbsent(
      [paths.data],
      "The protected temporary batch still exists on the local filesystem; cleanup remains armed and can be retried."
    );
    let leaseWitness = null;
    let leaseOperationFailure = null;
    try {
      try {
        leaseWitness = await nativeDeletionWitness(paths.lease);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await unlinkAndSync(this.#fileSystem, paths.lease);
      if (!await pathIsAbsent(this.#fileSystem, paths.lease)) {
        throw new KnowledgeCompilationError("STAGING_DELETE_FAILED", "The protected generation marker still exists; cleanup remains armed and can be retried.");
      }
      if (leaseWitness) {
        await finishNativeDeletionWitness(
          leaseWitness,
          paths.lease,
          "Another filesystem link retained the protected generation marker. Cleanup needs local review and was not reported complete."
        );
      } else {
        await assertNativePathsAbsent(
          [paths.lease],
          "The protected generation marker still exists on the local filesystem; cleanup remains armed and can be retried."
        );
      }
    } catch (error) {
      leaseOperationFailure = error;
      throw error;
    } finally {
      try {
        await closeNativeDeletionWitness(leaseWitness);
      } catch (error) {
        if (!leaseOperationFailure) throw error;
      }
    }
    await assertNativePathsAbsent(
      [paths.data, paths.lease],
      "The exact protected generation still exists on the local filesystem, so cleanup was not reported complete."
    );
    const retentionResult = await this.#disarmGenerationRetention(batchId, leaseId, root);
    await assertNativePathsAbsent(
      [paths.data, paths.lease, paths.owner],
      "The exact protected generation or its cleanup worker reappeared while cleanup was being finalized."
    );
    await assertNativeGenerationWorkerTempsAbsent(root, batchId, leaseId);

    let completion = null;
    if (retentionResult?.completionReceiptAvailable) {
      completion = await this.#completionArtifactAt(root, batchId, leaseId, "receipt");
    } else {
      await this.#markTombstoneRetentionQuiesced(root, batchId, leaseId);
      try {
        await this.#writeCompletionReceipt(
          root,
          batchId,
          leaseId,
          new Date().toISOString(),
          tombstone.value.reason
        );
      } catch {
        // The finalized tombstone remains generation-bound completion evidence
        // if the optional canonical receipt cannot be written.
      }
      completion = await this.#completionArtifactAt(root, batchId, leaseId, "receipt")
        ?? await this.#completionArtifactAt(root, batchId, leaseId, "tombstone");
    }
    if (!completion) {
      throw new KnowledgeCompilationError(
        "STAGING_DELETE_RECEIPT_PENDING",
        "The private batch is absent, but its exact durable cleanup evidence is still pending and can be resumed."
      );
    }
    const timerKey = this.#timerKey(batchId, leaseId);
    const timer = this.#expiryTimers.get(timerKey);
    if (timer) clearTimeout(timer);
    this.#expiryTimers.delete(timerKey);
    return true;
  }

  async delete(input, operationToken = null) {
    if (operationToken !== INTERNAL_LOCAL_STAGING_OPERATION) {
      return runLocalStagingOperation(this.#root, () => (
        LOCAL_TEMPORARY_STAGING_METHODS.delete.call(this, input, INTERNAL_LOCAL_STAGING_OPERATION)
      ));
    }
    const { batchId, leaseId = null, reason = "explicit-delete" } = input;
    try {
      const safeBatchId = assertBatchId(batchId);
      const root = await this.#trustedRoot();
      const generation = await this.#activeGeneration(root, safeBatchId, leaseId);
      // Absence reported by an injected adapter is not deletion authority.
      // Exact lifecycle callers retain generation-bound completion artifacts
      // and reconcile those separately under the shared state lock.
      if (!generation) return false;
      return await this.#deleteGenerationWithVerification(safeBatchId, generation.leaseId, root, { reason });
    } catch (error) {
      if (error instanceof KnowledgeCompilationError && [
        "STAGING_HARDLINK_BLOCKED",
        "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION",
        "STAGING_FILE_IDENTITY_CHANGED"
      ].includes(error.code)) throw error;
      throw new KnowledgeCompilationError("STAGING_DELETE_FAILED", "I could not confirm removal of the protected temporary batch. Cleanup remains armed and will retry.");
    }
  }

  async acknowledgeCleanupReceipt(input, internalToken, operationToken = null) {
    if (operationToken !== INTERNAL_LOCAL_STAGING_OPERATION) {
      return runLocalStagingOperation(this.#root, () => (
        LOCAL_TEMPORARY_STAGING_METHODS.acknowledgeCleanupReceipt.call(
          this,
          input,
          internalToken,
          INTERNAL_LOCAL_STAGING_OPERATION
        )
      ));
    }
    const { batchId, leaseId } = input;
    if (internalToken !== INTERNAL_CLEANUP_ACKNOWLEDGEMENT) {
      throw new KnowledgeCompilationError(
        "STAGING_CLEANUP_ACK_INTERNAL_ONLY",
        "Cleanup evidence can be acknowledged only by the locked compilation lifecycle."
      );
    }
    const safeBatchId = assertBatchId(batchId);
    const safeLeaseId = assertOpaqueId(leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
    const root = await this.#trustedRoot();
    const paths = this.#paths(root, safeBatchId, safeLeaseId);
    const completion = await this.#completionArtifactAt(root, safeBatchId, safeLeaseId, "receipt")
      ?? await this.#completionArtifactAt(root, safeBatchId, safeLeaseId, "tombstone");
    if (!completion) {
      throw new KnowledgeCompilationError(
        "STAGING_CLEANUP_EVIDENCE_REQUIRED",
        "The exact generation still lacks verified completion evidence, so retention remains armed."
      );
    }
    // Deletion itself disarms retention before it returns certified success.
    // Do not invoke caller-supplied retention code after terminal lifecycle
    // truth has been durably saved; acknowledgement only retires content-free
    // local evidence after one final native absence check.
    await assertNativePathsAbsent(
      [paths.data, paths.lease, paths.owner],
      "The exact protected generation reappeared before cleanup evidence could be acknowledged."
    );
    await assertNativeGenerationWorkerTempsAbsent(root, safeBatchId, safeLeaseId);
    for (const target of [paths.receipt, paths.tombstone]) {
      await unlinkAndSync(this.#fileSystem, target);
    }
    await assertNativePathsAbsent(
      [paths.data, paths.lease, paths.owner],
      "The exact protected generation reappeared while cleanup evidence was being acknowledged."
    );
    await assertNativeGenerationWorkerTempsAbsent(root, safeBatchId, safeLeaseId);
  }

  async rawDeletionEvidence(input, operationToken = null) {
    if (operationToken !== INTERNAL_LOCAL_STAGING_OPERATION) {
      throw new KnowledgeCompilationError(
        "STAGING_CLEANUP_EVIDENCE_REQUIRED",
        "Raw-body deletion evidence is available only to the locked compilation lifecycle."
      );
    }
    const safeBatchId = assertBatchId(input?.batchId);
    const safeLeaseId = assertOpaqueId(input?.leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
    const root = await this.#trustedRoot();
    const paths = this.#paths(root, safeBatchId, safeLeaseId);
    let tombstone;
    try {
      tombstone = await readSmallJson(this.#fileSystem, paths.tombstone);
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
    const rawSourceBodiesDeletedAt = exactCanonicalTimestamp(tombstone?.dataUnlinkVerifiedAt);
    if (
      tombstone?.version !== RETENTION_ARTIFACT_VERSION
      || tombstone.batchId !== safeBatchId
      || tombstone.leaseId !== safeLeaseId
      || tombstone.cleanupBlockedReason != null
      || tombstone.dataUnlinkVerified !== true
      || !rawSourceBodiesDeletedAt
      || Date.parse(rawSourceBodiesDeletedAt) > Date.now() + COMPLETION_CLOCK_SKEW_MS
    ) return null;
    await assertNativePathsAbsent(
      [paths.data],
      "The exact protected raw staging data still exists, so raw-body deletion cannot be reported."
    );
    return Object.freeze({ rawSourceBodiesDeletedAt });
  }

  async #discoverCompletionArtifacts(root) {
    const entries = await this.#fileSystem.readdir(root, { withFileTypes: true });
    const completions = new Map();
    for (const kind of ["tombstone", "receipt"]) {
      const suffix = kind === "receipt" ? STAGING_RECEIPT_SUFFIX : STAGING_TOMBSTONE_SUFFIX;
      for (const entry of entries) {
        const parsed = parseGenerationArtifact(entry.name, suffix);
        if (!parsed) continue;
        let raw;
        try {
          raw = await readSmallJson(this.#fileSystem, join(root, entry.name));
        } catch (error) {
          // A malformed, oversized, non-file, or symlinked completion
          // artifact is never deletion evidence. Leave it for the descriptor
          // scan below to surface as durable local attention instead of
          // letting it block every subsequent staging restart.
          if (error?.code === "ENOENT" || isIntrinsicRetentionArtifactError(error)) continue;
          throw error;
        }
        const leaseId = typeof raw?.leaseId === "string" && OPAQUE_ID.test(raw.leaseId) ? raw.leaseId : null;
        if (!leaseId || generationTagForLease(leaseId) !== parsed.generationTag) continue;
        let completion;
        try {
          completion = await this.#completionArtifactAt(root, parsed.batchId, leaseId, kind);
        } catch (error) {
          if (error instanceof KnowledgeCompilationError && [
            "STAGING_DELETE_FAILED",
            "RETENTION_SERVICE_UNAVAILABLE"
          ].includes(error.code)) continue;
          throw error;
        }
        if (!completion) continue;
        const key = `${parsed.batchId}\u0000${leaseId}`;
        if (kind === "receipt" || !completions.has(key)) completions.set(key, completion);
      }
    }
    return [...completions.values()];
  }

  async #cleanupExpiredInRoot(root, now) {
    const current = Date.parse(canonicalTimestamp(now, "STAGING_TIMESTAMP_INVALID"));
    const removedBatches = [];
    const cleanupNeedsAttentionBatches = [];
    const completionReceipts = await this.#discoverCompletionArtifacts(root);
    const completedGenerationKeys = new Set(completionReceipts.map((entry) => (
      `${entry.batchId}\u0000${generationTagForLease(entry.leaseId)}`
    )));
    const entries = await this.#fileSystem.readdir(root, { withFileTypes: true });
    const descriptors = new Map();
    for (const entry of entries) {
      const leaseArtifact = parseGenerationArtifact(entry.name, STAGING_LEASE_SUFFIX);
      const receiptArtifact = parseGenerationArtifact(entry.name, STAGING_RECEIPT_SUFFIX);
      const tombstoneArtifact = parseGenerationArtifact(entry.name, STAGING_TOMBSTONE_SUFFIX);
      const ownerArtifact = parseGenerationArtifact(entry.name, STAGING_OWNER_SUFFIX);
      const workerTempArtifact = parseGenerationWorkerTempArtifact(entry.name);
      const isSpecial = [STAGING_LEASE_SUFFIX, STAGING_RECEIPT_SUFFIX, STAGING_TOMBSTONE_SUFFIX, STAGING_OWNER_SUFFIX]
        .some((suffix) => entry.name.endsWith(suffix));
      const dataArtifact = isSpecial ? null : parseGenerationArtifact(entry.name, STAGING_FILE_SUFFIX);
      const artifact = leaseArtifact
        ?? receiptArtifact
        ?? tombstoneArtifact
        ?? ownerArtifact
        ?? workerTempArtifact
        ?? dataArtifact;
      if (!artifact) continue;
      const key = `${artifact.batchId}\u0000${artifact.generationTag}`;
      const descriptor = descriptors.get(key) ?? {
        ...artifact,
        hasLease: false,
        hasReceipt: false,
        hasTombstone: false,
        hasOwner: false,
        hasWorkerTemp: false,
        hasData: false
      };
      if (leaseArtifact) descriptor.hasLease = true;
      if (receiptArtifact) descriptor.hasReceipt = true;
      if (tombstoneArtifact) descriptor.hasTombstone = true;
      if (ownerArtifact) descriptor.hasOwner = true;
      if (workerTempArtifact) descriptor.hasWorkerTemp = true;
      if (dataArtifact) descriptor.hasData = true;
      descriptors.set(key, descriptor);
    }

    for (const descriptor of descriptors.values()) {
      const descriptorKey = `${descriptor.batchId}\u0000${descriptor.generationTag}`;
      if (completedGenerationKeys.has(descriptorKey)) continue;
      if (descriptor.hasWorkerTemp) {
        cleanupNeedsAttentionBatches.push({
          batchId: descriptor.batchId,
          generationTag: descriptor.generationTag,
          leaseId: null,
          reason: "RETENTION_SERVICE_UNAVAILABLE"
        });
        continue;
      }
      if (!descriptor.hasLease) {
        let retentionLeaseId = null;
        try {
          retentionLeaseId = await this.#retentionLeaseForGeneration(
            root,
            descriptor.batchId,
            descriptor.generationTag
          );
        } catch (error) {
          cleanupNeedsAttentionBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: unverifiedCleanupFailureReason(error)
          });
          continue;
        }
        if (retentionLeaseId) {
          try {
            await this.#deleteGenerationWithVerification(
              descriptor.batchId,
              retentionLeaseId,
              root,
              {
                allowNewlyAbsentData: !descriptor.hasData,
                reason: "orphaned-generation"
              }
            );
            removedBatches.push({
              batchId: descriptor.batchId,
              generationTag: descriptor.generationTag,
              leaseId: retentionLeaseId,
              reason: "orphaned-generation"
            });
          } catch (error) {
            const reason = unverifiedCleanupFailureReason(error);
            if (reason) {
              cleanupNeedsAttentionBatches.push({
                batchId: descriptor.batchId,
                generationTag: descriptor.generationTag,
                leaseId: retentionLeaseId,
                reason
              });
            }
          }
          continue;
        }
        if (descriptor.hasReceipt || descriptor.hasTombstone) {
          cleanupNeedsAttentionBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: "STAGING_CLEANUP_EVIDENCE_REQUIRED"
          });
          continue;
        }
        // An owner observed by this scan must never be downgraded to
        // lease-less cleanup authority if it changes or disappears while the
        // scan is running. Preserve nonterminal truth for a safe retry.
        if (descriptor.hasOwner || !descriptor.hasData) {
          cleanupNeedsAttentionBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: descriptor.hasOwner
              ? "RETENTION_SERVICE_UNAVAILABLE"
              : "STAGING_FILE_IDENTITY_CHANGED"
          });
          continue;
        }
        const orphanPath = resolve(root, `${STAGING_FILE_PREFIX}${descriptor.batchId}.${descriptor.generationTag}${STAGING_FILE_SUFFIX}`);
        try {
          await this.#unlinkUntrackedDataWithVerification(orphanPath);
          await this.#assertUntrackedGenerationArtifactsAbsent(
            root,
            descriptor.batchId,
            descriptor.generationTag,
            "An untracked staging generation or its cleanup worker remained after orphan cleanup. Cleanup was not reported complete."
          );
          removedBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: "orphaned-generation"
          });
        } catch (error) {
          cleanupNeedsAttentionBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: cleanupNeedsLocalAttention(error) ? error.code : "STAGING_DELETE_FAILED"
          });
        }
        continue;
      }
      const leasePath = resolve(root, `${STAGING_FILE_PREFIX}${descriptor.batchId}.${descriptor.generationTag}${STAGING_LEASE_SUFFIX}`);
      let rawManifest;
      let manifest;
      try {
        rawManifest = await readSmallJson(this.#fileSystem, leasePath);
        const leaseId = assertOpaqueId(rawManifest?.leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
        if (generationTagForLease(leaseId) !== descriptor.generationTag) {
          throw new KnowledgeCompilationError(
            "STAGING_LEASE_INVALID",
            "The protected temporary batch generation marker did not match its immutable filename."
          );
        }
        manifest = this.#validatedManifest(rawManifest, descriptor.batchId, leaseId);
      } catch (error) {
        if (!isIntrinsicRetentionArtifactError(error) && !isIntrinsicStagingValidationError(error)) {
          throw error;
        }
        const dataPath = resolve(root, `${STAGING_FILE_PREFIX}${descriptor.batchId}.${descriptor.generationTag}${STAGING_FILE_SUFFIX}`);
        let retentionLeaseId = null;
        try {
          retentionLeaseId = await this.#retentionLeaseForGeneration(
            root,
            descriptor.batchId,
            descriptor.generationTag
          );
        } catch (error) {
          cleanupNeedsAttentionBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: unverifiedCleanupFailureReason(error)
          });
          continue;
        }
        if (retentionLeaseId) {
          try {
            await this.#deleteGenerationWithVerification(
              descriptor.batchId,
              retentionLeaseId,
              root,
              {
                allowNewlyAbsentData: !descriptor.hasData,
                reason: "invalid-generation"
              }
            );
            removedBatches.push({
              batchId: descriptor.batchId,
              generationTag: descriptor.generationTag,
              leaseId: retentionLeaseId,
              reason: "invalid-generation"
            });
          } catch (error) {
            const reason = unverifiedCleanupFailureReason(error);
            if (reason) {
              cleanupNeedsAttentionBatches.push({
                batchId: descriptor.batchId,
                generationTag: descriptor.generationTag,
                leaseId: retentionLeaseId,
                reason
              });
            }
          }
          continue;
        }
        if (descriptor.hasReceipt || descriptor.hasTombstone) {
          cleanupNeedsAttentionBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: "STAGING_CLEANUP_EVIDENCE_REQUIRED"
          });
          continue;
        }
        if (descriptor.hasOwner || !descriptor.hasData) {
          cleanupNeedsAttentionBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: descriptor.hasOwner
              ? "RETENTION_SERVICE_UNAVAILABLE"
              : "STAGING_FILE_IDENTITY_CHANGED"
          });
          continue;
        }
        try {
          await this.#unlinkUntrackedDataWithVerification(dataPath);
          await this.#unlinkUntrackedDataWithVerification(leasePath);
          await this.#assertUntrackedGenerationArtifactsAbsent(
            root,
            descriptor.batchId,
            descriptor.generationTag,
            "A malformed staging generation remained on the local filesystem after cleanup. Cleanup needs local review and was not reported complete."
          );
          removedBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: "invalid-generation"
          });
        } catch (error) {
          cleanupNeedsAttentionBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: null,
            reason: cleanupNeedsLocalAttention(error) ? error.code : "STAGING_DELETE_FAILED"
          });
        }
        continue;
      }
      const paths = this.#paths(root, descriptor.batchId, manifest.leaseId);
      const dataAbsent = await pathIsAbsent(this.#fileSystem, paths.data);
      let invalidData = false;
      let localAttentionError = null;
      if (!dataAbsent) {
        try {
          const payload = await this.#readPayloadAt(root, descriptor.batchId, manifest.leaseId);
          invalidData = payload.createdAt !== manifest.createdAt || payload.expiresAt !== manifest.expiresAt;
        } catch (error) {
          if (cleanupNeedsLocalAttention(error)) {
            // A local-integrity concern is not proof that the generation is
            // malformed. If deletion is otherwise due, the verified deletion
            // path below records bounded attention without deleting blindly.
            localAttentionError = error;
          } else {
            if (!isIntrinsicStagingValidationError(error)) throw error;
            invalidData = true;
          }
        }
      }
      const expiresAt = Date.parse(manifest.expiresAt);
      const cleanupRequired = invalidData || expiresAt <= current || (dataAbsent && manifest.phase === "ready");
      if (localAttentionError && !cleanupRequired) {
        try {
          // Preserve a durable, generation-bound marker for local review
          // without attempting to unlink a still-active protected batch.
          await this.#ensureTombstone(
            root,
            descriptor.batchId,
            manifest.leaseId,
            new Date().toISOString(),
            "unknown-cleanup"
          );
        } catch (error) {
          const reason = unverifiedCleanupFailureReason(error);
          if (reason) {
            cleanupNeedsAttentionBatches.push({
              batchId: descriptor.batchId,
              generationTag: descriptor.generationTag,
              leaseId: manifest.leaseId,
              reason
            });
          }
        }
        cleanupNeedsAttentionBatches.push({
          batchId: descriptor.batchId,
          generationTag: descriptor.generationTag,
          leaseId: manifest.leaseId,
          reason: localAttentionError.code
        });
        this.#scheduleExpiry(descriptor.batchId, manifest.leaseId, manifest.expiresAt);
        try { await this.#armRetention(descriptor.batchId, manifest.expiresAt, manifest.leaseId, root); } catch {}
        continue;
      }
      if (cleanupRequired) {
        const reason = invalidData ? "invalid-generation" : expiresAt <= current ? "expired" : "verified-early-absence";
        try {
          // Startup cannot infer that an already-absent path was unlinked by
          // this generation's cleanup. Even a prepared marker may have had a
          // partial staged file moved or linked away before the restart.
          await this.#deleteGenerationWithVerification(descriptor.batchId, manifest.leaseId, root, { reason });
          removedBatches.push({
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: manifest.leaseId,
            reason
          });
        } catch (error) {
          const reason = unverifiedCleanupFailureReason(error);
          if (reason) {
            cleanupNeedsAttentionBatches.push({
              batchId: descriptor.batchId,
              generationTag: descriptor.generationTag,
              leaseId: manifest.leaseId,
              reason
            });
          }
          // A hard link, identity change, or unexplained ready-file absence
          // cannot become a false cleanup receipt. Restore both in-process and
          // detached retry coverage for this exact durable generation.
          this.#scheduleExpiry(descriptor.batchId, manifest.leaseId, manifest.expiresAt);
          try { await this.#armRetention(descriptor.batchId, manifest.expiresAt, manifest.leaseId, root); } catch {}
        }
        continue;
      }

      this.#scheduleExpiry(descriptor.batchId, manifest.leaseId, manifest.expiresAt);
      try {
        await this.#armRetention(descriptor.batchId, manifest.expiresAt, manifest.leaseId, root);
      } catch {
        try {
          await this.#deleteGenerationWithVerification(descriptor.batchId, manifest.leaseId, root, {
            reason: "retention-unavailable"
          });
          const removal = {
            batchId: descriptor.batchId,
            generationTag: descriptor.generationTag,
            leaseId: manifest.leaseId,
            reason: "retention-unavailable"
          };
          this.#retentionCoverageUnavailableBatches.push(removal);
          removedBatches.push(removal);
        } catch (error) {
          const reason = unverifiedCleanupFailureReason(error);
          if (reason) {
            cleanupNeedsAttentionBatches.push({
              batchId: descriptor.batchId,
              generationTag: descriptor.generationTag,
              leaseId: manifest.leaseId,
              reason
            });
          }
          // The durable generation marker remains, so a later owner-only
          // cleanup attempt can retry without exposing any content.
        }
      }
    }
    return {
      removedBatches,
      cleanupNeedsAttentionBatches,
      // Startup cleanup evidence is queued until the lifecycle lock can
      // consume it. Remember every generation observed by this fresh scan so
      // evidence from an earlier scan cannot override a generation that has
      // since reappeared and was revalidated, removed again, or placed into a
      // current needs-attention state.
      observedGenerationKeys: [...descriptors.keys()],
      completionReceipts: await this.#discoverCompletionArtifacts(root)
    };
  }

  #removalEvidencePaths(root, entry) {
    const batchId = assertBatchId(entry?.batchId);
    const generationTag = typeof entry?.generationTag === "string" && GENERATION_TAG.test(entry.generationTag)
      ? entry.generationTag
      : null;
    if (!generationTag) {
      throw new KnowledgeCompilationError(
        "STAGING_CLEANUP_EVIDENCE_REQUIRED",
        "Cleanup evidence did not identify one exact protected staging generation."
      );
    }
    if (entry?.leaseId) {
      const leaseId = assertOpaqueId(entry.leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
      if (generationTagForLease(leaseId) !== generationTag) {
        throw new KnowledgeCompilationError(
          "STAGING_CLEANUP_EVIDENCE_REQUIRED",
          "Cleanup evidence did not match the exact protected staging generation."
        );
      }
      return this.#paths(root, batchId, leaseId);
    }
    return this.#pathsForGenerationTag(root, batchId, generationTag);
  }

  async cleanupExpired(input, operationToken = null) {
    if (operationToken !== INTERNAL_LOCAL_STAGING_OPERATION) {
      return runLocalStagingOperation(this.#root, () => (
        LOCAL_TEMPORARY_STAGING_METHODS.cleanupExpired.call(this, input, INTERNAL_LOCAL_STAGING_OPERATION)
      ));
    }
    const { now } = input;
    const root = await this.#trustedRoot();
    const cleaned = await this.#cleanupExpiredInRoot(root, now);
    const observedGenerationKeys = new Set(cleaned.observedGenerationKeys ?? []);
    const startupEvidenceIsStillCurrent = (entry) => !observedGenerationKeys.has(
      `${entry.batchId}\u0000${entry.generationTag ?? ""}`
    );
    const candidateRemovedBatches = [
      ...this.#startupRemovedBatches.filter(startupEvidenceIsStillCurrent),
      ...cleaned.removedBatches
    ];
    const candidateCleanupNeedsAttentionBatches = [
      ...this.#startupCleanupNeedsAttentionBatches.filter(startupEvidenceIsStillCurrent),
      ...cleaned.cleanupNeedsAttentionBatches
    ];
    const removedBatches = [];
    for (const entry of candidateRemovedBatches) {
      const paths = this.#removalEvidencePaths(root, entry);
      try {
        if (entry.leaseId) {
          await assertNativePathsAbsent(
            [paths.data, paths.lease, paths.owner],
            "The exact protected generation or its cleanup worker reappeared before cleanup results were finalized. Cleanup was not reported complete."
          );
          await assertNativeGenerationWorkerTempsAbsent(root, entry.batchId, entry.leaseId);
        } else {
          await this.#assertUntrackedGenerationArtifactsAbsent(
            root,
            entry.batchId,
            entry.generationTag,
            "An untracked staging generation or its cleanup worker reappeared before cleanup results were finalized. Cleanup was not reported complete."
          );
        }
        removedBatches.push(entry);
      } catch (error) {
        if (!(error instanceof KnowledgeCompilationError)) throw error;
        candidateCleanupNeedsAttentionBatches.push({
          batchId: entry.batchId,
          generationTag: entry.generationTag,
          leaseId: entry.leaseId ?? null,
          reason: unverifiedCleanupFailureReason(error)
        });
      }
    }
    const completionReceipts = [];
    for (const receipt of cleaned.completionReceipts) {
      const paths = this.#paths(root, receipt.batchId, receipt.leaseId);
      try {
        await assertNativePathsAbsent(
          [paths.data, paths.lease, paths.owner],
          "The exact protected generation or its cleanup worker reappeared before cleanup evidence was finalized. Its receipt was not reported complete."
        );
        await assertNativeGenerationWorkerTempsAbsent(root, receipt.batchId, receipt.leaseId);
        completionReceipts.push(receipt);
      } catch (error) {
        if (!(error instanceof KnowledgeCompilationError)) throw error;
        candidateCleanupNeedsAttentionBatches.push({
          batchId: receipt.batchId,
          generationTag: generationTagForLease(receipt.leaseId),
          leaseId: receipt.leaseId,
          reason: unverifiedCleanupFailureReason(error)
        });
      }
    }
    const cleanupNeedsAttentionBatches = [...new Map(candidateCleanupNeedsAttentionBatches.map((entry) => [
      `${entry.batchId}\u0000${entry.generationTag ?? ""}\u0000${entry.leaseId ?? ""}\u0000${entry.reason}`,
      entry
    ])).values()];
    const retentionCoverageUnavailableBatches = [...this.#retentionCoverageUnavailableBatches];
    this.#startupRemovedBatches = [];
    this.#startupCleanupNeedsAttentionBatches = [];
    this.#retentionCoverageUnavailableBatches = [];
    return {
      removedBatches,
      removedBatchIds: [...new Set(removedBatches.map((entry) => entry.batchId))].sort(),
      cleanupNeedsAttentionBatches,
      cleanupNeedsAttentionBatchIds: [...new Set(cleanupNeedsAttentionBatches.map((entry) => entry.batchId))].sort(),
      retentionCoverageUnavailableBatches,
      retentionCoverageUnavailableBatchIds: [...new Set(retentionCoverageUnavailableBatches.map((entry) => entry.batchId))].sort(),
      completionReceipts
    };
  }
}

LOCAL_TEMPORARY_STAGING_METHODS = Object.freeze({
  initialize: LocalTemporaryStaging.prototype.initialize,
  stage: LocalTemporaryStaging.prototype.stage,
  read: LocalTemporaryStaging.prototype.read,
  delete: LocalTemporaryStaging.prototype.delete,
  cleanupExpired: LocalTemporaryStaging.prototype.cleanupExpired,
  rawDeletionEvidence: LocalTemporaryStaging.prototype.rawDeletionEvidence,
  acknowledgeCleanupReceipt: LocalTemporaryStaging.prototype.acknowledgeCleanupReceipt
});

async function acknowledgeVerifiedCleanup(staging, acknowledgement) {
  if (typeof staging.acknowledgeCleanupReceipt !== "function") return;
  await staging.acknowledgeCleanupReceipt(
    acknowledgement,
    INTERNAL_CLEANUP_ACKNOWLEDGEMENT
  );
}

function canonicalTimestamp(value, errorCode = "TIMESTAMP_INVALID") {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new KnowledgeCompilationError(errorCode, "A valid observed or verified timestamp is required for each approved record.");
  }
  return new Date(value).toISOString();
}

function canonicalOptionalTimestamp(value) {
  return value == null ? null : canonicalTimestamp(value);
}

function assertOpaqueId(value, code, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new KnowledgeCompilationError(code, `${field} must be a short opaque identifier without spaces or sensitive account details.`);
  }
  return value;
}

function assertNoUnexpectedFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeCompilationError("NORMALIZED_RECORD_INVALID", `Each ${label} must be a plain normalized object.`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new KnowledgeCompilationError(
      "RAW_SOURCE_FIELD_BLOCKED",
      `The ${label} included an unsupported field. Raw source bodies, headers, attachments, and configuration are never accepted here.`
    );
  }
}

function safeNormalizedText(value, { allowNull = false, field, maxLength = 360 } = {}) {
  if (allowNull && value == null) return null;
  if (typeof value !== "string") {
    throw new KnowledgeCompilationError("NORMALIZED_TEXT_INVALID", `${field} must be normalized short text, not a source body.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n]/.test(normalized) || DANGEROUS_TEXT.test(normalized) || SENSITIVE_TEXT.test(normalized)) {
    throw new KnowledgeCompilationError(
      "NORMALIZED_TEXT_UNSAFE",
      `${field} must be a short, non-sensitive normalized assertion. Source text and embedded instructions are not accepted.`
    );
  }
  return normalized;
}

function normalizedStableLink(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new KnowledgeCompilationError("SOURCE_PROVENANCE_INVALID", "A stable source link must be an approved HTTPS reference or omitted.");
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || url.hostname === "localhost"
      || url.hostname.endsWith(".localhost")
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)
      || url.hostname.includes(":")
    ) {
      throw new Error("unsafe host");
    }
    const stable = `${url.origin}${url.pathname}`;
    if (stable.length > 512 || SENSITIVE_TEXT.test(decodeURIComponent(url.pathname))) {
      throw new Error("sensitive path");
    }
    return stable;
  } catch {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "A stable source link must be a short, approved HTTPS reference without credentials, parameters, or sensitive details."
    );
  }
}

function normalizedPrivacy(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.length > PRIVACY_RESTRICTIONS.size) {
    throw new KnowledgeCompilationError("PRIVACY_RESTRICTION_REQUIRED", `${field} must include at least one recognized privacy restriction.`);
  }
  const normalized = [...new Set(value.map((restriction) => typeof restriction === "string" ? restriction.trim() : ""))].sort();
  if (normalized.some((restriction) => !PRIVACY_RESTRICTIONS.has(restriction))) {
    throw new KnowledgeCompilationError(
      "PRIVACY_RESTRICTION_INVALID",
      `${field} contains an unsupported privacy restriction. Keep the restriction explicit and bounded.`
    );
  }
  return normalized;
}

function normalizedOpaqueReferences(value, field, maxLength = 64) {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new KnowledgeCompilationError("SOURCE_PROVENANCE_INVALID", `${field} must be a bounded list of approved opaque references.`);
  }
  return [...new Set(value.map((reference) => assertOpaqueId(reference, "SOURCE_PROVENANCE_INVALID", field)))].sort();
}

function sourceEntryKey(source, accountId) {
  return `${source}:${encodeURIComponent(accountId)}`;
}

function recordFitsGrantMetadata(item, scope) {
  const containsOrEmpty = (value, allowed) => value == null || (Array.isArray(allowed) && allowed.includes(value));
  if (!containsOrEmpty(item.area, scope.areas)) return false;
  if (!containsOrEmpty(item.folder, scope.folders)) return false;
  if (!containsOrEmpty(item.channel, scope.channels)) return false;
  const conversation = item.kind === "conversation" ? item.id : (item.conversation ?? null);
  if (!containsOrEmpty(conversation, scope.conversations)) return false;
  if (!containsOrEmpty(item.category, scope.categories)) return false;

  const timestamp = item.timestamp ? Date.parse(item.timestamp) : null;
  if (scope.dateRange?.kind !== "selected-folders-only" && Number.isFinite(timestamp)) {
    if (timestamp < Date.parse(scope.dateRange.from) || timestamp > Date.parse(scope.dateRange.to)) return false;
    if ((scope.exclusions?.dateRanges ?? []).some((range) => timestamp >= Date.parse(range.from) && timestamp <= Date.parse(range.to))) return false;
  }

  if (!Array.isArray(item.participantIds)) return false;
  const participantIds = item.participantIds;
  const allowedPeople = new Set(Array.isArray(scope.people?.allowed) ? scope.people.allowed : []);
  const blockedPeople = new Set(Array.isArray(scope.people?.blocked) ? scope.people.blocked : []);
  const excludedPeople = participantIds.filter((personId) => scope.exclusions?.people?.includes(personId));
  const allowedBlockedGroupException = item.kind === "conversation"
    && item.isGroup === true
    && scope.blockedGroupConversationExceptions?.includes(item.id);
  if (allowedBlockedGroupException) {
    // A separately reviewed group can include only its explicitly selected
    // Allowed people plus the known Blocked people that justified the separate
    // exception. Restricted or unknown participants never hitchhike on it.
    if (participantIds.some((personId) => !allowedPeople.has(personId) && !blockedPeople.has(personId))) return false;
    if (excludedPeople.some((personId) => !blockedPeople.has(personId))) return false;
  } else if (excludedPeople.length > 0 || participantIds.some((personId) => !allowedPeople.has(personId))) {
    return false;
  }
  // Persisted review metadata is already normalized by QWA-139 and therefore
  // always carries this array (including [] for ordinary records). Missing or
  // non-array data is corruption, not evidence that the item is non-sensitive.
  if (!Array.isArray(item.sensitiveCategories)) return false;
  const declaredSensitive = item.sensitiveCategories;
  // Older/tampered metadata that carries an unrecognized sensitivity label
  // must never become ordinary content just because a prior normalizer dropped
  // it. Require a fresh metadata review instead.
  if (declaredSensitive.some((category) => typeof category !== "string" || !SENSITIVE_CATEGORIES.includes(category))) return false;
  if (item.uncertainSensitivity !== undefined && typeof item.uncertainSensitivity !== "boolean") return false;
  const sensitive = [...declaredSensitive, ...(item.uncertainSensitivity === true ? ["uncertain-sensitivity"] : [])];
  return !sensitive.some((category) => (
    scope.sensitiveGroups?.excluded?.includes(category)
    || !scope.sensitiveGroups?.included?.includes(category)
  ));
}

function assertActiveGrantForRecord(state, record) {
  const lifecycle = state?.sourcePermissionLifecycle;
  const entry = lifecycle?.entries?.[sourceEntryKey(record.source, record.accountId)];
  if (!entry || entry.status !== "granted" || entry.review?.id !== record.reviewId) {
    throw new KnowledgeCompilationError(
      "ACTIVE_GRANT_REQUIRED",
      "No active reviewed permission matches this record, so it was not staged or compiled."
    );
  }
  const grant = entry.grants?.find((candidate) => candidate.status === "active" && candidate.id === record.grantId);
  if (
    !grant
    || grant.source !== record.source
    || grant.accountId !== record.accountId
    || grant.reviewId !== record.reviewId
  ) {
    throw new KnowledgeCompilationError(
      "ACTIVE_GRANT_REQUIRED",
      "No active reviewed permission matches this record, so it was not staged or compiled."
    );
  }
  if (
    !grant.disclosuresAcknowledged?.modelProcessing?.acknowledged
    || !grant.disclosuresAcknowledged?.untrustedSourceMaterial?.acknowledged
  ) {
    throw new KnowledgeCompilationError(
      "PERSISTED_GRANT_INVALID",
      "The saved permission no longer matches its reviewed boundary, so the record was not staged or compiled."
    );
  }
  try {
    // Re-run the canonical QWA-139 normalization against immutable metadata on
    // every compile/resume. Comparing only a persisted grant to a mutable
    // requestedScope would let both forged objects agree while promoting a
    // Restricted or Blocked person beyond metadata's deny-by-default floor.
    assertPersistedSourcePermissionGrantStillMatchesReview(grant, entry);
  } catch {
    throw new KnowledgeCompilationError(
      "PERSISTED_GRANT_INVALID",
      "The saved permission no longer matches its reviewed metadata boundary, so the record was not staged or compiled."
    );
  }
  const metadataItem = entry.review?.metadata?.items?.find((item) => item.id === record.sourceRecordId);
  if (!metadataItem || !recordFitsGrantMetadata(metadataItem, grant.scope)) {
    throw new KnowledgeCompilationError(
      "RECORD_OUTSIDE_APPROVED_SCOPE",
      "A record fell outside the saved granular permission scope, so it was not staged or compiled."
    );
  }
  return { grant, entry, metadataItem };
}

function normalizeInertStagingRecords(records, { maxRecords = MAX_BATCH_RECORDS } = {}) {
  if (!Array.isArray(records) || records.length === 0 || records.length > maxRecords) {
    throw new KnowledgeCompilationError("APPROVED_RECORDS_REQUIRED", `Provide between 1 and ${maxRecords} approved normalized records.`);
  }
  const seenRecords = new Set();
  return records.map((record) => {
    assertNoUnexpectedFields(record, RECORD_FIELDS, "approved record");
    if (typeof record.source !== "string" || !SOURCE_NAME.test(record.source)) {
      throw new KnowledgeCompilationError("SOURCE_REFERENCE_INVALID", "Each approved record must include a named source reference.");
    }
    const source = record.source;
    const accountId = assertOpaqueId(record.accountId, "ACCOUNT_REFERENCE_INVALID", "accountId");
    const sourceRecordId = assertOpaqueId(record.sourceRecordId, "SOURCE_REFERENCE_INVALID", "sourceRecordId");
    const reviewId = assertOpaqueId(record.reviewId, "REVIEW_REFERENCE_INVALID", "reviewId");
    const grantId = assertOpaqueId(record.grantId, "GRANT_REFERENCE_INVALID", "grantId");
    if (record.processingDisposition !== "untrusted-inert-reference") {
      throw new KnowledgeCompilationError(
        "UNTRUSTED_DISPOSITION_REQUIRED",
        "Approved records must remain untrusted inert references; source content is never treated as instructions."
      );
    }
    const key = `${source}\u0000${accountId}\u0000${sourceRecordId}\u0000${reviewId}\u0000${grantId}`;
    if (seenRecords.has(key)) {
      throw new KnowledgeCompilationError("DUPLICATE_SOURCE_RECORD", "Each approved source record may appear only once in a batch.");
    }
    seenRecords.add(key);

    const sourceTimestamp = canonicalTimestamp(record.sourceTimestamp, "SOURCE_TIMESTAMP_REQUIRED");
    const approvedParticipantRefs = normalizedOpaqueReferences(record.approvedParticipantRefs, "approvedParticipantRefs");
    const sourceLabel = safeNormalizedText(record.sourceLabel, { allowNull: true, field: "sourceLabel", maxLength: 160 });
    const stableLink = normalizedStableLink(record.stableLink);
    const observedAt = canonicalTimestamp(record.observedAt);
    const verifiedAt = canonicalOptionalTimestamp(record.verifiedAt);
    if (verifiedAt && Date.parse(verifiedAt) < Date.parse(observedAt)) {
      throw new KnowledgeCompilationError("VERIFICATION_DATE_INVALID", "A verified date cannot precede the observed date.");
    }
    const privacyRestrictions = normalizedPrivacy(record.privacyRestrictions, "record privacyRestrictions");
    if (!Array.isArray(record.assertions) || record.assertions.length === 0 || record.assertions.length > 32) {
      throw new KnowledgeCompilationError("ASSERTIONS_REQUIRED", "Each approved record must contain a bounded list of normalized assertions.");
    }
    const assertions = record.assertions.map((assertion) => {
      assertNoUnexpectedFields(assertion, ASSERTION_FIELDS, "normalized assertion");
      const subjectType = assertion.subjectType;
      if (!Object.hasOwn(SUBJECT_TYPES, subjectType)) {
        throw new KnowledgeCompilationError("SUBJECT_TYPE_INVALID", "A canonical assertion must use a supported people, organization, project, decision, priority, area, meeting, or knowledge subject.");
      }
      const subjectId = assertOpaqueId(assertion.subjectId, "SUBJECT_ID_INVALID", "subjectId");
      const subjectLabel = safeNormalizedText(assertion.subjectLabel, { field: "subjectLabel", maxLength: 120 });
      const text = safeNormalizedText(assertion.assertion, { allowNull: true, field: "assertion" });
      const confidence = assertion.confidence;
      if (!CONFIDENCE_LEVELS.has(confidence)) {
        throw new KnowledgeCompilationError("CONFIDENCE_INVALID", "Each assertion must state confirmed, likely, or uncertain confidence.");
      }
      if (text === null && confidence !== "uncertain") {
        throw new KnowledgeCompilationError("UNKNOWN_CONFIDENCE_INVALID", "An unknown assertion must remain uncertain instead of receiving invented confidence.");
      }
      const assertionPrivacy = assertion.privacyRestrictions == null
        ? privacyRestrictions
        : normalizedPrivacy(assertion.privacyRestrictions, "assertion privacyRestrictions");
      return {
        subjectType,
        subjectId,
        subjectLabel,
        assertion: text,
        confidence,
        privacyRestrictions: [...new Set([...privacyRestrictions, ...assertionPrivacy])].sort()
      };
    });
    return {
      source,
      accountId,
      sourceRecordId,
      reviewId,
      grantId,
      processingDisposition: "untrusted-inert-reference",
      sourceTimestamp,
      approvedParticipantRefs,
      sourceLabel,
      stableLink,
      observedAt,
      verifiedAt,
      privacyRestrictions,
      assertions
    };
  });
}

function neutralSourceLabel(source) {
  return `Approved ${source} reference`;
}

function approvedParticipantRefsForMetadata(metadataItem) {
  return normalizedOpaqueReferences(metadataItem.participantIds ?? [], "approved participant metadata");
}

function validateApprovedProvenance(record, metadataItem) {
  const sourceTimestamp = canonicalTimestamp(metadataItem.timestamp, "SOURCE_TIMESTAMP_REQUIRED");
  if (record.sourceTimestamp !== sourceTimestamp) {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "The source timestamp no longer matches the reviewed metadata, so the record was not compiled."
    );
  }
  const approvedParticipantRefs = approvedParticipantRefsForMetadata(metadataItem);
  if (JSON.stringify(record.approvedParticipantRefs) !== JSON.stringify(approvedParticipantRefs)) {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "The participant references do not exactly match the reviewed metadata, so the record was not compiled."
    );
  }

  let reviewedLabel = null;
  try {
    reviewedLabel = safeNormalizedText(metadataItem.label, { field: "reviewed sourceLabel", maxLength: 160 });
  } catch {
    // The caller can still use a neutral label if a reviewed metadata label is
    // not safe enough to retain in a generated note.
    reviewedLabel = null;
  }
  const neutralLabel = neutralSourceLabel(record.source);
  const usesNeutralLabel = record.sourceLabel === null || record.sourceLabel === neutralLabel;
  const sourceLabel = usesNeutralLabel ? neutralLabel : record.sourceLabel;
  if (!usesNeutralLabel && (!reviewedLabel || record.sourceLabel !== reviewedLabel)) {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "The source label does not exactly match a safe reviewed metadata label, so it was not compiled."
    );
  }

  const approvedStableLink = normalizedStableLink(metadataItem.stableLink);
  if (record.stableLink !== approvedStableLink) {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "The stable link does not exactly match the safe reviewed metadata reference, so it was not compiled."
    );
  }
  return { sourceTimestamp, approvedParticipantRefs, sourceLabel, stableLink: approvedStableLink };
}

function normalizeApprovedRecords(records, state) {
  return normalizeInertStagingRecords(records).map((record) => {
    const { metadataItem } = assertActiveGrantForRecord(state, record);
    return { ...record, ...validateApprovedProvenance(record, metadataItem) };
  });
}

function claimIdFor({ subjectType, subjectId, assertion, confidence }) {
  const fingerprint = JSON.stringify({ version: 1, subjectType, subjectId, assertion, confidence });
  return `claim-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 20)}`;
}

function minTimestamp(current, candidate) {
  return !current || Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function maxTimestamp(current, candidate) {
  if (!candidate) return current ?? null;
  return !current || Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function sourceReferenceId(source) {
  return `${source.source}:${source.accountId}:${source.sourceRecordId}`;
}

function compileProjections(records, language, processedAt) {
  const claims = new Map();
  const noteLabels = new Map();
  for (const record of records) {
    for (const assertion of record.assertions) {
      const noteKey = `${assertion.subjectType}\u0000${assertion.subjectId}`;
      const knownLabel = noteLabels.get(noteKey);
      if (knownLabel && knownLabel !== assertion.subjectLabel) {
        throw new KnowledgeCompilationError(
          "SUBJECT_LABEL_CONFLICT",
          "Two approved records used different labels for the same canonical subject, so I stopped instead of inventing a merge."
        );
      }
      noteLabels.set(noteKey, assertion.subjectLabel);
      const id = claimIdFor(assertion);
      let claim = claims.get(id);
      if (!claim) {
        claim = {
          id,
          subjectType: assertion.subjectType,
          subjectId: assertion.subjectId,
          subjectLabel: assertion.subjectLabel,
          assertion: assertion.assertion,
          confidence: assertion.confidence,
          observedAt: record.observedAt,
          verifiedAt: record.verifiedAt,
          privacyRestrictions: [...assertion.privacyRestrictions],
          sourceReferences: []
        };
        claims.set(id, claim);
      } else {
        claim.observedAt = minTimestamp(claim.observedAt, record.observedAt);
        claim.verifiedAt = maxTimestamp(claim.verifiedAt, record.verifiedAt);
        claim.privacyRestrictions = [...new Set([...claim.privacyRestrictions, ...assertion.privacyRestrictions])].sort();
      }
      const source = {
        source: record.source,
        accountId: record.accountId,
        sourceRecordId: record.sourceRecordId,
        reviewId: record.reviewId,
        grantId: record.grantId,
        sourceTimestamp: record.sourceTimestamp,
        approvedParticipantRefs: [...record.approvedParticipantRefs],
        sourceLabel: record.sourceLabel,
        stableLink: record.stableLink,
        processedAt
      };
      if (!claim.sourceReferences.some((reference) => sourceReferenceId(reference) === sourceReferenceId(source) && reference.reviewId === source.reviewId && reference.grantId === source.grantId)) {
        claim.sourceReferences.push(source);
      }
    }
  }
  const orderedClaims = [...claims.values()]
    .map((claim) => ({
      ...claim,
      sourceReferences: claim.sourceReferences.sort((left, right) => sourceReferenceId(left).localeCompare(sourceReferenceId(right)))
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const canonicalNotes = buildCanonicalNotes(orderedClaims, language);
  const sourceIndexes = buildSourceIndexes(orderedClaims, canonicalNotes, language);
  return { claims: orderedClaims, canonicalNotes, sourceIndexes };
}

function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_{}\[\]<>()#+|])/g, "\\$1");
}

function canonicalNotePath(subjectType, subjectId) {
  return `${SUBJECT_TYPES[subjectType].directory}/${subjectId}.md`;
}

function noteLink(notePath) {
  return `[[${notePath.slice(0, -3)}]]`;
}

function renderSourceReference(source, text) {
  const participantRefs = source.approvedParticipantRefs.length > 0
    ? source.approvedParticipantRefs.map((reference) => `\`${escapeMarkdown(reference)}\``).join(", ")
    : "—";
  const stableLink = source.stableLink
    ? `[${text.stableLink}](<${source.stableLink}>)`
    : text.noStableLink;
  return [
    `${text.sourceReference}: \`${escapeMarkdown(sourceReferenceId(source))}\` (${text.review} \`${escapeMarkdown(source.reviewId)}\`, ${text.grant} \`${escapeMarkdown(source.grantId)}\`)`,
    `${text.sourceTimestamp}: ${source.sourceTimestamp}`,
    `${text.participants}: ${participantRefs}`,
    `${text.sourceLabel}: ${escapeMarkdown(source.sourceLabel)}`,
    `${text.stableLink}: ${stableLink}`,
    `${text.processed}: ${source.processedAt}`
  ].join(" · ");
}

function buildCanonicalNotes(claims, language) {
  const text = wording(language);
  const notes = new Map();
  for (const claim of claims) {
    const key = `${claim.subjectType}\u0000${claim.subjectId}`;
    if (!notes.has(key)) {
      notes.set(key, {
        type: "canonical-subject-note",
        path: canonicalNotePath(claim.subjectType, claim.subjectId),
        subject: {
          type: claim.subjectType,
          id: claim.subjectId,
          label: claim.subjectLabel
        },
        ownership: {
          generatedSection: "qwave-generated-canonical-claims",
          userOwnedSection: "user-owned-notes"
        },
        claims: []
      });
    }
    notes.get(key).claims.push(claim);
  }
  return [...notes.values()]
    .map((note) => {
      note.claims.sort((left, right) => left.id.localeCompare(right.id));
      const typeLabel = SUBJECT_TYPES[note.subject.type][language];
      const generated = note.claims.map((claim) => {
        const value = claim.assertion === null ? text.unknown : escapeMarkdown(claim.assertion);
        const sourceRows = claim.sourceReferences
          .map((source) => `  - ${renderSourceReference(source, text)}`)
          .join("\n");
        return [
          `### ${text.claim} \`${claim.id}\``,
          "",
          value,
          "",
          `- ${text.confidence}: \`${claim.confidence}\``,
          `- ${text.observed}: ${claim.observedAt}`,
          `- ${text.verified}: ${claim.verifiedAt ?? text.notVerified}`,
          `- ${text.privacy}: ${claim.privacyRestrictions.map((restriction) => `\`${restriction}\``).join(", ")}`,
          `- ${text.sourceHeading}:`,
          sourceRows
        ].join("\n");
      }).join("\n\n");
      return {
        ...note,
        claimIds: note.claims.map((claim) => claim.id),
        content: [
          "---",
          "qwave_generated: true",
          "projection: canonical-subject-note",
          `subject_type: ${note.subject.type}`,
          `subject_id: ${note.subject.id}`,
          "---",
          "",
          `# ${escapeMarkdown(note.subject.label)}`,
          "",
          `${typeLabel} · ${text.simulated}`,
          "",
          `## ${text.generatedHeading}`,
          "",
          `> ${text.generatedBoundary}`,
          "",
          generated,
          "",
          `## ${text.yourNotesHeading}`,
          "",
          `> ${text.yourNotesBoundary}`,
          ""
        ].join("\n")
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildSourceIndexes(claims, canonicalNotes, language) {
  const text = wording(language);
  const noteBySubject = new Map(canonicalNotes.map((note) => [`${note.subject.type}\u0000${note.subject.id}`, note]));
  const indexes = new Map();
  for (const claim of claims) {
    const note = noteBySubject.get(`${claim.subjectType}\u0000${claim.subjectId}`);
    for (const source of claim.sourceReferences) {
      const key = `${source.source}\u0000${source.accountId}`;
      if (!indexes.has(key)) {
        indexes.set(key, {
          type: "source-index",
          path: `Sources/${source.source}--${source.accountId}.md`,
          source: source.source,
          accountId: source.accountId,
          entries: new Map()
        });
      }
      const index = indexes.get(key);
      const sourceKey = `${sourceReferenceId(source)}\u0000${source.reviewId}\u0000${source.grantId}`;
      if (!index.entries.has(sourceKey)) {
        index.entries.set(sourceKey, {
          sourceReferenceId: sourceReferenceId(source),
          reviewId: source.reviewId,
          grantId: source.grantId,
          sourceTimestamp: source.sourceTimestamp,
          approvedParticipantRefs: [...source.approvedParticipantRefs],
          sourceLabel: source.sourceLabel,
          stableLink: source.stableLink,
          processedAt: source.processedAt,
          canonicalNotePaths: new Set(),
          claimIds: new Set()
        });
      }
      const entry = index.entries.get(sourceKey);
      entry.canonicalNotePaths.add(note.path);
      entry.claimIds.add(claim.id);
    }
  }
  return [...indexes.values()]
    .map((index) => {
      const entries = [...index.entries.values()]
        .map((entry) => ({
          sourceReferenceId: entry.sourceReferenceId,
          reviewId: entry.reviewId,
          grantId: entry.grantId,
          sourceTimestamp: entry.sourceTimestamp,
          approvedParticipantRefs: entry.approvedParticipantRefs,
          sourceLabel: entry.sourceLabel,
          stableLink: entry.stableLink,
          processedAt: entry.processedAt,
          canonicalNotePaths: [...entry.canonicalNotePaths].sort(),
          claimIds: [...entry.claimIds].sort()
        }))
        .sort((left, right) => left.sourceReferenceId.localeCompare(right.sourceReferenceId));
      const rows = entries.map((entry) => [
        `- \`${escapeMarkdown(entry.sourceReferenceId)}\``,
        `  - ${entry.canonicalNotePaths.map(noteLink).join(", ")}`,
        `  - ${text.claimIds}: ${entry.claimIds.map((id) => `\`${id}\``).join(", ")}`,
        `  - ${text.sourceTimestamp}: ${entry.sourceTimestamp}`,
        `  - ${text.participants}: ${entry.approvedParticipantRefs.length > 0 ? entry.approvedParticipantRefs.map((reference) => `\`${escapeMarkdown(reference)}\``).join(", ") : "—"}`,
        `  - ${text.sourceLabel}: ${escapeMarkdown(entry.sourceLabel)}`,
        `  - ${text.stableLink}: ${entry.stableLink ? `[${text.stableLink}](<${entry.stableLink}>)` : text.noStableLink}`,
        `  - ${text.processed}: ${entry.processedAt}`
      ].join("\n")).join("\n");
      return {
        type: index.type,
        path: index.path,
        source: index.source,
        accountId: index.accountId,
        entries,
        content: [
          "---",
          "qwave_generated: true",
          "projection: source-index",
          `source: ${index.source}`,
          `account_id: ${index.accountId}`,
          "---",
          "",
          `# ${text.sourceIndexHeading}: ${escapeMarkdown(index.source)}`,
          "",
          `> ${text.sourceIndexBoundary}`,
          "",
          rows,
          ""
        ].join("\n")
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function compilationState(state) {
  if (!state[STATE_KEY]) state[STATE_KEY] = { version: 1, batches: {}, audit: [] };
  return state[STATE_KEY];
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state) {
    throw new KnowledgeCompilationError(
      "SETUP_SESSION_NOT_FOUND",
      "Start your private second-brain setup and approve a source scope before compiling notes."
    );
  }
  return state;
}

function rawSourceBodiesRetainedForStaging(staging) {
  return Boolean(
    staging
    && !exactCanonicalTimestamp(staging.deletedAt)
    && !exactCanonicalTimestamp(staging.rawSourceBodiesDeletedAt)
  );
}

function publicBatch(entry, language) {
  const text = wording(language);
  const cleanupNeedsAttention = Boolean(entry.staging?.cleanupNeedsAttention);
  const cleanupAuthorityRequired = entry.staging?.cleanupNeedsAttention === "STAGING_AUTHORITATIVE_CLEANUP_REQUIRED";
  const rawSourceBodiesRetained = rawSourceBodiesRetainedForStaging(entry.staging);
  const cleanupFinalizationNeedsAttention = cleanupNeedsAttention && !rawSourceBodiesRetained;
  const base = {
    batchId: entry.batchId,
    status: entry.status,
    simulated: true,
    live: false,
    rawSourceBodiesRetained,
    staging: entry.staging ? {
      createdAt: entry.staging.createdAt,
      expiresAt: entry.staging.expiresAt,
      retention: entry.staging.retention,
      status: entry.staging.status ?? "available",
      cause: entry.staging.cleanupCause ?? null,
      deletedAt: entry.staging.deletedAt ?? null,
      rawSourceBodiesDeletedAt: exactCanonicalTimestamp(entry.staging.rawSourceBodiesDeletedAt) ?? null,
      needsAttention: cleanupNeedsAttention
    } : null
  };
  if (entry.status === "compiled") {
    const cleanupPending = entry.staging?.status === "result-persisted-pending-deletion";
    return {
      ...base,
      retryable: cleanupPending,
      needsAttention: cleanupNeedsAttention,
      message: cleanupAuthorityRequired
        ? text.cleanupAuthorityRequired
        : cleanupFinalizationNeedsAttention
        ? text.cleanupFinalizationNeedsAttention
        : cleanupNeedsAttention
        ? text.cleanupNeedsAttention
        : cleanupPending
        ? text.compiledCleanupPending
        : text.ready,
      completedAt: entry.completedAt,
      canonicalNoteCount: entry.result.canonicalNotes.length,
      sourceIndexCount: entry.result.sourceIndexes.length,
      claimCount: entry.result.claims.length
    };
  }
  if (entry.status === "expired") {
    const cleanupPending = entry.staging?.status === "expired-pending-deletion";
    return {
      ...base,
      retryable: cleanupPending,
      needsAttention: cleanupNeedsAttention,
      message: cleanupAuthorityRequired
        ? text.cleanupAuthorityRequired
        : cleanupFinalizationNeedsAttention
        ? text.cleanupFinalizationNeedsAttention
        : cleanupNeedsAttention
        ? text.cleanupNeedsAttention
        : cleanupPending
        ? text.expiredCleanupPending
        : text.expired
    };
  }
  if (entry.status === "discarded") {
    return {
      ...base,
      retryable: entry.staging?.status === "discarded-pending-deletion",
      needsAttention: cleanupNeedsAttention,
      message: cleanupAuthorityRequired
        ? text.cleanupAuthorityRequired
        : cleanupFinalizationNeedsAttention
        ? text.cleanupFinalizationNeedsAttention
        : cleanupNeedsAttention
        ? text.cleanupNeedsAttention
        : entry.staging?.status === "discarded-pending-deletion"
        ? text.discardedCleanupPending
        : text.discarded
    };
  }
  if (cleanupNeedsAttention) {
    return {
      ...base,
      retryable: true,
      needsAttention: true,
      message: cleanupAuthorityRequired
        ? text.cleanupAuthorityRequired
        : cleanupFinalizationNeedsAttention
        ? text.cleanupFinalizationNeedsAttention
        : text.cleanupNeedsAttention
    };
  }
  return { ...base, retryable: true, message: text.interrupted };
}

function compiledResponse(entry, language) {
  return {
    compilation: publicBatch(entry, language),
    claims: clone(entry.result.claims),
    canonicalNotes: clone(entry.result.canonicalNotes),
    sourceIndexes: clone(entry.result.sourceIndexes),
    limitation: wording(language).simulated
  };
}

function safeFailureCode(error) {
  return error instanceof KnowledgeCompilationError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : "TEMPORARY_STAGING_UNAVAILABLE";
}

function cleanupNeedsLocalAttention(error) {
  return error instanceof KnowledgeCompilationError && [
    "STAGING_HARDLINK_BLOCKED",
    "STAGING_MULTIPLE_LINKS_NEEDS_ATTENTION",
    "STAGING_FILE_IDENTITY_CHANGED"
  ].includes(error.code);
}

const INTRINSIC_STAGING_VALIDATION_CODES = new Set([
  "STAGING_BATCH_INVALID",
  "STAGING_PAYLOAD_INVALID",
  "STAGING_LEASE_INVALID",
  "STAGING_TIMESTAMP_INVALID",
  "STAGING_PAYLOAD_TOO_DEEP",
  "STAGING_SIZE_LIMIT",
  "STAGING_SYMLINK_BLOCKED",
  "RAW_SOURCE_FIELD_BLOCKED",
  "NORMALIZED_RECORD_INVALID",
  "NORMALIZED_TEXT_INVALID",
  "NORMALIZED_TEXT_UNSAFE",
  "SOURCE_REFERENCE_INVALID",
  "ACCOUNT_REFERENCE_INVALID",
  "REVIEW_REFERENCE_INVALID",
  "GRANT_REFERENCE_INVALID",
  "UNTRUSTED_DISPOSITION_REQUIRED",
  "SOURCE_TIMESTAMP_REQUIRED",
  "SOURCE_PROVENANCE_INVALID",
  "DUPLICATE_SOURCE_RECORD",
  "VERIFICATION_DATE_INVALID",
  "ASSERTIONS_REQUIRED",
  "SUBJECT_TYPE_INVALID",
  "SUBJECT_ID_INVALID",
  "CONFIDENCE_INVALID",
  "UNKNOWN_CONFIDENCE_INVALID",
  "PRIVACY_RESTRICTION_REQUIRED",
  "PRIVACY_RESTRICTION_INVALID",
  "SUBJECT_LABEL_CONFLICT"
]);

function isIntrinsicRetentionArtifactError(error) {
  return error instanceof SyntaxError || error instanceof UnsafeRetentionArtifactError;
}

function isIntrinsicStagingValidationError(error) {
  return error instanceof KnowledgeCompilationError && INTRINSIC_STAGING_VALIDATION_CODES.has(error.code);
}

function unverifiedCleanupFailureReason(error) {
  // Exact verified absence can be reconciled from the generation-bound
  // tombstone even when the optional receipt write was interrupted.
  if (error instanceof KnowledgeCompilationError && error.code === "STAGING_DELETE_RECEIPT_PENDING") return null;
  return error instanceof KnowledgeCompilationError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : "STAGING_DELETE_FAILED";
}

function stagingAfterCleanupSuccess(staging, status, deletedAt, { cleanupCause = null } = {}) {
  if (!staging) return null;
  const { cleanupNeedsAttention: _cleanupNeedsAttention, ...withoutAttention } = staging;
  const rawSourceBodiesDeletedAt = exactCanonicalTimestamp(staging.rawSourceBodiesDeletedAt)
    ?? exactCanonicalTimestamp(deletedAt);
  const next = { ...withoutAttention, status, deletedAt, rawSourceBodiesDeletedAt };
  if (cleanupCause) next.cleanupCause = boundedCleanupReason(cleanupCause);
  else delete next.cleanupCause;
  return next;
}

function shouldDiscardAfterFailure(error) {
  return new Set([
    "ACTIVE_GRANT_REQUIRED",
    "PERSISTED_GRANT_INVALID",
    "RECORD_OUTSIDE_APPROVED_SCOPE",
    "STAGING_BATCH_INVALID",
    "STAGING_PAYLOAD_INVALID",
    "STAGING_BATCH_MISSING",
    "STAGING_TIMESTAMP_INVALID",
    "STAGING_PAYLOAD_TOO_DEEP",
    "STAGING_SIZE_LIMIT",
    "STAGING_SYMLINK_BLOCKED",
    "RAW_SOURCE_FIELD_BLOCKED",
    "NORMALIZED_RECORD_INVALID",
    "NORMALIZED_TEXT_INVALID",
    "NORMALIZED_TEXT_UNSAFE",
    "SOURCE_REFERENCE_INVALID",
    "ACCOUNT_REFERENCE_INVALID",
    "REVIEW_REFERENCE_INVALID",
    "GRANT_REFERENCE_INVALID",
    "UNTRUSTED_DISPOSITION_REQUIRED",
    "SOURCE_TIMESTAMP_REQUIRED",
    "SOURCE_PROVENANCE_INVALID",
    "DUPLICATE_SOURCE_RECORD",
    "VERIFICATION_DATE_INVALID",
    "ASSERTIONS_REQUIRED",
    "SUBJECT_TYPE_INVALID",
    "SUBJECT_ID_INVALID",
    "CONFIDENCE_INVALID",
    "UNKNOWN_CONFIDENCE_INVALID",
    "PRIVACY_RESTRICTION_REQUIRED",
    "PRIVACY_RESTRICTION_INVALID",
    "SUBJECT_LABEL_CONFLICT"
  ]).has(safeFailureCode(error));
}

function stagingReceiptFromBatch(staged) {
  return {
    batchId: staged.batchId,
    leaseId: staged.leaseId,
    createdAt: staged.createdAt,
    expiresAt: staged.expiresAt,
    retention: "delete-after-compilation-or-within-24-hours"
  };
}

function expiredBatchEntry({ batchId, now, language, staged = null }) {
  return {
    batchId,
    status: "expired",
    language,
    createdAt: staged?.createdAt ?? null,
    staging: {
      ...(staged ? stagingReceiptFromBatch(staged) : {}),
      status: "expired-pending-deletion",
      deletedAt: null
    },
    audit: [{ type: "temporary-staging-expired", at: now, recoveredWithoutPersistedState: staged !== null }]
  };
}

function discardedBatchEntry({
  batchId,
  now,
  language,
  staged = null,
  reason,
  deletionCompleted = false,
  stagingStatus = null,
  cleanupCause = null
}) {
  return {
    batchId,
    status: "discarded",
    language,
    createdAt: staged?.createdAt ?? null,
    staging: {
      ...(staged ? stagingReceiptFromBatch(staged) : {}),
      status: deletionCompleted ? (stagingStatus ?? "discarded") : "discarded-pending-deletion",
      deletedAt: deletionCompleted ? now : null,
      rawSourceBodiesDeletedAt: deletionCompleted ? now : null,
      ...(cleanupCause ? { cleanupCause: boundedCleanupReason(cleanupCause) } : {})
    },
    audit: [{ type: "temporary-batch-discarded", at: now, reason, recoveredWithoutPersistedState: staged !== null }]
  };
}

async function recoverUntrackedStagedBatch({ staging, batchId, state, expectedRecords, now }) {
  let staged;
  try {
    staged = await staging.read({ batchId });
  } catch (error) {
    if (error instanceof KnowledgeCompilationError && error.code === "STAGING_BATCH_MISSING") return null;
    throw error;
  }
  if (Date.parse(staged.expiresAt) <= Date.parse(now)) {
    return { expired: true, staged };
  }
  let records;
  try {
    records = normalizeApprovedRecords(staged.records, state);
  } catch (error) {
    if (!shouldDiscardAfterFailure(error)) throw error;
    return { discarded: true, staged, error, deletionCompleted: false };
  }
  if (expectedRecords && JSON.stringify(records) !== JSON.stringify(expectedRecords)) {
    throw new KnowledgeCompilationError(
      "STAGING_BATCH_COLLISION",
      "That protected batch ID already belongs to different approved references. Choose a new opaque batch ID instead of replacing it."
    );
  }
  return { expired: false, staged, records, receipt: stagingReceiptFromBatch(staged) };
}

function cleanupResultKey(result) {
  return `${result?.batchId ?? ""}\u0000${result?.generationTag ?? ""}\u0000${result?.leaseId ?? ""}`;
}

function cleanupResultMatchesPersistedGeneration(entry, result, { allowTagOnly = false } = {}) {
  const persistedLeaseId = entry?.staging?.leaseId;
  if (typeof persistedLeaseId !== "string" || !OPAQUE_ID.test(persistedLeaseId)) return false;
  const expectedGenerationTag = generationTagForLease(persistedLeaseId);
  if (result?.leaseId === persistedLeaseId) {
    // The local staging cleanup result historically returned the exact durable
    // lease without a generation tag. Preserve that compatible, exact binding
    // inside the authority-captured engine. If a newer result also supplies a
    // tag, require both identities to agree.
    return result.generationTag === undefined
      || (
        typeof result.generationTag === "string"
        && GENERATION_TAG.test(result.generationTag)
        && result.generationTag === expectedGenerationTag
      );
  }
  // Filename-derived evidence is sufficient to route a bounded needs-attention
  // result to the tracked generation, but it is never terminal deletion
  // authority. Only the exact persisted lease can finalize lifecycle truth.
  return allowTagOnly
    && result?.leaseId === null
    && typeof result.generationTag === "string"
    && GENERATION_TAG.test(result.generationTag)
    && result.generationTag === expectedGenerationTag;
}

async function persistedGenerationIsReadableNow({
  staging,
  entry,
  batchId,
  integrityFailureMeansReadable = true
}) {
  const leaseId = entry?.staging?.leaseId;
  if (typeof leaseId !== "string" || !OPAQUE_ID.test(leaseId)) return false;
  try {
    const current = await staging.read({ batchId, leaseId });
    return current?.leaseId === leaseId;
  } catch (error) {
    if (error instanceof KnowledgeCompilationError && error.code === "STAGING_BATCH_MISSING") return false;
    // An absent lease is generation-bound evidence that the staged bytes are
    // not presently readable, but it is not deletion proof by itself. The
    // caller must still reconcile the exact cleanup result or surface local
    // attention. Integrity failures are likewise never terminal deletion
    // evidence: removal/receipt loops treat them as still readable, while the
    // dedicated attention loop may record the exact bounded reason.
    if (error?.code === "ENOENT") return false;
    if (cleanupNeedsLocalAttention(error)) return integrityFailureMeansReadable;
    throw error;
  }
}

async function refreshRawDeletionEvidence({ entry, staging, batchId }) {
  if (
    !entry?.staging
    || exactCanonicalTimestamp(entry.staging.rawSourceBodiesDeletedAt)
    || typeof entry.staging.leaseId !== "string"
    || typeof staging?.rawDeletionEvidence !== "function"
  ) return false;
  try {
    const evidence = await staging.rawDeletionEvidence({
      batchId,
      leaseId: entry.staging.leaseId
    });
    const rawSourceBodiesDeletedAt = exactCanonicalTimestamp(evidence?.rawSourceBodiesDeletedAt);
    if (!rawSourceBodiesDeletedAt) return false;
    entry.staging = { ...entry.staging, rawSourceBodiesDeletedAt };
    return true;
  } catch {
    // This marker is optional, monotonic evidence. Any readback uncertainty
    // leaves the public projection conservative until a later locked retry.
    return false;
  }
}

async function markExpiredBatches({ lifecycle, staging, now }) {
  const cleaned = await staging.cleanupExpired({ now });
  const removals = Array.isArray(cleaned.removedBatches)
    ? cleaned.removedBatches
    : (cleaned.removedBatchIds ?? []).map((batchId) => ({ batchId, leaseId: null, reason: "unknown-cleanup" }));
  const unavailable = new Set((cleaned.retentionCoverageUnavailableBatches ?? [])
    .map(cleanupResultKey));
  const acknowledgements = [];
  const verifiedCleanupKeys = new Set();
  const tagOnlyCleanupNeedsAttentionBatches = [];
  let changed = false;
  for (const [batchId, entry] of Object.entries(lifecycle.batches)) {
    if (await refreshRawDeletionEvidence({ entry, staging, batchId })) changed = true;
  }
  for (const removal of removals) {
    const { batchId } = removal;
    const entry = lifecycle.batches[batchId];
    const cleanupReason = unavailable.has(cleanupResultKey(removal))
      ? "retention-unavailable"
      : boundedCleanupReason(removal.reason);
    // Untracked or stale generations can be reported for local attention, but
    // they can never alter or clear a persisted lifecycle generation sharing
    // the same public batch ID.
    if (entry && !cleanupResultMatchesPersistedGeneration(entry, removal)) {
      // A genuinely untracked, ownerless artifact can be removed using its
      // filename-derived generation tag. That bounded evidence is still not
      // exact deletion authority for a persisted lifecycle generation. If it
      // addresses the tracked tag, preserve conservative public truth and
      // route the exact persisted lease to needs-attention instead of leaving
      // a now-absent batch looking resumable or accepting truncated-tag truth.
      if (cleanupResultMatchesPersistedGeneration(entry, removal, { allowTagOnly: true })) {
        tagOnlyCleanupNeedsAttentionBatches.push({
          batchId,
          generationTag: removal.generationTag,
          leaseId: null,
          reason: "STAGING_CLEANUP_EVIDENCE_REQUIRED"
        });
      }
      continue;
    }
    // Cleanup scans and durable lifecycle reconciliation are separate I/O
    // boundaries. An exact generation can be restored after a scan produced
    // removal evidence but before this locked lifecycle mutation. Re-read the
    // persisted lease now so stale evidence cannot create ghost deletion truth.
    if (entry && await persistedGenerationIsReadableNow({ staging, entry, batchId })) continue;
    const matchedLeaseId = entry?.staging?.leaseId ?? null;
    if (entry) verifiedCleanupKeys.add(`${batchId}\u0000${matchedLeaseId}`);
    if (entry?.status === "staged" && cleanupReason === "expired") {
      entry.status = "expired";
      entry.staging = stagingAfterCleanupSuccess(entry.staging, "expired-deleted", now);
      entry.audit.push({ type: "temporary-staging-expired", at: now });
      lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId });
      changed = true;
    } else if (entry?.status === "staged") {
      entry.status = "discarded";
      entry.staging = stagingAfterCleanupSuccess(
        entry.staging,
        discardedCleanupStatus(cleanupReason),
        now,
        { cleanupCause: cleanupReason }
      );
      entry.audit.push({ type: "temporary-batch-discarded", at: now, reason: cleanupReason });
      lifecycle.audit.push({ type: "temporary-batch-discarded", at: now, batchId, reason: cleanupReason });
      changed = true;
    } else if (entry?.status === "compiled" && entry.staging?.status === "result-persisted-pending-deletion") {
      // The compiled projection was already durable before the retention
      // service removed its input. Preserve that result and accurately record
      // cleanup rather than misclassifying it as an expired compilation.
      entry.staging = stagingAfterCleanupSuccess(entry.staging, "deleted-after-compilation", now);
      entry.audit.push({ type: "temporary-staging-deleted-after-result-persistence", at: now, by: "retention-service" });
      lifecycle.audit.push({ type: "temporary-staging-deleted-after-result-persistence", at: now, batchId, by: "retention-service" });
      changed = true;
    } else if (entry?.status === "discarded" && entry.staging?.status === "discarded-pending-deletion") {
      entry.staging = stagingAfterCleanupSuccess(entry.staging, "discarded", now);
      entry.audit.push({ type: "temporary-discarded-staging-deleted", at: now, by: "retention-service" });
      changed = true;
    } else if (entry?.status === "expired" && entry.staging?.status === "expired-pending-deletion") {
      entry.staging = stagingAfterCleanupSuccess(entry.staging, "expired-deleted", now);
      entry.audit.push({ type: "temporary-expired-staging-deleted", at: now, by: "retention-service" });
      lifecycle.audit.push({ type: "temporary-expired-staging-deleted", at: now, batchId, by: "retention-service" });
      changed = true;
    } else if (entry?.staging?.cleanupNeedsAttention) {
      entry.staging = stagingAfterCleanupSuccess(entry.staging, entry.staging.status, entry.staging.deletedAt ?? now);
      changed = true;
    } else if (!entry) {
      // A process may have staged the file successfully but crashed before its
      // state save. Without an exact durable lifecycle lease binding, even an
      // expiry cleanup is a discard rather than evidence that this public
      // batch expired. Keep a path-free tombstone so its ID cannot be revived.
      const cause = cleanupReason === "expired" ? "unknown-cleanup" : cleanupReason;
      lifecycle.batches[batchId] = discardedBatchEntry({
        batchId,
        now,
        language: "en",
        reason: cause,
        deletionCompleted: true,
        stagingStatus: discardedCleanupStatus(cleanupReason, { tracked: false }),
        cleanupCause: cause
      });
      lifecycle.audit.push({
        type: "temporary-batch-discarded",
        at: now,
        batchId,
        reason: cause,
        recoveredWithoutPersistedState: true
      });
      changed = true;
    }
  }

  for (const completion of cleaned.completionReceipts ?? []) {
    const { batchId, leaseId } = completion;
    const entry = lifecycle.batches[batchId];
    // A receipt/tombstone is accepted only for the exact durable lifecycle
    // generation. A stale or forged generation can remain inert for owner
    // inspection, but it cannot change public deletion truth.
    if (entry?.staging?.leaseId !== leaseId) continue;
    if (await persistedGenerationIsReadableNow({ staging, entry, batchId })) continue;
    verifiedCleanupKeys.add(`${batchId}\u0000${leaseId}`);
    const by = completion.source === "receipt" ? "retention-worker" : "durable-retention-tombstone";
    // A tombstone records when deletion began, not when absence became known.
    // When its exact generation paths are now verified absent, record this
    // reconciliation time rather than misreporting the earlier attempt time as
    // a deletion receipt.
    const confirmedDeletedAt = completion.deletedAt ?? now;
    if (entry.status === "compiled" && entry.staging.status === "result-persisted-pending-deletion") {
      entry.staging = stagingAfterCleanupSuccess(entry.staging, "deleted-after-compilation", confirmedDeletedAt);
      entry.audit.push({ type: "temporary-staging-deletion-receipt-consumed", at: now, by });
      lifecycle.audit.push({ type: "temporary-staging-deletion-receipt-consumed", at: now, batchId, by });
      changed = true;
    } else if (entry.status === "discarded" && entry.staging.status === "discarded-pending-deletion") {
      entry.staging = stagingAfterCleanupSuccess(entry.staging, "discarded", confirmedDeletedAt);
      entry.audit.push({ type: "temporary-discarded-staging-deletion-receipt-consumed", at: now, by });
      changed = true;
    } else if (entry.status === "expired" && entry.staging.status === "expired-pending-deletion") {
      entry.staging = stagingAfterCleanupSuccess(entry.staging, "expired-deleted", confirmedDeletedAt);
      entry.audit.push({ type: "temporary-expired-staging-deletion-receipt-consumed", at: now, by });
      lifecycle.audit.push({ type: "temporary-expired-staging-deletion-receipt-consumed", at: now, batchId, by });
      changed = true;
    } else if (entry.status === "staged" && completion.reason === "expired") {
      entry.status = "expired";
      entry.staging = stagingAfterCleanupSuccess(entry.staging, "expired-deleted", confirmedDeletedAt);
      entry.audit.push({ type: "temporary-staging-expired", at: now, by });
      lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId, by });
      changed = true;
    } else if (entry.status === "staged") {
      const cleanupReason = boundedCleanupReason(completion.reason);
      entry.status = "discarded";
      entry.staging = stagingAfterCleanupSuccess(
        entry.staging,
        discardedCleanupStatus(cleanupReason),
        confirmedDeletedAt,
        { cleanupCause: cleanupReason }
      );
      entry.audit.push({ type: "temporary-batch-discarded", at: now, reason: cleanupReason, by });
      lifecycle.audit.push({ type: "temporary-batch-discarded", at: now, batchId, reason: cleanupReason, by });
      changed = true;
    } else if (entry.staging.cleanupNeedsAttention) {
      entry.staging = stagingAfterCleanupSuccess(entry.staging, entry.staging.status, entry.staging.deletedAt ?? confirmedDeletedAt);
      changed = true;
    }
    acknowledgements.push({ batchId, leaseId });
  }

  const cleanupNeedsAttentionBatches = [
    ...(cleaned.cleanupNeedsAttentionBatches ?? []),
    ...tagOnlyCleanupNeedsAttentionBatches
  ];
  for (const attention of cleanupNeedsAttentionBatches) {
    const { batchId, reason } = attention;
    const entry = lifecycle.batches[batchId];
    if (!cleanupResultMatchesPersistedGeneration(entry, attention, { allowTagOnly: true })) continue;
    if (await persistedGenerationIsReadableNow({
      staging,
      entry,
      batchId,
      integrityFailureMeansReadable: false
    })) continue;
    const leaseId = entry.staging.leaseId;
    if (verifiedCleanupKeys.has(`${batchId}\u0000${leaseId}`)) continue;
    const desiredStatus = entry.status === "staged" ? "cleanup-needs-attention" : entry.staging.status;
    if (entry.staging.cleanupNeedsAttention !== reason || entry.staging.status !== desiredStatus) {
      entry.staging = {
        ...entry.staging,
        status: desiredStatus,
        deletedAt: null,
        cleanupNeedsAttention: reason
      };
      changed = true;
    }
    const alreadyAudited = entry.audit.some((event) => (
      event.type === "temporary-staging-cleanup-needs-attention"
      && event.leaseId === leaseId
      && event.reason === reason
    ));
    if (!alreadyAudited) {
      entry.audit.push({ type: "temporary-staging-cleanup-needs-attention", at: now, leaseId, reason });
      lifecycle.audit.push({ type: "temporary-staging-cleanup-needs-attention", at: now, batchId, leaseId, reason });
      changed = true;
    }
  }
  return {
    changed,
    acknowledgements,
    cleanupNeedsAttentionBatches
  };
}

function markCleanupAuthorityRequired({ lifecycle, now }) {
  const reason = "STAGING_AUTHORITATIVE_CLEANUP_REQUIRED";
  const cleanupNeedsAttentionBatches = [];
  let changed = false;

  for (const entry of Object.values(lifecycle.batches)) {
    if (!entry?.staging || entry.staging.deletedAt) continue;
    if (
      entry.status === "staged"
      && Number.isFinite(Date.parse(entry.staging.expiresAt))
      && Date.parse(entry.staging.expiresAt) <= Date.parse(now)
    ) {
      entry.status = "expired";
      entry.staging = {
        ...entry.staging,
        status: "expired-pending-deletion",
        deletedAt: null
      };
      if (!entry.audit.some((event) => event.type === "temporary-staging-expired")) {
        entry.audit.push({ type: "temporary-staging-expired", at: now, deletionConfirmed: false });
        lifecycle.audit.push({
          type: "temporary-staging-expired",
          at: now,
          batchId: entry.batchId,
          deletionConfirmed: false
        });
      }
      changed = true;
    }

    const cleanupPending = (
      entry.status === "compiled"
      && entry.staging.status === "result-persisted-pending-deletion"
    ) || (
      entry.status === "discarded"
      && entry.staging.status === "discarded-pending-deletion"
    ) || (
      entry.status === "expired"
      && entry.staging.status === "expired-pending-deletion"
    );
    if (!cleanupPending) continue;

    cleanupNeedsAttentionBatches.push({
      batchId: entry.batchId,
      leaseId: entry.staging.leaseId ?? null,
      reason
    });
    if (!entry.staging.cleanupNeedsAttention) {
      entry.staging = { ...entry.staging, cleanupNeedsAttention: reason };
      changed = true;
    }
    const alreadyAudited = entry.audit.some((event) => (
      event.type === "temporary-staging-cleanup-authority-required"
      && event.leaseId === (entry.staging.leaseId ?? null)
    ));
    if (!alreadyAudited) {
      entry.audit.push({
        type: "temporary-staging-cleanup-authority-required",
        at: now,
        leaseId: entry.staging.leaseId ?? null,
        reason
      });
      lifecycle.audit.push({
        type: "temporary-staging-cleanup-authority-required",
        at: now,
        batchId: entry.batchId,
        leaseId: entry.staging.leaseId ?? null,
        reason
      });
      changed = true;
    }
  }

  return { changed, acknowledgements: [], cleanupNeedsAttentionBatches };
}

async function reconcileKnowledgeCleanup({ state, lifecycle, stateStore, staging, now }) {
  const reconciliation = isTrustedLocalStagingFacade(staging)
    ? await markExpiredBatches({ lifecycle, staging, now })
    : markCleanupAuthorityRequired({ lifecycle, now });
  if (reconciliation.changed) await stateStore.save(state);
  for (const acknowledgement of reconciliation.acknowledgements) {
    try { await acknowledgeVerifiedCleanup(staging, acknowledgement); } catch {}
  }
  return reconciliation;
}

function resultFingerprint(result) {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

function compiledResultWasPersisted(entry, expectedFingerprint) {
  return entry?.status === "compiled"
    && entry?.result
    && resultFingerprint(entry.result) === expectedFingerprint;
}

async function deferCleanupWithoutLocalAuthority({ state, lifecycle, stateStore, staging, now }) {
  if (isTrustedLocalStagingFacade(staging)) return false;
  const reconciliation = markCleanupAuthorityRequired({ lifecycle, now });
  if (reconciliation.changed) await stateStore.save(state);
  return true;
}

async function finalizePersistedCompilationCleanup({ state, lifecycle, entry, stateStore, staging, batchId, now }) {
  if (entry?.status !== "compiled" || entry.staging?.status !== "result-persisted-pending-deletion") return false;
  if (await deferCleanupWithoutLocalAuthority({ state, lifecycle, stateStore, staging, now })) return false;
  const leaseId = entry.staging.leaseId;
  try {
    const deleted = await staging.delete({ batchId, leaseId, reason: "compiled" });
    if (deleted !== true) return false;
  } catch (error) {
    // The result is already durable. Keep the private staging receipt marked
    // pending so a later resume or the independently armed expiry worker can
    // complete deletion without losing the compiled projection.
    let stateChanged = await refreshRawDeletionEvidence({ entry, staging, batchId });
    if (cleanupNeedsLocalAttention(error)) {
      entry.staging = { ...entry.staging, cleanupNeedsAttention: "filesystem-generation-integrity" };
      if (!entry.audit.some((event) => event.type === "temporary-staging-cleanup-needs-attention" && event.at === now)) {
        entry.audit.push({ type: "temporary-staging-cleanup-needs-attention", at: now, reason: error.code });
        lifecycle.audit.push({ type: "temporary-staging-cleanup-needs-attention", at: now, batchId, reason: error.code });
      }
      stateChanged = true;
    }
    if (stateChanged) try { await stateStore.save(state); } catch {}
    return false;
  }

  const previousStaging = clone(entry.staging);
  const previousAuditLength = entry.audit.length;
  const previousLifecycleAuditLength = lifecycle.audit.length;
  entry.staging = stagingAfterCleanupSuccess(entry.staging, "deleted-after-compilation", now);
  entry.audit.push({ type: "temporary-staging-deleted-after-result-persistence", at: now, by: "compiler" });
  lifecycle.audit.push({ type: "temporary-staging-deleted-after-result-persistence", at: now, batchId, by: "compiler" });
  try {
    await stateStore.save(state);
    try { await acknowledgeVerifiedCleanup(staging, { batchId, leaseId }); } catch {}
    return true;
  } catch {
    // Do not report a deletion receipt that was not durably recorded. The
    // source batch is already gone, and the prior durable compiled result will
    // reattempt this bookkeeping safely on a later read or resume.
    entry.staging = previousStaging;
    entry.audit.length = previousAuditLength;
    lifecycle.audit.length = previousLifecycleAuditLength;
    if (await refreshRawDeletionEvidence({ entry, staging, batchId })) {
      try { await stateStore.save(state); } catch {}
    }
    return false;
  }
}

async function finalizeDiscardedCleanup({ state, lifecycle, entry, stateStore, staging, batchId, now }) {
  if (entry?.status !== "discarded" || entry.staging?.status !== "discarded-pending-deletion") return false;
  if (await deferCleanupWithoutLocalAuthority({ state, lifecycle, stateStore, staging, now })) return false;
  const leaseId = entry.staging.leaseId;
  try {
    const deleted = await staging.delete({ batchId, leaseId, reason: "discarded" });
    if (deleted !== true) return false;
  } catch (error) {
    let stateChanged = await refreshRawDeletionEvidence({ entry, staging, batchId });
    if (cleanupNeedsLocalAttention(error)) {
      entry.staging = { ...entry.staging, cleanupNeedsAttention: "filesystem-generation-integrity" };
      if (!entry.audit.some((event) => event.type === "temporary-discarded-staging-cleanup-needs-attention" && event.at === now)) {
        entry.audit.push({ type: "temporary-discarded-staging-cleanup-needs-attention", at: now, reason: error.code });
        lifecycle.audit.push({ type: "temporary-discarded-staging-cleanup-needs-attention", at: now, batchId, reason: error.code });
      }
      stateChanged = true;
    }
    if (stateChanged) try { await stateStore.save(state); } catch {}
    return false;
  }
  const previousStaging = clone(entry.staging);
  const previousAuditLength = entry.audit.length;
  const previousLifecycleAuditLength = lifecycle.audit.length;
  entry.staging = stagingAfterCleanupSuccess(entry.staging, "discarded", now);
  entry.audit.push({ type: "temporary-discarded-staging-deleted", at: now, by: "compiler-resume" });
  lifecycle.audit.push({ type: "temporary-discarded-staging-deleted", at: now, batchId, by: "compiler-resume" });
  try {
    await stateStore.save(state);
    try { await acknowledgeVerifiedCleanup(staging, { batchId, leaseId }); } catch {}
    return true;
  } catch {
    entry.staging = previousStaging;
    entry.audit.length = previousAuditLength;
    lifecycle.audit.length = previousLifecycleAuditLength;
    if (await refreshRawDeletionEvidence({ entry, staging, batchId })) {
      try { await stateStore.save(state); } catch {}
    }
    return false;
  }
}

async function finalizeExpiredCleanup({ state, lifecycle, entry, stateStore, staging, batchId, now }) {
  if (entry?.status !== "expired" || entry.staging?.status !== "expired-pending-deletion") return false;
  if (await deferCleanupWithoutLocalAuthority({ state, lifecycle, stateStore, staging, now })) return false;
  const leaseId = entry.staging.leaseId;
  try {
    const deleted = await staging.delete({ batchId, leaseId, reason: "expired" });
    if (deleted !== true) return false;
  } catch (error) {
    let stateChanged = await refreshRawDeletionEvidence({ entry, staging, batchId });
    if (cleanupNeedsLocalAttention(error)) {
      entry.staging = { ...entry.staging, cleanupNeedsAttention: "filesystem-generation-integrity" };
      if (!entry.audit.some((event) => event.type === "temporary-expired-staging-cleanup-needs-attention" && event.at === now)) {
        entry.audit.push({ type: "temporary-expired-staging-cleanup-needs-attention", at: now, reason: error.code });
        lifecycle.audit.push({ type: "temporary-expired-staging-cleanup-needs-attention", at: now, batchId, reason: error.code });
      }
      stateChanged = true;
    }
    if (stateChanged) try { await stateStore.save(state); } catch {}
    return false;
  }
  const previousStaging = clone(entry.staging);
  const previousAuditLength = entry.audit.length;
  const previousLifecycleAuditLength = lifecycle.audit.length;
  entry.staging = stagingAfterCleanupSuccess(entry.staging, "expired-deleted", now);
  entry.audit.push({ type: "temporary-expired-staging-deleted", at: now, by: "compiler-resume" });
  lifecycle.audit.push({ type: "temporary-expired-staging-deleted", at: now, batchId, by: "compiler-resume" });
  try {
    await stateStore.save(state);
    try { await acknowledgeVerifiedCleanup(staging, { batchId, leaseId }); } catch {}
    return true;
  } catch {
    entry.staging = previousStaging;
    entry.audit.length = previousAuditLength;
    lifecycle.audit.length = previousLifecycleAuditLength;
    if (await refreshRawDeletionEvidence({ entry, staging, batchId })) {
      try { await stateStore.save(state); } catch {}
    }
    return false;
  }
}

function cleanupOnlyResponse(entry, language) {
  const compilation = publicBatch(entry, language);
  return {
    compilation,
    cleanup: {
      completed: !compilation.retryable,
      retryable: compilation.retryable
    },
    limitation: wording(language).simulated
  };
}

async function persistCompiledResultBeforeDeleting({ stateStore, state, lifecycle, entry, batchId, result, now }) {
  const stagedEntry = clone(entry);
  const fingerprint = resultFingerprint(result);
  entry.status = "compiled";
  entry.completedAt = now;
  entry.staging = entry.staging ? {
    ...entry.staging,
    status: "result-persisted-pending-deletion",
    resultPersistedAt: now
  } : null;
  entry.result = result;
  entry.audit.push({
    type: "canonical-result-persisted",
    at: now,
    claimCount: result.claims.length,
    canonicalNoteCount: result.canonicalNotes.length,
    sourceIndexCount: result.sourceIndexes.length,
    temporaryBatchDeleted: false
  });
  lifecycle.audit.push({ type: "canonical-result-persisted", at: now, batchId, claimCount: result.claims.length });

  try {
    await stateStore.save(state);
  } catch {
    const persistedState = await stateStore.load().catch(() => null);
    const persistedEntry = persistedState?.[STATE_KEY]?.batches?.[batchId];
    if (compiledResultWasPersisted(persistedEntry, fingerprint)) {
      return {
        persisted: true,
        state: persistedState,
        lifecycle: persistedState[STATE_KEY],
        entry: persistedEntry
      };
    }
    return { persisted: false, stagedEntry };
  }

  const persistedState = await stateStore.load().catch(() => null);
  const persistedEntry = persistedState?.[STATE_KEY]?.batches?.[batchId];
  if (!compiledResultWasPersisted(persistedEntry, fingerprint)) {
    return { persisted: false, stagedEntry };
  }
  return {
    persisted: true,
    state: persistedState,
    lifecycle: persistedState[STATE_KEY],
    entry: persistedEntry
  };
}

function assertStagingAdapter(staging) {
  if (
    !staging
    || typeof staging.stage !== "function"
    || typeof staging.read !== "function"
    || typeof staging.delete !== "function"
    || typeof staging.cleanupExpired !== "function"
  ) {
    throw new TypeError("A bounded temporary staging adapter with stage(), read(), delete(), and cleanupExpired() is required.");
  }
}

/**
 * Compile one approved, bounded batch. First use stages the normalized records;
 * a later call with the same batch ID and no records safely resumes after a
 * temporary failure. The caller never receives a staging path or raw batch.
 */
export async function compileApprovedRecords(input) {
  const trustedStateStore = trustedFileStateStoreFacade(input?.stateStore);
  const operationStateStore = trustedStateStore ?? input?.stateStore;
  return withSourcePermissionStateLock(operationStateStore, () => {
    // Deletion truth is terminal only when neither side of the transaction can
    // execute caller code between native removal and the durable state save.
    const authority = trustedStateStore ? localStagingAuthority(input?.staging) : null;
    const operationInput = { ...input, stateStore: operationStateStore };
    return authority
      ? authority.run((trustedStaging) => compileApprovedRecordsLocked({ ...operationInput, staging: trustedStaging }))
      : compileApprovedRecordsLocked(operationInput);
  });
}

async function compileApprovedRecordsLocked({
  message,
  stateStore,
  staging,
  batchId,
  approvedRecords,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  assertStagingAdapter(staging);
  const safeBatchId = assertBatchId(batchId);
  const now = isoNow(clock);
  let state = await loadState(stateStore);
  let lifecycle = compilationState(state);
  await reconcileKnowledgeCleanup({ state, lifecycle, stateStore, staging, now });

  let entry = lifecycle.batches[safeBatchId];
  const resolvedLanguage = languageFor(state, language);
  if (entry?.status === "compiled") {
    await finalizePersistedCompilationCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
    return compiledResponse(entry, resolvedLanguage);
  }
  if (entry?.status === "discarded" && entry.staging?.status === "discarded-pending-deletion") {
    await finalizeDiscardedCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
    return cleanupOnlyResponse(entry, resolvedLanguage);
  }
  if (entry?.status === "expired") {
    await finalizeExpiredCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
    throw new KnowledgeCompilationError("STAGING_EXPIRED", publicBatch(entry, resolvedLanguage).message);
  }
  if (entry?.status === "discarded") {
    throw new KnowledgeCompilationError("STAGING_DISCARDED", wording(resolvedLanguage).discarded);
  }

  if (!entry) {
    let records = approvedRecords === undefined ? null : normalizeApprovedRecords(approvedRecords, state);
    let receipt;
    let reconciliation = null;
    if (records === null) {
      reconciliation = await recoverUntrackedStagedBatch({
        staging,
        batchId: safeBatchId,
        state,
        expectedRecords: null,
        now
      });
      if (!reconciliation) {
        // Keep the normal customer path explicit: a new batch must arrive as
        // approved normalized records, while an interrupted batch can resume
        // without resubmitting any source material.
        records = normalizeApprovedRecords(approvedRecords, state);
      }
    }
    if (reconciliation?.expired) {
      entry = expiredBatchEntry({ batchId: safeBatchId, now, language: resolvedLanguage, staged: reconciliation.staged });
      lifecycle.batches[safeBatchId] = entry;
      lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId: safeBatchId, recoveredWithoutPersistedState: true });
      await stateStore.save(state);
      await finalizeExpiredCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
      throw new KnowledgeCompilationError("STAGING_EXPIRED", publicBatch(entry, resolvedLanguage).message);
    }
    if (reconciliation?.discarded) {
      entry = discardedBatchEntry({
        batchId: safeBatchId,
        now,
        language: resolvedLanguage,
        staged: reconciliation.staged,
        reason: safeFailureCode(reconciliation.error),
        deletionCompleted: reconciliation.deletionCompleted
      });
      lifecycle.batches[safeBatchId] = entry;
      lifecycle.audit.push({
        type: "temporary-batch-discarded",
        at: now,
        batchId: safeBatchId,
        reason: safeFailureCode(reconciliation.error),
        recoveredWithoutPersistedState: true
      });
      await stateStore.save(state);
      await finalizeDiscardedCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
      throw reconciliation.error;
    }
    if (reconciliation) {
      records = reconciliation.records;
      receipt = reconciliation.receipt;
    } else {
      try {
        receipt = await staging.stage({ batchId: safeBatchId, records, createdAt: now });
      } catch (error) {
        if (!(error instanceof KnowledgeCompilationError) || error.code !== "STAGING_BATCH_EXISTS") throw error;
        reconciliation = await recoverUntrackedStagedBatch({
          staging,
          batchId: safeBatchId,
          state,
          expectedRecords: records,
          now
        });
        if (!reconciliation?.expired) {
          records = reconciliation?.records ?? records;
          receipt = reconciliation?.receipt ?? receipt;
        }
      }
      if (reconciliation?.expired) {
        entry = expiredBatchEntry({ batchId: safeBatchId, now, language: resolvedLanguage, staged: reconciliation.staged });
        lifecycle.batches[safeBatchId] = entry;
        lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId: safeBatchId, recoveredWithoutPersistedState: true });
        await stateStore.save(state);
        await finalizeExpiredCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
        throw new KnowledgeCompilationError("STAGING_EXPIRED", publicBatch(entry, resolvedLanguage).message);
      }
      if (reconciliation?.discarded) {
        entry = discardedBatchEntry({
          batchId: safeBatchId,
          now,
          language: resolvedLanguage,
          staged: reconciliation.staged,
          reason: safeFailureCode(reconciliation.error),
          deletionCompleted: reconciliation.deletionCompleted
        });
        lifecycle.batches[safeBatchId] = entry;
        lifecycle.audit.push({
          type: "temporary-batch-discarded",
          at: now,
          batchId: safeBatchId,
          reason: safeFailureCode(reconciliation.error),
          recoveredWithoutPersistedState: true
        });
        await stateStore.save(state);
        await finalizeDiscardedCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
        throw reconciliation.error;
      }
      if (!receipt) {
        throw new KnowledgeCompilationError("STAGING_BATCH_MISSING", "The protected temporary batch could not be safely reconciled. Approve a new batch before continuing.");
      }
    }
    entry = {
      batchId: safeBatchId,
      status: "staged",
      language: resolvedLanguage,
      createdAt: receipt.createdAt,
      staging: receipt,
      audit: [{
        type: reconciliation ? "approved-normalized-records-reconciled-after-state-save-interruption" : "approved-normalized-records-staged",
        at: now,
        recordCount: records.length
      }]
    };
    lifecycle.batches[safeBatchId] = entry;
    lifecycle.audit.push({
      type: reconciliation ? "approved-normalized-records-reconciled-after-state-save-interruption" : "approved-normalized-records-staged",
      at: now,
      batchId: safeBatchId,
      recordCount: records.length
    });
    await stateStore.save(state);
  } else if (approvedRecords !== undefined) {
    throw new KnowledgeCompilationError(
      "BATCH_ALREADY_STAGED",
      "This protected batch is already staged. Resume it without resubmitting records so it cannot be replaced."
    );
  }

  try {
    const staged = await staging.read({ batchId: safeBatchId, leaseId: entry.staging?.leaseId });
    if (Date.parse(staged.expiresAt) <= Date.parse(now)) {
      entry.status = "expired";
      entry.staging = entry.staging ? { ...entry.staging, status: "expired-pending-deletion", deletedAt: null } : null;
      entry.audit.push({ type: "temporary-staging-expired", at: now, deletionConfirmed: false });
      lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId: safeBatchId, deletionConfirmed: false });
      await stateStore.save(state);
      await finalizeExpiredCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
      throw new KnowledgeCompilationError("STAGING_EXPIRED", publicBatch(entry, resolvedLanguage).message);
    }

    // Re-load while holding the shared in-process lifecycle lock immediately
    // before producing a durable result. This catches a revocation completed
    // before this transaction and prevents same-process stale-root saves.
    state = await loadState(stateStore);
    lifecycle = compilationState(state);
    entry = lifecycle.batches[safeBatchId];
    if (entry?.status === "compiled") {
      await finalizePersistedCompilationCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
      return compiledResponse(entry, resolvedLanguage);
    }
    if (!entry || entry.status !== "staged") {
      throw new KnowledgeCompilationError(
        "COMPILATION_STATE_CONFLICT",
        "The protected batch changed while it was being compiled, so no canonical result was written. Resume from the current private state."
      );
    }
    const records = normalizeApprovedRecords(staged.records, state);
    const result = compileProjections(records, resolvedLanguage, now);
    const persisted = await persistCompiledResultBeforeDeleting({
      stateStore,
      state,
      lifecycle,
      entry,
      batchId: safeBatchId,
      result,
      now
    });
    if (!persisted.persisted) {
      // Never delete the staged batch when the derived result is not known to
      // be durably saved. A normal-language resume will re-read this same
      // bounded stage instead of losing or inventing a result.
      return {
        compilation: publicBatch(persisted.stagedEntry, resolvedLanguage),
        interruption: { code: "RESULT_STATE_SAVE_FAILED", retryable: true },
        limitation: wording(resolvedLanguage).simulated
      };
    }
    state = persisted.state;
    lifecycle = persisted.lifecycle;
    entry = persisted.entry;
    await finalizePersistedCompilationCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
    return compiledResponse(entry, resolvedLanguage);
  } catch (error) {
    if (error instanceof KnowledgeCompilationError && error.code === "STAGING_EXPIRED") throw error;
    if (error instanceof KnowledgeCompilationError && error.code === "COMPILATION_STATE_CONFLICT") throw error;
    if (shouldDiscardAfterFailure(error)) {
      entry.status = "discarded";
      entry.staging = entry.staging
        ? {
            ...entry.staging,
            status: "discarded-pending-deletion",
            deletedAt: null
          }
        : null;
      entry.audit.push({ type: "temporary-batch-discarded", at: now, reason: safeFailureCode(error) });
      lifecycle.audit.push({ type: "temporary-batch-discarded", at: now, batchId: safeBatchId, reason: safeFailureCode(error) });
      await stateStore.save(state);
      await finalizeDiscardedCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
      throw error;
    }
    if (cleanupNeedsLocalAttention(error) && entry.staging) {
      entry.staging = { ...entry.staging, cleanupNeedsAttention: "filesystem-generation-integrity" };
    }
    entry.audit.push({ type: "canonical-compilation-interrupted", at: now, reason: safeFailureCode(error) });
    lifecycle.audit.push({ type: "canonical-compilation-interrupted", at: now, batchId: safeBatchId, reason: safeFailureCode(error) });
    await stateStore.save(state);
    return {
      compilation: publicBatch(entry, resolvedLanguage),
      interruption: { code: safeFailureCode(error), retryable: true },
      limitation: wording(resolvedLanguage).simulated
    };
  }
}

/** Removes any expired temporary staging batch and makes its private state fail closed. */
export async function cleanupExpiredKnowledgeStaging(input) {
  const trustedStateStore = trustedFileStateStoreFacade(input?.stateStore);
  const operationStateStore = trustedStateStore ?? input?.stateStore;
  return withSourcePermissionStateLock(operationStateStore, () => {
    const authority = trustedStateStore ? localStagingAuthority(input?.staging) : null;
    const operationInput = { ...input, stateStore: operationStateStore };
    return authority
      ? authority.run((trustedStaging) => cleanupExpiredKnowledgeStagingLocked({ ...operationInput, staging: trustedStaging }))
      : cleanupExpiredKnowledgeStagingLocked(operationInput);
  });
}

async function cleanupExpiredKnowledgeStagingLocked({ stateStore, staging, clock }) {
  assertStateStore(stateStore);
  assertStagingAdapter(staging);
  const now = isoNow(clock);
  const state = await loadState(stateStore);
  const lifecycle = compilationState(state);
  const reconciliation = await reconcileKnowledgeCleanup({ state, lifecycle, stateStore, staging, now });
  return {
    cleanup: {
      simulated: true,
      rawSourceBodiesRetained: Object.values(lifecycle.batches).some((entry) => (
        rawSourceBodiesRetainedForStaging(entry.staging)
      )),
      needsAttentionBatchIds: [...new Set(
        reconciliation.cleanupNeedsAttentionBatches.map((entry) => entry.batchId)
      )].sort(),
      expiredBatchIds: Object.values(lifecycle.batches)
        .filter((entry) => entry.status === "expired")
        .map((entry) => entry.batchId)
        .sort()
    }
  };
}

/** Read-only status. It never accesses source connectors or temporary batch contents. */
export async function getKnowledgeCompilationStatus(input) {
  const operationStateStore = trustedFileStateStoreFacade(input?.stateStore) ?? input?.stateStore;
  return withSourcePermissionStateLock(operationStateStore, () => (
    getKnowledgeCompilationStatusLocked({ ...input, stateStore: operationStateStore })
  ));
}

async function getKnowledgeCompilationStatusLocked({ stateStore, batchId, language }) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state?.[STATE_KEY]) return null;
  const entry = state[STATE_KEY].batches[assertBatchId(batchId)];
  if (!entry) return null;
  const resolvedLanguage = languageFor(state, language);
  return {
    compilation: publicBatch(entry, resolvedLanguage),
    result: entry.status === "compiled" ? {
      claimCount: entry.result.claims.length,
      canonicalNoteCount: entry.result.canonicalNotes.length,
      sourceIndexCount: entry.result.sourceIndexes.length
    } : null
  };
}

export const CANONICAL_SUBJECT_TYPES = Object.freeze(Object.keys(SUBJECT_TYPES));
export const TEMPORARY_STAGING_POLICY = Object.freeze({
  directoryName: STAGING_DIRECTORY_NAME,
  maxAgeHours: 24,
  maxRecords: MAX_BATCH_RECORDS,
  maxBytes: MAX_STAGING_BYTES,
  rawSourceBodiesAccepted: false
});
