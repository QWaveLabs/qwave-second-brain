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

class CustomerVisibleError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "CustomerVisibleError";
    this.code = code;
    this.customerMessage = customerMessage;
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
  if (!adapters?.vault || typeof adapters.vault.ensureVault !== "function" || typeof adapters.vault.inspect !== "function") {
    throw new TypeError("A vault adapter with ensureVault() and inspect() is required.");
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
    version: 1,
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
    vault: null,
    blocker: null,
    stageOutputs: {
      bootstrap: {
        stage: "bootstrap",
        progress: "0 of 4 setup steps complete",
        message: language === "es"
          ? "Perfecto. Vamos a configurar tu segundo cerebro paso a paso. Guardaré el progreso para que puedas continuar aquí si se interrumpe."
          : "Great. We’ll set up your second brain one step at a time. I’ll save your progress so you can continue here if anything interrupts us."
      }
    },
    createdAt: now,
    updatedAt: now
  };
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

  state.validation.environment = {
    supported: true,
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
      2
    ),
    clock
  );
}

async function runVaultStage(state, adapters, clock) {
  const vault = await adapters.vault.ensureVault({
    name: state.safeDecisions.vaultName,
    homeContent: buildHomeContent(state),
    statusContent: buildStatusContent(state)
  });

  if (!vault?.path || !Array.isArray(vault.files)) {
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
      3
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

  state.validation.vault = {
    checkedAt: isoNow(clock),
    exists: true,
    requiredFiles,
    simulated: Boolean(inspection.simulated)
  };
  appendCompletedStage(
    state,
    "validation",
    stageOutput(
      "validation",
      state.safeDecisions.language === "es"
        ? "Verifiqué la ruta de la bóveda y sus dos superficies iniciales."
        : "I verified the vault location and its two starting surfaces.",
      4
    ),
    clock
  );
}

async function runPendingStages(state, { adapters, stateStore, clock, stopAfterStage }) {
  for (const stage of SETUP_STAGES) {
    if (state.completedStages.includes(stage)) {
      continue;
    }

    try {
      if (stage === "environment") await runEnvironmentStage(state, adapters, clock);
      if (stage === "foundation") await runFoundationStage(state, clock);
      if (stage === "vault") await runVaultStage(state, adapters, clock);
      if (stage === "validation") await runValidationStage(state, adapters, clock);
      await stateStore.save(state);
    } catch (error) {
      const customerError = error instanceof CustomerVisibleError
        ? error
        : new CustomerVisibleError("SAFE_RETRY_REQUIRED", "That step did not finish. Your completed progress is saved, and you can safely try again here.");
      state.status = "blocked";
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
  const latest = state.status === "blocked"
    ? { message: state.blocker.message, progress: `${state.completedStages.length} of ${SETUP_STAGES.length} setup steps complete` }
    : state.stageOutputs[state.stage] ?? state.stageOutputs.bootstrap;
  const nextAction = state.status === "complete"
    ? "Ask a normal question in this same conversation whenever you want to continue."
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
      nextAction
    },
    savedSetup: {
      answers: { ...state.answers },
      safeDecisions: { ...state.safeDecisions },
      validation: structuredClone(state.validation)
    },
    vault: state.vault ? structuredClone(state.vault) : null,
    transcript: publicTranscript(state),
    limitation: state.vault?.simulated
      ? "This QWA-138 proof uses a simulated Desktop vault adapter. It does not claim that Obsidian has been installed or opened."
      : null
  };
}

async function execute({ message, stateStore, adapters, answers, decisions, clock, installationIdFactory, stopAfterStage }) {
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
  }

  if (state.status === "complete") {
    return toPublicView(state);
  }

  state.status = "active";
  state.blocker = null;
  await stateStore.save(state);
  const completed = await runPendingStages(state, { adapters, stateStore, clock, stopAfterStage });
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
