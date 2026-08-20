/**
 * QWA-144 customer bootstrap handoff.
 *
 * The approved release model is one private QWave repository. This boundary
 * makes the private-repository clone handoff safe
 * and resumable before Setup Session begins; the customer never receives a
 * terminal procedure.
 */

export const QWAVE_INSTALLER_VERSION = "0.1.0";

export const DISTRIBUTION_VISIBILITIES = Object.freeze(["public", "private"]);
export const QWAVE_DISTRIBUTION = Object.freeze({
  repositoryVisibility: "private"
});

export const BOOTSTRAP_CAPABILITIES = Object.freeze([
  "set up",
  "connect",
  "review privacy",
  "build",
  "refresh",
  "audit",
  "show",
  "restore",
  "improve"
]);

class BootstrapHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BootstrapHandoffError";
    this.code = code;
  }
}

export { BootstrapHandoffError };

function assertBootstrapIntent(message) {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new BootstrapHandoffError(
      "BOOTSTRAP_MESSAGE_REQUIRED",
      "Tell me you would like to set up your QWave Second Brain, and I will guide you from there."
    );
  }
  if (message.trim().startsWith("/")) {
    throw new BootstrapHandoffError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Tell me you would like to set up your QWave Second Brain."
    );
  }
  if (!/qwave\s+second\s+brain|second\s+brain|segundo\s+cerebro/i.test(message)) {
    throw new BootstrapHandoffError(
      "UNRECOGNIZED_BOOTSTRAP",
      "To begin, say “Set up my QWave Second Brain.”"
    );
  }
}

function assertRequiredVisibility(value) {
  if (!DISTRIBUTION_VISIBILITIES.includes(value)) {
    throw new TypeError("requiredVisibility must be either 'public' or 'private'.");
  }
}

function assertRepositoryAdapter(repository) {
  if (!repository || typeof repository.inspectCheckout !== "function" || typeof repository.inspectSource !== "function" || typeof repository.clone !== "function") {
    throw new TypeError("A repository adapter with inspectCheckout(), inspectSource(), and clone() is required.");
  }
}

function sourceMatchesPolicy(source, requiredVisibility) {
  return source?.visibility === requiredVisibility && typeof source.cloneUrl === "string" && source.cloneUrl.length > 0;
}

function visibleMessage({ language, cloned, root }) {
  if (language === "es") {
    return cloned
      ? "Preparé la copia aprobada de QWave Second Brain y puedo continuar la configuración guiada aquí."
      : "Encontré tu copia aprobada de QWave Second Brain y puedo continuar la configuración guiada aquí.";
  }
  return cloned
    ? "I prepared the approved QWave Second Brain copy and can continue the guided setup here."
    : "I found your approved QWave Second Brain copy and can continue the guided setup here.";
}

function safeRepositoryReference(repositoryReference) {
  if (repositoryReference === undefined) return "the QWave repository link provided with this setup";
  if (typeof repositoryReference !== "string" || repositoryReference.trim().length === 0 || repositoryReference.length > 300) {
    throw new TypeError("repositoryReference must be a short, non-empty description or HTTPS repository URL.");
  }
  const normalized = repositoryReference.trim();
  if (/\r|\n/.test(normalized)) {
    throw new TypeError("repositoryReference must be one line.");
  }
  if (normalized.startsWith("https://")) {
    const url = new URL(normalized);
    if (url.username || url.password || url.search || url.hash) {
      throw new TypeError("repositoryReference must not contain credentials, query parameters, or fragments.");
    }
  }
  return normalized;
}

/**
 * The one message a customer can paste into Codex. QWave may embed its approved
 * private runtime link, but no credential may be embedded and no terminal
 * action is delegated to the customer.
 */
export function buildCustomerBootstrapPrompt({ language = "en", repositoryReference } = {}) {
  const repository = safeRepositoryReference(repositoryReference);
  if (language !== "en" && language !== "es") {
    throw new TypeError("language must be 'en' or 'es'.");
  }
  if (language === "es") {
    return `Quiero configurar mi QWave Second Brain. Usa ${repository} para preparar o continuar la copia privada aprobada. Confirma que el runtime es privado antes de clonarlo. Haz la configuración local segura por mí; no me pidas usar Terminal ni comandos. Habla en español claro, pide una sola decisión a la vez solo cuando necesites mi aprobación de privacidad, seguridad o inicio de sesión, y deja todas las fuentes en solo lectura hasta que yo otorgue un permiso específico. Si existe una configuración protegida, reanúdala. Antes de terminar, dime con honestidad qué está verificado en vivo, importado una sola vez, omitido, en beta o bloqueado.`;
  }
  return `I want to set up my QWave Second Brain. Use ${repository} to prepare or continue the approved private runtime copy. Confirm that the runtime is private before cloning it. Do the safe local setup for me; do not ask me to use Terminal or commands. Use clear English, ask one decision at a time only when you need my privacy, security, or sign-in approval, and keep every source read-only until I grant a specific permission. If a protected setup already exists, resume it. Before you finish, tell me truthfully what is live and verified, imported once, skipped, beta-only, or blocked.`;
}

/**
 * Creates or resumes the repository handoff. The adapter owns the actual Git
 * implementation, while this public contract refuses a source whose visibility
 * does not match the approved private-runtime policy.
 */
export async function prepareBootstrapHandoff({
  message,
  repository,
  requiredVisibility = QWAVE_DISTRIBUTION.repositoryVisibility,
  language = "en"
} = {}) {
  assertBootstrapIntent(message);
  assertRequiredVisibility(requiredVisibility);
  assertRepositoryAdapter(repository);

  const existing = await repository.inspectCheckout();
  if (existing?.ready === true && typeof existing.root === "string" && existing.root.length > 0) {
    return {
      status: "ready",
      cloned: false,
      root: existing.root,
      message: visibleMessage({ language, cloned: false, root: existing.root })
    };
  }

  const source = await repository.inspectSource();
  if (!sourceMatchesPolicy(source, requiredVisibility)) {
    return {
      status: "blocked",
      cloned: false,
      root: null,
      message: "I could not verify that the approved QWave installer source has the required visibility, so I stopped before cloning anything.",
      nextAction: "Ask QWave for the approved repository access, then continue this same setup."
    };
  }

  const clone = await repository.clone({ cloneUrl: source.cloneUrl });
  if (!clone?.root || typeof clone.root !== "string") {
    throw new BootstrapHandoffError(
      "CLONE_RESULT_INVALID",
      "I could not verify the approved QWave Second Brain copy after cloning, so I stopped before setup."
    );
  }
  const readback = await repository.inspectCheckout();
  if (readback?.ready !== true || readback.root !== clone.root) {
    throw new BootstrapHandoffError(
      "CLONE_READBACK_REQUIRED",
      "I could not read back the approved QWave Second Brain copy after cloning, so I stopped before setup."
    );
  }

  return {
    status: "ready",
    cloned: true,
    root: clone.root,
    message: visibleMessage({ language, cloned: true, root: clone.root })
  };
}
