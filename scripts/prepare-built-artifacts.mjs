#!/usr/bin/env node
import { chmodSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const executable = path.join(repositoryRoot, 'dist/src/bin/inframux.js');
const stat = lstatSync(executable);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
  throw new Error(`Unsafe compiled executable: ${executable}`);
}
if (!readFileSync(executable, 'utf8').startsWith('#!/usr/bin/env node\n')) {
  throw new Error('Compiled inframux executable is missing its Node shebang');
}
chmodSync(executable, 0o755);
