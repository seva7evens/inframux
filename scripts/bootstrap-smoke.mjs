import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { delay, parseJson, run, spawnService, terminateService, waitForSocket } from './smoke-helpers.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp('/tmp/inframux-installed-smoke-');
const installRoot = path.join(temporaryRoot, 'install');
const homeRoot = path.join(temporaryRoot, 'home');
const environment = Object.freeze({
  HOME: homeRoot,
  INFRAMUX_ROOT: installRoot,
  INFRAMUX_SECURITY_MODE: 'user',
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
});

try {
  const bootstrap = parseJson(await run(process.execPath, [
    path.join(repositoryRoot, 'dist/src/bin/inframux.js'),
    'bootstrap', '--user-mode', '--apply', '--json',
  ], repositoryRoot, environment, 6 * 60_000));
  assert.equal(bootstrap.mode, 'user');
  assert.equal(bootstrap.version, '0.1.6');

  const installedCli = path.join(installRoot, 'current/bin/inframux');
  const update = parseJson(await run(installedCli, ['update', '--check', '--json'], temporaryRoot, environment));
  assert.equal(update.currentVersion, '0.1.6');
  assert.equal(update.updateAvailable, false);

  const installedNode = path.join(installRoot, 'current/bin/node');
  const clientSocket = path.join(installRoot, 'run/client.sock');
  const workerSocket = path.join(installRoot, 'run/worker.sock');
  const serviceEnvironment = Object.freeze({
    ...environment,
    INFRAMUX_STATE_ROOT: path.join(installRoot, 'state'),
    INFRAMUX_FINGERPRINT_KEY: path.join(installRoot, 'state/keys/fingerprint.key'),
    INFRAMUX_AUDIT_KEY: path.join(installRoot, 'state/keys/audit.key'),
    INFRAMUX_CLIENT_SOCKET: clientSocket,
    INFRAMUX_WORKER_SOCKET: workerSocket,
    INFRAMUX_CALLER_UID: String(process.getuid?.() ?? 0),
    INFRAMUX_WORKER_ROOT: path.join(installRoot, 'worker'),
    INFRAMUX_TOOL_ROOT: path.join(installRoot, 'current/tools'),
    INFRAMUX_EXECUTABLE_MANIFEST: path.join(installRoot, 'current/executable-manifest.json'),
    INFRAMUX_RUNTIME_MANIFEST: path.join(installRoot, 'current/package.json'),
  });
  const broker = spawnService(installedNode, path.join(installRoot, 'current/dist/src/bin/broker.js'), temporaryRoot, serviceEnvironment);
  let worker;
  try {
    await waitForSocket(clientSocket, broker, 5_000);
    worker = spawnService(installedNode, path.join(installRoot, 'current/dist/src/bin/worker.js'), temporaryRoot, serviceEnvironment);
    await delay(150);
    assert.equal(worker.child.exitCode, null, worker.stderrText());
    assert.equal(worker.child.signalCode, null, worker.stderrText());
    assert.equal((await lstat(workerSocket)).isSocket(), true);
  } finally {
    if (worker !== undefined) await terminateService(worker.child);
    await terminateService(broker.child);
  }

  const doctor = parseJson(await run(
    path.join(installRoot, 'current/bin/agent-playwright'),
    ['doctor'],
    temporaryRoot,
    environment,
  ));
  assert.equal(doctor.ok, true);

  const uninstall = parseJson(await run(installedCli, ['uninstall', '--json'], temporaryRoot, environment));
  assert.equal(uninstall.uninstalled, true);
  assert.deepEqual(uninstall.preserved, [
    path.join(installRoot, 'state'),
    path.join(installRoot, 'browser-state'),
  ]);

  process.stdout.write('fresh installed user-mode bootstrap smoke passed\n');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
