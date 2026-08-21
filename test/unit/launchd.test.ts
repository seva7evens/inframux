import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseFileVaultStatus } from '../../src/install/filevault.js';
import { renderLaunchdPlists } from '../../src/install/launchd.js';
import { MacOsManagementSystem, selectServiceIds } from '../../src/install/macos-system.js';
import { listenUnixSocket } from '../../src/ipc/server.js';

test('renders explicit least-privilege broker and worker launch daemons without shell or package managers', () => {
  const rendered = renderLaunchdPlists({
    installRoot: '/Library/Application Support/inframux',
    nodeExecutable: '/Library/Application Support/inframux/current/bin/node',
    brokerEntry: '/Library/Application Support/inframux/current/dist/src/bin/broker.js',
    workerEntry: '/Library/Application Support/inframux/current/dist/src/bin/worker.js',
    brokerUser: '_inframux', workerUser: '_inframuxw', group: '_inframux',
    callerUid: 501,
    executableManifest: '/Library/Application Support/inframux/current/executable-manifest.json',
    clientUsername: 'testuser',
  });
  for (const [kind, plist] of Object.entries(rendered)) {
    assert.match(plist, new RegExp(`<string>dev\\.inframux\\.${kind}</string>`));
    assert.match(plist, /<key>UserName<\/key>/);
    assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
    assert.match(plist, /<key>HardResourceLimits<\/key>/);
    assert.match(plist, /<key>EnvironmentVariables<\/key>/);
    assert.match(plist, /INFRAMUX_(?:CLIENT|WORKER)_SOCKET/);
    assert.match(plist, /INFRAMUX_SECURITY_MODE/);
    assert.match(plist, /INFRAMUX_DIAGNOSTIC_ROOT/);
    assert.match(plist, /INFRAMUX_(?:RUNTIME_MANIFEST|EXECUTABLE_MANIFEST)/);
    assert.equal(/npm|npx|\/bin\/(?:ba|z)?sh|Documents\/GitHub/i.test(plist), false);
  }
  assert.match(rendered.broker, /<string>_inframux<\/string>/);
  assert.match(rendered.worker, /<string>_inframuxw<\/string>/);
  assert.match(rendered.broker, /INFRAMUX_FINGERPRINT_KEY/);
  assert.match(rendered.worker, /INFRAMUX_EXECUTABLE_MANIFEST/);
});

test('allocates collision-free hidden service IDs from the reserved local range', () => {
  assert.deepEqual(selectServiceIds([399, 397]), { groupGid: 398, brokerUid: 396, workerUid: 395 });
  assert.throws(() => selectServiceIds(Array.from({ length: 200 }, (_, index) => 200 + index)), /No safe local service IDs/);
});

test('accepts FileVault on or actively encrypting and fails closed otherwise', () => {
  assert.equal(parseFileVaultStatus('FileVault is On.'), 'ready');
  assert.equal(parseFileVaultStatus('Encryption in progress: Percent completed = 37'), 'encrypting');
  assert.equal(parseFileVaultStatus('FileVault is Off.'), 'disabled');
  assert.equal(parseFileVaultStatus('unexpected output'), 'unknown');
});

test('verifies existing macOS service identities through fixed system executables', async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const system = new MacOsManagementSystem({
    execute: async (executable, args) => {
      calls.push({ executable, args: [...args] });
      if (executable === '/usr/bin/fdesetup') return { stdout: 'FileVault is On.\n', stderr: '' };
      if (executable === '/usr/bin/id') return { stdout: '501\n', stderr: '' };
      if (executable === '/usr/bin/dscl' && args[1] === '-list' && args[2] === '/Users') {
        return { stdout: '_inframux 398\n_inframuxw 397\ntestuser 501\n', stderr: '' };
      }
      if (executable === '/usr/bin/dscl' && args[1] === '-list' && args[2] === '/Groups') {
        return { stdout: '_inframux 399\nstaff 20\n', stderr: '' };
      }
      if (executable === '/usr/bin/dscl' && args[1] === '-read') {
        if (args[2] === '/Groups/_inframux') return { stdout: 'PrimaryGroupID: 399\n', stderr: '' };
        const uid = args[2] === '/Users/_inframux' ? 398 : 397;
        return {
          stdout: `UniqueID: ${uid}\nPrimaryGroupID: 399\nUserShell: /usr/bin/false\nNFSHomeDirectory: /var/empty\n`,
          stderr: '',
        };
      }
      if (executable === '/usr/sbin/dseditgroup') return { stdout: '', stderr: '' };
      throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
    },
  });

  assert.equal(await system.fileVaultStatus(), 'ready');
  assert.deepEqual(await system.ensureServiceAccounts({ uid: 501, gid: 20, username: 'testuser' }), {
    brokerUid: 398, workerUid: 397, groupGid: 399,
  });
  assert.ok(calls.every(({ executable }) => executable.startsWith('/usr/')));
  assert.deepEqual(calls.at(-1), {
    executable: '/usr/sbin/dseditgroup',
    args: ['-o', 'edit', '-a', 'testuser', '-t', 'user', '_inframux'],
  });
});

test('waits for launchd jobs to disappear before bootstrapping replacements', async () => {
  const calls: string[] = [];
  const visibleAfterBootout = new Map([
    ['system/dev.inframux.worker', 1],
    ['system/dev.inframux.broker', 1],
  ]);
  const system = new MacOsManagementSystem({ execute: async (executable, args) => {
    const call = `${executable} ${args.join(' ')}`;
    calls.push(call);
    if (executable === '/bin/launchctl' && args[0] === 'print') {
      const target = args[1]!;
      const remaining = visibleAfterBootout.get(target) ?? 0;
      if (remaining > 0) {
        visibleAfterBootout.set(target, remaining - 1);
        return { stdout: `service = ${target}\n`, stderr: '' };
      }
      const error = Object.assign(new Error(`Could not find service ${target}`), {
        code: 113,
        stdout: '',
        stderr: `Could not find service ${target}`,
      });
      throw error;
    }
    return { stdout: '', stderr: '' };
  } });

  await system.restartServices('/tmp/inframux-launchd-test');

  for (const target of ['system/dev.inframux.worker', 'system/dev.inframux.broker']) {
    const lastPrint = calls.lastIndexOf(`/bin/launchctl print ${target}`);
    const firstBootstrap = calls.findIndex((call) => call.startsWith('/bin/launchctl bootstrap system '));
    assert.ok(lastPrint >= 0, `launchd removal was not observed for ${target}`);
    assert.ok(lastPrint < firstBootstrap, `replacement bootstrap raced ${target} removal`);
  }
});

test('treats launchctl bootout code 3 as an already-absent service', async () => {
  const calls: string[] = [];
  const system = new MacOsManagementSystem({ execute: async (executable, args) => {
    const call = `${executable} ${args.join(' ')}`;
    calls.push(call);
    if (executable === '/bin/launchctl' && args[0] === 'bootout') {
      throw Object.assign(new Error('Boot-out failed: 3: No such process'), {
        code: 3,
        stdout: '',
        stderr: 'Boot-out failed: 3: No such process\n',
      });
    }
    return { stdout: '', stderr: '' };
  } });

  await system.restartServices('/tmp/inframux-launchd-test');

  assert.equal(calls.filter((call) => call.startsWith('/bin/launchctl bootstrap system ')).length, 2);
  assert.equal(calls.some((call) => call.startsWith('/bin/launchctl print ')), false);
});

test('fails closed on an unexpected launchctl bootout error', async () => {
  const calls: string[] = [];
  const system = new MacOsManagementSystem({ execute: async (executable, args) => {
    calls.push(`${executable} ${args.join(' ')}`);
    throw Object.assign(new Error('Boot-out failed: 5: Input/output error'), {
      code: 5,
      stdout: '',
      stderr: 'Boot-out failed: 5: Input/output error\n',
    });
  } });

  await assert.rejects(system.restartServices('/tmp/inframux-launchd-test'), /Input\/output error/);
  assert.equal(calls.some((call) => call.startsWith('/bin/launchctl bootstrap ')), false);
});

test('fails closed when launchctl cannot confirm service removal', async () => {
  const calls: string[] = [];
  const system = new MacOsManagementSystem({ execute: async (executable, args) => {
    calls.push(`${executable} ${args.join(' ')}`);
    if (executable === '/bin/launchctl' && args[0] === 'print') {
      throw Object.assign(new Error('Operation not permitted'), {
        code: 1,
        stdout: '',
        stderr: 'Operation not permitted\n',
      });
    }
    return { stdout: '', stderr: '' };
  } });

  await assert.rejects(system.restartServices('/tmp/inframux-launchd-test'), /Operation not permitted/);
  assert.equal(calls.some((call) => call.startsWith('/bin/launchctl bootstrap ')), false);
});

test('removes only stopped stale Unix sockets before bootstrapping replacement daemons', async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-stale-sockets-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const runRoot = path.join(targetRoot, 'run');
  await mkdir(runRoot);
  for (const name of ['client.sock', 'worker.sock']) await createStaleSocket(path.join(runRoot, name));
  const system = new MacOsManagementSystem({ execute: launchdAlreadyStopped });

  await system.restartServices(targetRoot);

  await assert.rejects(lstat(path.join(runRoot, 'client.sock')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(runRoot, 'worker.sock')), { code: 'ENOENT' });
});

test('fails closed instead of deleting a non-socket collision in the run directory', async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-unsafe-socket-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  await mkdir(path.join(targetRoot, 'run'));
  await writeFile(path.join(targetRoot, 'run/client.sock'), 'user-data');
  const calls: string[] = [];
  const system = new MacOsManagementSystem({ execute: async (executable, args) => {
    calls.push(`${executable} ${args.join(' ')}`);
    return launchdAlreadyStopped(executable, args);
  } });

  await assert.rejects(system.restartServices(targetRoot), /Refusing to remove non-socket/);
  assert.equal(calls.some((call) => call.includes('launchctl bootstrap')), false);
});

test('validates both socket paths before removing either one', async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-atomic-socket-check-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const runRoot = path.join(targetRoot, 'run');
  await mkdir(runRoot);
  const clientSocket = path.join(runRoot, 'client.sock');
  await createStaleSocket(clientSocket);
  await writeFile(path.join(runRoot, 'worker.sock'), 'foreign-data');
  const system = new MacOsManagementSystem({ execute: launchdAlreadyStopped });

  await assert.rejects(system.restartServices(targetRoot), /Refusing to remove non-socket/);
  assert.equal((await lstat(clientSocket)).isSocket(), true);
});

test('refuses to unlink a Unix socket that still accepts connections', async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-live-socket-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const socketPath = path.join(targetRoot, 'run/client.sock');
  const server = await listenUnixSocket({ socketPath, handlers: {} });
  t.after(() => server.close());
  const calls: string[] = [];
  const system = new MacOsManagementSystem({ execute: async (executable, args) => {
    calls.push(`${executable} ${args.join(' ')}`);
    return launchdAlreadyStopped(executable, args);
  } });

  await assert.rejects(system.restartServices(targetRoot), /still accepts connections/);
  assert.equal((await lstat(socketPath)).isSocket(), true);
  assert.equal(calls.some((call) => call.includes('launchctl bootstrap')), false);
});

test('does not accept stale socket inodes or a broker without an attached worker as healthy', async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-real-health-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  await mkdir(path.join(targetRoot, 'runtime/versions/0.1.4'), { recursive: true });
  await symlink('runtime/versions/0.1.4', path.join(targetRoot, 'current'));
  const runRoot = path.join(targetRoot, 'run');
  await mkdir(runRoot);
  let workerReady = true;
  let releaseVersion = '0.1.4';
  let launchdOutput = 'state = spawn scheduled\n';
  const clientServer = await listenUnixSocket({
    socketPath: path.join(runRoot, 'client.sock'),
    handlers: {
      'system.health': async () => ({
        schema: 1, releaseVersion, brokerReady: true, workerReady,
      }),
    },
  });
  const workerServer = await listenUnixSocket({ socketPath: path.join(runRoot, 'worker.sock'), handlers: {} });
  t.after(() => Promise.all([clientServer.close(), workerServer.close()]));
  const system = new MacOsManagementSystem({
    execute: async () => ({ stdout: launchdOutput, stderr: '' }),
    serviceProbeTimeoutMs: 25,
    serviceProbePollMs: 1,
  });

  assert.equal(await system.probeServices(targetRoot), false);
  launchdOutput = 'state = running\npid = 123\n';
  workerReady = false;
  assert.equal(await system.probeServices(targetRoot), false);
  workerReady = true;
  releaseVersion = '0.1.3';
  assert.equal(await system.probeServices(targetRoot), false);
  releaseVersion = '0.1.4';
  assert.equal(await system.probeServices(targetRoot), true);
});

test('accepts legacy protocol readiness only for an explicit rollback probe', async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-legacy-health-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  await mkdir(path.join(targetRoot, 'runtime/versions/0.1.0'), { recursive: true });
  await symlink('runtime/versions/0.1.0', path.join(targetRoot, 'current'));
  const runRoot = path.join(targetRoot, 'run');
  const clientServer = await listenUnixSocket({ socketPath: path.join(runRoot, 'client.sock'), handlers: {} });
  const workerServer = await listenUnixSocket({ socketPath: path.join(runRoot, 'worker.sock'), handlers: {} });
  t.after(() => Promise.all([clientServer.close(), workerServer.close()]));
  const system = new MacOsManagementSystem({
    execute: async () => ({ stdout: 'state = running\npid = 123\n', stderr: '' }),
    serviceProbeTimeoutMs: 25,
    serviceProbePollMs: 1,
  });

  assert.equal(await system.probeServices(targetRoot), false);
  assert.equal(await system.probeServices(targetRoot, { allowLegacyHealth: true }), true);
});

async function launchdAlreadyStopped(executable: string, args: readonly string[]) {
  if (executable === '/bin/launchctl' && args[0] === 'bootout') {
    throw Object.assign(new Error('Boot-out failed: 3: No such process'), {
      code: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process\n',
    });
  }
  return { stdout: '', stderr: '' };
}

async function createStaleSocket(socketPath: string): Promise<void> {
  const source = [
    "const net = require('node:net');",
    `net.createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write('ready\\n'));`,
  ].join('');
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', () => resolve());
  });
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  assert.equal((await lstat(socketPath)).isSocket(), true);
}

test('records only an ACL it owns, retries idempotently, and removes it on cleanup', async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-acl-receipt-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const ancestorInput = path.join(targetRoot, 'private-home', 'Documents');
  await mkdir(ancestorInput, { recursive: true });
  const ancestor = await realpath(ancestorInput);
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  let aclPresent = false;
  const system = new MacOsManagementSystem({ execute: async (executable, args) => {
    calls.push({ executable, args: [...args] });
    if (executable === '/bin/ls') return { stdout: aclPresent ? ' 0: group:_inframux allow search\n' : '', stderr: '' };
    if (executable === '/bin/chmod' && args[0] === '+a') aclPresent = true;
    if (executable === '/bin/chmod' && args[0] === '-a') aclPresent = false;
    return { stdout: '', stderr: '' };
  } });
  await system.grantCheckoutAccess(targetRoot, [ancestor], '018f47d2-8737-7a19-8000-123456789abc');
  await system.grantCheckoutAccess(targetRoot, [ancestor], '018f47d2-8737-7a19-8000-123456789abc');
  assert.equal(calls.filter(({ executable, args }) => executable === '/bin/chmod' && args[0] === '+a').length, 1);
  await system.revokeOwnedCheckoutAccess(targetRoot);
  await system.revokeOwnedCheckoutAccess(targetRoot);
  assert.deepEqual(calls.filter(({ executable }) => executable === '/bin/chmod'), [
    { executable: '/bin/chmod', args: ['+a', 'group:_inframux allow search', ancestor] },
    { executable: '/bin/chmod', args: ['-a', 'group:_inframux allow search', ancestor] },
  ]);
});

test('does not claim or remove a matching ACL that already existed', async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-foreign-acl-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const ancestorInput = path.join(targetRoot, 'private-home');
  await mkdir(ancestorInput);
  const ancestor = await realpath(ancestorInput);
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const system = new MacOsManagementSystem({ execute: async (executable, args) => {
    calls.push({ executable, args: [...args] });
    if (executable === '/bin/ls') return { stdout: ' 0: group:_inframux allow search\n', stderr: '' };
    return { stdout: '', stderr: '' };
  } });
  await system.grantCheckoutAccess(targetRoot, [ancestor], '018f47d2-8737-7a19-8000-123456789abc');
  await system.revokeOwnedCheckoutAccess(targetRoot);
  assert.equal(calls.some(({ executable }) => executable === '/bin/chmod'), false);
});
