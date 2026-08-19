import assert from 'node:assert/strict';
import test from 'node:test';

import { renderOperationalHuman } from '../../src/cli/operations-ui.js';

test('renders doctor health and exact recovery without internal JSON', () => {
  const output = renderOperationalHuman('doctor', {
    schema: 1, project: 'example', securityMode: 'hardened', checkoutApproved: true,
    providers: [
      { id: 'sentry', health: 'healthy', identity: { organization: 'example-org' } },
      { id: 'vercel', health: 'missing', error: 'CREDENTIAL_MISSING', recovery: 'inframux replace-token vercel' },
    ],
  }, { unicode: true, verbose: false });
  assert.match(output, /inframux doctor · example/);
  assert.match(output, /✓ sentry · healthy · example-org/);
  assert.match(output, /✗ vercel · missing/);
  assert.match(output, /inframux replace-token vercel/);
  assert.doesNotMatch(output, /"providers"|"schema"/);
});

test('renders capability, checkout preview, and maintenance outcomes as actions', () => {
  const capabilities = renderOperationalHuman('capabilities', {
    id: 'vercel', displayName: 'Vercel', capabilities: [
      { operation: 'api.request', surface: 'api', support: 'stable', destructive: true, classification: 'control-plane' },
    ],
  }, { unicode: false, verbose: false });
  assert.match(capabilities, /Vercel capabilities/);
  assert.match(capabilities, /api.request · api · stable · destructive/);

  const trust = renderOperationalHuman('trust.prepare-checkout', {
    ready: false, principal: '_inframux', ancestors: ['/private-home/Documents'],
    nextActions: [{ actor: 'user', command: 'inframux trust prepare-checkout 018f47d2-8737-7a19-8000-123456789abc --apply' }],
  }, { unicode: false, verbose: false });
  assert.match(trust, /Minimal checkout access required/);
  assert.match(trust, /only directory search/);
  assert.match(trust, /--apply/);

  const bootstrap = renderOperationalHuman('bootstrap', {
    schema: 1, mode: 'hardened', version: '0.1.0', executable: '/Library/Application Support/inframux/current/bin/inframux',
  }, { unicode: false, verbose: false });
  assert.match(bootstrap, /inframux 0.1.0 installed/);
  assert.match(bootstrap, /Mode: hardened/);

  const bootstrapPreview = renderOperationalHuman('bootstrap', {
    schema: 1, mode: 'hardened', state: 'planned', complete: false,
    nextActions: [{ actor: 'user', command: 'inframux bootstrap --apply' }],
  }, { unicode: false, verbose: false });
  assert.match(bootstrapPreview, /bootstrap plan ready/i);
  assert.doesNotMatch(bootstrapPreview, /bootstrap complete/i);
  assert.match(bootstrapPreview, /inframux bootstrap --apply/);
});
