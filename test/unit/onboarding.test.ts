import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeServiceConfig } from '../../src/onboarding/config.js';
import { deriveProjectIdentity, parseServiceList } from '../../src/onboarding/project.js';
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
