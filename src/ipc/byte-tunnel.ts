import type { Readable, Writable } from 'node:stream';

export interface McpReadResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly eof: boolean;
}

export interface McpTunnelTransport {
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
  read(): Promise<McpReadResult>;
  close(): Promise<void>;
}

export async function pumpMcpTunnel(options: {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  transport: McpTunnelTransport;
  signal?: AbortSignal;
}): Promise<void> {
  const inputTask = (async () => {
    for await (const chunk of options.input) {
      if (options.signal?.aborted) throw new Error('MCP tunnel cancelled');
      await options.transport.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await options.transport.end();
  })();
  const outputTask = (async () => {
    while (true) {
      if (options.signal?.aborted) throw new Error('MCP tunnel cancelled');
      const result = await options.transport.read();
      await writeChunk(options.output, result.stdout);
      await writeChunk(options.errorOutput, result.stderr);
      if (result.eof) return;
    }
  })();
  try {
    await Promise.all([inputTask, outputTask]);
  } finally {
    await options.transport.close();
  }
}

async function writeChunk(stream: Writable, chunk: Buffer): Promise<void> {
  if (chunk.length === 0) return;
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}
