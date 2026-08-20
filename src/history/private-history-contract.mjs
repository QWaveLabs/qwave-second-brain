/**
 * QWA-154 preflight contract.
 *
 * This module plans a customer-owned history mode without initializing Git,
 * writing a checkpoint, cloning, pushing, or restoring files. Those mutations
 * remain blocked on QWA-154's dependency evidence. It makes the privacy gate
 * testable now: a remote is usable only after private visibility is read back.
 */

export const HISTORY_MODES = Object.freeze(["local-only", "private-remote"]);
export const CHECKPOINT_KINDS = Object.freeze(["build", "refresh", "migration", "restore", "purge"]);

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function safeRemoteReference(remote) {
  return typeof remote?.reference === "string" && remote.reference.length > 0 && remote.reference.length <= 240
    ? remote.reference
    : null;
}

/**
 * Returns a customer-safe result. It intentionally does not echo a remote
 * address, because a private repository locator can be sensitive setup state.
 */
export function planPrivateHistory({ mode, remote } = {}) {
  if (!HISTORY_MODES.includes(mode)) {
    throw new TypeError("mode must be 'local-only' or 'private-remote'.");
  }

  if (mode === "local-only") {
    return {
      status: "ready",
      mode,
      remoteStatus: "not-configured",
      mayInitializeLocalHistory: true,
      mayPush: false,
      message: "Your private history can stay on this Mac. No remote backup will be created."
    };
  }

  const privateReadback = remote?.visibility === "private" && isIsoTimestamp(remote?.verifiedAt) && safeRemoteReference(remote);
  if (!privateReadback) {
    return {
      status: "blocked",
      mode,
      remoteStatus: remote?.visibility === "public" ? "public" : "unverified",
      mayInitializeLocalHistory: false,
      mayPush: false,
      message: "I could not verify a private remote for your second brain, so I stopped before creating history or pushing anything.",
      nextAction: "Choose local-only history or ask QWave to verify the approved private remote before continuing."
    };
  }

  return {
    status: "ready",
    mode,
    remoteStatus: "private-verified",
    mayInitializeLocalHistory: true,
    mayPush: true,
    message: "I verified the approved private remote before any history or backup push."
  };
}

/**
 * Generates a human-readable checkpoint intent. A future private-history
 * adapter must create and read back the checkpoint before this becomes a
 * customer-visible backup or restore claim.
 */
export function planHistoryCheckpoint({ kind } = {}) {
  if (!CHECKPOINT_KINDS.includes(kind)) {
    throw new TypeError("kind must be build, refresh, migration, restore, or purge.");
  }
  return {
    kind,
    label: `Second Brain ${kind} checkpoint`,
    requiresReadback: true,
    customerMessage: `I will create and verify a private ${kind} checkpoint before changing your brain.`
  };
}
