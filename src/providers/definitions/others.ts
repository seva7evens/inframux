import { capability, commonBlockedFlags } from '../capabilities.js';
import type { ProviderDefinition } from '../types.js';

export const sentryProvider: ProviderDefinition = {
  id: 'sentry', displayName: 'Sentry', adapterVersion: 1,
  credentialEnvironmentVariable: 'SENTRY_AUTH_TOKEN', executables: {},
  identity: { operation: 'identity.verify', expectedFields: ['organization', 'origin'], maxAgeMs: 86_400_000 },
  recoveryCommand: 'inframux replace-token sentry',
  onboarding: {
    auth: 'static-token', setupUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    documentationUrl: 'https://docs.sentry.io/api/auth/', requiredConfig: ['origin', 'organization'],
    optionalConfig: ['projects'], credentialReuse: 'explicit',
  },
  capabilities: [capability('identity.verify', { surface: 'api' }), capability('resources.list', { surface: 'api' }), capability('api.request', { surface: 'api', destructive: true, idempotent: false })],
};

export const uptimeRobotProvider: ProviderDefinition = {
  id: 'uptimerobot', displayName: 'UptimeRobot', adapterVersion: 1,
  credentialEnvironmentVariable: 'UPTIMEROBOT_API_KEY', executables: {},
  identity: { operation: 'identity.verify', expectedFields: ['accountFingerprint'], maxAgeMs: 86_400_000 },
  recoveryCommand: 'inframux replace-token uptimerobot',
  onboarding: {
    auth: 'static-token', setupUrl: 'https://dashboard.uptimerobot.com/integrations',
    documentationUrl: 'https://uptimerobot.com/api/v3/', requiredConfig: [],
    optionalConfig: ['monitors'], credentialReuse: 'explicit',
  },
  capabilities: [capability('identity.verify', { surface: 'api' }), capability('resources.list', { surface: 'api' }), capability('api.request', { surface: 'api', destructive: true, idempotent: false })],
};

export const resendProvider: ProviderDefinition = {
  id: 'resend', displayName: 'Resend', adapterVersion: 1,
  credentialEnvironmentVariable: 'RESEND_API_KEY', executables: {},
  identity: { operation: 'identity.verify', expectedFields: ['accountScope'], maxAgeMs: 86_400_000 },
  recoveryCommand: 'inframux replace-token resend',
  onboarding: {
    auth: 'static-token', setupUrl: 'https://resend.com/api-keys',
    documentationUrl: 'https://resend.com/docs/api-reference/api-keys/create-api-key',
    requiredConfig: [], optionalConfig: ['accountScope', 'anticipatedDomain', 'status'], credentialReuse: 'explicit',
  },
  capabilities: [capability('identity.verify', { surface: 'api' }), capability('resources.list', { surface: 'api' }), capability('api.request', { surface: 'api', destructive: true, idempotent: false })],
};

export const posthogProvider: ProviderDefinition = {
  id: 'posthog', displayName: 'PostHog', adapterVersion: 1,
  credentialEnvironmentVariable: 'POSTHOG_PERSONAL_API_KEY', executables: {},
  identity: { operation: 'identity.verify', expectedFields: ['organizationId', 'projectId'], maxAgeMs: 86_400_000 },
  recoveryCommand: 'inframux replace-token posthog',
  onboarding: {
    auth: 'static-token', setupUrl: 'https://us.posthog.com/settings/user-api-keys',
    documentationUrl: 'https://posthog.com/docs/api', requiredConfig: ['origin', 'organizationId', 'projectId'],
    optionalConfig: [], credentialReuse: 'explicit',
  },
  capabilities: [capability('identity.verify', { surface: 'api' }), capability('resources.list', { surface: 'api' }), capability('api.request', { surface: 'api', destructive: true, idempotent: false })],
};

export const googleCloudProvider: ProviderDefinition = {
  id: 'google-cloud', displayName: 'Google Cloud', adapterVersion: 1,
  credentialEnvironmentVariable: 'CLOUDSDK_AUTH_ACCESS_TOKEN', executables: {},
  identity: { operation: 'identity.verify', expectedFields: ['account'], maxAgeMs: 3_600_000 },
  recoveryCommand: 'inframux reauthorize google-cloud',
  onboarding: {
    auth: 'oauth-pkce', setupUrl: 'https://console.cloud.google.com/apis/credentials',
    documentationUrl: 'https://developers.google.com/identity/protocols/oauth2/resources/best-practices',
    requiredConfig: ['account', 'scopes'], optionalConfig: ['projects'], credentialReuse: 'explicit',
  },
  capabilities: [
    capability('identity.verify', { surface: 'api' }),
    capability('resources.list', { surface: 'api' }),
    capability('api.request', { surface: 'api', destructive: true, idempotent: false }),
  ],
};

export const syntheticProvider: ProviderDefinition = {
  id: 'synthetic', displayName: 'Synthetic test provider', adapterVersion: 1,
  credentialEnvironmentVariable: 'INFRAMUX_SYNTHETIC_TOKEN',
  executables: { cli: 'synthetic-cli', mcp: 'synthetic-mcp' },
  identity: { operation: 'identity.verify', expectedFields: ['accountId'], maxAgeMs: 60_000 },
  recoveryCommand: 'inframux replace-token synthetic',
  onboarding: {
    auth: 'static-token', setupUrl: 'https://example.invalid/inframux/synthetic',
    documentationUrl: 'https://example.invalid/inframux/synthetic/docs', requiredConfig: ['accountId'],
    optionalConfig: [], credentialReuse: 'explicit',
  },
  capabilities: [capability('identity.verify', { surface: 'cli' }), capability('resources.list', { surface: 'cli' }), capability('mcp.launch', { surface: 'official-mcp' })],
  commandPolicy: { allowedTopLevel: ['identity', 'resources', 'echo', 'sleep', 'overflow', 'crash'], blockedFlags: commonBlockedFlags },
};
