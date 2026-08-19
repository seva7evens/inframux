import type { Readable, Writable } from 'node:stream';

import { loadRepositoryManifest } from '../config/load.js';
import { collectCheckoutEvidence } from '../git/evidence.js';
import { pumpMcpTunnel, type McpTunnelTransport } from '../ipc/byte-tunnel.js';
import { connectClient } from '../ipc/client.js';

export async function launchMcpFromRepository(provider: string, options: {
  cwd: string;
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  socketPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const evidence = await collectCheckoutEvidence(options.cwd);
  const manifest = await loadRepositoryManifest(evidence.manifestPath);
  const client = await connectClient(options.socketPath);
  try {
    const opened = await client.call('mcp.open', { evidence, manifest, provider }, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }) as { sessionId: string };
    let closed = false;
    const transport: McpTunnelTransport = {
      write: async (chunk) => {
        await client.call('mcp.write', {
          sessionId: opened.sessionId,
          chunkBase64: Buffer.from(chunk).toString('base64'),
        });
      },
      end: async () => { await client.call('mcp.end', { sessionId: opened.sessionId }); },
      read: async () => {
        const result = await client.call('mcp.read', { sessionId: opened.sessionId }) as {
          stdoutBase64: string; stderrBase64: string; eof: boolean;
        };
        return {
          stdout: Buffer.from(result.stdoutBase64, 'base64'),
          stderr: Buffer.from(result.stderrBase64, 'base64'),
          eof: result.eof,
        };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await client.call('mcp.close', { sessionId: opened.sessionId });
      },
    };
    await pumpMcpTunnel({
      input: options.input,
      output: options.output,
      errorOutput: options.errorOutput,
      transport,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    client.close();
  }
}
