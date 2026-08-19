import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import { z } from 'zod';

import type { BundleManifest } from './bundle.js';
import { initializeBrokerState } from './coordinator.js';
import { assertFileVaultReady, type FileVaultStatus } from './filevault.js';
import { renderLaunchdPlists } from './launchd.js';
import { applyToRoot } from './lifecycle.js';
import { activateVersion } from './lifecycle.js';

const bundleFileSchema = z.object({
  path: z.string().min(1).max(4_096), mode: z.number().int().min(0).max(0o777),
  uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
  installUid: z.number().int().nonnegative(), installGid: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
const managementRequestSchema = z.object({
  schema: z.literal(1), operation: z.literal('bootstrap'),
  stagedRoot: z.string().startsWith('/'), targetRoot: z.string().startsWith('/'),
  manifest: z.object({
    schema: z.literal(1), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i),
    nodeVersion: z.literal('24.18.1'), files: z.array(bundleFileSchema).min(1).max(100_000),
  }).strict(),
  caller: z.object({
    uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
    username: z.string().regex(/^[a-z_][a-z0-9_-]{0,63}$/i),
  }).strict(),
}).strict();
const maintenanceRequestSchema = z.object({
  schema: z.literal(1), operation: z.enum(['rollback', 'uninstall']),
  targetRoot: z.string().startsWith('/'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i).optional(),
  caller: z.object({
    uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
    username: z.string().regex(/^[a-z_][a-z0-9_-]{0,63}$/i),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.operation === 'rollback' && value.version === undefined) {
    context.addIssue({ code: 'custom', path: ['version'], message: 'Rollback requires a version' });
  }
  if (value.operation === 'uninstall' && value.version !== undefined) {
    context.addIssue({ code: 'custom', path: ['version'], message: 'Uninstall cannot select a version' });
  }
});
const checkoutAccessRequestSchema = z.object({
  schema: z.literal(1), operation: z.literal('checkout-access'),
  targetRoot: z.string().startsWith('/'), sessionId: z.uuid(), principal: z.literal('_inframux'),
  repositoryRoot: z.string().startsWith('/'), gitCommonDir: z.string().startsWith('/'),
  ancestors: z.array(z.string().startsWith('/')).min(1).max(16),
  caller: z.object({
    uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
    username: z.string().regex(/^[a-z_][a-z0-9_-]{0,63}$/i),
  }).strict(),
}).strict();

export interface BootstrapManagementRequest {
  readonly schema: 1;
  readonly operation: 'bootstrap';
  readonly stagedRoot: string;
  readonly targetRoot: string;
  readonly manifest: BundleManifest;
  readonly caller: { readonly uid: number; readonly gid: number; readonly username: string };
}

export interface ServiceAccounts {
  readonly brokerUid: number;
  readonly workerUid: number;
  readonly groupGid: number;
}

export type MaintenanceManagementRequest = z.infer<typeof maintenanceRequestSchema>;
export type CheckoutAccessManagementRequest = z.infer<typeof checkoutAccessRequestSchema>;

export interface ManagementSystem {
  fileVaultStatus(): Promise<FileVaultStatus>;
  ensureServiceAccounts(caller: BootstrapManagementRequest['caller']): Promise<ServiceAccounts>;
  prepareDataRoots(targetRoot: string, accounts: ServiceAccounts, caller: BootstrapManagementRequest['caller']): Promise<void>;
  installUserLaunchers(targetRoot: string): Promise<void>;
  installLaunchDaemons(plists: { readonly broker: string; readonly worker: string }): Promise<void>;
  restartServices(): Promise<void>;
  probeServices(targetRoot: string): Promise<boolean>;
  stopServices(): Promise<void>;
  removeInstallation(targetRoot: string): Promise<void>;
  grantCheckoutAccess(targetRoot: string, ancestors: readonly string[], sessionId: string): Promise<void>;
  revokeOwnedCheckoutAccess(targetRoot: string): Promise<void>;
}

export async function writeManagementRequest(filename: string, requestInput: BootstrapManagementRequest): Promise<void> {
  const request = managementRequestSchema.parse(requestInput);
  if (!path.isAbsolute(filename)) throw new Error('Management request path must be absolute');
  let handle;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(request, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export async function readManagementRequest(filename: string): Promise<BootstrapManagementRequest> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024 * 1024) {
    throw new Error('Management request is not a safe private regular file');
  }
  const request = managementRequestSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
  assertRequestOwner(stat.uid, stat.gid, request.caller);
  for (const file of request.manifest.files) {
    if (file.uid !== request.caller.uid || file.gid !== request.caller.gid) {
      throw new Error(`Staged bundle file is not owned by the authenticated caller: ${file.path}`);
    }
    if (file.installUid !== 0 || file.installGid !== 0) {
      throw new Error(`Hardened bundle files must be installed root-owned: ${file.path}`);
    }
    if ((file.mode & 0o022) !== 0) throw new Error(`Hardened bundle file is group/world writable: ${file.path}`);
  }
  return request;
}

export async function writeMaintenanceRequest(filename: string, requestInput: MaintenanceManagementRequest): Promise<void> {
  const request = maintenanceRequestSchema.parse(requestInput);
  await writePrivateJson(filename, request);
}

export async function readMaintenanceRequest(filename: string): Promise<MaintenanceManagementRequest> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) {
    throw new Error('Maintenance request is not a safe private regular file');
  }
  const request = maintenanceRequestSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
  assertRequestOwner(stat.uid, stat.gid, request.caller);
  return request;
}

export async function writeCheckoutAccessRequest(filename: string, requestInput: CheckoutAccessManagementRequest): Promise<void> {
  await writePrivateJson(filename, checkoutAccessRequestSchema.parse(requestInput));
}

export async function readCheckoutAccessRequest(filename: string): Promise<CheckoutAccessManagementRequest> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) {
    throw new Error('Checkout access request is not a safe private regular file');
  }
  const request = checkoutAccessRequestSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
  assertRequestOwner(stat.uid, stat.gid, request.caller);
  return request;
}

export async function applyHardenedBootstrap(
  request: BootstrapManagementRequest,
  system: ManagementSystem,
): Promise<{ readonly schema: 1; readonly mode: 'hardened'; readonly version: string; readonly executable: string }> {
  validateRequest(request);
  assertFileVaultReady(await system.fileVaultStatus());
  const accounts = await system.ensureServiceAccounts(request.caller);
  let servicesTouched = false;
  try {
    await applyToRoot({
      stagedRoot: request.stagedRoot,
      targetRoot: request.targetRoot,
      manifest: request.manifest,
      probe: async () => {
        await initializeBrokerState(request.targetRoot);
        await system.prepareDataRoots(request.targetRoot, accounts, request.caller);
        await system.installUserLaunchers(request.targetRoot);
        const plists = renderLaunchdPlists({
          installRoot: request.targetRoot,
          nodeExecutable: path.join(request.targetRoot, 'current/bin/node'),
          brokerEntry: path.join(request.targetRoot, 'current/dist/src/bin/broker.js'),
          workerEntry: path.join(request.targetRoot, 'current/dist/src/bin/worker.js'),
          brokerUser: '_inframux',
          workerUser: '_inframuxw',
          group: '_inframux',
          callerUid: request.caller.uid,
          clientUsername: request.caller.username,
          executableManifest: path.join(request.targetRoot, 'current/executable-manifest.json'),
        });
        await system.installLaunchDaemons(plists);
        servicesTouched = true;
        await system.restartServices();
        return system.probeServices(request.targetRoot);
      },
    });
  } catch (error) {
    if (servicesTouched) await system.stopServices().catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    schema: 1,
    mode: 'hardened',
    version: request.manifest.version,
    executable: path.join(request.targetRoot, 'current/bin/inframux'),
  });
}

export async function applyHardenedRollback(
  request: MaintenanceManagementRequest,
  system: ManagementSystem,
): Promise<{ readonly schema: 1; readonly rolledBack: true; readonly from: string; readonly to: string }> {
  if (request.operation !== 'rollback' || request.version === undefined) throw new Error('Rollback management request is invalid');
  validateMaintenanceTarget(request.targetRoot);
  const currentLink = path.join(request.targetRoot, 'current');
  const from = path.basename(await readlink(currentLink));
  if (from === request.version) throw new Error('Requested rollback version is already active');
  await activateVersion(request.targetRoot, request.version);
  try {
    await system.restartServices();
    if (!await system.probeServices(request.targetRoot)) throw new Error('Rolled-back services failed probe');
  } catch (error) {
    await activateVersion(request.targetRoot, from);
    await system.restartServices().catch(() => undefined);
    throw error;
  }
  return Object.freeze({ schema: 1, rolledBack: true, from, to: request.version });
}

export async function applyHardenedUninstall(
  request: MaintenanceManagementRequest,
  system: ManagementSystem,
): Promise<{ readonly schema: 1; readonly uninstalled: true; readonly preserved: readonly string[] }> {
  if (request.operation !== 'uninstall') throw new Error('Uninstall management request is invalid');
  validateMaintenanceTarget(request.targetRoot);
  await system.revokeOwnedCheckoutAccess(request.targetRoot);
  await system.stopServices();
  await system.removeInstallation(request.targetRoot);
  return Object.freeze({
    schema: 1,
    uninstalled: true,
    preserved: Object.freeze([path.join(request.targetRoot, 'state'), '~/.config/inframux/browser-state']),
  });
}

export async function applyCheckoutAccess(
  request: CheckoutAccessManagementRequest,
  system: ManagementSystem,
): Promise<{ readonly schema: 1; readonly prepared: true; readonly principal: '_inframux'; readonly ancestors: readonly string[] }> {
  checkoutAccessRequestSchema.parse(request);
  validateMaintenanceTarget(request.targetRoot);
  if (request.targetRoot !== '/Library/Application Support/inframux') {
    throw new Error('Checkout access requires the standard hardened install root');
  }
  const ancestors: string[] = [];
  for (const candidate of request.ancestors) {
    const ancestor = path.resolve(candidate);
    if (!isStrictAncestor(ancestor, request.repositoryRoot) && !isStrictAncestor(ancestor, request.gitCommonDir)) {
      throw new Error('Checkout ancestor is outside captured repository evidence');
    }
    const stat = await lstat(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(ancestor) !== ancestor) {
      throw new Error('Checkout ancestor must be a canonical directory');
    }
    ancestors.push(ancestor);
  }
  const unique = Object.freeze([...new Set(ancestors)]);
  await system.grantCheckoutAccess(request.targetRoot, unique, request.sessionId);
  return Object.freeze({ schema: 1, prepared: true, principal: '_inframux', ancestors: unique });
}

function validateRequest(request: BootstrapManagementRequest): void {
  managementRequestSchema.parse(request);
  if (request.schema !== 1 || request.operation !== 'bootstrap') throw new Error('Invalid management request');
  for (const [name, value] of [['stagedRoot', request.stagedRoot], ['targetRoot', request.targetRoot]] as const) {
    if (!path.isAbsolute(value) || /\0|[\r\n]/u.test(value) || value === path.parse(value).root) {
      throw new Error(`Unsafe management ${name}`);
    }
  }
  if (!Number.isSafeInteger(request.caller.uid) || request.caller.uid < 0 ||
      !Number.isSafeInteger(request.caller.gid) || request.caller.gid < 0 ||
      !/^[a-z_][a-z0-9_-]{0,63}$/i.test(request.caller.username)) {
    throw new Error('Invalid management caller identity');
  }
  if (request.manifest.schema !== 1 || request.manifest.nodeVersion !== '24.18.1' || request.manifest.files.length === 0) {
    throw new Error('Invalid management bundle manifest');
  }
}

function validateMaintenanceTarget(targetRoot: string): void {
  if (!path.isAbsolute(targetRoot) || /\0|[\r\n]/u.test(targetRoot) || targetRoot === path.parse(targetRoot).root) {
    throw new Error('Maintenance target is unsafe');
  }
}

function isStrictAncestor(ancestor: string, targetInput: string): boolean {
  const target = path.resolve(targetInput);
  const relative = path.relative(ancestor, target);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  if (!path.isAbsolute(filename)) throw new Error('Management request path must be absolute');
  let handle;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function assertRequestOwner(
  uid: number,
  gid: number,
  caller: { readonly uid: number; readonly gid: number },
): void {
  if (uid !== caller.uid || gid !== caller.gid) {
    throw new Error('Management request owner does not match its authenticated caller');
  }
}
