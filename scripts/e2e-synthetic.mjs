#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

for (const [executable, args] of [
  [process.execPath, ['--version']],
  [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']],
  [path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['--test', 'test/e2e/*.test.ts']],
  [process.execPath, ['scripts/cli-journey-smoke.mjs', './bin/inframux']],
]) {
  const result = spawnSync(executable, args, { stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
