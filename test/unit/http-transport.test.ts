import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { InframuxError } from '../../src/core/errors.js';
import { FetchHttpTransport, validateApiRequestInput } from '../../src/providers/http-transport.js';

test('pins requests to an enrolled origin and rejects URL/header escape hatches', () => {
  assert.throws(
    () => validateApiRequestInput({ method: 'GET', path: 'https://evil.example/steal' }),
    /relative API path/,
  );
  assert.throws(
    () => validateApiRequestInput({ method: 'GET', path: '/v1/../tokens' }),
    /path segment/,
  );
  assert.throws(
    () => validateApiRequestInput({ method: 'GET', path: '/v1/resources', headers: { authorization: 'stolen' } } as never),
    /unrecognized key/i,
  );
  assert.deepEqual(validateApiRequestInput({
    method: 'POST',
    path: '/v1/resources',
    query: { page: '1', tags: ['one', 'two'] },
    body: { enabled: true },
    idempotencyKey: '018f47d2-safe-retry',
  }), {
    method: 'POST',
    path: '/v1/resources',
    query: { page: '1', tags: ['one', 'two'] },
    body: { enabled: true },
    idempotencyKey: '018f47d2-safe-retry',
  });
});

test('performs one bounded JSON request without following credential-bearing redirects', async (context) => {
  const requests: Array<{ url: string; authorization?: string; userAgent?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url ?? '',
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
      ...(request.headers['user-agent'] === undefined ? {} : { userAgent: request.headers['user-agent'] }),
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'https://evil.example/steal' }).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining': '9' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = new FetchHttpTransport({
    allowedOrigins: [origin],
    allowInsecureLoopback: true,
    maxRequestBytes: 1024,
    maxResponseBytes: 1024,
    timeoutMs: 2_000,
  });

  const result = await transport.request({
    origin,
    method: 'POST',
    path: '/v1/resources',
    query: { page: '1' },
    headers: {
      authorization: 'Bearer test-secret-value',
      'user-agent': 'inframux-test/1',
    },
    body: { name: 'safe' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, {
    status: 200,
    body: { ok: true },
    rateLimit: { remaining: '9' },
  });
  assert.deepEqual(requests[0], {
    url: '/v1/resources?page=1',
    authorization: 'Bearer test-secret-value',
    userAgent: 'inframux-test/1',
    body: '{"name":"safe"}',
  });

  await assert.rejects(
    transport.request({
      origin,
      method: 'GET',
      path: '/redirect',
      headers: { authorization: 'Bearer test-secret-value' },
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof InframuxError && error.code === 'PROVIDER_UNAVAILABLE' && /redirect/.test(error.message),
  );
  assert.equal(requests.length, 2);
});

test('maps authentication, scope, throttling, malformed JSON and response bounds fail-closed', async (context) => {
  const server = createServer((request, response) => {
    if (request.url === '/unauthorized') return void response.writeHead(401).end('{"error":"bad token"}');
    if (request.url === '/forbidden') return void response.writeHead(403).end('{"error":"scope"}');
    if (request.url === '/limited') return void response.writeHead(429, { 'retry-after': '3' }).end('{"error":"slow"}');
    if (request.url === '/invalid') return void response.writeHead(200, { 'content-type': 'application/json' }).end('not-json');
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: 'x'.repeat(2_000) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = new FetchHttpTransport({
    allowedOrigins: [origin], allowInsecureLoopback: true,
    maxRequestBytes: 128, maxResponseBytes: 256, timeoutMs: 2_000,
  });
  const expected = new Map([
    ['/unauthorized', 'TOKEN_EXPIRED'],
    ['/forbidden', 'SCOPE_MISSING'],
    ['/limited', 'RATE_LIMITED'],
    ['/invalid', 'PROVIDER_UNAVAILABLE'],
    ['/large', 'OUTPUT_LIMIT_EXCEEDED'],
  ]);
  for (const [path, code] of expected) {
    await assert.rejects(
      transport.request({ origin, method: 'GET', path, headers: {}, signal: new AbortController().signal }),
      (error: unknown) => error instanceof InframuxError && error.code === code,
      path,
    );
  }
  await assert.rejects(
    transport.request({
      origin, method: 'POST', path: '/large', headers: {},
      body: { data: 'x'.repeat(200) }, signal: new AbortController().signal,
    }),
    /request body exceeds/i,
  );
});
