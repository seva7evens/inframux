import { TextDecoder } from 'node:util';

import { InframuxError } from '../../core/errors.js';
import type { JsonValue } from '../../core/json.js';
import { validateApiRequestInput, type HttpTransport } from '../http-transport.js';
import type { ProviderCallContext } from './types.js';

export function credentialText(secret: Buffer): string {
  if (secret.length < 8 || secret.length > 128 * 1024) throw new InframuxError('CREDENTIAL_MISSING', 'Provider credential has an invalid size');
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(secret);
  } catch (error) {
    throw new InframuxError('CREDENTIAL_MISSING', 'Provider credential is not valid UTF-8', { cause: error });
  }
  if (/\s|\0/u.test(value)) throw new InframuxError('CREDENTIAL_MISSING', 'Provider credential contains unsafe whitespace');
  return value;
}

export function bearer(secret: Buffer): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${credentialText(secret)}` };
}

export async function genericApiCall(options: {
  readonly context: ProviderCallContext;
  readonly transport: HttpTransport;
  readonly origin: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly transform?: (input: ReturnType<typeof validateApiRequestInput>) => ReturnType<typeof validateApiRequestInput>;
}): Promise<JsonValue> {
  if (options.context.operation !== 'api.request') {
    throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', `Provider API operation is not implemented: ${options.context.operation}`);
  }
  const parsed = validateApiRequestInput(options.context.input);
  const request = options.transform?.(parsed) ?? parsed;
  const response = await options.transport.request({
    origin: options.origin,
    method: request.method,
    path: request.path,
    headers: { ...bearer(options.context.secret), ...options.headers },
    signal: options.context.signal,
    ...(request.query === undefined ? {} : { query: request.query }),
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  });
  return { status: response.status, body: response.body, rateLimit: response.rateLimit };
}

export function assertFound(value: boolean, provider: string, resource: string): void {
  if (!value) throw new InframuxError('WRONG_PROVIDER_IDENTITY', `${provider} credential cannot access expected ${resource}`);
}

export function safeProviderOrigin(value: unknown, allowed: readonly string[], fallback: string): string {
  const selected = typeof value === 'string' ? value : fallback;
  if (!allowed.includes(selected)) throw new InframuxError('WRONG_PROVIDER_IDENTITY', 'Catalog contains an unsupported provider origin');
  return selected;
}
