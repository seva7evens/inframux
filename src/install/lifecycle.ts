import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { RUNTIME_NODE_VERSION } from '../core/version.js';
import { assertFileVaultReady, type FileVaultStatus } from './filevault.js';
import { verifyBundle, type BundleFile, type BundleManifest } from './bundle.js';

export interface ServiceAccountState { readonly name: string; readonly shell: string; readonly home: string }

export function planBootstrap(input: {
  mode: 'hardened' | 'user';
  installRoot: string;
  stagedRoot: string;
  version: string;
  nodeVersion: string;
  fileVaultStatus: FileVaultStatus;
  accounts: { readonly broker: ServiceAccountState | null; readonly worker: ServiceAccountState | null };
  socketPathsExist: boolean;
}): {
  readonly mode: 'hardened' | 'user';
  readonly accounts: readonly string[];
  readonly actions: readonly Readonly<Record<string, string>>[];
} {
  if (!path.isAbsolute(input.installRoot) || !path.isAbsolute(input.stagedRoot)) throw new Error('Install roots must be absolute');
  if (input.nodeVersion !== RUNTIME_NODE_VERSION) throw new Error(`Bootstrap requires Node ${RUNTIME_NODE_VERSION}`);
  if (input.socketPathsExist) throw new Error('Existing socket collision must be resolved before bootstrap');
  if (input.mode === 'hardened') assertFileVaultReady(input.fileVaultStatus);
  assertAccount(input.accounts.broker, '_inframux');
  assertAccount(input.accounts.worker, '_inframuxw');
  const accounts = input.mode === 'hardened' ? ['_inframux', '_inframuxw'] : [];
  const actions = [
    { kind: 'verify-sealed-bundle', source: input.stagedRoot },
    ...(accounts.map((name) => ({ kind: 'ensure-service-account', name }))),
    { kind: 'install-version', target: path.join(input.installRoot, 'runtime/versions', input.version) },
    { kind: 'activate-version', target: input.version },
    ...(input.mode === 'hardened'
      ? [{ kind: 'load-launch-daemons', target: '/Library/LaunchDaemons/dev.inframux.*.plist' }]
      : []),
    { kind: 'probe-isolation', target: input.installRoot },
  ];
  return Object.freeze({ mode: input.mode, accounts: Object.freeze(accounts), actions: Object.freeze(actions.map(Object.freeze)) });
}

export type InstallFailurePoint = 'after-create' | 'after-copy' | 'after-verify' | 'after-switch' | 'after-probe';

export async function applyToRoot(input: {
  stagedRoot: string;
  targetRoot: string;
  manifest: BundleManifest;
  probe: (activeRoot: string) => Promise<boolean>;
  failAt?: InstallFailurePoint;
}): Promise<void> {
  await verifyBundle(input.stagedRoot, input.manifest);
  await mkdir(path.join(input.targetRoot, 'runtime/versions'), { recursive: true, mode: 0o755 });
  const versionsRoot = path.join(input.targetRoot, 'runtime/versions');
  const finalRoot = path.join(versionsRoot, input.manifest.version);
  const temporaryRoot = path.join(versionsRoot, `.install-${input.manifest.version}-${randomUUID()}`);
  const previous = await currentVersionOrNull(input.targetRoot);
  let switched = false;
  try {
    await mkdir(temporaryRoot, { mode: 0o755 });
    inject(input.failAt, 'after-create');
    for (const file of input.manifest.files) await copySealedFile(input.stagedRoot, temporaryRoot, file);
    inject(input.failAt, 'after-copy');
    await verifyBundle(temporaryRoot, installedManifest(input.manifest));
    inject(input.failAt, 'after-verify');
    try {
      await lstat(finalRoot);
      throw new Error(`Install version already exists: ${input.manifest.version}`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await rename(temporaryRoot, finalRoot);
    await activateVersion(input.targetRoot, input.manifest.version);
    switched = true;
    inject(input.failAt, 'after-switch');
    if (!await input.probe(finalRoot)) throw new Error('Activated inframux version failed health/isolation probe');
    inject(input.failAt, 'after-probe');
    await pruneVersions(versionsRoot, new Set([input.manifest.version, ...(previous === null ? [] : [previous])]));
  } catch (error) {
    if (switched) {
      if (previous === null) await rm(path.join(input.targetRoot, 'current'), { force: true });
      else await activateVersion(input.targetRoot, previous);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(finalRoot, { recursive: true, force: true });
    throw error;
  }
}

async function pruneVersions(versionsRoot: string, keep: ReadonlySet<string>): Promise<void> {
  const entries = await readdir(versionsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(entry.name)) {
      throw new Error(`Unexpected entry in sealed versions root: ${entry.name}`);
    }
    if (!keep.has(entry.name)) await rm(path.join(versionsRoot, entry.name), { recursive: true, force: false });
  }
}

export async function activateVersion(installRoot: string, version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) throw new Error('Invalid activation version');
  const versionRoot = path.join(installRoot, 'runtime/versions', version);
  const stat = await lstat(versionRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Activation target is not a sealed version directory');
  const temporary = path.join(installRoot, `.current-${randomUUID()}`);
  await symlink(path.join('runtime', 'versions', version), temporary);
  try {
    await rename(temporary, path.join(installRoot, 'current'));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function rollback(installRoot: string, version: string): Promise<void> {
  await activateVersion(installRoot, version);
}

export function planUpdate(input: { currentVersion: string; targetManifest: BundleManifest }): {
  readonly currentVersion: string; readonly targetVersion: string; readonly changedFiles: readonly string[];
} {
  return Object.freeze({
    currentVersion: input.currentVersion,
    targetVersion: input.targetManifest.version,
    changedFiles: Object.freeze(input.targetManifest.files.map((file) => file.path)),
  });
}

export function planUninstall(input: { installRoot: string; purgeState: boolean; purgeBrowserProfiles: boolean }): {
  readonly remove: readonly string[]; readonly preserve: readonly string[];
} {
  const remove = [
    path.join(input.installRoot, 'current'),
    path.join(input.installRoot, 'runtime'),
    '/Library/LaunchDaemons/dev.inframux.broker.plist',
    '/Library/LaunchDaemons/dev.inframux.worker.plist',
  ];
  if (input.purgeState) remove.push(path.join(input.installRoot, 'state'));
  if (input.purgeBrowserProfiles) remove.push('~/.config/inframux/browser-state');
  const preserve = [
    ...(!input.purgeState ? [path.join(input.installRoot, 'state')] : []),
    ...(!input.purgeBrowserProfiles ? ['~/.config/inframux/browser-state'] : []),
  ];
  return Object.freeze({ remove: Object.freeze(remove), preserve: Object.freeze(preserve) });
}

async function copySealedFile(sourceRoot: string, targetRoot: string, file: BundleFile): Promise<void> {
  const source = path.join(sourceRoot, ...file.path.split('/'));
  const target = path.join(targetRoot, ...file.path.split('/'));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let targetHandle;
  try {
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile() || sourceStat.nlink !== 1 || (sourceStat.mode & 0o777) !== file.mode || sourceStat.size !== file.size) {
      throw new Error(`Staged install file changed: ${file.path}`);
    }
    const contents = await sourceHandle.readFile();
    targetHandle = await open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, file.mode);
    await targetHandle.writeFile(contents);
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    await chmod(target, file.mode);
    await chown(target, file.installUid, file.installGid);
  } finally {
    await targetHandle?.close();
    await sourceHandle.close();
  }
}

function installedManifest(manifest: BundleManifest): BundleManifest {
  return {
    ...manifest,
    files: manifest.files.map((file) => ({
      ...file,
      uid: file.installUid,
      gid: file.installGid,
    })),
  };
}

async function currentVersionOrNull(installRoot: string): Promise<string | null> {
  try {
    const current = path.join(installRoot, 'current');
    const stat = await lstat(current);
    if (!stat.isSymbolicLink()) throw new Error('Current install pointer is not a symbolic link');
    return path.basename(await readlink(current));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertAccount(account: ServiceAccountState | null, expectedName: string): void {
  if (account === null) return;
  if (account.name !== expectedName || account.shell !== '/usr/bin/false' || account.home !== '/var/empty') {
    throw new Error(`Existing service account ${expectedName} has an unsafe identity`);
  }
}

function inject(actual: InstallFailurePoint | undefined, point: InstallFailurePoint): void {
  if (actual === point) throw new Error(`Injected install failure at ${point}`);
}
