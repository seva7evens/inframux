import { z } from 'zod';

import type { HttpTransport } from '../http-transport.js';
import { assertFound, bearer, genericApiCall, safeProviderOrigin } from './shared.js';
import type { ProviderAdapter } from './types.js';

const serviceSchema = z.object({
  origin: z.string().url(), organization: z.string().min(1),
  projects: z.array(z.string().min(1)).default([]),
}).passthrough();

export function sentryAdapter(transport: HttpTransport, originOverride?: string): ProviderAdapter {
  const originFor = (service: z.infer<typeof serviceSchema>) => originOverride ?? safeProviderOrigin(
    service.origin, ['https://sentry.io', 'https://us.sentry.io', 'https://de.sentry.io'], 'https://sentry.io',
  );
  return {
    id: 'sentry',
    async verify(context) {
      const service = serviceSchema.parse(context.service);
      const origin = originFor(service);
      const headers = bearer(context.secret);
      const organization = z.object({ id: z.string(), slug: z.string(), links: z.object({ regionUrl: z.string().url().optional() }).passthrough().optional() }).passthrough().parse((await transport.request({
        origin, method: 'GET', path: `/api/0/organizations/${encodeURIComponent(service.organization)}/`, headers, signal: context.signal,
      })).body);
      assertFound(organization.slug === service.organization, 'Sentry', `organization ${service.organization}`);
      const projects = z.array(z.object({ id: z.string(), slug: z.string() }).passthrough()).parse((await transport.request({
        origin, method: 'GET', path: `/api/0/organizations/${encodeURIComponent(service.organization)}/projects/`, headers, signal: context.signal,
      })).body);
      for (const slug of service.projects) assertFound(projects.some((project) => project.slug === slug), 'Sentry', `project ${slug}`);
      return {
        identity: Object.freeze({ organization: service.organization, origin: service.origin }),
        resources: { organizationId: organization.id, projects: projects.map(({ id, slug }) => ({ id, slug })) },
      };
    },
    call: (context) => {
      const service = serviceSchema.parse(context.service);
      return genericApiCall({ context, transport, origin: originFor(service) });
    },
  };
}
