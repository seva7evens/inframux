import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { atomicWritePrivateFile, ensurePrivateDirectory, assertSafeRegularFile } from '../core/safe-files.js';
import { normalizeGitRemote } from '../git/remote.js';
import { approvedCheckoutSchema, trustLedgerSchema, type ApprovedCheckout, type TrustLedgerDocument } from './types.js';

export class TrustLedger {
  readonly #stateRoot: string;
  readonly #relativeFile = path.join('registry', 'approved-checkouts.json');

  constructor(stateRoot: string) {
    this.#stateRoot = path.resolve(stateRoot);
  }

  async list(): Promise<readonly ApprovedCheckout[]> {
    return Object.freeze([...(await this.#read()).approvedCheckouts]);
  }

  async find(repositoryRoot: string): Promise<ApprovedCheckout | undefined> {
    const entry = (await this.#read()).approvedCheckouts.find(
      (candidate) => candidate.repositoryRoot === repositoryRoot,
    );
    return entry === undefined ? undefined : Object.freeze({ ...entry });
  }

  async approve(input: ApprovedCheckout): Promise<void> {
    const workspaceRoot = await realpath(input.workspaceRoot);
    const repositoryRoot = await realpath(input.repositoryRoot);
    const gitCommonDir = await realpath(input.gitCommonDir);
    if (!isWithin(workspaceRoot, repositoryRoot) || !isWithin(workspaceRoot, gitCommonDir)) {
      throw new Error('Approved checkout paths must be inside the canonical workspace root');
    }
    const entry = approvedCheckoutSchema.parse({
      ...input,
      workspaceRoot,
      repositoryRoot,
      gitCommonDir,
      canonicalRemote: normalizeGitRemote(input.canonicalRemote),
    });
    const current = await this.#read();
    const retained = current.approvedCheckouts.filter(
      (candidate) => candidate.repositoryRoot !== entry.repositoryRoot,
    );
    const next: TrustLedgerDocument = {
      schema: 1,
      approvedCheckouts: [...retained, entry].sort((left, right) =>
        left.repositoryRoot.localeCompare(right.repositoryRoot)),
    };
    await atomicWritePrivateFile(
      this.#stateRoot,
      this.#relativeFile,
      Buffer.from(`${JSON.stringify(next, null, 2)}\n`),
    );
  }

  async revoke(repositoryRoot: string): Promise<boolean> {
    const current = await this.#read();
    const retained = current.approvedCheckouts.filter(
      (candidate) => candidate.repositoryRoot !== repositoryRoot,
    );
    if (retained.length === current.approvedCheckouts.length) return false;
    await atomicWritePrivateFile(
      this.#stateRoot,
      this.#relativeFile,
      Buffer.from(`${JSON.stringify({ schema: 1, approvedCheckouts: retained }, null, 2)}\n`),
    );
    return true;
  }

  async #read(): Promise<TrustLedgerDocument> {
    await ensurePrivateDirectory(this.#stateRoot);
    const filename = path.join(this.#stateRoot, this.#relativeFile);
    try {
      await assertSafeRegularFile(filename);
      return trustLedgerSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { schema: 1, approvedCheckouts: [] };
      }
      throw error;
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
