import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stageLocalRelease } from '../../src/install/coordinator.js';
import {
  applyHardenedBootstrap,
  applyHardenedRollback,
  applyHardenedUninstall,
  applyCheckoutAccess,
  readCheckoutAccessRequest,
  writeCheckoutAccessRequest,
  readManagementRequest,
  writeManagementRequest,
  type ManagementSystem,
} from '../../src/install/management.js';

test('applies only a session-bound search ACL to checkout ancestors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-checkout-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryInput = path.join(root, 'private', 'repository');
  await mkdir(repositoryInput, { recursive: true });
  const repository = await realpath(repositoryInput);
  const ancestor = await realpath(path.dirname(repository));
  const requestFile = path.join(root, 'request.json');
  const uid = process.getuid!(); const gid = process.getgid!();
  await writeCheckoutAccessRequest(requestFile, {
    schema: 1, operation: 'checkout-access', targetRoot: '/Library/Application Support/inframux',
    sessionId: '018f47d2-8737-7a19-8000-123456789abc', principal: '_inframux',
    repositoryRoot: repository, gitCommonDir: path.join(repository, '.git'), ancestors: [ancestor],
    caller: { uid, gid, username: os.userInfo().username },
  });
  const request = await readCheckoutAccessRequest(requestFile);
  const system = new FakeManagementSystem(uid, gid);
  const result = await applyCheckoutAccess(request, system);
  assert.deepEqual(result, { schema: 1, prepared: true, principal: '_inframux', ancestors: [ancestor] });
  assert.deepEqual(system.checkoutAncestors, [ancestor]);

  await assert.rejects(applyCheckoutAccess({ ...request, ancestors: ['/tmp'] }, system), /checkout ancestor/i);
});

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
  assert.deepEqual(system.events, ['revoke-checkout-access', 'stop', 'remove']);
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
  checkoutAncestors: string[] = [];
  constructor(readonly uid: number, readonly gid: number) {}
  async fileVaultStatus() { this.events.push('filevault'); return 'ready' as const; }
  async ensureServiceAccounts() {
    this.events.push('accounts');
    return { brokerUid: this.uid, workerUid: this.uid, groupGid: this.gid };
  }
  async prepareDataRoots() { this.events.push('prepare'); }
  async installUserLaunchers() { this.events.push('launchers'); }
  async installLaunchDaemons(plists: { broker: string; worker: string }) { this.events.push('plists'); this.plists = plists; }
  readonly probeResults: boolean[] = [];
  async restartServices(_targetRoot: string) { this.events.push('restart'); }
  async probeServices(_targetRoot?: string, _options?: { allowLegacyHealth?: boolean }) {
    this.events.push('probe'); return this.probeResults.shift() ?? true;
  }
  async stopServices() { this.events.push('stop'); }
  async removeInstallation() { this.events.push('remove'); }
  async grantCheckoutAccess(_targetRoot: string, ancestors: readonly string[], _sessionId: string) { this.checkoutAncestors.push(...ancestors); }
  async revokeOwnedCheckoutAccess() { this.events.push('revoke-checkout-access'); }
}

test('failed upgrade restores and re-probes the retained runtime without deleting state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-upgrade-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'installed');
  const uid = process.getuid!();
  const gid = process.getgid!();
  const caller = { uid, gid, username: os.userInfo().username };
  const system = new FakeManagementSystem(uid, gid);

  const firstStage = path.join(root, 'stage-0.1.0');
  const firstManifest = await stageLocalRelease({
    sourceRoot: path.resolve(import.meta.dirname, '../..'), stagingRoot: firstStage, targetRoot: target,
    version: '0.1.0', installUid: uid, installGid: gid,
  });
  await applyHardenedBootstrap({
    schema: 1, operation: 'bootstrap', stagedRoot: firstStage, targetRoot: target, manifest: firstManifest, caller,
  }, system);
  await mkdir(path.join(target, 'state/credentials'), { recursive: true });
  const credentialSentinel = path.join(target, 'state/credentials/preserved');
  await (await import('node:fs/promises')).writeFile(credentialSentinel, 'do-not-delete');

  system.events.length = 0;
  system.probeResults.push(false, true);
  const upgradeStage = path.join(root, 'stage-0.1.4');
  const upgradeManifest = await stageLocalRelease({
    sourceRoot: path.resolve(import.meta.dirname, '../..'), stagingRoot: upgradeStage, targetRoot: target,
    version: '0.1.4', installUid: uid, installGid: gid,
  });
  await assert.rejects(applyHardenedBootstrap({
    schema: 1, operation: 'bootstrap', stagedRoot: upgradeStage, targetRoot: target, manifest: upgradeManifest, caller,
  }, system), /health\/isolation probe/);

  assert.equal(path.basename(await readlink(path.join(target, 'current'))), '0.1.0');
  assert.equal(await (await import('node:fs/promises')).readFile(credentialSentinel, 'utf8'), 'do-not-delete');
  assert.deepEqual(system.events, [
    'filevault', 'accounts', 'prepare', 'launchers', 'plists',
    'restart', 'probe', 'restart', 'probe',
  ]);
});
