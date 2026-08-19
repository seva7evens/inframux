#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { launchBrowserFromRepository } from '../cli/browser-launch.js';
import { runCli } from '../cli/main.js';
import { launchMcpFromRepository } from '../cli/mcp-launch.js';
import { parseCli } from '../cli/parse.js';
import { renderError } from '../cli/render.js';
import { resolveInframuxPaths } from '../core/paths.js';
import { assertRuntimeVersion } from '../core/version.js';

export async function main(): Promise<number> {
  assertRuntimeVersion();
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.command === 'browser.mcp') {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const paths = resolveInframuxPaths({ mode: 'hardened' });
      await launchBrowserFromRepository(parsed.mode, parsed.provider, {
        cwd: process.cwd(),
        socketPath: process.env.INFRAMUX_CLIENT_SOCKET ?? paths.clientSocket,
        browserStateRoot: process.env.INFRAMUX_BROWSER_STATE ?? paths.browserState,
        browserTasksRoot: process.env.INFRAMUX_BROWSER_TASKS ?? paths.browserTasks,
        runtimeLauncher: process.env.INFRAMUX_PLAYWRIGHT_LAUNCHER ?? defaultPlaywrightLauncher(),
        stdio: 'inherit',
        environment: process.env,
        signal: controller.signal,
      });
      return 0;
    } catch (error) {
      const rendered = renderError(error, parsed.json);
      process.stderr.write(`${rendered.text}\n`);
      return rendered.exitCode;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  if (parsed.command === 'launch.mcp') {
    try {
      await launchMcpFromRepository(parsed.provider, {
        cwd: process.cwd(),
        input: process.stdin,
        output: process.stdout,
        errorOutput: process.stderr,
        socketPath: process.env.INFRAMUX_CLIENT_SOCKET ?? '/Library/Application Support/inframux/run/client.sock',
      });
      return 0;
    } catch (error) {
      const rendered = renderError(error, false);
      process.stderr.write(`${rendered.text}\n`);
      return rendered.exitCode;
    }
  }
  return runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdin: process.stdin,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    terminalColumns: process.stderr.columns,
    environment: process.env,
  });
}

function defaultPlaywrightLauncher(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = moduleDirectory.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(moduleDirectory, '../../..')
    : path.resolve(moduleDirectory, '../..');
  return path.join(packageRoot, 'bin', 'agent-playwright');
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'inframux failed'}\n`);
    process.exitCode = 1;
  });
}
