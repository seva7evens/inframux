import { randomBytes } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadCatalog } from '../config/load.js';
import { assertSafeRegularFile, atomicWritePrivateFile, ensurePrivateDirectory } from '../core/safe-files.js';
import { RUNTIME_NODE_VERSION } from '../core/version.js';
import { EnrolledCatalogStore } from '../trust/catalog-store.js';
import { createBundleManifest, type BundleManifest } from './bundle.js';
import { buildProductionDependencyCopyPlan } from './dependency-closure.js';
import { applyToRoot } from './lifecycle.js';

export async function stageLocalRelease(input: {
  readonly sourceRoot: string;
  readonly stagingRoot: string;
  readonly targetRoot: string;
  readonly version: string;
  readonly nodeExecutable?: string;
  readonly installUid?: number;
  readonly installGid?: number;
}): Promise<BundleManifest> {
  assertAbsoluteClean(input.stagingRoot, 'stagingRoot');
  assertAbsoluteClean(input.targetRoot, 'targetRoot');
  const sourceRoot = await realpath(input.sourceRoot);
  const nodeExecutable = await realpath(input.nodeExecutable ?? process.execPath);
  const nodeStat = await lstat(nodeExecutable);
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || nodeStat.nlink !== 1) throw new Error('Runtime Node executable is unsafe');
  const stageParent = await realpath(path.dirname(input.stagingRoot));
  const stagingRoot = path.join(stageParent, path.basename(input.stagingRoot));
  await mkdir(stagingRoot, { mode: 0o700 });
  try {
    await copySealed(nodeExecutable, path.join(stagingRoot, 'bin/node'), 0o755);
    await copyRequiredTree(path.join(sourceRoot, 'dist'), path.join(stagingRoot, 'dist'));
    await copySealed(path.join(sourceRoot, 'package.json'), path.join(stagingRoot, 'package.json'), 0o644);
    for (const dependency of await buildProductionDependencyCopyPlan(sourceRoot)) {
      await copyDependencyPackage(dependency.source, path.join(stagingRoot, dependency.relativePath));
    }
    if (await exists(path.join(sourceRoot, 'runtime/playwright'))) {
      await copyPlaywrightRuntime(
        path.join(sourceRoot, 'runtime/playwright'),
        path.join(stagingRoot, 'runtime/playwright'),
        stagingRoot,
        input.targetRoot,
      );
    }
    await writeExecutable(path.join(stagingRoot, 'bin/inframux'), shellLauncher(
      path.join(input.targetRoot, 'current/bin/node'),
      path.join(input.targetRoot, 'current/dist/src/bin/inframux.js'),
    ));
    if (await exists(path.join(stagingRoot, 'runtime/playwright/src/launcher.mjs'))) {
      await writeExecutable(path.join(stagingRoot, 'bin/agent-playwright'), shellLauncher(
        path.join(input.targetRoot, 'current/bin/node'),
        path.join(input.targetRoot, 'current/runtime/playwright/src/launcher.mjs'),
      ));
    }
    await writeFile(path.join(stagingRoot, 'executable-manifest.json'), `${JSON.stringify({
      schema: 1,
      runtimeNodeVersion: RUNTIME_NODE_VERSION,
      executables: {},
    }, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    return await createBundleManifest(stagingRoot, {
      version: input.version,
      nodeVersion: RUNTIME_NODE_VERSION,
      ...(input.installUid === undefined ? {} : { installUid: input.installUid }),
      ...(input.installGid === undefined ? {} : { installGid: input.installGid }),
    });
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function applyUserBootstrap(input: {
  readonly stagedRoot: string;
  readonly targetRoot: string;
  readonly manifest: BundleManifest;
}): Promise<{ readonly schema: 1; readonly mode: 'user'; readonly version: string; readonly executable: string }> {
  await applyToRoot({
    stagedRoot: input.stagedRoot,
    targetRoot: input.targetRoot,
    manifest: input.manifest,
    probe: async (activeRoot) => {
      await initializeBrokerState(input.targetRoot);
      await assertSafeRegularFile(path.join(activeRoot, 'dist/src/bin/broker.js'), { mode: 0o644 });
      await assertSafeRegularFile(path.join(activeRoot, 'dist/src/bin/worker.js'), { mode: 0o644 });
      return true;
    },
  });
  return Object.freeze({
    schema: 1,
    mode: 'user',
    version: input.manifest.version,
    executable: path.join(input.targetRoot, 'current/bin/inframux'),
  });
}

export async function initializeBrokerState(targetRoot: string, catalogDirectory?: string): Promise<void> {
  const stateRoot = path.join(targetRoot, 'state');
  await ensurePrivateDirectory(stateRoot);
  await ensurePrivateDirectory(path.join(stateRoot, 'keys'));
  for (const name of ['audit.key', 'fingerprint.key']) {
    const filename = path.join(stateRoot, 'keys', name);
    if (await exists(filename)) {
      await assertSafeRegularFile(filename);
      const key = await readFile(filename);
      if (key.length !== 32) throw new Error(`Existing broker key has invalid length: ${name}`);
      continue;
    }
    const key = randomBytes(32);
    try {
      await atomicWritePrivateFile(stateRoot, path.join('keys', name), key);
    } finally {
      key.fill(0);
    }
  }
  if (catalogDirectory === undefined) return;
  const catalogs = new EnrolledCatalogStore(stateRoot);
  const entries = (await import('node:fs/promises')).readdir(catalogDirectory, { withFileTypes: true });
  for (const entry of (await entries).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.yaml')) continue;
    await catalogs.enroll(await loadCatalog(path.join(catalogDirectory, entry.name)));
  }
}

async function copyRequiredTree(source: string, destination: string): Promise<void> {
  const stat = await lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Required release directory is unsafe: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    filter: (candidate) => path.basename(candidate) !== '.DS_Store',
  });
}

async function copyDependencyPackage(source: string, destination: string): Promise<void> {
  const stat = await lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Required dependency directory is unsafe: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    filter: (candidate) => candidate === source || !['.DS_Store', 'node_modules'].includes(path.basename(candidate)),
  });
}

async function copyPlaywrightRuntime(source: string, destination: string, stagingRoot: string, targetRoot: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o755 });
  await copyRequiredTree(path.join(source, 'src'), path.join(destination, 'src'));
  const binRoot = path.join(stagingRoot, 'node_modules/.bin');
  await mkdir(binRoot, { recursive: true, mode: 0o755 });
  const installedDependencyRoot = path.join(targetRoot, 'current/node_modules');
  for (const [name, entry] of [
    ['playwright', '@playwright/test/cli.js'],
    ['playwright-cli', '@playwright/cli/playwright-cli.js'],
    ['playwright-mcp', '@playwright/mcp/cli.js'],
  ] as const) {
    const filename = path.join(binRoot, name);
    await writeFile(filename, shellLauncher(
      path.join(targetRoot, 'current/bin/node'),
      path.join(installedDependencyRoot, entry),
    ), { mode: 0o755 });
    await chmod(filename, 0o755);
  }
}

async function copySealed(source: string, destination: string, mode: number): Promise<void> {
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Required release file is unsafe: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination, (await import('node:fs')).constants.COPYFILE_EXCL);
  await chmod(destination, mode);
}

async function writeExecutable(filename: string, source: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o755 });
  await writeFile(filename, source, { mode: 0o755, flag: 'wx' });
  await chmod(filename, 0o755);
}

function shellLauncher(node: string, entry: string): string {
  return `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`;
}

function shellQuote(value: string): string {
  if (/\0|[\r\n]/u.test(value)) throw new Error('Unsafe launcher path');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertAbsoluteClean(value: string, name: string): void {
  if (!path.isAbsolute(value) || /\0|[\r\n]/u.test(value)) throw new Error(`${name} must be a clean absolute path`);
}

async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
