import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authorizeGoogleDesktop } from '../../src/cli/google-desktop-auth.js';
import { decodeOAuthCredential, type OAuthCredential } from '../../src/providers/oauth.js';

test('completes Google Desktop PKCE on random loopback without exposing the credential', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-google-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clientFile = path.join(root, 'client.json');
  await writeFile(clientFile, JSON.stringify({
    installed: {
      client_id: 'desktop-client.apps.googleusercontent.com',
      client_secret: 'desktop-client-secret',
      auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      redirect_uris: ['http://localhost'],
    },
  }));
  let exchangeInput: { code: string; codeVerifier: string; redirectUri: string } | undefined;
  const credential: OAuthCredential = {
    schema: 1, kind: 'oauth2', accessToken: 'google-access-token', refreshToken: 'google-refresh-token',
    tokenType: 'Bearer', expiresAt: '2026-08-18T12:00:00.000Z', scopes: ['email', 'openid'],
    clientId: 'desktop-client.apps.googleusercontent.com', clientSecret: 'desktop-client-secret',
    tokenEndpoint: 'https://oauth2.googleapis.com/token', revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  };
  const encoded = await authorizeGoogleDesktop({
    clientFile,
    scopes: ['openid', 'email'],
    loginHint: 'maintainer@example.test',
    signal: new AbortController().signal,
    timeoutMs: 5_000,
  }, {
    openUrl: async (authorizationUrl) => {
      const authorization = new URL(authorizationUrl);
      assert.equal(authorization.origin, 'https://accounts.google.com');
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorization.searchParams.get('access_type'), 'offline');
      assert.equal(authorization.searchParams.get('prompt'), 'consent');
      assert.equal(authorization.searchParams.get('login_hint'), 'maintainer@example.test');
      const redirect = authorization.searchParams.get('redirect_uri');
      const state = authorization.searchParams.get('state');
      assert.ok(redirect);
      assert.ok(state);
      const wrong = await fetch(`${redirect}?code=auth-code&state=wrong`);
      assert.equal(wrong.status, 400);
      const accepted = await fetch(`${redirect}?code=auth-code&state=${state}`);
      assert.equal(accepted.status, 200);
    },
    exchange: async (input) => {
      exchangeInput = { code: input.code, codeVerifier: input.codeVerifier, redirectUri: input.redirectUri };
      return credential;
    },
  });
  try {
    assert.equal(decodeOAuthCredential(encoded).refreshToken, 'google-refresh-token');
  } finally {
    encoded.fill(0);
  }
  assert.equal(exchangeInput?.code, 'auth-code');
  assert.match(exchangeInput?.redirectUri ?? '', /^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/);
  assert.ok((exchangeInput?.codeVerifier.length ?? 0) >= 43);
});

test('times out without a callback and never accepts a symlinked client file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-google-auth-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.json');
  const linked = path.join(root, 'linked.json');
  await writeFile(source, '{}');
  const { symlink } = await import('node:fs/promises');
  await symlink(source, linked);
  await assert.rejects(authorizeGoogleDesktop({
    clientFile: linked, scopes: ['openid'], signal: new AbortController().signal, timeoutMs: 100,
  }, { openUrl: async () => undefined }), /symbolic link/i);
});
