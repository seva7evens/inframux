import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { InframuxError } from '../../src/core/errors.js';
import { createProviderAdapterRegistry } from '../../src/providers/adapters/index.js';
import { FetchHttpTransport } from '../../src/providers/http-transport.js';

test('verifies every static provider against exact catalog identity and resources', async (context) => {
  const seen: Array<{ method: string; url: string; authorization: string }> = [];
  const server = createServer((request, response) => {
    seen.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorization: request.headers.authorization ?? '',
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(route(request.url ?? '')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = new FetchHttpTransport({
    allowedOrigins: [origin], allowInsecureLoopback: true,
    timeoutMs: 2_000, maxRequestBytes: 64 * 1024, maxResponseBytes: 256 * 1024,
  });
  const registry = createProviderAdapterRegistry({
    transport,
    originOverrides: Object.fromEntries(
      ['cloudflare', 'vercel', 'supabase', 'sentry', 'uptimerobot', 'resend', 'posthog']
        .map((provider) => [provider, origin]),
    ),
  });
  const fixtures = [
    {
      provider: 'cloudflare',
      service: { credential: 'cf-admin', accountId: 'cf-account', zones: [{ name: 'example.test' }] },
      identity: { accountId: 'cf-account' },
    },
    {
      provider: 'vercel',
      service: {
        credential: 'vercel-admin', user: 'samplebot-4021', teamId: 'vercel-team',
        projects: ['vercel-project'],
      },
      identity: { teamId: 'vercel-team', user: 'samplebot-4021' },
    },
    {
      provider: 'supabase',
      service: {
        credential: 'supabase-admin', organizationId: 'supabase-org',
        projects: ['supabase-project'],
      },
      identity: { organizationId: 'supabase-org' },
    },
    {
      provider: 'sentry',
      service: {
        credential: 'sentry-admin', origin: 'https://de.sentry.io', organization: 'sentry-org',
        projects: ['sample-admin-panel', 'sample-streamer', 'sample-streamer-supervisor'],
      },
      identity: { organization: 'sentry-org', origin: 'https://de.sentry.io' },
    },
    {
      provider: 'uptimerobot',
      service: { credential: 'uptime-admin', monitors: ['100000001', '100000002'] },
      identity: {
        resourceFingerprint: 'sha256:36045807e5fec6c4c4d034de859b3e8d3f34c91b57e0190345be6d4004d82978',
        monitorCount: '2',
      },
    },
    {
      provider: 'uptimerobot',
      service: { credential: 'uptime-empty-admin', monitors: [] },
      identity: {
        resourceFingerprint: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        monitorCount: '2',
      },
    },
    {
      provider: 'resend',
      service: { credential: 'resend-admin', accountScope: 'full_access', anticipatedDomain: 'mail.example.test', status: 'planned' },
      identity: { accountScope: 'full_access' },
    },
    {
      provider: 'resend',
      service: { credential: 'resend-legacy-admin', accountScope: 'full-access', status: 'planned' },
      identity: { accountScope: 'full_access' },
    },
    {
      provider: 'posthog',
      service: { credential: 'posthog-admin', origin: 'https://eu.posthog.com', organizationId: 'posthog-org', projectId: '42' },
      identity: { organizationId: 'posthog-org', projectId: '42' },
    },
  ] as const;

  for (const fixture of fixtures) {
    const secret = Buffer.from(`${fixture.provider}-secret-token`);
    try {
      const verified = await registry.require(fixture.provider).verify({
        project: 'sample', secret, service: fixture.service,
        signal: new AbortController().signal,
      });
      assert.deepEqual(verified.identity, fixture.identity, fixture.provider);
      assert.ok(verified.resources !== null, fixture.provider);
    } finally {
      secret.fill(0);
    }
  }
  assert.equal(seen.every((item) => item.authorization.startsWith('Bearer ')), true);
  assert.equal(seen.some((item) => item.authorization.includes('cloudflare-secret-token')), true);
});

test('accepts Cloudflare zone-name shorthand while preserving account identity pinning', async (context) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/client/v4/user/tokens/verify') {
      response.end('{"success":true,"result":{"id":"token-id","status":"active"}}');
    } else if (request.url?.startsWith('/client/v4/accounts?')) {
      response.end('{"success":true,"result":[{"id":"cf-account","name":"Sample"}],"result_info":{"page":1,"per_page":50,"total_count":1}}');
    } else if (request.url?.startsWith('/client/v4/zones?')) {
      response.end('{"success":true,"result":[{"id":"cf-zone","name":"example.test","account":{"id":"cf-account"}}],"result_info":{"page":1,"per_page":50,"total_count":1,"total_pages":1}}');
    } else {
      response.end('{"success":false,"result":null}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const registry = createProviderAdapterRegistry({
    transport: new FetchHttpTransport({ allowedOrigins: [origin], allowInsecureLoopback: true }),
    originOverrides: { cloudflare: origin },
  });
  const secret = Buffer.from('cloudflare-secret-token');
  try {
    const result = await registry.require('cloudflare').verify({
      project: 'sample', secret,
      service: { credential: 'cf-admin', accountId: 'cf-account', zones: ['example.test'] },
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, {
      identity: { accountId: 'cf-account' },
      resources: { tokenId: 'token-id', zones: [{ id: 'cf-zone', name: 'example.test' }] },
    });
  } finally {
    secret.fill(0);
  }
});

test('finds the pinned Cloudflare account beyond the first result page', async (context) => {
  const seenPages: number[] = [];
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/client/v4/user/tokens/verify') {
      response.end('{"success":true,"result":{"id":"token-id","status":"active"}}');
      return;
    }
    if (request.url?.startsWith('/client/v4/accounts?')) {
      const page = Number(new URL(request.url, 'http://localhost').searchParams.get('page') ?? '1');
      seenPages.push(page);
      const account = page === 1
        ? { id: 'other-account', name: 'Other' }
        : { id: 'cf-account', name: 'Sample' };
      response.end(JSON.stringify({
        success: true, result: [account],
        result_info: { page, per_page: 1, total_count: 2 },
      }));
      return;
    }
    if (request.url?.startsWith('/client/v4/zones?')) {
      response.end('{"success":true,"result":[],"result_info":{"page":1,"per_page":50,"total_count":0,"total_pages":1}}');
      return;
    }
    response.end('{"success":false,"result":null}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const registry = createProviderAdapterRegistry({
    transport: new FetchHttpTransport({ allowedOrigins: [origin], allowInsecureLoopback: true }),
    originOverrides: { cloudflare: origin },
  });
  const secret = Buffer.from('cloudflare-secret-token');
  try {
    const result = await registry.require('cloudflare').verify({
      project: 'sample', secret,
      service: { credential: 'cf-admin', accountId: 'cf-account', zones: [] },
      signal: new AbortController().signal,
    });
    assert.deepEqual(result.identity, { accountId: 'cf-account' });
    assert.deepEqual(seenPages, [1, 2]);
  } finally {
    secret.fill(0);
  }
});

test('finds a pinned Cloudflare zone beyond the first result page', async (context) => {
  const seenPages: number[] = [];
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/client/v4/user/tokens/verify') {
      response.end('{"success":true,"result":{"id":"token-id","status":"active"}}');
      return;
    }
    if (request.url?.startsWith('/client/v4/accounts?')) {
      response.end('{"success":true,"result":[{"id":"cf-account","name":"Sample"}],"result_info":{"page":1,"per_page":50,"total_count":1}}');
      return;
    }
    if (request.url?.startsWith('/client/v4/zones?')) {
      const page = Number(new URL(request.url, 'http://localhost').searchParams.get('page') ?? '1');
      seenPages.push(page);
      const zone = page === 1
        ? { id: 'other-zone', name: 'other.test', account: { id: 'cf-account' } }
        : { id: 'target-zone', name: 'target.test', account: { id: 'cf-account' } };
      response.end(JSON.stringify({
        success: true, result: [zone],
        result_info: { page, per_page: 1, total_count: 2, total_pages: 2 },
      }));
      return;
    }
    response.end('{"success":false,"result":null}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const registry = createProviderAdapterRegistry({
    transport: new FetchHttpTransport({ allowedOrigins: [origin], allowInsecureLoopback: true }),
    originOverrides: { cloudflare: origin },
  });
  const secret = Buffer.from('cloudflare-secret-token');
  try {
    const result = await registry.require('cloudflare').verify({
      project: 'sample', secret,
      service: { credential: 'cf-admin', accountId: 'cf-account', zones: ['target.test'] },
      signal: new AbortController().signal,
    });
    assert.deepEqual(result.resources, {
      tokenId: 'token-id',
      zones: [{ id: 'other-zone', name: 'other.test' }, { id: 'target-zone', name: 'target.test' }],
    });
    assert.deepEqual(seenPages, [1, 2]);
  } finally {
    secret.fill(0);
  }
});

test('classifies unsuccessful or malformed Cloudflare envelopes as provider failures', async (context) => {
  let zoneBody = '{"success":false,"errors":[{"code":1000,"message":"rejected"}],"result":null}';
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/client/v4/user/tokens/verify') {
      response.end('{"success":true,"result":{"id":"token-id","status":"active"}}');
    } else if (request.url?.startsWith('/client/v4/accounts?')) {
      response.end('{"success":true,"result":[{"id":"cf-account","name":"Sample"}]}');
    } else if (request.url?.startsWith('/client/v4/zones?')) {
      response.end(zoneBody);
    } else {
      response.end('{"success":false,"result":null}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const registry = createProviderAdapterRegistry({
    transport: new FetchHttpTransport({ allowedOrigins: [origin], allowInsecureLoopback: true }),
    originOverrides: { cloudflare: origin },
  });
  const secret = Buffer.from('cloudflare-secret-token');
  const verify = () => registry.require('cloudflare').verify({
    project: 'sample', secret,
    service: { credential: 'cf-admin', accountId: 'cf-account', zones: [] },
    signal: new AbortController().signal,
  });
  try {
    await assert.rejects(verify(), (error: unknown) => (
      error instanceof InframuxError && error.code === 'PROVIDER_UNAVAILABLE'
    ));
    zoneBody = '{"success":true,"result":"not-an-array"}';
    await assert.rejects(verify(), (error: unknown) => (
      error instanceof InframuxError && error.code === 'PROVIDER_UNAVAILABLE'
    ));
  } finally {
    secret.fill(0);
  }
});

test('fails enrollment when an accessible provider account does not match the catalog', async (context) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/client/v4/user/tokens/verify') {
      response.end('{"success":true,"result":{"id":"token-id","status":"active"}}');
    } else if (request.url?.startsWith('/client/v4/accounts')) {
      response.end('{"success":true,"result":[{"id":"another-account","name":"Wrong"}]}');
    } else response.end('{"success":true,"result":[]}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const registry = createProviderAdapterRegistry({
    transport: new FetchHttpTransport({ allowedOrigins: [origin], allowInsecureLoopback: true }),
    originOverrides: { cloudflare: origin },
  });
  const secret = Buffer.from('wrong-account-token');
  try {
    await assert.rejects(
      registry.require('cloudflare').verify({
        project: 'sample', secret,
        service: { credential: 'cf-admin', accountId: 'cf-account', zones: [{ name: 'example.test' }] },
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof InframuxError && error.code === 'WRONG_PROVIDER_IDENTITY' && /account/i.test(error.message),
    );
  } finally {
    secret.fill(0);
  }
});

test('exposes complete API coverage only through a provider-pinned relative request', async (context) => {
  let observed: { method: string; url: string; idempotencyKey?: string; body: string } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const idempotencyHeader = request.headers['idempotency-key'];
    observed = {
      method: request.method ?? '', url: request.url ?? '',
      ...(idempotencyHeader === undefined ? {} : { idempotencyKey: Array.isArray(idempotencyHeader) ? idempotencyHeader[0] ?? '' : idempotencyHeader }),
      body: Buffer.concat(chunks).toString('utf8'),
    };
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end('{"result":{"id":"new-resource"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const registry = createProviderAdapterRegistry({
    transport: new FetchHttpTransport({ allowedOrigins: [origin], allowInsecureLoopback: true }),
    originOverrides: { cloudflare: origin },
  });
  const secret = Buffer.from('cloudflare-secret-token');
  try {
    const result = await registry.require('cloudflare').call({
      project: 'sample', secret,
      service: { credential: 'cf-admin', accountId: 'cf-account' },
      operation: 'api.request',
      input: {
        method: 'POST', path: '/client/v4/accounts/cf-account/storage/kv/namespaces',
        body: { title: 'agent-created' }, idempotencyKey: 'create-namespace-018f',
      },
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, { status: 201, body: { result: { id: 'new-resource' } }, rateLimit: {} });
    assert.deepEqual(observed, {
      method: 'POST', url: '/client/v4/accounts/cf-account/storage/kv/namespaces',
      idempotencyKey: 'create-namespace-018f', body: '{"title":"agent-created"}',
    });
    await assert.rejects(
      registry.require('cloudflare').call({
        project: 'sample', secret,
        service: { credential: 'cf-admin', accountId: 'cf-account' },
        operation: 'api.request',
        input: { method: 'GET', path: 'https://evil.example/steal' },
        signal: new AbortController().signal,
      }),
      /relative API path/,
    );
  } finally {
    secret.fill(0);
  }
});

function route(url: string): unknown {
  if (url === '/client/v4/user/tokens/verify') return { success: true, result: { id: 'token-id', status: 'active' } };
  if (url.startsWith('/client/v4/accounts?')) return { success: true, result: [{ id: 'cf-account', name: 'Sample' }] };
  if (url.startsWith('/client/v4/zones?')) return { success: true, result: [{ id: 'cf-zone', name: 'example.test', account: { id: 'cf-account' } }] };
  if (url === '/v2/user') return { user: { id: 'vercel-user', username: 'samplebot-4021', email: 'bot@example.test' } };
  if (url.startsWith('/v2/teams?')) return { teams: [{ id: 'vercel-team', slug: 'sample' }], pagination: { count: 1 } };
  if (url.startsWith('/v9/projects/vercel-project?')) return { id: 'vercel-project', name: 'sample-admin-panel', accountId: 'vercel-team' };
  if (url.startsWith('/v9/projects/vercel-project/domains?')) return { domains: [{ name: 'app.example.test', verified: true }] };
  if (url === '/v1/organizations') return [{ id: 'supabase-org', slug: 'example-org', name: 'Sample' }];
  if (url === '/v1/projects') return [{ id: 'supabase-project', ref: 'supabase-project', organization_id: 'supabase-org', name: 'sample_admin_panel' }];
  if (url === '/api/0/organizations/sentry-org/') return { id: 'sentry-id', slug: 'sentry-org', links: { regionUrl: 'https://de.sentry.io' } };
  if (url === '/api/0/organizations/sentry-org/projects/') return [
    { id: '1', slug: 'sample-admin-panel' }, { id: '2', slug: 'sample-streamer' },
    { id: '3', slug: 'sample-streamer-supervisor' },
  ];
  if (url.startsWith('/v3/monitors?')) return { data: [
    { id: 100000001, friendly_name: 'Website' }, { id: 100000002, friendly_name: 'Admin' },
  ], pagination: { next: null } };
  if (url === '/api-keys') return { object: 'list', has_more: false, data: [{ id: 'resend-key', name: 'inframux' }] };
  if (url === '/domains') return { object: 'list', has_more: false, data: [] };
  if (url === '/api/users/@me/') return {
    id: 7, uuid: 'posthog-user', organization: { id: 'posthog-org' }, team: { id: 42, name: 'Sample' },
  };
  return { error: `unhandled ${url}` };
}
