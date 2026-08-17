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

export {
  IMessageBetaError,
  approveIMessageSensitiveContent,
  attemptIMessageLocalAccess,
  beginIMessageBeta,
  beginIMessageSnapshotImport,
  fetchApprovedIMessageContent,
  getIMessageBetaStatus,
  grantIMessageContent,
  revokeIMessageContent
} from "./connectors/imessage-beta.mjs";

export {
  SimulatedIMessageLocalAdapter,
  SimulatedIMessageSnapshotConnector
} from "./connectors/simulated-imessage-adapter.mjs";

export {
  GoogleCalendarLifecycleError,
  beginGoogleCalendarReview,
  fetchApprovedGoogleCalendarContent,
  getGoogleCalendarStatus,
  grantGoogleCalendarContent,
  revokeGoogleCalendarContent
} from "./connectors/google-calendar.mjs";

export {
  SimulatedGoogleCalendarAdapter,
  SimulatedGoogleCalendarAdapterError
} from "./connectors/simulated-google-calendar-adapter.mjs";
