/**
 * Private local boundary for QWave WhatsApp Snapshot Bundle v1.
 *
 * A bundle is an uncompressed metadata manifest plus per-chat JSONL segments
 * and optional media files. Only the manifest is opened during preflight.
 * Selected segment/media bodies are opened only after an immutable grant.
 * Native WhatsApp ZIP archives are deliberately unsupported here.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { SENSITIVE_CATEGORIES } from "../permissions/setup-source-permissions.mjs";
import { assertLocalWhatsAppSnapshotLifecycleOperationAuthorized } from "./whatsapp-snapshot.mjs";

export const WHATSAPP_SNAPSHOT_BUNDLE_FORMAT = "qwave.whatsapp-snapshot-bundle/v1";
export const WHATSAPP_SNAPSHOT_CONNECTOR_PROTOCOL = "qwave.local-whatsapp-snapshot/v1";
export const DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF = "wa-account-local-1";

export const DEFAULT_WHATSAPP_SNAPSHOT_LIMITS = Object.freeze({
  manifestBytes: 512 * 1024,
  people: 2_000,
  chats: 500,
  segments: 2_000,
  records: 50_000,
  recordFileBytes: 8 * 1024 * 1024,
  totalRecordBytes: 64 * 1024 * 1024,
  recordLineBytes: 256 * 1024,
  messageTextBytes: 128 * 1024,
  mediaFiles: 500,
  mediaFileBytes: 16 * 1024 * 1024,
  totalMediaBytes: 128 * 1024 * 1024,
  pathCharacters: 1_024,
  pathComponents: 64
});

const MODULE_REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ACCESS_LEVELS = new Set(["allowed", "restricted", "blocked"]);
const SENSITIVITIES = new Set(["general", ...SENSITIVE_CATEGORIES]);
const CHAT_TYPES = new Set(["direct", "group"]);
const MEDIA_STATES = new Set(["none", "present"]);
const SAFE_MEDIA_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm"
]);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_REF = /^[A-Za-z0-9._:-]{1,160}$/;
const ACCOUNT_REF = /^wa-account-[a-z0-9._:-]{1,128}$/;
const LOCAL_WHATSAPP_SNAPSHOT_LIFECYCLE_OPERATIONS = new WeakMap();

// Deliberately not re-exported from the package entrypoint. High-authority
// closures still require a synchronous one-shot authorization held entirely
// inside the lifecycle module; this bridge never receives or exposes a token.
export function getLocalWhatsAppSnapshotLifecycleOperations(connector) {
  return LOCAL_WHATSAPP_SNAPSHOT_LIFECYCLE_OPERATIONS.get(connector) ?? null;
}

export class LocalWhatsAppSnapshotError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "LocalWhatsAppSnapshotError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

function fail(code, message) {
  throw new LocalWhatsAppSnapshotError(code, message);
}

function clone(value) {
  return structuredClone(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function alias(seed, kind, rawId) {
  return `wa-${kind}-${hash(`${seed}\0${kind}\0${rawId}`).slice(0, 20)}`;
}

function strictIso(value, code = "SNAPSHOT_TIMESTAMP_INVALID") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(code, "The snapshot contains a timestamp that is not a strict UTC ISO timestamp, so I stopped safely.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(code, "The snapshot contains an invalid timestamp, so I stopped safely.");
  }
  return value;
}

function assertAllowedKeys(object, allowed, field) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    fail("SNAPSHOT_SCHEMA_INVALID", `The snapshot ${field} metadata is malformed, so I stopped safely.`);
  }
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail("SNAPSHOT_SCHEMA_INVALID", `The snapshot ${field} metadata contains unsupported fields, so I stopped safely.`);
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\0\r\n]/.test(value)) {
    fail("SNAPSHOT_SCHEMA_INVALID", `The snapshot ${field} value is missing or malformed, so I stopped safely.`);
  }
  return value.trim();
}

function requiredSafeRef(value, field) {
  const result = requiredString(value, field);
  if (!SAFE_REF.test(result)) fail("SNAPSHOT_SCHEMA_INVALID", `The snapshot ${field} identifier is malformed, so I stopped safely.`);
  return result;
}

function requiredInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("SNAPSHOT_LIMIT_EXCEEDED", `The snapshot ${field} exceeds the private import limit, so I stopped before reading content.`);
  }
  return value;
}

function decodeStrictUtf8(bytes, code, message) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code, message);
  }
}

function normalizedLimits(limits) {
  const result = { ...DEFAULT_WHATSAPP_SNAPSHOT_LIMITS };
  if (limits === undefined) return Object.freeze(result);
  assertAllowedKeys(limits, Object.keys(DEFAULT_WHATSAPP_SNAPSHOT_LIMITS), "limit");
  for (const [key, defaultValue] of Object.entries(DEFAULT_WHATSAPP_SNAPSHOT_LIMITS)) {
    const value = limits[key] ?? defaultValue;
    if (!Number.isSafeInteger(value) || value < 1 || value > defaultValue) {
      throw new TypeError(`WhatsApp snapshot limit ${key} must be an integer between 1 and ${defaultValue}.`);
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validatePathShape(value, limits, { manifest = false } = {}) {
  if (typeof value !== "string" || !value || value.length > limits.pathCharacters || /[\0\r\n]/.test(value)) {
    fail("SNAPSHOT_PATH_INVALID", "The selected snapshot path is malformed or too long, so I did not open it.");
  }
  if (value.split(/[\\/]+/).length > limits.pathComponents) {
    fail("SNAPSHOT_PATH_INVALID", "The selected snapshot path is too deeply nested, so I did not open it.");
  }
  const lower = value.toLowerCase();
  if (/\.(?:zip|gz|tgz|tar|7z|rar)$/.test(lower)) {
    fail("SNAPSHOT_ARCHIVE_UNSUPPORTED", "Compressed WhatsApp archives are not supported by this snapshot contract. Provide an uncompressed QWave snapshot bundle manifest.");
  }
  if (manifest && !lower.endsWith(".qwave-wa.json")) {
    fail("SNAPSHOT_FORMAT_UNSUPPORTED", "This import accepts only an uncompressed .qwave-wa.json bundle manifest; native WhatsApp ZIP archives are not supported.");
  }
}

function validateRelativeFile(value, limits, expectedSuffix) {
  validatePathShape(value, limits);
  if (path.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("SNAPSHOT_PATH_INVALID", "A snapshot content path escapes its private bundle, so I stopped before opening it.");
  }
  if (!value.toLowerCase().endsWith(expectedSuffix)) {
    fail("SNAPSHOT_FORMAT_UNSUPPORTED", "A snapshot content file uses an unsupported format, so I stopped before opening it.");
  }
  return value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function publicFileError(error, fallbackCode = "SNAPSHOT_FILE_UNAVAILABLE") {
  if (error instanceof LocalWhatsAppSnapshotError) throw error;
  fail(fallbackCode, "I could not safely open the selected private snapshot file. No snapshot content was returned.");
}

export class LocalWhatsAppSnapshotConnector {
  #manifestPath;
  #permittedRoot;
  #repositoryRoots;
  #accountRef;
  #limits;
  #ready = null;
  #pendingGrantBindings = new Map();
  #grantBindings = new Map();
  #revokedGrants = new Set();
  #fetchCache = new Map();
  #metrics = {
    metadataPreflightCalls: 0,
    manifestReads: 0,
    recordFileReads: 0,
    mediaFileReads: 0,
    rawMessageBodiesRead: 0,
    rawMediaBodiesRead: 0,
    grantPreparationCalls: 0,
    grantRegistrationCalls: 0,
    grantRevocationCalls: 0,
    writeCalls: 0
  };

  constructor({ manifestPath, permittedRoot, accountRef = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, repositoryRoots = [], limits } = {}) {
    if (typeof manifestPath !== "string" || typeof permittedRoot !== "string") {
      throw new TypeError("A private snapshot manifestPath and permittedRoot are required.");
    }
    if (!path.isAbsolute(manifestPath) || !path.isAbsolute(permittedRoot)) {
      throw new TypeError("The private snapshot manifestPath and permittedRoot must be absolute local paths.");
    }
    if (!ACCOUNT_REF.test(accountRef)) throw new TypeError("accountRef must be a local wa-account-* alias, never a source account identifier.");
    if (!Array.isArray(repositoryRoots) || repositoryRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
      throw new TypeError("repositoryRoots must be an array of absolute paths.");
    }
    // Deliberately lexical only: construction and every public getter perform
    // zero filesystem operations. Canonicalization begins in discoverMetadata,
    // after the customer has approved the local import preflight.
    this.#manifestPath = manifestPath;
    this.#permittedRoot = permittedRoot;
    this.#repositoryRoots = [MODULE_REPOSITORY_ROOT, ...repositoryRoots];
    this.#accountRef = accountRef;
    this.#limits = normalizedLimits(limits);
    LOCAL_WHATSAPP_SNAPSHOT_LIFECYCLE_OPERATIONS.set(this, Object.freeze({
      discoverMetadata: (request) => this.#discoverMetadata(request),
      getSnapshotBinding: () => this.#getSnapshotBinding(),
      validateSelection: (selection) => this.#validateSelection(selection),
      preparePermissionGrant: (request) => this.#preparePermissionGrant(request),
      registerPermissionGrant: (request) => this.#registerPermissionGrant(request),
      revokePermissionGrant: (request) => this.#revokePermissionGrant(request),
      readPermissionGrantStatus: (request) => this.#readPermissionGrantStatus(request),
      createApprovedFetchPlan: (request) => this.#createApprovedFetchPlan(request),
      fetchApprovedContent: (request) => this.#fetchApprovedContent(request),
      cleanupPrivateMemory: () => this.#cleanupPrivateMemory()
    }));
    // The exact grant readback is an own, non-replaceable function backed by
    // connector-private maps. The lifecycle does not invoke this public
    // wrapper; it uses the exact-instance private operation registered above.
    Object.defineProperty(this, "readPermissionGrantStatus", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (request) => this.#readPermissionGrantStatus(request)
    });
  }

  get metadataPreflightCalls() { return this.#metrics.metadataPreflightCalls; }
  get manifestReads() { return this.#metrics.manifestReads; }
  get recordFileReads() { return this.#metrics.recordFileReads; }
  get mediaFileReads() { return this.#metrics.mediaFileReads; }
  get rawMessageBodiesRead() { return this.#metrics.rawMessageBodiesRead; }
  get rawMediaBodiesRead() { return this.#metrics.rawMediaBodiesRead; }
  get grantPreparationCalls() { return this.#metrics.grantPreparationCalls; }
  get grantRegistrationCalls() { return this.#metrics.grantRegistrationCalls; }
  get grantRevocationCalls() { return this.#metrics.grantRevocationCalls; }
  get writeCalls() { return this.#metrics.writeCalls; }

  async #readPermissionGrantStatus({ grantId, snapshotBinding } = {}) {
    this.#assertBinding(snapshotBinding);
    if (!SAFE_REF.test(grantId)) fail("SNAPSHOT_GRANT_INVALID", "The WhatsApp snapshot grant identifier is invalid.");
    const pending = this.#pendingGrantBindings.has(grantId);
    return Object.freeze({
      grantId,
      active: this.#grantBindings.has(grantId),
      revoked: this.#revokedGrants.has(grantId),
      ...(pending ? { pending: true } : {})
    });
  }

  async #canonicalRoots() {
    if (!path.isAbsolute(this.#permittedRoot)) fail("SNAPSHOT_ROOT_INVALID", "The private snapshot root must be an absolute local path.");
    const lexicalPermittedRoot = path.resolve(this.#permittedRoot);
    const permittedRoot = await realpath(lexicalPermittedRoot).catch((error) => publicFileError(error, "SNAPSHOT_ROOT_INVALID"));
    const repositoryRoots = [];
    for (const root of this.#repositoryRoots) {
      try {
        repositoryRoots.push(await realpath(root));
      } catch {
        // An optional additional repository root that does not exist cannot
        // contain the selected snapshot and is safe to ignore.
      }
    }
    return { lexicalPermittedRoot, permittedRoot, repositoryRoots };
  }

  async #openBoundedFile(candidate, { maximumBytes, expectedBytes, expectedSha256, roots, kind }) {
    validatePathShape(candidate, this.#limits, { manifest: kind === "manifest" });
    const lexical = path.resolve(candidate);
    let before;
    try {
      before = await lstat(lexical);
    } catch (error) {
      publicFileError(error);
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      fail("SNAPSHOT_FILE_IDENTITY_INVALID", "A snapshot file is not a private regular file or has an unsafe link, so I did not open it.");
    }
    const canonical = await realpath(lexical).catch((error) => publicFileError(error));
    const enteredThroughLexicalRoot = isWithin(lexical, roots.lexicalPermittedRoot);
    const enteredThroughCanonicalRoot = isWithin(lexical, roots.permittedRoot);
    const expectedCanonical = enteredThroughLexicalRoot
      ? path.resolve(roots.permittedRoot, path.relative(roots.lexicalPermittedRoot, lexical))
      : lexical;
    if ((!enteredThroughLexicalRoot && !enteredThroughCanonicalRoot) || canonical !== expectedCanonical || !isWithin(canonical, roots.permittedRoot)) {
      fail("SNAPSHOT_PATH_ESCAPE", "A snapshot file resolves outside the approved private root, so I did not open it.");
    }
    if (roots.repositoryRoots.some((root) => isWithin(canonical, root))) {
      fail("SNAPSHOT_REPOSITORY_PATH_BLOCKED", "Snapshot source data cannot be imported from inside a code repository.");
    }
    if (before.size > maximumBytes || (expectedBytes !== undefined && before.size !== expectedBytes)) {
      fail("SNAPSHOT_LIMIT_EXCEEDED", "A snapshot file size does not match its bounded manifest, so I stopped before returning content.");
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    let handle;
    let bytes;
    try {
      handle = await open(canonical, flags);
      const opened = await handle.stat();
      if (!sameIdentity(before, opened)) fail("SNAPSHOT_FILE_CHANGED", "A snapshot file changed while it was being opened, so I stopped safely.");
      // Read at most the already-approved size plus one sentinel byte. A
      // concurrently growing file therefore cannot turn a bounded import into
      // an unbounded allocation before the post-read identity check runs.
      const bounded = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < bounded.length) {
        const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      bytes = bounded.subarray(0, offset);
      if (offset !== opened.size) fail("SNAPSHOT_FILE_CHANGED", "A snapshot file changed while it was being read, so I stopped safely.");
      const after = await handle.stat();
      if (!sameIdentity(opened, after) || bytes.length !== opened.size) {
        fail("SNAPSHOT_FILE_CHANGED", "A snapshot file changed while it was being read, so I stopped safely.");
      }
      const digest = hash(bytes);
      if (expectedSha256 !== undefined && digest !== expectedSha256) {
        fail("SNAPSHOT_DIGEST_MISMATCH", "A snapshot file no longer matches its immutable digest, so I stopped safely.");
      }
      return { bytes, digest, stat: opened, canonical };
    } catch (error) {
      if (bytes) bytes.fill(0);
      publicFileError(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  #validateManifest(manifest, { digest, canonical, stat, roots }) {
    assertAllowedKeys(manifest, ["format", "generation", "capturedAt", "account", "people", "chats"], "manifest");
    if (manifest.format !== WHATSAPP_SNAPSHOT_BUNDLE_FORMAT) {
      fail("SNAPSHOT_FORMAT_UNSUPPORTED", "This file is not a supported uncompressed QWave WhatsApp snapshot bundle.");
    }
    const generation = requiredSafeRef(manifest.generation, "generation");
    const capturedAt = strictIso(manifest.capturedAt);
    assertAllowedKeys(manifest.account, ["id", "label"], "account");
    requiredString(manifest.account.id, "account id");
    requiredString(manifest.account.label, "account label");
    if (!Array.isArray(manifest.people) || manifest.people.length < 1 || manifest.people.length > this.#limits.people) {
      fail("SNAPSHOT_LIMIT_EXCEEDED", "The snapshot people list is missing or exceeds the private import limit.");
    }
    if (!Array.isArray(manifest.chats) || manifest.chats.length < 1 || manifest.chats.length > this.#limits.chats) {
      fail("SNAPSHOT_LIMIT_EXCEEDED", "The snapshot chat list is missing or exceeds the private import limit.");
    }

    const seed = `${digest}:${generation}`;
    const peopleByRaw = new Map();
    const peopleByAlias = new Map();
    manifest.people.forEach((person, index) => {
      assertAllowedKeys(person, ["id", "label", "accessLevel"], "person");
      const id = requiredString(person.id, "person id");
      requiredString(person.label, "person label");
      if (!ACCESS_LEVELS.has(person.accessLevel)) {
        fail("SNAPSHOT_ACCESS_UNKNOWN", "Every snapshot person needs an explicit Allowed, Restricted, or Blocked classification.");
      }
      if (peopleByRaw.has(id)) fail("SNAPSHOT_IDENTIFIER_AMBIGUOUS", "The snapshot contains a duplicate person identifier.");
      const ref = alias(seed, "person", id);
      const normalized = { rawId: id, ref, accessLevel: person.accessLevel, publicLabel: `WhatsApp person ${index + 1}` };
      peopleByRaw.set(id, normalized);
      peopleByAlias.set(ref, normalized);
    });

    const chatsByAlias = new Map();
    const rawChatIds = new Set();
    const recordPaths = new Set();
    const mediaPaths = new Set();
    const rawMediaIds = new Set();
    let segmentCount = 0;
    let recordCount = 0;
    let recordBytes = 0;
    let mediaCount = 0;
    let mediaBytes = 0;
    manifest.chats.forEach((chat, index) => {
      assertAllowedKeys(chat, ["id", "label", "type", "participantIds", "sensitivity", "media", "segments", "mediaInventory"], "chat");
      const rawId = requiredString(chat.id, "chat id");
      requiredString(chat.label, "chat label");
      if (rawChatIds.has(rawId)) fail("SNAPSHOT_IDENTIFIER_AMBIGUOUS", "The snapshot contains a duplicate chat identifier.");
      rawChatIds.add(rawId);
      if (!CHAT_TYPES.has(chat.type)) fail("SNAPSHOT_CHAT_TYPE_UNKNOWN", "Every snapshot chat needs an explicit direct or group type.");
      if (!SENSITIVITIES.has(chat.sensitivity)) fail("SNAPSHOT_SENSITIVITY_UNKNOWN", "Every snapshot chat needs an explicit supported sensitivity classification.");
      if (!MEDIA_STATES.has(chat.media)) fail("SNAPSHOT_MEDIA_UNKNOWN", "Every snapshot chat must explicitly declare whether media is present.");
      if (!Array.isArray(chat.participantIds) || chat.participantIds.length < 1) {
        fail("SNAPSHOT_PARTICIPANTS_UNKNOWN", "Every snapshot chat needs an explicit participant list.");
      }
      const participantIds = [...new Set(chat.participantIds.map((value) => requiredString(value, "participant id")))];
      if (participantIds.length !== chat.participantIds.length || participantIds.some((id) => !peopleByRaw.has(id))) {
        fail("SNAPSHOT_PARTICIPANTS_UNKNOWN", "A snapshot chat has duplicate or unknown participants, so I kept it inaccessible.");
      }
      if (!Array.isArray(chat.segments) || chat.segments.length < 1) {
        fail("SNAPSHOT_SEGMENTS_REQUIRED", "Every snapshot chat needs at least one bounded JSONL segment.");
      }
      const rawSegmentIds = new Set();
      const segments = chat.segments.map((segment) => {
        assertAllowedKeys(segment, ["id", "path", "sha256", "bytes", "count", "from", "to"], "segment");
        const rawSegmentId = requiredString(segment.id, "segment id");
        if (rawSegmentIds.has(rawSegmentId)) fail("SNAPSHOT_IDENTIFIER_AMBIGUOUS", "A snapshot chat contains a duplicate segment identifier.");
        rawSegmentIds.add(rawSegmentId);
        const relativePath = validateRelativeFile(segment.path, this.#limits, ".jsonl");
        if (recordPaths.has(relativePath)) {
          fail("SNAPSHOT_PATH_AMBIGUOUS", "A snapshot record path is reused, so its immutable chat binding is ambiguous.");
        }
        recordPaths.add(relativePath);
        if (!SHA256.test(segment.sha256)) fail("SNAPSHOT_SCHEMA_INVALID", "A snapshot segment digest is malformed.");
        const bytes = requiredInteger(segment.bytes, 1, this.#limits.recordFileBytes, "segment bytes");
        const count = requiredInteger(segment.count, 1, this.#limits.records, "segment record count");
        const from = strictIso(segment.from);
        const to = strictIso(segment.to);
        if (Date.parse(from) > Date.parse(to) || Date.parse(to) > Date.parse(capturedAt)) {
          fail("SNAPSHOT_TIMESTAMP_INVALID", "A snapshot segment date boundary is invalid or later than its capture time.");
        }
        segmentCount += 1;
        recordCount += count;
        recordBytes += bytes;
        if (segmentCount > this.#limits.segments || recordCount > this.#limits.records || recordBytes > this.#limits.totalRecordBytes) {
          fail("SNAPSHOT_LIMIT_EXCEEDED", "The snapshot record segments exceed the private import limits.");
        }
        return {
          rawId: rawSegmentId,
          ref: alias(seed, "segment", `${rawId}:${rawSegmentId}`),
          relativePath,
          sha256: segment.sha256,
          bytes,
          count,
          from,
          to
        };
      });
      const chronologicalSegments = [...segments].sort((left, right) => Date.parse(left.from) - Date.parse(right.from));
      for (let position = 1; position < chronologicalSegments.length; position += 1) {
        if (Date.parse(chronologicalSegments[position].from) <= Date.parse(chronologicalSegments[position - 1].to)) {
          fail("SNAPSHOT_SEGMENT_OVERLAP", "A snapshot chat contains overlapping segment boundaries, so I stopped before reading content.");
        }
      }
      if (!Array.isArray(chat.mediaInventory)) {
        fail("SNAPSHOT_MEDIA_INVENTORY_REQUIRED", "Every snapshot chat needs an explicit body-free media inventory.");
      }
      const segmentByRawId = new Map(segments.map((segment) => [segment.rawId, segment]));
      const mediaInventory = chat.mediaInventory.map((media) => {
        assertAllowedKeys(media, ["id", "segmentId", "messageId", "path", "sha256", "bytes", "mimeType"], "media inventory");
        const rawMediaId = requiredString(media.id, "media id");
        const rawSegmentId = requiredString(media.segmentId, "media segment id");
        const rawMessageId = requiredString(media.messageId, "media message id");
        const segment = segmentByRawId.get(rawSegmentId);
        if (!segment) fail("SNAPSHOT_MEDIA_BINDING_INVALID", "A media inventory item is not bound to a declared segment.");
        if (rawMediaIds.has(rawMediaId)) fail("SNAPSHOT_IDENTIFIER_AMBIGUOUS", "The snapshot contains a duplicate media identifier.");
        rawMediaIds.add(rawMediaId);
        const normalized = this.#validateMediaMetadata(media, { inventory: true });
        if (mediaPaths.has(normalized.relativePath)) {
          fail("SNAPSHOT_PATH_AMBIGUOUS", "A snapshot media path is reused, so its immutable message binding is ambiguous.");
        }
        mediaPaths.add(normalized.relativePath);
        mediaCount += 1;
        mediaBytes += normalized.bytes;
        if (mediaCount > this.#limits.mediaFiles || mediaBytes > this.#limits.totalMediaBytes) {
          fail("SNAPSHOT_MEDIA_LIMIT_EXCEEDED", "The snapshot media inventory exceeds the private import limits.");
        }
        return {
          ...normalized,
          rawSegmentId,
          rawMessageId,
          segmentRef: segment.ref,
          messageRef: alias(seed, "message", rawMessageId),
          ref: alias(seed, "media", `${rawMessageId}:${rawMediaId}`)
        };
      });
      if ((chat.media === "none") !== (mediaInventory.length === 0)) {
        fail("SNAPSHOT_MEDIA_DECLARATION_MISMATCH", "The chat media declaration does not exactly match its body-free media inventory.");
      }
      const ref = alias(seed, "chat", rawId);
      chatsByAlias.set(ref, {
        rawId,
        ref,
        publicLabel: `${chat.type === "group" ? "Group" : "Direct"} WhatsApp chat ${index + 1}`,
        isGroup: chat.type === "group",
        participantRefs: participantIds.map((id) => peopleByRaw.get(id).ref),
        participantRawIds: participantIds,
        sensitivity: chat.sensitivity,
        media: chat.media,
        segments,
        mediaInventory
      });
    });

    const bundleRoot = path.dirname(canonical);
    const snapshotId = `wa-snapshot-${hash(`${canonical}\0${digest}\0${generation}\0${stat.dev}:${stat.ino}`).slice(0, 24)}`;
    const mediaInventoryBinding = `wa-media-inventory-${hash(JSON.stringify(
      [...chatsByAlias.values()].flatMap((chat) => chat.mediaInventory.map((media) => ({
        chatRef: chat.ref,
        segmentRef: media.segmentRef,
        messageRef: media.messageRef,
        mediaRef: media.ref,
        relativePath: media.relativePath,
        sha256: media.sha256,
        bytes: media.bytes,
        mimeType: media.mimeType
      })))
    )).slice(0, 24)}`;
    const binding = Object.freeze({
      protocol: WHATSAPP_SNAPSHOT_CONNECTOR_PROTOCOL,
      format: WHATSAPP_SNAPSHOT_BUNDLE_FORMAT,
      snapshotId,
      generation: `wa-generation-${hash(generation).slice(0, 20)}`,
      mediaInventoryBinding,
      capturedAt,
      accountRef: this.#accountRef
    });
    return { binding, manifestSha256: digest, roots, bundleRoot, peopleByAlias, chatsByAlias, generationSeed: seed };
  }

  async #discoverMetadata({ source } = {}) {
    if (source !== "whatsapp") fail("SNAPSHOT_CONNECTOR_SUBSTITUTION", "This private snapshot connector can only review WhatsApp snapshot data.");
    this.#metrics.metadataPreflightCalls += 1;
    if (!this.#ready) {
      const roots = await this.#canonicalRoots();
      validatePathShape(this.#manifestPath, this.#limits, { manifest: true });
      const opened = await this.#openBoundedFile(this.#manifestPath, {
        maximumBytes: this.#limits.manifestBytes,
        roots,
        kind: "manifest"
      });
      this.#metrics.manifestReads += 1;
      let manifest;
      try {
        manifest = JSON.parse(decodeStrictUtf8(opened.bytes, "SNAPSHOT_MANIFEST_MALFORMED", "The snapshot manifest is not valid UTF-8."));
      } catch {
        opened.bytes.fill(0);
        fail("SNAPSHOT_MANIFEST_MALFORMED", "The snapshot manifest is malformed or truncated, so I stopped before reading any message content.");
      }
      try {
        this.#ready = this.#validateManifest(manifest, { ...opened, roots });
      } finally {
        opened.bytes.fill(0);
      }
    }
    const ready = this.#ready;
    return {
      source: "whatsapp",
      readOnly: true,
      account: { id: this.#accountRef, label: "Personal WhatsApp snapshot" },
      people: [...ready.peopleByAlias.values()].map((person) => ({
        id: person.ref,
        label: person.publicLabel,
        accessLevel: person.accessLevel
      })),
      conversations: [...ready.chatsByAlias.keys()],
      categories: [...new Set([...ready.chatsByAlias.values()].map((chat) => chat.sensitivity === "general" ? "messages" : chat.sensitivity))],
      items: [...ready.chatsByAlias.values()].map((chat) => ({
        id: chat.ref,
        kind: "conversation",
        conversation: chat.ref,
        category: chat.sensitivity === "general" ? "messages" : chat.sensitivity,
        sensitiveCategories: chat.sensitivity === "general" ? [] : [chat.sensitivity],
        isGroup: chat.isGroup,
        participantIds: [...chat.participantRefs],
        label: chat.publicLabel
      }))
    };
  }

  async discoverMetadata(request) {
    return this.#discoverMetadata(request);
  }

  #getSnapshotBinding() {
    if (!this.#ready) fail("SNAPSHOT_PREFLIGHT_REQUIRED", "Approve the snapshot metadata preflight before continuing.");
    return clone(this.#ready.binding);
  }

  getSnapshotBinding() {
    return this.#getSnapshotBinding();
  }

  #validateSelection(selection) {
    if (!this.#ready) fail("SNAPSHOT_PREFLIGHT_REQUIRED", "Approve the snapshot metadata preflight before continuing.");
    assertAllowedKeys(selection, ["chatRefs", "personRefs", "from", "to", "includeMedia", "sensitiveCategories", "selectionDigest", "mediaInventoryBinding"], "selection");
    if (!Array.isArray(selection.chatRefs) || selection.chatRefs.length < 1 || !Array.isArray(selection.personRefs) || selection.personRefs.length < 1) {
      fail("WHATSAPP_EXPLICIT_SELECTION_REQUIRED", "Choose at least one reviewed chat and one reviewed Allowed person before approving this snapshot.");
    }
    if (typeof selection.includeMedia !== "boolean") fail("MEDIA_SELECTION_REQUIRED", "Choose explicitly whether media is included.");
    if (!Array.isArray(selection.sensitiveCategories)) fail("SNAPSHOT_SENSITIVITY_SELECTION_REQUIRED", "Choose explicitly which reviewed sensitive categories, if any, are included.");
    const chatRefs = [...new Set(selection.chatRefs)];
    const personRefs = [...new Set(selection.personRefs)];
    const sensitiveCategories = [...new Set(selection.sensitiveCategories)];
    if (chatRefs.length !== selection.chatRefs.length || personRefs.length !== selection.personRefs.length || sensitiveCategories.length !== selection.sensitiveCategories.length) {
      fail("WHATSAPP_EXPLICIT_SELECTION_REQUIRED", "The WhatsApp selection contains duplicate or ambiguous entries.");
    }
    const from = strictIso(selection.from, "WHATSAPP_DATE_SELECTION_REQUIRED");
    const to = strictIso(selection.to, "WHATSAPP_DATE_SELECTION_REQUIRED");
    const capturedAt = this.#ready.binding.capturedAt;
    if (Date.parse(from) > Date.parse(to) || Date.parse(to) > Date.parse(capturedAt)) {
      fail("WHATSAPP_DATE_SELECTION_INVALID", "Choose an explicit date range that ends no later than the snapshot capture time.");
    }
    for (const personRef of personRefs) {
      const person = this.#ready.peopleByAlias.get(personRef);
      if (!person || person.accessLevel !== "allowed") {
        fail("WHATSAPP_ALLOWED_PERSON_REQUIRED", "Only people explicitly classified and selected as Allowed can be included.");
      }
    }
    const personSet = new Set(personRefs);
    const sensitiveSet = new Set(sensitiveCategories);
    const requiredPeople = new Set();
    const requiredSensitiveCategories = new Set();
    const selectedSegments = [];
    for (const chatRef of chatRefs) {
      const chat = this.#ready.chatsByAlias.get(chatRef);
      if (!chat) fail("WHATSAPP_CHAT_SELECTION_INVALID", "A selected chat was not part of this immutable metadata review.");
      if (chat.participantRefs.some((participantRef) => !personSet.has(participantRef))) {
        fail("WHATSAPP_POSITIVE_MEMBERSHIP_REQUIRED", "Every participant in a selected chat must be explicitly selected and classified as Allowed.");
      }
      chat.participantRefs.forEach((participantRef) => requiredPeople.add(participantRef));
      if (chat.sensitivity !== "general" && !sensitiveSet.has(chat.sensitivity)) {
        fail("WHATSAPP_SENSITIVE_APPROVAL_REQUIRED", "A selected sensitive chat needs an explicit matching sensitivity approval.");
      }
      if (chat.sensitivity !== "general") requiredSensitiveCategories.add(chat.sensitivity);
      if (chat.media === "present" && selection.includeMedia !== true) {
        // The chat may still be selected; media files will remain unopened.
      }
      const bounded = chat.segments.filter((segment) => Date.parse(segment.from) >= Date.parse(from) && Date.parse(segment.to) <= Date.parse(to));
      if (bounded.length < 1) {
        fail("WHATSAPP_DATE_SELECTION_EMPTY", "The chosen date range does not fully include a bounded segment for one selected chat.");
      }
      selectedSegments.push(...bounded.map((segment) => ({ chatRef, ...segment })));
    }
    for (const category of sensitiveCategories) {
      if (!SENSITIVE_CATEGORIES.includes(category)) fail("WHATSAPP_SENSITIVITY_SELECTION_INVALID", "An unknown sensitivity choice was rejected.");
    }
    if (JSON.stringify([...personSet].sort()) !== JSON.stringify([...requiredPeople].sort())) {
      fail("WHATSAPP_EXACT_MEMBERSHIP_REQUIRED", "The selected people must exactly match the participants in the selected chats.");
    }
    if (JSON.stringify([...sensitiveSet].sort()) !== JSON.stringify([...requiredSensitiveCategories].sort())) {
      fail("WHATSAPP_EXACT_SENSITIVITY_REQUIRED", "Sensitive approvals must exactly match the sensitive categories in the selected chats.");
    }
    const selectedSegmentRefs = new Set(selectedSegments.map((segment) => segment.ref));
    const selectedMediaInventory = [...chatRefs].sort().flatMap((chatRef) => {
      const chat = this.#ready.chatsByAlias.get(chatRef);
      return chat.mediaInventory
        .filter((media) => selectedSegmentRefs.has(media.segmentRef))
        .map((media) => ({ chatRef, segmentRef: media.segmentRef, messageRef: media.messageRef, mediaRef: media.ref }));
    }).sort((left, right) => `${left.segmentRef}:${left.messageRef}:${left.mediaRef}`.localeCompare(`${right.segmentRef}:${right.messageRef}:${right.mediaRef}`));
    const mediaInventoryBinding = `wa-selected-media-${hash(JSON.stringify(selectedMediaInventory)).slice(0, 24)}`;
    if (selection.mediaInventoryBinding !== undefined && selection.mediaInventoryBinding !== mediaInventoryBinding) {
      fail("SNAPSHOT_MEDIA_BINDING_MISMATCH", "The saved WhatsApp media inventory no longer matches its immutable review.");
    }
    const selectionDigest = hash(JSON.stringify({
      chatRefs: [...chatRefs].sort(),
      personRefs: [...personRefs].sort(),
      from,
      to,
      includeMedia: selection.includeMedia,
      sensitiveCategories: [...sensitiveCategories].sort(),
      mediaInventoryBinding
    }));
    if (selection.selectionDigest !== undefined && selection.selectionDigest !== selectionDigest) {
      fail("SNAPSHOT_SELECTION_BINDING_MISMATCH", "The saved WhatsApp selection no longer matches its immutable binding.");
    }
    return Object.freeze({
      chatRefs: Object.freeze([...chatRefs].sort()),
      personRefs: Object.freeze([...personRefs].sort()),
      from,
      to,
      includeMedia: selection.includeMedia,
      sensitiveCategories: Object.freeze([...sensitiveCategories].sort()),
      mediaInventoryBinding,
      selectionDigest
    });
  }

  validateSelection(selection) {
    return this.#validateSelection(selection);
  }

  #assertBinding(binding) {
    if (!this.#ready || !binding || JSON.stringify(binding) !== JSON.stringify(this.#ready.binding)) {
      fail("SNAPSHOT_CONNECTOR_SUBSTITUTION", "The connector no longer matches the immutable snapshot review, so I stopped safely.");
    }
  }

  #grantBinding({ grant, snapshotBinding, selection }) {
    this.#assertBinding(snapshotBinding);
    const normalized = this.#validateSelection(selection);
    if (!grant || grant.accountId !== this.#accountRef || grant.source !== "whatsapp" || grant.status !== "active") {
      fail("SNAPSHOT_GRANT_INVALID", "The private snapshot grant does not match this reviewed account.");
    }
    const grantedConversations = [...(grant.scope?.conversations ?? [])].sort();
    const grantedPeople = [...(grant.scope?.people?.allowed ?? [])].sort();
    const grantedSensitiveCategories = [...(grant.scope?.sensitiveGroups?.included ?? [])].sort();
    if (JSON.stringify(grantedConversations) !== JSON.stringify(normalized.chatRefs)
      || JSON.stringify(grantedPeople) !== JSON.stringify(normalized.personRefs)
      || JSON.stringify(grantedSensitiveCategories) !== JSON.stringify(normalized.sensitiveCategories)) {
      fail("SNAPSHOT_GRANT_SCOPE_MISMATCH", "The durable grant does not exactly match this immutable WhatsApp selection.");
    }
    return {
      snapshotId: snapshotBinding.snapshotId,
      selectionDigest: normalized.selectionDigest,
      mediaInventoryBinding: normalized.mediaInventoryBinding
    };
  }

  async #preparePermissionGrant({ grant, snapshotBinding, selection }) {
    assertLocalWhatsAppSnapshotLifecycleOperationAuthorized(this, "preparePermissionGrant", { grant, snapshotBinding, selection });
    const next = this.#grantBinding({ grant, snapshotBinding, selection });
    this.#metrics.grantPreparationCalls += 1;
    const active = this.#grantBindings.get(grant.id);
    const pending = this.#pendingGrantBindings.get(grant.id);
    if ((active && JSON.stringify(active) !== JSON.stringify(next))
      || (pending && JSON.stringify(pending) !== JSON.stringify(next))) {
      fail("SNAPSHOT_GRANT_CHANGED", "An existing WhatsApp snapshot grant cannot be widened or rebound.");
    }
    if (this.#revokedGrants.has(grant.id)) fail("SNAPSHOT_GRANT_REVOKED", "That WhatsApp snapshot grant was revoked and cannot be restored.");
    if (!active) this.#pendingGrantBindings.set(grant.id, next);
    return { prepared: true, idempotent: Boolean(active || pending), alreadyActive: Boolean(active) };
  }

  async #registerPermissionGrant({ grant, snapshotBinding, selection }) {
    assertLocalWhatsAppSnapshotLifecycleOperationAuthorized(this, "registerPermissionGrant", { grant, snapshotBinding, selection });
    const next = this.#grantBinding({ grant, snapshotBinding, selection });
    this.#metrics.grantRegistrationCalls += 1;
    const existing = this.#grantBindings.get(grant.id);
    const pending = this.#pendingGrantBindings.get(grant.id);
    if ((existing && JSON.stringify(existing) !== JSON.stringify(next))
      || (pending && JSON.stringify(pending) !== JSON.stringify(next))) {
      fail("SNAPSHOT_GRANT_CHANGED", "An existing WhatsApp snapshot grant cannot be widened or rebound.");
    }
    if (this.#revokedGrants.has(grant.id)) fail("SNAPSHOT_GRANT_REVOKED", "That WhatsApp snapshot grant was revoked and cannot be restored.");
    this.#grantBindings.set(grant.id, next);
    this.#pendingGrantBindings.delete(grant.id);
    return { registered: true, idempotent: Boolean(existing) };
  }

  async #revokePermissionGrant({ grantId, snapshotBinding }) {
    assertLocalWhatsAppSnapshotLifecycleOperationAuthorized(this, "revokePermissionGrant", { grantId, snapshotBinding });
    this.#assertBinding(snapshotBinding);
    if (!SAFE_REF.test(grantId)) fail("SNAPSHOT_GRANT_INVALID", "The WhatsApp snapshot grant identifier is invalid.");
    if (!this.#revokedGrants.has(grantId)) {
      this.#metrics.grantRevocationCalls += 1;
      this.#revokedGrants.add(grantId);
      this.#pendingGrantBindings.delete(grantId);
      this.#grantBindings.delete(grantId);
    }
    return { revoked: true };
  }

  async preparePermissionGrant() {
    fail("WHATSAPP_LIFECYCLE_CAPABILITY_REQUIRED", "Local snapshot grants can only be prepared by the durable permission lifecycle.");
  }

  async registerPermissionGrant() {
    fail("WHATSAPP_LIFECYCLE_CAPABILITY_REQUIRED", "Local snapshot grants can only be activated by the durable permission lifecycle.");
  }

  async revokePermissionGrant() {
    fail("WHATSAPP_LIFECYCLE_CAPABILITY_REQUIRED", "Local snapshot grants can only be revoked by the durable permission lifecycle.");
  }

  async #assertManifestUnchanged() {
    const roots = await this.#canonicalRoots();
    const opened = await this.#openBoundedFile(this.#manifestPath, {
      maximumBytes: this.#limits.manifestBytes,
      expectedSha256: this.#ready.manifestSha256,
      roots,
      kind: "manifest"
    });
    this.#metrics.manifestReads += 1;
    opened.bytes.fill(0);
  }

  async #resolveBundleFile(relativePath, expectedSuffix) {
    validateRelativeFile(relativePath, this.#limits, expectedSuffix);
    const candidate = path.resolve(this.#ready.bundleRoot, relativePath);
    if (!isWithin(candidate, this.#ready.bundleRoot)) fail("SNAPSHOT_PATH_ESCAPE", "A snapshot content path escapes its bundle.");
    return candidate;
  }

  #validateMediaMetadata(media, { inventory = false } = {}) {
    assertAllowedKeys(media, inventory
      ? ["id", "segmentId", "messageId", "path", "sha256", "bytes", "mimeType"]
      : ["id", "path", "sha256", "bytes", "mimeType"], "media");
    const rawId = requiredString(media.id, "media id");
    const relativePath = validateRelativeFile(media.path, this.#limits, ".bin");
    if (!SHA256.test(media.sha256)) fail("SNAPSHOT_SCHEMA_INVALID", "A media digest is malformed.");
    const bytes = requiredInteger(media.bytes, 1, this.#limits.mediaFileBytes, "media bytes");
    const mimeType = requiredString(media.mimeType, "media type");
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i.test(mimeType)
      || !SAFE_MEDIA_MIME_TYPES.has(mimeType.toLowerCase())) {
      fail("SNAPSHOT_MEDIA_TYPE_UNKNOWN", "A selected media item has a missing, malformed, or unsupported safe media type.");
    }
    return { rawId, relativePath, sha256: media.sha256, bytes, mimeType };
  }

  async #readInventoryMedia(media) {
    await this.#assertManifestUnchanged();
    const candidate = await this.#resolveBundleFile(media.relativePath, ".bin");
    const opened = await this.#openBoundedFile(candidate, {
      maximumBytes: this.#limits.mediaFileBytes,
      expectedBytes: media.bytes,
      expectedSha256: media.sha256,
      roots: this.#ready.roots,
      kind: "media"
    });
    this.#metrics.mediaFileReads += 1;
    this.#metrics.rawMediaBodiesRead += 1;
    opened.bytes.fill(0);
    return media.ref;
  }

  #approvedPlan(normalized) {
    const segmentUnits = [];
    const selectedSegmentRefs = new Set();
    for (const chatRef of normalized.chatRefs) {
      const chat = this.#ready.chatsByAlias.get(chatRef);
      const segments = chat.segments
        .filter((segment) => Date.parse(segment.from) >= Date.parse(normalized.from) && Date.parse(segment.to) <= Date.parse(normalized.to))
        .sort((left, right) => Date.parse(left.from) - Date.parse(right.from) || left.ref.localeCompare(right.ref));
      for (const segment of segments) {
        selectedSegmentRefs.add(segment.ref);
        segmentUnits.push({ phase: "segment", unitRef: segment.ref, chatRef, segmentRef: segment.ref });
      }
    }
    const mediaUnits = normalized.includeMedia ? normalized.chatRefs.flatMap((chatRef) => {
      const chat = this.#ready.chatsByAlias.get(chatRef);
      return chat.mediaInventory
        .filter((media) => selectedSegmentRefs.has(media.segmentRef))
        .sort((left, right) => `${left.segmentRef}:${left.messageRef}:${left.ref}`.localeCompare(`${right.segmentRef}:${right.messageRef}:${right.ref}`))
        .map((media) => ({
          phase: "media",
          unitRef: media.ref,
          chatRef,
          segmentRef: media.segmentRef,
          messageRef: media.messageRef,
          mediaRef: media.ref
        }));
    }) : [];
    const units = [...segmentUnits, ...mediaUnits].map((unit, index) => Object.freeze({ ...unit, index }));
    const planBinding = `wa-fetch-plan-${hash(JSON.stringify({
      snapshotId: this.#ready.binding.snapshotId,
      selectionDigest: normalized.selectionDigest,
      mediaInventoryBinding: normalized.mediaInventoryBinding,
      units
    })).slice(0, 24)}`;
    return Object.freeze({
      protocol: "qwave.whatsapp-snapshot-fetch-plan/v1",
      planBinding,
      selectionDigest: normalized.selectionDigest,
      mediaInventoryBinding: normalized.mediaInventoryBinding,
      units: Object.freeze(units)
    });
  }

  #createApprovedFetchPlan({ snapshotBinding, selection } = {}) {
    this.#assertBinding(snapshotBinding);
    return clone(this.#approvedPlan(this.#validateSelection(selection)));
  }

  createApprovedFetchPlan(request) {
    return this.#createApprovedFetchPlan(request);
  }

  #safeReceipt(plan, unit, records) {
    const receiptCore = {
      protocol: "qwave.whatsapp-snapshot-fetch-receipt/v1",
      planBinding: plan.planBinding,
      index: unit.index,
      unitRef: unit.unitRef,
      phase: unit.phase,
      records: clone(records)
    };
    return Object.freeze({
      ...receiptCore,
      receiptBinding: `wa-fetch-receipt-${hash(JSON.stringify(receiptCore)).slice(0, 24)}`
    });
  }

  #assertCompletedReceipts(plan, receipts, nextIndex) {
    if (!Array.isArray(receipts) || receipts.length !== nextIndex) {
      fail("SNAPSHOT_FETCH_CURSOR_INVALID", "The durable WhatsApp snapshot cursor is incomplete or out of order, so I did not read another body.");
    }
    const priorSegmentMessageRefs = new Set();
    receipts.forEach((receipt, index) => {
      const unit = plan.units[index];
      if (!unit || receipt?.protocol !== "qwave.whatsapp-snapshot-fetch-receipt/v1"
        || receipt.planBinding !== plan.planBinding || receipt.index !== index
        || receipt.unitRef !== unit.unitRef || receipt.phase !== unit.phase
        || !Array.isArray(receipt.records)) {
        fail("SNAPSHOT_FETCH_CURSOR_INVALID", "A durable WhatsApp snapshot receipt does not match the exact approved plan.");
      }
      const expected = this.#safeReceipt(plan, unit, receipt.records);
      if (receipt.receiptBinding !== expected.receiptBinding) {
        fail("SNAPSHOT_FETCH_CURSOR_INVALID", "A durable WhatsApp snapshot receipt binding is invalid.");
      }
      for (const record of receipt.records) {
        const allowedRecordKeys = unit.phase === "media" ? ["sourceRecordId", "source", "mediaReferenceIds"] : ["sourceRecordId", "source"];
        if (!record || record.source !== "whatsapp" || !/^wa-message-[a-f0-9]{20}$/.test(record.sourceRecordId)
          || Object.keys(record).some((key) => !allowedRecordKeys.includes(key))) {
          fail("SNAPSHOT_FETCH_CURSOR_INVALID", "A durable WhatsApp snapshot receipt contains an invalid record reference.");
        }
        if (unit.phase === "segment") {
          if (priorSegmentMessageRefs.has(record.sourceRecordId)) {
            fail("SNAPSHOT_IDENTIFIER_AMBIGUOUS", "The selected snapshot contains a duplicate message identifier across segments.");
          }
          priorSegmentMessageRefs.add(record.sourceRecordId);
        } else if (receipt.records.length !== 1 || record.sourceRecordId !== unit.messageRef
          || !Array.isArray(record.mediaReferenceIds) || record.mediaReferenceIds.length !== 1
          || record.mediaReferenceIds[0] !== unit.mediaRef) {
          fail("SNAPSHOT_FETCH_CURSOR_INVALID", "A durable media receipt does not exactly match its approved message and media unit.");
        }
      }
    });
    return priorSegmentMessageRefs;
  }

  #findPlanUnit(plan, fetchUnit) {
    if (!fetchUnit || fetchUnit.planBinding !== plan.planBinding || !Number.isSafeInteger(fetchUnit.index)) {
      fail("SNAPSHOT_FETCH_UNIT_INVALID", "The requested WhatsApp snapshot unit is not bound to the approved fetch plan.");
    }
    const unit = plan.units[fetchUnit.index];
    if (!unit || JSON.stringify(unit) !== JSON.stringify(fetchUnit.unit)) {
      fail("SNAPSHOT_FETCH_UNIT_INVALID", "The requested WhatsApp snapshot unit does not exactly match the approved fetch plan.");
    }
    return unit;
  }

  async #fetchApprovedContent({ source, accountId, grant, snapshotBinding, selection, fetchUnit, completedReceipts = [] }) {
    assertLocalWhatsAppSnapshotLifecycleOperationAuthorized(this, "fetchApprovedContent", {
      source,
      accountId,
      grant,
      snapshotBinding,
      selection,
      fetchUnit,
      completedReceipts
    });
    if (source !== "whatsapp" || accountId !== this.#accountRef) fail("SNAPSHOT_CONNECTOR_SUBSTITUTION", "The approved fetch does not match this WhatsApp snapshot account.");
    this.#assertBinding(snapshotBinding);
    const normalized = this.#validateSelection(selection);
    const registeredGrant = this.#grantBindings.get(grant?.id);
    if (!registeredGrant || this.#revokedGrants.has(grant.id)
      || registeredGrant.snapshotId !== snapshotBinding.snapshotId
      || registeredGrant.selectionDigest !== normalized.selectionDigest
      || registeredGrant.mediaInventoryBinding !== normalized.mediaInventoryBinding) {
      fail("SNAPSHOT_DURABLE_GRANT_REQUIRED", "The exact durable WhatsApp grant must be registered before any selected body can be opened.");
    }
    const plan = this.#approvedPlan(normalized);
    const unit = this.#findPlanUnit(plan, fetchUnit);
    const priorSegmentMessageRefs = this.#assertCompletedReceipts(plan, completedReceipts, unit.index);
    const cacheKey = `${grant.id}:${plan.planBinding}:${unit.index}:${unit.unitRef}`;
    await this.#assertManifestUnchanged();
    const cached = this.#fetchCache.get(cacheKey);
    if (cached) return clone(cached);

    const records = [];
    if (unit.phase === "segment") {
      const chat = this.#ready.chatsByAlias.get(unit.chatRef);
      const segment = chat?.segments.find((candidate) => candidate.ref === unit.segmentRef);
      if (!chat || !segment) fail("SNAPSHOT_FETCH_UNIT_INVALID", "The selected segment is no longer part of the immutable snapshot plan.");
      const expectedMediaByMessage = new Map();
      for (const media of chat.mediaInventory.filter((candidate) => candidate.segmentRef === segment.ref)) {
        const list = expectedMediaByMessage.get(media.rawMessageId) ?? [];
        list.push(media);
        expectedMediaByMessage.set(media.rawMessageId, list);
      }
      const seenRawMessages = new Set();
      const seenSegmentMessageRefs = new Set();
      try {
        await this.#assertManifestUnchanged();
        const candidate = await this.#resolveBundleFile(segment.relativePath, ".jsonl");
        const opened = await this.#openBoundedFile(candidate, {
          maximumBytes: this.#limits.recordFileBytes,
          expectedBytes: segment.bytes,
          expectedSha256: segment.sha256,
          roots: this.#ready.roots,
          kind: "records"
        });
        this.#metrics.recordFileReads += 1;
        try {
          const lines = decodeStrictUtf8(opened.bytes, "SNAPSHOT_RECORD_MALFORMED", "A selected snapshot segment is not valid UTF-8.").split("\n");
          if (lines.at(-1) === "") lines.pop();
          if (lines.length !== segment.count) fail("SNAPSHOT_RECORD_COUNT_MISMATCH", "A selected snapshot segment is truncated or has an unexpected record count.");
          for (const line of lines) {
            if (!line || Buffer.byteLength(line) > this.#limits.recordLineBytes) fail("SNAPSHOT_RECORD_LIMIT_EXCEEDED", "A selected snapshot record exceeds the private import limit.");
            let record;
            try { record = JSON.parse(line); } catch { fail("SNAPSHOT_RECORD_MALFORMED", "A selected snapshot record is malformed or truncated."); }
            assertAllowedKeys(record, ["id", "chatId", "senderId", "sentAt", "sensitivity", "text", "media"], "record");
            const rawId = requiredString(record.id, "message id");
            const messageRef = alias(this.#ready.generationSeed, "message", rawId);
            if (seenRawMessages.has(rawId) || seenSegmentMessageRefs.has(messageRef) || priorSegmentMessageRefs.has(messageRef)) {
              fail("SNAPSHOT_IDENTIFIER_AMBIGUOUS", "A selected snapshot contains a duplicate message identifier.");
            }
            seenRawMessages.add(rawId);
            seenSegmentMessageRefs.add(messageRef);
            if (requiredString(record.chatId, "message chat id") !== chat.rawId) fail("SNAPSHOT_RECORD_CHAT_MISMATCH", "A selected record is bound to a different chat.");
            const senderId = requiredString(record.senderId, "message sender id");
            if (!chat.participantRawIds.includes(senderId)) fail("SNAPSHOT_RECORD_PARTICIPANT_MISMATCH", "A selected record has an unknown participant.");
            const sentAt = strictIso(record.sentAt);
            if (Date.parse(sentAt) < Date.parse(segment.from) || Date.parse(sentAt) > Date.parse(segment.to)
              || Date.parse(sentAt) < Date.parse(normalized.from) || Date.parse(sentAt) > Date.parse(normalized.to)
              || Date.parse(sentAt) > Date.parse(this.#ready.binding.capturedAt)) {
              fail("SNAPSHOT_RECORD_TIMESTAMP_INVALID", "A selected record falls outside its approved date, segment, or capture boundary.");
            }
            if (!SENSITIVITIES.has(record.sensitivity) || record.sensitivity !== chat.sensitivity) {
              fail("SNAPSHOT_RECORD_SENSITIVITY_MISMATCH", "A selected record has missing, unknown, or mismatched sensitivity metadata.");
            }
            if (typeof record.text !== "string" || Buffer.byteLength(record.text) > this.#limits.messageTextBytes) {
              fail("SNAPSHOT_RECORD_LIMIT_EXCEEDED", "A selected message body is malformed or exceeds the private import limit.");
            }
            if (!Array.isArray(record.media)) fail("SNAPSHOT_MEDIA_UNKNOWN", "A selected record is missing its explicit media list.");
            const expectedMedia = expectedMediaByMessage.get(rawId) ?? [];
            const seenMediaIds = new Set();
            const actualMedia = [];
            for (const media of record.media) {
              const normalizedMedia = this.#validateMediaMetadata(media);
              if (seenMediaIds.has(normalizedMedia.rawId)) fail("SNAPSHOT_IDENTIFIER_AMBIGUOUS", "A selected record contains a duplicate media identifier.");
              seenMediaIds.add(normalizedMedia.rawId);
              actualMedia.push(normalizedMedia);
            }
            const canonicalMedia = (media) => ({
              rawId: media.rawId,
              relativePath: media.relativePath,
              sha256: media.sha256,
              bytes: media.bytes,
              mimeType: media.mimeType
            });
            const actualBinding = actualMedia.map(canonicalMedia).sort((left, right) => left.rawId.localeCompare(right.rawId));
            const expectedBinding = expectedMedia.map(canonicalMedia).sort((left, right) => left.rawId.localeCompare(right.rawId));
            if (JSON.stringify(actualBinding) !== JSON.stringify(expectedBinding)) {
              if (chat.media === "none" && actualBinding.length > 0) {
                fail("SNAPSHOT_MEDIA_DECLARATION_MISMATCH", "A selected record contains media that was not declared during metadata review.");
              }
              fail("SNAPSHOT_MEDIA_BINDING_MISMATCH", "A selected record media set does not exactly match its body-free manifest inventory.");
            }
            this.#metrics.rawMessageBodiesRead += 1;
            records.push({
              sourceRecordId: messageRef,
              source: "whatsapp"
            });
          }
          for (const rawMessageId of expectedMediaByMessage.keys()) {
            if (!seenRawMessages.has(rawMessageId)) {
              fail("SNAPSHOT_MEDIA_BINDING_MISMATCH", "A manifest media item is bound to a message missing from its declared segment.");
            }
          }
        } finally {
          opened.bytes.fill(0);
        }
      } catch (error) {
        throw error;
      }
    } else if (unit.phase === "media") {
      const chat = this.#ready.chatsByAlias.get(unit.chatRef);
      const media = chat?.mediaInventory.find((candidate) => candidate.ref === unit.mediaRef
        && candidate.segmentRef === unit.segmentRef && candidate.messageRef === unit.messageRef);
      if (!media) fail("SNAPSHOT_MEDIA_BINDING_MISMATCH", "The selected media unit is no longer bound to its reviewed chat, segment, and message.");
      const segmentUnits = plan.units.filter((candidate) => candidate.phase === "segment");
      if (completedReceipts.length < segmentUnits.length) {
        fail("SNAPSHOT_MEDIA_BEFORE_SEGMENTS", "All selected message segments must be durably validated before any media file can open.");
      }
      if (!priorSegmentMessageRefs.has(media.messageRef)) {
        fail("SNAPSHOT_MEDIA_BINDING_MISMATCH", "The selected media message was not present in the durably validated segment receipts.");
      }
      const mediaRef = await this.#readInventoryMedia(media);
      records.push({ sourceRecordId: media.messageRef, source: "whatsapp", mediaReferenceIds: [mediaRef] });
    } else {
      fail("SNAPSHOT_FETCH_UNIT_INVALID", "The approved WhatsApp snapshot unit has an unsupported phase.");
    }
    const frozenRecords = Object.freeze(records.map((record) => Object.freeze(record)));
    const result = Object.freeze({
      records: frozenRecords,
      rawBodiesReturned: false,
      fetchCheckpoint: this.#safeReceipt(plan, unit, frozenRecords)
    });
    this.#fetchCache.set(cacheKey, result);
    return clone(result);
  }

  async fetchApprovedContent() {
    fail("WHATSAPP_LIFECYCLE_CAPABILITY_REQUIRED", "Local snapshot content can only be read by the durable permission lifecycle.");
  }

  #cleanupPrivateMemory() {
    this.#ready = null;
    this.#pendingGrantBindings.clear();
    this.#grantBindings.clear();
    this.#revokedGrants.clear();
    this.#fetchCache.clear();
    return {
      memoryCleared: true,
      sourceFilesDeleted: false,
      stagingFilesCreated: false,
      processExitCleanupClaimed: false
    };
  }

  cleanupPrivateMemory() {
    return this.#cleanupPrivateMemory();
  }
}
