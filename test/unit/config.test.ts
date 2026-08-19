import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadCatalog, loadRepositoryManifest } from '../../src/config/load.js';

test('loads closed repository TOML and rejects fields that could redirect identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-config-'));
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }));

  const manifest = path.join(root, '.inframux.toml');
  await writeFile(manifest, 'schema = 1\nproject = "sample"\nregistry = "sample"\n');
  assert.deepEqual(await loadRepositoryManifest(manifest), {
    schema: 1,
    project: 'sample',
    registry: 'sample',
  });

  await writeFile(manifest, 'schema = 1\nproject = "sample"\nregistry = "sample"\npath = "/tmp/other"\n');
  await assert.rejects(() => loadRepositoryManifest(manifest), /unrecognized key/i);

  await writeFile(manifest, 'schema = 1\nproject = "../sample"\nregistry = "sample"\n');
  await assert.rejects(() => loadRepositoryManifest(manifest), /invalid/i);
});

test('loads public catalog metadata and rejects secret-looking material', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-catalog-'));
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, 'sample.yaml');
  await writeFile(catalog, [
    'schema: 1',
    'id: sample',
    'displayName: Sample Project',
    'repositories:',
    '  - remote: github.com/EXAMPLE-ORG/sample_app',
    'services:',
    '  vercel:',
    '    credential: sample-vercel-admin',
    '    teamId: team_public',
    '',
  ].join('\n'));

  const loaded = await loadCatalog(catalog);
  assert.equal(loaded.id, 'sample');
  assert.equal(loaded.repositories[0]?.remote, 'github.com/EXAMPLE-ORG/sample_app');

  await writeFile(catalog, [
    'schema: 1',
    'id: sample',
    'displayName: Sample Project',
    'repositories: []',
    'services:',
    '  vercel:',
    '    credential: sample-vercel-admin',
    '    apiToken: synthetic-secret-must-not-enter-git',
    '',
  ].join('\n'));
  await assert.rejects(() => loadCatalog(catalog), /secret material.*apiToken/i);
});
