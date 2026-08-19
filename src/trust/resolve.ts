import path from 'node:path';

import type { ProjectCatalog, RepositoryManifest } from '../config/schemas.js';
import { InframuxError } from '../core/errors.js';
import type { CheckoutEvidence } from '../git/evidence.js';
import { normalizeGitRemote } from '../git/remote.js';
import type { TrustLedger } from './ledger.js';
import type { ResolvedProjectContext } from './types.js';

export async function resolveProjectContext(input: {
  evidence: CheckoutEvidence;
  manifest: RepositoryManifest;
  catalog: ProjectCatalog;
  ledger: TrustLedger;
}): Promise<ResolvedProjectContext> {
  const { evidence, manifest, catalog, ledger } = input;
  const actualRemote = validateCatalogBinding({ evidence, manifest, catalog });
  const approved = await ledger.find(evidence.repositoryRoot);
  if (approved === undefined) {
    throw new InframuxError('CHECKOUT_NOT_APPROVED', 'Exact checkout is not approved', {
      recovery: `inframux trust approve ${evidence.repositoryRoot}`,
    });
  }
  const workspaceRelative = path.relative(approved.workspaceRoot, evidence.repositoryRoot);
  const mismatch =
    approved.project !== manifest.project ||
    approved.repositoryRoot !== evidence.repositoryRoot ||
    approved.gitCommonDir !== evidence.gitCommonDir ||
    approved.canonicalRemote !== actualRemote ||
    approved.manifestDigest !== evidence.manifestDigest ||
    workspaceRelative === '..' ||
    workspaceRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(workspaceRelative);
  if (mismatch) {
    throw new InframuxError('CHECKOUT_NOT_APPROVED', 'Exact checkout approval evidence no longer matches');
  }

  return Object.freeze({
    project: manifest.project,
    repositoryRoot: evidence.repositoryRoot,
    gitCommonDir: evidence.gitCommonDir,
    canonicalRemote: actualRemote,
    manifestDigest: evidence.manifestDigest,
    approvedAt: approved.approvedAt,
  });
}

export function validateCatalogBinding(input: {
  evidence: CheckoutEvidence;
  manifest: RepositoryManifest;
  catalog: ProjectCatalog;
}): string {
  const { evidence, manifest, catalog } = input;
  if (manifest.project !== manifest.registry || manifest.project !== catalog.id) {
    throw new InframuxError('REMOTE_NOT_ALLOWED', 'Manifest and enrolled registry project disagree');
  }
  if (evidence.normalizedRemotes.length !== 1) {
    throw new InframuxError('REMOTE_NOT_ALLOWED', 'Conflicting or missing Git remotes prevent project resolution');
  }
  const [actualRemote] = evidence.normalizedRemotes;
  const allowed = new Set(catalog.repositories.map((entry) => normalizeGitRemote(entry.remote)));
  if (actualRemote === undefined || !allowed.has(actualRemote)) {
    throw new InframuxError('REMOTE_NOT_ALLOWED', 'Git remote is not allowed by the enrolled project');
  }
  return actualRemote;
}
