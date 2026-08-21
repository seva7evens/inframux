import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeServiceConfig } from '../../src/onboarding/config.js';
import { deriveProjectIdentity, parseServiceList } from '../../src/onboarding/project.js';
import { projectOnboardingJourney } from '../../src/onboarding/projection.js';
import type { OnboardingSession } from '../../src/onboarding/session-store.js';
import { createProviderRegistry } from '../../src/providers/registry.js';

const registry = createProviderRegistry();

test('normalizes, sorts, and deduplicates supported service lists', () => {
  assert.deepEqual(parseServiceList(' Supabase,cloudflare,supabase ', registry), ['cloudflare', 'supabase']);
  assert.throws(() => parseServiceList('', registry), /at least one/i);
  assert.throws(() => parseServiceList('cloudflare,unknown', registry), /unknown provider.*unknown/i);
});

test('derives a stable project identity from the canonical remote', () => {
  assert.deepEqual(deriveProjectIdentity(['github.com/example-org/alpha_app']), {
    id: 'alpha-app',
    displayName: 'alpha app',
    canonicalRemote: 'github.com/example-org/alpha_app',
  });
  assert.equal(deriveProjectIdentity(['gitlab.com/team/My.Project']).id, 'my-project');
  assert.throws(() => deriveProjectIdentity([]), /exactly one canonical remote/i);
  assert.throws(() => deriveProjectIdentity(['a/x', 'b/y']), /exactly one canonical remote/i);
});

test('provider descriptors expose bounded authorization metadata', () => {
  for (const provider of registry.list()) {
    assert.match(provider.onboarding.setupUrl, /^https:\/\//);
    assert.match(provider.onboarding.documentationUrl, /^https:\/\//);
    assert.ok(['static-token', 'oauth-pkce'].includes(provider.onboarding.auth));
    assert.equal(provider.onboarding.credentialReuse, 'explicit');
  }
});

test('sanitizes non-secret provider config and enforces required pins', () => {
  const cloudflare = registry.require('cloudflare');
  assert.deepEqual(sanitizeServiceConfig(cloudflare, { accountId: 'account-1', zones: [{ name: 'example.com' }] }), {
    credential: 'cloudflare-admin', accountId: 'account-1', zones: [{ name: 'example.com' }],
  });
  assert.throws(() => sanitizeServiceConfig(cloudflare, {}), /accountId/);
  assert.throws(() => sanitizeServiceConfig(cloudflare, {
    accountId: 'account-1', nested: { apiToken: 'must-not-enter-config' },
  }), /secret material field.*apiToken/i);
  assert.throws(() => sanitizeServiceConfig(cloudflare, {
    accountId: 'account-1', origin: 'https://attacker.invalid',
  }), /unsupported config field.*origin/i);
});

test('projects every onboarding state with one exact next transition', () => {
  const base = {
    schema: 1 as const, id: '018f47d2-8737-7a19-8000-123456789abc', callerUid: 501,
    project: 'example', displayName: 'Example', providers: ['cloudflare'], services: {},
    evidence: {
      repositoryRoot: '/workspace/example', gitCommonDir: '/workspace/example/.git',
      manifestPath: '/workspace/example/.inframux.toml', manifestDigest: `sha256:${'a'.repeat(64)}`,
      normalizedRemotes: ['github.com/acme/example'],
    },
    workspaceRoot: '/workspace/example', createdAt: '2026-08-19T10:00:00.000Z',
    expiresAt: '2026-08-20T10:00:00.000Z',
  } satisfies OnboardingSession;

  const configuration = projectOnboardingJourney(base, registry, 'ready');
  assert.equal(configuration.state, 'configuration-required');
  assert.match(configuration.nextActions[0]!.command, /onboard configure .* --service cloudflare/);

  const configured = projectOnboardingJourney({ ...base, services: {
    cloudflare: { config: { credential: 'example-cloudflare-admin', accountId: 'account' } },
  } }, registry, 'ready');
  assert.equal(configured.state, 'authorization-required');
  assert.equal(configured.nextActions[0]!.command, `inframux onboard authorize ${base.id}`);

  const verified = projectOnboardingJourney({ ...base, services: {
    cloudflare: { config: { credential: 'example-cloudflare-admin', accountId: 'account' },
      profile: 'example-cloudflare-admin', verifiedAt: '2026-08-19T10:05:00.000Z' },
  } }, registry, 'ready');
  assert.equal(verified.state, 'ready-to-finish');
  assert.equal(verified.nextActions[0]!.command, `inframux onboard finish ${base.id} --json`);

  const blocked = projectOnboardingJourney(base, registry, 'required');
  assert.equal(blocked.state, 'checkout-access-required');
  assert.equal(blocked.nextActions[0]!.command, `inframux trust prepare-checkout ${base.id}`);
});
