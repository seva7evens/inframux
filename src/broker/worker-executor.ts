import type { JsonValue } from '../core/json.js';
import type { RpcPeer } from '../ipc/peer.js';
import type { McpReadResult } from '../ipc/byte-tunnel.js';
import type { McpProcessManager } from '../worker/mcp-process.js';
import type { ExecutionLease, WorkerResult, WorkerRunner } from '../worker/runner.js';

export interface WorkerExecutor {
  run(lease: ExecutionLease, signal?: AbortSignal): Promise<WorkerResult>;
  openMcp(lease: ExecutionLease, signal?: AbortSignal): Promise<string>;
  writeMcp(sessionId: string, chunk: Uint8Array): Promise<void>;
  endMcp(sessionId: string): Promise<void>;
  readMcp(sessionId: string): Promise<McpReadResult>;
  closeMcp(sessionId: string): Promise<void>;
}

export class LocalWorkerExecutor implements WorkerExecutor {
  constructor(readonly runner: WorkerRunner, readonly mcp?: McpProcessManager) {}

  run(lease: ExecutionLease, signal?: AbortSignal): Promise<WorkerResult> {
    return this.runner.runLease(lease, signal);
  }

  openMcp(lease: ExecutionLease, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('MCP launch cancelled'));
    return this.requireMcp().open(lease);
  }

  writeMcp(sessionId: string, chunk: Uint8Array): Promise<void> { return this.requireMcp().write(sessionId, chunk); }
  endMcp(sessionId: string): Promise<void> { return this.requireMcp().end(sessionId); }
  readMcp(sessionId: string): Promise<McpReadResult> { return this.requireMcp().read(sessionId); }
  closeMcp(sessionId: string): Promise<void> { return this.requireMcp().close(sessionId); }

  private requireMcp(): McpProcessManager {
    if (this.mcp === undefined) throw new Error('MCP process manager is unavailable');
    return this.mcp;
  }
}

export class RpcWorkerExecutor implements WorkerExecutor {
  #peer: RpcPeer | undefined;

  attach(peer: RpcPeer): void {
    if (this.#peer !== undefined) throw new Error('A worker is already attached');
    this.#peer = peer;
  }

  detach(peer: RpcPeer): void {
    if (this.#peer === peer) this.#peer = undefined;
  }

  async run(lease: ExecutionLease, signal?: AbortSignal): Promise<WorkerResult> {
    if (this.#peer === undefined) throw new Error('Execution worker is unavailable');
    const result = await this.#peer.call('worker.run', lease as unknown as JsonValue, {
      timeoutMs: lease.timeoutMs + 5_000,
      ...(signal === undefined ? {} : { signal }),
    });
    return result as unknown as WorkerResult;
  }

  async openMcp(lease: ExecutionLease, signal?: AbortSignal): Promise<string> {
    const result = await this.requirePeer().call('worker.mcp.open', lease, {
      timeoutMs: 20_000,
      ...(signal === undefined ? {} : { signal }),
    }) as { sessionId: string };
    return result.sessionId;
  }

  async writeMcp(sessionId: string, chunk: Uint8Array): Promise<void> {
    await this.requirePeer().call('worker.mcp.write', { sessionId, chunkBase64: Buffer.from(chunk).toString('base64') });
  }

  async endMcp(sessionId: string): Promise<void> {
    await this.requirePeer().call('worker.mcp.end', { sessionId });
  }

  async readMcp(sessionId: string): Promise<McpReadResult> {
    const result = await this.requirePeer().call('worker.mcp.read', { sessionId }) as {
      stdoutBase64: string; stderrBase64: string; eof: boolean;
    };
    return {
      stdout: Buffer.from(result.stdoutBase64, 'base64'),
      stderr: Buffer.from(result.stderrBase64, 'base64'),
      eof: result.eof,
    };
  }

  async closeMcp(sessionId: string): Promise<void> {
    await this.requirePeer().call('worker.mcp.close', { sessionId });
  }

  private requirePeer(): RpcPeer {
    if (this.#peer === undefined) throw new Error('Execution worker is unavailable');
    return this.#peer;
  }
}
