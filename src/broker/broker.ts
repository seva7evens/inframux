import { randomUUID } from 'node:crypto';

import type { ProjectCatalog } from '../config/schemas.js';
import { InframuxError } from '../core/errors.js';
import type { JsonValue } from '../core/json.js';
import { renderAgentIntegrationGuide } from '../integration/agent-config.js';
import { ProviderAdapterRegistry } from '../providers/adapters/index.js';
import { refreshGoogleCredential } from '../providers/google-oauth.js';
import { decodeOAuthCredential, encodeOAuthCredential, type OAuthCredential, type OAuthRefreshResult } from '../providers/oauth.js';
import { validateProviderCommand } from '../providers/command-policy.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderDefinition } from '../providers/types.js';
import type { AuditInput } from '../security/audit.js';
import type { CredentialMetadata, CredentialStore } from '../security/credential-store.js';
import type { Redactor } from '../security/redactor.js';
import { KeyedLock } from '../security/locks.js';
import type { EnrolledCatalogStore } from '../trust/catalog-store.js';
import type { OnboardingSessionStore } from '../onboarding/session-store.js';
import { sanitizeServiceConfig } from '../onboarding/config.js';
import { deriveProjectIdentity } from '../onboarding/project.js';
import { projectOnboardingJourney } from '../onboarding/projection.js';
import { journeyError, withJourney } from '../cli/journey.js';
import type { TrustLedger } from '../trust/ledger.js';
import { planCheckoutAccess, probeCheckoutAccess, type CheckoutAccessReport } from '../trust/access.js';
import { PendingTrustStore } from '../trust/pending.js';
import { resolveProjectContext, validateCatalogBinding } from '../trust/resolve.js';
import type { ResolvedProjectContext } from '../trust/types.js';
import type { ExecutionLease, WorkerResult } from '../worker/runner.js';
import {
  callPayloadSchema,
  checkoutPayloadSchema,
  credentialRevokePayloadSchema,
  credentialEnrollmentInfoPayloadSchema,
  credentialStatusPayloadSchema,
  enrollPayloadSchema,
  mcpOpenPayloadSchema,
  mcpSessionPayloadSchema,
  mcpWritePayloadSchema,
  runPayloadSchema,
  trustApprovePayloadSchema,
  trustRequestPayloadSchema,
  trustRevokePayloadSchema,
  onboardingStartPayloadSchema, onboardingSessionPayloadSchema,
  onboardingConfigurePayloadSchema, onboardingVerifiedPayloadSchema,
  onboardingReusePayloadSchema,
  type CallPayload,
  type CheckoutPayload,
  type CredentialRevokePayload,
  type CredentialEnrollmentInfoPayload,
  type CredentialStatusPayload,
  type EnrollPayload,
  type McpOpenPayload,
  type RunPayload,
  type TrustApprovePayload,
  type TrustRequestPayload,
  type TrustRevokePayload,
} from './operations.js';
import type { WorkerExecutor } from './worker-executor.js';

export interface AuditSink {
  append(input: AuditInput): Promise<void>;
  verify?(): Promise<unknown>;
}

export interface BrokerRequestContext {
  readonly callerUid: number;
  readonly signal: AbortSignal;
}

export class Broker {
  readonly #securityMode: 'hardened' | 'user';
  readonly #ledger: TrustLedger;
  readonly #catalogs: EnrolledCatalogStore;
  readonly #credentials: CredentialStore;
  readonly #audit: AuditSink;
  readonly #providers: ProviderRegistry;
  readonly #adapters: ProviderAdapterRegistry;
  readonly #worker: WorkerExecutor;
  readonly #redactor: Redactor | undefined;
  readonly #googleRefresh: (credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthRefreshResult>;
  readonly #oauthLocks = new KeyedLock();
  readonly #pendingTrust: PendingTrustStore | undefined;
  readonly #onboarding: OnboardingSessionStore | undefined;
  readonly #checkoutAccess: (repositoryRoot: string, gitCommonDir: string) => Promise<CheckoutAccessReport>;
  readonly #mcpSessions = new Map<string, {
    project: string;
    provider: string;
    repository: string;
    fingerprint: string;
    callerUid: number;
  }>();

  constructor(options: {
    securityMode: 'hardened' | 'user';
    ledger: TrustLedger;
    catalogs: EnrolledCatalogStore;
    credentials: CredentialStore;
    audit: AuditSink;
    providers: ProviderRegistry;
    adapters?: ProviderAdapterRegistry;
    worker: WorkerExecutor;
    redactor?: Redactor;
    googleRefresh?: (credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthRefreshResult>;
    pendingTrust?: PendingTrustStore;
    onboarding?: OnboardingSessionStore;
    checkoutAccess?: (repositoryRoot: string, gitCommonDir: string) => Promise<CheckoutAccessReport>;
  }) {
    this.#securityMode = options.securityMode;
    this.#ledger = options.ledger;
    this.#catalogs = options.catalogs;
    this.#credentials = options.credentials;
    this.#audit = options.audit;
    this.#providers = options.providers;
    this.#adapters = options.adapters ?? new ProviderAdapterRegistry([]);
    this.#worker = options.worker;
    this.#redactor = options.redactor;
    this.#googleRefresh = options.googleRefresh ?? ((credential, signal) => refreshGoogleCredential(credential, { signal }));
    this.#pendingTrust = options.pendingTrust;
    this.#onboarding = options.onboarding;
    this.#checkoutAccess = options.checkoutAccess ?? (options.securityMode === 'user'
      ? async () => Object.freeze({ ready: true as const })
      : probeCheckoutAccess);
  }

  async handle(operation: string, payload: unknown, context: BrokerRequestContext): Promise<JsonValue> {
    if (context.signal.aborted) throw new Error('Broker request cancelled');
    switch (operation) {
      case 'project.resolve':
        return this.#resolve(checkoutPayloadSchema.parse(payload)).then(({ resolved }) => resolved as unknown as JsonValue);
      case 'status':
        return this.#status(checkoutPayloadSchema.parse(payload));
      case 'doctor':
        return this.#doctor(checkoutPayloadSchema.parse(payload), context);
      case 'audit.verify': {
        await this.#resolve(checkoutPayloadSchema.parse(payload));
        if (this.#audit.verify === undefined) throw new InframuxError('AUDIT_UNAVAILABLE', 'Audit verification is unavailable');
        return JSON.parse(JSON.stringify(await this.#audit.verify())) as JsonValue;
      }
      case 'agent.instructions': {
        const { resolved, catalog } = await this.#resolve(checkoutPayloadSchema.parse(payload));
        return {
          schema: 1,
          project: resolved.project,
          providers: Object.keys(catalog.services).sort(),
          agentInstructions: renderAgentIntegrationGuide({
            project: resolved.project,
            providers: Object.keys(catalog.services),
          }),
        };
      }
      case 'credential.enroll':
        return this.#enroll(enrollPayloadSchema.parse(payload), context);
      case 'onboarding.start': {
        const input = onboardingStartPayloadSchema.parse(payload);
        const identity = deriveProjectIdentity(input.evidence.normalizedRemotes);
        if (identity.id !== input.project) throw new InframuxError('WRONG_PROVIDER_IDENTITY', 'Onboarding project does not match canonical remote');
        for (const provider of input.providers) this.#providers.require(provider);
        const session = await this.#requireOnboarding().create({
          callerUid: context.callerUid, project: input.project, displayName: input.displayName,
          evidence: { ...input.evidence, normalizedRemotes: [...input.evidence.normalizedRemotes] },
          workspaceRoot: input.workspaceRoot, providers: input.providers,
        });
        const access = await this.#checkoutAccess(session.evidence.repositoryRoot, session.evidence.gitCommonDir);
        return withJourney({
          schema: 1, id: session.id, project: session.project,
          plan: session.providers.map((id) => {
            const onboarding = this.#providers.require(id).onboarding;
            return { id, auth: onboarding.auth, requiredConfig: [...onboarding.requiredConfig],
              optionalConfig: [...onboarding.optionalConfig], setupUrl: onboarding.setupUrl,
              documentationUrl: onboarding.documentationUrl };
          }),
          next: `inframux onboard configure ${session.id} --service <provider> --input-json '<non-secret-json>'`,
        }, projectOnboardingJourney(session, this.#providers, access.ready ? 'ready' : 'required')) as unknown as JsonValue;
      }
      case 'onboarding.checkout-access': {
        const input = onboardingSessionPayloadSchema.parse(payload);
        const session = await this.#requireOnboarding().get(input.sessionId, context.callerUid);
        const report = await this.#checkoutAccess(session.evidence.repositoryRoot, session.evidence.gitCommonDir);
        return planCheckoutAccess({
          repositoryRoot: session.evidence.repositoryRoot,
          gitCommonDir: session.evidence.gitCommonDir,
          report,
        }) as unknown as JsonValue;
      }
      case 'onboarding.status': {
        const input = onboardingSessionPayloadSchema.parse(payload);
        const session = await this.#requireOnboarding().get(input.sessionId, context.callerUid);
        return withJourney(session, projectOnboardingJourney(session, this.#providers, 'ready')) as unknown as JsonValue;
      }
      case 'onboarding.resume': {
        const input = onboardingSessionPayloadSchema.parse(payload);
        const current = await this.#requireOnboarding().get(input.sessionId, context.callerUid);
        if (current.completedAt !== undefined) return this.#onboardingCompletionResult(current);
        const session = await this.#reconcileOnboarding(input.sessionId, context.callerUid);
        return withJourney(session, projectOnboardingJourney(session, this.#providers, 'ready')) as unknown as JsonValue;
      }
      case 'onboarding.configure': {
        const input = onboardingConfigurePayloadSchema.parse(payload);
        const current = await this.#requireOnboarding().get(input.sessionId, context.callerUid);
        const config = sanitizeServiceConfig(this.#providers.require(input.provider), input.input);
        const session = await this.#requireOnboarding().configure(input.sessionId, context.callerUid, input.provider, {
          ...config, credential: `${current.project}-${input.provider}-admin`,
        });
        await this.#enrollSessionCatalog(session);
        return withJourney(session, projectOnboardingJourney(session, this.#providers, 'ready')) as unknown as JsonValue;
      }
      case 'onboarding.provider-verified': {
        const input = onboardingVerifiedPayloadSchema.parse(payload);
        const session = await this.#requireOnboarding().get(input.sessionId, context.callerUid);
        const config = session.services[input.provider]?.config;
        if (config === undefined) throw new Error(`Provider is not configured: ${input.provider}`);
        const alias = typeof config.credential === 'string' ? config.credential : input.provider;
        await this.#credentials.metadata(session.project, input.provider, alias);
        const verified = await this.#requireOnboarding().markVerified(input.sessionId, context.callerUid, input.provider, input.profile);
        return withJourney(verified, projectOnboardingJourney(verified, this.#providers, 'ready')) as unknown as JsonValue;
      }
      case 'onboarding.reuse': {
        const input = onboardingReusePayloadSchema.parse(payload);
        const session = await this.#requireOnboarding().get(input.sessionId, context.callerUid);
        const config = session.services[input.provider]?.config;
        if (config === undefined) throw new Error(`Provider must be configured before reuse: ${input.provider}`);
        const provider = this.#providers.require(input.provider);
        const targetAlias = typeof config.credential === 'string' ? config.credential : `${session.project}-${input.provider}-admin`;
        const expectedIdentity = expectedIdentityFromCatalog(provider, config, {});
        await this.#credentials.bindExisting({
          sourceProject: input.sourceProject, sourceAlias: `${input.sourceProject}-${input.provider}-admin`,
          targetProject: session.project, targetAlias, provider: input.provider, expectedIdentity,
        });
        const verified = await this.#requireOnboarding().markVerified(input.sessionId, context.callerUid, input.provider, targetAlias);
        return withJourney(verified, projectOnboardingJourney(verified, this.#providers, 'ready')) as unknown as JsonValue;
      }
      case 'onboarding.finish': {
        const input = onboardingSessionPayloadSchema.parse(payload);
        const current = await this.#requireOnboarding().get(input.sessionId, context.callerUid);
        if (current.completedAt !== undefined) return this.#onboardingCompletionResult(current);
        const access = await this.#checkoutAccess(current.evidence.repositoryRoot, current.evidence.gitCommonDir);
        if (!access.ready) {
          throw journeyError(
            'BROKER_CHECKOUT_INACCESSIBLE',
            `The hardened broker cannot traverse checkout ancestor: ${access.inaccessibleAncestor}`,
            projectOnboardingJourney(current, this.#providers, 'required'),
          );
        }
        const session = await this.#reconcileOnboarding(input.sessionId, context.callerUid);
        const incomplete = session.providers.filter((provider) => session.services[provider]?.profile === undefined);
        if (incomplete.length > 0) {
          throw journeyError(
            'SESSION_AUTHORIZATION_REQUIRED',
            `Cannot complete onboarding; incomplete providers: ${incomplete.join(', ')}`,
            projectOnboardingJourney(session, this.#providers, 'ready'),
          );
        }
        await this.#enrollSessionCatalog(session);
        await this.#ledger.approve({
          schema: 1, project: session.project, repositoryRoot: session.evidence.repositoryRoot,
          gitCommonDir: session.evidence.gitCommonDir, canonicalRemote: session.evidence.normalizedRemotes[0]!,
          workspaceRoot: session.workspaceRoot, manifestDigest: session.evidence.manifestDigest,
          approvedAt: new Date().toISOString(),
        });
        const completed = await this.#requireOnboarding().complete(input.sessionId, context.callerUid);
        return this.#onboardingCompletionResult(completed);
      }
      case 'credential.enrollment-info':
        return this.#credentialEnrollmentInfo(credentialEnrollmentInfoPayloadSchema.parse(payload));
      case 'credential.status':
        return this.#credentialStatus(credentialStatusPayloadSchema.parse(payload));
      case 'credential.revoke':
        return this.#revokeCredential(credentialRevokePayloadSchema.parse(payload), context);
      case 'trust.request':
        return this.#requestTrust(trustRequestPayloadSchema.parse(payload));
      case 'trust.approve':
        return this.#approveTrust(trustApprovePayloadSchema.parse(payload), context);
      case 'trust.revoke':
        return this.#revokeTrust(trustRevokePayloadSchema.parse(payload), context);
      case 'run':
        return this.#run(runPayloadSchema.parse(payload), context);
      case 'call':
        return this.#call(callPayloadSchema.parse(payload), context);
      case 'mcp.open':
        return this.#openMcp(mcpOpenPayloadSchema.parse(payload), context);
      case 'mcp.write': {
        const input = mcpWritePayloadSchema.parse(payload);
        this.#requireMcpSession(input.sessionId, context);
        await this.#worker.writeMcp(input.sessionId, Buffer.from(input.chunkBase64, 'base64'));
        return { ok: true };
      }
      case 'mcp.end': {
        const input = mcpSessionPayloadSchema.parse(payload);
        this.#requireMcpSession(input.sessionId, context);
        await this.#worker.endMcp(input.sessionId);
        return { ok: true };
      }
      case 'mcp.read': {
        const input = mcpSessionPayloadSchema.parse(payload);
        this.#requireMcpSession(input.sessionId, context);
        const read = await this.#worker.readMcp(input.sessionId);
        return {
          stdoutBase64: read.stdout.toString('base64'),
          stderrBase64: read.stderr.toString('base64'),
          eof: read.eof,
        };
      }
      case 'mcp.close': {
        const input = mcpSessionPayloadSchema.parse(payload);
        const session = this.#requireMcpSession(input.sessionId, context);
        await this.#worker.closeMcp(input.sessionId);
        this.#mcpSessions.delete(input.sessionId);
        await this.#appendAudit({
          context,
          project: session.project,
          repository: session.repository,
          provider: session.provider,
          operation: 'mcp.close',
          resource: input.sessionId,
          result: 'success',
          fingerprint: session.fingerprint,
          durationMs: 0,
        });
        return { ok: true };
      }
      default:
        throw new InframuxError('INVALID_REQUEST', `Unknown broker operation: ${operation}`);
    }
  }

  #requireOnboarding(): OnboardingSessionStore {
    if (this.#onboarding === undefined) throw new InframuxError('INVALID_REQUEST', 'Universal onboarding is unavailable');
    return this.#onboarding;
  }

  async #reconcileOnboarding(sessionId: string, callerUid: number) {
    let session = await this.#requireOnboarding().get(sessionId, callerUid);
    for (const provider of session.providers) {
      const service = session.services[provider];
      if (service?.profile !== undefined || service?.config === undefined) continue;
      const alias = typeof service.config.credential === 'string' ? service.config.credential : `${session.project}-${provider}-admin`;
      try {
        await this.#credentials.metadata(session.project, provider, alias);
        session = await this.#requireOnboarding().markVerified(sessionId, callerUid, provider, alias);
      } catch (error) {
        if (!(error instanceof InframuxError) || error.code !== 'CREDENTIAL_MISSING') throw error;
      }
    }
    return session;
  }

  #onboardingCompletionResult(session: Awaited<ReturnType<OnboardingSessionStore['get']>>): JsonValue {
    return withJourney({
      schema: 1,
      project: session.project,
      providers: session.providers,
      agentInstructions: renderAgentIntegrationGuide({ project: session.project, providers: session.providers }),
    }, projectOnboardingJourney(session, this.#providers, 'ready')) as unknown as JsonValue;
  }

  async #enrollSessionCatalog(session: Awaited<ReturnType<OnboardingSessionStore['get']>>): Promise<void> {
    const services: Record<string, Record<string, unknown>> = {};
    for (const provider of session.providers) {
      const config = session.services[provider]?.config;
      if (config !== undefined) services[provider] = { ...config };
    }
    await this.#catalogs.enroll({
      schema: 1, id: session.project, displayName: session.displayName,
      repositories: session.evidence.normalizedRemotes.map((remote) => ({ remote })), services,
    });
  }

  async #resolve(payload: CheckoutPayload): Promise<{
    resolved: ResolvedProjectContext;
    catalog: ProjectCatalog;
  }> {
    const catalog = await this.#catalogs.get(payload.manifest.registry);
    const resolved = await resolveProjectContext({
      evidence: payload.evidence,
      manifest: payload.manifest,
      catalog,
      ledger: this.#ledger,
    });
    return { resolved, catalog };
  }

  async #status(payload: CheckoutPayload): Promise<JsonValue> {
    const { resolved, catalog } = await this.#resolve(payload);
    const providers = await this.#providerCredentialStatus(resolved.project, catalog);
    return {
      schema: 1,
      securityMode: this.#securityMode,
      project: resolved.project,
      repository: resolved.canonicalRemote,
      checkoutApproved: true,
      providers,
    };
  }

  async #credentialStatus(payload: CredentialStatusPayload): Promise<JsonValue> {
    const catalog = await this.#catalogs.get(payload.project);
    return {
      schema: 1,
      project: payload.project,
      providers: await this.#providerCredentialStatus(payload.project, catalog),
    };
  }

  async #credentialEnrollmentInfo(payload: CredentialEnrollmentInfoPayload): Promise<JsonValue> {
    const catalog = await this.#catalogs.get(payload.project);
    const service = serviceRecord(catalog, payload.provider);
    const provider = this.#providers.require(payload.provider);
    const expectedIdentity = expectedIdentityFromCatalog(provider, service, {});
    const rawScopes = service.scopes;
    const scopes = rawScopes === undefined
      ? []
      : Array.isArray(rawScopes) && rawScopes.every((scope) => typeof scope === 'string')
        ? [...new Set(rawScopes)].sort()
        : (() => { throw new Error(`Catalog contains invalid scopes for ${payload.provider}`); })();
    return { schema: 1, project: payload.project, provider: payload.provider, expectedIdentity, scopes };
  }

  async #providerCredentialStatus(project: string, catalog: ProjectCatalog): Promise<Array<Record<string, JsonValue>>> {
    const providers: Array<Record<string, JsonValue>> = [];
    for (const providerId of Object.keys(catalog.services).sort()) {
      const service = serviceRecord(catalog, providerId);
      const alias = credentialAlias(service, providerId);
      try {
        const metadata = await this.#credentials.metadata(project, providerId, alias);
        providers.push({
          id: providerId,
          credential: alias,
          health: credentialHealth(metadata),
          identity: metadata.expectedIdentity,
          lastVerifiedAt: metadata.lastVerifiedAt,
          fingerprint: metadata.fingerprint,
        });
      } catch (error) {
        if (!(error instanceof InframuxError) || error.code !== 'CREDENTIAL_MISSING') throw error;
        providers.push({ id: providerId, credential: alias, health: 'missing' });
      }
    }
    return providers;
  }

  async #doctor(payload: CheckoutPayload, context: BrokerRequestContext): Promise<JsonValue> {
    const { resolved, catalog } = await this.#resolve(payload);
    const providers: Array<Record<string, JsonValue>> = [];
    for (const providerId of Object.keys(catalog.services).sort()) {
      const service = serviceRecord(catalog, providerId);
      const alias = credentialAlias(service, providerId);
      try {
        const provider = this.#providers.require(providerId);
        if (provider.id === 'google-cloud') await this.#refreshGoogleIfNeeded(resolved.project, alias, context.signal, false);
        let identity: Readonly<Record<string, string>> | undefined;
        let resources: JsonValue = null;
        await this.#credentials.withCredential(resolved.project, providerId, alias, async (secret, metadata) => {
          assertCatalogIdentity(service, metadata.expectedIdentity);
          if (provider.id === 'synthetic') {
            identity = await this.#verifyIdentity(provider, resolved.project, service, secret, metadata.expectedIdentity, context.signal);
          } else {
            const verified = await this.#requireAdapter(providerId).verify({
              project: resolved.project, secret, service, signal: context.signal,
            });
            identity = verified.identity;
            resources = verified.resources;
          }
        });
        if (identity === undefined) throw new Error('Provider doctor returned no identity');
        providers.push({ id: providerId, health: 'healthy', identity, resources });
      } catch (error) {
        if (error instanceof InframuxError) {
          providers.push({
            id: providerId,
            health: doctorHealth(error.code),
            error: error.code,
            ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
          });
          continue;
        }
        throw error;
      }
    }
    return {
      schema: 1,
      securityMode: this.#securityMode,
      project: resolved.project,
      repository: resolved.canonicalRemote,
      checkoutApproved: true,
      providers,
    };
  }

  async #enroll(payload: EnrollPayload, context: BrokerRequestContext): Promise<JsonValue> {
    const catalog = await this.#catalogs.get(payload.project);
    const service = serviceRecord(catalog, payload.provider);
    const alias = credentialAlias(service, payload.provider);
    const provider = this.#providers.require(payload.provider);
    if (payload.alias !== undefined && alias !== payload.alias) throw new InframuxError('WRONG_PROVIDER_IDENTITY', 'Credential alias does not match enrolled catalog');
    assertCatalogIdentity(service, payload.expectedIdentity);
    const expectedIdentity = expectedIdentityFromCatalog(provider, service, payload.expectedIdentity);
    const secret = Buffer.from(payload.secretBase64, 'base64');
    let identity: Readonly<Record<string, string>>;
    try {
      identity = await this.#verifyIdentity(provider, payload.project, service, secret, expectedIdentity, context.signal);
      const expiresAt = provider.id === 'google-cloud' ? decodeOAuthCredential(secret).expiresAt : null;
      const metadata = await this.#credentials.put({
        project: payload.project,
        provider: payload.provider,
        alias,
        credentialType: payload.credentialType,
        expectedIdentity,
        secret,
        expiresAt,
        lastVerifiedAt: new Date().toISOString(),
      });
      await this.#drainProviderSessions(payload.project, payload.provider);
      await this.#appendAudit({
        context,
        project: payload.project,
        repository: 'enrollment',
        provider: payload.provider,
        operation: 'credential.enroll',
        resource: alias,
        result: 'success',
        fingerprint: metadata.fingerprint,
        durationMs: 0,
      });
      return { schema: 1, project: payload.project, provider: payload.provider, alias, identity, metadata } as unknown as JsonValue;
    } finally {
      secret.fill(0);
    }
  }

  async #run(payload: RunPayload, context: BrokerRequestContext): Promise<JsonValue> {
    const started = Date.now();
    const { resolved, catalog } = await this.#resolve(payload);
    const provider = this.#providers.require(payload.provider);
    const args = validateProviderCommand(provider, payload.args);
    const service = serviceRecord(catalog, payload.provider);
    const alias = credentialAlias(service, payload.provider);
    let result: WorkerResult | undefined;
    let metadata: CredentialMetadata | undefined;
    await this.#credentials.withCredential(resolved.project, payload.provider, alias, async (secret, current) => {
      metadata = current;
      assertCatalogIdentity(service, current.expectedIdentity);
      if (identityIsStale(current, provider.identity.maxAgeMs)) {
        await this.#verifyIdentity(provider, resolved.project, service, secret, current.expectedIdentity, context.signal);
      }
      result = await this.#worker.run(this.#lease(provider, resolved.project, current, secret, args), context.signal);
    });
    if (result === undefined || metadata === undefined) throw new Error('Worker returned no result');
    const serialized = JSON.stringify(result);
    this.#redactor?.assertClean(serialized);
    await this.#appendAudit({
      context,
      project: resolved.project,
      repository: resolved.canonicalRemote,
      provider: payload.provider,
      operation: `cli.${args[0]}`,
      resource: args[0] ?? 'command',
      result: result.exitCode === 0 ? 'success' : 'failure',
      fingerprint: metadata.fingerprint,
      durationMs: Date.now() - started,
    });
    return { schema: 1, project: resolved.project, provider: payload.provider, ...result } as unknown as JsonValue;
  }

  async #call(payload: CallPayload, context: BrokerRequestContext): Promise<JsonValue> {
    const started = Date.now();
    const { resolved, catalog } = await this.#resolve(payload);
    const service = serviceRecord(catalog, payload.provider);
    const provider = this.#providers.require(payload.provider);
    const capability = provider.capabilities.find((candidate) => candidate.operation === payload.operation);
    if (capability === undefined || capability.support === 'unsupported' || capability.classification === 'source-bound') {
      throw new InframuxError(
        capability?.classification === 'source-bound' ? 'SOURCE_BOUND_OPERATION' : 'UNSUPPORTED_PROVIDER_OPERATION',
        `Provider operation is source-bound or unsupported: ${payload.provider}/${payload.operation}`,
      );
    }
    if (payload.provider === 'synthetic' && payload.operation === 'resources.list') {
      return this.#run({ ...payload, args: ['resources'] }, context);
    }
    const alias = credentialAlias(service, payload.provider);
    let result: JsonValue | undefined;
    let metadata: CredentialMetadata | undefined;
    if (provider.id === 'google-cloud') await this.#refreshGoogleIfNeeded(resolved.project, alias, context.signal, false);
    const invoke = () => this.#credentials.withCredential(resolved.project, payload.provider, alias, async (secret, current) => {
        metadata = current;
        assertCatalogIdentity(service, current.expectedIdentity);
        const adapter = this.#requireAdapter(payload.provider);
        if (identityIsStale(current, provider.identity.maxAgeMs) || capability.destructive) {
          await this.#verifyIdentity(provider, resolved.project, service, secret, current.expectedIdentity, context.signal);
        }
        if (payload.operation === 'resources.list' || payload.operation === 'identity.verify') {
          const verified = await adapter.verify({ project: resolved.project, secret, service, signal: context.signal });
          result = payload.operation === 'identity.verify'
            ? { identity: verified.identity, resources: verified.resources }
            : verified.resources;
        } else {
          result = await adapter.call({
            project: resolved.project,
            secret,
            service,
            operation: payload.operation,
            input: payload.input,
            signal: context.signal,
          });
        }
      });
    try {
      await invoke();
    } catch (error) {
      if (!(error instanceof InframuxError) || error.code !== 'TOKEN_EXPIRED' || provider.id !== 'google-cloud') throw error;
      result = undefined;
      metadata = undefined;
      await this.#refreshGoogleIfNeeded(resolved.project, alias, context.signal, true);
      await invoke();
    }
    if (result === undefined || metadata === undefined) throw new Error('Provider adapter returned no result');
    this.#redactor?.assertClean(JSON.stringify(result));
    await this.#appendAudit({
      context,
      project: resolved.project,
      repository: resolved.canonicalRemote,
      provider: payload.provider,
      operation: payload.operation,
      resource: resourceFromCall(payload),
      result: 'success',
      fingerprint: metadata.fingerprint,
      durationMs: Date.now() - started,
    });
    return result;
  }

  async #revokeCredential(payload: CredentialRevokePayload, context: BrokerRequestContext): Promise<JsonValue> {
    const catalog = await this.#catalogs.get(payload.project);
    const service = serviceRecord(catalog, payload.provider);
    const alias = credentialAlias(service, payload.provider);
    let metadata: CredentialMetadata;
    try {
      metadata = await this.#credentials.metadata(payload.project, payload.provider, alias);
    } catch (error) {
      if (error instanceof InframuxError && error.code === 'CREDENTIAL_MISSING') {
        return { removed: false, project: payload.project, provider: payload.provider };
      }
      throw error;
    }
    await this.#drainProviderSessions(payload.project, payload.provider);
    const removed = await this.#credentials.remove(payload.project, payload.provider, alias);
    await this.#appendAudit({
      context,
      project: payload.project,
      repository: 'credential-management',
      provider: payload.provider,
      operation: 'credential.revoke',
      resource: alias,
      result: 'success',
      fingerprint: metadata.fingerprint,
      durationMs: 0,
    });
    return { removed, project: payload.project, provider: payload.provider };
  }

  async #requestTrust(payload: TrustRequestPayload): Promise<JsonValue> {
    const pendingTrust = this.#requirePendingTrust();
    const catalog = await this.#catalogs.get(payload.manifest.registry);
    const canonicalRemote = validateCatalogBinding({
      evidence: payload.evidence,
      manifest: payload.manifest,
      catalog,
    });
    const pending = await pendingTrust.create({
      project: payload.manifest.project,
      evidence: payload.evidence,
      canonicalRemote,
      workspaceRoot: payload.workspaceRoot,
    });
    return {
      ...pending,
      agentInstructions: renderAgentIntegrationGuide({
        project: payload.manifest.project,
        providers: Object.keys(catalog.services),
      }),
    } as unknown as JsonValue;
  }

  async #approveTrust(payload: TrustApprovePayload, context: BrokerRequestContext): Promise<JsonValue> {
    const pendingTrust = this.#requirePendingTrust();
    const pending = await pendingTrust.get(payload.requestId);
    await this.#ledger.approve({
      schema: 1,
      project: pending.project,
      repositoryRoot: pending.repositoryRoot,
      gitCommonDir: pending.gitCommonDir,
      canonicalRemote: pending.canonicalRemote,
      workspaceRoot: pending.workspaceRoot,
      manifestDigest: pending.manifestDigest,
      approvedAt: new Date().toISOString(),
    });
    await pendingTrust.consume(payload.requestId);
    await this.#appendAudit({
      context,
      project: pending.project,
      repository: pending.canonicalRemote,
      provider: 'local-trust',
      operation: 'trust.approve',
      resource: pending.repositoryRoot,
      result: 'success',
      fingerprint: 'none',
      durationMs: 0,
    });
    return { approved: true, project: pending.project, repositoryRoot: pending.repositoryRoot };
  }

  async #revokeTrust(payload: TrustRevokePayload, context: BrokerRequestContext): Promise<JsonValue> {
    const removed = await this.#ledger.revoke(payload.repositoryRoot);
    await this.#appendAudit({
      context,
      project: 'local-trust',
      repository: payload.repositoryRoot,
      provider: 'local-trust',
      operation: 'trust.revoke',
      resource: payload.repositoryRoot,
      result: 'success',
      fingerprint: 'none',
      durationMs: 0,
    });
    return { revoked: removed, repositoryRoot: payload.repositoryRoot };
  }

  #requirePendingTrust(): PendingTrustStore {
    if (this.#pendingTrust === undefined) throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', 'Pending trust storage is not configured');
    return this.#pendingTrust;
  }

  async #openMcp(payload: McpOpenPayload, context: BrokerRequestContext): Promise<JsonValue> {
    const { resolved, catalog } = await this.#resolve(payload);
    const provider = this.#providers.require(payload.provider);
    if (provider.executables.mcp === undefined || !provider.capabilities.some((item) => item.operation === 'mcp.launch' && item.support !== 'unsupported')) {
      throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', `Provider has no approved official MCP: ${payload.provider}`);
    }
    const service = serviceRecord(catalog, payload.provider);
    const alias = credentialAlias(service, payload.provider);
    let sessionId: string | undefined;
    let metadata: CredentialMetadata | undefined;
    await this.#credentials.withCredential(resolved.project, payload.provider, alias, async (secret, current) => {
      metadata = current;
      assertCatalogIdentity(service, current.expectedIdentity);
      if (identityIsStale(current, provider.identity.maxAgeMs)) {
        await this.#verifyIdentity(provider, resolved.project, service, secret, current.expectedIdentity, context.signal);
      }
      sessionId = await this.#worker.openMcp(this.#mcpLease(provider, resolved.project, current, secret), context.signal);
    });
    if (sessionId === undefined || metadata === undefined) throw new Error('Worker did not open MCP session');
    this.#mcpSessions.set(sessionId, {
      project: resolved.project,
      provider: payload.provider,
      repository: resolved.canonicalRemote,
      fingerprint: metadata.fingerprint,
      callerUid: context.callerUid,
    });
    try {
      await this.#appendAudit({
        context,
        project: resolved.project,
        repository: resolved.canonicalRemote,
        provider: payload.provider,
        operation: 'mcp.open',
        resource: sessionId,
        result: 'success',
        fingerprint: metadata.fingerprint,
        durationMs: 0,
      });
    } catch (error) {
      this.#mcpSessions.delete(sessionId);
      await this.#worker.closeMcp(sessionId);
      throw error;
    }
    return { sessionId };
  }

  async #verifyIdentity(
    provider: ProviderDefinition,
    project: string,
    service: Readonly<Record<string, unknown>>,
    secret: Buffer,
    expectedIdentity: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, string>>> {
    if (provider.id !== 'synthetic') {
      const verified = await this.#requireAdapter(provider.id).verify({ project, secret, service, signal });
      for (const field of provider.identity.expectedFields) {
        if (verified.identity[field] !== expectedIdentity[field]) {
          throw new InframuxError('WRONG_PROVIDER_IDENTITY', `Wrong provider identity for ${field}`);
        }
      }
      return verified.identity;
    }
    const metadata: CredentialMetadata = {
      schema: 1,
      project,
      provider: provider.id,
      alias: 'enrollment-probe',
      credentialType: 'probe',
      expectedIdentity: { ...expectedIdentity },
      createdAt: new Date().toISOString(),
      expiresAt: null,
      lastVerifiedAt: null,
      fingerprint: 'hmac-sha256:enrollment-probe',
    };
    const result = await this.#worker.run(this.#lease(provider, project, metadata, secret, ['identity']), signal);
    if (result.exitCode !== 0) throw new InframuxError('WRONG_PROVIDER_IDENTITY', 'Provider identity check failed');
    let identity: Record<string, string>;
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('identity must be an object');
      identity = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== 'string') throw new Error(`identity field is not a string: ${key}`);
        return [key, value];
      }));
    } catch (error) {
      throw new InframuxError('WRONG_PROVIDER_IDENTITY', 'Provider returned invalid identity data', { cause: error });
    }
    for (const field of provider.identity.expectedFields) {
      if (identity[field] !== expectedIdentity[field]) {
        throw new InframuxError('WRONG_PROVIDER_IDENTITY', `Wrong provider identity for ${field}`);
      }
    }
    return Object.freeze(identity);
  }

  #requireAdapter(provider: string) {
    try {
      return this.#adapters.require(provider);
    } catch (error) {
      throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', `Production adapter is not installed: ${provider}`, { cause: error });
    }
  }

  async #refreshGoogleIfNeeded(project: string, alias: string, signal: AbortSignal, force: boolean): Promise<void> {
    await this.#oauthLocks.run(`${project}/google-cloud`, async () => {
      let credential: OAuthCredential | undefined;
      let metadata: CredentialMetadata | undefined;
      await this.#credentials.withCredential(project, 'google-cloud', alias, async (secret, current) => {
        credential = decodeOAuthCredential(secret);
        metadata = current;
      });
      if (credential === undefined || metadata === undefined) throw new Error('Google OAuth credential could not be loaded');
      if (!force && Date.parse(credential.expiresAt) - Date.now() > 5 * 60_000) return;
      const refreshed = await this.#googleRefresh(credential, signal);
      const next: OAuthCredential = {
        ...credential,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? credential.refreshToken,
        tokenType: refreshed.tokenType,
        scopes: [...refreshed.scopes].sort(),
        expiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1_000).toISOString(),
      };
      const encoded = encodeOAuthCredential(next);
      try {
        await this.#credentials.put({
          project,
          provider: 'google-cloud',
          alias,
          credentialType: metadata.credentialType,
          expectedIdentity: metadata.expectedIdentity,
          secret: encoded,
          createdAt: metadata.createdAt,
          expiresAt: next.expiresAt,
          lastVerifiedAt: metadata.lastVerifiedAt,
        });
      } finally {
        encoded.fill(0);
      }
    });
  }

  #lease(
    provider: ProviderDefinition,
    project: string,
    metadata: CredentialMetadata,
    secret: Buffer,
    args: string[],
  ): ExecutionLease {
    const executableId = provider.executables.cli;
    const credentialEnvironmentVariable = provider.credentialEnvironmentVariable;
    if (executableId === undefined || credentialEnvironmentVariable === undefined) {
      throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', `Provider has no approved CLI credential path: ${provider.id}`);
    }
    return {
      schema: 1,
      leaseId: randomUUID(),
      project,
      provider: provider.id,
      credentialFingerprint: metadata.fingerprint,
      credentialEnvironmentVariable,
      credentialBase64: secret.toString('base64'),
      executableId,
      args,
      publicEnvironment: { INFRAMUX_PROJECT_ID: project },
      timeoutMs: 120_000,
      maxOutputBytes: 4 * 1024 * 1024,
      configFiles: [],
    };
  }

  #mcpLease(
    provider: ProviderDefinition,
    project: string,
    metadata: CredentialMetadata,
    secret: Buffer,
  ): ExecutionLease {
    const executableId = provider.executables.mcp;
    const credentialEnvironmentVariable = provider.credentialEnvironmentVariable;
    if (executableId === undefined || credentialEnvironmentVariable === undefined) {
      throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', `Provider has no approved MCP credential path: ${provider.id}`);
    }
    return {
      schema: 1,
      leaseId: randomUUID(),
      project,
      provider: provider.id,
      credentialFingerprint: metadata.fingerprint,
      credentialEnvironmentVariable,
      credentialBase64: secret.toString('base64'),
      executableId,
      args: [],
      publicEnvironment: { INFRAMUX_PROJECT_ID: project },
      timeoutMs: 15 * 60_000,
      maxOutputBytes: 16 * 1024 * 1024,
      configFiles: [],
    };
  }

  #requireMcpSession(sessionId: string, context: BrokerRequestContext) {
    const session = this.#mcpSessions.get(sessionId);
    if (session === undefined || session.callerUid !== context.callerUid) {
      throw new InframuxError('INVALID_REQUEST', 'Unknown or foreign MCP session');
    }
    return session;
  }

  async #drainProviderSessions(project: string, provider: string): Promise<void> {
    const matching = [...this.#mcpSessions.entries()].filter(([, session]) =>
      session.project === project && session.provider === provider);
    let failure: unknown;
    for (const [sessionId] of matching) {
      try {
        await this.#worker.closeMcp(sessionId);
      } catch (error) {
        failure ??= error;
      } finally {
        this.#mcpSessions.delete(sessionId);
      }
    }
    if (failure !== undefined) throw new Error(`Failed to drain MCP sessions for ${project}/${provider}`, { cause: failure });
  }

  async #appendAudit(input: {
    context: BrokerRequestContext;
    project: string;
    repository: string;
    provider: string;
    operation: string;
    resource: string;
    result: 'success' | 'failure' | 'cancelled';
    fingerprint: string;
    durationMs: number;
  }): Promise<void> {
    try {
      await this.#audit.append({
        securityMode: this.#securityMode,
        callerUid: input.context.callerUid,
        project: input.project,
        repository: input.repository,
        provider: input.provider,
        operation: input.operation,
        resource: input.resource,
        result: input.result,
        credentialFingerprint: input.fingerprint,
        durationMs: input.durationMs,
      });
    } catch (error) {
      throw new InframuxError('AUDIT_UNAVAILABLE', 'Audit durability is unavailable', { cause: error });
    }
  }
}

function serviceRecord(catalog: ProjectCatalog, provider: string): Record<string, unknown> {
  const service = catalog.services[provider];
  if (service === undefined) throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', `Provider is not enrolled for project: ${provider}`);
  return service;
}

function credentialAlias(service: Record<string, unknown>, provider: string): string {
  if (typeof service.credential !== 'string') throw new Error(`Catalog service has no credential alias: ${provider}`);
  return service.credential;
}

function assertCatalogIdentity(service: Record<string, unknown>, expected: Readonly<Record<string, string>>): void {
  for (const [field, value] of Object.entries(expected)) {
    const catalogValue = service[field];
    if (typeof catalogValue === 'string' && catalogValue !== value) {
      throw new InframuxError('WRONG_PROVIDER_IDENTITY', `Expected identity disagrees with catalog field: ${field}`);
    }
  }
}

function identityIsStale(metadata: CredentialMetadata, maxAgeMs: number): boolean {
  if (metadata.lastVerifiedAt === null) return true;
  const verified = Date.parse(metadata.lastVerifiedAt);
  return !Number.isFinite(verified) || Date.now() - verified > maxAgeMs;
}

function credentialHealth(metadata: CredentialMetadata): 'healthy' | 'verification-required' | 'expiring' {
  if (metadata.expiresAt !== null && Date.parse(metadata.expiresAt) - Date.now() <= 5 * 60_000) return 'expiring';
  return metadata.lastVerifiedAt === null ? 'verification-required' : 'healthy';
}

function doctorHealth(code: InframuxError['code']): string {
  switch (code) {
    case 'CREDENTIAL_MISSING': return 'missing';
    case 'WRONG_PROVIDER_IDENTITY': return 'wrong_identity';
    case 'TOKEN_EXPIRED':
    case 'OAUTH_REFRESH_FAILED': return 'requires_interactive_reauth';
    case 'SCOPE_MISSING': return 'scope_missing';
    case 'PROVIDER_UNAVAILABLE':
    case 'RATE_LIMITED': return 'provider_unavailable';
    default: return 'local_error';
  }
}

function resourceFromCall(payload: CallPayload): string {
  if (payload.input !== null && typeof payload.input === 'object' && !Array.isArray(payload.input)) {
    const resource = (payload.input as Record<string, unknown>).path;
    if (typeof resource === 'string') return resource.slice(0, 512);
  }
  return payload.operation;
}

function expectedIdentityFromCatalog(
  provider: ProviderDefinition,
  service: Record<string, unknown>,
  supplied: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const derived = provider.identity.deriveExpected?.(service) ?? {};
  const expected: Record<string, string> = {
    ...supplied,
    ...derived,
  };
  for (const field of provider.identity.expectedFields) {
    const catalogValue = service[field];
    if (typeof catalogValue === 'string' && derived[field] === undefined) expected[field] = catalogValue;
    if (expected[field] === undefined) {
      throw new InframuxError('WRONG_PROVIDER_IDENTITY', `Catalog is missing expected provider identity field: ${field}`);
    }
  }
  return Object.freeze(expected);
}
