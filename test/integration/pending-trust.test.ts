import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { collectCheckoutEvidence } from '../../src/git/evidence.js';
import { PendingTrustStore } from '../../src/trust/pending.js';

const run = promisify(execFile);

test('creates one private expiring repository-bound trust request and consumes it once', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-pending-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  await createRepository(repository);
  const evidence = await collectCheckoutEvidence(repository);
  const store = new PendingTrustStore({ stateRoot: path.join(root, 'state'), now: () => Date.parse('2026-08-18T01:00:00.000Z') });
  const pending = await store.create({
    project: 'sample', evidence,
    canonicalRemote: 'github.com/example-org/sample_app',
    workspaceRoot: root,
  });
  assert.match(pending.id, /^[0-9a-f-]{36}$/);
  assert.equal(pending.repositoryRoot, evidence.repositoryRoot);
  assert.equal(pending.expiresAt, '2026-08-18T01:15:00.000Z');
  assert.deepEqual(await store.get(pending.id), pending);
  assert.deepEqual(await store.consume(pending.id), pending);
  await assert.rejects(store.get(pending.id), /not found|expired/i);
});

test('rejects expired, moved and path-escaping pending requests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-pending-expiry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  await createRepository(repository);
  const evidence = await collectCheckoutEvidence(repository);
  let now = Date.parse('2026-08-18T01:00:00.000Z');
  const store = new PendingTrustStore({ stateRoot: path.join(root, 'state'), now: () => now, ttlMs: 1_000 });
  const pending = await store.create({
    project: 'sample', evidence,
    canonicalRemote: 'github.com/example-org/sample_app', workspaceRoot: root,
  });
  now += 1_001;
  await assert.rejects(store.consume(pending.id), /expired/i);
  await mkdir(path.join(root, 'other'));
  await assert.rejects(
    store.create({
      project: 'sample', evidence,
      canonicalRemote: 'github.com/example-org/sample_app', workspaceRoot: path.join(root, 'other'),
    }),
    /workspace/i,
  );
});

async function createRepository(repository: string): Promise<void> {
  await mkdir(repository);
  await run('git', ['init', '-b', 'main'], { cwd: repository });
  await run('git', ['config', 'user.email', 'inframux@example.invalid'], { cwd: repository });
  await run('git', ['config', 'user.name', 'inframux test'], { cwd: repository });
  await writeFile(path.join(repository, '.inframux.toml'), 'schema = 1\nproject = "sample"\nregistry = "sample"\n');
  await run('git', ['add', '.inframux.toml'], { cwd: repository });
  await run('git', ['commit', '-m', 'fixture'], { cwd: repository });
  await run('git', ['remote', 'add', 'origin', 'git@github.com:EXAMPLE-ORG/sample_app.git'], { cwd: repository });
}
