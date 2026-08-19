import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { InframuxError } from '../../src/core/errors.js';
import { googleAdapter } from '../../src/providers/adapters/google.js';
import { exchangeGoogleAuthorizationCode, refreshGoogleCredential } from '../../src/providers/google-oauth.js';
import { FetchHttpTransport } from '../../src/providers/http-transport.js';
import { decodeOAuthCredential, encodeOAuthCredential, type OAuthCredential } from '../../src/providers/oauth.js';

const scopes = [
  'email', 'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/drive',
];

test('exchanges and refreshes a Google Desktop PKCE credential with exact granted scopes', async (context) => {
  const forms: URLSearchParams[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    forms.push(form);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (form.get('grant_type') === 'authorization_code') {
      response.end(JSON.stringify({
        access_token: 'google-access-one', refresh_token: 'google-refresh-one',
        expires_in: 3600, token_type: 'Bearer', scope: scopes.join(' '),
      }));
    } else {
      response.end(JSON.stringify({
        access_token: 'google-access-two', refresh_token: 'google-refresh-two',
        expires_in: 3600, token_type: 'Bearer', scope: scopes.join(' '),
      }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const tokenEndpoint = `http://127.0.0.1:${address.port}/token`;
  const credential = await exchangeGoogleAuthorizationCode({
    tokenEndpoint, allowInsecureLoopbackEndpoint: true,
    clientId: 'desktop-client.apps.googleusercontent.com',
    clientSecret: 'desktop-public-client-secret',
    code: 'one-time-code', codeVerifier: 'v'.repeat(64),
    redirectUri: 'http://127.0.0.1:49152/oauth/callback',
    requiredScopes: scopes,
    now: () => Date.parse('2026-08-18T01:00:00.000Z'),
    signal: new AbortController().signal,
  });
  assert.equal(credential.accessToken, 'google-access-one');
  assert.equal(credential.refreshToken, 'google-refresh-one');
  assert.equal(credential.expiresAt, '2026-08-18T02:00:00.000Z');
  assert.deepEqual(forms[0] === undefined ? {} : Object.fromEntries(forms[0]), {
    client_id: 'desktop-client.apps.googleusercontent.com',
    client_secret: 'desktop-public-client-secret',
    code: 'one-time-code', code_verifier: 'v'.repeat(64),
    grant_type: 'authorization_code',
    redirect_uri: 'http://127.0.0.1:49152/oauth/callback',
  });

  const refreshed = await refreshGoogleCredential(credential, {
    tokenEndpoint, allowInsecureLoopbackEndpoint: true,
    clientSecret: 'desktop-public-client-secret',
    signal: new AbortController().signal,
  });
  assert.equal(refreshed.accessToken, 'google-access-two');
  assert.equal(refreshed.refreshToken, 'google-refresh-two');
  assert.deepEqual(forms[1] === undefined ? {} : Object.fromEntries(forms[1]), {
    client_id: 'desktop-client.apps.googleusercontent.com',
    client_secret: 'desktop-public-client-secret',
    grant_type: 'refresh_token', refresh_token: 'google-refresh-one',
  });
});

test('verifies the exact Google account and routes only registered Google APIs', async (context) => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url ?? '');
    assert.equal(request.headers.authorization, 'Bearer google-access-token');
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/userinfo') {
      response.end('{"sub":"google-user-1","email":"maintainer@example.test","email_verified":true}');
    } else if (request.url === '/v1/projects?pageSize=100') {
      response.end('{"projects":[{"projectId":"sample-cloud","displayName":"Sample"}]}');
    } else if (request.url === '/gmail/v1/users/me/profile') {
      response.end('{"emailAddress":"maintainer@example.test","messagesTotal":12}');
    } else response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = new FetchHttpTransport({ allowedOrigins: [origin], allowInsecureLoopback: true });
  const adapter = googleAdapter(transport, {
    userinfo: { origin, path: '/userinfo' },
    cloudresourcemanager: { origin, prefix: '' },
    gmail: { origin, prefix: '' },
  });
  const credential: OAuthCredential = {
    schema: 1, kind: 'oauth2', accessToken: 'google-access-token', refreshToken: 'google-refresh-token',
    tokenType: 'Bearer', expiresAt: '2099-08-18T02:00:00.000Z', scopes,
    clientId: 'desktop-client.apps.googleusercontent.com',
    tokenEndpoint: 'https://oauth2.googleapis.com/token', revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  };
  const secret = encodeOAuthCredential(credential);
  try {
    const verified = await adapter.verify({
      project: 'sample', secret,
      service: { credential: 'google-admin', account: 'maintainer@example.test', projects: ['sample-cloud'], scopes },
      signal: new AbortController().signal,
    });
    assert.deepEqual(verified.identity, { account: 'maintainer@example.test' });
    assert.deepEqual(verified.resources, { accountSubject: 'google-user-1', projects: [{ id: 'sample-cloud', name: 'Sample' }] });
    const result = await adapter.call({
      project: 'sample', secret,
      service: { credential: 'google-admin', account: 'maintainer@example.test', scopes },
      operation: 'api.request',
      input: { api: 'gmail', method: 'GET', path: '/gmail/v1/users/me/profile' },
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, { status: 200, body: { emailAddress: 'maintainer@example.test', messagesTotal: 12 }, rateLimit: {} });
    await assert.rejects(
      adapter.call({
        project: 'sample', secret,
        service: { credential: 'google-admin', account: 'maintainer@example.test', scopes },
        operation: 'api.request',
        input: { api: 'attacker', method: 'GET', path: '/steal' },
        signal: new AbortController().signal,
      }),
      /registered Google API/,
    );
  } finally {
    secret.fill(0);
  }
  assert.deepEqual(seen, ['/userinfo', '/v1/projects?pageSize=100', '/gmail/v1/users/me/profile']);
});

test('rejects a valid Google credential for another account before storing it', async (context) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/userinfo') response.end('{"sub":"other","email":"other@example.test","email_verified":true}');
    else response.end('{"projects":[]}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const adapter = googleAdapter(
    new FetchHttpTransport({ allowedOrigins: [origin], allowInsecureLoopback: true }),
    { userinfo: { origin, path: '/userinfo' }, cloudresourcemanager: { origin, prefix: '' } },
  );
  const secret = encodeOAuthCredential({
    schema: 1, kind: 'oauth2', accessToken: 'google-access-token', refreshToken: 'google-refresh-token',
    tokenType: 'Bearer', expiresAt: '2099-08-18T02:00:00.000Z', scopes,
    clientId: 'desktop-client', tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  });
  try {
    await assert.rejects(
      adapter.verify({
        project: 'sample', secret,
        service: { credential: 'google-admin', account: 'maintainer@example.test', scopes },
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof InframuxError && error.code === 'WRONG_PROVIDER_IDENTITY',
    );
  } finally {
    secret.fill(0);
  }
});

test('keeps OAuth envelope parsing strict after network operations', () => {
  const credential: OAuthCredential = {
    schema: 1, kind: 'oauth2', accessToken: 'google-access-token', refreshToken: 'google-refresh-token',
    tokenType: 'Bearer', expiresAt: '2099-08-18T02:00:00.000Z', scopes,
    clientId: 'desktop-client', tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  };
  const encoded = encodeOAuthCredential(credential);
  assert.deepEqual(decodeOAuthCredential(encoded), { ...credential, scopes: [...scopes].sort() });
  encoded.fill(0);
});
