import type { JsonValue } from '../core/json.js';
import { connectClient } from '../ipc/client.js';
import type { RpcPeer } from '../ipc/peer.js';
import type { RpcHandler } from '../ipc/peer.js';
import type { ExecutionLease, WorkerResult, WorkerRunner } from './runner.js';
import type { McpProcessManager } from './mcp-process.js';

export async function startWorkerService(options: {
  socketPath: string;
  runner: WorkerRunner;
  mcp?: McpProcessManager;
}): Promise<RpcPeer> {
  const handlers: Record<string, RpcHandler> = {
    'worker.run': async (payload, context) => {
        const result: WorkerResult = await options.runner.runLease(
          payload as unknown as ExecutionLease,
          context.signal,
        );
        return result as unknown as JsonValue;
    },
  };
  const mcp = options.mcp;
  if (mcp !== undefined) {
    handlers['worker.mcp.open'] = async (payload) => ({ sessionId: await mcp.open(payload as unknown as ExecutionLease) });
    handlers['worker.mcp.write'] = async (payload) => {
      const input = payload as { sessionId: string; chunkBase64: string };
      await mcp.write(input.sessionId, Buffer.from(input.chunkBase64, 'base64'));
      return { ok: true };
    };
    handlers['worker.mcp.end'] = async (payload) => {
      await mcp.end((payload as { sessionId: string }).sessionId);
      return { ok: true };
    };
    handlers['worker.mcp.read'] = async (payload) => {
      const result = await mcp.read((payload as { sessionId: string }).sessionId);
      return {
        stdoutBase64: result.stdout.toString('base64'),
        stderrBase64: result.stderr.toString('base64'),
        eof: result.eof,
      };
    };
    handlers['worker.mcp.close'] = async (payload) => {
      await mcp.close((payload as { sessionId: string }).sessionId);
      return { ok: true };
    };
  }
  return connectClient(options.socketPath, {
    handlers,
  });
}
