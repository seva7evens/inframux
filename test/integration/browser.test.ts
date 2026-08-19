import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireBrowserProfile, cleanupCleanProfile, planBrowserLaunch } from '../../src/browser/manager.js';

const context = {
  project: 'sample', repositoryRoot: '/workspace/sample', gitCommonDir: '/workspace/sample/.git',
  canonicalRemote: 'github.com/example-org/sample_app', manifestDigest: `sha256:${'a'.repeat(64)}`,
  approvedAt: '2026-08-18T00:00:00.000Z',
};

test('preserves persistent state, excludes it from clean sessions, and locks canonical writers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const common = {
    context, browserStateRoot: path.join(root, 'state'), browserTasksRoot: path.join(root, 'tasks'),
    runtimeLauncher: '/runtime/agent-playwright',
  };
  const persistent = planBrowserLaunch({ ...common, mode: 'persistent', provider: 'cloudflare' });
  const first = await acquireBrowserProfile(persistent);
  await writeFile(path.join(persistent.profileDir, 'origin-state.json'), '{"cookie":"session"}');
  await assert.rejects(() => acquireBrowserProfile(persistent), /already in use|locked/i);
  await first.release();
  const second = await acquireBrowserProfile(persistent);
  assert.equal(await readFile(path.join(persistent.profileDir, 'origin-state.json'), 'utf8'), '{"cookie":"session"}');
  await second.release();

  const clean = planBrowserLaunch({ ...common, mode: 'clean' });
  const cleanLease = await acquireBrowserProfile(clean);
  await assert.rejects(() => readFile(path.join(clean.profileDir, 'origin-state.json')), /ENOENT/);
  await cleanLease.release();
  const cleanTaskRoot = clean.taskRoot;
  assert.ok(cleanTaskRoot);
  await assert.rejects(() => lstat(cleanTaskRoot), /ENOENT/);
  assert.equal(await readFile(path.join(persistent.profileDir, 'origin-state.json'), 'utf8'), '{"cookie":"session"}');
});

test('allows concurrent clean profiles and rejects symlink cleanup escapes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-browser-clean-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const common = {
    mode: 'clean' as const, context, browserStateRoot: path.join(root, 'state'),
    browserTasksRoot: path.join(root, 'tasks'), runtimeLauncher: '/runtime/agent-playwright',
  };
  const first = planBrowserLaunch(common);
  const second = planBrowserLaunch(common);
  assert.notEqual(first.taskRoot, second.taskRoot);
  const [firstLease, secondLease] = await Promise.all([acquireBrowserProfile(first), acquireBrowserProfile(second)]);
  await Promise.all([firstLease.release(), secondLease.release()]);

  const outside = path.join(root, 'outside');
  await writeFile(outside, 'must-survive');
  const malicious = path.join(root, 'tasks/malicious');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(malicious), { recursive: true });
  await symlink(outside, malicious);
  await assert.rejects(() => cleanupCleanProfile(path.join(root, 'tasks'), malicious), /symbolic link/i);
  assert.equal(await readFile(outside, 'utf8'), 'must-survive');
});
