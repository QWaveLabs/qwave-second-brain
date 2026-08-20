/**
 * QWA-151 bounded support-escalation contract.
 *
 * This module deliberately builds a tiny, schema-limited report. It never
 * accepts source data, customer contacts, prompts, credentials, local paths,
 * or caller-selected recipients. A host-owned relay adapter is responsible for
 * actual delivery; this repository only defines the safe contract that adapter
 * must honor.
 */

export const QWAVE_SUPPORT_RECIPIENTS = Object.freeze([
  "support@qwavelabs.io",
  "rob@qwavelabs.io"
]);

export const QWAVE_SUPPORT_REPORT_SCHEMA_VERSION = 1;
export const QWAVE_SUPPORT_INSTALLER_VERSION = "0.1.0";
export const QWAVE_SUPPORT_MAX_PAYLOAD_BYTES = 8 * 1024;
export const QWAVE_SUPPORT_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const QWAVE_SUPPORT_MAX_REPORTS_PER_INSTALLATION = 3;

const SETUP_STAGES = new Set([
  "environment",
  "obsidian",
  "foundation",
  "vault",
  "validation"
]);

const CONNECTOR_CATEGORIES = Object.freeze({
  environment: "macos-environment",
  obsidian: "obsidian",
  foundation: "setup-foundation",
  vault: "desktop-vault",
  validation: "vault-validation"
});

const ARCHITECTURES = new Set(["arm64", "x64", "x86_64", "unknown"]);
const SAFE_ACTION_IDS = new Set(["resume-blocked-setup-stage"]);
const SAFE_ACTION_OUTCOMES = new Set(["failed", "recovered"]);
const ANONYMOUS_INSTALLATION_ID = /^qsb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FAILURE_DETAILS = Object.freeze({
  BOOTSTRAP_MESSAGE_REQUIRED: {
    category: "setup-request-required",
    message: "The setup request needs a clear ordinary-language instruction.",
    validationFailures: ["setup-request"]
  },
  UNSUPPORTED_ENVIRONMENT: {
    category: "environment-not-ready",
    message: "The required private Mac environment could not be verified.",
    validationFailures: ["private-macos-environment"]
  },
  SHARED_MAC_PROFILE: {
    category: "private-profile-required",
    message: "A private macOS user account is required before setup can continue.",
    validationFailures: ["private-macos-profile"]
  },
  OBSIDIAN_OFFICIAL_APP_REQUIRED: {
    category: "official-obsidian-required",
    message: "The official Obsidian app could not be verified.",
    validationFailures: ["official-obsidian-app"]
  },
  OFFICIAL_INSTALL_ACTION_INVALID: {
    category: "official-install-action-invalid",
    message: "The official Obsidian installation action could not be verified.",
    validationFailures: ["official-install-action"]
  },
  VAULT_PLAN_INVALID: {
    category: "desktop-vault-plan-invalid",
    message: "A safe Desktop location for the new vault could not be verified.",
    validationFailures: ["desktop-vault-path"]
  },
  VAULT_PATH_ALREADY_EXISTS: {
    category: "desktop-vault-path-in-use",
    message: "The requested Desktop vault location is already in use.",
    validationFailures: ["desktop-vault-path"]
  },
  VAULT_RESULT_INVALID: {
    category: "desktop-vault-result-invalid",
    message: "The new vault location could not be verified after creation.",
    validationFailures: ["desktop-vault-result"]
  },
  VAULT_VALIDATION_FAILED: {
    category: "vault-validation-failed",
    message: "The required initial vault files could not be verified.",
    validationFailures: ["vault-foundation-files"]
  },
  ACTIVE_VAULT_READBACK_REQUIRED: {
    category: "active-vault-readback-required",
    message: "The active Obsidian vault could not be safely verified.",
    validationFailures: ["active-obsidian-vault"]
  },
  OBSIDIAN_OPEN_VERIFICATION_FAILED: {
    category: "obsidian-open-not-verified",
    message: "Obsidian opening the new vault could not be verified.",
    validationFailures: ["active-obsidian-vault"]
  },
  SAFE_RETRY_REQUIRED: {
    category: "safe-retry-required",
    message: "A required setup step did not finish and needs a safe retry.",
    validationFailures: ["blocked-setup-stage"]
  }
});

const FAILURE_CATEGORIES = new Set(Object.values(FAILURE_DETAILS).map((detail) => detail.category));
const FAILURE_MESSAGES = new Set(Object.values(FAILURE_DETAILS).map((detail) => detail.message));

function isKnownFailureDetail({ category, message }) {
  return Object.values(FAILURE_DETAILS).some((detail) => (
    detail.category === category && detail.message === message
  ));
}

export class QWaveSupportEscalationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QWaveSupportEscalationError";
    this.code = code;
  }
}

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, field) {
  if (!isPlainObject(value)) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", `${field} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", `${field} contains unsupported fields.`);
  }
}

function safeInstallationId(value) {
  return typeof value === "string" && ANONYMOUS_INSTALLATION_ID.test(value)
    ? value
    : "qsb-unavailable";
}

function isSafeInstallationId(value) {
  return value === "qsb-unavailable" || (typeof value === "string" && ANONYMOUS_INSTALLATION_ID.test(value));
}

function safeInstallerVersion(value) {
  return value === QWAVE_SUPPORT_INSTALLER_VERSION
    ? value
    : QWAVE_SUPPORT_INSTALLER_VERSION;
}

function safeMacOSVersion(value) {
  return typeof value === "string" && /^\d{1,2}(?:\.\d{1,2}){0,3}$/.test(value)
    ? value
    : "unavailable";
}

function safeArchitecture(value) {
  return ARCHITECTURES.has(value) ? value : "unknown";
}

function safeTimezone(value) {
  if (typeof value !== "string" || !/^(?:UTC|[A-Za-z]+(?:\/[A-Za-z_+-]+){1,3})$/.test(value)) {
    return "unavailable";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return "unavailable";
  }
}

function safeStage(value) {
  return SETUP_STAGES.has(value) ? value : "environment";
}

function safeRepairAttempts(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 99) : 1;
}

function failureDetailFor(code) {
  return FAILURE_DETAILS[code] ?? FAILURE_DETAILS.SAFE_RETRY_REQUIRED;
}

function supportSubject(report) {
  return `QWave Second Brain — ${report.setup.stage} blocked — ${report.installationId}`;
}

function supportBody(report) {
  return [
    "QWave Second Brain setup blocker",
    `Installation ID: ${report.installationId}`,
    `Installer version: ${report.installerVersion}`,
    `Occurred at: ${report.occurredAt}`,
    `macOS version: ${report.environment.macOSVersion}`,
    `Architecture: ${report.environment.architecture}`,
    `Timezone: ${report.environment.timezone}`,
    `Setup stage: ${report.setup.stage}`,
    `Connector category: ${report.setup.connectorCategory}`,
    `Sanitized error category: ${report.failure.category}`,
    `Sanitized error: ${report.failure.message}`,
    `Safe repair attempts: ${report.repairAttempts}`,
    `Safe action outcomes: ${report.safeActions.map((action) => `${action.id}:${action.outcome}`).join(", ")}`,
    `Validation failures: ${report.validationFailures.join(", ")}`
  ].join("\n");
}

function assertReportShape(report) {
  assertExactKeys(report, [
    "schemaVersion",
    "reportKind",
    "installationId",
    "installerVersion",
    "occurredAt",
    "environment",
    "setup",
    "failure",
    "safeActions",
    "repairAttempts",
    "validationFailures"
  ], "support report");

  if (report.schemaVersion !== QWAVE_SUPPORT_REPORT_SCHEMA_VERSION || report.reportKind !== "qwave-second-brain-setup-blocker") {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report uses an unsupported schema.");
  }
  if (!isSafeInstallationId(report.installationId)) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has an invalid installation identifier.");
  }
  if (report.installerVersion !== QWAVE_SUPPORT_INSTALLER_VERSION) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has an invalid installer version.");
  }
  if (typeof report.occurredAt !== "string" || Number.isNaN(Date.parse(report.occurredAt))) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has an invalid timestamp.");
  }

  assertExactKeys(report.environment, ["macOSVersion", "architecture", "timezone"], "support environment");
  if (
    safeMacOSVersion(report.environment.macOSVersion) !== report.environment.macOSVersion
    || safeArchitecture(report.environment.architecture) !== report.environment.architecture
    || safeTimezone(report.environment.timezone) !== report.environment.timezone
  ) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has unsupported environment metadata.");
  }

  assertExactKeys(report.setup, ["stage", "connectorCategory", "status"], "support setup");
  if (
    !SETUP_STAGES.has(report.setup.stage)
    || report.setup.connectorCategory !== CONNECTOR_CATEGORIES[report.setup.stage]
    || report.setup.status !== "blocked"
  ) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has unsupported setup metadata.");
  }

  assertExactKeys(report.failure, ["category", "message"], "support failure");
  if (
    !FAILURE_CATEGORIES.has(report.failure.category)
    || !FAILURE_MESSAGES.has(report.failure.message)
    || !isKnownFailureDetail(report.failure)
  ) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has an unsupported sanitized failure.");
  }
  if (!Array.isArray(report.safeActions) || report.safeActions.length !== 1) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has invalid safe action outcomes.");
  }
  for (const action of report.safeActions) {
    assertExactKeys(action, ["id", "outcome"], "support safe action");
    if (!SAFE_ACTION_IDS.has(action.id) || !SAFE_ACTION_OUTCOMES.has(action.outcome)) {
      throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has an unsupported safe action outcome.");
    }
  }
  if (report.safeActions[0].id !== "resume-blocked-setup-stage" || report.safeActions[0].outcome !== "failed") {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has an unsupported safe action outcome.");
  }
  if (!Number.isInteger(report.repairAttempts) || report.repairAttempts < 1 || report.repairAttempts > 99) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has an invalid repair count.");
  }
  const matchingFailure = Object.values(FAILURE_DETAILS).find((detail) => (
    detail.category === report.failure.category && detail.message === report.failure.message
  ));
  if (
    !Array.isArray(report.validationFailures)
    || !matchingFailure
    || report.validationFailures.length !== matchingFailure.validationFailures.length
    || report.validationFailures.some((value, index) => value !== matchingFailure.validationFailures[index])
  ) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support report has unsupported validation failures.");
  }
}

/**
 * Converts optional environment facts into the only three environment fields a
 * support report is permitted to carry. Invalid values become a stable
 * placeholder rather than being copied into the report.
 */
export function sanitizeSupportEnvironment(environment = {}) {
  return {
    macOSVersion: safeMacOSVersion(environment?.macOSVersion),
    architecture: safeArchitecture(environment?.architecture),
    timezone: safeTimezone(environment?.timezone)
  };
}

/**
 * Builds an allowlisted report from persisted setup state. Raw exception text
 * and every caller-provided diagnostic field are deliberately ignored.
 */
export function buildSanitizedQWaveSupportReport({
  installationId,
  environment,
  blocker,
  repairAttempts,
  clock,
  installerVersion = QWAVE_SUPPORT_INSTALLER_VERSION
} = {}) {
  const stage = safeStage(blocker?.stage);
  const failure = failureDetailFor(blocker?.code);
  const report = {
    schemaVersion: QWAVE_SUPPORT_REPORT_SCHEMA_VERSION,
    reportKind: "qwave-second-brain-setup-blocker",
    installationId: safeInstallationId(installationId),
    installerVersion: safeInstallerVersion(installerVersion),
    occurredAt: isoNow(clock),
    environment: sanitizeSupportEnvironment(environment),
    setup: {
      stage,
      connectorCategory: CONNECTOR_CATEGORIES[stage],
      status: "blocked"
    },
    failure: {
      category: failure.category,
      message: failure.message
    },
    safeActions: [{ id: "resume-blocked-setup-stage", outcome: "failed" }],
    repairAttempts: safeRepairAttempts(repairAttempts),
    validationFailures: [...failure.validationFailures]
  };
  assertReportShape(report);
  return report;
}

/**
 * Produces the only request shape accepted by the controlled QWave relay.
 * Recipients are not an argument by design.
 */
export function buildQWaveSupportRelayRequest({ report } = {}) {
  assertReportShape(report);
  const request = {
    schemaVersion: QWAVE_SUPPORT_REPORT_SCHEMA_VERSION,
    recipients: [...QWAVE_SUPPORT_RECIPIENTS],
    subject: supportSubject(report),
    body: supportBody(report),
    report: structuredClone(report)
  };
  validateQWaveSupportRelayRequest(request);
  return request;
}

/**
 * Applies the relay boundary checks locally as well as in the host-owned relay
 * implementation. That makes arbitrary recipient selection, extra fields, and
 * oversized or malformed payloads fail before any delivery attempt.
 */
export function validateQWaveSupportRelayRequest(request, { maxPayloadBytes = QWAVE_SUPPORT_MAX_PAYLOAD_BYTES } = {}) {
  assertExactKeys(request, ["schemaVersion", "recipients", "subject", "body", "report"], "support relay request");
  if (request.schemaVersion !== QWAVE_SUPPORT_REPORT_SCHEMA_VERSION) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support relay request uses an unsupported schema.");
  }
  if (
    !Array.isArray(request.recipients)
    || request.recipients.length !== QWAVE_SUPPORT_RECIPIENTS.length
    || request.recipients.some((recipient, index) => recipient !== QWAVE_SUPPORT_RECIPIENTS[index])
  ) {
    throw new QWaveSupportEscalationError("SUPPORT_RECIPIENTS_FIXED", "The support relay accepts only the fixed QWave recipients.");
  }

  assertReportShape(request.report);
  if (request.subject !== supportSubject(request.report) || request.body !== supportBody(request.report)) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_SCHEMA_INVALID", "The support relay request includes unapproved email content.");
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 256 || payloadBytes > maxPayloadBytes) {
    throw new QWaveSupportEscalationError("SUPPORT_REPORT_TOO_LARGE", "The support relay request exceeds the allowed size.");
  }
  return { payloadBytes };
}

function sanitizedRelayFailureCode(error) {
  const known = new Set([
    "SUPPORT_RELAY_UNAVAILABLE",
    "SUPPORT_REPORT_SCHEMA_INVALID",
    "SUPPORT_RECIPIENTS_FIXED",
    "SUPPORT_REPORT_TOO_LARGE",
    "SUPPORT_REPORT_RATE_LIMITED",
    "SUPPORT_REPORT_DUPLICATE"
  ]);
  return error instanceof QWaveSupportEscalationError && known.has(error.code)
    ? error.code
    : "SUPPORT_DELIVERY_UNVERIFIED";
}

/**
 * Attempts delivery without exposing a transport's raw response or error. The
 * caller always retains the already-sanitized report locally, even if delivery
 * cannot be verified.
 */
export async function deliverQWaveSupportReport({ relay, report, clock } = {}) {
  const request = buildQWaveSupportRelayRequest({ report });
  if (!relay || typeof relay.send !== "function") {
    return {
      status: "delivery-unverified",
      code: "SUPPORT_RELAY_UNAVAILABLE",
      attemptedAt: isoNow(clock)
    };
  }

  try {
    const acknowledgement = await relay.send(request);
    if (acknowledgement?.delivered !== true) {
      return {
        status: "delivery-unverified",
        code: "SUPPORT_DELIVERY_UNVERIFIED",
        attemptedAt: isoNow(clock)
      };
    }
    return {
      status: "sent",
      code: "SUPPORT_REPORT_DELIVERED",
      attemptedAt: isoNow(clock)
    };
  } catch (error) {
    return {
      status: "delivery-unverified",
      code: sanitizedRelayFailureCode(error),
      attemptedAt: isoNow(clock)
    };
  }
}
