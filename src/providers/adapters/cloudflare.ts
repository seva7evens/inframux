import { z } from 'zod';

import { InframuxError } from '../../core/errors.js';
import type { HttpTransport } from '../http-transport.js';
import { assertFound, bearer, genericApiCall } from './shared.js';
import type { ProviderAdapter } from './types.js';

const serviceSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/i),
  credentialKind: z.enum(['account-api-token', 'user-api-token']).default('account-api-token'),
  zones: z.array(z.union([
    z.string().min(1).transform((name) => ({ name })),
    z.object({ name: z.string().min(1) }).passthrough(),
  ])).default([]),
}).passthrough();
const envelope = <T extends z.ZodType>(value: T) => z.object({ success: z.literal(true), result: value }).passthrough();
const accountSchema = z.object({ id: z.string(), name: z.string().optional() }).passthrough();
const zoneSchema = z.object({
  id: z.string(), name: z.string(), account: z.object({ id: z.string() }).passthrough().optional(),
}).passthrough();
const resultInfoSchema = z.object({
  page: z.number().int().min(1).optional(),
  per_page: z.number().int().min(1).max(50).optional(),
  total_count: z.number().int().min(0).optional(),
  total_pages: z.number().int().min(0).optional(),
}).passthrough();

export function cloudflareAdapter(transport: HttpTransport, origin: string): ProviderAdapter {
  return {
    id: 'cloudflare',
    async verify(context) {
      const service = serviceSchema.parse(context.service);
      const headers = bearer(context.secret);
      const verifyPath = service.credentialKind === 'account-api-token'
        ? `/client/v4/accounts/${service.accountId}/tokens/verify`
        : '/client/v4/user/tokens/verify';
      const verified = parseCloudflareEnvelope((await transport.request({
        origin, method: 'GET', path: verifyPath, headers, signal: context.signal,
      })).body, envelope(z.object({ id: z.string(), status: z.literal('active') }).passthrough()));
      if (service.credentialKind === 'user-api-token') {
        const accounts: Array<z.infer<typeof accountSchema>> = [];
        for (let page = 1; page <= 1_000; page += 1) {
          const response = parseCloudflareEnvelope((await transport.request({
            origin, method: 'GET', path: '/client/v4/accounts', query: { page: String(page), per_page: '50' }, headers, signal: context.signal,
          })).body, envelope(z.array(accountSchema)).extend({ result_info: resultInfoSchema.optional() }));
          accounts.push(...response.result);
          if (!hasNextPage(response.result_info, page, response.result.length, 50)) break;
          if (page === 1_000) throw new Error('Cloudflare accounts pagination exceeded the safety limit');
        }
        assertFound(accounts.some((item) => item.id === service.accountId), 'Cloudflare', `account ${service.accountId}`);
      }
      const zones: Array<z.infer<typeof zoneSchema>> = [];
      for (let page = 1; page <= 1_000; page += 1) {
        const response = parseCloudflareEnvelope((await transport.request({
          origin, method: 'GET', path: '/client/v4/zones',
          query: { 'account.id': service.accountId, page: String(page), per_page: '50' }, headers, signal: context.signal,
        })).body, envelope(z.array(zoneSchema)).extend({ result_info: resultInfoSchema.optional() }));
        zones.push(...response.result);
        if (!hasNextPage(response.result_info, page, response.result.length, 50)) break;
        if (page === 1_000) throw new Error('Cloudflare zones pagination exceeded the safety limit');
      }
      for (const expected of service.zones) {
        assertFound(zones.some((zone) => zone.name === expected.name && (zone.account?.id ?? service.accountId) === service.accountId), 'Cloudflare', `zone ${expected.name}`);
      }
      return {
        identity: Object.freeze({ accountId: service.accountId, credentialKind: service.credentialKind }),
        resources: { tokenId: verified.result.id, zones: zones.map(({ id, name }) => ({ id, name })) },
      };
    },
    call: (context) => genericApiCall({ context, transport, origin }),
  };
}

function parseCloudflareEnvelope<T extends z.ZodType>(body: unknown, schema: T): z.infer<T> {
  const status = z.object({ success: z.boolean() }).passthrough().safeParse(body);
  if (!status.success) {
    throw new InframuxError('PROVIDER_UNAVAILABLE', 'Cloudflare returned a malformed API response');
  }
  if (!status.data.success) {
    throw new InframuxError('PROVIDER_UNAVAILABLE', 'Cloudflare API returned an unsuccessful response');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new InframuxError('PROVIDER_UNAVAILABLE', 'Cloudflare returned a malformed API response');
  }
  return parsed.data;
}

function hasNextPage(
  info: z.infer<typeof resultInfoSchema> | undefined,
  requestedPage: number,
  resultCount: number,
  requestedPerPage: number,
): boolean {
  if (info?.total_pages !== undefined) return requestedPage < info.total_pages;
  if (info?.total_count !== undefined) {
    return requestedPage * (info.per_page ?? requestedPerPage) < info.total_count;
  }
  return resultCount === requestedPerPage;
}
