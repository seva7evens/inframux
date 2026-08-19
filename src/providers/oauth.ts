import { createHash, randomBytes as secureRandomBytes } from 'node:crypto';
import { z } from 'zod';

import { InframuxError } from '../core/errors.js';
import { KeyedLock } from '../security/locks.js';

const oauthCredentialSchema = z.object({
  schema: z.literal(1),
  kind: z.literal('oauth2'),
  accessToken: z.string().min(8).max(128 * 1024),
  refreshToken: z.string().min(8).max(128 * 1024),
  tokenType: z.literal('Bearer'),
  expiresAt: z.iso.datetime({ offset: true }),
  scopes: z.array(z.string().min(1).max(2_048)).min(1).max(512),
  clientId: z.string().min(3).max(4_096),
  clientSecret: z.string().min(3).max(128 * 1024).optional(),
  tokenEndpoint: z.url(),
  revokeEndpoint: z.url(),
}).strict().superRefine((value, context) => {
  for (const [field, endpoint] of [['tokenEndpoint', value.tokenEndpoint], ['revokeEndpoint', value.revokeEndpoint]] as const) {
    if (new URL(endpoint).protocol !== 'https:') context.addIssue({ code: 'custom', path: [field], message: `${field} must use HTTPS` });
  }
  if (new Set(value.scopes).size !== value.scopes.length) context.addIssue({ code: 'custom', path: ['scopes'], message: 'OAuth scopes must be unique' });
});

export type OAuthCredential = z.infer<typeof oauthCredentialSchema>;

export interface OAuthRefreshResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: 'Bearer';
  readonly expiresInSeconds: number;
  readonly scopes: readonly string[];
}

export function encodeOAuthCredential(input: OAuthCredential): Buffer {
  const credential = normalizeCredential(input);
  return Buffer.from(`${JSON.stringify(credential)}\n`);
}

export function decodeOAuthCredential(input: Uint8Array): OAuthCredential {
  if (input.byteLength > 512 * 1024) throw new Error('OAuth credential envelope exceeds limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input).toString('utf8'));
  } catch (error) {
    throw new Error('OAuth credential envelope is not valid JSON', { cause: error });
  }
  return normalizeCredential(oauthCredentialSchema.parse(parsed));
}

export function createPkceAuthorization(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  loginHint?: string;
  randomBytes?: (length: number) => Uint8Array;
}): {
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly state: string;
} {
  const endpoint = new URL(input.authorizationEndpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') throw new Error('OAuth authorization endpoint must use HTTPS');
  const redirect = validateLoopbackRedirect(input.redirectUri);
  const scopes = normalizeScopes(input.scopes);
  const generator = input.randomBytes ?? secureRandomBytes;
  const codeVerifier = Buffer.from(generator(64)).toString('base64url');
  const state = Buffer.from(generator(32)).toString('base64url');
  if (codeVerifier.length < 43 || codeVerifier.length > 128) throw new Error('OAuth PKCE verifier has invalid length');
  endpoint.searchParams.set('client_id', z.string().min(3).max(4_096).parse(input.clientId));
  endpoint.searchParams.set('redirect_uri', redirect.href);
  endpoint.searchParams.set('response_type', 'code');
  endpoint.searchParams.set('scope', scopes.join(' '));
  endpoint.searchParams.set('state', state);
  endpoint.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
  endpoint.searchParams.set('code_challenge_method', 'S256');
  endpoint.searchParams.set('access_type', 'offline');
  endpoint.searchParams.set('include_granted_scopes', 'true');
  if (input.loginHint !== undefined) endpoint.searchParams.set('login_hint', z.string().email().max(320).parse(input.loginHint));
  return Object.freeze({ authorizationUrl: endpoint.href, codeVerifier, state });
}

export function validateOAuthCallback(
  callbackUrl: string,
  expected: { readonly redirectUri: string; readonly state: string },
): { readonly code: string } {
  const callback = new URL(callbackUrl);
  const redirect = validateLoopbackRedirect(expected.redirectUri);
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.hash !== '') {
    throw new Error('OAuth callback does not match the enrolled loopback redirect');
  }
  if (callback.searchParams.get('state') !== expected.state) throw new Error('OAuth callback state mismatch');
  const providerError = callback.searchParams.get('error');
  if (providerError !== null) throw new InframuxError('OAUTH_REFRESH_FAILED', `OAuth authorization failed: ${providerError}`);
  const code = callback.searchParams.get('code');
  if (code === null || code.length < 3 || code.length > 16_384) throw new Error('OAuth callback is missing a valid authorization code');
  return Object.freeze({ code });
}

export class OAuthTokenManager {
  readonly #now: () => number;
  readonly #load: (key: string) => Promise<OAuthCredential>;
  readonly #save: (key: string, value: OAuthCredential) => Promise<void>;
  readonly #refresh: (key: string, current: OAuthCredential) => Promise<OAuthRefreshResult>;
  readonly #locks = new KeyedLock();
  readonly #refreshSkewMs: number;

  constructor(options: {
    now?: () => number;
    load: (key: string) => Promise<OAuthCredential>;
    save: (key: string, value: OAuthCredential) => Promise<void>;
    refresh: (key: string, current: OAuthCredential) => Promise<OAuthRefreshResult>;
    refreshSkewMs?: number;
  }) {
    this.#now = options.now ?? Date.now;
    this.#load = options.load;
    this.#save = options.save;
    this.#refresh = options.refresh;
    this.#refreshSkewMs = options.refreshSkewMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.#refreshSkewMs) || this.#refreshSkewMs < 0) throw new Error('Invalid OAuth refresh skew');
  }

  async withAccessToken<T>(
    key: string,
    requiredScopes: readonly string[],
    operation: (accessToken: Buffer) => Promise<T>,
  ): Promise<T> {
    if (!/^[a-z][a-z0-9-]{1,126}\/[a-z][a-z0-9-]{1,126}$/.test(key)) throw new Error('Invalid OAuth credential key');
    const required = normalizeScopes(requiredScopes);
    return this.#locks.run(key, async () => {
      let credential = normalizeCredential(await this.#load(key));
      assertScopes(credential.scopes, required);
      if (Date.parse(credential.expiresAt) - this.#now() <= this.#refreshSkewMs) {
        let refreshed: OAuthRefreshResult;
        try {
          refreshed = await this.#refresh(key, credential);
        } catch (error) {
          throw new InframuxError('OAUTH_REFRESH_FAILED', 'OAuth refresh failed and requires interactive reauthorization', {
            cause: error,
            recovery: `inframux reauthorize ${key.split('/')[1] ?? 'provider'}`,
          });
        }
        const scopes = normalizeScopes(refreshed.scopes);
        assertScopes(scopes, required);
        if (!Number.isSafeInteger(refreshed.expiresInSeconds) || refreshed.expiresInSeconds < 60 || refreshed.expiresInSeconds > 31_536_000) {
          throw new InframuxError('OAUTH_REFRESH_FAILED', 'OAuth provider returned an invalid token lifetime');
        }
        credential = normalizeCredential({
          ...credential,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? credential.refreshToken,
          tokenType: refreshed.tokenType,
          scopes,
          expiresAt: new Date(this.#now() + refreshed.expiresInSeconds * 1_000).toISOString(),
        });
        await this.#save(key, credential);
      }
      const accessToken = Buffer.from(credential.accessToken);
      try {
        return await operation(accessToken);
      } finally {
        accessToken.fill(0);
      }
    });
  }
}

function normalizeCredential(input: OAuthCredential): OAuthCredential {
  const parsed = oauthCredentialSchema.parse(input);
  return Object.freeze({ ...parsed, scopes: normalizeScopes(parsed.scopes) });
}

function normalizeScopes(input: readonly string[]): string[] {
  const scopes = z.array(z.string().trim().min(1).max(2_048)).min(1).max(512).parse(input);
  const unique = [...new Set(scopes)].sort();
  if (unique.length !== scopes.length) throw new Error('OAuth scopes must be unique');
  return unique;
}

function assertScopes(granted: readonly string[], required: readonly string[]): void {
  const actual = new Set(granted);
  const missing = required.filter((scope) => !actual.has(scope));
  if (missing.length > 0) {
    throw new InframuxError('SCOPE_MISSING', 'OAuth credential lacks required scopes', {
      details: { missingScopes: missing },
    });
  }
}

function validateLoopbackRedirect(value: string): URL {
  const redirect = new URL(value);
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.port === '' ||
      redirect.username !== '' || redirect.password !== '' || redirect.search !== '' || redirect.hash !== '') {
    throw new Error('OAuth desktop redirect must be an exact 127.0.0.1 loopback URL with a random port');
  }
  return redirect;
}
