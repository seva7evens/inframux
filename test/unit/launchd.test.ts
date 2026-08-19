import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFileVaultStatus } from '../../src/install/filevault.js';
import { renderLaunchdPlists } from '../../src/install/launchd.js';
import { MacOsManagementSystem, selectServiceIds } from '../../src/install/macos-system.js';

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

test('grants only search ACL to the fixed hardened broker group', async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const system = new MacOsManagementSystem({ execute: async (executable, args) => {
    calls.push({ executable, args: [...args] });
    return { stdout: '', stderr: '' };
  } });
  await system.grantCheckoutAccess(['/private-home/Documents']);
  assert.deepEqual(calls, [{
    executable: '/bin/chmod',
    args: ['+a', 'group:_inframux allow search', '/private-home/Documents'],
  }]);
});
