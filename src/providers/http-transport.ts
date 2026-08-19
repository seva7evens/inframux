import { TextDecoder } from 'node:util';
import { z } from 'zod';

import { InframuxError } from '../core/errors.js';
import type { JsonValue } from '../core/json.js';

const methodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const queryValueSchema = z.union([
  z.string().max(16_384),
  z.array(z.string().max(16_384)).max(128),
]);
const publicRequestSchema = z.object({
  method: methodSchema,
  path: z.string().min(1).max(16_384),
  query: z.record(z.string().min(1).max(256), queryValueSchema).optional(),
  body: z.json().optional(),
  idempotencyKey: z.string().min(8).max(256).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).strict();

export type ApiRequestInput = z.infer<typeof publicRequestSchema>;

export interface HttpTransportRequest extends ApiRequestInput {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface HttpTransportResponse {
  readonly status: number;
  readonly body: JsonValue;
  readonly rateLimit: Readonly<Record<string, string>>;
}

export interface HttpTransport {
  request(input: HttpTransportRequest): Promise<HttpTransportResponse>;
}

export function validateApiRequestInput(input: unknown): ApiRequestInput {
  const parsed = publicRequestSchema.parse(input);
  assertSafeRelativeApiPath(parsed.path);
  return parsed;
}

export class FetchHttpTransport implements HttpTransport {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #timeoutMs: number;

  constructor(options: {
    allowedOrigins: readonly string[];
    allowInsecureLoopback?: boolean;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    timeoutMs?: number;
  }) {
    if (options.allowedOrigins.length === 0) throw new Error('HTTP transport requires at least one allowed origin');
    const origins = options.allowedOrigins.map((value) => canonicalOrigin(value, options.allowInsecureLoopback ?? false));
    if (new Set(origins).size !== origins.length) throw new Error('HTTP transport has duplicate allowed origins');
    this.#allowedOrigins = new Set(origins);
    this.#maxRequestBytes = boundedInteger(options.maxRequestBytes ?? 2 * 1024 * 1024, 'maxRequestBytes');
    this.#maxResponseBytes = boundedInteger(options.maxResponseBytes ?? 8 * 1024 * 1024, 'maxResponseBytes');
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 'timeoutMs');
  }

  async request(input: HttpTransportRequest): Promise<HttpTransportResponse> {
    const publicInput = validateApiRequestInput({
      method: input.method,
      path: input.path,
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    const origin = canonicalOrigin(input.origin, input.origin.startsWith('http://127.0.0.1:'));
    if (!this.#allowedOrigins.has(origin)) throw new InframuxError('INVALID_REQUEST', 'Provider origin is not enrolled');
    const url = new URL(publicInput.path, `${origin}/`);
    if (url.origin !== origin) throw new InframuxError('INVALID_REQUEST', 'Provider request escaped its enrolled origin');
    for (const [key, value] of Object.entries(publicInput.query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
    }

    const headers = validatedInternalHeaders(input.headers);
    headers.set('accept', 'application/json');
    let requestBody: string | undefined;
    if (publicInput.body !== undefined) {
      requestBody = JSON.stringify(publicInput.body);
      if (Buffer.byteLength(requestBody) > this.#maxRequestBytes) {
        throw new InframuxError('OUTPUT_LIMIT_EXCEEDED', 'Provider request body exceeds configured limit');
      }
      headers.set('content-type', 'application/json');
    }
    if (publicInput.idempotencyKey !== undefined) headers.set('idempotency-key', publicInput.idempotencyKey);
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([input.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await fetch(url, {
        method: publicInput.method,
        headers,
        redirect: 'manual',
        signal,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      });
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error('Provider request cancelled');
      throw new InframuxError('PROVIDER_UNAVAILABLE', 'Provider network request failed', { cause: error });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new InframuxError('PROVIDER_UNAVAILABLE', 'Provider redirect was rejected to protect credentials');
    }
    const bytes = await readBoundedBody(response, this.#maxResponseBytes);
    const rateLimit = safeRateLimitHeaders(response.headers);
    if (response.status === 401) throw new InframuxError('TOKEN_EXPIRED', 'Provider rejected the credential');
    if (response.status === 403) throw new InframuxError('SCOPE_MISSING', 'Provider credential lacks a required permission');
    if (response.status === 429) {
      throw new InframuxError('RATE_LIMITED', 'Provider rate limit was reached', {
        details: { retryAfter: response.headers.get('retry-after') },
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new InframuxError('PROVIDER_UNAVAILABLE', `Provider request failed with HTTP ${response.status}`);
    }
    if (bytes.length === 0) return Object.freeze({ status: response.status, body: null, rateLimit });
    let body: JsonValue;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      body = z.json().parse(JSON.parse(decoded));
    } catch (error) {
      throw new InframuxError('PROVIDER_UNAVAILABLE', 'Provider returned malformed JSON', { cause: error });
    } finally {
      bytes.fill(0);
    }
    return Object.freeze({ status: response.status, body, rateLimit });
  }
}

function assertSafeRelativeApiPath(value: string): void {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('?') || value.includes('#') || value.includes('\0')) {
    throw new Error('Provider request requires one safe relative API path');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch (error) {
    throw new Error('Provider request path has invalid percent encoding', { cause: error });
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Provider request rejects dot path segments');
  }
}

function canonicalOrigin(value: string, allowInsecureLoopback: boolean): string {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('Provider origin must contain only scheme and host');
  }
  const secure = url.protocol === 'https:';
  const loopback = allowInsecureLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (!secure && !loopback) throw new Error('Provider origin must use HTTPS');
  return url.origin;
}

function validatedInternalHeaders(input: Readonly<Record<string, string>>): Headers {
  const allowed = new Set(['authorization', 'user-agent', 'x-api-key']);
  const headers = new Headers();
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) throw new Error(`Provider adapter header is not approved: ${rawName}`);
    if (value.length === 0 || value.length > 128 * 1024 || /[\r\n\0]/u.test(value)) throw new Error(`Unsafe provider header: ${rawName}`);
    headers.set(name, value);
  }
  return headers;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.length;
      if (total > maxBytes) {
        chunk.fill(0);
        throw new InframuxError('OUTPUT_LIMIT_EXCEEDED', 'Provider response exceeds configured limit');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await reader.cancel().catch(() => undefined);
  }
}

function safeRateLimitHeaders(headers: Headers): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [source, target] of [
    ['x-ratelimit-limit', 'limit'],
    ['x-ratelimit-remaining', 'remaining'],
    ['x-ratelimit-reset', 'reset'],
    ['retry-after', 'retryAfter'],
  ] as const) {
    const value = headers.get(source);
    if (value !== null && /^[0-9.]{1,32}$/.test(value)) output[target] = value;
  }
  return Object.freeze(output);
}

function boundedInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 128 * 1024 * 1024) throw new Error(`Invalid ${name}`);
  return value;
}
