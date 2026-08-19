import { randomUUID } from 'node:crypto';
import { readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { assertSafeRegularFile, atomicWritePrivateFile } from '../core/safe-files.js';
import type { CheckoutEvidence } from '../git/evidence.js';
import { normalizeGitRemote } from '../git/remote.js';
import { KeyedLock } from '../security/locks.js';

const evidenceSchema = z.object({
  repositoryRoot: z.string().startsWith('/'),
  gitCommonDir: z.string().startsWith('/'),
  manifestPath: z.string().startsWith('/'),
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  normalizedRemotes: z.array(z.string()).readonly(),
}).strict();

const pendingSchema = z.object({
  schema: z.literal(1),
  id: z.uuid(),
  project: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  repositoryRoot: z.string().startsWith('/'),
  gitCommonDir: z.string().startsWith('/'),
  manifestPath: z.string().startsWith('/'),
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  canonicalRemote: z.string().min(3).max(512),
  workspaceRoot: z.string().startsWith('/'),
  requestedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export type PendingTrustRequest = z.infer<typeof pendingSchema>;

export class PendingTrustStore {
  readonly #stateRoot: string;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #locks = new KeyedLock();

  constructor(options: { stateRoot: string; now?: () => number; ttlMs?: number }) {
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1_000 || this.#ttlMs > 60 * 60_000) throw new Error('Pending trust TTL must be 1 second to 1 hour');
  }

  async create(input: {
    project: string;
    evidence: CheckoutEvidence;
    canonicalRemote: string;
    workspaceRoot: string;
  }): Promise<PendingTrustRequest> {
    const evidence = evidenceSchema.parse(input.evidence);
    const workspaceRoot = await realpath(input.workspaceRoot);
    const repositoryRoot = await realpath(evidence.repositoryRoot);
    const gitCommonDir = await realpath(evidence.gitCommonDir);
    if (!isWithin(workspaceRoot, repositoryRoot) || !isWithin(workspaceRoot, gitCommonDir)) {
      throw new Error('Pending trust repository and Git data must be inside the canonical workspace root');
    }
    const now = this.#now();
    const pending = pendingSchema.parse({
      schema: 1,
      id: randomUUID(),
      project: input.project,
      repositoryRoot,
      gitCommonDir,
      manifestPath: path.join(repositoryRoot, '.inframux.toml'),
      manifestDigest: evidence.manifestDigest,
      canonicalRemote: normalizeGitRemote(input.canonicalRemote),
      workspaceRoot,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#ttlMs).toISOString(),
    });
    await atomicWritePrivateFile(
      this.#stateRoot,
      relativeFile(pending.id),
      Buffer.from(`${JSON.stringify(pending, null, 2)}\n`),
    );
    return Object.freeze({ ...pending });
  }

  async get(id: string): Promise<PendingTrustRequest> {
    return this.#locks.run(id, () => this.#read(id));
  }

  async consume(id: string): Promise<PendingTrustRequest> {
    return this.#locks.run(id, async () => {
      const pending = await this.#read(id);
      await rm(path.join(this.#stateRoot, relativeFile(id)));
      return pending;
    });
  }

  async #read(id: string): Promise<PendingTrustRequest> {
    const filename = path.join(this.#stateRoot, relativeFile(id));
    try {
      await assertSafeRegularFile(filename);
      const pending = pendingSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
      if (Date.parse(pending.expiresAt) <= this.#now()) {
        await rm(filename, { force: true });
        throw new Error(`Pending trust request expired: ${id}`);
      }
      return Object.freeze({ ...pending });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error(`Pending trust request not found: ${id}`, { cause: error });
      throw error;
    }
  }
}

function relativeFile(id: string): string {
  return path.join('trust', 'pending', `${z.uuid().parse(id)}.json`);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
