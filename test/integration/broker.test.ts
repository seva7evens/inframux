import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';

import { Broker, type AuditSink } from '../../src/broker/broker.js';
import { startBrokerService } from '../../src/broker/service.js';
import { loadRepositoryManifest } from '../../src/config/load.js';
import { collectCheckoutEvidence } from '../../src/git/evidence.js';
import { connectClient } from '../../src/ipc/client.js';
import { launchMcpFromRepository } from '../../src/cli/mcp-launch.js';
import { PassThrough } from 'node:stream';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { ProviderAdapterRegistry, type ProviderAdapter } from '../../src/providers/adapters/index.js';
import { InframuxError } from '../../src/core/errors.js';
import { decodeOAuthCredential, encodeOAuthCredential, type OAuthCredential, type OAuthRefreshResult } from '../../src/providers/oauth.js';
import { AuditLog } from '../../src/security/audit.js';
import { CredentialStore } from '../../src/security/credential-store.js';
import { Redactor } from '../../src/security/redactor.js';
import { EnrolledCatalogStore } from '../../src/trust/catalog-store.js';
import { TrustLedger } from '../../src/trust/ledger.js';
import { PendingTrustStore } from '../../src/trust/pending.js';
import { OnboardingSessionStore } from '../../src/onboarding/session-store.js';
import type { ExecutableManifest } from '../../src/worker/executable-manifest.js';
import { LocalWorkerExecutor } from '../../src/broker/worker-executor.js';
import { McpProcessManager } from '../../src/worker/mcp-process.js';
import { WorkerRunner } from '../../src/worker/runner.js';

const execute = promisify(execFile);
const remote = 'github.com/example-org/sample_app';
const token = 'account:account-sample:broker-canary-secret';

test('orchestrates dynamic onboarding without package-baked project logic', async (t) => {
  const fixture = await setupBroker(t);
  const started = await fixture.broker.handle('onboarding.start', {
    project: 'sample-app', displayName: 'Sample management', providers: ['synthetic'],
    evidence: fixture.evidence, workspaceRoot: fixture.root,
  }, fixture.context()) as { id: string; plan: Array<{ id: string; requiredConfig: string[]; auth: string }> };
  assert.deepEqual(started.plan.map(({ id, auth, requiredConfig }) => ({ id, auth, requiredConfig })), [
    { id: 'synthetic', auth: 'static-token', requiredConfig: ['accountId'] },
  ]);
  assert.equal((started as unknown as { state: string }).state, 'configuration-required');
  assert.match((started as unknown as { nextActions: Array<{ command: string }> }).nextActions[0]!.command, /onboard configure/);
  await assert.rejects(fixture.broker.handle('onboarding.status', { sessionId: started.id }, {
    callerUid: fixture.context().callerUid + 1, signal: new AbortController().signal,
  }), /different user/i);
  const configured = await fixture.broker.handle('onboarding.configure', {
    sessionId: started.id, provider: 'synthetic', input: { accountId: 'account-sample' },
  }, fixture.context()) as { services: Record<string, { config?: unknown }> };
  assert.deepEqual(configured.services.synthetic?.config, { credential: 'sample-app-synthetic-admin', accountId: 'account-sample' });
  assert.equal((configured as unknown as { state: string }).state, 'authorization-required');
  await fixture.broker.handle('credential.enroll', {
    project: 'sample-app', provider: 'synthetic', credentialType: 'administrative-token',
    secretBase64: Buffer.from(token).toString('base64'),
  }, fixture.context());
  const resumed = await fixture.broker.handle('onboarding.resume', { sessionId: started.id }, fixture.context()) as {
    services: Record<string, { profile?: string }>;
  };
  assert.equal(resumed.services.synthetic?.profile, 'sample-app-synthetic-admin');
  const finished = await fixture.broker.handle('onboarding.finish', { sessionId: started.id }, fixture.context()) as { complete: boolean };
  assert.equal(finished.complete, true);
  assert.equal((await fixture.ledger.find(fixture.evidence.repositoryRoot))?.project, 'sample-app');
});

test('finishes without explicit resume and replays canonical agent instructions', async (t) => {
  const fixture = await setupBroker(t);
  const started = await fixture.broker.handle('onboarding.start', {
    project: 'sample-app', displayName: 'Sample management', providers: ['synthetic'],
    evidence: fixture.evidence, workspaceRoot: fixture.root,
  }, fixture.context()) as { id: string };
  await fixture.broker.handle('onboarding.configure', {
    sessionId: started.id, provider: 'synthetic', input: { accountId: 'account-sample' },
  }, fixture.context());
  await assert.rejects(
    fixture.broker.handle('onboarding.finish', { sessionId: started.id }, fixture.context()),
    (error: unknown) => error instanceof InframuxError && error.code === 'SESSION_AUTHORIZATION_REQUIRED' &&
      error.recovery === `inframux onboard authorize ${started.id}`,
  );
  await fixture.broker.handle('credential.enroll', {
    project: 'sample-app', provider: 'synthetic', credentialType: 'administrative-token',
    secretBase64: Buffer.from(token).toString('base64'),
  }, fixture.context());

  const first = await fixture.broker.handle('onboarding.finish', { sessionId: started.id }, fixture.context()) as {
    complete: boolean; state: string; agentInstructions: string; nextActions: unknown[];
  };
  const repeated = await fixture.broker.handle('onboarding.finish', { sessionId: started.id }, fixture.context());
  const resumed = await fixture.broker.handle('onboarding.resume', { sessionId: started.id }, fixture.context());
  assert.equal(first.complete, true);
  assert.equal(first.state, 'complete');
  assert.match(first.agentInstructions, /Available provider contexts: synthetic/);
  assert.equal(first.nextActions.length, 3);
  assert.deepEqual(repeated, first);
  assert.deepEqual(resumed, first);
});

test('reports hardened checkout access before authorization and blocks finish with one recovery action', async (t) => {
  const fixture = await setupBroker(t, undefined, undefined, async (repositoryRoot) => ({
    ready: false as const, inaccessibleAncestor: path.dirname(repositoryRoot),
  }), 'hardened');
  const started = await fixture.broker.handle('onboarding.start', {
    project: 'sample-app', displayName: 'Sample management', providers: ['synthetic'],
    evidence: fixture.evidence, workspaceRoot: fixture.root,
  }, fixture.context()) as { id: string; state: string; nextActions: Array<{ command: string }> };
  assert.equal(started.state, 'checkout-access-required');
  assert.equal(started.nextActions[0]!.command, `inframux trust prepare-checkout ${started.id}`);

  const preview = await fixture.broker.handle('onboarding.checkout-access', { sessionId: started.id }, fixture.context()) as {
    ready: boolean; ancestors: string[]; principal: string;
  };
  assert.deepEqual(preview.ancestors, [path.dirname(fixture.evidence.repositoryRoot)]);
  assert.equal(preview.principal, '_inframux');
  await assert.rejects(
    fixture.broker.handle('onboarding.finish', { sessionId: started.id }, fixture.context()),
    (error: unknown) => error instanceof InframuxError && error.code === 'BROKER_CHECKOUT_INACCESSIBLE' &&
      error.recovery === `inframux trust prepare-checkout ${started.id}`,
  );
});

test('derives provider identity pins from non-secret onboarding configuration before authorization', async (t) => {
  const fixture = await setupBroker(t);
  const started = await fixture.broker.handle('onboarding.start', {
    project: 'sample-app', displayName: 'Sample management', providers: ['resend', 'uptimerobot'],
    evidence: fixture.evidence, workspaceRoot: fixture.root,
  }, fixture.context()) as { id: string };

  await fixture.broker.handle('onboarding.configure', {
    sessionId: started.id, provider: 'resend', input: {},
  }, fixture.context());
  await fixture.broker.handle('onboarding.configure', {
    sessionId: started.id, provider: 'uptimerobot', input: { monitors: { api: '200000002', web: '100000001' } },
  }, fixture.context());

  assert.deepEqual(await fixture.broker.handle('credential.enrollment-info', {
    project: 'sample-app', provider: 'resend',
  }, fixture.context()), {
    schema: 1, project: 'sample-app', provider: 'resend',
    expectedIdentity: { accountScope: 'full_access' }, scopes: [],
  });
  assert.deepEqual(await fixture.broker.handle('credential.enrollment-info', {
    project: 'sample-app', provider: 'uptimerobot',
  }, fixture.context()), {
    schema: 1, project: 'sample-app', provider: 'uptimerobot',
    expectedIdentity: { accountFingerprint: 'monitors:100000001,200000002' }, scopes: [],
  });
});

test('enrolls once, resolves checkout, reports status, and runs a verified provider lease', async (t) => {
  const fixture = await setupBroker(t);
  const googleEnrollment = await fixture.broker.handle('credential.enrollment-info', {
    project: 'sample', provider: 'google-cloud',
  }, fixture.context());
  assert.deepEqual(googleEnrollment, {
    schema: 1, project: 'sample', provider: 'google-cloud',
    expectedIdentity: { account: 'maintainer@example.test' },
    scopes: ['email', 'openid'],
  });
  const enrolled = await fixture.broker.handle('credential.enroll', {
    project: 'sample', provider: 'synthetic', alias: 'sample-synthetic-admin',
    credentialType: 'api-token', expectedIdentity: { accountId: 'account-sample' },
    secretBase64: Buffer.from(token).toString('base64'),
  }, fixture.context());
  assert.equal((enrolled as { identity: { accountId: string } }).identity.accountId, 'account-sample');
  assert.equal(JSON.stringify(enrolled).includes(token), false);

  const authStatus = await fixture.broker.handle('credential.status', { project: 'sample' }, fixture.context()) as {
    providers: Array<{ id: string; health: string; credential?: string }>;
  };
  assert.equal(authStatus.providers.find((item) => item.id === 'synthetic')?.health, 'healthy');
  assert.equal(authStatus.providers.find((item) => item.id === 'cloudflare')?.health, 'missing');
  assert.equal(JSON.stringify(authStatus).includes(token), false);

  const resolved = await fixture.broker.handle('project.resolve', fixture.checkoutPayload(), fixture.context());
  assert.equal((resolved as { project: string }).project, 'sample');
  const status = await fixture.broker.handle('status', fixture.checkoutPayload(), fixture.context());
  assert.equal((status as { securityMode: string }).securityMode, 'user');
  assert.equal(
    (status as { providers: Array<{ id: string; health: string }> }).providers.find((item) => item.id === 'synthetic')?.health,
    'healthy',
  );

  const result = await fixture.broker.handle('run', {
    ...fixture.checkoutPayload(), provider: 'synthetic', args: ['resources'],
  }, fixture.context());
  assert.equal((result as { stdout: string }).stdout, '{"resources":["alpha","beta"]}\n');
  assert.equal(JSON.stringify(result).includes('broker-canary-secret'), false);
  assert.equal((await fixture.audit.verify()).valid, true);
});

test('rejects wrong identity, missing credentials, foreign checkouts, and source-bound operations', async (t) => {
  const fixture = await setupBroker(t);
  await assert.rejects(() => fixture.broker.handle('credential.enroll', {
    project: 'sample', provider: 'synthetic', alias: 'sample-synthetic-admin',
    credentialType: 'api-token', expectedIdentity: { accountId: 'account-sample' },
    secretBase64: Buffer.from('account:wrong-account:long-enough-secret').toString('base64'),
  }, fixture.context()), /wrong provider identity/i);

  await assert.rejects(() => fixture.broker.handle('run', {
    ...fixture.checkoutPayload(), provider: 'synthetic', args: ['resources'],
  }, fixture.context()), /not enrolled|credential/i);

  const copied = path.join(fixture.root, 'copied');
  await execute('cp', ['-R', fixture.repository, copied]);
  await assert.rejects(async () => fixture.broker.handle('project.resolve', {
    evidence: await collectCheckoutEvidence(copied), manifest: fixture.manifest,
  }, fixture.context()), /checkout.*approved/i);

  await assert.rejects(() => fixture.broker.handle('call', {
    ...fixture.checkoutPayload(), provider: 'supabase', operation: 'database.migrate', input: {},
  }, fixture.context()), /source-bound|unsupported/i);
});

test('routes production enrollment and API calls through the adapter while preserving a valid credential on failed rotation', async (t) => {
  const adapter = new RecordingCloudflareAdapter();
  const fixture = await setupBroker(t, adapter);
  const firstSecret = 'cloudflare-production-secret-one';
  const enrolled = await fixture.broker.handle('credential.enroll', {
    project: 'sample', provider: 'cloudflare', credentialType: 'user-api-token',
    expectedIdentity: { accountId: 'cf-account' },
    secretBase64: Buffer.from(firstSecret).toString('base64'),
  }, fixture.context()) as { identity: { accountId: string }; metadata: { fingerprint: string } };
  assert.deepEqual(enrolled.identity, { accountId: 'cf-account' });
  assert.equal(JSON.stringify(enrolled).includes(firstSecret), false);

  const doctor = await fixture.broker.handle('doctor', fixture.checkoutPayload(), fixture.context()) as {
    providers: Array<{ id: string; health: string; identity?: { accountId: string }; resources?: unknown }>;
  };
  const cloudflareHealth = doctor.providers.find((item) => item.id === 'cloudflare');
  assert.deepEqual(cloudflareHealth, {
    id: 'cloudflare', health: 'healthy', identity: { accountId: 'cf-account' }, resources: { zones: [] },
  });

  const called = await fixture.broker.handle('call', {
    ...fixture.checkoutPayload(), provider: 'cloudflare', operation: 'api.request',
    input: { method: 'GET', path: '/client/v4/accounts/cf-account' },
  }, fixture.context());
  assert.deepEqual(called, { adapter: 'cloudflare', accountId: 'cf-account', ok: true });
  assert.equal(adapter.seenSecrets.at(-1), firstSecret);

  adapter.state.wrongIdentity = true;
  await assert.rejects(
    fixture.broker.handle('credential.enroll', {
      project: 'sample', provider: 'cloudflare', credentialType: 'user-api-token',
      expectedIdentity: { accountId: 'cf-account' },
      secretBase64: Buffer.from('cloudflare-production-secret-two').toString('base64'),
    }, fixture.context()),
    (error: unknown) => error instanceof InframuxError && error.code === 'WRONG_PROVIDER_IDENTITY',
  );
  adapter.state.wrongIdentity = false;
  const retained = await fixture.credentials.metadata('sample', 'cloudflare', 'sample-cloudflare-admin');
  assert.equal(retained.fingerprint, enrolled.metadata.fingerprint);
  await fixture.broker.handle('call', {
    ...fixture.checkoutPayload(), provider: 'cloudflare', operation: 'api.request',
    input: { method: 'GET', path: '/client/v4/accounts/cf-account' },
  }, fixture.context());
  assert.equal(adapter.seenSecrets.at(-1), firstSecret);

  const revoked = await fixture.broker.handle('credential.revoke', {
    project: 'sample', provider: 'cloudflare',
  }, fixture.context());
  assert.deepEqual(revoked, { removed: true, project: 'sample', provider: 'cloudflare' });
  await assert.rejects(
    fixture.credentials.metadata('sample', 'cloudflare', 'sample-cloudflare-admin'),
    /not enrolled/,
  );
});

test('refreshes one Google OAuth credential once for concurrent calls and persists refresh-token rotation', async (t) => {
  const adapter = new RecordingGoogleAdapter();
  let refreshes = 0;
  const fixture = await setupBroker(t, adapter, async (credential) => {
    refreshes += 1;
    assert.equal(credential.refreshToken, 'google-refresh-one');
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      accessToken: 'google-access-two', refreshToken: 'google-refresh-two', tokenType: 'Bearer',
      expiresInSeconds: 3600, scopes: credential.scopes,
    };
  });
  const expired: OAuthCredential = {
    schema: 1, kind: 'oauth2', accessToken: 'google-access-one', refreshToken: 'google-refresh-one',
    tokenType: 'Bearer', expiresAt: '2026-08-18T00:00:00.000Z', scopes: ['email', 'openid'],
    clientId: 'desktop-client', clientSecret: 'desktop-public-client-secret',
    tokenEndpoint: 'https://oauth2.googleapis.com/token', revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  };
  const encoded = encodeOAuthCredential(expired);
  try {
    await fixture.credentials.put({
      project: 'sample', provider: 'google-cloud', alias: 'sample-google-cloud-admin',
      credentialType: 'oauth2', expectedIdentity: { account: 'maintainer@example.test' },
      secret: encoded, expiresAt: expired.expiresAt, lastVerifiedAt: '2026-08-18T00:00:00.000Z',
    });
  } finally {
    encoded.fill(0);
  }
  const beforeRefresh = await fixture.broker.handle('status', fixture.checkoutPayload(), fixture.context()) as {
    providers: Array<{ id: string; health: string }>;
  };
  assert.equal(beforeRefresh.providers.find((item) => item.id === 'google-cloud')?.health, 'expiring');
  await Promise.all(Array.from({ length: 6 }, () => fixture.broker.handle('call', {
    ...fixture.checkoutPayload(), provider: 'google-cloud', operation: 'api.request',
    input: { api: 'gmail', method: 'GET', path: '/gmail/v1/users/me/profile' },
  }, fixture.context())));
  assert.equal(refreshes, 1);
  assert.deepEqual(adapter.seenAccessTokens, Array.from({ length: 12 }, () => 'google-access-two'));
  let persisted: OAuthCredential | undefined;
  await fixture.credentials.withCredential('sample', 'google-cloud', 'sample-google-cloud-admin', async (secret) => {
    persisted = decodeOAuthCredential(secret);
  });
  assert.equal(persisted?.refreshToken, 'google-refresh-two');
  assert.ok(Date.parse(persisted?.expiresAt ?? '') > Date.now());
});

test('propagates cancellation and fails closed when audit durability is unavailable', async (t) => {
  const fixture = await setupBroker(t);
  await fixture.enroll();
  const controller = new AbortController();
  const running = fixture.broker.handle('run', {
    ...fixture.checkoutPayload(), provider: 'synthetic', args: ['sleep', '5000'],
  }, fixture.context(controller.signal));
  controller.abort(new Error('cancelled by active task'));
  await assert.rejects(() => running, /cancel/i);

  fixture.auditSink.fail = true;
  await assert.rejects(() => fixture.broker.handle('run', {
    ...fixture.checkoutPayload(), provider: 'synthetic', args: ['resources'],
  }, fixture.context()), /audit/i);
});

test('exposes the strict broker operations over the client Unix socket', async (t) => {
  const fixture = await setupBroker(t);
  await fixture.enroll();
  const socketPath = path.join(fixture.root, 'run/client.sock');
  const service = await startBrokerService({
    socketPath,
    broker: fixture.broker,
    callerUid: process.getuid!(),
  });
  t.after(() => service.close());
  const client = await connectClient(socketPath);
  t.after(() => client.close());
  const resolved = await client.call('project.resolve', fixture.checkoutPayload());
  assert.equal((resolved as { project: string }).project, 'sample');
  await assert.rejects(() => client.call('raw-secret.read', {}), /unknown operation/i);
});

test('links, approves and revokes one exact checkout through expiring trust state', async (t) => {
  const fixture = await setupBroker(t);
  assert.equal(await fixture.ledger.revoke(fixture.evidence.repositoryRoot), true);
  const pending = await fixture.broker.handle('trust.request', {
    ...fixture.checkoutPayload(), workspaceRoot: fixture.root,
  }, fixture.context()) as { id: string; repositoryRoot: string };
  assert.equal(pending.repositoryRoot, fixture.evidence.repositoryRoot);
  await assert.rejects(
    fixture.broker.handle('project.resolve', fixture.checkoutPayload(), fixture.context()),
    /not approved/i,
  );
  const approved = await fixture.broker.handle('trust.approve', { requestId: pending.id }, fixture.context());
  assert.deepEqual(approved, { approved: true, project: 'sample', repositoryRoot: fixture.evidence.repositoryRoot });
  const resolved = await fixture.broker.handle('project.resolve', fixture.checkoutPayload(), fixture.context()) as { project: string };
  assert.equal(resolved.project, 'sample');
  const revoked = await fixture.broker.handle('trust.revoke', { repositoryRoot: fixture.evidence.repositoryRoot }, fixture.context());
  assert.deepEqual(revoked, { revoked: true, repositoryRoot: fixture.evidence.repositoryRoot });
});

test('opens only the catalog-bound official MCP and tunnels opaque bytes', async (t) => {
  const fixture = await setupBroker(t);
  await fixture.enroll();
  const opened = await fixture.broker.handle('mcp.open', {
    ...fixture.checkoutPayload(), provider: 'synthetic',
  }, fixture.context()) as { sessionId: string };
  const message = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n';
  await fixture.broker.handle('mcp.write', {
    sessionId: opened.sessionId, chunkBase64: Buffer.from(message).toString('base64'),
  }, fixture.context());
  await fixture.broker.handle('mcp.end', { sessionId: opened.sessionId }, fixture.context());
  let output = '';
  let eof = false;
  while (!eof) {
    const read = await fixture.broker.handle('mcp.read', { sessionId: opened.sessionId }, fixture.context()) as {
      stdoutBase64: string; eof: boolean;
    };
    output += Buffer.from(read.stdoutBase64, 'base64').toString('utf8');
    eof = read.eof;
  }
  await fixture.broker.handle('mcp.close', { sessionId: opened.sessionId }, fixture.context());
  assert.equal(output, message);
});

test('drains only matching MCP sessions after a successful credential rotation', async (t) => {
  const fixture = await setupBroker(t);
  await fixture.enroll();
  const opened = await fixture.broker.handle('mcp.open', {
    ...fixture.checkoutPayload(), provider: 'synthetic',
  }, fixture.context()) as { sessionId: string };
  await fixture.broker.handle('credential.enroll', {
    project: 'sample', provider: 'synthetic', alias: 'sample-synthetic-admin',
    credentialType: 'api-token', expectedIdentity: { accountId: 'account-sample' },
    secretBase64: Buffer.from('account:account-sample:rotated-broker-canary').toString('base64'),
  }, fixture.context());
  await assert.rejects(
    fixture.broker.handle('mcp.read', { sessionId: opened.sessionId }, fixture.context()),
    /unknown.*session/i,
  );
});

test('launches the official MCP from repository stdio through the broker socket', async (t) => {
  const fixture = await setupBroker(t);
  await fixture.enroll();
  const socketPath = path.join(fixture.root, 'run/mcp-client.sock');
  const service = await startBrokerService({ socketPath, broker: fixture.broker, callerUid: process.getuid!() });
  t.after(() => service.close());
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const outputChunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => outputChunks.push(Buffer.from(chunk)));
  const message = '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}\n';
  input.end(message);
  await launchMcpFromRepository('synthetic', {
    cwd: fixture.repository,
    input,
    output,
    errorOutput,
    socketPath,
  });
  assert.equal(Buffer.concat(outputChunks).toString('utf8'), message);
});

async function setupBroker(
  t: TestContext,
  productionAdapter?: ProviderAdapter,
  googleRefresh?: (credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthRefreshResult>,
  checkoutAccess?: (repositoryRoot: string, gitCommonDir: string) => Promise<{ ready: true } | { ready: false; inaccessibleAncestor: string }>,
  securityMode: 'hardened' | 'user' = 'user',
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-broker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  await execute('git', ['init', '-b', 'main'], { cwd: repository });
  await execute('git', ['config', 'user.email', 'inframux@example.invalid'], { cwd: repository });
  await execute('git', ['config', 'user.name', 'inframux test'], { cwd: repository });
  await writeFile(path.join(repository, '.inframux.toml'), 'schema = 1\nproject = "sample"\nregistry = "sample"\n');
  await execute('git', ['add', '.inframux.toml'], { cwd: repository });
  await execute('git', ['commit', '-m', 'fixture'], { cwd: repository });
  await execute('git', ['remote', 'add', 'origin', `https://${remote}.git`], { cwd: repository });
  const evidence = await collectCheckoutEvidence(repository);
  const manifest = await loadRepositoryManifest(path.join(repository, '.inframux.toml'));
  const state = path.join(root, 'state');
  const ledger = new TrustLedger(state);
  await ledger.approve({
    schema: 1, project: 'sample', repositoryRoot: evidence.repositoryRoot,
    gitCommonDir: evidence.gitCommonDir, canonicalRemote: remote, workspaceRoot: root,
    manifestDigest: evidence.manifestDigest, approvedAt: '2026-08-18T00:00:00.000Z',
  });
  const catalogs = new EnrolledCatalogStore(state);
  await catalogs.enroll({
    schema: 1, id: 'sample', displayName: 'Sample Project',
    repositories: [{ remote }],
    services: {
      synthetic: { credential: 'sample-synthetic-admin', accountId: 'account-sample' },
      supabase: { credential: 'sample-supabase-admin', organizationId: 'org-public' },
      cloudflare: { credential: 'sample-cloudflare-admin', accountId: 'cf-account' },
      'google-cloud': {
        credential: 'sample-google-cloud-admin', account: 'maintainer@example.test', scopes: ['email', 'openid'],
      },
    },
  });

  const redactor = new Redactor();
  const credentials = new CredentialStore({ stateRoot: state, fingerprintKey: Buffer.alloc(32, 21), redactor });
  const audit = new AuditLog({ stateRoot: state, hmacKey: Buffer.alloc(32, 22), redactor });
  const auditSink = new ToggleAuditSink(audit);
  const toolRoot = path.join(root, 'tools');
  await mkdir(toolRoot, { mode: 0o700 });
  const executable = path.join(toolRoot, 'synthetic-provider');
  await copyFile(new URL('../fixtures/fake-provider.mjs', import.meta.url), executable);
  await writeFile(executable, (await readFile(executable, 'utf8')).replace('#!/usr/bin/env node', `#!${process.execPath}`));
  await chmod(executable, 0o755);
  const mcpExecutable = path.join(toolRoot, 'synthetic-mcp');
  await copyFile(new URL('../fixtures/fake-mcp.mjs', import.meta.url), mcpExecutable);
  await writeFile(mcpExecutable, (await readFile(mcpExecutable, 'utf8')).replace('#!/usr/bin/env node', `#!${process.execPath}`));
  await chmod(mcpExecutable, 0o755);
  const executableManifest: ExecutableManifest = {
    schema: 1, runtimeNodeVersion: '24.18.1', executables: {
      'synthetic-cli': {
        path: executable, provider: 'synthetic', kind: 'cli', version: '1.0.0',
        sha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
      },
      'synthetic-mcp': {
        path: mcpExecutable, provider: 'synthetic', kind: 'mcp', version: '1.0.0',
        sha256: createHash('sha256').update(await readFile(mcpExecutable)).digest('hex'),
      },
    },
  };
  const runner = new WorkerRunner({
    workerRoot: path.join(root, 'worker'), toolRoot, manifest: executableManifest,
    allowedOwnerUids: [process.getuid!()], redactor, terminationGraceMs: 10,
  });
  const mcp = new McpProcessManager({
    workerRoot: path.join(root, 'worker'), toolRoot, manifest: executableManifest,
    allowedOwnerUids: [process.getuid!()], redactor, terminationGraceMs: 10,
  });
  const broker = new Broker({
    securityMode, ledger, catalogs, credentials, audit: auditSink,
    providers: createProviderRegistry(), worker: new LocalWorkerExecutor(runner, mcp),
    adapters: new ProviderAdapterRegistry(productionAdapter === undefined ? [] : [productionAdapter]),
    ...(googleRefresh === undefined ? {} : { googleRefresh }),
    pendingTrust: new PendingTrustStore({ stateRoot: state }),
    onboarding: new OnboardingSessionStore({ stateRoot: state }),
    redactor,
    ...(checkoutAccess === undefined ? {} : { checkoutAccess }),
  });
  return {
    root, repository, evidence, manifest, broker, audit, auditSink, credentials, ledger,
    checkoutPayload: () => ({ evidence, manifest }),
    context: (signal = new AbortController().signal) => ({ callerUid: process.getuid!(), signal }),
    enroll: () => broker.handle('credential.enroll', {
      project: 'sample', provider: 'synthetic', alias: 'sample-synthetic-admin',
      credentialType: 'api-token', expectedIdentity: { accountId: 'account-sample' },
      secretBase64: Buffer.from(token).toString('base64'),
    }, { callerUid: process.getuid!(), signal: new AbortController().signal }),
  };
}

class RecordingCloudflareAdapter implements ProviderAdapter {
  readonly id = 'cloudflare';
  readonly seenSecrets: string[] = [];
  readonly state = { wrongIdentity: false };

  async verify(context: Parameters<ProviderAdapter['verify']>[0]) {
    this.seenSecrets.push(context.secret.toString('utf8'));
    if (this.state.wrongIdentity) throw new InframuxError('WRONG_PROVIDER_IDENTITY', 'Cloudflare account mismatch');
    return { identity: { accountId: 'cf-account' }, resources: { zones: [] } };
  }

  async call(context: Parameters<ProviderAdapter['call']>[0]) {
    this.seenSecrets.push(context.secret.toString('utf8'));
    return { adapter: 'cloudflare', accountId: 'cf-account', ok: true };
  }
}

class RecordingGoogleAdapter implements ProviderAdapter {
  readonly id = 'google-cloud';
  readonly seenAccessTokens: string[] = [];

  async verify(context: Parameters<ProviderAdapter['verify']>[0]) {
    const credential = decodeOAuthCredential(context.secret);
    this.seenAccessTokens.push(credential.accessToken);
    return { identity: { account: 'maintainer@example.test' }, resources: { projects: [] } };
  }

  async call(context: Parameters<ProviderAdapter['call']>[0]) {
    const credential = decodeOAuthCredential(context.secret);
    this.seenAccessTokens.push(credential.accessToken);
    return { account: 'maintainer@example.test', ok: true };
  }
}

class ToggleAuditSink implements AuditSink {
  fail = false;
  constructor(readonly target: AuditLog) {}
  async append(input: Parameters<AuditLog['append']>[0]): Promise<void> {
    if (this.fail) throw new Error('synthetic audit unavailable');
    await this.target.append(input);
  }
}
