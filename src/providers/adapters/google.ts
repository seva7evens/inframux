import { z } from 'zod';

import { InframuxError } from '../../core/errors.js';
import type { JsonValue } from '../../core/json.js';
import { decodeOAuthCredential } from '../oauth.js';
import { validateApiRequestInput, type HttpTransport } from '../http-transport.js';
import { assertFound } from './shared.js';
import type { ProviderAdapter } from './types.js';

interface GoogleEndpoint {
  readonly origin: string;
  readonly prefix?: string;
  readonly path?: string;
}

export type GoogleEndpointRegistry = Readonly<Record<string, GoogleEndpoint>>;

const serviceSchema = z.object({
  account: z.string().email(),
  projects: z.array(z.string().min(1)).default([]),
  scopes: z.array(z.string().min(1)).min(1),
}).passthrough();

const defaultEndpoints: GoogleEndpointRegistry = Object.freeze({
  userinfo: { origin: 'https://openidconnect.googleapis.com', path: '/v1/userinfo' },
  cloudresourcemanager: { origin: 'https://cloudresourcemanager.googleapis.com' },
  serviceusage: { origin: 'https://serviceusage.googleapis.com' },
  iam: { origin: 'https://iam.googleapis.com' },
  cloudbilling: { origin: 'https://cloudbilling.googleapis.com' },
  compute: { origin: 'https://compute.googleapis.com' },
  run: { origin: 'https://run.googleapis.com' },
  storage: { origin: 'https://storage.googleapis.com' },
  sqladmin: { origin: 'https://sqladmin.googleapis.com' },
  dns: { origin: 'https://dns.googleapis.com' },
  pubsub: { origin: 'https://pubsub.googleapis.com' },
  secretmanager: { origin: 'https://secretmanager.googleapis.com' },
  logging: { origin: 'https://logging.googleapis.com' },
  monitoring: { origin: 'https://monitoring.googleapis.com' },
  cloudbuild: { origin: 'https://cloudbuild.googleapis.com' },
  artifactregistry: { origin: 'https://artifactregistry.googleapis.com' },
  drive: { origin: 'https://www.googleapis.com' },
  youtube: { origin: 'https://www.googleapis.com' },
  sheets: { origin: 'https://sheets.googleapis.com' },
  docs: { origin: 'https://docs.googleapis.com' },
  calendar: { origin: 'https://www.googleapis.com' },
  gmail: { origin: 'https://gmail.googleapis.com' },
  analytics: { origin: 'https://analyticsadmin.googleapis.com' },
  searchconsole: { origin: 'https://searchconsole.googleapis.com' },
});

export function googleAdapter(
  transport: HttpTransport,
  endpointOverrides: GoogleEndpointRegistry = defaultEndpoints,
): ProviderAdapter {
  const endpoints = Object.freeze({ ...defaultEndpoints, ...endpointOverrides });
  return {
    id: 'google-cloud',
    async verify(context) {
      const service = serviceSchema.parse(context.service);
      const credential = decodeOAuthCredential(context.secret);
      assertScopes(credential.scopes, service.scopes);
      if (Date.parse(credential.expiresAt) <= Date.now()) throw new InframuxError('TOKEN_EXPIRED', 'Google OAuth access token requires refresh');
      const headers = { authorization: `Bearer ${credential.accessToken}` };
      const userinfoEndpoint = requiredEndpoint(endpoints, 'userinfo');
      const user = z.object({
        sub: z.string(), email: z.string().email(), email_verified: z.boolean().optional(),
      }).passthrough().parse((await transport.request({
        origin: userinfoEndpoint.origin, method: 'GET', path: userinfoEndpoint.path ?? '/v1/userinfo',
        headers, signal: context.signal,
      })).body);
      assertFound(user.email === service.account && user.email_verified !== false, 'Google', `account ${service.account}`);
      const crm = requiredEndpoint(endpoints, 'cloudresourcemanager');
      const projectsBody = z.object({
        projects: z.array(z.object({ projectId: z.string(), displayName: z.string().optional(), name: z.string().optional() }).passthrough()).default([]),
      }).passthrough().parse((await transport.request({
        origin: crm.origin, method: 'GET', path: `${crm.prefix ?? ''}/v1/projects`,
        query: { pageSize: '100' }, headers, signal: context.signal,
      })).body);
      for (const project of service.projects) assertFound(projectsBody.projects.some((item) => item.projectId === project), 'Google Cloud', `project ${project}`);
      return {
        identity: Object.freeze({ account: service.account }),
        resources: {
          accountSubject: user.sub,
          projects: projectsBody.projects.map((item) => ({ id: item.projectId, name: item.displayName ?? item.name ?? '' })),
        },
      };
    },
    async call(context): Promise<JsonValue> {
      const service = serviceSchema.parse(context.service);
      const credential = decodeOAuthCredential(context.secret);
      assertScopes(credential.scopes, service.scopes);
      if (context.operation !== 'api.request') throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', `Google operation is not implemented: ${context.operation}`);
      if (context.input === null || typeof context.input !== 'object' || Array.isArray(context.input)) throw new Error('Google API request must be an object');
      const { api, ...requestInput } = context.input as Record<string, unknown>;
      if (typeof api !== 'string' || api === 'userinfo' || endpoints[api] === undefined) throw new Error('Google request requires a registered Google API');
      const endpoint = requiredEndpoint(endpoints, api);
      const request = validateApiRequestInput(requestInput);
      const response = await transport.request({
        origin: endpoint.origin,
        method: request.method,
        path: `${endpoint.prefix ?? ''}${request.path}`,
        headers: { authorization: `Bearer ${credential.accessToken}` },
        signal: context.signal,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      });
      return { status: response.status, body: response.body, rateLimit: response.rateLimit };
    },
  };
}

export function googleApiOrigins(endpoints: GoogleEndpointRegistry = defaultEndpoints): readonly string[] {
  return Object.freeze([...new Set(Object.values(endpoints).map((item) => item.origin))].sort());
}

function requiredEndpoint(endpoints: GoogleEndpointRegistry, key: string): GoogleEndpoint {
  const endpoint = endpoints[key];
  if (endpoint === undefined) throw new Error(`Google API endpoint is not registered: ${key}`);
  return endpoint;
}

function assertScopes(granted: readonly string[], required: readonly string[]): void {
  const actual = new Set(granted);
  const missing = required.filter((scope) => !actual.has(scope));
  if (missing.length > 0) throw new InframuxError('SCOPE_MISSING', 'Google credential lacks required scopes', { details: { missingScopes: missing } });
}
