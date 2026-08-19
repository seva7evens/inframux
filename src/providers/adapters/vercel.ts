import { z } from 'zod';

import { InframuxError } from '../../core/errors.js';
import type { ApiRequestInput, HttpTransport } from '../http-transport.js';
import { assertFound, bearer, genericApiCall } from './shared.js';
import type { ProviderAdapter } from './types.js';

const projectSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).optional(), productionDomain: z.string().min(1).optional(),
}).passthrough();
const projectsSchema = z.union([
  z.record(z.string(), projectSchema),
  z.array(z.string().min(1)),
]).transform((projects): Record<string, z.infer<typeof projectSchema>> => Array.isArray(projects)
  ? Object.fromEntries(projects.map((id) => [id, { id }]))
  : projects);
const serviceSchema = z.object({
  user: z.string().min(1).optional(),
  teamId: z.string().min(1),
  projects: projectsSchema.default({}),
}).passthrough();

export function vercelAdapter(transport: HttpTransport, origin: string): ProviderAdapter {
  return {
    id: 'vercel',
    async verify(context) {
      const service = serviceSchema.parse(context.service);
      const headers = bearer(context.secret);
      const userBody = z.object({ user: z.object({ id: z.string(), username: z.string().optional(), email: z.string().optional() }).passthrough() }).passthrough().parse((await transport.request({
        origin, method: 'GET', path: '/v2/user', headers, signal: context.signal,
      })).body);
      if (service.user !== undefined) assertFound(userBody.user.username === service.user, 'Vercel', `user ${service.user}`);
      const teams = z.object({ teams: z.array(z.object({ id: z.string(), slug: z.string().optional() }).passthrough()) }).passthrough().parse((await transport.request({
        origin, method: 'GET', path: '/v2/teams', query: { limit: '100' }, headers, signal: context.signal,
      })).body).teams;
      assertFound(teams.some((team) => team.id === service.teamId), 'Vercel', `team ${service.teamId}`);
      const resources: Array<{ id: string; name: string; productionDomain: string }> = [];
      for (const expected of Object.values(service.projects)) {
        const project = z.object({ id: z.string(), name: z.string(), accountId: z.string().optional() }).passthrough().parse((await transport.request({
          origin, method: 'GET', path: `/v9/projects/${encodeURIComponent(expected.id)}`,
          query: { teamId: service.teamId }, headers, signal: context.signal,
        })).body);
        assertFound(project.id === expected.id, 'Vercel', `project ${expected.id}`);
        if (expected.name !== undefined) assertFound(project.name === expected.name, 'Vercel', `project ${expected.id}`);
        if (project.accountId !== undefined) assertFound(project.accountId === service.teamId, 'Vercel', `project team ${service.teamId}`);
        const domains = z.object({ domains: z.array(z.object({ name: z.string(), verified: z.boolean().optional() }).passthrough()) }).passthrough().parse((await transport.request({
          origin, method: 'GET', path: `/v9/projects/${encodeURIComponent(expected.id)}/domains`,
          query: { teamId: service.teamId }, headers, signal: context.signal,
        })).body).domains;
        if (expected.productionDomain !== undefined) {
          assertFound(domains.some((domain) => domain.name === expected.productionDomain), 'Vercel', `production domain ${expected.productionDomain}`);
        }
        resources.push({
          id: project.id,
          name: project.name,
          productionDomain: expected.productionDomain ?? domains.find((domain) => domain.verified !== false)?.name ?? '',
        });
      }
      return {
        identity: Object.freeze({ teamId: service.teamId, ...(service.user === undefined ? {} : { user: service.user }) }),
        resources: { userId: userBody.user.id, projects: resources },
      };
    },
    call: (context) => {
      const service = serviceSchema.parse(context.service);
      return genericApiCall({ context, transport, origin, transform: (input) => withTeam(input, service.teamId) });
    },
  };
}

function withTeam(input: ApiRequestInput, teamId: string): ApiRequestInput {
  const supplied = input.query?.teamId;
  if (supplied !== undefined && supplied !== teamId) throw new InframuxError('WRONG_PROVIDER_IDENTITY', 'Vercel request attempted to select another team');
  return { ...input, query: { ...input.query, teamId } };
}
