import { createJourneyAction, createJourneyProjection, type JourneyProjection } from '../cli/journey.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { OnboardingSession } from './session-store.js';

export type CheckoutAccessState = 'ready' | 'required';

export function projectOnboardingJourney(
  session: OnboardingSession,
  providers: ProviderRegistry,
  checkoutAccess: CheckoutAccessState,
): JourneyProjection {
  if (session.completedAt !== undefined) {
    return createJourneyProjection('complete', true, postCompletionActions());
  }
  if (checkoutAccess === 'required') {
    return createJourneyProjection('checkout-access-required', false, [createJourneyAction({
      type: 'prepare-checkout', actor: 'user',
      command: `inframux trust prepare-checkout ${session.id}`,
      description: 'Preview the minimal checkout traversal access required by the hardened broker.',
      interactive: false, privileged: false,
    })]);
  }
  const missing = session.providers.filter((provider) => session.services[provider]?.config === undefined);
  if (missing.length > 0) {
    return createJourneyProjection('configuration-required', false, missing.map((providerId) => {
      const provider = providers.require(providerId);
      const fields = [...provider.onboarding.requiredConfig, ...provider.onboarding.optionalConfig];
      return createJourneyAction({
        type: 'configure-provider', actor: 'agent',
        command: `inframux onboard configure ${session.id} --service ${providerId} --input-json '<non-secret-json>' --json`,
        description: fields.length === 0
          ? `Confirm the non-secret ${provider.displayName} configuration.`
          : `Configure non-secret ${provider.displayName} fields: ${fields.join(', ')}.`,
        interactive: false, privileged: false,
      });
    }));
  }
  const unverified = session.providers.filter((provider) => session.services[provider]?.profile === undefined);
  if (unverified.length > 0) {
    return createJourneyProjection('authorization-required', false, [createJourneyAction({
      type: 'authorize-providers', actor: 'user',
      command: `inframux onboard authorize ${session.id}`,
      description: `Authorize ${unverified.length} remaining service${unverified.length === 1 ? '' : 's'} in your Terminal.`,
      interactive: true, privileged: false,
    })]);
  }
  return createJourneyProjection('ready-to-finish', false, [createJourneyAction({
    type: 'finish-onboarding', actor: 'agent',
    command: `inframux onboard finish ${session.id} --json`,
    description: 'Reconcile credentials and trust the exact captured checkout.',
    interactive: false, privileged: false,
  })]);
}

function postCompletionActions() {
  return [
    createJourneyAction({ type: 'inspect-status', actor: 'agent', command: 'inframux status --json',
      description: 'Inspect the resolved project and provider bindings.', interactive: false, privileged: false }),
    createJourneyAction({ type: 'verify-health', actor: 'agent', command: 'inframux doctor --json',
      description: 'Verify live provider health.', interactive: false, privileged: false }),
    createJourneyAction({ type: 'verify-audit', actor: 'agent', command: 'inframux audit verify --json',
      description: 'Verify the local audit chain.', interactive: false, privileged: false }),
  ];
}
