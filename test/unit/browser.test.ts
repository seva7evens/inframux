import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { planBrowserLaunch } from '../../src/browser/manager.js';

const context = {
  project: 'sample', repositoryRoot: '/workspace/sample', gitCommonDir: '/workspace/sample/.git',
  canonicalRemote: 'github.com/example-org/sample_app', manifestDigest: `sha256:${'a'.repeat(64)}`,
  approvedAt: '2026-08-18T00:00:00.000Z',
};

test('plans explicit persistent project/provider state and clean task state', () => {
  const persistent = planBrowserLaunch({
    mode: 'persistent', context, provider: 'cloudflare', browserStateRoot: '/state/browser-state',
    browserTasksRoot: '/state/browser-tasks', runtimeLauncher: '/runtime/bin/agent-playwright',
  });
  assert.equal(persistent.profileDir, '/state/browser-state/sample/cloudflare');
  assert.equal(persistent.cleanup, false);
  assert.deepEqual(persistent.args.slice(0, 5), ['mcp', '--user-data-dir', persistent.profileDir, '--output-dir', persistent.artifactDir]);

  const clean = planBrowserLaunch({
    mode: 'clean', context, taskId: '0198b443-f1c2-7b2f-a7b1-88e305891234',
    browserStateRoot: '/state/browser-state', browserTasksRoot: '/state/browser-tasks',
    runtimeLauncher: '/runtime/bin/agent-playwright',
  });
  assert.equal(clean.profileDir, path.join('/state/browser-tasks', '0198b443-f1c2-7b2f-a7b1-88e305891234/profile'));
  assert.equal(clean.cleanup, true);
  assert.equal(clean.profileDir.startsWith(persistent.profileDir), false);
});

test('requires a provider for persistent mode and rejects unsafe identifiers or launchers', () => {
  const common = {
    context, browserStateRoot: '/state/browser-state', browserTasksRoot: '/state/browser-tasks',
    runtimeLauncher: '/runtime/bin/agent-playwright',
  };
  assert.throws(() => planBrowserLaunch({ ...common, mode: 'persistent' }), /provider/i);
  assert.throws(() => planBrowserLaunch({ ...common, mode: 'persistent', provider: '../other' }), /provider/i);
  assert.throws(() => planBrowserLaunch({ ...common, mode: 'clean', runtimeLauncher: 'relative-launcher' }), /absolute/i);
});
