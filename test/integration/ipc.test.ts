import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { connectClient } from '../../src/ipc/client.js';
import { listenUnixSocket } from '../../src/ipc/server.js';
import { startBrokerSystem } from '../../src/broker/service.js';
import { RpcWorkerExecutor } from '../../src/broker/worker-executor.js';
import type { Broker } from '../../src/broker/broker.js';

test('serves concurrent request IDs over a private Unix socket', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-ipc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = path.join(root, 'client.sock');
  const server = await listenUnixSocket({
    socketPath,
    directoryMode: 0o770,
    socketMode: 0o660,
    handlers: {
      echo: async (payload) => payload,
      delayed: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, Number((payload as { delay: number }).delay)));
        return payload;
      },
    },
  });
  t.after(() => server.close());
  assert.equal((await lstat(root)).mode & 0o777, 0o770);
  assert.equal((await lstat(socketPath)).mode & 0o777, 0o660);

  const client = await connectClient(socketPath);
  t.after(() => client.close());
  const [slow, fast] = await Promise.all([
    client.call('delayed', { delay: 25, name: 'slow' }),
    client.call('echo', { name: 'fast' }),
  ]);
  assert.deepEqual(slow, { delay: 25, name: 'slow' });
  assert.deepEqual(fast, { name: 'fast' });
  await assert.rejects(() => client.call('missing', {}), /unknown operation/i);
});

test('propagates cancellation and deadlines and releases pending requests on disconnect', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await listenUnixSocket({
    socketPath: path.join(root, 'client.sock'),
    handlers: {
      wait: async (_payload, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
      }),
    },
  });
  t.after(() => server.close());
  const client = await connectClient(path.join(root, 'client.sock'));

  const controller = new AbortController();
  const cancelled = client.call('wait', {}, { signal: controller.signal, timeoutMs: 5_000 });
  controller.abort(new Error('user cancelled'));
  await assert.rejects(() => cancelled, /cancelled/i);

  await assert.rejects(() => client.call('wait', {}, { timeoutMs: 20 }), /deadline|timed out/i);
  const disconnected = client.call('wait', {}, { timeoutMs: 5_000 });
  client.close();
  await assert.rejects(() => disconnected, /closed|disconnect/i);
});

test('reports broker protocol readiness only after the execution worker is attached', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-health-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clientSocketPath = path.join(root, 'client.sock');
  const workerSocketPath = path.join(root, 'worker.sock');
  const worker = new RpcWorkerExecutor();
  const system = await startBrokerSystem({
    clientSocketPath, workerSocketPath, worker, callerUid: process.getuid!(), releaseVersion: '0.1.4',
    broker: { handle: async () => ({ schema: 1 }) } as unknown as Broker,
  });
  t.after(() => system.close());
  const client = await connectClient(clientSocketPath);
  t.after(() => client.close());

  assert.deepEqual(await client.call('system.health', {}, { timeoutMs: 1_000 }), {
    schema: 1, releaseVersion: '0.1.4', brokerReady: true, workerReady: false,
  });
  const workerPeer = await connectClient(workerSocketPath);
  t.after(() => workerPeer.close());
  assert.deepEqual(await client.call('system.health', {}, { timeoutMs: 1_000 }), {
    schema: 1, releaseVersion: '0.1.4', brokerReady: true, workerReady: true,
  });
});
