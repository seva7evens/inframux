#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Redactor } from '../security/redactor.js';
import { assertRuntimeVersion } from '../core/version.js';
import { loadExecutableManifest } from '../worker/executable-manifest.js';
import { WorkerRunner } from '../worker/runner.js';
import { McpProcessManager } from '../worker/mcp-process.js';
import { startWorkerService } from '../worker/service.js';
import { clearDaemonDiagnostic, writeDaemonDiagnostic } from '../install/daemon-diagnostic.js';

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
  if (environment.INFRAMUX_DIAGNOSTIC_ROOT !== undefined) {
    await clearDaemonDiagnostic(environment.INFRAMUX_DIAGNOSTIC_ROOT);
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required worker environment: ${name}`);
  return value;
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  workerMain().catch(async (error: unknown) => {
    const diagnosticRoot = process.env.INFRAMUX_DIAGNOSTIC_ROOT;
    if (diagnosticRoot !== undefined) await writeDaemonDiagnostic(diagnosticRoot, 'worker', error).catch(() => undefined);
    process.stderr.write('Worker failed to start; run inframux bootstrap --apply to repair or automatically roll back.\n');
    process.exitCode = 1;
  });
}
