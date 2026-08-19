import { z } from 'zod';

const projectId = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const credentialAlias = z.string().regex(/^[a-z][a-z0-9-]{1,126}$/);

export const repositoryManifestSchema = z
  .object({
    schema: z.literal(1),
    project: projectId,
    registry: projectId,
  })
  .strict();

const repositorySchema = z
  .object({
    remote: z.string().min(3).max(512).regex(/^[^\s]+$/),
  })
  .strict();

const serviceSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    if (typeof value.credential !== 'string' || !credentialAlias.safeParse(value.credential).success) {
      context.addIssue({
        code: 'custom',
        message: 'Each service requires a public credential alias',
        path: ['credential'],
      });
    }
    findForbiddenSecretKeys(value, [], context);
  });

export const catalogSchema = z
  .object({
    schema: z.literal(1),
    id: projectId,
    displayName: z.string().trim().min(1).max(128),
    repositories: z.array(repositorySchema).min(1),
    services: z.record(projectId, serviceSchema),
  })
  .strict();

export type RepositoryManifest = z.infer<typeof repositoryManifestSchema>;
export type ProjectCatalog = z.infer<typeof catalogSchema>;

const forbiddenSecretKey = /^(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|private[_-]?key|cookie|authorization)$/i;

function findForbiddenSecretKeys(
  value: unknown,
  path: PropertyKey[],
  context: z.core.$RefinementCtx,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => findForbiddenSecretKeys(child, [...path, index], context));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenSecretKey.test(key)) {
      context.addIssue({
        code: 'custom',
        message: `Catalog contains secret material field: ${key}`,
        path: [...path, key],
      });
    }
    findForbiddenSecretKeys(child, [...path, key], context);
  }
}
