export {
  BOOTSTRAP_EXAMPLES,
  CONTACT_QWAVE_SUPPORT_ACTION,
  SETUP_STAGES,
  SUPPORT_SAFE_REPAIR_ATTEMPT_LIMIT,
  continueSetupSession,
  getSetupSessionStatus,
  startSetupSession
} from "./public/setup-session.mjs";

export {
  BOOTSTRAP_CAPABILITIES,
  DISTRIBUTION_VISIBILITIES,
  QWAVE_DISTRIBUTION,
  QWAVE_INSTALLER_VERSION,
  BootstrapHandoffError,
  buildCustomerBootstrapPrompt,
  prepareBootstrapHandoff
} from "./public/bootstrap-handoff.mjs";

export {
  CHECKPOINT_KINDS,
  HISTORY_MODES,
  planHistoryCheckpoint,
  planPrivateHistory
} from "./history/private-history-contract.mjs";

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
  SimulatedObsidianAdapter,
  SimulatedQWaveSupportRelay
} from "./adapters/simulated-dependencies.mjs";

export {
  QWAVE_SUPPORT_INSTALLER_VERSION,
  QWAVE_SUPPORT_MAX_PAYLOAD_BYTES,
  QWAVE_SUPPORT_MAX_REPORTS_PER_INSTALLATION,
  QWAVE_SUPPORT_RATE_LIMIT_WINDOW_MS,
  QWAVE_SUPPORT_RECIPIENTS,
  QWAVE_SUPPORT_REPORT_SCHEMA_VERSION,
  QWaveSupportEscalationError,
  buildQWaveSupportRelayRequest,
  buildSanitizedQWaveSupportReport,
  deliverQWaveSupportReport,
  sanitizeSupportEnvironment,
  validateQWaveSupportRelayRequest
} from "./support/qwave-support-escalation.mjs";

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
  SlackLifecycleError,
  approveSlackBlockedGroupException,
  authorizeSlackOfficialPlugin,
  beginSlackConnection,
  denySlackContentReview,
  fetchApprovedSlackContent,
  getSlackConnectionStatus,
  grantSlackContent,
  requestSlackBlockedGroupException,
  revokeSlackContent
} from "./connectors/slack.mjs";

export {
  SimulatedSlackOfficialPlugin,
  SlackPluginError
} from "./connectors/simulated-slack-plugin.mjs";

export {
  FolderBoundedDriveConnector,
  GoogleDriveLifecycleError,
  authorizeGoogleDriveReadOnly,
  beginGoogleDriveConnection,
  fetchApprovedGoogleDriveContent,
  getGoogleDriveConnectionStatus,
  grantGoogleDriveFolderContent,
  revokeGoogleDriveConnection
} from "./connectors/google-drive.mjs";

export {
  SimulatedGoogleDriveConnector,
  SimulatedGoogleDrivePlugin
} from "./connectors/simulated-google-drive-plugin.mjs";

export {
  CANONICAL_SUBJECT_TYPES,
  DetachedLocalRetentionService,
  KnowledgeCompilationError,
  LocalTemporaryStaging,
  TEMPORARY_STAGING_POLICY,
  cleanupExpiredKnowledgeStaging,
  compileApprovedRecords,
  getKnowledgeCompilationStatus
} from "./knowledge/approved-record-compiler.mjs";

export {
  GMAIL_CONNECTION_STATES,
  GMAIL_IN_APP_FALLBACK_ACTION,
  GmailReadOnlyConnector,
  GmailReadOnlyError,
  beginGmailConnection,
  beginGmailPrivacyReview,
  cancelGmailReadOnlyScope,
  fetchApprovedGmailReferences,
  getGmailReadOnlyStatus,
  grantGmailReadOnlyScope,
  revokeGmailReadOnlyConnection,
  skipGmailConnection
} from "./connectors/gmail-readonly.mjs";

export { SimulatedGmailPlugin } from "./connectors/simulated-gmail-plugin.mjs";

export {
  CalendarBoundedConnector,
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

export {
  LIVE_CONNECTOR_RELEASE_GATE,
  SOURCE_ADAPTER_NAMES,
  SOURCE_HANDOFF_CATEGORIES,
  SOURCE_STATE_VOCABULARY,
  SOURCE_STATUS_STATES,
  SourceStatusError,
  beginSimulatedExportPreview,
  buildSimulatedExportPermissionScope,
  explainUnsupportedSource,
  getPersistedAdapterSourceStatus,
  getSourceStatus,
  getSourceStatusHandoff,
  grantSimulatedExportPermission,
  importSimulatedExportSnapshot,
  normalizeAdapterSourceStatus,
  recoverInterruptedSimulatedExportImport,
  resumeOptionalSource,
  revokeSimulatedExportPermission,
  skipOptionalSource
} from "./source-status.mjs";

export { SimulatedGenericExportAdapter } from "./connectors/simulated-generic-export.mjs";

export {
  OFFICIAL_WHATSAPP_BUSINESS_VERIFICATION_PROTOCOL,
  WHATSAPP_LOCAL_SNAPSHOT_CONTRACT,
  WhatsAppSnapshotError,
  beginWhatsAppPersonalSnapshot,
  beginWhatsAppSnapshotImport,
  cancelWhatsAppSnapshotReview,
  cleanupWhatsAppSnapshotPrivateMemory,
  confirmWhatsAppPersonalExport,
  denyWhatsAppSnapshotContent,
  fetchApprovedWhatsAppSnapshotContent,
  getWhatsAppOfficialBusinessStatus,
  getWhatsAppSnapshotStatus,
  grantWhatsAppSnapshotContent,
  restartWhatsAppSnapshotReview,
  resumeWhatsAppSnapshotFetch,
  revokeWhatsAppSnapshotContent,
  selectWhatsAppSnapshotMedia,
  selectWhatsAppSnapshotScope,
  verifyWhatsAppOfficialBusinessConnection
} from "./connectors/whatsapp-snapshot.mjs";

export { SimulatedWhatsAppSnapshotConnector } from "./connectors/simulated-whatsapp-snapshot-adapter.mjs";

export {
  DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF,
  DEFAULT_WHATSAPP_SNAPSHOT_LIMITS,
  LocalWhatsAppSnapshotConnector,
  LocalWhatsAppSnapshotError,
  WHATSAPP_SNAPSHOT_BUNDLE_FORMAT,
  WHATSAPP_SNAPSHOT_CONNECTOR_PROTOCOL
} from "./connectors/local-whatsapp-snapshot-connector.mjs";
