/**
 * Public continuation of the saved Setup Session.
 *
 * The implementation is intentionally separate from the QWA-138 bootstrap
 * state machine so future environment/vault work can integrate at the adapter
 * boundary without changing the customer-facing onboarding contract.
 */
export {
  ONBOARDING_BATCHES,
  continueOnboardingSession,
  getOnboardingSessionStatus,
  startOnboardingSession
} from "../onboarding/foundation-session.mjs";
