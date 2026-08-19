import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stageLocalRelease } from '../../src/install/coordinator.js';
import {
  applyHardenedBootstrap,
  applyHardenedRollback,
  applyHardenedUninstall,
  readManagementRequest,
  writeManagementRequest,
  type ManagementSystem,
} from '../../src/install/management.js';

test('applies hardened release through a narrow management boundary and probes both services', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-management-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'installed');
  const stage = path.join(root, 'stage');
  const uid = process.getuid!();
  const gid = process.getgid!();
  const manifest = await stageLocalRelease({
    sourceRoot: path.resolve(import.meta.dirname, '../..'), stagingRoot: stage, targetRoot: target,
    version: '0.1.0', installUid: uid, installGid: gid,
  });
  const system = new FakeManagementSystem(uid, gid);
  const result = await applyHardenedBootstrap({
    schema: 1, operation: 'bootstrap', stagedRoot: stage, targetRoot: target, manifest,
    caller: { uid, gid, username: os.userInfo().username },
  }, system);
  assert.equal(result.mode, 'hardened');
  assert.equal(path.basename(await readlink(path.join(target, 'current'))), '0.1.0');
  assert.deepEqual(system.events, ['filevault', 'accounts', 'prepare', 'launchers', 'plists', 'restart', 'probe']);
  assert.match(system.plists?.broker ?? '', /INFRAMUX_CALLER_UID/);
  assert.match(system.plists?.worker ?? '', /INFRAMUX_EXECUTABLE_MANIFEST/);
  assert.doesNotMatch(JSON.stringify(system.plists), /Documents\/GitHub|\.nvm|npm|npx/);

  await mkdir(path.join(target, 'runtime/versions/0.0.9'));
  system.events.length = 0;
  const rolledBack = await applyHardenedRollback({
    schema: 1, operation: 'rollback', targetRoot: target, version: '0.0.9',
    caller: { uid, gid, username: os.userInfo().username },
  }, system);
  assert.deepEqual(rolledBack, { schema: 1, rolledBack: true, from: '0.1.0', to: '0.0.9' });
  assert.deepEqual(system.events, ['restart', 'probe']);

  system.events.length = 0;
  const uninstalled = await applyHardenedUninstall({
    schema: 1, operation: 'uninstall', targetRoot: target,
    caller: { uid, gid, username: os.userInfo().username },
  }, system);
  assert.equal(uninstalled.uninstalled, true);
  assert.deepEqual(system.events, ['stop', 'remove']);
});

test('rejects management requests that break caller and root ownership invariants', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-management-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uid = process.getuid!();
  const gid = process.getgid!();
  const base = {
    schema: 1 as const,
    operation: 'bootstrap' as const,
    stagedRoot: path.join(root, 'stage'),
    targetRoot: '/Library/Application Support/inframux',
    manifest: {
      schema: 1 as const,
      version: '0.1.0',
      nodeVersion: '24.18.1',
      files: [{
        path: 'bin/node', mode: 0o755, uid, gid, installUid: uid, installGid: gid,
        size: 1, digest: `sha256:${'0'.repeat(64)}`,
      }],
    },
    caller: { uid, gid, username: os.userInfo().username },
  };
  const unsafeInstallOwner = path.join(root, 'unsafe-install-owner.json');
  await writeManagementRequest(unsafeInstallOwner, base);
  await assert.rejects(readManagementRequest(unsafeInstallOwner), /root-owned/);

  const wrongCaller = path.join(root, 'wrong-caller.json');
  await writeManagementRequest(wrongCaller, {
    ...base,
    manifest: {
      ...base.manifest,
      files: base.manifest.files.map((file) => ({ ...file, installUid: 0, installGid: 0 })),
    },
    caller: { ...base.caller, uid: uid + 1 },
  });
  await assert.rejects(readManagementRequest(wrongCaller), /owner does not match/);
});

class FakeManagementSystem implements ManagementSystem {
  readonly events: string[] = [];
  plists?: { broker: string; worker: string };
  constructor(readonly uid: number, readonly gid: number) {}
  async fileVaultStatus() { this.events.push('filevault'); return 'ready' as const; }
  async ensureServiceAccounts() {
    this.events.push('accounts');
    return { brokerUid: this.uid, workerUid: this.uid, groupGid: this.gid };
  }
  async prepareDataRoots() { this.events.push('prepare'); }
  async installUserLaunchers() { this.events.push('launchers'); }
  async installLaunchDaemons(plists: { broker: string; worker: string }) { this.events.push('plists'); this.plists = plists; }
  async restartServices() { this.events.push('restart'); }
  async probeServices() { this.events.push('probe'); return true; }
  async stopServices() { this.events.push('stop'); }
  async removeInstallation() { this.events.push('remove'); }
}
