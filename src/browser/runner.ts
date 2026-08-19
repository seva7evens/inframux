import { spawn, type StdioOptions } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';

import type { BrowserLaunchPlan } from './types.js';
import { acquireBrowserProfile } from './manager.js';

const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'PATH', 'SHELL', 'LANG', 'TERM',
  '__CF_USER_TEXT_ENCODING', 'COLORTERM', 'NO_COLOR',
]);

export async function runBrowserPlan(plan: BrowserLaunchPlan, options: {
  stdio?: StdioOptions;
  environment?: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
} = {}): Promise<void> {
  await assertTrustedLauncher(plan.executable);
  const lease = await acquireBrowserProfile(plan);
  try {
    const child = spawn(plan.executable, [...plan.args], {
      cwd: plan.context.repositoryRoot,
      env: sanitizeBrowserEnvironment(options.environment ?? process.env),
      shell: false,
      stdio: options.stdio ?? 'inherit',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else if (signal !== null) reject(new Error(`Browser runtime exited after signal ${signal}`));
        else reject(new Error(`Browser runtime exited with code ${code ?? 'unknown'}`));
      });
    });
  } finally {
    await lease.release();
  }
}

export function sanitizeBrowserEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const target: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('LC_') && value !== undefined) target[key] = value;
  }
  return target;
}

async function assertTrustedLauncher(executable: string): Promise<void> {
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Browser runtime launcher is not a safe regular file: ${executable}`);
  }
  await access(executable, fsConstants.X_OK);
}
