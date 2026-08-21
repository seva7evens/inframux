import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OnboardingSessionStore } from '../../src/onboarding/session-store.js';

const evidence = {
  repositoryRoot: '/workspace/example', gitCommonDir: '/workspace/example/.git',
  manifestPath: '/workspace/example/.inframux.toml', manifestDigest: `sha256:${'a'.repeat(64)}`,
  normalizedRemotes: ['github.com/acme/example'],
};

test('persists private owner-bound onboarding sessions and replaces only unverified configuration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-onboarding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OnboardingSessionStore({ stateRoot: root, now: () => new Date('2026-08-19T10:00:00Z') });
  const created = await store.create({ callerUid: 501, project: 'example', displayName: 'Example', evidence, providers: ['cloudflare'] });

  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal((await lstat(path.join(root, 'onboarding', `${created.id}.json`))).mode & 0o777, 0o600);
  await assert.rejects(store.get(created.id, 502), /different user/i);
  const configured = await store.configure(created.id, 501, 'cloudflare', { credential: 'cloudflare-admin', accountId: 'one' });
  assert.deepEqual(configured.services.cloudflare?.config, { credential: 'cloudflare-admin', accountId: 'one' });
  assert.deepEqual(await store.configure(created.id, 501, 'cloudflare', { credential: 'cloudflare-admin', accountId: 'one' }), configured);
  const corrected = await store.configure(created.id, 501, 'cloudflare', { credential: 'cloudflare-admin', accountId: 'two' });
  assert.deepEqual(corrected.services.cloudflare?.config, { credential: 'cloudflare-admin', accountId: 'two' });
  await store.markVerified(created.id, 501, 'cloudflare', 'cloudflare-admin');
  await assert.rejects(
    store.configure(created.id, 501, 'cloudflare', { credential: 'cloudflare-admin', accountId: 'three' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PROVIDER_ALREADY_VERIFIED',
  );
});

test('expires mutation after 24 hours and refuses incomplete completion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-onboarding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = new Date('2026-08-19T10:00:00Z');
  const store = new OnboardingSessionStore({ stateRoot: root, now: () => now });
  const session = await store.create({ callerUid: 501, project: 'example', displayName: 'Example', evidence, providers: ['cloudflare', 'vercel'] });
  await assert.rejects(store.complete(session.id, 501), /incomplete providers.*cloudflare.*vercel/i);
  await store.configure(session.id, 501, 'cloudflare', { credential: 'cloudflare-admin', accountId: 'one' });
  await store.markVerified(session.id, 501, 'cloudflare', 'profile-one');
  await store.configure(session.id, 501, 'vercel', { credential: 'vercel-admin', teamId: 'team' });
  await store.markVerified(session.id, 501, 'vercel', 'profile-two');
  assert.equal((await store.complete(session.id, 501)).completedAt, '2026-08-19T10:00:00.000Z');

  const second = await store.create({ callerUid: 501, project: 'later', displayName: 'Later', evidence, providers: ['cloudflare'] });
  now = new Date('2026-08-20T10:00:00.001Z');
  await assert.rejects(store.configure(second.id, 501, 'cloudflare', { credential: 'cloudflare-admin' }), /expired/i);
  assert.equal((await store.get(second.id, 501)).project, 'later');
});
