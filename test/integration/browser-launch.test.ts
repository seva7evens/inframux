import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { planBrowserLaunch } from '../../src/browser/manager.js';
import { runBrowserPlan } from '../../src/browser/runner.js';
import { launchBrowserFromRepository } from '../../src/cli/browser-launch.js';
import { listenUnixSocket } from '../../src/ipc/server.js';

const run = promisify(execFile);

const context = {
  project: 'sample', repositoryRoot: '/workspace/sample', gitCommonDir: '/workspace/sample/.git',
  canonicalRemote: 'github.com/example-org/sample_app', manifestDigest: `sha256:${'a'.repeat(64)}`,
  approvedAt: '2026-08-18T00:00:00.000Z',
};

test('runs the absolute central launcher without a shell and releases the persistent lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-browser-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'fake launcher');
  await writeFile(launcher, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-dir') + 1];
fs.writeFileSync(path.join(output, 'invocation.json'), JSON.stringify({ args, shellProbe: process.env.INFRAMUX_SHELL_PROBE ?? null }));
`);
  await chmod(launcher, 0o700);
  const plan = planBrowserLaunch({
    mode: 'persistent', context: { ...context, repositoryRoot: root, gitCommonDir: path.join(root, '.git') },
    provider: 'cloudflare', browserStateRoot: path.join(root, 'state'),
    browserTasksRoot: path.join(root, 'tasks'), runtimeLauncher: launcher,
  });

  await runBrowserPlan(plan, { stdio: 'ignore', environment: { ...process.env, INFRAMUX_SHELL_PROBE: 'must-not-leak' } });
  const invocation = JSON.parse(await readFile(path.join(plan.artifactDir, 'invocation.json'), 'utf8')) as {
    args: string[]; shellProbe: string | null;
  };
  assert.deepEqual(invocation.args, plan.args);
  assert.equal(invocation.shellProbe, null);

  await runBrowserPlan(plan, { stdio: 'ignore' });
});

test('deletes a clean profile after both successful and failed child exits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-browser-exit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'failing-launcher');
  await writeFile(launcher, '#!/bin/sh\nexit 23\n');
  await chmod(launcher, 0o700);
  const plan = planBrowserLaunch({
    mode: 'clean', context: { ...context, repositoryRoot: root, gitCommonDir: path.join(root, '.git') },
    taskId: '0198b443-f1c2-7b2f-a7b1-88e305891234',
    browserStateRoot: path.join(root, 'state'), browserTasksRoot: path.join(root, 'tasks'), runtimeLauncher: launcher,
  });

  await assert.rejects(() => runBrowserPlan(plan, { stdio: 'ignore' }), /code 23/i);
  const taskRoot = plan.taskRoot;
  assert.ok(taskRoot);
  await assert.rejects(() => readFile(path.join(taskRoot, 'profile', 'anything')), /ENOENT/);
});

test('resolves the repository through the broker before selecting browser state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-browser-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  await run('git', ['init', '-b', 'main', repository]);
  await writeFile(path.join(repository, '.inframux.toml'), 'schema = 1\nproject = "sample"\nregistry = "sample"\n');
  await run('git', ['-C', repository, 'remote', 'add', 'origin', 'git@github.com:example-org/sample_app.git']);
  const socketPath = path.join(root, 'run', 'client.sock');
  let resolveCalls = 0;
  const server = await listenUnixSocket({
    socketPath,
    handlers: {
      'project.resolve': async (payload) => {
        resolveCalls += 1;
        const checkout = payload as { evidence: { repositoryRoot: string; gitCommonDir: string; manifestDigest: string } };
        return {
          ...context,
          repositoryRoot: checkout.evidence.repositoryRoot,
          gitCommonDir: checkout.evidence.gitCommonDir,
          manifestDigest: checkout.evidence.manifestDigest,
        };
      },
    },
  });
  t.after(() => server.close());
  const launcher = path.join(root, 'launcher');
  await writeFile(launcher, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-dir') + 1];
fs.writeFileSync(path.join(output, 'resolved-cwd'), process.cwd());
`);
  await chmod(launcher, 0o700);

  await launchBrowserFromRepository('persistent', 'cloudflare', {
    cwd: repository,
    socketPath,
    browserStateRoot: path.join(root, 'browser-state'),
    browserTasksRoot: path.join(root, 'browser-tasks'),
    runtimeLauncher: launcher,
    stdio: 'ignore',
  });

  assert.equal(resolveCalls, 1);
  assert.equal(
    await readFile(path.join(root, 'browser-state/.artifacts/sample/cloudflare/resolved-cwd'), 'utf8'),
    await realpath(repository),
  );
});
