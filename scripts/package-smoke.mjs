#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateArchive } from './package-contract.mjs';
import { delay, parseJson, run, spawnService, terminateService, waitForSocket } from './smoke-helpers.mjs';

const repositoryRoot = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && path.isAbsolute(npmCli), 'package smoke requires npm_execpath from npm run');

const temporaryRoot = await mkdtemp('/tmp/inframux-package-smoke-');
const packageOutputRoot = path.join(temporaryRoot, 'package');
const prefixRoot = path.join(temporaryRoot, 'prefix');
const installRoot = path.join(temporaryRoot, 'inframux-root');
const homeRoot = path.join(temporaryRoot, 'home');
const unrelatedCwd = path.join(temporaryRoot, 'unrelated-cwd');
const guardRoot = path.join(temporaryRoot, 'guard-bin');
const npmCache = path.join(temporaryRoot, 'npm-cache');
const npmUserConfig = path.join(temporaryRoot, 'npmrc-user');
const npmGlobalConfig = path.join(temporaryRoot, 'npmrc-global');
const sourceStatusBefore = await gitStatus();

try {
  for (const directory of [packageOutputRoot, homeRoot, unrelatedCwd, guardRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await symlink(process.execPath, path.join(guardRoot, 'node'));
  await writeFile(npmUserConfig, '', { mode: 0o600 });
  await writeFile(npmGlobalConfig, '', { mode: 0o600 });
  for (const command of ['npm', 'npx', 'corepack', 'tsc']) {
    await writeFile(path.join(guardRoot, command), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  }

  const packageEnvironment = Object.freeze({
    ...process.env,
    HOME: homeRoot,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    npm_config_audit: 'false',
    npm_config_cache: npmCache,
    npm_config_fund: 'false',
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_update_notifier: 'false',
    npm_config_userconfig: npmUserConfig,
  });
  const packOutput = await run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', packageOutputRoot], repositoryRoot, packageEnvironment, 5 * 60_000);
  const packageRecord = validateArchive(JSON.parse(packOutput));
  const tarball = path.join(packageOutputRoot, packageRecord.filename);
  await assertRegularFile(tarball);

  await run(process.execPath, [
    npmCli,
    'install', '--global', '--prefix', prefixRoot, tarball,
    '--foreground-scripts', '--no-audit', '--no-fund',
  ], unrelatedCwd, packageEnvironment, 5 * 60_000);

  const packageRoot = await realpath(path.join(prefixRoot, 'lib/node_modules/inframux'));
  const installedBin = path.join(prefixRoot, 'bin/inframux');
  await access(installedBin);
  await assertMissing(path.join(packageRoot, 'src'));
  await assertMissing(path.join(packageRoot, 'test'));
  await assertMissing(path.join(packageRoot, 'scripts'));
  await assertMissing(path.join(packageRoot, 'runtime/playwright/package.json'));
  await assertMissing(path.join(packageRoot, 'runtime/playwright/node_modules'));
  const packagedOnboardingGuide = await readFile(path.join(packageRoot, 'docs/onboarding.md'), 'utf8');
  const packagedPrompt = packagedOnboardingGuide.match(/## Reusable prompt[\s\S]*?```text\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(packagedPrompt, 'packaged onboarding guide must contain the reusable prompt');
  assert.match(packagedPrompt, /Services: <ENTER COMMA-SEPARATED SERVICES>/);
  assert.equal((packagedPrompt.match(/<[^>]+>/g) ?? []).length, 1);
  const packageDigestBefore = await treeDigest(packageRoot);

  const runtimeEnvironment = Object.freeze({
    HOME: homeRoot,
    INFRAMUX_FILEVAULT_STATUS: 'ready',
    INFRAMUX_ROOT: installRoot,
    INFRAMUX_SECURITY_MODE: 'user',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: `${guardRoot}:/usr/bin:/bin:/usr/sbin:/sbin`,
    npm_execpath: '/forbidden/inframux-bootstrap-must-not-run-npm',
  });

  await run(process.execPath, [
    path.join(repositoryRoot, 'scripts/cli-journey-smoke.mjs'), installedBin,
  ], unrelatedCwd, runtimeEnvironment);

  assert.match(await run(installedBin, ['--help'], unrelatedCwd, runtimeEnvironment), /inframux/);
  const onboardingPrompt = await run(installedBin, ['prompt', 'onboarding'], unrelatedCwd, runtimeEnvironment);
  assert.match(onboardingPrompt, /Services: <ENTER COMMA-SEPARATED SERVICES>/);
  assert.equal((onboardingPrompt.match(/<[^>]+>/g) ?? []).length, 1);
  const hardenedPreview = parseJson(await run(installedBin, ['bootstrap', '--json'], unrelatedCwd, runtimeEnvironment));
  assert.equal(hardenedPreview.mode, 'hardened');

  const bootstrap = parseJson(await run(installedBin, [
    'bootstrap', '--user-mode', '--apply', '--json',
  ], unrelatedCwd, runtimeEnvironment, 6 * 60_000));
  assert.equal(bootstrap.mode, 'user');
  assert.equal(bootstrap.version, '0.1.5');

  const sealedCli = path.join(installRoot, 'current/bin/inframux');
  const update = parseJson(await run(sealedCli, ['update', '--check', '--json'], unrelatedCwd, runtimeEnvironment));
  assert.equal(update.currentVersion, '0.1.5');
  assert.equal(update.updateAvailable, false);

  const installedNode = path.join(installRoot, 'current/bin/node');
  const clientSocket = path.join(installRoot, 'run/client.sock');
  const workerSocket = path.join(installRoot, 'run/worker.sock');
  const serviceEnvironment = Object.freeze({
    ...runtimeEnvironment,
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
  const broker = spawnService(installedNode, path.join(installRoot, 'current/dist/src/bin/broker.js'), unrelatedCwd, serviceEnvironment);
  let worker;
  try {
    await waitForSocket(clientSocket, broker, 5_000);
    worker = spawnService(installedNode, path.join(installRoot, 'current/dist/src/bin/worker.js'), unrelatedCwd, serviceEnvironment);
    await delay(150);
    assert.equal(worker.child.exitCode, null, worker.stderrText());
    assert.equal(worker.child.signalCode, null, worker.stderrText());
    assert.equal((await lstat(workerSocket)).isSocket(), true);
  } finally {
    if (worker !== undefined) await terminateService(worker.child);
    await terminateService(broker.child);
  }

  const playwrightLauncher = path.join(installRoot, 'current/bin/agent-playwright');
  const doctor = parseJson(await run(playwrightLauncher, ['doctor'], unrelatedCwd, runtimeEnvironment));
  assert.equal(doctor.ok, true);
  assert.equal(doctor.dependencyRoot, await realpath(path.join(installRoot, 'current')));
  const updateInstructions = await run(playwrightLauncher, ['update'], unrelatedCwd, runtimeEnvironment);
  assert.match(updateInstructions, /npm install --global inframux@<reviewed-version>/);

  const apiScript = path.join(unrelatedCwd, 'central-api-check.mjs');
  await writeFile(apiScript, `export default async ({ playwright, test, expect, workspace, artifactDir }) => {
    if (!playwright.chromium || typeof test !== 'function' || typeof expect !== 'function') throw new Error('central API unavailable');
    if (!workspace || !artifactDir) throw new Error('workspace context unavailable');
  };\n`, { mode: 0o600 });
  await run(playwrightLauncher, ['run', path.basename(apiScript)], unrelatedCwd, runtimeEnvironment);

  assert.equal(await treeDigest(packageRoot), packageDigestBefore, 'bootstrap/runtime commands mutated the installed npm package');
  const uninstall = parseJson(await run(sealedCli, ['uninstall', '--json'], unrelatedCwd, runtimeEnvironment));
  assert.equal(uninstall.uninstalled, true);
  assert.deepEqual(uninstall.preserved, [path.join(installRoot, 'state'), path.join(installRoot, 'browser-state')]);
  assert.equal((await lstat(path.join(installRoot, 'state'))).isDirectory(), true);

  assert.equal(await gitStatus(), sourceStatusBefore, 'package smoke changed repository state');
  process.stdout.write(`package consumer smoke passed: ${JSON.stringify(packageRecord)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function assertRegularFile(filename) {
  const stat = await lstat(filename);
  assert.equal(stat.isFile(), true, `Expected regular file: ${filename}`);
  assert.equal(stat.isSymbolicLink(), false, `Refusing symlink: ${filename}`);
}

async function assertMissing(filename) {
  await assert.rejects(lstat(filename), (error) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
}

async function gitStatus() {
  return run('git', ['status', '--porcelain=v1', '--untracked-files=all'], repositoryRoot, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C',
  });
}

async function treeDigest(root) {
  const hash = createHash('sha256');
  const visit = async (directory, relative) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await lstat(filename);
      hash.update(`${childRelative}\0${stat.mode & 0o777}\0`);
      if (stat.isSymbolicLink()) {
        hash.update(`link\0${await readlink(filename)}\0`);
      } else if (stat.isDirectory()) {
        hash.update('dir\0');
        await visit(filename, childRelative);
      } else if (stat.isFile()) {
        hash.update(`file\0${stat.size}\0`);
        hash.update(await readFile(filename));
      } else {
        throw new Error(`Unsafe installed package entry: ${filename}`);
      }
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}
