import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseFileVaultStatus } from './filevault.js';
import type { BootstrapManagementRequest, ManagementSystem, ServiceAccounts } from './management.js';

const executeFile = promisify(execFile);
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
      } catch {
        // A first installation has no loaded unit; bootout is intentionally idempotent.
      }
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

  async grantCheckoutAccess(ancestors: readonly string[]): Promise<void> {
    for (const ancestor of ancestors) {
      await this.#execute('/bin/chmod', ['+a', 'group:_inframux allow search', ancestor]);
    }
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
