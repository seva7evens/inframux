import { z } from 'zod';

import { InframuxError } from '../core/errors.js';
import { type OAuthCredential, type OAuthRefreshResult } from './oauth.js';

const tokenResponseSchema = z.object({
  access_token: z.string().min(8).max(128 * 1024),
  refresh_token: z.string().min(8).max(128 * 1024).optional(),
  expires_in: z.number().int().min(60).max(31_536_000),
  token_type: z.literal('Bearer'),
  scope: z.string().min(1).max(128 * 1024).optional(),
}).passthrough();

export async function exchangeGoogleAuthorizationCode(input: {
  readonly tokenEndpoint?: string;
  readonly allowInsecureLoopbackEndpoint?: boolean;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly requiredScopes: readonly string[];
  readonly now?: () => number;
  readonly signal: AbortSignal;
}): Promise<OAuthCredential> {
  const endpoint = input.tokenEndpoint ?? 'https://oauth2.googleapis.com/token';
  const form = new URLSearchParams({
    client_id: bounded(input.clientId, 'clientId'),
    code: bounded(input.code, 'authorization code'),
    code_verifier: z.string().min(43).max(128).parse(input.codeVerifier),
    grant_type: 'authorization_code',
    redirect_uri: loopbackRedirect(input.redirectUri),
  });
  if (input.clientSecret !== undefined) form.set('client_secret', bounded(input.clientSecret, 'clientSecret'));
  const response = await postTokenForm(endpoint, form, input.signal, input.allowInsecureLoopbackEndpoint ?? false);
  if (response.refresh_token === undefined) throw new InframuxError('OAUTH_REFRESH_FAILED', 'Google did not issue an offline refresh token');
  const scopes = parseAndRequireScopes(response.scope, input.requiredScopes);
  const now = input.now?.() ?? Date.now();
  return {
    schema: 1,
    kind: 'oauth2',
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    tokenType: response.token_type,
    expiresAt: new Date(now + response.expires_in * 1_000).toISOString(),
    scopes,
    clientId: input.clientId,
    ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
    tokenEndpoint: endpoint,
    revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  };
}

export async function refreshGoogleCredential(
  credential: OAuthCredential,
  options: {
    readonly tokenEndpoint?: string;
    readonly allowInsecureLoopbackEndpoint?: boolean;
    readonly clientSecret?: string;
    readonly signal: AbortSignal;
  },
): Promise<OAuthRefreshResult> {
  const endpoint = options.tokenEndpoint ?? credential.tokenEndpoint;
  const form = new URLSearchParams({
    client_id: credential.clientId,
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
  });
  const clientSecret = options.clientSecret ?? credential.clientSecret;
  if (clientSecret !== undefined) form.set('client_secret', bounded(clientSecret, 'clientSecret'));
  const response = await postTokenForm(endpoint, form, options.signal, options.allowInsecureLoopbackEndpoint ?? false);
  return {
    accessToken: response.access_token,
    ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
    tokenType: response.token_type,
    expiresInSeconds: response.expires_in,
    scopes: parseAndRequireScopes(response.scope, credential.scopes),
  };
}

async function postTokenForm(
  endpointValue: string,
  form: URLSearchParams,
  signal: AbortSignal,
  allowInsecureLoopback: boolean,
): Promise<z.infer<typeof tokenResponseSchema>> {
  const endpoint = new URL(endpointValue);
  const allowedInsecure = allowInsecureLoopback && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1';
  if (endpoint.protocol !== 'https:' && !allowedInsecure) throw new Error('Google OAuth token endpoint must use HTTPS');
  if (endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') throw new Error('Unsafe Google OAuth token endpoint');
  const timeout = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Google OAuth request cancelled');
    throw new InframuxError('PROVIDER_UNAVAILABLE', 'Google OAuth endpoint is unavailable', { cause: error });
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new InframuxError('OAUTH_REFRESH_FAILED', 'Google OAuth redirect was rejected');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    if (bytes.length > 512 * 1024) throw new InframuxError('OUTPUT_LIMIT_EXCEEDED', 'Google OAuth response exceeds limit');
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!response.ok) {
      const error = z.object({ error: z.string().optional(), error_description: z.string().optional() }).passthrough().safeParse(parsed);
      const reason = error.success ? error.data.error ?? `HTTP ${response.status}` : `HTTP ${response.status}`;
      throw new InframuxError('OAUTH_REFRESH_FAILED', `Google OAuth request failed: ${reason}`);
    }
    return tokenResponseSchema.parse(parsed);
  } catch (error) {
    if (error instanceof InframuxError) throw error;
    throw new InframuxError('OAUTH_REFRESH_FAILED', 'Google OAuth returned malformed token data', { cause: error });
  } finally {
    bytes.fill(0);
  }
}

function parseAndRequireScopes(value: string | undefined, requiredInput: readonly string[]): string[] {
  const required = [...new Set(requiredInput)].sort();
  const granted = value === undefined ? required : [...new Set(value.split(/\s+/u).filter(Boolean))].sort();
  const actual = new Set(granted);
  const missing = required.filter((scope) => !actual.has(scope));
  if (missing.length > 0) throw new InframuxError('SCOPE_MISSING', 'Google OAuth consent omitted required scopes', { details: { missingScopes: missing } });
  return granted;
}

function bounded(value: string, label: string): string {
  try {
    return z.string().min(3).max(128 * 1024).parse(value);
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
}

function loopbackRedirect(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || url.search !== '' || url.hash !== '') {
    throw new Error('Google Desktop OAuth requires an exact 127.0.0.1 loopback redirect');
  }
  return url.href;
}
