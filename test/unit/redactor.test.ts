import assert from 'node:assert/strict';
import test from 'node:test';

import { Redactor } from '../../src/security/redactor.js';

test('redacts active exact credentials and structural secret forms', () => {
  const redactor = new Redactor({ maxInputBytes: 16_384 });
  const unregister = redactor.registerSecret('synthetic-token-123456');
  const input = [
    'plain=synthetic-token-123456',
    'encoded=synthetic-token-123456',
    'Authorization: Bearer another-token-value',
    'Cookie: session=private-cookie-value',
    'https://user:password@example.invalid/path',
    '{"refresh_token":"oauth-refresh-value","safe":"visible"}',
    '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
  ].join('\n');

  const output = redactor.redact(input);
  for (const secret of [
    'synthetic-token-123456',
    'another-token-value',
    'private-cookie-value',
    'password',
    'oauth-refresh-value',
    'abc123',
  ]) {
    assert.equal(output.includes(secret), false, secret);
  }
  assert.match(output, /"safe":"visible"/);
  unregister();
  assert.match(redactor.redact('synthetic-token-123456'), /synthetic-token-123456/);
});

test('bounds input before redaction and detects secret-bearing serialized output', () => {
  const bounded = new Redactor({ maxInputBytes: 16 });
  assert.throws(() => bounded.redact('x'.repeat(17)), /output limit/i);

  const canaryAware = new Redactor({ maxInputBytes: 64 });
  canaryAware.registerSecret('canary-secret');
  assert.throws(() => canaryAware.assertClean('value=canary-secret'), /secret-bearing/i);
  assert.doesNotThrow(() => canaryAware.assertClean('safe metadata'));
});
