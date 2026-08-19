import { z } from 'zod';

import type { HttpTransport } from '../http-transport.js';
import { assertFound, bearer, genericApiCall } from './shared.js';
import type { ProviderAdapter } from './types.js';

const serviceSchema = z.object({
  accountId: z.string().min(1),
  zones: z.array(z.object({ name: z.string().min(1) }).passthrough()).default([]),
}).passthrough();
const envelope = <T extends z.ZodType>(value: T) => z.object({ success: z.literal(true), result: value }).passthrough();

export function cloudflareAdapter(transport: HttpTransport, origin: string): ProviderAdapter {
  return {
    id: 'cloudflare',
    async verify(context) {
      const service = serviceSchema.parse(context.service);
      const headers = bearer(context.secret);
      const verified = envelope(z.object({ id: z.string(), status: z.literal('active') }).passthrough()).parse((await transport.request({
        origin, method: 'GET', path: '/client/v4/user/tokens/verify', headers, signal: context.signal,
      })).body);
      const accounts = envelope(z.array(z.object({ id: z.string(), name: z.string().optional() }).passthrough())).parse((await transport.request({
        origin, method: 'GET', path: '/client/v4/accounts', query: { per_page: '50' }, headers, signal: context.signal,
      })).body).result;
      assertFound(accounts.some((item) => item.id === service.accountId), 'Cloudflare', `account ${service.accountId}`);
      const zones = envelope(z.array(z.object({
        id: z.string(), name: z.string(), account: z.object({ id: z.string() }).passthrough().optional(),
      }).passthrough())).parse((await transport.request({
        origin, method: 'GET', path: '/client/v4/zones',
        query: { 'account.id': service.accountId, per_page: '50' }, headers, signal: context.signal,
      })).body).result;
      for (const expected of service.zones) {
        assertFound(zones.some((zone) => zone.name === expected.name && (zone.account?.id ?? service.accountId) === service.accountId), 'Cloudflare', `zone ${expected.name}`);
      }
      return {
        identity: Object.freeze({ accountId: service.accountId }),
        resources: { tokenId: verified.result.id, zones: zones.map(({ id, name }) => ({ id, name })) },
      };
    },
    call: (context) => genericApiCall({ context, transport, origin }),
  };
}
