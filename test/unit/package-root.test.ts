import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolvePackageRoot } from '../../src/install/package-root.js';

test('resolves the immutable nearest inframux package independently of cwd', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-package-root-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const packageRoot = path.join(temporaryRoot, 'package');
  const moduleFile = path.join(packageRoot, 'dist/src/cli/main.js');
  await mkdir(path.dirname(moduleFile), { recursive: true });
  await writeFile(moduleFile, 'export {};\n', { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'inframux', version: '1.2.3', type: 'module',
    bin: { inframux: 'bin/inframux' },
  })}\n`, { mode: 0o644 });

  const previous = process.cwd();
  process.chdir(os.tmpdir());
  try {
    assert.deepEqual(resolvePackageRoot(pathToFileURL(moduleFile)), {
      root: await realpath(packageRoot),
      name: 'inframux',
      version: '1.2.3',
    });
  } finally {
    process.chdir(previous);
  }
});

test('rejects wrong identity, invalid versions, and unsafe package files', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-package-root-invalid-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const create = async (name: string, manifest: Record<string, unknown>) => {
    const root = path.join(temporaryRoot, name);
    const moduleFile = path.join(root, 'dist/src/cli/main.js');
    await mkdir(path.dirname(moduleFile), { recursive: true });
    await writeFile(moduleFile, 'export {};\n');
    await writeFile(path.join(root, 'package.json'), `${JSON.stringify(manifest)}\n`);
    return { root, moduleFile };
  };
  const valid = { name: 'inframux', version: '1.2.3', type: 'module', bin: { inframux: 'bin/inframux' } };

  const wrong = await create('wrong', { ...valid, name: 'lookalike' });
  assert.throws(() => resolvePackageRoot(pathToFileURL(wrong.moduleFile)), /identity/i);

  const version = await create('version', { ...valid, version: 'latest' });
  assert.throws(() => resolvePackageRoot(pathToFileURL(version.moduleFile)), /version/i);

  const symlinked = await create('symlinked', valid);
  const foreignManifest = path.join(temporaryRoot, 'foreign-package.json');
  await writeFile(foreignManifest, `${JSON.stringify(valid)}\n`);
  await rm(path.join(symlinked.root, 'package.json'));
  await symlink(foreignManifest, path.join(symlinked.root, 'package.json'));
  assert.throws(() => resolvePackageRoot(pathToFileURL(symlinked.moduleFile)), /unsafe/i);

  const hardlinked = await create('hardlinked', valid);
  await rm(path.join(hardlinked.root, 'package.json'));
  await link(foreignManifest, path.join(hardlinked.root, 'package.json'));
  assert.throws(() => resolvePackageRoot(pathToFileURL(hardlinked.moduleFile)), /unsafe/i);
});

test('rejects a symlinked or missing executing module', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-package-module-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const realModule = path.join(temporaryRoot, 'real.js');
  const linkModule = path.join(temporaryRoot, 'link.js');
  await writeFile(realModule, 'export {};\n');
  await symlink(realModule, linkModule);
  assert.throws(() => resolvePackageRoot(pathToFileURL(linkModule)), /unsafe module/i);
  assert.throws(() => resolvePackageRoot(pathToFileURL(path.join(temporaryRoot, 'missing.js'))), /module/i);
});
