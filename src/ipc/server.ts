import { chmod, lstat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

import { ensurePrivateDirectory } from '../core/safe-files.js';
import { RpcPeer, type RpcHandler } from './peer.js';

export interface UnixRpcServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

export async function listenUnixSocket(options: {
  socketPath: string;
  handlers: Readonly<Record<string, RpcHandler>>;
  maxFrameBytes?: number;
  onPeer?: (peer: RpcPeer) => void;
  directoryMode?: 0o700 | 0o770;
  socketMode?: 0o600 | 0o660;
}): Promise<UnixRpcServer> {
  if (Buffer.byteLength(options.socketPath) > 100) {
    throw new Error('Unix socket path is too long for macOS');
  }
  const directory = await ensurePrivateDirectory(path.dirname(options.socketPath));
  await chmod(directory, options.directoryMode ?? 0o700);
  try {
    await lstat(options.socketPath);
    throw new Error(`Unix socket path already exists: ${options.socketPath}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  const peers = new Set<RpcPeer>();
  const server = createServer((socket) => {
    const peer = new RpcPeer(socket, {
      handlers: options.handlers,
      ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    });
    peers.add(peer);
    options.onPeer?.(peer);
    socket.once('close', () => peers.delete(peer));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(options.socketPath);
  });
  await chmod(options.socketPath, options.socketMode ?? 0o600);
  return {
    socketPath: options.socketPath,
    close: async () => {
      for (const peer of peers) peer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}
