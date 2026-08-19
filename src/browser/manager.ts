import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { ensurePrivateDirectory } from '../core/safe-files.js';
import type { ResolvedProjectContext } from '../trust/types.js';
import type { BrowserLaunchPlan, BrowserMode, BrowserProfileLease } from './types.js';

export function planBrowserLaunch(input: {
  mode: BrowserMode;
  context: ResolvedProjectContext;
  provider?: string;
  taskId?: string;
  browserStateRoot: string;
  browserTasksRoot: string;
  runtimeLauncher: string;
}): BrowserLaunchPlan {
  if (!path.isAbsolute(input.runtimeLauncher)) throw new Error('Browser runtime launcher must be absolute');
  if (!path.isAbsolute(input.browserStateRoot) || !path.isAbsolute(input.browserTasksRoot)) {
    throw new Error('Browser state roots must be absolute');
  }
  validateId(input.context.project, 'project');
  if (input.mode === 'persistent') {
    const provider = input.provider;
    if (provider === undefined) throw new Error('Persistent browser mode requires a provider');
    validateId(provider, 'provider');
    const profileDir = path.join(input.browserStateRoot, input.context.project, provider);
    const artifactDir = path.join(input.browserStateRoot, '.artifacts', input.context.project, provider);
    const lockPath = path.join(input.browserStateRoot, '.locks', input.context.project, `${provider}.lock`);
    return Object.freeze({
      mode: 'persistent',
      project: input.context.project,
      provider,
      context: input.context,
      executable: input.runtimeLauncher,
      args: Object.freeze(managedArgs(profileDir, artifactDir)),
      profileDir,
      artifactDir,
      taskRoot: null,
      lockPath,
      cleanup: false,
    });
  }
  const taskId = input.taskId ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error('Clean browser task ID must be a UUID');
  const taskRoot = path.join(input.browserTasksRoot, taskId);
  const profileDir = path.join(taskRoot, 'profile');
  const artifactDir = path.join(taskRoot, 'artifacts');
  return Object.freeze({
    mode: 'clean',
    project: input.context.project,
    provider: null,
    context: input.context,
    executable: input.runtimeLauncher,
    args: Object.freeze(managedArgs(profileDir, artifactDir)),
    profileDir,
    artifactDir,
    taskRoot,
    lockPath: null,
    cleanup: true,
  });
}

export async function acquireBrowserProfile(plan: BrowserLaunchPlan): Promise<BrowserProfileLease> {
  if (plan.mode === 'persistent') {
    if (plan.lockPath === null) throw new Error('Persistent browser plan has no lock');
    await ensurePrivateDirectory(path.dirname(plan.lockPath));
    try {
      await mkdir(plan.lockPath, { mode: 0o700 });
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) throw new Error(`Persistent browser profile is already in use (locked): ${plan.project}/${plan.provider}`);
      throw error;
    }
    try {
      await ensurePrivateDirectory(plan.profileDir);
      await ensurePrivateDirectory(plan.artifactDir);
    } catch (error) {
      await rm(plan.lockPath, { recursive: true, force: true });
      throw error;
    }
    let released = false;
    return {
      plan,
      release: async () => {
        if (released) return;
        released = true;
        await rm(plan.lockPath!, { recursive: true, force: true });
      },
    };
  }

  if (plan.taskRoot === null) throw new Error('Clean browser plan has no task root');
  await ensurePrivateDirectory(path.dirname(plan.taskRoot));
  await mkdir(plan.taskRoot, { mode: 0o700 });
  await ensurePrivateDirectory(plan.profileDir);
  await ensurePrivateDirectory(plan.artifactDir);
  let released = false;
  return {
    plan,
    release: async () => {
      if (released) return;
      released = true;
      await cleanupCleanProfile(path.dirname(plan.taskRoot!), plan.taskRoot!);
    },
  };
}

export async function cleanupCleanProfile(browserTasksRoot: string, taskRoot: string): Promise<void> {
  const stat = await lstat(taskRoot);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link browser cleanup target: ${taskRoot}`);
  if (!stat.isDirectory()) throw new Error(`Browser cleanup target is not a directory: ${taskRoot}`);
  const rootReal = await realpath(browserTasksRoot);
  const taskReal = await realpath(taskRoot);
  const relative = path.relative(rootReal, taskReal);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Browser cleanup target escapes task root: ${taskRoot}`);
  }
  await rm(taskReal, { recursive: true, force: false });
}

function managedArgs(profileDir: string, artifactDir: string): string[] {
  return [
    'mcp',
    '--user-data-dir', profileDir,
    '--output-dir', artifactDir,
    '--output-max-size', '104857600',
    '--codegen', 'typescript',
  ];
}

function validateId(value: string, label: string): void {
  if (!/^[a-z][a-z0-9-]{1,126}$/.test(value)) throw new Error(`Invalid browser ${label}: ${value}`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
