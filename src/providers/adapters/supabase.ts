import { z } from 'zod';

import type { HttpTransport } from '../http-transport.js';
import { assertFound, bearer, genericApiCall } from './shared.js';
import type { ProviderAdapter } from './types.js';

const serviceSchema = z.object({
  organizationId: z.string().min(1),
  projects: z.record(z.string(), z.object({ ref: z.string(), name: z.string() }).passthrough()).default({}),
}).passthrough();

export function supabaseAdapter(transport: HttpTransport, origin: string): ProviderAdapter {
  return {
    id: 'supabase',
    async verify(context) {
      const service = serviceSchema.parse(context.service);
      const headers = bearer(context.secret);
      const organizations = z.array(z.object({ id: z.string(), slug: z.string().optional(), name: z.string().optional() }).passthrough()).parse((await transport.request({
        origin, method: 'GET', path: '/v1/organizations', headers, signal: context.signal,
      })).body);
      assertFound(organizations.some((item) => item.id === service.organizationId), 'Supabase', `organization ${service.organizationId}`);
      const projects = z.array(z.object({
        id: z.string().optional(), ref: z.string(), organization_id: z.string(), name: z.string(),
      }).passthrough()).parse((await transport.request({
        origin, method: 'GET', path: '/v1/projects', headers, signal: context.signal,
      })).body);
      for (const expected of Object.values(service.projects)) {
        assertFound(projects.some((item) => item.ref === expected.ref && item.name === expected.name && item.organization_id === service.organizationId), 'Supabase', `project ${expected.ref}`);
      }
      return {
        identity: Object.freeze({ organizationId: service.organizationId }),
        resources: { projects: projects.filter((item) => item.organization_id === service.organizationId).map(({ ref, name }) => ({ ref, name })) },
      };
    },
    call: (context) => genericApiCall({ context, transport, origin }),
  };
}
