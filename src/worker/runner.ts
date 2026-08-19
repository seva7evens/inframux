import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { InframuxError } from '../core/errors.js';
import { atomicWritePrivateFile, ensurePrivateDirectory } from '../core/safe-files.js';
import type { Redactor } from '../security/redactor.js';
import { buildLeaseEnvironment } from './environment.js';
import { verifyExecutable, type ExecutableManifest } from './executable-manifest.js';

const configFileSchema = z.object({
  path: z.string().min(1).max(256),
  contentBase64: z.base64(),
}).strict();

export const executionLeaseSchema = z.object({
  schema: z.literal(1),
  leaseId: z.uuid(),
  project: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
  credentialFingerprint: z.string().min(1).max(128),
  credentialEnvironmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
  credentialBase64: z.base64(),
  executableId: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
  args: z.array(z.string().max(32_768)).max(256),
  publicEnvironment: z.record(z.string(), z.string().max(32_768)),
  timeoutMs: z.number().int().min(1).max(3_600_000),
  maxOutputBytes: z.number().int().min(1).max(64 * 1024 * 1024),
  configFiles: z.array(configFileSchema).max(128),
}).strict();

export type ExecutionLease = z.infer<typeof executionLeaseSchema>;

export interface WorkerResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export class WorkerRunner {
  readonly #workerRoot: string;
  readonly #toolRoot: string;
  readonly #manifest: ExecutableManifest;
  readonly #allowedOwnerUids: readonly number[];
  readonly #redactor: Redactor;
  readonly #baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly #terminationGraceMs: number;

  constructor(options: {
    workerRoot: string;
    toolRoot: string;
    manifest: ExecutableManifest;
    allowedOwnerUids: readonly number[];
    redactor: Redactor;
    baseEnvironment?: Readonly<NodeJS.ProcessEnv>;
    terminationGraceMs?: number;
  }) {
    this.#workerRoot = path.resolve(options.workerRoot);
    this.#toolRoot = path.resolve(options.toolRoot);
    this.#manifest = options.manifest;
    this.#allowedOwnerUids = options.allowedOwnerUids;
    this.#redactor = options.redactor;
    this.#baseEnvironment = options.baseEnvironment ?? {};
    this.#terminationGraceMs = options.terminationGraceMs ?? 2_000;
  }

  async runLease(input: ExecutionLease, signal?: AbortSignal): Promise<WorkerResult> {
    const lease = executionLeaseSchema.parse(input);
    const entry = await verifyExecutable(this.#manifest, lease.executableId, {
      toolRoot: this.#toolRoot,
      allowedOwnerUids: this.#allowedOwnerUids,
    });
    if (entry.provider !== lease.provider) throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable provider does not match lease');

    const tmpRoot = path.join(this.#workerRoot, 'tmp');
    await ensurePrivateDirectory(this.#workerRoot);
    await ensurePrivateDirectory(tmpRoot);
    const leaseRoot = path.join(tmpRoot, lease.leaseId);
    const home = path.join(leaseRoot, 'home');
    const temp = path.join(leaseRoot, 'tmp');
    const config = path.join(leaseRoot, 'config');
    await mkdir(leaseRoot, { mode: 0o700 });
    await ensurePrivateDirectory(home);
    await ensurePrivateDirectory(temp);
    await ensurePrivateDirectory(config);

    const secret = Buffer.from(lease.credentialBase64, 'base64');
    if (secret.length < 8) throw new Error('Lease credential is too short');
    const unregister = this.#redactor.registerSecret(secret);
    const started = Date.now();
    try {
      for (const file of lease.configFiles) {
        if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) {
          throw new Error(`Config file escapes lease root: ${file.path}`);
        }
        await atomicWritePrivateFile(config, file.path, Buffer.from(file.contentBase64, 'base64'));
      }
      const environment = buildLeaseEnvironment({
        baseEnvironment: this.#baseEnvironment,
        home,
        temp,
        credentialEnvironmentVariable: lease.credentialEnvironmentVariable,
        credential: secret.toString('utf8'),
        publicEnvironment: { ...lease.publicEnvironment, INFRAMUX_CONFIG_DIR: config },
      });
      const result = await this.#runChild(entry.path, lease.args, leaseRoot, environment, {
        timeoutMs: lease.timeoutMs,
        maxOutputBytes: lease.maxOutputBytes,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        ...result,
        stdout: this.#redactor.redact(result.stdout),
        stderr: this.#redactor.redact(result.stderr),
        durationMs: Date.now() - started,
      };
    } finally {
      unregister();
      secret.fill(0);
      await rm(leaseRoot, { recursive: true, force: true });
    }
  }

  async #runChild(
    executable: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    limits: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<Omit<WorkerResult, 'durationMs'>> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let terminalError: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = (error: Error) => {
        if (terminalError !== undefined) return;
        terminalError = error;
        killGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), this.#terminationGraceMs);
        killTimer.unref();
      };
      const collect = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > limits.maxOutputBytes) {
          terminate(new InframuxError('OUTPUT_LIMIT_EXCEEDED', 'Child output limit exceeded'));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', (error) => {
        terminalError = error;
      });
      const timeout = setTimeout(
        () => terminate(new Error(`Provider process timed out after ${limits.timeoutMs}ms`)),
        limits.timeoutMs,
      );
      const onAbort = () => terminate(new Error('Provider process cancelled'));
      if (limits.signal?.aborted) onAbort();
      else limits.signal?.addEventListener('abort', onAbort, { once: true });
      child.once('close', (code, childSignal) => {
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        limits.signal?.removeEventListener('abort', onAbort);
        if (terminalError !== undefined) {
          reject(terminalError);
          return;
        }
        resolve({
          exitCode: code,
          signal: childSignal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}
