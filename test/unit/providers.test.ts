import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderRegistry } from '../../src/providers/registry.js';

test('publishes complete immutable provider identity and recovery contracts', () => {
  const registry = createProviderRegistry();
  const expected = [
    'cloudflare', 'google-cloud', 'posthog', 'resend', 'sentry',
    'supabase', 'synthetic', 'uptimerobot', 'vercel',
  ];
  assert.deepEqual(registry.list().map((provider) => provider.id), expected);

  for (const provider of registry.list()) {
    assert.ok(provider.identity.operation.length > 0, provider.id);
    assert.ok(provider.identity.expectedFields.length > 0, provider.id);
    assert.match(provider.recoveryCommand, /^inframux /, provider.id);
    assert.equal(Object.isFrozen(provider), true, provider.id);
    assert.equal(new Set(provider.capabilities.map((item) => item.operation)).size, provider.capabilities.length);
    for (const capability of provider.capabilities) {
      assert.ok(['api', 'cli', 'official-mcp', 'browser'].includes(capability.surface));
      assert.ok(['control-plane', 'source-bound'].includes(capability.classification));
      assert.ok(['stable', 'preview', 'unsupported'].includes(capability.support));
      if (capability.destructive) assert.equal(typeof capability.idempotent, 'boolean');
    }
  }
});

test('generates completion candidates from the same provider registry', () => {
  const registry = createProviderRegistry();
  const candidates = registry.completionCandidates();
  assert.ok(candidates.includes('vercel:resources.list'));
  assert.ok(candidates.includes('cloudflare:identity.verify'));
  assert.ok(candidates.includes('synthetic:mcp.launch'));
  assert.equal(candidates.some((candidate) => candidate.includes('login')), false);
});
