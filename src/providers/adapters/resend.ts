import { z } from 'zod';

import type { HttpTransport } from '../http-transport.js';
import { assertFound, bearer, genericApiCall } from './shared.js';
import type { ProviderAdapter } from './types.js';

const serviceSchema = z.object({
  accountScope: z.enum(['full_access', 'full-access']).transform(() => 'full_access' as const).default('full_access'),
  anticipatedDomain: z.string().min(1).optional(), status: z.string().optional(),
}).passthrough();
const listSchema = z.object({ object: z.literal('list'), data: z.array(z.record(z.string(), z.json())) }).passthrough();

export function resendAdapter(transport: HttpTransport, origin: string): ProviderAdapter {
  const headers = (secret: Buffer) => ({ ...bearer(secret), 'user-agent': 'inframux/0.1.1' });
  return {
    id: 'resend',
    async verify(context) {
      const service = serviceSchema.parse(context.service);
      const apiKeys = listSchema.parse((await transport.request({
        origin, method: 'GET', path: '/api-keys', headers: headers(context.secret), signal: context.signal,
      })).body);
      assertFound(apiKeys.data.length > 0, 'Resend', 'Full Access API-key management');
      const domains = listSchema.parse((await transport.request({
        origin, method: 'GET', path: '/domains', headers: headers(context.secret), signal: context.signal,
      })).body);
      if (service.status !== 'planned' && service.anticipatedDomain !== undefined) {
        assertFound(domains.data.some((item) => item.name === service.anticipatedDomain), 'Resend', `domain ${service.anticipatedDomain}`);
      }
      return { identity: Object.freeze({ accountScope: service.accountScope }), resources: { domains: domains.data } };
    },
    call: (context) => genericApiCall({ context, transport, origin, headers: { 'user-agent': 'inframux/0.1.1' } }),
  };
}
