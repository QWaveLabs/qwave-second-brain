/**
 * QWA-138 public Setup Session seam.
 *
 * This module intentionally knows nothing about real macOS, Obsidian, connectors,
 * Git, or support transport. Those concerns arrive through injected adapters in
 * later vertical slices. The public functions below are the customer journey
 * boundary exercised by the black-box tests.
 */

import { randomUUID } from "node:crypto";

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
    version: 2,
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

function toPublicView(state) {
  const waitingForCustomerAction = state.status === "waiting_for_approval" || state.status === "waiting_for_customer_action";
  const latest = waitingForCustomerAction
    ? state.pendingAction
    : state.status === "blocked"
    ? { message: state.blocker.message, progress: `${state.completedStages.length} of ${SETUP_STAGES.length} setup steps complete` }
    : state.stageOutputs[state.stage] ?? state.stageOutputs.bootstrap;
  const nextAction = state.status === "complete"
    ? "Ask a normal question in this same conversation whenever you want to continue."
    : state.status === "waiting_for_approval"
      ? "Review the single official installation request above. Approve it here only if you want to continue."
      : state.status === "waiting_for_customer_action"
        ? "Complete the one official action above, then tell me to continue setting up your second brain."
    : state.status === "blocked"
      ? "Your completed progress is saved. Resolve the one issue above, then tell me to continue setting up your second brain."
      : "Your progress is saved. Tell me to continue setting up your second brain when you are ready.";

  return {
    setupSession: {
      installationId: state.installationId,
      status: state.status,
      stage: state.stage,
      progress: latest.progress,
      message: latest.message,
      nextAction,
      pendingAction: waitingForCustomerAction ? structuredClone(state.pendingAction) : null
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

  if (state.status === "complete" && SETUP_STAGES.every((stage) => state.completedStages.includes(stage))) {
    return toPublicView(state);
  }

  state.status = "active";
  state.blocker = null;
  await stateStore.save(state);
  const completed = await runPendingStages(state, { adapters, stateStore, clock, stopAfterStage, action });
  return toPublicView(completed);
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
  assertNaturalLanguageBootstrap(input?.message);
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
  return state ? toPublicView(state) : null;
}
