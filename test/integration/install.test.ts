import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBundleManifest, verifyBundle } from '../../src/install/bundle.js';
import {
  activateVersion,
  applyToRoot,
  planBootstrap,
  planUninstall,
  planUpdate,
  rollback,
} from '../../src/install/lifecycle.js';

const TEST_UID = process.getuid?.() ?? 0;
const TEST_GID = process.getgid?.() ?? 0;

test('seals exact bundle paths, owners, modes, sizes and digests and rejects substitutions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = await createStage(root, '1.0.0', 'one');
  const manifest = await createBundleManifest(stage, {
    version: '1.0.0', nodeVersion: '24.18.1', installUid: TEST_UID, installGid: TEST_GID,
  });
  assert.deepEqual(manifest.files.map((file) => file.path), ['bin/node', 'dist/app.js']);
  assert.equal(manifest.files.every((file) => file.digest.startsWith('sha256:') && file.uid === process.getuid?.()), true);
  assert.equal(manifest.files.every((file) => file.installUid === TEST_UID && file.installGid === TEST_GID), true);
  const rootOwned = await createBundleManifest(stage, { version: '1.0.0', nodeVersion: '24.18.1' });
  assert.equal(rootOwned.files.every((file) => file.installUid === 0 && file.installGid === 0), true);
  await verifyBundle(stage, manifest);

  await writeFile(path.join(stage, 'dist/app.js'), 'changed');
  await assert.rejects(() => verifyBundle(stage, manifest), /size|digest|changed/i);
  await writeFile(path.join(stage, 'dist/app.js'), 'one');
  await chmod(path.join(stage, 'dist/app.js'), 0o600);
  await assert.rejects(() => verifyBundle(stage, manifest), /changed/i);
  await chmod(path.join(stage, 'dist/app.js'), 0o644);
  await symlink('/etc/hosts', path.join(stage, 'escape'));
  await assert.rejects(() => createBundleManifest(stage, { version: '1.0.0', nodeVersion: '24.18.1' }), /symbolic link/i);
  await rm(path.join(stage, 'escape'));
  await link(path.join(stage, 'dist/app.js'), path.join(stage, 'hard'));
  await assert.rejects(() => createBundleManifest(stage, { version: '1.0.0', nodeVersion: '24.18.1' }), /hard link/i);
  await assert.rejects(() => createBundleManifest(stage, { version: '1.0.0', nodeVersion: '24.17.0' }), /24\.18\.1/);
});

test('plans hardened bootstrap only with FileVault and exact service identities', () => {
  const common = {
    mode: 'hardened' as const,
    installRoot: '/Library/Application Support/inframux',
    stagedRoot: '/private/var/tmp/inframux-stage',
    version: '1.0.0', nodeVersion: '24.18.1', fileVaultStatus: 'ready' as const,
    accounts: { broker: null, worker: null }, socketPathsExist: false,
  };
  const plan = planBootstrap(common);
  assert.equal(plan.actions.some((action) => /npm|npx|Documents\/GitHub/.test(JSON.stringify(action))), false);
  assert.deepEqual(plan.accounts, ['_inframux', '_inframuxw']);
  assert.throws(() => planBootstrap({ ...common, fileVaultStatus: 'disabled' }), /FileVault/i);
  assert.throws(() => planBootstrap({ ...common, socketPathsExist: true }), /socket/i);
  assert.throws(() => planBootstrap({
    ...common, accounts: { broker: { name: '_inframux', shell: '/bin/zsh', home: '/Users/bad' }, worker: null },
  }), /account/i);
});

test('rolls back every injected install boundary and supports update, rollback, and preserving-state uninstall', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'installed');
  const firstStage = await createStage(root, '1.0.0', 'one');
  const firstManifest = await createBundleManifest(firstStage, {
    version: '1.0.0', nodeVersion: '24.18.1', installUid: TEST_UID, installGid: TEST_GID,
  });
  await applyToRoot({ stagedRoot: firstStage, targetRoot: installRoot, manifest: firstManifest, probe: async () => true });
  assert.equal(await activeVersion(installRoot), '1.0.0');
  await mkdir(path.join(installRoot, 'state/credentials'), { recursive: true });
  await writeFile(path.join(installRoot, 'state/credentials/keep'), 'secret-state-placeholder');

  const secondStage = await createStage(root, '2.0.0', 'two');
  const secondManifest = await createBundleManifest(secondStage, {
    version: '2.0.0', nodeVersion: '24.18.1', installUid: TEST_UID, installGid: TEST_GID,
  });
  for (const failAt of ['after-create', 'after-copy', 'after-verify', 'after-switch', 'after-probe'] as const) {
    const freshRoot = path.join(root, `fresh-${failAt}`);
    await assert.rejects(() => applyToRoot({
      stagedRoot: secondStage, targetRoot: freshRoot, manifest: secondManifest,
      probe: async () => true, failAt,
    }), /injected/i);
    await assert.rejects(() => lstat(path.join(freshRoot, 'current')), /ENOENT/);
    await assert.rejects(() => applyToRoot({
      stagedRoot: secondStage, targetRoot: installRoot, manifest: secondManifest,
      probe: async () => true, failAt,
    }), /injected/i);
    assert.equal(await activeVersion(installRoot), '1.0.0');
  }

  const update = planUpdate({ currentVersion: '1.0.0', targetManifest: secondManifest });
  assert.equal(update.targetVersion, '2.0.0');
  await applyToRoot({ stagedRoot: secondStage, targetRoot: installRoot, manifest: secondManifest, probe: async () => true });
  assert.equal(await activeVersion(installRoot), '2.0.0');
  await rollback(installRoot, '1.0.0');
  assert.equal(await activeVersion(installRoot), '1.0.0');
  await activateVersion(installRoot, '2.0.0');

  const thirdStage = await createStage(root, '3.0.0', 'three');
  const thirdManifest = await createBundleManifest(thirdStage, {
    version: '3.0.0', nodeVersion: '24.18.1', installUid: TEST_UID, installGid: TEST_GID,
  });
  await applyToRoot({ stagedRoot: thirdStage, targetRoot: installRoot, manifest: thirdManifest, probe: async () => true });
  assert.deepEqual((await readdir(path.join(installRoot, 'runtime/versions'))).sort(), ['2.0.0', '3.0.0']);

  const uninstall = planUninstall({ installRoot, purgeState: false, purgeBrowserProfiles: false });
  assert.equal(uninstall.remove.some((target) => target.includes('/state') || target.includes('browser-state')), false);
  assert.equal(await readFile(path.join(installRoot, 'state/credentials/keep'), 'utf8'), 'secret-state-placeholder');
});

async function createStage(root: string, version: string, body: string): Promise<string> {
  const stage = path.join(root, `stage-${version}`);
  await mkdir(path.join(stage, 'bin'), { recursive: true });
  await mkdir(path.join(stage, 'dist'), { recursive: true });
  await writeFile(path.join(stage, 'bin/node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(stage, 'dist/app.js'), body, { mode: 0o644 });
  return stage;
}

async function activeVersion(installRoot: string): Promise<string> {
  const stat = await lstat(path.join(installRoot, 'current'));
  assert.equal(stat.isSymbolicLink(), true);
  return path.basename(await readlink(path.join(installRoot, 'current')));
}
