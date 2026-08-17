export {
  BOOTSTRAP_EXAMPLES,
  SETUP_STAGES,
  continueSetupSession,
  getSetupSessionStatus,
  startSetupSession
} from "./public/setup-session.mjs";

export {
  ONBOARDING_BATCHES,
  continueOnboardingSession,
  getOnboardingSessionStatus,
  startOnboardingSession
} from "./public/onboarding.mjs";

export {
  FileStateStore,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedObsidianAdapter
} from "./adapters/simulated-dependencies.mjs";

export {
  MacOSDesktopVaultAdapter,
  MacOSObsidianAdapter
} from "./adapters/macos-dependencies.mjs";

export {
  DEFAULT_PERMISSION_WINDOWS,
  PERMISSION_SOURCE_KINDS,
  SENSITIVE_CATEGORIES,
  PermissionLifecycleError,
  beginSourcePermissionReview,
  denySourcePermission,
  fetchApprovedSourceContent,
  getSourcePermissionStatus,
  grantSourcePermission,
  revokeSourcePermission
} from "./permissions/setup-source-permissions.mjs";

export { SimulatedReadOnlyConnector } from "./permissions/simulated-connector.mjs";
