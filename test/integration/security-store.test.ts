import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CredentialStore } from '../../src/security/credential-store.js';
import { Redactor } from '../../src/security/redactor.js';

const canary = 'synthetic-credential-never-return-this';

test('stores only private credential bytes and exposes metadata through bounded callbacks', async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'inframux-vault-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const redactor = new Redactor();
  const store = new CredentialStore({
    stateRoot: state,
    fingerprintKey: Buffer.alloc(32, 7),
    redactor,
  });

  const metadata = await store.put({
    project: 'sample',
    provider: 'vercel',
    alias: 'sample-vercel-admin',
    credentialType: 'api-token',
    expectedIdentity: { teamId: 'team_public' },
    secret: Buffer.from(canary),
    createdAt: '2026-08-18T00:00:00.000Z',
  });
  assert.match(metadata.fingerprint, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(metadata).includes(canary), false);
  assert.equal('readSecret' in store, false);
  assert.equal('exportSecret' in store, false);

  let observed = '';
  await store.withCredential('sample', 'vercel', 'sample-vercel-admin', async (secret) => {
    observed = secret.toString('utf8');
    assert.throws(() => redactor.assertClean(`log=${observed}`), /secret-bearing/i);
  });
  assert.equal(observed, canary);
  assert.doesNotThrow(() => redactor.assertClean(`log=${canary}`));

  const secretPath = path.join(state, 'credentials/sample/vercel/sample-vercel-admin.secret');
  const metadataPath = path.join(state, 'metadata/credentials/sample/vercel/sample-vercel-admin.json');
  assert.equal((await lstat(secretPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(metadataPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(metadataPath, 'utf8')).includes(canary), false);
});

test('serializes concurrent access to one credential without blocking a different credential', async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'inframux-locks-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const store = new CredentialStore({
    stateRoot: state,
    fingerprintKey: Buffer.alloc(32, 9),
    redactor: new Redactor(),
  });
  for (const alias of ['primary-token', 'secondary-token']) {
    await store.put({
      project: 'sample', provider: 'vercel', alias,
      credentialType: 'api-token', expectedIdentity: {}, secret: Buffer.from(`${alias}-secret`),
      createdAt: '2026-08-18T00:00:00.000Z',
    });
  }

  let activePrimary = 0;
  let peakPrimary = 0;
  let secondaryRan = false;
  const primary = () => store.withCredential('sample', 'vercel', 'primary-token', async () => {
    activePrimary += 1;
    peakPrimary = Math.max(peakPrimary, activePrimary);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activePrimary -= 1;
  });
  await Promise.all([
    primary(),
    primary(),
    store.withCredential('sample', 'vercel', 'secondary-token', async () => { secondaryRan = true; }),
  ]);
  assert.equal(peakPrimary, 1);
  assert.equal(secondaryRan, true);
});

test('reuses one verified secret through an explicit project binding without copying bytes', async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'inframux-bindings-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const store = new CredentialStore({ stateRoot: state, fingerprintKey: Buffer.alloc(32, 11), redactor: new Redactor() });
  await store.put({
    project: 'source-project', provider: 'vercel', alias: 'source-vercel-admin',
    credentialType: 'api-token', expectedIdentity: { teamId: 'team-one' }, secret: Buffer.from(canary),
  });

  const binding = await store.bindExisting({
    sourceProject: 'source-project', sourceAlias: 'source-vercel-admin',
    targetProject: 'target-project', targetAlias: 'target-vercel-admin', provider: 'vercel',
    expectedIdentity: { teamId: 'team-one' },
  });
  assert.equal(binding.project, 'target-project');
  assert.equal(binding.fingerprint, (await store.metadata('source-project', 'vercel', 'source-vercel-admin')).fingerprint);
  let observed = '';
  await store.withCredential('target-project', 'vercel', 'target-vercel-admin', async (secret) => { observed = secret.toString(); });
  assert.equal(observed, canary);
  await assert.rejects(lstat(path.join(state, 'credentials/target-project/vercel/target-vercel-admin.secret')), { code: 'ENOENT' });
  assert.equal(await store.remove('target-project', 'vercel', 'target-vercel-admin'), true);
  await store.withCredential('source-project', 'vercel', 'source-vercel-admin', async (secret) => assert.equal(secret.toString(), canary));
  await assert.rejects(store.bindExisting({
    sourceProject: 'source-project', sourceAlias: 'source-vercel-admin', targetProject: 'wrong-project',
    targetAlias: 'wrong-vercel-admin', provider: 'vercel', expectedIdentity: { teamId: 'team-two' },
  }), /identity/i);
});
