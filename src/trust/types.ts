import { z } from 'zod';

export const approvedCheckoutSchema = z
  .object({
    schema: z.literal(1),
    project: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    repositoryRoot: z.string().startsWith('/'),
    gitCommonDir: z.string().startsWith('/'),
    canonicalRemote: z.string().min(3),
    workspaceRoot: z.string().startsWith('/'),
    manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    approvedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const trustLedgerSchema = z
  .object({
    schema: z.literal(1),
    approvedCheckouts: z.array(approvedCheckoutSchema),
  })
  .strict();

export type ApprovedCheckout = z.infer<typeof approvedCheckoutSchema>;
export type TrustLedgerDocument = z.infer<typeof trustLedgerSchema>;

export interface ResolvedProjectContext {
  readonly project: string;
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly canonicalRemote: string;
  readonly manifestDigest: string;
  readonly approvedAt: string;
}
