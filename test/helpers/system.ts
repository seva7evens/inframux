import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collectCheckoutEvidence } from '../../src/git/evidence.js';
import { EnrolledCatalogStore } from '../../src/trust/catalog-store.js';
import { TrustLedger } from '../../src/trust/ledger.js';

export interface CommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }

export interface SyntheticSystem {
  readonly root: string;
  readonly stateRoot: string;
  readonly repositories: Readonly<Record<'alpha' | 'beta', string>>;
  readonly tokens: Readonly<Record<'alpha' | 'beta', string>>;
  readonly environment: NodeJS.ProcessEnv;
  readonly browserStateRoot: string;
  readonly browserTasksRoot: string;
  run(project: 'alpha' | 'beta', args: readonly string[], stdin?: string): Promise<CommandResult>;
  runInteractive(project: 'alpha' | 'beta', args: readonly string[], secret: string): Promise<CommandResult>;
  runAt(cwd: string, args: readonly string[], stdin?: string): Promise<CommandResult>;
  spawn(project: 'alpha' | 'beta', args: readonly string[]): ChildProcess;
  serviceOutput(): string;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export async function startSyntheticSystem(): Promise<SyntheticSystem> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-e2e-'));
  await chmod(root, 0o700);
  const stateRoot = path.join(root, 'state');
  const runRoot = path.join(root, 'run');
  const workerRoot = path.join(root, 'worker');
  const toolRoot = path.join(root, 'tools');
  const browserStateRoot = path.join(root, 'browser-state');
  const browserTasksRoot = path.join(root, 'browser-tasks');
  await mkdir(toolRoot, { mode: 0o700 });
  const repositories = {
    alpha: await createRepository(root, 'alpha'),
    beta: await createRepository(root, 'beta'),
  } as const;
  const ledger = new TrustLedger(stateRoot);
  const catalogs = new EnrolledCatalogStore(stateRoot);
  for (const project of ['alpha', 'beta'] as const) {
    const evidence = await collectCheckoutEvidence(repositories[project]);
    const id = `e2e-${project}`;
    const remote = `github.com/inframux-fixtures/${id}`;
    await catalogs.enroll({
      schema: 1, id, displayName: `E2E ${project}`,
      repositories: [{ remote }],
      services: { synthetic: { credential: `${id}-synthetic-admin`, accountId: `account-${project}` } },
    });
    await ledger.approve({
      schema: 1, project: id, repositoryRoot: evidence.repositoryRoot,
      gitCommonDir: evidence.gitCommonDir, canonicalRemote: remote, workspaceRoot: root,
      manifestDigest: evidence.manifestDigest, approvedAt: '2026-08-18T00:00:00.000Z',
    });
  }

  const cliExecutable = path.join(toolRoot, 'synthetic-provider');
  const mcpExecutable = path.join(toolRoot, 'synthetic-mcp');
  await installFixture('../fixtures/fake-provider.mjs', cliExecutable);
  await installFixture('../fixtures/fake-mcp.mjs', mcpExecutable);
  const executableManifest = path.join(root, 'executable-manifest.json');
  await privateWrite(executableManifest, JSON.stringify({
    schema: 1,
    runtimeNodeVersion: '24.18.1',
    executables: {
      'synthetic-cli': {
        path: cliExecutable, provider: 'synthetic', kind: 'cli', version: '1.0.0',
        sha256: await digestFile(cliExecutable),
      },
      'synthetic-mcp': {
        path: mcpExecutable, provider: 'synthetic', kind: 'mcp', version: '1.0.0',
        sha256: await digestFile(mcpExecutable),
      },
    },
  }));
  const fingerprintKey = path.join(root, 'fingerprint.key');
  const auditKey = path.join(root, 'audit.key');
  await privateWrite(fingerprintKey, randomBytes(32));
  await privateWrite(auditKey, randomBytes(32));
  const browserLauncher = path.join(toolRoot, 'synthetic-browser');
  await writeFile(browserLauncher, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const output = args[args.indexOf('--output-dir') + 1];
fs.writeFileSync(path.join(output, 'browser-ran.json'), JSON.stringify({ cwd: process.cwd(), args }));
`);
  await chmod(browserLauncher, 0o755);

  const clientSocket = path.join(runRoot, 'client.sock');
  const workerSocket = path.join(runRoot, 'worker.sock');
  const commonEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: 'C',
    INFRAMUX_CLIENT_SOCKET: clientSocket,
    INFRAMUX_WORKER_SOCKET: workerSocket,
    INFRAMUX_STATE_ROOT: stateRoot,
    INFRAMUX_WORKER_ROOT: workerRoot,
    INFRAMUX_TOOL_ROOT: toolRoot,
    INFRAMUX_EXECUTABLE_MANIFEST: executableManifest,
    INFRAMUX_FINGERPRINT_KEY: fingerprintKey,
    INFRAMUX_AUDIT_KEY: auditKey,
    INFRAMUX_SECURITY_MODE: 'user',
    INFRAMUX_ROOT: path.join(root, 'user-install'),
    INFRAMUX_CALLER_UID: String(process.getuid?.() ?? 0),
    INFRAMUX_BROWSER_STATE: browserStateRoot,
    INFRAMUX_BROWSER_TASKS: browserTasksRoot,
    INFRAMUX_PLAYWRIGHT_LAUNCHER: browserLauncher,
    INFRAMUX_AMBIENT_CANARY: 'MUST-NOT-REACH-WORKER',
  };
  const serviceBuffers: Buffer[] = [];
  let broker: ChildProcess;
  let worker: ChildProcess;
  const launchServices = async () => {
    broker = spawn(process.execPath, [dist('broker.js')], { env: commonEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    broker.stdout?.on('data', (chunk: Buffer) => serviceBuffers.push(Buffer.from(chunk)));
    broker.stderr?.on('data', (chunk: Buffer) => serviceBuffers.push(Buffer.from(chunk)));
    await waitForPath(clientSocket, broker);
    worker = spawn(process.execPath, [dist('worker.js')], { env: commonEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    worker.stdout?.on('data', (chunk: Buffer) => serviceBuffers.push(Buffer.from(chunk)));
    worker.stderr?.on('data', (chunk: Buffer) => serviceBuffers.push(Buffer.from(chunk)));
    await waitForAlive(worker);
  };
  await launchServices();

  const tokens = {
    alpha: 'account:account-alpha:SYNTHETIC-E2E-ALPHA-CANARY',
    beta: 'account:account-beta:SYNTHETIC-E2E-BETA-CANARY',
  } as const;
  let stopped = false;
  return {
    root, stateRoot, repositories, tokens, environment: commonEnvironment, browserStateRoot, browserTasksRoot,
    run: (project, args, stdin) => runProcess(repositories[project], args, commonEnvironment, stdin),
    runInteractive: (project, args, secret) => runInteractiveProcess(repositories[project], args, commonEnvironment, secret),
    runAt: (cwd, args, stdin) => runProcess(cwd, args, commonEnvironment, stdin),
    spawn: (project, args) => spawn(process.execPath, [dist('inframux.js'), ...args], {
      cwd: repositories[project], env: commonEnvironment, stdio: ['pipe', 'pipe', 'pipe'],
    }),
    serviceOutput: () => Buffer.concat(serviceBuffers).toString('utf8'),
    restart: async () => {
      await Promise.all([terminate(worker), terminate(broker)]);
      await Promise.all([rm(clientSocket, { force: true }), rm(workerSocket, { force: true })]);
      await launchServices();
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await Promise.all([terminate(worker), terminate(broker)]);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runInteractiveProcess(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  secret: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const command = [process.execPath, dist('inframux.js'), ...args].map(tclWord).join(' ');
    const expectProgram = [
      'set timeout 10',
      'log_user 1',
      `spawn ${command}`,
      'expect "Credential (input hidden):"',
      'gets stdin secret',
      'send -- "$secret\\r"',
      'expect eof',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    const child = spawn('/usr/bin/expect', ['-c', expectProgram], {
      cwd,
      env: { ...environment, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let sent = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for interactive credential prompt: ${Buffer.concat(stdout).toString('utf8')}`));
    }, 10_000);
    timeout.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk));
      if (!sent && Buffer.concat(stdout).toString('utf8').includes('Credential (input hidden):')) {
        sent = true;
        child.stdin?.end(`${secret}\n`);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8').replaceAll('\r', ''),
        stderr: Buffer.concat(stderr).toString('utf8').replaceAll('\r', ''),
      });
    });
  });
}

function tclWord(value: string): string {
  return `{${value.replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}')}}`;
}

async function createRepository(root: string, project: 'alpha' | 'beta'): Promise<string> {
  const repository = path.join(root, `repository-${project}`);
  await command('git', ['init', '-b', 'main', repository], root);
  await command('git', ['-C', repository, 'config', 'user.email', 'e2e@example.invalid'], root);
  await command('git', ['-C', repository, 'config', 'user.name', 'inframux e2e'], root);
  await writeFile(path.join(repository, '.inframux.toml'), `schema = 1\nproject = "e2e-${project}"\nregistry = "e2e-${project}"\n`);
  await writeFile(path.join(repository, 'README.md'), `synthetic ${project}\n`);
  await command('git', ['-C', repository, 'add', '.'], root);
  await command('git', ['-C', repository, 'commit', '-m', 'fixture'], root);
  await command('git', ['-C', repository, 'remote', 'add', 'origin', `git@github.com:inframux-fixtures/e2e-${project}.git`], root);
  return realpath(repository);
}

async function installFixture(relativeUrl: string, target: string): Promise<void> {
  await copyFile(new URL(relativeUrl, import.meta.url), target);
  const source = (await readFile(target, 'utf8')).replace('#!/usr/bin/env node', `#!${process.execPath}`);
  await writeFile(target, source);
  await chmod(target, 0o755);
}

async function privateWrite(filename: string, data: string | Buffer): Promise<void> {
  await writeFile(filename, data, { mode: 0o600 });
  await chmod(filename, 0o600);
}

async function digestFile(filename: string): Promise<string> {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

function dist(name: string): string {
  return path.resolve(import.meta.dirname, '../../dist/src/bin', name);
}

async function waitForPath(filename: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Service exited before creating ${filename}`);
    try { await lstat(filename); return; } catch { await delay(20); }
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

async function waitForAlive(child: ChildProcess): Promise<void> {
  await delay(100);
  if (child.exitCode !== null) throw new Error(`Service exited with ${child.exitCode}`);
}

async function runProcess(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  stdin?: string,
  executable = process.execPath,
): Promise<CommandResult> {
  const actualArgs = executable === process.execPath ? [dist('inframux.js'), ...args] : [...args];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, actualArgs, { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin?.end(stdin);
  });
}

async function command(executable: string, args: readonly string[], cwd: string): Promise<void> {
  const result = await runProcess(cwd, args, { PATH: process.env.PATH, LANG: 'C' }, undefined, executable);
  if (result.code !== 0) throw new Error(`${executable} failed: ${result.stderr}`);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  const exited = await Promise.race([closed.then(() => true), delay(1_000).then(() => false)]);
  if (!exited) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    await closed;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
