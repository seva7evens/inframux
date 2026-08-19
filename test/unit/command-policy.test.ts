import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProviderCommand } from '../../src/providers/command-policy.js';
import { createProviderRegistry } from '../../src/providers/registry.js';

const registry = createProviderRegistry();

test('allows reviewed provider subcommands while preserving hostile values as argv', () => {
  assert.deepEqual(
    validateProviderCommand(registry.require('synthetic'), ['echo', 'name=$(touch /tmp/nope)']),
    ['echo', 'name=$(touch /tmp/nope)'],
  );
});

test('rejects unknown commands and flags that alter identity, config, execution, or tool trust', () => {
  const provider = registry.require('synthetic');
  for (const args of [
    ['login'], ['logout'], ['deploy'], ['unknown'],
    ['echo', '--token', 'secret'],
    ['echo', '--cwd=/tmp/other'],
    ['echo', '--global-config', '/tmp/config'],
    ['echo', '--scope', 'other-team'],
    ['echo', '--debug'],
    ['echo', '--update'],
    ['echo', '--plugin=repo-code'],
  ]) {
    assert.throws(() => validateProviderCommand(provider, args), /not approved|blocked/i, args.join(' '));
  }
  assert.throws(
    () => validateProviderCommand(registry.require('vercel'), ['anything']),
    /does not expose an approved cli/i,
  );
});
