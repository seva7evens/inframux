import type { JsonValue } from '../core/json.js';
import { listenUnixSocket, type UnixRpcServer } from '../ipc/server.js';
import type { RpcHandler } from '../ipc/peer.js';
import type { Broker } from './broker.js';
import { RpcWorkerExecutor } from './worker-executor.js';

const PUBLIC_OPERATIONS = Object.freeze([
  'project.resolve',
  'status',
  'doctor',
  'audit.verify',
  'credential.enroll',
  'credential.enrollment-info',
  'credential.status',
  'credential.revoke',
  'onboarding.start',
  'onboarding.configure',
  'onboarding.status',
  'onboarding.resume',
  'onboarding.provider-verified',
  'onboarding.reuse',
  'onboarding.finish',
  'trust.request',
  'trust.approve',
  'trust.revoke',
  'run',
  'call',
  'mcp.open',
  'mcp.write',
  'mcp.end',
  'mcp.read',
  'mcp.close',
]);

export async function startBrokerService(options: {
  socketPath: string;
  broker: Broker;
  callerUid: number;
  sharedSockets?: boolean;
}): Promise<UnixRpcServer> {
  const handlers = Object.fromEntries(PUBLIC_OPERATIONS.map((operation) => [
    operation,
    (async (payload, context) => options.broker.handle(operation, payload, {
      callerUid: options.callerUid,
      signal: context.signal,
    })) satisfies RpcHandler,
  ])) as Record<string, RpcHandler>;
  return listenUnixSocket({
    socketPath: options.socketPath,
    handlers,
    ...(options.sharedSockets ? { directoryMode: 0o770 as const, socketMode: 0o660 as const } : {}),
  });
}

export async function startBrokerSystem(options: {
  clientSocketPath: string;
  workerSocketPath: string;
  broker: Broker;
  worker: RpcWorkerExecutor;
  callerUid: number;
  sharedSockets?: boolean;
}): Promise<{ close(): Promise<void> }> {
  const workerServer = await listenUnixSocket({
    socketPath: options.workerSocketPath,
    handlers: {},
    onPeer: (peer) => {
      try {
        options.worker.attach(peer);
        peer.onClose(() => options.worker.detach(peer));
      } catch {
        peer.close();
      }
    },
    ...(options.sharedSockets ? { directoryMode: 0o770 as const, socketMode: 0o660 as const } : {}),
  });
  let clientServer: UnixRpcServer;
  try {
    clientServer = await startBrokerService({
      socketPath: options.clientSocketPath,
      broker: options.broker,
      callerUid: options.callerUid,
      ...(options.sharedSockets ? { sharedSockets: true } : {}),
    });
  } catch (error) {
    await workerServer.close();
    throw error;
  }
  return {
    close: async () => {
      await clientServer.close();
      await workerServer.close();
    },
  };
}

export function publicBrokerOperations(): readonly JsonValue[] {
  return PUBLIC_OPERATIONS;
}
