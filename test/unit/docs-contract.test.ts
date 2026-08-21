import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { parseCli } from '../../src/cli/parse.js';
import { createProviderRegistry } from '../../src/providers/registry.js';

const root = path.resolve(import.meta.dirname, '../..');

test('documents the implemented safe CLI and labels live-provider work honestly', async () => {
  const documents = await Promise.all([
    'README.md', 'SECURITY.md', 'docs/architecture.md', 'docs/operations.md',
    'docs/onboarding.md', 'docs/provider-enrollment.md', 'docs/testing.md',
  ].map(async (filename) => [filename, await readFile(path.join(root, filename), 'utf8')] as const));
  const all = documents.map(([, contents]) => contents).join('\n');
  for (const command of [
    ['status'], ['doctor'], ['project', 'resolve'], ['run', 'synthetic', '--', 'resources'],
    ['call', 'synthetic', 'resources.list'], ['launch', 'mcp', 'synthetic'],
    ['browser', 'mcp', 'clean'], ['browser', 'mcp', 'persistent', '--provider', 'synthetic'],
    ['audit', 'verify'], ['bootstrap', '--user-mode'], ['update', '--check'], ['uninstall', '--dry-run'],
  ]) assert.doesNotThrow(() => parseCli(command));
  assert.match(all, /production core/i);
  assert.match(all, /(?:real-account|live-provider) acceptance (?:is intentionally )?pending/i);
  assert.equal(/broker implementation pending|commands.*not implemented yet/i.test(documents[0]![1]), false);
});

test('pins package installation and bootstrap execution to the required NVM runtime', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /nvm exec 24\.18\.1 npm install --global inframux@0\.1\.5/);
  assert.match(readme, /nvm exec 24\.18\.1 inframux bootstrap --apply/);
  assert.doesNotMatch(readme, /^npm install --global inframux@0\.1\.0$/m);
});

test('keeps documented provider capability names in sync', async () => {
  const enrollment = await readFile(path.join(root, 'docs/provider-enrollment.md'), 'utf8');
  for (const provider of createProviderRegistry().list()) {
    for (const capability of provider.capabilities) assert.match(enrollment, new RegExp(capability.operation.replace('.', '\\.')));
  }
});
