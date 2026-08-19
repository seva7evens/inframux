import os from 'node:os';
import path from 'node:path';

export type SecurityMode = 'hardened' | 'user';

export interface InframuxPaths {
  readonly mode: SecurityMode;
  readonly root: string;
  readonly state: string;
  readonly run: string;
  readonly worker: string;
  readonly browserState: string;
  readonly browserTasks: string;
  readonly clientSocket: string;
  readonly workerSocket: string;
}

export function resolveInframuxPaths(options: {
  mode: SecurityMode;
  root?: string;
  home?: string;
}): InframuxPaths {
  const home = options.home ?? os.homedir();
  const root = path.resolve(
    options.root ??
      (options.mode === 'hardened'
        ? '/Library/Application Support/inframux'
        : path.join(home, '.config', 'inframux')),
  );
  const state = options.mode === 'hardened' ? path.join(root, 'state') : path.join(root, 'state');
  const run = path.join(root, 'run');
  const worker = path.join(root, 'worker');
  const browserRoot =
    options.mode === 'hardened' ? path.join(home, '.config', 'inframux') : root;
  return Object.freeze({
    mode: options.mode,
    root,
    state,
    run,
    worker,
    browserState: path.join(browserRoot, 'browser-state'),
    browserTasks: path.join(browserRoot, 'browser-tasks'),
    clientSocket: path.join(run, 'client.sock'),
    workerSocket: path.join(run, 'worker.sock'),
  });
}
