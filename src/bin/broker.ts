#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Broker } from '../broker/broker.js';
import { startBrokerSystem } from '../broker/service.js';
import { RpcWorkerExecutor } from '../broker/worker-executor.js';
import { assertSafeRegularFile } from '../core/safe-files.js';
import { assertRuntimeVersion } from '../core/version.js';
import { clearDaemonDiagnostic, writeDaemonDiagnostic } from '../install/daemon-diagnostic.js';
import { createProviderAdapterRegistry } from '../providers/adapters/index.js';
import { googleApiOrigins } from '../providers/adapters/google.js';
import { FetchHttpTransport } from '../providers/http-transport.js';
import { createProviderRegistry } from '../providers/registry.js';
import { AuditLog } from '../security/audit.js';
import { CredentialStore } from '../security/credential-store.js';
import { Redactor } from '../security/redactor.js';
import { EnrolledCatalogStore } from '../trust/catalog-store.js';
import { TrustLedger } from '../trust/ledger.js';
import { PendingTrustStore } from '../trust/pending.js';
import { OnboardingSessionStore } from '../onboarding/session-store.js';

const execute = promisify(execFile);

export async function brokerMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertRuntimeVersion();
  const stateRoot = required(environment, 'INFRAMUX_STATE_ROOT');
  const fingerprintKey = await readPrivateKey(required(environment, 'INFRAMUX_FINGERPRINT_KEY'));
  const auditKey = await readPrivateKey(required(environment, 'INFRAMUX_AUDIT_KEY'));
  const redactor = new Redactor();
  const worker = new RpcWorkerExecutor();
  const transport = new FetchHttpTransport({ allowedOrigins: productionProviderOrigins() });
  const broker = new Broker({
    securityMode: required(environment, 'INFRAMUX_SECURITY_MODE') === 'hardened' ? 'hardened' : 'user',
    ledger: new TrustLedger(stateRoot),
    catalogs: new EnrolledCatalogStore(stateRoot),
    credentials: new CredentialStore({ stateRoot, fingerprintKey, redactor }),
    audit: new AuditLog({ stateRoot, hmacKey: auditKey, redactor }),
    providers: createProviderRegistry(),
    adapters: createProviderAdapterRegistry({ transport }),
    worker,
    redactor,
    pendingTrust: new PendingTrustStore({ stateRoot }),
    onboarding: new OnboardingSessionStore({ stateRoot }),
  });
  await startBrokerSystem({
    clientSocketPath: required(environment, 'INFRAMUX_CLIENT_SOCKET'),
    workerSocketPath: required(environment, 'INFRAMUX_WORKER_SOCKET'),
    broker,
    worker,
    callerUid: Number.parseInt(required(environment, 'INFRAMUX_CALLER_UID'), 10),
    releaseVersion: await readReleaseVersion(required(environment, 'INFRAMUX_RUNTIME_MANIFEST')),
    sharedSockets: required(environment, 'INFRAMUX_SECURITY_MODE') === 'hardened',
  });
  if (required(environment, 'INFRAMUX_SECURITY_MODE') === 'hardened') {
    const username = required(environment, 'INFRAMUX_CLIENT_USERNAME');
    if (!/^[a-z_][a-z0-9_-]{0,63}$/i.test(username)) throw new Error('Invalid interactive client username');
    await execute('/bin/chmod', ['+a', `${username} allow read,write`, required(environment, 'INFRAMUX_CLIENT_SOCKET')], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
  }
  if (environment.INFRAMUX_DIAGNOSTIC_ROOT !== undefined) {
    await clearDaemonDiagnostic(environment.INFRAMUX_DIAGNOSTIC_ROOT);
  }
}

async function readReleaseVersion(filename: string): Promise<string> {
  await assertSafeRegularFile(filename, { mode: 0o644 });
  const manifest = JSON.parse(await readFile(filename, 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(manifest.version)) {
    throw new Error('Runtime package manifest has an invalid version');
  }
  return manifest.version;
}

function productionProviderOrigins(): readonly string[] {
  return Object.freeze([...new Set([
    'https://api.cloudflare.com',
    'https://api.vercel.com',
    'https://api.supabase.com',
    'https://sentry.io',
    'https://us.sentry.io',
    'https://de.sentry.io',
    'https://api.uptimerobot.com',
    'https://api.resend.com',
    'https://us.posthog.com',
    'https://eu.posthog.com',
    ...googleApiOrigins(),
  ])].sort());
}

async function readPrivateKey(filename: string): Promise<Buffer> {
  await assertSafeRegularFile(filename);
  const key = await readFile(filename);
  if (key.length < 32) throw new Error(`Broker key is too short: ${filename}`);
  return key;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required broker environment: ${name}`);
  return value;
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  brokerMain().catch(async (error: unknown) => {
    const diagnosticRoot = process.env.INFRAMUX_DIAGNOSTIC_ROOT;
    if (diagnosticRoot !== undefined) await writeDaemonDiagnostic(diagnosticRoot, 'broker', error).catch(() => undefined);
    process.stderr.write('Broker failed to start; run inframux bootstrap --apply to repair or automatically roll back.\n');
    process.exitCode = 1;
  });
}
