import type { ReadStream } from 'node:tty';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, readlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadRepositoryManifest } from '../config/load.js';
import { InframuxError } from '../core/errors.js';
import { collectCheckoutEvidence, inspectGitRepository } from '../git/evidence.js';
import { connectClient } from '../ipc/client.js';
import { planBootstrap, planUninstall, rollback as rollbackVersion } from '../install/lifecycle.js';
import { applyUserBootstrap, stageLocalRelease } from '../install/coordinator.js';
import { resolvePackageRoot } from '../install/package-root.js';
import { writeMaintenanceRequest, writeManagementRequest } from '../install/management.js';
import { resolveInframuxPaths } from '../core/paths.js';
import { createProviderRegistry } from '../providers/registry.js';
import { deriveProjectIdentity, parseServiceList } from '../onboarding/project.js';
import { renderUniversalOnboardingPrompt } from '../integration/agent-config.js';
import { authorizeGoogleDesktop } from './google-desktop-auth.js';
import { renderCommandHelp, resolveCommandHelp } from './command-catalog.js';
import { parseCli } from './parse.js';
import { runPrivilegedHelper } from './privileged.js';
import { renderError, renderResult } from './render.js';

export interface CliDependencies {
  readonly cwd: string;
  readonly stdin: NodeJS.ReadStream;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly authorizeGoogle?: typeof authorizeGoogleDesktop;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
  let json = false;
  try {
    const release = resolvePackageRoot(import.meta.url);
    const command = parseCli(argv);
    json = command.json;
    if (command.command === 'help') {
      dependencies.writeStdout(renderCommandHelp(resolveCommandHelp(argv) ?? resolveCommandHelp([])!));
      return 0;
    }
    if (command.command === 'capabilities') {
      const provider = createProviderRegistry().require(command.provider);
      dependencies.writeStdout(renderResult(command.command, {
        id: provider.id,
        displayName: provider.displayName,
        capabilities: provider.capabilities,
      }, command));
      return 0;
    }
    if (command.command === 'prompt.onboarding') {
      dependencies.writeStdout(renderUniversalOnboardingPrompt());
      return 0;
    }
    if (command.command === 'onboard.start') {
      const providers = parseServiceList(command.services, createProviderRegistry());
      const repository = await inspectGitRepository(dependencies.cwd);
      const identity = deriveProjectIdentity(repository.normalizedRemotes);
      const manifestPath = path.join(repository.repositoryRoot, '.inframux.toml');
      const source = repositoryManifest(identity.id);
      if (!(await pathExists(manifestPath))) await writeNewManifest(manifestPath, source);
      else {
        const manifest = await loadRepositoryManifest(manifestPath);
        if (manifest.project !== identity.id || manifest.registry !== identity.id) {
          throw new InframuxError('PROJECT_NOT_BOUND', 'Existing .inframux.toml does not match the derived repository project');
        }
      }
      const evidence = await collectCheckoutEvidence(repository.repositoryRoot);
      const client = await connectBroker(dependencies.environment);
      try {
        const result = await client.call('onboarding.start', {
          project: identity.id, displayName: identity.displayName, providers, evidence,
          workspaceRoot: safeWorkspaceRoot(evidence.repositoryRoot, evidence.gitCommonDir),
        });
        dependencies.writeStdout(renderResult(command.command, result, command));
        return 0;
      } finally { client.close(); }
    }
    if (command.command === 'onboard.configure' || command.command === 'onboard.reuse' || command.command === 'onboard.resume' || command.command === 'onboard.finish') {
      const client = await connectBroker(dependencies.environment);
      try {
        const operation = command.command === 'onboard.configure' ? 'onboarding.configure'
          : command.command === 'onboard.reuse' ? 'onboarding.reuse'
          : command.command === 'onboard.resume' ? 'onboarding.resume' : 'onboarding.finish';
        const payload = command.command === 'onboard.configure'
          ? { sessionId: command.sessionId, provider: command.provider, input: command.input }
          : command.command === 'onboard.reuse'
            ? { sessionId: command.sessionId, provider: command.provider, sourceProject: command.sourceProject }
          : { sessionId: command.sessionId };
        const result = await client.call(operation, payload);
        dependencies.writeStdout(renderResult(command.command, result, command));
        return 0;
      } finally { client.close(); }
    }
    if (command.command === 'onboard.authorize') {
      if (!dependencies.stdin.isTTY) {
        throw new InframuxError('INVALID_REQUEST', 'onboard authorize requires a user-owned interactive Terminal', {
          recovery: `Run inframux onboard authorize ${command.sessionId} in Terminal`,
        });
      }
      const client = await connectBroker(dependencies.environment);
      try {
        const session = await client.call('onboarding.status', { sessionId: command.sessionId }) as unknown as {
          project: string; providers: string[];
          services: Record<string, { config?: Record<string, unknown>; profile?: string }>;
        };
        const registry = createProviderRegistry();
        for (const providerId of session.providers) {
          const service = session.services[providerId];
          if (service?.profile !== undefined) continue;
          if (service?.config === undefined) throw new Error(`Provider must be configured before authorization: ${providerId}`);
          const provider = registry.require(providerId);
          if (provider.onboarding.auth === 'oauth-pkce') {
            if (providerId !== 'google-cloud' || command.oauthClientJson === undefined) {
              throw new InframuxError('INVALID_REQUEST', `${provider.displayName} requires an OAuth client file`, {
                recovery: `Run inframux onboard authorize ${command.sessionId} --oauth-client-json /absolute/client.json`,
              });
            }
            const payload = await googleEnrollmentPayload(client, session.project, providerId, command.oauthClientJson, dependencies.authorizeGoogle);
            await client.call('credential.enroll', payload);
            const alias = typeof service.config.credential === 'string' ? service.config.credential : `${providerId}-admin`;
            await client.call('onboarding.provider-verified', { sessionId: command.sessionId, provider: providerId, profile: alias });
            continue;
          }
          dependencies.writeStderr(`${provider.displayName}: create/retrieve the credential at ${provider.onboarding.setupUrl}\n`);
          const secret = await readSecret(dependencies.stdin, dependencies.writeStderr);
          try {
            await client.call('credential.enroll', {
              project: session.project, provider: providerId, credentialType: 'administrative-token',
              secretBase64: secret.toString('base64'),
            });
            const alias = typeof service.config.credential === 'string' ? service.config.credential : `${providerId}-admin`;
            await client.call('onboarding.provider-verified', { sessionId: command.sessionId, provider: providerId, profile: alias });
          } finally { secret.fill(0); }
        }
        const result = await client.call('onboarding.status', { sessionId: command.sessionId });
        dependencies.writeStdout(renderResult(command.command, result, command));
        return 0;
      } finally { client.close(); }
    }
    if (command.command === 'bootstrap') {
      const paths = resolveInframuxPaths({
        mode: command.mode === 'user' ? 'user' : 'hardened',
        ...(dependencies.environment.INFRAMUX_ROOT === undefined ? {} : { root: dependencies.environment.INFRAMUX_ROOT }),
      });
      if (command.apply && command.mode === 'user') {
        const sourceRoot = release.root;
        const stagingParent = await mkdtemp(path.join(os.tmpdir(), 'inframux-stage-'));
        const stagedRoot = path.join(stagingParent, 'release');
        try {
          const manifest = await stageLocalRelease({
            sourceRoot,
            stagingRoot: stagedRoot,
            targetRoot: paths.root,
            version: release.version,
            installUid: process.getuid?.() ?? 0,
            installGid: process.getgid?.() ?? 0,
          });
          const result = await applyUserBootstrap({ stagedRoot, targetRoot: paths.root, manifest });
          dependencies.writeStdout(renderResult(command.command, result, command));
          return 0;
        } finally {
          await rm(stagingParent, { recursive: true, force: true });
        }
      }
      if (command.apply) {
        const sourceRoot = release.root;
        const stagingParent = await mkdtemp(path.join(os.tmpdir(), 'inframux-stage-'));
        const stagedRoot = path.join(stagingParent, 'release');
        const requestFile = path.join(stagingParent, 'management-request.json');
        try {
          const manifest = await stageLocalRelease({
            sourceRoot,
            stagingRoot: stagedRoot,
            targetRoot: paths.root,
            version: release.version,
          });
          const caller = os.userInfo();
          await writeManagementRequest(requestFile, {
            schema: 1,
            operation: 'bootstrap',
            stagedRoot: await realpath(stagedRoot),
            targetRoot: paths.root,
            manifest,
            caller: {
              uid: process.getuid?.() ?? caller.uid,
              gid: process.getgid?.() ?? caller.gid,
              username: caller.username,
            },
          });
          dependencies.writeStderr(`Applying sealed inframux ${release.version} (${manifest.files.length} verified files) to ${paths.root}. macOS authorization follows.\n`);
          await runPrivilegedHelper(
            path.join(stagedRoot, 'bin/node'),
            path.join(stagedRoot, 'dist/src/bin/manage.js'),
            'bootstrap',
            requestFile,
          );
          return 0;
        } finally {
          await rm(stagingParent, { recursive: true, force: true });
        }
      }
      const plan = planBootstrap({
        mode: command.mode,
        installRoot: paths.root,
        stagedRoot: path.join(paths.root, 'staging', `inframux-${release.version}`),
        version: release.version,
        nodeVersion: '24.18.1',
        fileVaultStatus: command.mode === 'user' ? 'unknown' : fileVaultFromEnvironment(dependencies.environment),
        accounts: { broker: null, worker: null },
        socketPathsExist: false,
      });
      dependencies.writeStdout(renderResult(command.command, plan, command));
      return 0;
    }
    if (command.command === 'update') {
      const mode = dependencies.environment.INFRAMUX_SECURITY_MODE === 'user' ? 'user' : 'hardened';
      const paths = resolveInframuxPaths({
        mode,
        ...(dependencies.environment.INFRAMUX_ROOT === undefined ? {} : { root: dependencies.environment.INFRAMUX_ROOT }),
      });
      const current = await activeVersionOrNull(paths.root);
      if (command.check) {
        dependencies.writeStdout(renderResult(command.command, {
          schema: 1, currentVersion: current, localReleaseVersion: release.version,
          updateAvailable: current !== release.version,
        }, command));
        return 0;
      }
      if (command.rollback) {
        const previous = await previousInstalledVersion(paths.root, current);
        if (mode === 'user') {
          await rollbackVersion(paths.root, previous);
          dependencies.writeStdout(renderResult(command.command, { schema: 1, rolledBack: true, from: current, to: previous }, command));
          return 0;
        }
        await runMaintenanceHelper(paths.root, 'rollback', previous, dependencies);
        return 0;
      }
      if (current === release.version) {
        dependencies.writeStdout(renderResult(command.command, { schema: 1, currentVersion: current, updated: false }, command));
        return 0;
      }
      return runCli(['bootstrap', ...(mode === 'user' ? ['--user-mode'] : []), '--apply', ...(command.json ? ['--json'] : []), ...(command.verbose ? ['--verbose'] : [])], dependencies);
    }
    if (command.command === 'uninstall') {
      const mode = dependencies.environment.INFRAMUX_SECURITY_MODE === 'user' ? 'user' : 'hardened';
      const paths = resolveInframuxPaths({
        mode,
        ...(dependencies.environment.INFRAMUX_ROOT === undefined ? {} : { root: dependencies.environment.INFRAMUX_ROOT }),
      });
      if (command.dryRun) {
        dependencies.writeStdout(renderResult(command.command, planUninstall({
          installRoot: paths.root, purgeState: false, purgeBrowserProfiles: false,
        }), command));
        return 0;
      }
      if (mode === 'user') {
        for (const relative of ['current', 'runtime', 'run', 'worker', 'logs']) {
          await rm(path.join(paths.root, relative), { recursive: true, force: true });
        }
        dependencies.writeStdout(renderResult(command.command, {
          schema: 1, uninstalled: true, preserved: [paths.state, paths.browserState],
        }, command));
        return 0;
      }
      await runMaintenanceHelper(paths.root, 'uninstall', undefined, dependencies);
      return 0;
    }
    if (command.command === 'launch.mcp' || command.command === 'browser.mcp') {
      throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', `${command.command} is initialized by its dedicated launcher`);
    }

    if (command.command === 'link') {
      const repository = await realpath(command.repository);
      const manifestPath = path.join(repository, '.inframux.toml');
      const manifestSource = repositoryManifest(command.project);
      if (!(await pathExists(manifestPath))) {
        if (!command.writeManifest) {
          dependencies.writeStdout(renderResult(command.command, {
            schema: 1,
            action: 'preview',
            repository,
            manifestPath,
            manifest: manifestSource,
            next: `inframux link --project ${command.project} ${repository} --write-manifest`,
          }, command));
          return 0;
        }
        await writeNewManifest(manifestPath, manifestSource);
      } else {
        const existing = await loadRepositoryManifest(manifestPath);
        if (existing.project !== command.project || existing.registry !== command.project) {
          throw new InframuxError('PROJECT_NOT_BOUND', 'Existing .inframux.toml belongs to a different project');
        }
      }
      const evidence = await collectCheckoutEvidence(repository);
      const manifest = await loadRepositoryManifest(evidence.manifestPath);
      const client = await connectBroker(dependencies.environment);
      try {
        const result = await client.call('trust.request', {
          evidence,
          manifest,
          workspaceRoot: safeWorkspaceRoot(evidence.repositoryRoot, evidence.gitCommonDir),
        });
        dependencies.writeStdout(renderResult(command.command, result, command));
        return 0;
      } finally {
        client.close();
      }
    }

    const client = await connectBroker(dependencies.environment);
    try {
      let brokerOperation: string;
      let payload: unknown;
      if (command.command === 'trust.approve') {
        brokerOperation = 'trust.approve';
        payload = { requestId: command.requestId };
      } else if (command.command === 'trust.revoke') {
        brokerOperation = 'trust.revoke';
        payload = { repositoryRoot: await realpath(command.repository) };
      } else if (command.command === 'auth.status') {
        brokerOperation = 'credential.status';
        payload = { project: command.project };
      } else if (command.command === 'auth.revoke') {
        brokerOperation = 'credential.revoke';
        payload = { project: command.project, provider: command.provider };
      } else if (command.command === 'enroll') {
        if (command.provider === 'google-cloud') {
          payload = await googleEnrollmentPayload(
            client,
            command.project,
            command.provider,
            command.oauthClientJson ?? dependencies.environment.INFRAMUX_GOOGLE_OAUTH_CLIENT,
            dependencies.authorizeGoogle,
          );
        } else {
          const secret = await readSecret(dependencies.stdin, dependencies.writeStderr);
          try {
            payload = {
              project: command.project,
              provider: command.provider,
              credentialType: 'administrative-token',
              secretBase64: secret.toString('base64'),
            };
          } finally {
            secret.fill(0);
          }
        }
        brokerOperation = 'credential.enroll';
      } else {
        const evidence = await collectCheckoutEvidence(dependencies.cwd);
        const manifest = await loadRepositoryManifest(evidence.manifestPath);
        const checkout = { evidence, manifest };
        switch (command.command) {
          case 'replace-token': {
            const secret = await readSecret(dependencies.stdin, dependencies.writeStderr);
            try {
              brokerOperation = 'credential.enroll';
              payload = {
                project: manifest.project,
                provider: command.provider,
                credentialType: 'administrative-token',
                secretBase64: secret.toString('base64'),
              };
            } finally {
              secret.fill(0);
            }
            break;
          }
          case 'reauthorize':
            if (command.provider !== 'google-cloud') {
              throw new InframuxError('UNSUPPORTED_PROVIDER_OPERATION', `Provider does not use interactive OAuth: ${command.provider}`);
            }
            brokerOperation = 'credential.enroll';
            payload = await googleEnrollmentPayload(
              client,
              manifest.project,
              command.provider,
              command.oauthClientJson ?? dependencies.environment.INFRAMUX_GOOGLE_OAUTH_CLIENT,
              dependencies.authorizeGoogle,
            );
            break;
          case 'status':
          case 'doctor':
            brokerOperation = command.command;
            payload = checkout;
            break;
          case 'project.resolve':
            brokerOperation = 'project.resolve';
            payload = checkout;
            break;
          case 'run':
            brokerOperation = 'run';
            payload = { ...checkout, provider: command.provider, args: command.args };
            break;
          case 'call':
            brokerOperation = 'call';
            payload = { ...checkout, provider: command.provider, operation: command.operation, input: command.input };
            break;
          case 'audit.verify':
            brokerOperation = 'audit.verify';
            payload = checkout;
            break;
          default:
            throw new InframuxError('INVALID_REQUEST', 'Command is not wired to the broker');
        }
      }
      const result = await client.call(brokerOperation, payload);
      dependencies.writeStdout(renderResult(command.command, result, command));
      return 0;
    } finally {
      client.close();
    }
  } catch (error) {
    const rendered = renderError(error, json);
    dependencies.writeStderr(`${rendered.text}\n`);
    return rendered.exitCode;
  }
}

async function runMaintenanceHelper(
  targetRoot: string,
  operation: 'rollback' | 'uninstall',
  version: string | undefined,
  dependencies: CliDependencies,
): Promise<void> {
  const requestRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-maintenance-'));
  const requestFile = path.join(requestRoot, 'request.json');
  try {
    const caller = os.userInfo();
    await writeMaintenanceRequest(requestFile, {
      schema: 1,
      operation,
      targetRoot,
      ...(version === undefined ? {} : { version }),
      caller: {
        uid: process.getuid?.() ?? caller.uid,
        gid: process.getgid?.() ?? caller.gid,
        username: caller.username,
      },
    });
    dependencies.writeStderr(`Applying reviewed inframux ${operation}. macOS authorization follows.\n`);
    await runPrivilegedHelper(
      path.join(targetRoot, 'current/bin/node'),
      path.join(targetRoot, 'current/dist/src/bin/manage.js'),
      operation,
      requestFile,
    );
  } finally {
    await rm(requestRoot, { recursive: true, force: true });
  }
}

async function activeVersionOrNull(installRoot: string): Promise<string | null> {
  try {
    const current = path.join(installRoot, 'current');
    const stat = await lstat(current);
    if (!stat.isSymbolicLink()) throw new Error('Installed current pointer is not a symbolic link');
    return path.basename(await readlink(current));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function previousInstalledVersion(installRoot: string, current: string | null): Promise<string> {
  if (current === null) throw new Error('inframux is not installed');
  const entries = await readdir(path.join(installRoot, 'runtime/versions'), { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== current && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(entry.name));
  if (candidates.length !== 1) throw new Error(`Rollback requires exactly one retained previous version; found ${candidates.length}`);
  return candidates[0]!.name;
}

async function connectBroker(environment: Readonly<NodeJS.ProcessEnv>) {
  const socketPath = environment.INFRAMUX_CLIENT_SOCKET ?? '/Library/Application Support/inframux/run/client.sock';
  try {
    return await connectClient(socketPath);
  } catch (error) {
    throw new InframuxError('BROKER_UNAVAILABLE', `Cannot connect to inframux broker at ${socketPath}`, { cause: error });
  }
}

async function googleEnrollmentPayload(
  client: { call(operation: string, payload: unknown): Promise<unknown> },
  project: string,
  provider: string,
  clientFileInput: string | undefined,
  authorize: typeof authorizeGoogleDesktop = authorizeGoogleDesktop,
): Promise<Record<string, unknown>> {
  if (clientFileInput === undefined) {
    throw new InframuxError('INVALID_REQUEST', 'Google authorization requires --oauth-client-json <absolute-path>', {
      recovery: 'Download a Desktop OAuth client JSON from Google Cloud Console and pass its absolute path once',
    });
  }
  const info = await client.call('credential.enrollment-info', { project, provider }) as {
    expectedIdentity?: Record<string, string>;
    scopes?: string[];
  };
  const account = info.expectedIdentity?.account;
  if (typeof account !== 'string' || !Array.isArray(info.scopes) || info.scopes.length === 0) {
    throw new InframuxError('INVALID_REQUEST', 'Google enrollment catalog is missing account or scopes');
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Google authorization cancelled'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let secret: Buffer | undefined;
  try {
    const clientFile = await realpath(clientFileInput);
    secret = await authorize({
      clientFile,
      scopes: info.scopes,
      loginHint: account,
      signal: controller.signal,
    });
    return {
      project,
      provider,
      credentialType: 'oauth2-desktop-pkce',
      expectedIdentity: info.expectedIdentity,
      secretBase64: secret.toString('base64'),
    };
  } finally {
    secret?.fill(0);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

function repositoryManifest(project: string): string {
  return `schema = 1\nproject = "${project}"\nregistry = "${project}"\n`;
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeNewManifest(filename: string, source: string): Promise<void> {
  const parent = await realpath(path.dirname(filename));
  if (path.join(parent, path.basename(filename)) !== filename) throw new Error('Manifest parent changed during link');
  let handle;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function safeWorkspaceRoot(repositoryRoot: string, gitCommonDir: string): string {
  const repositoryParts = path.resolve(repositoryRoot).split(path.sep);
  const gitParts = path.resolve(gitCommonDir).split(path.sep);
  let index = 0;
  while (index < repositoryParts.length && repositoryParts[index] === gitParts[index]) index += 1;
  const common = repositoryParts.slice(0, index).join(path.sep) || path.parse(repositoryRoot).root;
  if (common === path.parse(common).root) throw new Error('Repository and Git common directory do not share a safe workspace root');
  return common;
}

function fileVaultFromEnvironment(environment: Readonly<NodeJS.ProcessEnv>): 'ready' | 'encrypting' | 'disabled' | 'unknown' {
  const value = environment.INFRAMUX_FILEVAULT_STATUS;
  return value === 'ready' || value === 'encrypting' || value === 'disabled' ? value : 'unknown';
}

async function readSecret(stdin: NodeJS.ReadStream, write: (value: string) => void): Promise<Buffer> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const combined = Buffer.concat(chunks);
    let end = combined.length;
    while (end > 0 && (combined[end - 1] === 10 || combined[end - 1] === 13)) end -= 1;
    const secret = Buffer.from(combined.subarray(0, end));
    combined.fill(0);
    return secret;
  }
  const tty = stdin as ReadStream;
  write('Credential (input hidden): ');
  const bytes: number[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    const previousRaw = tty.isRaw;
    const finish = (error?: Error) => {
      tty.off('data', onData);
      tty.setRawMode(previousRaw ?? false);
      write('\n');
      if (error !== undefined) reject(error);
      else resolve(Buffer.from(bytes));
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error('Enrollment cancelled'));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 127 || byte === 8) bytes.pop();
        else bytes.push(byte);
      }
    };
    tty.setRawMode(true);
    tty.on('data', onData);
    tty.resume();
  });
}
