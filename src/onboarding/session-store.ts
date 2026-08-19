import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { assertSafeRegularFile, atomicWritePrivateFile } from '../core/safe-files.js';
import { KeyedLock } from '../security/locks.js';

const id = z.string().uuid();
const identifier = z.string().regex(/^[a-z][a-z0-9-]{1,126}$/);
const evidenceSchema = z.object({
  repositoryRoot: z.string().startsWith('/'), gitCommonDir: z.string().startsWith('/'),
  manifestPath: z.string().startsWith('/'), manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  normalizedRemotes: z.array(z.string().min(3)).min(1).max(8),
}).strict();
const serviceSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  profile: identifier.optional(), verifiedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
const sessionSchema = z.object({
  schema: z.literal(1), id, callerUid: z.number().int().nonnegative(), project: identifier,
  displayName: z.string().min(1).max(128), evidence: evidenceSchema,
  workspaceRoot: z.string().startsWith('/'),
  providers: z.array(identifier).min(1), services: z.record(identifier, serviceSchema),
  createdAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

export type OnboardingSession = z.infer<typeof sessionSchema>;

export class OnboardingSessionStore {
  readonly #stateRoot: string;
  readonly #now: () => Date;
  readonly #locks = new KeyedLock();

  constructor(options: { stateRoot: string; now?: () => Date }) {
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: {
    callerUid: number; project: string; displayName: string;
    evidence: z.input<typeof evidenceSchema>; workspaceRoot?: string; providers: readonly string[];
  }): Promise<OnboardingSession> {
    const createdAt = this.#now();
    const providers = [...new Set(input.providers)].sort();
    const session = sessionSchema.parse({
      schema: 1, id: randomUUID(), callerUid: input.callerUid, project: input.project,
      displayName: input.displayName, evidence: input.evidence, providers, services: {},
      workspaceRoot: input.workspaceRoot ?? input.evidence.repositoryRoot,
      createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + 86_400_000).toISOString(),
    });
    await this.#write(session);
    return freeze(session);
  }

  async get(sessionId: string, callerUid: number): Promise<OnboardingSession> {
    id.parse(sessionId);
    const filename = this.#filename(sessionId);
    await assertSafeRegularFile(filename);
    const session = sessionSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    if (session.callerUid !== callerUid) throw new Error('Onboarding session belongs to a different user');
    return freeze(session);
  }

  async configure(sessionId: string, callerUid: number, provider: string, config: Readonly<Record<string, unknown>>): Promise<OnboardingSession> {
    return this.#mutate(sessionId, callerUid, (session) => {
      this.#assertMutable(session);
      if (!session.providers.includes(provider)) throw new Error(`Provider is not requested by this onboarding session: ${provider}`);
      const current = session.services[provider]?.config;
      if (current !== undefined) {
        if (JSON.stringify(current) === JSON.stringify(config)) return session;
        throw new Error(`Provider is already configured: ${provider}`);
      }
      return { ...session, services: { ...session.services, [provider]: { config: structuredClone(config) } } };
    });
  }

  async markVerified(sessionId: string, callerUid: number, provider: string, profile: string): Promise<OnboardingSession> {
    return this.#mutate(sessionId, callerUid, (session) => {
      this.#assertMutable(session);
      const service = session.services[provider];
      if (service?.config === undefined) throw new Error(`Provider must be configured before verification: ${provider}`);
      if (service.profile === profile) return session;
      if (service.profile !== undefined) throw new Error(`Provider is already verified: ${provider}`);
      return { ...session, services: { ...session.services, [provider]: {
        ...service, profile: identifier.parse(profile), verifiedAt: this.#now().toISOString(),
      } } };
    });
  }

  async complete(sessionId: string, callerUid: number): Promise<OnboardingSession> {
    return this.#mutate(sessionId, callerUid, (session) => {
      if (session.completedAt !== undefined) return session;
      this.#assertMutable(session);
      const incomplete = session.providers.filter((provider) => session.services[provider]?.profile === undefined);
      if (incomplete.length > 0) throw new Error(`Cannot complete onboarding; incomplete providers: ${incomplete.join(', ')}`);
      return { ...session, completedAt: this.#now().toISOString() };
    });
  }

  async #mutate(sessionId: string, callerUid: number, update: (session: OnboardingSession) => OnboardingSession): Promise<OnboardingSession> {
    return this.#locks.run(id.parse(sessionId), async () => {
      const current = await this.get(sessionId, callerUid);
      const next = sessionSchema.parse(update(current));
      if (JSON.stringify(current) !== JSON.stringify(next)) await this.#write(next);
      return freeze(next);
    });
  }

  #assertMutable(session: OnboardingSession): void {
    if (session.completedAt !== undefined) throw new Error('Onboarding session is already complete');
    if (this.#now().getTime() > Date.parse(session.expiresAt)) throw new Error('Onboarding session expired');
  }

  #filename(sessionId: string): string { return path.join(this.#stateRoot, 'onboarding', `${id.parse(sessionId)}.json`); }

  async #write(session: OnboardingSession): Promise<void> {
    await atomicWritePrivateFile(this.#stateRoot, path.join('onboarding', `${session.id}.json`), Buffer.from(`${JSON.stringify(session, null, 2)}\n`));
  }
}

function freeze(session: OnboardingSession): OnboardingSession {
  Object.freeze(session.evidence.normalizedRemotes); Object.freeze(session.evidence); Object.freeze(session.providers);
  for (const service of Object.values(session.services)) { if (service.config !== undefined) Object.freeze(service.config); Object.freeze(service); }
  Object.freeze(session.services); return Object.freeze(session);
}
