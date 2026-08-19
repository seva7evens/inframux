#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Redactor } from '../security/redactor.js';
import { assertRuntimeVersion } from '../core/version.js';
import { loadExecutableManifest } from '../worker/executable-manifest.js';
import { WorkerRunner } from '../worker/runner.js';
import { McpProcessManager } from '../worker/mcp-process.js';
import { startWorkerService } from '../worker/service.js';

export async function workerMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertRuntimeVersion();
  const socketPath = required(environment, 'INFRAMUX_WORKER_SOCKET');
  const workerRoot = required(environment, 'INFRAMUX_WORKER_ROOT');
  const toolRoot = required(environment, 'INFRAMUX_TOOL_ROOT');
  const manifest = await loadExecutableManifest(required(environment, 'INFRAMUX_EXECUTABLE_MANIFEST'));
  const redactor = new Redactor();
  const allowedOwnerUids = [0, process.getuid?.() ?? -1];
  await startWorkerService({
    socketPath,
    runner: new WorkerRunner({
      workerRoot,
      toolRoot,
      manifest,
      allowedOwnerUids,
      redactor,
    }),
    mcp: new McpProcessManager({ workerRoot, toolRoot, manifest, allowedOwnerUids, redactor }),
  });
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required worker environment: ${name}`);
  return value;
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  workerMain().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Worker failed'}\n`);
    process.exitCode = 1;
  });
}
