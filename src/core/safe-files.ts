import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function ensurePrivateDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Private directory is a symbolic link or non-directory: ${directory}`);
  }
  await chmod(directory, 0o700);
  return realpath(directory);
}

export async function assertSafeRegularFile(
  filename: string,
  options: { mode?: number } = {},
): Promise<void> {
  const expectedMode = options.mode ?? 0o600;
  const stat = await lstat(filename);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${filename}`);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${filename}`);
  if (stat.nlink !== 1) throw new Error(`Refusing hard linked file: ${filename}`);
  if ((stat.mode & 0o777) !== expectedMode) {
    throw new Error(
      `Unsafe file mode for ${filename}: expected ${expectedMode.toString(8)}, received ${(stat.mode & 0o777).toString(8)}`,
    );
  }
}

export async function atomicWritePrivateFile(
  root: string,
  relativeName: string,
  data: Uint8Array,
): Promise<string> {
  if (path.isAbsolute(relativeName)) throw new Error('Absolute paths are outside the state root');
  const normalized = path.normalize(relativeName);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.includes(`..${path.sep}`)
  ) {
    throw new Error(`Path traversal is outside the state root: ${relativeName}`);
  }
  const segments = normalized.split(path.sep).filter(Boolean);
  const leaf = segments.pop();
  if (!leaf || leaf === '.' || leaf === '..') throw new Error('A file name is required');

  const rootReal = await ensurePrivateDirectory(root);
  let parent = rootReal;
  for (const segment of segments) {
    const candidate = path.join(parent, segment);
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link parent: ${candidate}`);
      if (!stat.isDirectory()) throw new Error(`Expected directory parent: ${candidate}`);
      await chmod(candidate, 0o700);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      await mkdir(candidate, { mode: 0o700 });
    }
    const candidateReal = await realpath(candidate);
    assertWithin(rootReal, candidateReal);
    parent = candidateReal;
  }

  const destination = path.join(parent, leaf);
  try {
    await assertSafeRegularFile(destination);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }

  const temporary = path.join(parent, `.${leaf}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    const directoryHandle = await open(parent, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await assertSafeRegularFile(destination);
    return destination;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Resolved path is outside state root: ${candidate}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
