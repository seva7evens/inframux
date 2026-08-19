import { createHmac } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { InframuxError } from '../core/errors.js';
import { assertSafeRegularFile, atomicWritePrivateFile } from '../core/safe-files.js';
import { KeyedLock } from './locks.js';
import type { Redactor } from './redactor.js';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{1,126}$/);
const metadataSchema = z.object({
  schema: z.literal(1),
  project: identifier,
  provider: identifier,
  alias: identifier,
  credentialType: z.string().min(1).max(64),
  expectedIdentity: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  lastVerifiedAt: z.iso.datetime({ offset: true }).nullable(),
  fingerprint: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
}).strict();
const bindingSchema = z.object({
  schema: z.literal(1), project: identifier, provider: identifier, alias: identifier,
  sourceProject: identifier, sourceAlias: identifier, expectedIdentity: z.record(z.string(), z.string()),
  fingerprint: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/), createdAt: z.iso.datetime({ offset: true }),
}).strict();

export type CredentialMetadata = z.infer<typeof metadataSchema>;

export interface PutCredentialInput {
  readonly project: string;
  readonly provider: string;
  readonly alias: string;
  readonly credentialType: string;
  readonly expectedIdentity: Readonly<Record<string, string>>;
  readonly secret: Uint8Array;
  readonly createdAt?: string;
  readonly expiresAt?: string | null;
  readonly lastVerifiedAt?: string | null;
}

export class CredentialStore {
  readonly #stateRoot: string;
  readonly #fingerprintKey: Buffer;
  readonly #redactor: Redactor;
  readonly #locks = new KeyedLock();

  constructor(options: { stateRoot: string; fingerprintKey: Uint8Array; redactor: Redactor }) {
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#fingerprintKey = Buffer.from(options.fingerprintKey);
    if (this.#fingerprintKey.length < 32) throw new Error('Fingerprint key must be at least 32 bytes');
    this.#redactor = options.redactor;
  }

  async put(input: PutCredentialInput): Promise<CredentialMetadata> {
    const key = credentialKey(input.project, input.provider, input.alias);
    return this.#locks.run(key, async () => {
      const secret = Buffer.from(input.secret);
      if (secret.length < 8 || secret.length > 128 * 1024 || secret.includes(0)) {
        throw new Error('Credential must contain 8..131072 non-NUL bytes');
      }
      const now = input.createdAt ?? new Date().toISOString();
      const metadata = metadataSchema.parse({
        schema: 1,
        project: input.project,
        provider: input.provider,
        alias: input.alias,
        credentialType: input.credentialType,
        expectedIdentity: input.expectedIdentity,
        createdAt: now,
        expiresAt: input.expiresAt ?? null,
        lastVerifiedAt: input.lastVerifiedAt ?? null,
        fingerprint: `hmac-sha256:${createHmac('sha256', this.#fingerprintKey).update(secret).digest('hex')}`,
      });
      try {
        await atomicWritePrivateFile(this.#stateRoot, secretRelative(input.project, input.provider, input.alias), secret);
        await atomicWritePrivateFile(
          this.#stateRoot,
          metadataRelative(input.project, input.provider, input.alias),
          Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
        );
        return Object.freeze({ ...metadata });
      } finally {
        secret.fill(0);
      }
    });
  }

  async metadata(project: string, provider: string, alias: string): Promise<CredentialMetadata> {
    credentialKey(project, provider, alias);
    const filename = path.join(this.#stateRoot, metadataRelative(project, provider, alias));
    try {
      await assertSafeRegularFile(filename);
      return Object.freeze(metadataSchema.parse(JSON.parse(await readFile(filename, 'utf8'))));
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return this.#boundMetadata(project, provider, alias);
      throw error;
    }
  }

  async bindExisting(input: {
    readonly sourceProject: string; readonly sourceAlias: string;
    readonly targetProject: string; readonly targetAlias: string; readonly provider: string;
    readonly expectedIdentity: Readonly<Record<string, string>>;
  }): Promise<CredentialMetadata> {
    const sourceKey = credentialKey(input.sourceProject, input.provider, input.sourceAlias);
    const targetKey = credentialKey(input.targetProject, input.provider, input.targetAlias);
    if (sourceKey === targetKey) return this.metadata(input.sourceProject, input.provider, input.sourceAlias);
    return this.#locks.run([sourceKey, targetKey].sort().join('|'), async () => {
      const source = await this.metadata(input.sourceProject, input.provider, input.sourceAlias);
      if (JSON.stringify(source.expectedIdentity) !== JSON.stringify(input.expectedIdentity)) {
        throw new InframuxError('WRONG_PROVIDER_IDENTITY', 'Credential profile identity does not match the target binding');
      }
      await atomicWritePrivateFile(this.#stateRoot, bindingRelative(input.targetProject, input.provider, input.targetAlias), Buffer.from(`${JSON.stringify({
        schema: 1, project: input.targetProject, provider: input.provider, alias: input.targetAlias,
        sourceProject: input.sourceProject, sourceAlias: input.sourceAlias,
        expectedIdentity: input.expectedIdentity, fingerprint: source.fingerprint, createdAt: new Date().toISOString(),
      }, null, 2)}\n`));
      return this.metadata(input.targetProject, input.provider, input.targetAlias);
    });
  }

  async withCredential(
    project: string,
    provider: string,
    alias: string,
    operation: (secret: Buffer, metadata: CredentialMetadata) => Promise<void>,
  ): Promise<void> {
    const location = await this.#resolveLocation(project, provider, alias);
    const key = credentialKey(location.project, provider, location.alias);
    await this.#locks.run(key, async () => {
      const metadata = await this.metadata(project, provider, alias);
      const filename = path.join(this.#stateRoot, secretRelative(location.project, provider, location.alias));
      try {
        await assertSafeRegularFile(filename);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          throw new InframuxError('CREDENTIAL_MISSING', `Credential ${project}/${provider}/${alias} is not enrolled`);
        }
        throw error;
      }
      const secret = await readFile(filename);
      const unregister = this.#redactor.registerSecret(secret);
      try {
        await operation(secret, metadata);
      } finally {
        unregister();
        secret.fill(0);
      }
    });
  }

  async remove(project: string, provider: string, alias: string): Promise<boolean> {
    const key = credentialKey(project, provider, alias);
    return this.#locks.run(key, async () => {
      let removed = false;
      for (const relative of [secretRelative(project, provider, alias), metadataRelative(project, provider, alias), bindingRelative(project, provider, alias)]) {
        try {
          await assertSafeRegularFile(path.join(this.#stateRoot, relative));
          await rm(path.join(this.#stateRoot, relative));
          removed = true;
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error;
        }
      }
      return removed;
    });
  }

  async #boundMetadata(project: string, provider: string, alias: string): Promise<CredentialMetadata> {
    const filename = path.join(this.#stateRoot, bindingRelative(project, provider, alias));
    try {
      await assertSafeRegularFile(filename);
      const binding = bindingSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
      const source = await this.metadata(binding.sourceProject, provider, binding.sourceAlias);
      if (source.fingerprint !== binding.fingerprint || JSON.stringify(source.expectedIdentity) !== JSON.stringify(binding.expectedIdentity)) {
        throw new InframuxError('WRONG_PROVIDER_IDENTITY', 'Credential binding no longer matches its verified profile');
      }
      return Object.freeze({ ...source, project, alias, expectedIdentity: binding.expectedIdentity });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new InframuxError('CREDENTIAL_MISSING', `Credential ${project}/${provider}/${alias} is not enrolled`, {
        recovery: `inframux enroll ${project} --service ${provider}`,
      });
      throw error;
    }
  }

  async #resolveLocation(project: string, provider: string, alias: string): Promise<{ project: string; alias: string }> {
    const bindingFile = path.join(this.#stateRoot, bindingRelative(project, provider, alias));
    try {
      await assertSafeRegularFile(bindingFile);
      const binding = bindingSchema.parse(JSON.parse(await readFile(bindingFile, 'utf8')));
      return { project: binding.sourceProject, alias: binding.sourceAlias };
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { project, alias };
      throw error;
    }
  }
}

function credentialKey(project: string, provider: string, alias: string): string {
  return [project, provider, alias].map((value) => identifier.parse(value)).join('/');
}

function secretRelative(project: string, provider: string, alias: string): string {
  credentialKey(project, provider, alias);
  return path.join('credentials', project, provider, `${alias}.secret`);
}

function metadataRelative(project: string, provider: string, alias: string): string {
  credentialKey(project, provider, alias);
  return path.join('metadata', 'credentials', project, provider, `${alias}.json`);
}

function bindingRelative(project: string, provider: string, alias: string): string {
  credentialKey(project, provider, alias);
  return path.join('metadata', 'credential-bindings', project, provider, `${alias}.json`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
