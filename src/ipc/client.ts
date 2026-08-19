import { createConnection } from 'node:net';

import { RpcPeer } from './peer.js';
import type { RpcHandler } from './peer.js';

export async function connectClient(
  socketPath: string,
  options: { handlers?: Readonly<Record<string, RpcHandler>> } = {},
): Promise<RpcPeer> {
  const socket = createConnection({ path: socketPath });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return new RpcPeer(socket, options);
}
