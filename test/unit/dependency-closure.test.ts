import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildProductionDependencyCopyPlan } from '../../src/install/dependency-closure.js';

test('collects required and present optional dependencies with nested versions but no dev packages', async (t) => {
  const root = await fixtureRoot(t);
  await packageAt(root, '.', {
    name: 'inframux', version: '0.1.0',
    dependencies: { a: '1.0.0', b: '1.0.0' }, devDependencies: { 'dev-only': '1.0.0' },
  });
  await packageAt(root, 'node_modules/a', {
    name: 'a', version: '1.0.0', dependencies: { shared: '^1.0.0' },
    optionalDependencies: { optional: '^1.0.0', absent: '^1.0.0' },
  });
  await packageAt(root, 'node_modules/a/node_modules/shared', { name: 'shared', version: '1.4.0' });
  await packageAt(root, 'node_modules/a/node_modules/optional', { name: 'optional', version: '1.1.0' });
  await packageAt(root, 'node_modules/b', { name: 'b', version: '1.0.0', dependencies: { shared: '^2.0.0' } });
  await packageAt(root, 'node_modules/shared', { name: 'shared', version: '2.2.0' });
  await packageAt(root, 'node_modules/dev-only', { name: 'dev-only', version: '1.0.0' });

  const plan = await buildProductionDependencyCopyPlan(root);
  assert.deepEqual(plan.map((entry) => [entry.name, entry.version, entry.relativePath]), [
    ['a', '1.0.0', 'node_modules/a'],
    ['optional', '1.1.0', 'node_modules/a/node_modules/optional'],
    ['shared', '1.4.0', 'node_modules/a/node_modules/shared'],
    ['b', '1.0.0', 'node_modules/b'],
    ['shared', '2.2.0', 'node_modules/shared'],
  ]);
  assert.equal(plan.some((entry) => entry.name === 'dev-only'), false);
  assert.equal(plan.some((entry) => entry.name === 'absent'), false);
});

test('fails closed for missing required dependencies and invalid package identity', async (t) => {
  const missing = await fixtureRoot(t, 'missing');
  await packageAt(missing, '.', { name: 'inframux', version: '0.1.0', dependencies: { absent: '1.0.0' } });
  await assert.rejects(buildProductionDependencyCopyPlan(missing), /missing required dependency.*absent/i);

  const wrong = await fixtureRoot(t, 'wrong');
  await packageAt(wrong, '.', { name: 'inframux', version: '0.1.0', dependencies: { expected: '1.0.0' } });
  await packageAt(wrong, 'node_modules/expected', { name: 'lookalike', version: '1.0.0' });
  await assert.rejects(buildProductionDependencyCopyPlan(wrong), /identity/i);

  const invalid = await fixtureRoot(t, 'invalid');
  await packageAt(invalid, '.', { name: 'inframux', version: '0.1.0', dependencies: { '../escape': '1.0.0' } });
  await assert.rejects(buildProductionDependencyCopyPlan(invalid), /dependency name/i);
});

test('rejects symlinked packages and symlink escapes inside package payloads', async (t) => {
  const linked = await fixtureRoot(t, 'linked');
  await packageAt(linked, '.', { name: 'inframux', version: '0.1.0', dependencies: { linked: '1.0.0' } });
  const foreign = path.join(linked, 'foreign');
  await packageAt(linked, 'foreign', { name: 'linked', version: '1.0.0' });
  await mkdir(path.join(linked, 'node_modules'), { recursive: true });
  await symlink(foreign, path.join(linked, 'node_modules/linked'));
  await assert.rejects(buildProductionDependencyCopyPlan(linked), /unsafe dependency directory/i);

  const escaped = await fixtureRoot(t, 'escaped');
  await packageAt(escaped, '.', { name: 'inframux', version: '0.1.0', dependencies: { safe: '1.0.0' } });
  const packageRoot = await packageAt(escaped, 'node_modules/safe', { name: 'safe', version: '1.0.0' });
  await symlink('/private/etc/passwd', path.join(packageRoot, 'escape'));
  await assert.rejects(buildProductionDependencyCopyPlan(escaped), /symlink/i);
});

async function fixtureRoot(t: TestContext, suffix = 'main'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `inframux-dependency-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function packageAt(root: string, relative: string, manifest: Record<string, unknown>): Promise<string> {
  const directory = path.resolve(root, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
  await writeFile(path.join(directory, 'index.js'), 'export {};\n', { mode: 0o644 });
  return directory;
}
