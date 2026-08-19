import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { z } from 'zod';

import { InframuxError } from '../core/errors.js';
import { exchangeGoogleAuthorizationCode } from '../providers/google-oauth.js';
import {
  createPkceAuthorization,
  encodeOAuthCredential,
  validateOAuthCallback,
  type OAuthCredential,
} from '../providers/oauth.js';

const execute = promisify(execFile);
const desktopClientSchema = z.object({
  installed: z.object({
    client_id: z.string().min(3).max(4_096),
    client_secret: z.string().min(3).max(128 * 1024).optional(),
    auth_uri: z.url(),
    token_uri: z.url(),
    redirect_uris: z.array(z.string()).min(1).max(16),
  }).strict(),
}).strict();

type ExchangeInput = Parameters<typeof exchangeGoogleAuthorizationCode>[0];

export async function authorizeGoogleDesktop(input: {
  readonly clientFile: string;
  readonly scopes: readonly string[];
  readonly loginHint?: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}, dependencies: {
  readonly openUrl?: (url: string) => Promise<void>;
  readonly exchange?: (input: ExchangeInput) => Promise<OAuthCredential>;
} = {}): Promise<Buffer> {
  const client = await readDesktopClient(input.clientFile);
  const timeoutMs = input.timeoutMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15 * 60_000) throw new Error('OAuth callback timeout must be 100ms to 15 minutes');
  if (input.signal.aborted) throw abortReason(input.signal);

  const server = createServer();
  server.maxHeadersCount = 32;
  await listenLoopback(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Google OAuth loopback server did not bind a TCP port');
  }
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
  const authorization = createPkceAuthorization({
    authorizationEndpoint: client.auth_uri,
    clientId: client.client_id,
    redirectUri,
    scopes: input.scopes,
    ...(input.loginHint === undefined ? {} : { loginHint: input.loginHint }),
  });
  const authorizationUrl = new URL(authorization.authorizationUrl);
  authorizationUrl.searchParams.set('prompt', 'consent');

  try {
    const callback = waitForCallback(server, {
      redirectUri,
      state: authorization.state,
      timeoutMs,
      signal: input.signal,
    });
    await (dependencies.openUrl ?? openSystemBrowser)(authorizationUrl.href);
    const code = await callback;
    const credential = await (dependencies.exchange ?? exchangeGoogleAuthorizationCode)({
      clientId: client.client_id,
      ...(client.client_secret === undefined ? {} : { clientSecret: client.client_secret }),
      code,
      codeVerifier: authorization.codeVerifier,
      redirectUri,
      requiredScopes: input.scopes,
      tokenEndpoint: client.token_uri,
      signal: input.signal,
    });
    return encodeOAuthCredential(credential);
  } finally {
    await closeServer(server);
  }
}

async function readDesktopClient(filename: string) {
  const stat = await lstat(filename);
  if (stat.isSymbolicLink()) throw new Error('Refusing symbolic link Google OAuth client file');
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Google OAuth client must be one regular file');
  if (stat.size > 512 * 1024) throw new Error('Google OAuth client file exceeds limit');
  const parsed = desktopClientSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
  for (const field of ['auth_uri', 'token_uri'] as const) {
    const endpoint = new URL(parsed.installed[field]);
    if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') {
      throw new Error(`Unsafe Google Desktop OAuth ${field}`);
    }
  }
  return parsed.installed;
}

function waitForCallback(server: Server, input: {
  redirectUri: string;
  state: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      server.removeListener('request', onRequest);
      if (error !== undefined) reject(error);
      else resolve(code!);
    };
    const onAbort = () => finish(abortReason(input.signal));
    const timer = setTimeout(() => finish(new InframuxError(
      'OAUTH_REFRESH_FAILED',
      'Google OAuth callback timed out',
      { recovery: 'Run the authorization command again and complete the browser consent' },
    )), input.timeoutMs);
    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET' || req.url === undefined || req.url.length > 20_000) {
        sendBrowserResponse(res, 400, 'Invalid OAuth callback.');
        return;
      }
      try {
        const callback = validateOAuthCallback(new URL(req.url, input.redirectUri).href, input);
        sendBrowserResponse(res, 200, 'inframux authorization complete. You can close this tab.');
        finish(undefined, callback.code);
      } catch (error) {
        sendBrowserResponse(res, 400, 'OAuth callback was rejected. Return to the terminal and try again.');
        if (error instanceof InframuxError) finish(error);
      }
    };
    server.on('request', onRequest);
    input.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sendBrowserResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'x-content-type-options': 'nosniff',
  });
  response.end(`${message}\n`);
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function openSystemBrowser(url: string): Promise<void> {
  await execute('/usr/bin/open', [url], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Google OAuth authorization cancelled');
}
