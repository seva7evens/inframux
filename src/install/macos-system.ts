import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseFileVaultStatus } from './filevault.js';
import type { BootstrapManagementRequest, ManagementSystem, ServiceAccounts } from './management.js';

const executeFile = promisify(execFile);
const LAUNCHD_REMOVAL_TIMEOUT_MS = 5_000;
const LAUNCHD_REMOVAL_POLL_MS = 25;
type CommandResult = { stdout: string; stderr: string };
type CommandExecutor = (executable: string, args: readonly string[]) => Promise<CommandResult>;

export class MacOsManagementSystem implements ManagementSystem {
  readonly #execute: CommandExecutor;
  readonly #launchDaemonRoot: string;
  readonly #launcherRoot: string;

  constructor(options: { execute?: CommandExecutor; launchDaemonRoot?: string; launcherRoot?: string } = {}) {
    this.#execute = options.execute ?? executeCommand;
    this.#launchDaemonRoot = options.launchDaemonRoot ?? '/Library/LaunchDaemons';
    this.#launcherRoot = options.launcherRoot ?? '/usr/local/bin';
  }

  async fileVaultStatus() {
    const result = await this.#execute('/usr/bin/fdesetup', ['status']);
    return parseFileVaultStatus(result.stdout);
  }

  async ensureServiceAccounts(caller: BootstrapManagementRequest['caller']): Promise<ServiceAccounts> {
    const actualCaller = Number.parseInt((await this.#execute('/usr/bin/id', ['-u', caller.username])).stdout.trim(), 10);
    if (actualCaller !== caller.uid) throw new Error('Bootstrap caller UID does not match the local directory identity');
    const userIds = parseDirectoryIds((await this.#execute('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID'])).stdout);
    const groupIds = parseDirectoryIds((await this.#execute('/usr/bin/dscl', ['.', '-list', '/Groups', 'PrimaryGroupID'])).stdout);
    const selected = selectServiceIds([...userIds.values(), ...groupIds.values()]);
    const groupGid = groupIds.get('_inframux') ?? selected.groupGid;
    if (!groupIds.has('_inframux')) await this.#createGroup('_inframux', groupGid);
    const brokerUid = userIds.get('_inframux') ?? selected.brokerUid;
    const workerUid = userIds.get('_inframuxw') ?? selected.workerUid;
    if (!userIds.has('_inframux')) await this.#createUser('_inframux', brokerUid, groupGid);
    if (!userIds.has('_inframuxw')) await this.#createUser('_inframuxw', workerUid, groupGid);
    await this.#verifyUser('_inframux', brokerUid, groupGid);
    await this.#verifyUser('_inframuxw', workerUid, groupGid);
    await this.#verifyGroup('_inframux', groupGid);
    await this.#execute('/usr/sbin/dseditgroup', ['-o', 'edit', '-a', caller.username, '-t', 'user', '_inframux']);
    return Object.freeze({ brokerUid, workerUid, groupGid });
  }

  async prepareDataRoots(
    targetRoot: string,
    accounts: ServiceAccounts,
    caller: BootstrapManagementRequest['caller'],
  ): Promise<void> {
    const state = path.join(targetRoot, 'state');
    const run = path.join(targetRoot, 'run');
    const worker = path.join(targetRoot, 'worker');
    const brokerLogs = path.join(targetRoot, 'logs/broker');
    const workerLogs = path.join(targetRoot, 'logs/worker');
    for (const directory of [state, run, worker, brokerLogs, workerLogs]) await mkdir(directory, { recursive: true });
    await this.#ownershipTree(state, accounts.brokerUid, accounts.groupGid, 0o700);
    await this.#ownershipTree(worker, accounts.workerUid, accounts.groupGid, 0o700);
    await this.#ownershipTree(brokerLogs, accounts.brokerUid, accounts.groupGid, 0o700);
    await this.#ownershipTree(workerLogs, accounts.workerUid, accounts.groupGid, 0o700);
    await chown(run, accounts.brokerUid, accounts.groupGid);
    await chmod(run, 0o770);
    await this.#execute('/bin/chmod', ['+a', `${caller.username} allow list,search,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit`, run]);
  }

  async installLaunchDaemons(plists: { broker: string; worker: string }): Promise<void> {
    await mkdir(this.#launchDaemonRoot, { recursive: true, mode: 0o755 });
    await writeRootFile(path.join(this.#launchDaemonRoot, 'dev.inframux.broker.plist'), plists.broker);
    await writeRootFile(path.join(this.#launchDaemonRoot, 'dev.inframux.worker.plist'), plists.worker);
  }

  async installUserLaunchers(targetRoot: string): Promise<void> {
    await mkdir(this.#launcherRoot, { recursive: true, mode: 0o755 });
    for (const name of ['inframux', 'agent-playwright']) {
      const source = path.join(targetRoot, 'current/bin', name);
      try {
        await writeRootFile(path.join(this.#launcherRoot, name), await readFile(source, 'utf8'), 0o755);
      } catch (error) {
        if (name === 'agent-playwright' && error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  async restartServices(): Promise<void> {
    await this.stopServices();
    await this.#execute('/bin/launchctl', ['bootstrap', 'system', path.join(this.#launchDaemonRoot, 'dev.inframux.broker.plist')]);
    await this.#execute('/bin/launchctl', ['bootstrap', 'system', path.join(this.#launchDaemonRoot, 'dev.inframux.worker.plist')]);
    await this.#execute('/bin/launchctl', ['kickstart', '-k', 'system/dev.inframux.broker']);
    await this.#execute('/bin/launchctl', ['kickstart', '-k', 'system/dev.inframux.worker']);
  }

  async probeServices(targetRoot: string): Promise<boolean> {
    const deadline = Date.now() + 20_000;
    const sockets = [path.join(targetRoot, 'run/client.sock'), path.join(targetRoot, 'run/worker.sock')];
    while (Date.now() < deadline) {
      if ((await Promise.all(sockets.map(isSocket))).every(Boolean)) {
        await this.#execute('/bin/launchctl', ['print', 'system/dev.inframux.broker']);
        await this.#execute('/bin/launchctl', ['print', 'system/dev.inframux.worker']);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  async stopServices(): Promise<void> {
    for (const target of ['system/dev.inframux.worker', 'system/dev.inframux.broker']) {
      try {
        await this.#execute('/bin/launchctl', ['bootout', target]);
      } catch (error) {
        if (isLaunchdServiceMissing(error, 'bootout')) continue;
        throw error;
      }
      await this.#waitForServiceRemoval(target);
    }
  }

  async #waitForServiceRemoval(target: string): Promise<void> {
    const deadline = Date.now() + LAUNCHD_REMOVAL_TIMEOUT_MS;
    while (true) {
      try {
        await this.#execute('/bin/launchctl', ['print', target]);
      } catch (error) {
        if (isLaunchdServiceMissing(error, 'print')) return;
        throw error;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for launchd service removal: ${target}`);
      await new Promise((resolve) => setTimeout(resolve, LAUNCHD_REMOVAL_POLL_MS));
    }
  }

  async removeInstallation(targetRoot: string): Promise<void> {
    for (const name of ['inframux', 'agent-playwright']) {
      await removeExpectedFile(path.join(this.#launcherRoot, name), targetRoot);
    }
    for (const name of ['dev.inframux.broker.plist', 'dev.inframux.worker.plist']) {
      await removeExpectedFile(path.join(this.#launchDaemonRoot, name), 'dev.inframux');
    }
    for (const relative of ['current', 'runtime', 'run', 'worker', 'logs']) {
      await rm(path.join(targetRoot, relative), { recursive: true, force: true });
    }
  }

  async grantCheckoutAccess(targetRoot: string, ancestors: readonly string[], sessionId: string): Promise<void> {
    const receiptRoot = await ensureAclReceiptRoot(targetRoot);
    for (const ancestor of ancestors) {
      const stat = await canonicalDirectoryStat(ancestor);
      const receiptFile = path.join(receiptRoot, `${createHash('sha256').update(ancestor).digest('hex')}.json`);
      const existing = await readAclReceipt(receiptFile);
      if (existing !== undefined) {
        if (existing.ancestor !== ancestor || existing.dev !== String(stat.dev) || existing.ino !== String(stat.ino)) {
          throw new Error(`Checkout ACL receipt does not match the current directory: ${ancestor}`);
        }
        continue;
      }
      const listing = await this.#execute('/bin/ls', ['-lde', ancestor]);
      if (/^\s*\d+:\s+group:_inframux allow search\s*$/mu.test(listing.stdout)) continue;
      await this.#execute('/bin/chmod', ['+a', 'group:_inframux allow search', ancestor]);
      try {
        await writeAclReceipt(receiptFile, {
          schema: 1, principal: '_inframux', sessionId, ancestor,
          dev: String(stat.dev), ino: String(stat.ino),
        });
      } catch (error) {
        await this.#execute('/bin/chmod', ['-a', 'group:_inframux allow search', ancestor]).catch(() => undefined);
        throw error;
      }
    }
  }

  async revokeOwnedCheckoutAccess(targetRoot: string): Promise<void> {
    const receiptRoot = path.join(targetRoot, 'acl-receipts');
    let entries;
    try {
      const rootStat = await lstat(receiptRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Checkout ACL receipt root is unsafe');
      entries = await readdir(receiptRoot, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
        throw new Error(`Unsafe checkout ACL receipt entry: ${entry.name}`);
      }
      const receiptFile = path.join(receiptRoot, entry.name);
      const receipt = await readAclReceipt(receiptFile);
      if (receipt === undefined || `${createHash('sha256').update(receipt.ancestor).digest('hex')}.json` !== entry.name) {
        throw new Error(`Invalid checkout ACL receipt: ${entry.name}`);
      }
      try {
        const stat = await canonicalDirectoryStat(receipt.ancestor);
        if (String(stat.dev) === receipt.dev && String(stat.ino) === receipt.ino) {
          await this.#execute('/bin/chmod', ['-a', 'group:_inframux allow search', receipt.ancestor]);
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await rm(receiptFile);
    }
    await rmdir(receiptRoot);
  }

  async #createGroup(name: string, gid: number): Promise<void> {
    await this.#execute('/usr/bin/dscl', ['.', '-create', `/Groups/${name}`]);
    await this.#execute('/usr/bin/dscl', ['.', '-create', `/Groups/${name}`, 'PrimaryGroupID', String(gid)]);
    await this.#execute('/usr/bin/dscl', ['.', '-create', `/Groups/${name}`, 'Password', '*']);
  }

  async #createUser(name: string, uid: number, gid: number): Promise<void> {
    const record = `/Users/${name}`;
    await this.#execute('/usr/bin/dscl', ['.', '-create', record]);
    for (const [key, value] of [
      ['UniqueID', String(uid)], ['PrimaryGroupID', String(gid)], ['UserShell', '/usr/bin/false'],
      ['NFSHomeDirectory', '/var/empty'], ['IsHidden', '1'], ['Password', '*'],
    ] as const) await this.#execute('/usr/bin/dscl', ['.', '-create', record, key, value]);
  }

  async #verifyUser(name: string, uid: number, gid: number): Promise<void> {
    const output = (await this.#execute('/usr/bin/dscl', ['.', '-read', `/Users/${name}`, 'UniqueID', 'PrimaryGroupID', 'UserShell', 'NFSHomeDirectory'])).stdout;
    for (const expected of [`UniqueID: ${uid}`, `PrimaryGroupID: ${gid}`, 'UserShell: /usr/bin/false', 'NFSHomeDirectory: /var/empty']) {
      if (!output.includes(expected)) throw new Error(`Existing service account ${name} has unsafe attributes`);
    }
  }

  async #verifyGroup(name: string, gid: number): Promise<void> {
    const output = (await this.#execute('/usr/bin/dscl', ['.', '-read', `/Groups/${name}`, 'PrimaryGroupID'])).stdout;
    if (!output.includes(`PrimaryGroupID: ${gid}`)) throw new Error(`Existing service group ${name} has unsafe attributes`);
  }

  async #ownershipTree(target: string, uid: number, gid: number, mode: number): Promise<void> {
    await this.#execute('/usr/sbin/chown', ['-R', `${uid}:${gid}`, target]);
    await this.#execute('/bin/chmod', ['-R', 'go-rwx', target]);
    await chmod(target, mode);
  }
}

export function selectServiceIds(usedInput: readonly number[]): ServiceAccounts {
  const used = new Set(usedInput);
  const available: number[] = [];
  for (let candidate = 399; candidate >= 200 && available.length < 3; candidate -= 1) {
    if (!used.has(candidate)) available.push(candidate);
  }
  if (available.length < 3) throw new Error('No safe local service IDs are available in 200..399');
  return { groupGid: available[0]!, brokerUid: available[1]!, workerUid: available[2]! };
}

interface CheckoutAclReceipt {
  readonly schema: 1;
  readonly principal: '_inframux';
  readonly sessionId: string;
  readonly ancestor: string;
  readonly dev: string;
  readonly ino: string;
}

async function ensureAclReceiptRoot(targetRoot: string): Promise<string> {
  if (!path.isAbsolute(targetRoot) || targetRoot === path.parse(targetRoot).root) throw new Error('ACL receipt target is unsafe');
  const receiptRoot = path.join(targetRoot, 'acl-receipts');
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  const stat = await lstat(receiptRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Checkout ACL receipt root is unsafe');
  await chmod(receiptRoot, 0o700);
  return receiptRoot;
}

async function canonicalDirectoryStat(directory: string) {
  if (!path.isAbsolute(directory) || directory === path.parse(directory).root || await realpath(directory) !== directory) {
    throw new Error('Checkout ACL target must be a canonical absolute directory');
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Checkout ACL target must be a canonical directory');
  return stat;
}

async function readAclReceipt(filename: string): Promise<CheckoutAclReceipt | undefined> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16_384) {
      throw new Error('Checkout ACL receipt is not a safe private regular file');
    }
    const value = JSON.parse(await readFile(filename, 'utf8')) as Partial<CheckoutAclReceipt>;
    if (value.schema !== 1 || value.principal !== '_inframux' || typeof value.sessionId !== 'string' ||
        !/^[0-9a-f-]{36}$/u.test(value.sessionId) || typeof value.ancestor !== 'string' ||
        !path.isAbsolute(value.ancestor) || !/^\d+$/u.test(value.dev ?? '') || !/^\d+$/u.test(value.ino ?? '') ||
        Object.keys(value).sort().join(',') !== 'ancestor,dev,ino,principal,schema,sessionId') {
      throw new Error('Checkout ACL receipt schema is invalid');
    }
    return Object.freeze(value as CheckoutAclReceipt);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAclReceipt(filename: string, receipt: CheckoutAclReceipt): Promise<void> {
  let handle;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function parseDirectoryIds(output: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of output.split('\n')) {
    const match = /^([^\s]+)\s+(\d+)\s*$/u.exec(line);
    if (match === null) continue;
    const value = Number.parseInt(match[2]!, 10);
    if (Number.isSafeInteger(value) && value >= 0) result.set(match[1]!, value);
  }
  return result;
}

async function writeRootFile(filename: string, source: string, mode = 0o644): Promise<void> {
  try {
    const existing = await lstat(filename);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error(`Unsafe launch daemon path: ${filename}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const temporary = `${filename}.inframux-new`;
  let handle;
  try {
    await rm(temporary, { force: true });
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    await chown(temporary, 0, 0);
    await rename(temporary, filename);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function removeExpectedFile(filename: string, marker: string): Promise<void> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Refusing to remove unsafe managed file: ${filename}`);
    if (!(await readFile(filename, 'utf8')).includes(marker)) throw new Error(`Refusing to remove foreign managed file: ${filename}`);
    await rm(filename);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function isSocket(filename: string): Promise<boolean> {
  try {
    return (await lstat(filename)).isSocket();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function executeCommand(executable: string, args: readonly string[]): Promise<CommandResult> {
  const result = await executeFile(executable, [...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function isLaunchdServiceMissing(error: unknown, operation: 'bootout' | 'print'): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as Error & { code?: unknown; stderr?: unknown };
  if (typeof details.stderr !== 'string') return false;
  return operation === 'bootout'
    ? details.code === 3 && /Boot-out failed:\s*3:\s*No such process/u.test(details.stderr)
    : details.code === 113 && /Could not find service/u.test(details.stderr);
}
