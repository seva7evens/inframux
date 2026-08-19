import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { InframuxError } from '../core/errors.js';
import { atomicWritePrivateFile, ensurePrivateDirectory } from '../core/safe-files.js';
import type { McpReadResult } from '../ipc/byte-tunnel.js';
import type { Redactor } from '../security/redactor.js';
import { buildLeaseEnvironment } from './environment.js';
import { verifyExecutable, type ExecutableManifest } from './executable-manifest.js';
import { executionLeaseSchema, type ExecutionLease } from './runner.js';

interface Session {
  readonly id: string;
  readonly child: ChildProcess;
  readonly root: string;
  readonly secret: Buffer;
  readonly unregister: () => void;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly waiters: Set<() => void>;
  readonly closed: Promise<void>;
  resolveClosed(): void;
  stdoutPending: Buffer;
  outputBytes: number;
  exited: boolean;
  exitError?: Error;
  timeout: NodeJS.Timeout;
}

export class McpProcessManager {
  readonly #workerRoot: string;
  readonly #toolRoot: string;
  readonly #manifest: ExecutableManifest;
  readonly #allowedOwnerUids: readonly number[];
  readonly #redactor: Redactor;
  readonly #terminationGraceMs: number;
  readonly #sessions = new Map<string, Session>();

  constructor(options: {
    workerRoot: string;
    toolRoot: string;
    manifest: ExecutableManifest;
    allowedOwnerUids: readonly number[];
    redactor: Redactor;
    terminationGraceMs?: number;
  }) {
    this.#workerRoot = path.resolve(options.workerRoot);
    this.#toolRoot = path.resolve(options.toolRoot);
    this.#manifest = options.manifest;
    this.#allowedOwnerUids = options.allowedOwnerUids;
    this.#redactor = options.redactor;
    this.#terminationGraceMs = options.terminationGraceMs ?? 2_000;
  }

  activeSessions(): string[] {
    return [...this.#sessions.keys()].sort();
  }

  async open(input: ExecutionLease): Promise<string> {
    const lease = executionLeaseSchema.parse(input);
    if (this.#sessions.has(lease.leaseId)) throw new Error('Duplicate MCP lease ID');
    const entry = await verifyExecutable(this.#manifest, lease.executableId, {
      toolRoot: this.#toolRoot,
      allowedOwnerUids: this.#allowedOwnerUids,
    });
    if (entry.provider !== lease.provider || entry.kind !== 'mcp') {
      throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'MCP executable does not match lease provider/kind');
    }
    const tmpRoot = path.join(this.#workerRoot, 'tmp');
    await ensurePrivateDirectory(this.#workerRoot);
    await ensurePrivateDirectory(tmpRoot);
    const root = path.join(tmpRoot, `mcp-${lease.leaseId}`);
    const home = path.join(root, 'home');
    const temp = path.join(root, 'tmp');
    const config = path.join(root, 'config');
    await mkdir(root, { mode: 0o700 });
    await ensurePrivateDirectory(home);
    await ensurePrivateDirectory(temp);
    await ensurePrivateDirectory(config);
    const secret = Buffer.from(lease.credentialBase64, 'base64');
    if (secret.length < 8) throw new Error('MCP lease credential is too short');
    const unregister = this.#redactor.registerSecret(secret);
    try {
      for (const file of lease.configFiles) {
        if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) throw new Error('MCP config escapes lease root');
        await atomicWritePrivateFile(config, file.path, Buffer.from(file.contentBase64, 'base64'));
      }
      const environment = buildLeaseEnvironment({
        home,
        temp,
        credentialEnvironmentVariable: lease.credentialEnvironmentVariable,
        credential: secret.toString('utf8'),
        publicEnvironment: { ...lease.publicEnvironment, INFRAMUX_CONFIG_DIR: config },
      });
      const child = spawn(entry.path, [...lease.args], {
        cwd: root,
        env: environment,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
      const session: Session = {
        id: lease.leaseId,
        child,
        root,
        secret,
        unregister,
        stdout: [],
        stderr: [],
        waiters: new Set(),
        closed,
        resolveClosed,
        stdoutPending: Buffer.alloc(0),
        outputBytes: 0,
        exited: false,
        timeout: setTimeout(() => {
          session.exitError = new Error('MCP process timed out');
          terminate(child, this.#terminationGraceMs);
        }, lease.timeoutMs),
      };
      session.timeout.unref();
      this.#sessions.set(session.id, session);
      child.stdout?.on('data', (chunk: Buffer) => this.#stdout(session, chunk, lease.maxOutputBytes));
      child.stderr?.on('data', (chunk: Buffer) => this.#stderr(session, chunk, lease.maxOutputBytes));
      child.once('error', (error) => {
        session.exitError = error;
        this.#wake(session);
      });
      child.once('close', () => {
        clearTimeout(session.timeout);
        this.#flushStdout(session);
        session.exited = true;
        session.resolveClosed();
        this.#wake(session);
      });
      return session.id;
    } catch (error) {
      unregister();
      secret.fill(0);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async write(sessionId: string, chunk: Uint8Array): Promise<void> {
    const session = this.#require(sessionId);
    if (session.exited || session.child.stdin === null) throw new Error('MCP session is closed');
    if (chunk.byteLength > 256 * 1024) throw new Error('MCP input chunk exceeds limit');
    if (session.child.stdin.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      session.child.stdin?.once('drain', resolve);
      session.child.stdin?.once('error', reject);
    });
  }

  async end(sessionId: string): Promise<void> {
    const session = this.#require(sessionId);
    session.child.stdin?.end();
  }

  async read(sessionId: string, waitMs = 1_000): Promise<McpReadResult> {
    const session = this.#require(sessionId);
    if (session.stdout.length === 0 && session.stderr.length === 0 && !session.exited && session.exitError === undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { session.waiters.delete(done); resolve(); }, waitMs);
        const done = () => { clearTimeout(timer); resolve(); };
        session.waiters.add(done);
      });
    }
    if (session.exitError !== undefined) throw session.exitError;
    const stdout = Buffer.concat(session.stdout.splice(0));
    const stderr = Buffer.concat(session.stderr.splice(0));
    return { stdout, stderr, eof: session.exited && session.stdout.length === 0 && session.stderr.length === 0 };
  }

  async close(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    if (!session.exited) {
      session.child.stdin?.end();
      terminate(session.child, this.#terminationGraceMs);
      await session.closed;
    }
    this.#sessions.delete(sessionId);
    clearTimeout(session.timeout);
    session.unregister();
    session.secret.fill(0);
    await rm(session.root, { recursive: true, force: true });
  }

  #stdout(session: Session, chunk: Buffer, limit: number): void {
    if (!this.#count(session, chunk, limit)) return;
    session.stdoutPending = Buffer.concat([session.stdoutPending, chunk]);
    while (true) {
      const newline = session.stdoutPending.indexOf(10);
      if (newline < 0) break;
      const frame = Buffer.from(session.stdoutPending.subarray(0, newline + 1));
      session.stdoutPending = session.stdoutPending.subarray(newline + 1);
      try {
        this.#redactor.assertClean(frame);
        session.stdout.push(frame);
      } catch (error) {
        session.exitError = error instanceof Error ? error : new Error('MCP emitted credential data');
        terminate(session.child, this.#terminationGraceMs);
      }
    }
    this.#wake(session);
  }

  #stderr(session: Session, chunk: Buffer, limit: number): void {
    if (!this.#count(session, chunk, limit)) return;
    session.stderr.push(Buffer.from(this.#redactor.redact(chunk)));
    this.#wake(session);
  }

  #count(session: Session, chunk: Buffer, limit: number): boolean {
    session.outputBytes += chunk.length;
    if (session.outputBytes <= limit) return true;
    session.exitError = new InframuxError('OUTPUT_LIMIT_EXCEEDED', 'MCP output limit exceeded');
    terminate(session.child, this.#terminationGraceMs);
    this.#wake(session);
    return false;
  }

  #flushStdout(session: Session): void {
    if (session.stdoutPending.length === 0) return;
    try {
      this.#redactor.assertClean(session.stdoutPending);
      session.stdout.push(Buffer.from(session.stdoutPending));
    } catch (error) {
      session.exitError = error instanceof Error ? error : new Error('MCP emitted credential data');
    }
    session.stdoutPending = Buffer.alloc(0);
  }

  #wake(session: Session): void {
    for (const waiter of session.waiters) waiter();
    session.waiters.clear();
  }

  #require(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error(`Unknown MCP session: ${sessionId}`);
    return session;
  }
}

function terminate(child: ChildProcess, graceMs: number): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const timer = setTimeout(() => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, graceMs);
  timer.unref();
}
