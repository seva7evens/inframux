import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyExecutable, type ExecutableManifest } from '../../src/worker/executable-manifest.js';
import { buildLeaseEnvironment } from '../../src/worker/environment.js';

test('verifies absolute regular executable ownership, modes, root containment, and digest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'synthetic-provider');
  await copyFile(new URL('../fixtures/fake-provider.mjs', import.meta.url), executable);
  await writeFile(executable, (await readFile(executable, 'utf8')).replace('#!/usr/bin/env node', `#!${process.execPath}`));
  await chmod(executable, 0o755);
  const digest = createHash('sha256').update(await readFile(executable)).digest('hex');
  const manifest: ExecutableManifest = {
    schema: 1,
    runtimeNodeVersion: '24.18.1',
    executables: {
      'synthetic-cli': {
        path: executable, provider: 'synthetic', kind: 'cli', version: '1.0.0',
        sha256: digest,
      },
    },
  };

  assert.equal((await verifyExecutable(manifest, 'synthetic-cli', {
    toolRoot: root, allowedOwnerUids: [process.getuid!()],
  })).path, await realpath(executable));

  await writeFile(executable, '\nmutation', { flag: 'a' });
  await assert.rejects(
    () => verifyExecutable(manifest, 'synthetic-cli', { toolRoot: root, allowedOwnerUids: [process.getuid!()] }),
    /digest/i,
  );
  await chmod(executable, 0o777);
  const mutatedDigest = createHash('sha256').update(await readFile(executable)).digest('hex');
  await assert.rejects(
    () => verifyExecutable({ ...manifest, executables: { 'synthetic-cli': { ...manifest.executables['synthetic-cli']!, sha256: mutatedDigest } } }, 'synthetic-cli', { toolRoot: root, allowedOwnerUids: [process.getuid!()] }),
    /writable|mode/i,
  );

  const link = path.join(root, 'linked-provider');
  await symlink(executable, link);
  const linkedManifest: ExecutableManifest = { ...manifest, executables: { 'synthetic-cli': { ...manifest.executables['synthetic-cli']!, path: link } } };
  await assert.rejects(
    () => verifyExecutable(linkedManifest, 'synthetic-cli', { toolRoot: root, allowedOwnerUids: [process.getuid!()] }),
    /symbolic link/i,
  );
});

test('builds a minimal environment containing exactly one leased credential', () => {
  const environment = buildLeaseEnvironment({
    baseEnvironment: {
      VERCEL_TOKEN: 'ambient-vercel',
      SUPABASE_ACCESS_TOKEN: 'ambient-supabase',
      AWS_SECRET_ACCESS_KEY: 'ambient-aws',
      PATH: '/malicious/repository/bin',
    },
    home: '/worker/home/lease',
    temp: '/worker/tmp/lease',
    credentialEnvironmentVariable: 'INFRAMUX_SYNTHETIC_TOKEN',
    credential: 'leased-synthetic-token',
    publicEnvironment: { INFRAMUX_PROJECT_ID: 'sample', SYNTHETIC_ACCOUNT_ID: 'account-test' },
  });
  assert.deepEqual(environment, {
    HOME: '/worker/home/lease',
    TMPDIR: '/worker/tmp/lease',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    INFRAMUX_PROJECT_ID: 'sample',
    SYNTHETIC_ACCOUNT_ID: 'account-test',
    INFRAMUX_SYNTHETIC_TOKEN: 'leased-synthetic-token',
  });
});
