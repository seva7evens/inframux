import { z } from 'zod';

import type { HttpTransport } from '../http-transport.js';
import { assertFound, bearer, genericApiCall, safeProviderOrigin } from './shared.js';
import type { ProviderAdapter } from './types.js';

const serviceSchema = z.object({
  origin: z.string().url().optional(), organizationId: z.string().min(1), projectId: z.string().min(1),
}).passthrough();

export function posthogAdapter(transport: HttpTransport, originOverride?: string): ProviderAdapter {
  const originFor = (service: z.infer<typeof serviceSchema>) => originOverride ?? safeProviderOrigin(
    service.origin, ['https://us.posthog.com', 'https://eu.posthog.com'], 'https://us.posthog.com',
  );
  return {
    id: 'posthog',
    async verify(context) {
      const service = serviceSchema.parse(context.service);
      const me = z.object({
        id: z.union([z.string(), z.number()]),
        organization: z.object({ id: z.union([z.string(), z.number()]) }).passthrough(),
        team: z.object({ id: z.union([z.string(), z.number()]), name: z.string().optional() }).passthrough(),
      }).passthrough().parse((await transport.request({
        origin: originFor(service), method: 'GET', path: '/api/users/@me/',
        headers: bearer(context.secret), signal: context.signal,
      })).body);
      assertFound(String(me.organization.id) === service.organizationId, 'PostHog', `organization ${service.organizationId}`);
      assertFound(String(me.team.id) === service.projectId, 'PostHog', `project ${service.projectId}`);
      return {
        identity: Object.freeze({ organizationId: service.organizationId, projectId: service.projectId }),
        resources: { userId: String(me.id), projectName: me.team.name ?? '' },
      };
    },
    call: (context) => {
      const service = serviceSchema.parse(context.service);
      return genericApiCall({ context, transport, origin: originFor(service) });
    },
  };
}
