import { z } from 'zod';

import { repositoryManifestSchema } from '../config/schemas.js';

const checkoutEvidenceSchema = z.object({
  repositoryRoot: z.string().startsWith('/'),
  gitCommonDir: z.string().startsWith('/'),
  manifestPath: z.string().startsWith('/'),
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  normalizedRemotes: z.array(z.string()).readonly(),
}).strict();

export const checkoutPayloadSchema = z.object({
  evidence: checkoutEvidenceSchema,
  manifest: repositoryManifestSchema,
}).strict();

export const enrollPayloadSchema = z.object({
  project: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
  alias: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/).optional(),
  credentialType: z.string().min(1).max(64),
  expectedIdentity: z.record(z.string(), z.string()).default({}),
  secretBase64: z.base64(),
}).strict();

export const credentialRevokePayloadSchema = z.object({
  project: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
}).strict();

export const credentialStatusPayloadSchema = z.object({
  project: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
}).strict();

export const credentialEnrollmentInfoPayloadSchema = z.object({
  project: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
}).strict();

export const trustRequestPayloadSchema = checkoutPayloadSchema.extend({
  workspaceRoot: z.string().startsWith('/'),
}).strict();

export const trustApprovePayloadSchema = z.object({ requestId: z.uuid() }).strict();
export const trustRevokePayloadSchema = z.object({ repositoryRoot: z.string().startsWith('/') }).strict();

export const runPayloadSchema = checkoutPayloadSchema.extend({
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
  args: z.array(z.string().max(32_768)).min(1).max(256),
}).strict();

export const callPayloadSchema = checkoutPayloadSchema.extend({
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
  operation: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  input: z.json(),
}).strict();

export const mcpOpenPayloadSchema = checkoutPayloadSchema.extend({
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
}).strict();

export const mcpSessionPayloadSchema = z.object({ sessionId: z.uuid() }).strict();
export const onboardingStartPayloadSchema = z.object({
  project: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/), displayName: z.string().min(1).max(128),
  providers: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,126}$/)).min(1),
  evidence: checkoutEvidenceSchema, workspaceRoot: z.string().startsWith('/'),
}).strict();
export const onboardingSessionPayloadSchema = z.object({ sessionId: z.uuid() }).strict();
export const onboardingConfigurePayloadSchema = onboardingSessionPayloadSchema.extend({
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/), input: z.unknown(),
}).strict();
export const onboardingVerifiedPayloadSchema = onboardingSessionPayloadSchema.extend({
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/), profile: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
}).strict();
export const onboardingReusePayloadSchema = onboardingSessionPayloadSchema.extend({
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
  sourceProject: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
}).strict();
export const mcpWritePayloadSchema = mcpSessionPayloadSchema.extend({
  chunkBase64: z.base64().refine((value) => Buffer.byteLength(value, 'base64') <= 256 * 1024, 'MCP chunk exceeds limit'),
}).strict();

export type CheckoutPayload = z.infer<typeof checkoutPayloadSchema>;
export type EnrollPayload = z.infer<typeof enrollPayloadSchema>;
export type CredentialRevokePayload = z.infer<typeof credentialRevokePayloadSchema>;
export type CredentialStatusPayload = z.infer<typeof credentialStatusPayloadSchema>;
export type CredentialEnrollmentInfoPayload = z.infer<typeof credentialEnrollmentInfoPayloadSchema>;
export type TrustRequestPayload = z.infer<typeof trustRequestPayloadSchema>;
export type TrustApprovePayload = z.infer<typeof trustApprovePayloadSchema>;
export type TrustRevokePayload = z.infer<typeof trustRevokePayloadSchema>;
export type RunPayload = z.infer<typeof runPayloadSchema>;
export type CallPayload = z.infer<typeof callPayloadSchema>;
export type McpOpenPayload = z.infer<typeof mcpOpenPayloadSchema>;
