import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { InframuxError } from '../../src/core/errors.js';
import {
  OAuthTokenManager,
  createPkceAuthorization,
  decodeOAuthCredential,
  encodeOAuthCredential,
  validateOAuthCallback,
  type OAuthCredential,
} from '../../src/providers/oauth.js';

test('creates an RFC7636 S256 authorization and validates the exact loopback callback state', () => {
  const authorization = createPkceAuthorization({
    authorizationEndpoint: 'https://accounts.example.test/o/oauth2/v2/auth',
    clientId: 'desktop-client.apps.exampleusercontent.com',
    redirectUri: 'http://127.0.0.1:49152/oauth/callback',
    scopes: ['openid', 'email', 'scope.admin'],
    loginHint: 'owner@example.test',
    randomBytes: (length) => Buffer.alloc(length, 7),
  });
  const url = new URL(authorization.authorizationUrl);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(authorization.codeVerifier).digest('base64url'),
  );
  assert.equal(url.searchParams.get('state'), authorization.state);
  assert.equal(url.searchParams.get('scope'), 'email openid scope.admin');
  assert.equal(url.searchParams.get('login_hint'), 'owner@example.test');
  assert.deepEqual(validateOAuthCallback(
    `http://127.0.0.1:49152/oauth/callback?state=${authorization.state}&code=one-time-code`,
    { redirectUri: 'http://127.0.0.1:49152/oauth/callback', state: authorization.state },
  ), { code: 'one-time-code' });
  assert.throws(
    () => validateOAuthCallback(
      'http://127.0.0.1:49152/oauth/callback?state=attacker&code=stolen',
      { redirectUri: 'http://127.0.0.1:49152/oauth/callback', state: authorization.state },
    ),
    /state mismatch/i,
  );
});

test('round-trips a strict OAuth envelope without accepting missing refresh or granted scopes', () => {
  const credential: OAuthCredential = {
    schema: 1,
    kind: 'oauth2',
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    tokenType: 'Bearer',
    expiresAt: '2026-08-18T02:00:00.000Z',
    scopes: ['email', 'openid'],
    clientId: 'desktop-client',
    tokenEndpoint: 'https://oauth2.example.test/token',
    revokeEndpoint: 'https://oauth2.example.test/revoke',
  };
  const encoded = encodeOAuthCredential(credential);
  assert.deepEqual(decodeOAuthCredential(encoded), credential);
  encoded.fill(0);
  assert.throws(
    () => decodeOAuthCredential(Buffer.from(JSON.stringify({ ...credential, refreshToken: '' }))),
    /refreshToken/i,
  );
  assert.throws(
    () => decodeOAuthCredential(Buffer.from(JSON.stringify({ ...credential, scopes: [] }))),
    /scopes/i,
  );
});

test('collapses concurrent refresh, atomically saves rotated refresh data and rejects missing scopes', async () => {
  let stored: OAuthCredential = {
    schema: 1, kind: 'oauth2', accessToken: 'expired-access', refreshToken: 'refresh-one',
    tokenType: 'Bearer', expiresAt: '2026-08-18T00:00:00.000Z', scopes: ['email', 'scope.admin'],
    clientId: 'desktop-client', tokenEndpoint: 'https://oauth2.example.test/token',
    revokeEndpoint: 'https://oauth2.example.test/revoke',
  };
  let refreshes = 0;
  let saves = 0;
  const seen: string[] = [];
  const manager = new OAuthTokenManager({
    now: () => Date.parse('2026-08-18T01:00:00.000Z'),
    load: async () => structuredClone(stored),
    save: async (_key, next) => { saves += 1; stored = structuredClone(next); },
    refresh: async (_key, current) => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(current.refreshToken, 'refresh-one');
      return {
        accessToken: 'fresh-access', refreshToken: 'refresh-two', tokenType: 'Bearer',
        expiresInSeconds: 3600, scopes: ['scope.admin', 'email'],
      };
    },
  });
  await Promise.all(Array.from({ length: 8 }, () => manager.withAccessToken(
    'sample/google', ['email', 'scope.admin'], async (token) => { seen.push(token.toString('utf8')); },
  )));
  assert.equal(refreshes, 1);
  assert.equal(saves, 1);
  assert.deepEqual(seen, Array.from({ length: 8 }, () => 'fresh-access'));
  assert.equal(stored.refreshToken, 'refresh-two');
  assert.equal(stored.expiresAt, '2026-08-18T02:00:00.000Z');

  await assert.rejects(
    manager.withAccessToken('sample/google', ['scope.not-granted'], async () => undefined),
    (error: unknown) => error instanceof InframuxError && error.code === 'SCOPE_MISSING',
  );
});

test('maps invalid_grant refresh failures to one explicit interactive reauthorization error', async () => {
  const credential: OAuthCredential = {
    schema: 1, kind: 'oauth2', accessToken: 'expired-access', refreshToken: 'revoked-refresh',
    tokenType: 'Bearer', expiresAt: '2026-08-18T00:00:00.000Z', scopes: ['email'],
    clientId: 'desktop-client', tokenEndpoint: 'https://oauth2.example.test/token',
    revokeEndpoint: 'https://oauth2.example.test/revoke',
  };
  let attempts = 0;
  const manager = new OAuthTokenManager({
    now: () => Date.parse('2026-08-18T01:00:00.000Z'),
    load: async () => credential,
    save: async () => assert.fail('revoked credential must not be saved'),
    refresh: async () => { attempts += 1; throw new Error('invalid_grant'); },
  });
  await assert.rejects(
    manager.withAccessToken('sample/google', ['email'], async () => undefined),
    (error: unknown) => error instanceof InframuxError && error.code === 'OAUTH_REFRESH_FAILED' && /reauthorize/.test(error.recovery ?? ''),
  );
  assert.equal(attempts, 1);
});
