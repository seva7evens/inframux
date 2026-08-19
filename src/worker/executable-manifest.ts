import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { InframuxError } from '../core/errors.js';

const executableEntrySchema = z.object({
  path: z.string().startsWith('/'),
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,126}$/),
  kind: z.enum(['cli', 'mcp']),
  version: z.string().min(1).max(128),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const executableManifestSchema = z.object({
  schema: z.literal(1),
  runtimeNodeVersion: z.literal('24.18.1'),
  executables: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,126}$/), executableEntrySchema),
}).strict();

export type ExecutableEntry = z.infer<typeof executableEntrySchema>;
export type ExecutableManifest = z.infer<typeof executableManifestSchema>;

export async function loadExecutableManifest(filename: string): Promise<ExecutableManifest> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
    throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable manifest is mutable or not a regular file');
  }
  return executableManifestSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
}

export async function verifyExecutable(
  manifestInput: ExecutableManifest,
  executableId: string,
  options: { toolRoot: string; allowedOwnerUids: readonly number[] },
): Promise<ExecutableEntry> {
  const manifest = executableManifestSchema.parse(manifestInput);
  const entry = manifest.executables[executableId];
  if (entry === undefined) {
    throw new InframuxError('EXECUTABLE_NOT_APPROVED', `Executable is not approved: ${executableId}`);
  }
  const toolRoot = await realpath(options.toolRoot);
  if (!path.isAbsolute(entry.path)) throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable path must be absolute');

  const stat = await lstat(entry.path);
  if (stat.isSymbolicLink()) throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable is a symbolic link');
  if (!stat.isFile() || stat.nlink !== 1) throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable is not a unique regular file');
  if ((stat.mode & 0o022) !== 0) throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable is group/other writable');
  if (!options.allowedOwnerUids.includes(stat.uid)) throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable owner is not approved');

  const executableReal = await realpath(entry.path);
  if (outside(path.relative(toolRoot, executableReal))) {
    throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable resolves outside the approved tool root');
  }
  let parent = path.dirname(executableReal);
  while (true) {
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o022) !== 0) {
      throw new InframuxError('EXECUTABLE_NOT_APPROVED', `Executable parent is writable or unsafe: ${parent}`);
    }
    if (!options.allowedOwnerUids.includes(parentStat.uid)) {
      throw new InframuxError('EXECUTABLE_NOT_APPROVED', `Executable parent owner is not approved: ${parent}`);
    }
    if (parent === toolRoot) break;
    if (outside(path.relative(toolRoot, parent))) {
      throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable parent escaped tool root');
    }
    parent = path.dirname(parent);
  }

  const digest = createHash('sha256').update(await readFile(executableReal)).digest('hex');
  if (digest !== entry.sha256) throw new InframuxError('EXECUTABLE_NOT_APPROVED', 'Executable digest does not match manifest');
  return Object.freeze({ ...entry, path: executableReal });
}

function outside(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
