import { z } from 'zod';

import type { HttpTransport } from '../http-transport.js';
import { assertFound, bearer, genericApiCall } from './shared.js';
import type { ProviderAdapter } from './types.js';
import { stableResourceFingerprint } from '../resource-fingerprint.js';

const monitorsSchema = z.union([
  z.record(z.string(), z.string().min(1)),
  z.array(z.string().min(1)),
]).transform((monitors) => Array.isArray(monitors)
  ? Object.fromEntries(monitors.map((id) => [id, id]))
  : monitors);
const serviceSchema = z.object({ monitors: monitorsSchema.default({}) }).passthrough();

export function uptimeRobotAdapter(transport: HttpTransport, origin: string): ProviderAdapter {
  return {
    id: 'uptimerobot',
    async verify(context) {
      const service = serviceSchema.parse(context.service);
      const response = z.object({
        data: z.array(z.object({ id: z.union([z.number(), z.string()]), friendly_name: z.string().optional(), name: z.string().optional() }).passthrough()),
      }).passthrough().parse((await transport.request({
        origin, method: 'GET', path: '/v3/monitors', query: { limit: '200' },
        headers: bearer(context.secret), signal: context.signal,
      })).body);
      const monitorIds = Object.values(service.monitors).sort();
      for (const id of monitorIds) assertFound(response.data.some((monitor) => String(monitor.id) === id), 'UptimeRobot', `monitor ${id}`);
      return {
        identity: Object.freeze({
          resourceFingerprint: stableResourceFingerprint(monitorIds),
          monitorCount: String(response.data.length),
        }),
        resources: { monitors: response.data.map((monitor) => ({ id: String(monitor.id), name: monitor.friendly_name ?? monitor.name ?? '' })) },
      };
    },
    call: (context) => genericApiCall({ context, transport, origin }),
  };
}
