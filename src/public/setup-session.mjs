/**
 * QWA-138 public Setup Session seam.
 *
 * This module intentionally knows nothing about real macOS, Obsidian, connectors,
 * Git, or support transport. Those concerns arrive through injected adapters in
 * later vertical slices. The public functions below are the customer journey
 * boundary exercised by the black-box tests.
 */

import { randomUUID } from "node:crypto";
import {
  buildQWaveSupportRelayRequest,
  buildSanitizedQWaveSupportReport,
  deliverQWaveSupportReport,
  sanitizeSupportEnvironment
} from "../support/qwave-support-escalation.mjs";

export const SETUP_STAGES = Object.freeze([
  "environment",
  "obsidian",
  "foundation",
  "vault",
  "validation"
]);

export const BOOTSTRAP_EXAMPLES = Object.freeze({
  en: "Set up my second brain",
  es: "Configura mi segundo cerebro"
});

const DEFAULTS = Object.freeze({
  displayName: "there",
  focus: "a calmer daily command center",
  vaultName: "My Second Brain"
});

const OFFICIAL_OBSIDIAN_DOWNLOAD_URL = "https://obsidian.md/download";
const OFFICIAL_INSTALL_APPROVAL = "approve-official-obsidian-install";
export const SUPPORT_SAFE_REPAIR_ATTEMPT_LIMIT = 2;
export const CONTACT_QWAVE_SUPPORT_ACTION = "contact-qwave-support";
const SUPPORT_DELIVERY_ATTEMPT_LIMIT = 99;

/*
 * Local setup state is recoverable customer-owned data, not a receipt store.
 * Keep the evidence that *this running process* observed a relay acknowledgement
 * out of that mutable state. On a later process, an old delivery is retained as
 * an honest local report but is never re-presented as a verified send without a
 * host-verifiable receipt (which the production relay has not supplied yet).
 */
const TRUSTED_SUPPORT_ATTEMPTS = new WeakMap();

class CustomerVisibleError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "CustomerVisibleError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

class CustomerActionRequired extends Error {
  constructor({ status, pendingAction }) {
    super(pendingAction.message);
    this.name = "CustomerActionRequired";
    this.status = status;
    this.pendingAction = pendingAction;
  }
}

function assertNaturalLanguageBootstrap(message) {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new CustomerVisibleError(
      "BOOTSTRAP_MESSAGE_REQUIRED",
      "Tell me you would like to set up your second brain, and I’ll guide you from there."
    );
  }

  const normalized = message.trim();
  if (normalized.startsWith("/")) {
    throw new CustomerVisibleError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Just tell me you would like to set up your second brain."
    );
  }

  const asksForSetup = /second\s+brain|segundo\s+cerebro/i.test(normalized);
  if (!asksForSetup) {
    throw new CustomerVisibleError(
      "UNRECOGNIZED_BOOTSTRAP",
      "I can help with that. To begin, say “Set up my second brain.”"
    );
  }
}

function assertDependencies({ stateStore, adapters }) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent stateStore with load() and save() is required.");
  }
  if (!adapters?.environment || typeof adapters.environment.inspect !== "function") {
    throw new TypeError("An environment adapter with inspect() is required.");
  }
  if (
    !adapters?.obsidian
    || typeof adapters.obsidian.inspect !== "function"
    || typeof adapters.obsidian.createOfficialInstallAction !== "function"
    || typeof adapters.obsidian.verifyVaultOpen !== "function"
  ) {
    throw new TypeError(
      "An Obsidian adapter with inspect(), createOfficialInstallAction(), and verifyVaultOpen() is required."
    );
  }
  if (
    !adapters?.vault
    || typeof adapters.vault.planDesktopVault !== "function"
    || typeof adapters.vault.ensureVault !== "function"
    || typeof adapters.vault.inspect !== "function"
  ) {
    throw new TypeError("A vault adapter with planDesktopVault(), ensureVault(), and inspect() is required.");
  }
}

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultSupportState() {
  return {
    environment: sanitizeSupportEnvironment(),
    repair: null,
    escalation: null
  };
}

function trustFor(stateStore) {
  let trust = TRUSTED_SUPPORT_ATTEMPTS.get(stateStore);
  if (!trust) {
    trust = {
      deliveryKeys: new Set(),
      automaticEscalationFingerprints: new Set(),
      repairAttemptsByFingerprint: new Map()
    };
    TRUSTED_SUPPORT_ATTEMPTS.set(stateStore, trust);
  }
  return trust;
}

function escalationTrustKey(escalation) {
  if (!isPlainRecord(escalation) || !isPlainRecord(escalation.delivery)) return null;
  return JSON.stringify({
    fingerprint: escalation.fingerprint,
    report: escalation.report,
    delivery: {
      status: escalation.delivery.status,
      code: escalation.delivery.code,
      attemptedAt: escalation.delivery.attemptedAt
    }
  });
}

function hasTrustedDeliveryReceipt(stateStore, escalation) {
  const key = escalationTrustKey(escalation);
  return Boolean(key && stateStore && trustFor(stateStore).deliveryKeys.has(key));
}

function recordTrustedDeliveryReceipt(stateStore, escalation) {
  const key = escalationTrustKey(escalation);
  if (key && stateStore) trustFor(stateStore).deliveryKeys.add(key);
}

function trustedRepairAttempts(stateStore, fingerprint) {
  return stateStore ? trustFor(stateStore).repairAttemptsByFingerprint.get(fingerprint) ?? 0 : 0;
}

function hasAutomaticEscalationAttempt(stateStore, fingerprint) {
  return Boolean(stateStore && trustFor(stateStore).automaticEscalationFingerprints.has(fingerprint));
}

function recordAutomaticEscalationAttempt(stateStore, fingerprint) {
  if (stateStore) trustFor(stateStore).automaticEscalationFingerprints.add(fingerprint);
}

/**
 * Support state is deliberately separate from the ordinary blocker. The
 * blocker remains local customer-facing setup state; this record contains
 * only bounded facts that are permitted to enter a QWave support report.
 */
function ensureSupportState(state) {
  let changed = false;
  if (!isPlainRecord(state.support)) {
    state.support = defaultSupportState();
    changed = true;
  }
  if (!isPlainRecord(state.support.environment)) {
    state.support.environment = sanitizeSupportEnvironment();
    changed = true;
  } else {
    const sanitizedEnvironment = sanitizeSupportEnvironment(state.support.environment);
    if (
      sanitizedEnvironment.macOSVersion !== state.support.environment.macOSVersion
      || sanitizedEnvironment.architecture !== state.support.environment.architecture
      || sanitizedEnvironment.timezone !== state.support.environment.timezone
    ) {
      state.support.environment = sanitizedEnvironment;
      changed = true;
    }
  }
  if (!(state.support.repair === null || isPlainRecord(state.support.repair))) {
    state.support.repair = null;
    changed = true;
  }
  if (!(state.support.escalation === null || isPlainRecord(state.support.escalation))) {
    state.support.escalation = null;
    changed = true;
  }
  return changed;
}

function safeBlockerFingerprint(blocker) {
  const stage = SETUP_STAGES.includes(blocker?.stage) ? blocker.stage : "environment";
  const code = typeof blocker?.code === "string" && /^[A-Z0-9_]{3,80}$/.test(blocker.code)
    ? blocker.code
    : "SAFE_RETRY_REQUIRED";
  return `${stage}:${code}`;
}

const SUPPORT_DELIVERY_CODES = new Set([
  "SUPPORT_REPORT_DELIVERED",
  "SUPPORT_RELAY_UNAVAILABLE",
  "SUPPORT_REPORT_SCHEMA_INVALID",
  "SUPPORT_RECIPIENTS_FIXED",
  "SUPPORT_REPORT_TOO_LARGE",
  "SUPPORT_REPORT_RATE_LIMITED",
  "SUPPORT_REPORT_DUPLICATE",
  "SUPPORT_DELIVERY_UNVERIFIED"
]);

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Persisted setup state is local, mutable input. Treat an escalation as
 * authoritative only when every bounded field still matches the active
 * blocker and the report can pass the same fixed-recipient relay contract
 * used before a delivery attempt. This deliberately fails closed: a malformed
 * or mismatched record remains private history but cannot claim delivery or
 * suppress an explicit or automatic retry for the current blocker.
 */
function validStoredEscalationForBlocker(state, blocker) {
  const escalation = state.support?.escalation;
  const fingerprint = safeBlockerFingerprint(blocker);
  if (!isPlainRecord(escalation) || escalation.fingerprint !== fingerprint) return null;
  if (
    escalation.reason !== "customer-requested"
    && escalation.reason !== "safe-repairs-exhausted"
  ) return null;
  if (!isIsoTimestamp(escalation.localReportRetainedAt)) return null;
  if (!isPlainRecord(escalation.delivery)) return null;

  const { delivery } = escalation;
  if (
    (delivery.status !== "sent" && delivery.status !== "delivery-unverified")
    || !SUPPORT_DELIVERY_CODES.has(delivery.code)
    || !isIsoTimestamp(delivery.attemptedAt)
    || !Number.isInteger(delivery.attempts)
    || delivery.attempts < 1
    || delivery.attempts > SUPPORT_DELIVERY_ATTEMPT_LIMIT
    || (delivery.status === "sent" && delivery.code !== "SUPPORT_REPORT_DELIVERED")
    || (delivery.status === "delivery-unverified" && delivery.code === "SUPPORT_REPORT_DELIVERED")
  ) return null;

  try {
    buildQWaveSupportRelayRequest({ report: escalation.report });
    const expectedReport = buildSanitizedQWaveSupportReport({
      installationId: state.installationId,
      environment: state.support.environment,
      blocker,
      repairAttempts: escalation.report.repairAttempts,
      clock: { now: () => escalation.report.occurredAt }
    });
    return JSON.stringify(escalation.report) === JSON.stringify(expectedReport)
      ? escalation
      : null;
  } catch {
    return null;
  }
}

function recordSafeRepairFailure(state, blocker, clock, stateStore) {
  ensureSupportState(state);
  const fingerprint = safeBlockerFingerprint(blocker);
  const attempts = Math.min(trustedRepairAttempts(stateStore, fingerprint) + 1, SUPPORT_SAFE_REPAIR_ATTEMPT_LIMIT);
  trustFor(stateStore).repairAttemptsByFingerprint.set(fingerprint, attempts);
  state.support.repair = {
    fingerprint,
    stage: blocker.stage,
    code: blocker.code,
    attempts,
    safeActions: [{ id: "resume-blocked-setup-stage", outcome: "failed" }],
    lastAttemptedAt: isoNow(clock)
  };
  return state.support.repair;
}

function clearResolvedSupportRepair(state, stage, stateStore) {
  ensureSupportState(state);
  if (state.support.repair?.stage === stage) {
    state.support.repair = null;
  }
  if (stateStore) {
    for (const fingerprint of trustFor(stateStore).repairAttemptsByFingerprint.keys()) {
      if (fingerprint.startsWith(`${stage}:`)) {
        trustFor(stateStore).repairAttemptsByFingerprint.delete(fingerprint);
      }
    }
  }
}

async function escalateQWaveSupport(state, { adapters, stateStore, clock, reason }) {
  ensureSupportState(state);
  const blocker = state.blocker;
  if (!blocker) return null;

  const fingerprint = safeBlockerFingerprint(blocker);
  const previous = validStoredEscalationForBlocker(state, blocker);
  if (previous && hasTrustedDeliveryReceipt(stateStore, previous)) {
    return previous;
  }

  const report = buildSanitizedQWaveSupportReport({
    installationId: state.installationId,
    environment: state.support.environment,
    blocker,
    repairAttempts: Math.max(1, trustedRepairAttempts(stateStore, fingerprint)),
    clock
  });
  const delivery = await deliverQWaveSupportReport({
    relay: adapters.support,
    report,
    clock
  });
  const priorAttempts = previous?.fingerprint === fingerprint && Number.isInteger(previous.delivery?.attempts)
    ? previous.delivery.attempts
    : 0;
  state.support.escalation = {
    fingerprint,
    reason: reason === "customer-requested" ? "customer-requested" : "safe-repairs-exhausted",
    report,
    localReportRetainedAt: isoNow(clock),
    delivery: {
      status: delivery.status,
      code: delivery.code,
      attemptedAt: delivery.attemptedAt,
      attempts: Math.min(priorAttempts + 1, SUPPORT_DELIVERY_ATTEMPT_LIMIT)
    }
  };
  if (delivery.status === "sent") {
    recordTrustedDeliveryReceipt(stateStore, state.support.escalation);
  }
  if (reason !== "customer-requested") {
    recordAutomaticEscalationAttempt(stateStore, fingerprint);
  }
  return state.support.escalation;
}

function publicSupportStatus(state, { stateStore } = {}) {
  const activeFingerprint = state.status === "blocked"
    ? safeBlockerFingerprint(state.blocker)
    : null;
  const escalation = activeFingerprint
    ? validStoredEscalationForBlocker(state, state.blocker)
    : null;
  if (!escalation) {
    return {
      status: "not-requested",
      deliveryVerified: false,
      localReportRetained: false,
      message: null
    };
  }

  const delivered = escalation.delivery?.status === "sent" && hasTrustedDeliveryReceipt(stateStore, escalation);
  return {
    status: delivered ? "sent" : "delivery-unverified",
    deliveryVerified: delivered,
    localReportRetained: true,
    message: delivered
      ? "I sent a sanitized setup report to QWave support. It did not include your source content, contacts, prompts, credentials, or local file paths."
      : "I saved a sanitized setup report locally, but I could not verify delivery to QWave support. Your completed setup progress is still saved."
  };
}

function isExplicitSupportRequest({ message, action }) {
  if (action?.kind === CONTACT_QWAVE_SUPPORT_ACTION) return true;
  if (typeof message !== "string") return false;
  return /\b(?:contact|email|send|notify)\s+(?:qwave\s+)?support\b/i.test(message);
}

function defaultInstallationId() {
  return `qsb-${randomUUID()}`;
}

function isSpanish(message) {
  return /segundo\s+cerebro|configura|configurar/i.test(message);
}

function safeVaultName(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  const name = candidate || DEFAULTS.vaultName;
  if (name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new CustomerVisibleError(
      "VAULT_NAME_INVALID",
      "Choose a simple vault name without slashes so it stays safely inside your Desktop."
    );
  }
  return name.slice(0, 80);
}

function buildInitialState({ message, answers = {}, decisions = {}, clock, installationIdFactory }) {
  const language = decisions.language ?? (isSpanish(message) ? "es" : "en");
  const vaultName = safeVaultName(decisions.vaultName);
  const now = isoNow(clock);

  return {
    version: 4,
    installationId: (installationIdFactory ?? defaultInstallationId)(),
    status: "active",
    stage: "bootstrap",
    completedStages: [],
    answers: {
      displayName: answers.displayName ?? DEFAULTS.displayName,
      focus: answers.focus ?? DEFAULTS.focus
    },
    safeDecisions: {
      language,
      vaultName,
      useRecommendedSetup: decisions.useRecommendedSetup ?? true
    },
    validation: {},
    pendingAction: null,
    vault: null,
    blocker: null,
    support: defaultSupportState(),
    stageOutputs: {
      bootstrap: {
        stage: "bootstrap",
        progress: `0 of ${SETUP_STAGES.length} setup steps complete`,
        message: language === "es"
          ? "Perfecto. Vamos a configurar tu segundo cerebro paso a paso. Guardaré el progreso para que puedas continuar aquí si se interrumpe."
          : "Great. We’ll set up your second brain one step at a time. I’ll save your progress so you can continue here if anything interrupts us."
      }
    },
    createdAt: now,
    updatedAt: now
  };
}

/**
 * QWA-138 sessions may already have a simulated vault. Preserve that state, but
 * make the new Obsidian-detection and open-verification requirements run before
 * the session can remain complete under the QWA-140 contract.
 */
function upgradeStateForObsidianHandoff(state, clock) {
  let changed = false;

  if (!Array.isArray(state.completedStages)) {
    state.completedStages = [];
    changed = true;
  }
  if (!state.stageOutputs) {
    state.stageOutputs = {};
    changed = true;
  }
  if (!state.validation) {
    state.validation = {};
    changed = true;
  }
  if (!("pendingAction" in state)) {
    state.pendingAction = null;
    changed = true;
  }

  if ((state.version ?? 1) < 2) {
    state.version = 2;

    // Old validation did not prove an Obsidian open. Re-run only validation;
    // the already-created vault remains untouched and is not duplicated.
    if (state.completedStages.includes("validation")) {
      state.completedStages = state.completedStages.filter((stage) => stage !== "validation");
      delete state.stageOutputs.validation;
      delete state.validation.vault;
    }
    delete state.stageOutputs.complete;

    if (state.status === "complete") {
      state.status = "active";
      state.stage = state.completedStages.at(-1) ?? "bootstrap";
    }
    changed = true;
  }

  if (ensureSupportState(state)) {
    changed = true;
  }
  if ((state.version ?? 1) < 4) {
    state.version = 4;
    changed = true;
  }

  if (changed) {
    state.updatedAt = isoNow(clock);
  }
  return changed;
}

function applyPendingVaultRename(state, decisions, clock) {
  if (!decisions || typeof decisions.vaultName !== "string" || state.completedStages.includes("vault")) {
    return false;
  }
  const vaultName = safeVaultName(decisions.vaultName);
  if (vaultName === state.safeDecisions.vaultName) {
    return false;
  }
  state.safeDecisions.vaultName = vaultName;
  state.updatedAt = isoNow(clock);
  return true;
}

function stageOutput(stage, message, completed) {
  return {
    stage,
    progress: `${completed} of ${SETUP_STAGES.length} setup steps complete`,
    message
  };
}

function appendCompletedStage(state, stage, output, clock) {
  if (state.completedStages.includes(stage)) {
    return;
  }
  state.completedStages.push(stage);
  state.stage = stage;
  state.stageOutputs[stage] = output;
  state.updatedAt = isoNow(clock);
}

function addCompleteOutput(state, clock) {
  if (!state.stageOutputs.complete) {
    const isEs = state.safeDecisions.language === "es";
    state.stageOutputs.complete = {
      stage: "complete",
      progress: `${SETUP_STAGES.length} of ${SETUP_STAGES.length} setup steps complete`,
      message: isEs
        ? "Tu configuración mínima está lista. Tu bóveda y su estado están guardados y puedes continuar en esta misma conversación cuando quieras."
        : "Your minimal setup is ready. Your vault and its status are saved, and you can continue in this same conversation whenever you want."
    };
  }
  state.status = "complete";
  state.stage = "complete";
  state.blocker = null;
  state.updatedAt = isoNow(clock);
}

function buildHomeContent(state) {
  const isEs = state.safeDecisions.language === "es";
  if (isEs) {
    return `# Inicio\n\n## Enfoque actual\n\n${state.answers.focus}\n\n## Próximo paso\n\nVuelve a esta misma conversación y di: “Continúa configurando mi segundo cerebro”.\n`;
  }
  return `# Home\n\n## Current focus\n\n${state.answers.focus}\n\n## Next step\n\nReturn to this same conversation and say: “Continue setting up my second brain.”\n`;
}

function buildStatusContent(state) {
  const isEs = state.safeDecisions.language === "es";
  const status = isEs ? "Configuración mínima simulada completada" : "Minimal simulated setup complete";
  return `# System Status\n\n- ${status}\n- Installation ID: ${state.installationId}\n- Setup progress is persisted separately and revalidated before handoff\n- Connection status: No sources connected in this foundation slice\n`;
}

async function runEnvironmentStage(state, adapters, clock) {
  const environment = await adapters.environment.inspect();
  ensureSupportState(state);
  state.support.environment = sanitizeSupportEnvironment(environment);
  if (!environment?.supported) {
    throw new CustomerVisibleError(
      environment?.code ?? "UNSUPPORTED_ENVIRONMENT",
      environment?.customerMessage ?? "This setup needs a supported private Mac environment before it can continue."
    );
  }
  if (environment.sharedProfile === true || environment.profileKind === "shared") {
    throw new CustomerVisibleError(
      "SHARED_MAC_PROFILE",
      "This Mac account appears to be shared. To protect your private second brain, setup is paused until you use a private macOS user account."
    );
  }

  state.validation.environment = {
    supported: true,
    privateProfile: true,
    checkedAt: isoNow(clock),
    summary: environment.summary ?? "Supported simulated environment"
  };
  appendCompletedStage(
    state,
    "environment",
    stageOutput(
      "environment",
      state.safeDecisions.language === "es"
        ? "Tu entorno está listo para continuar con esta configuración guiada."
        : "Your environment is ready to continue with this guided setup.",
      1
    ),
    clock
  );
}

function isApprovedOfficialInstall(action) {
  return action?.kind === OFFICIAL_INSTALL_APPROVAL && action.approved === true;
}

function toExistingVaultCount(inspection) {
  return Array.isArray(inspection?.existingVaults) ? inspection.existingVaults.length : 0;
}

function existingVaultPaths(inspection) {
  return Array.isArray(inspection?.existingVaults)
    ? inspection.existingVaults.map((vault) => vault?.path).filter((path) => typeof path === "string")
    : [];
}

async function runObsidianStage(state, adapters, clock, action) {
  const inspection = await adapters.obsidian.inspect();
  const existingVaultCount = toExistingVaultCount(inspection);

  if (inspection?.installed && inspection?.official) {
    state.pendingAction = null;
    state.obsidian = {
      appPath: inspection.appPath ?? null,
      existingVaultPaths: existingVaultPaths(inspection),
      simulated: Boolean(inspection.simulated)
    };
    state.validation.obsidian = {
      detectedAt: isoNow(clock),
      official: true,
      appPath: inspection.appPath ?? null,
      existingVaultCount,
      existingVaultsReadOnly: true,
      simulated: Boolean(inspection.simulated)
    };
    appendCompletedStage(
      state,
      "obsidian",
      stageOutput(
        "obsidian",
        state.safeDecisions.language === "es"
          ? `Detecté Obsidian oficial y dejé ${existingVaultCount} bóveda${existingVaultCount === 1 ? " existente" : "s existentes"} sin modificar.`
          : `I detected official Obsidian and left ${existingVaultCount} existing vault${existingVaultCount === 1 ? "" : "s"} untouched.`,
        2
      ),
      clock
    );
    return;
  }

  if (inspection?.installed && inspection?.official === false) {
    throw new CustomerVisibleError(
      "OBSIDIAN_OFFICIAL_APP_REQUIRED",
      "I found an Obsidian app I cannot verify as official, so I stopped before using it. Please install the official Obsidian app and continue here."
    );
  }

  if (state.pendingAction?.kind === OFFICIAL_INSTALL_APPROVAL && state.pendingAction.status === "waiting_for_customer_action") {
    throw new CustomerActionRequired({
      status: "waiting_for_customer_action",
      pendingAction: state.pendingAction
    });
  }

  if (!isApprovedOfficialInstall(action)) {
    throw new CustomerActionRequired({
      status: "waiting_for_approval",
      pendingAction: {
        kind: OFFICIAL_INSTALL_APPROVAL,
        status: "waiting_for_approval",
        approvalRequired: true,
        message: state.safeDecisions.language === "es"
          ? "No encontré Obsidian. No instalaré nada sin tu aprobación. Confirma la instalación oficial de Obsidian para recibir un solo paso seguro."
          : "I did not find Obsidian. I will not install anything without your approval. Approve the official Obsidian installation to receive one safe next step."
      }
    });
  }

  const officialAction = await adapters.obsidian.createOfficialInstallAction({
    downloadUrl: OFFICIAL_OBSIDIAN_DOWNLOAD_URL
  });
  if (officialAction?.url !== OFFICIAL_OBSIDIAN_DOWNLOAD_URL) {
    throw new CustomerVisibleError(
      "OFFICIAL_INSTALL_ACTION_INVALID",
      "I could not confirm a safe official Obsidian installation action, so I stopped before asking you to install anything."
    );
  }

  throw new CustomerActionRequired({
    status: "waiting_for_customer_action",
    pendingAction: {
      kind: OFFICIAL_INSTALL_APPROVAL,
      status: "waiting_for_customer_action",
      approvalRequired: false,
      approvedAt: isoNow(clock),
      customerAction: {
        kind: officialAction.kind ?? "official-download-and-install",
        label: officialAction.label ?? "Install Obsidian from the official page",
        url: officialAction.url
      },
      message: state.safeDecisions.language === "es"
        ? "Aprobado. Haz este único paso: instala Obsidian desde la página oficial y luego di “Continúa configurando mi segundo cerebro”."
        : "Approved. Take this one step: install Obsidian from the official page, then say “Continue setting up my second brain.”"
    }
  });
}

async function runFoundationStage(state, clock) {
  state.validation.foundation = {
    capturedAt: isoNow(clock),
    hasFocus: Boolean(state.answers.focus),
    hasVaultName: Boolean(state.safeDecisions.vaultName)
  };
  appendCompletedStage(
    state,
    "foundation",
    stageOutput(
      "foundation",
      state.safeDecisions.language === "es"
        ? "Guardé tus decisiones iniciales y la recomendación de configuración."
        : "I saved your starting choices and the recommended setup direction.",
      3
    ),
    clock
  );
}

async function runVaultStage(state, adapters, clock) {
  const plannedVault = await adapters.vault.planDesktopVault({
    name: state.safeDecisions.vaultName,
    installationId: state.installationId
  });
  if (!plannedVault?.path) {
    throw new CustomerVisibleError(
      "VAULT_PLAN_INVALID",
      "I could not confirm a visible Desktop location for the new vault, so I stopped before creating anything."
    );
  }
  if (
    (!plannedVault.existingOwnedByInstallation && plannedVault.exists)
    || (!plannedVault.existingOwnedByInstallation && state.obsidian?.existingVaultPaths?.includes(plannedVault.path))
  ) {
    throw new CustomerVisibleError(
      "VAULT_PATH_ALREADY_EXISTS",
      "I found an existing vault at that Desktop location. I stopped before changing it; choose a different vault name and continue here."
    );
  }

  const vault = await adapters.vault.ensureVault({
    name: state.safeDecisions.vaultName,
    installationId: state.installationId,
    homeContent: buildHomeContent(state),
    statusContent: buildStatusContent(state)
  });

  if (!vault?.path || vault.path !== plannedVault.path || !Array.isArray(vault.files)) {
    throw new CustomerVisibleError(
      "VAULT_RESULT_INVALID",
      "I could not confirm the new vault location, so I stopped before claiming it was ready."
    );
  }

  state.vault = {
    name: state.safeDecisions.vaultName,
    desktopPath: vault.path,
    files: [...vault.files].sort(),
    simulated: Boolean(vault.simulated)
  };
  appendCompletedStage(
    state,
    "vault",
    stageOutput(
      "vault",
      state.safeDecisions.language === "es"
        ? `Creé la bóveda ${state.safeDecisions.vaultName} con Inicio y Estado del sistema.`
        : `I created ${state.safeDecisions.vaultName} with Home and System Status.`,
      4
    ),
    clock
  );
}

async function runValidationStage(state, adapters, clock) {
  const inspection = await adapters.vault.inspect({ path: state.vault?.desktopPath });
  const requiredFiles = ["Home.md", "System/Status.md"];
  const missing = requiredFiles.filter((file) => !inspection?.files?.includes(file));
  if (!inspection?.exists || missing.length > 0) {
    throw new CustomerVisibleError(
      "VAULT_VALIDATION_FAILED",
      "I could not verify the Home and System Status files, so the setup is safely paused before handoff."
    );
  }

  const opened = await adapters.obsidian.verifyVaultOpen({ path: state.vault.desktopPath });
  if (opened?.code === "VAULT_REGISTRATION_REQUIRED") {
    const isEs = state.safeDecisions.language === "es";
    throw new CustomerActionRequired({
      status: "waiting_for_customer_action",
      pendingAction: {
        kind: "open-generated-vault-in-obsidian",
        status: "waiting_for_customer_action",
        approvalRequired: false,
        customerAction: {
          kind: "open-folder-as-vault",
          app: "Obsidian",
          vaultName: state.vault.name,
          desktopPath: state.vault.desktopPath
        },
        message: isEs
          ? `Tu bóveda ${state.vault.name} ya está en el Escritorio. En Obsidian, elige “Open folder as vault” y selecciona esa carpeta. Después di “Continúa configurando mi segundo cerebro”.`
          : `Your ${state.vault.name} vault is already on the Desktop. In Obsidian, choose “Open folder as vault” and select that folder. Then say “Continue setting up my second brain.”`
      }
    });
  }
  if (opened?.code === "ACTIVE_VAULT_READBACK_REQUIRED") {
    throw new CustomerVisibleError(
      "ACTIVE_VAULT_READBACK_REQUIRED",
      "I created the new vault, but this setup does not have a safe way to confirm which Obsidian window is active. Your progress is saved, and I stopped before claiming the new vault was opened."
    );
  }
  if (!opened?.opened || opened.path !== state.vault.desktopPath) {
    throw new CustomerVisibleError(
      "OBSIDIAN_OPEN_VERIFICATION_FAILED",
      "I could not confirm that Obsidian opened the new vault, so setup is safely paused before handoff."
    );
  }

  state.validation.vault = {
    checkedAt: isoNow(clock),
    exists: true,
    requiredFiles,
    simulated: Boolean(inspection.simulated)
  };
  state.validation.obsidian = {
    ...state.validation.obsidian,
    openedAt: isoNow(clock),
    openedVaultPath: opened.path,
    openVerified: true,
    simulated: Boolean(state.validation.obsidian?.simulated || opened.simulated)
  };
  appendCompletedStage(
    state,
    "validation",
    stageOutput(
      "validation",
      state.safeDecisions.language === "es"
        ? "Verifiqué la ruta de la bóveda, sus dos superficies iniciales y que Obsidian abrió esta bóveda exacta."
        : "I verified the vault location, its two starting surfaces, and that Obsidian opened this exact vault.",
      5
    ),
    clock
  );
}

async function runPendingStages(state, { adapters, stateStore, clock, stopAfterStage, action }) {
  for (const stage of SETUP_STAGES) {
    if (state.completedStages.includes(stage)) {
      continue;
    }

    try {
      if (stage === "environment") await runEnvironmentStage(state, adapters, clock);
      if (stage === "obsidian") await runObsidianStage(state, adapters, clock, action);
      if (stage === "foundation") await runFoundationStage(state, clock);
      if (stage === "vault") await runVaultStage(state, adapters, clock);
      if (stage === "validation") await runValidationStage(state, adapters, clock);
      clearResolvedSupportRepair(state, stage, stateStore);
      await stateStore.save(state);
    } catch (error) {
      if (error instanceof CustomerActionRequired) {
        state.status = error.status;
        state.blocker = null;
        state.pendingAction = {
          ...structuredClone(error.pendingAction),
          stage,
          progress: `${state.completedStages.length} of ${SETUP_STAGES.length} setup steps complete`
        };
        state.updatedAt = isoNow(clock);
        await stateStore.save(state);
        return state;
      }
      const customerError = error instanceof CustomerVisibleError
        ? error
        : new CustomerVisibleError("SAFE_RETRY_REQUIRED", "That step did not finish. Your completed progress is saved, and you can safely try again here.");
      state.status = "blocked";
      state.pendingAction = null;
      state.blocker = {
        stage,
        code: customerError.code,
        message: customerError.customerMessage,
        recordedAt: isoNow(clock)
      };
      const repair = recordSafeRepairFailure(state, state.blocker, clock, stateStore);
      // An automatic handoff is bounded to one observed attempt for this
      // blocker in this running setup process. Persisted local state is not
      // used as that boundary: it is mutable and therefore cannot suppress an
      // otherwise due safety handoff. A customer can still explicitly ask
      // QWave support to retry later.
      const fingerprint = safeBlockerFingerprint(state.blocker);
      const alreadyEscalatedForThisBlocker = hasAutomaticEscalationAttempt(stateStore, fingerprint)
        || hasTrustedDeliveryReceipt(stateStore, validStoredEscalationForBlocker(state, state.blocker));
      if (repair.attempts >= SUPPORT_SAFE_REPAIR_ATTEMPT_LIMIT && !alreadyEscalatedForThisBlocker) {
        await escalateQWaveSupport(state, {
          adapters,
          stateStore,
          clock,
          reason: "safe-repairs-exhausted"
        });
      }
      state.updatedAt = isoNow(clock);
      await stateStore.save(state);
      return state;
    }

    if (stopAfterStage === stage) {
      state.status = "paused";
      state.updatedAt = isoNow(clock);
      await stateStore.save(state);
      return state;
    }
  }

  addCompleteOutput(state, clock);
  await stateStore.save(state);
  return state;
}

function publicTranscript(state) {
  return ["bootstrap", ...SETUP_STAGES, "complete"]
    .map((stage) => state.stageOutputs[stage])
    .filter(Boolean);
}

function toPublicView(state, { stateStore } = {}) {
  const waitingForCustomerAction = state.status === "waiting_for_approval" || state.status === "waiting_for_customer_action";
  const support = publicSupportStatus(state, { stateStore });
  const latest = waitingForCustomerAction
    ? state.pendingAction
    : state.status === "blocked"
    ? {
      message: [state.blocker?.message, support.message].filter(Boolean).join(" "),
      progress: `${state.completedStages.length} of ${SETUP_STAGES.length} setup steps complete`
    }
    : state.stageOutputs[state.stage] ?? state.stageOutputs.bootstrap;
  let nextAction = "Your progress is saved. Tell me to continue setting up your second brain when you are ready.";
  if (state.status === "complete") {
    nextAction = "Ask a normal question in this same conversation whenever you want to continue.";
  } else if (state.status === "waiting_for_approval") {
    nextAction = "Review the single official installation request above. Approve it here only if you want to continue.";
  } else if (state.status === "waiting_for_customer_action") {
    nextAction = "Complete the one official action above, then tell me to continue setting up your second brain.";
  } else if (state.status === "blocked" && support.status === "sent") {
    nextAction = "QWave support has the sanitized report. Resolve the one issue above, then tell me to continue setting up your second brain.";
  } else if (state.status === "blocked" && support.status === "delivery-unverified") {
    nextAction = "The sanitized support report is saved locally, but delivery is unverified. Resolve the one issue above, then tell me to continue setting up your second brain.";
  } else if (state.status === "blocked") {
    nextAction = "Your completed progress is saved. Resolve the one issue above, then tell me to continue setting up your second brain.";
  }

  return {
    setupSession: {
      installationId: state.installationId,
      status: state.status,
      stage: state.stage,
      progress: latest.progress,
      message: latest.message,
      nextAction,
      pendingAction: waitingForCustomerAction ? structuredClone(state.pendingAction) : null,
      support: {
        status: support.status,
        deliveryVerified: support.deliveryVerified,
        localReportRetained: support.localReportRetained
      }
    },
    savedSetup: {
      answers: { ...state.answers },
      safeDecisions: { ...state.safeDecisions },
      validation: structuredClone(state.validation)
    },
    vault: state.vault ? structuredClone(state.vault) : null,
    transcript: publicTranscript(state),
    limitation: state.vault?.simulated || state.validation.obsidian?.simulated
      ? "This QWA-140 proof uses simulated Desktop vault and Obsidian adapters. It does not claim that the host has installed Obsidian or opened a customer vault."
      : null
  };
}

async function execute({ message, stateStore, adapters, answers, decisions, action, clock, installationIdFactory, stopAfterStage }) {
  assertDependencies({ stateStore, adapters });

  let state = await stateStore.load();
  if (!state) {
    if (!message) {
      throw new CustomerVisibleError(
        "SETUP_NOT_FOUND",
        "I could not find a saved setup yet. Tell me you would like to set up your second brain to begin."
      );
    }
    state = buildInitialState({ message, answers, decisions, clock, installationIdFactory });
    await stateStore.save(state);
  } else {
    const upgraded = upgradeStateForObsidianHandoff(state, clock);
    const renamed = applyPendingVaultRename(state, decisions, clock);
    if (upgraded || renamed) {
      await stateStore.save(state);
    }
  }

  if (state.status === "blocked" && state.blocker && isExplicitSupportRequest({ message, action })) {
    await escalateQWaveSupport(state, {
      adapters,
      stateStore,
      clock,
      reason: "customer-requested"
    });
    state.updatedAt = isoNow(clock);
    await stateStore.save(state);
    return toPublicView(state, { stateStore });
  }

  if (state.status === "complete" && SETUP_STAGES.every((stage) => state.completedStages.includes(stage))) {
    return toPublicView(state, { stateStore });
  }

  state.status = "active";
  state.blocker = null;
  await stateStore.save(state);
  const completed = await runPendingStages(state, { adapters, stateStore, clock, stopAfterStage, action });
  return toPublicView(completed, { stateStore });
}

/**
 * Public entry point for the customer’s initial natural-language bootstrap.
 */
export async function startSetupSession(input) {
  assertNaturalLanguageBootstrap(input?.message);
  return execute(input);
}

/**
 * Public entry point for the customer’s normal-language resume request.
 */
export async function continueSetupSession(input) {
  if (!isExplicitSupportRequest(input ?? {})) {
    assertNaturalLanguageBootstrap(input?.message);
  }
  return execute(input);
}

/**
 * Public read-only status boundary for a saved setup.
 */
export async function getSetupSessionStatus({ stateStore }) {
  if (!stateStore || typeof stateStore.load !== "function") {
    throw new TypeError("A persistent stateStore with load() is required.");
  }
  const state = await stateStore.load();
  return state ? toPublicView(state, { stateStore }) : null;
}
