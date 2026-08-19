import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { Redactor } from '../../src/security/redactor.js';
import type { ExecutableManifest } from '../../src/worker/executable-manifest.js';
import { WorkerRunner, type ExecutionLease } from '../../src/worker/runner.js';

const canary = 'worker-canary-secret-never-output';

test('runs a digest-pinned child with literal argv, isolated cwd/env, redaction, and cleanup', async (t) => {
  const fixture = await setupRunner(t);
  const marker = path.join(fixture.root, 'shell-must-not-create-this');
  const result = await fixture.runner.runLease(lease({
    args: ['echo', `$(touch ${marker})`, 'print-secret'],
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes(canary), false);
  assert.match(result.stdout, /\[REDACTED\]/);
  const parsed = JSON.parse(result.stdout) as { args: string[]; cwd: string; environment: string[] };
  assert.equal(parsed.args[0], `$(touch ${marker})`);
  assert.match(parsed.cwd, new RegExp(`^${escapeRegex(await realpath(path.join(fixture.root, 'worker')))}`));
  assert.equal(parsed.environment.includes('VERCEL_TOKEN'), false);
  await assert.rejects(() => readFile(marker), /ENOENT/);
  assert.deepEqual(await readdir(path.join(fixture.root, 'worker/tmp')), []);
});

test('terminates timeouts, cancellation, and oversized output while cleaning after crashes', async (t) => {
  const fixture = await setupRunner(t);
  await assert.rejects(
    () => fixture.runner.runLease(lease({ args: ['sleep', '5000'], timeoutMs: 25 })),
    /timed out/i,
  );
  await assert.rejects(
    () => fixture.runner.runLease(lease({ args: ['overflow', '20000'], maxOutputBytes: 1024 })),
    /output limit/i,
  );
  const controller = new AbortController();
  const cancelled = fixture.runner.runLease(lease({ args: ['sleep', '5000'] }), controller.signal);
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(() => cancelled, /cancel/i);

  const crashed = await fixture.runner.runLease(lease({ args: ['crash'] }));
  assert.equal(crashed.exitCode, 23);
  assert.deepEqual(await readdir(path.join(fixture.root, 'worker/tmp')), []);
});

function lease(overrides: Partial<ExecutionLease> = {}): ExecutionLease {
  return {
    schema: 1,
    leaseId: randomUUID(),
    project: 'sample',
    provider: 'synthetic',
    credentialFingerprint: 'hmac-sha256:test',
    credentialEnvironmentVariable: 'INFRAMUX_SYNTHETIC_TOKEN',
    credentialBase64: Buffer.from(canary).toString('base64'),
    executableId: 'synthetic-cli',
    args: ['identity'],
    publicEnvironment: { INFRAMUX_PROJECT_ID: 'sample', SYNTHETIC_ACCOUNT_ID: 'account-test' },
    timeoutMs: 1_000,
    maxOutputBytes: 8_192,
    configFiles: [],
    ...overrides,
  };
}

async function setupRunner(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolRoot = path.join(root, 'tools');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(toolRoot, { mode: 0o700 });
  const executable = path.join(toolRoot, 'synthetic-provider');
  await copyFile(new URL('../fixtures/fake-provider.mjs', import.meta.url), executable);
  await writeFile(executable, (await readFile(executable, 'utf8')).replace('#!/usr/bin/env node', `#!${process.execPath}`));
  await chmod(executable, 0o755);
  const manifest: ExecutableManifest = {
    schema: 1, runtimeNodeVersion: '24.18.1',
    executables: {
      'synthetic-cli': {
        path: executable, provider: 'synthetic', kind: 'cli', version: '1.0.0',
        sha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
      },
    },
  };
  return {
    root,
    runner: new WorkerRunner({
      workerRoot: path.join(root, 'worker'), toolRoot, manifest,
      allowedOwnerUids: [process.getuid!()], redactor: new Redactor(),
      baseEnvironment: { VERCEL_TOKEN: 'ambient', PATH: '/malicious' },
      terminationGraceMs: 10,
    }),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
