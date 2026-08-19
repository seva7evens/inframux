import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyUserBootstrap, stageLocalRelease } from '../../src/install/coordinator.js';
import { verifyBundle } from '../../src/install/bundle.js';
import { runCli } from '../../src/cli/main.js';

test('stages a relocatable locked release and applies user mode with private keys', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-coordinator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  const target = path.join(root, 'installed');
  const source = path.resolve(import.meta.dirname, '../..');
  const uid = process.getuid!();
  const gid = process.getgid!();
  const manifest = await stageLocalRelease({
    sourceRoot: source,
    stagingRoot: stage,
    targetRoot: target,
    version: '0.1.0',
    nodeExecutable: process.execPath,
    installUid: uid,
    installGid: gid,
  });
  await verifyBundle(stage, manifest);
  assert.ok(manifest.files.some((file) => file.path === 'dist/src/bin/inframux.js'));
  assert.ok(manifest.files.some((file) => file.path === 'node_modules/zod/index.js'));
  assert.ok(manifest.files.some((file) => file.path === 'node_modules/@playwright/cli/playwright-cli.js'));
  assert.ok(manifest.files.some((file) => file.path === 'node_modules/@playwright/cli/node_modules/playwright/package.json'));
  assert.ok(manifest.files.some((file) => file.path === 'node_modules/playwright/node_modules/playwright-core/package.json'));
  assert.equal(manifest.files.some((file) => file.path.startsWith('node_modules/typescript/')), false);
  assert.equal(manifest.files.some((file) => file.path.startsWith('node_modules/tsx/')), false);
  assert.ok(manifest.files.some((file) => file.path === 'node_modules/.bin/playwright' && file.mode === 0o755));
  assert.ok(manifest.files.some((file) => file.path === 'node_modules/.bin/playwright-cli' && file.mode === 0o755));
  assert.ok(manifest.files.some((file) => file.path === 'node_modules/.bin/playwright-mcp' && file.mode === 0o755));
  assert.equal(manifest.files.some((file) => file.path.startsWith('runtime/playwright/node_modules/')), false);
  assert.equal(manifest.files.some((file) => file.path === 'runtime/playwright/package.json'), false);
  assert.equal(manifest.files.some((file) => file.path === 'runtime/playwright/package-lock.json'), false);
  assert.equal(manifest.files.some((file) => file.path.startsWith('projects/')), false);
  assert.ok(manifest.files.some((file) => file.path === 'bin/inframux' && file.mode === 0o755));

  const result = await applyUserBootstrap({ stagedRoot: stage, targetRoot: target, manifest });
  assert.equal(result.version, '0.1.0');
  assert.equal(path.basename(await readlink(path.join(target, 'current'))), '0.1.0');
  for (const key of ['audit.key', 'fingerprint.key']) {
    const stat = await lstat(path.join(target, 'state/keys', key));
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.size, 32);
  }
  assert.doesNotMatch(await readFile(path.join(target, 'current/bin/inframux'), 'utf8'), /Documents\/GitHub|\.nvm/);

  let output = '';
  const cliDependencies = {
    cwd: source, stdin: process.stdin,
    writeStdout: (value: string) => { output += value; },
    writeStderr: () => undefined,
    environment: { INFRAMUX_ROOT: target, INFRAMUX_SECURITY_MODE: 'user' },
  };
  assert.equal(await runCli(['update', '--check', '--json'], cliDependencies), 0);
  assert.equal(JSON.parse(output).currentVersion, '0.1.0');
  output = '';
  assert.equal(await runCli(['uninstall', '--json'], cliDependencies), 0);
  assert.equal(JSON.parse(output).uninstalled, true);
  await assert.rejects(lstat(path.join(target, 'current')), /ENOENT/);
  assert.equal((await lstat(path.join(target, 'state'))).isDirectory(), true);
});
