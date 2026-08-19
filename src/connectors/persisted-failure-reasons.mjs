/**
 * Fixed failure reasons shared by connector writers and loaded-root migration.
 *
 * This module is deliberately connector-independent so source-status can
 * normalize recognized legacy audit events without importing connector
 * modules that already depend on source-status. Unknown event types remain
 * untouched; recognized events never retain an adapter-provided error code.
 */

export const DRIVE_FAILURE_REASONS = Object.freeze({
  METADATA_REVIEW: "DRIVE_METADATA_REVIEW_FAILED",
  APPROVED_FETCH: "DRIVE_APPROVED_FETCH_FAILED",
  APPROVED_FETCH_AUTHORIZATION_REVOKED: "DRIVE_APPROVED_FETCH_AUTHORIZATION_REVOKED"
});
const ALLOWED_DRIVE_FAILURE_REASONS = new Set(Object.values(DRIVE_FAILURE_REASONS));

export function driveFailureReason(reason) {
  if (!ALLOWED_DRIVE_FAILURE_REASONS.has(reason)) {
    throw new TypeError("A fixed Drive failure reason is required.");
  }
  return reason;
}

export function sanitizePersistedDriveFailureReasons(entry) {
  let changed = false;
  for (const event of Array.isArray(entry?.audit) ? entry.audit : []) {
    if (event?.type === "drive-metadata-review-unavailable") {
      const expected = driveFailureReason(DRIVE_FAILURE_REASONS.METADATA_REVIEW);
      if (event.reason !== expected) {
        event.reason = expected;
        changed = true;
      }
    }
    if (event?.type === "drive-approved-reference-fetch-interrupted") {
      const expected = driveFailureReason(entry.status === "revoked"
        ? DRIVE_FAILURE_REASONS.APPROVED_FETCH_AUTHORIZATION_REVOKED
        : DRIVE_FAILURE_REASONS.APPROVED_FETCH);
      if (event.reason !== expected) {
        event.reason = expected;
        changed = true;
      }
    }
  }
  return changed;
}

export const IMESSAGE_FAILURE_REASONS = Object.freeze({
  METADATA_REVIEW: "IMESSAGE_METADATA_REVIEW_FAILED"
});
const ALLOWED_IMESSAGE_FAILURE_REASONS = new Set(Object.values(IMESSAGE_FAILURE_REASONS));

export function iMessageFailureReason(reason) {
  if (!ALLOWED_IMESSAGE_FAILURE_REASONS.has(reason)) {
    throw new TypeError("A fixed iMessage failure reason is required.");
  }
  return reason;
}

export function sanitizePersistedIMessageEntryFailureReasons(entry) {
  let changed = false;
  for (const event of Array.isArray(entry?.audit) ? entry.audit : []) {
    if (event?.type !== "imessage-metadata-review-unavailable") continue;
    const expected = iMessageFailureReason(IMESSAGE_FAILURE_REASONS.METADATA_REVIEW);
    if (event.reason !== expected) {
      event.reason = expected;
      changed = true;
    }
  }
  return changed;
}

export function sanitizePersistedIMessageRootFailureReasons(state) {
  let changed = false;
  for (const event of Array.isArray(state?.imessageBetaLifecycle?.audit)
    ? state.imessageBetaLifecycle.audit
    : []) {
    if (event?.type !== "imessage-snapshot-fallback-available") continue;
    if (event.reason === "denied" || event.reason === "unavailable") continue;
    const expected = iMessageFailureReason(IMESSAGE_FAILURE_REASONS.METADATA_REVIEW);
    if (event.reason !== expected) {
      event.reason = expected;
      changed = true;
    }
  }
  return changed;
}
