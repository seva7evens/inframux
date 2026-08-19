import { createHash } from 'node:crypto';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { RUNTIME_NODE_VERSION } from '../core/version.js';

export interface BundleFile {
  readonly path: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly installUid: number;
  readonly installGid: number;
  readonly size: number;
  readonly digest: string;
}

export interface BundleManifest {
  readonly schema: 1;
  readonly version: string;
  readonly nodeVersion: string;
  readonly files: readonly BundleFile[];
}

export async function createBundleManifest(root: string, metadata: {
  version: string;
  nodeVersion: string;
  installUid?: number;
  installGid?: number;
}): Promise<BundleManifest> {
  validateMetadata(metadata);
  const canonicalRoot = await realpath(root);
  const relativeFiles = await walk(canonicalRoot, '');
  const files: BundleFile[] = [];
  const installUid = metadata.installUid ?? 0;
  const installGid = metadata.installGid ?? 0;
  validateOwner(installUid, 'installUid');
  validateOwner(installGid, 'installGid');
  for (const relativePath of relativeFiles.sort(compareUtf8)) {
    files.push(await inspectFile(canonicalRoot, relativePath, installUid, installGid));
  }
  if (files.length === 0) throw new Error('Install bundle cannot be empty');
  return Object.freeze({
    schema: 1,
    version: metadata.version,
    nodeVersion: metadata.nodeVersion,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
}

export async function verifyBundle(root: string, manifest: BundleManifest): Promise<void> {
  validateMetadata(manifest);
  const canonicalRoot = await realpath(root);
  const actualPaths = (await walk(canonicalRoot, '')).sort(compareUtf8);
  const expectedPaths = manifest.files.map((file) => file.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error('Install bundle file set changed');
  for (const expected of manifest.files) {
    const actual = await inspectFile(canonicalRoot, expected.path, expected.installUid, expected.installGid);
    if (actual.mode !== expected.mode || actual.uid !== expected.uid || actual.gid !== expected.gid ||
        actual.size !== expected.size || actual.digest !== expected.digest) {
      throw new Error(`Install bundle file changed: ${expected.path}`);
    }
  }
}

async function walk(root: string, relativeDirectory: string): Promise<string[]> {
  const absolute = path.join(root, relativeDirectory);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Install bundle directory is unsafe: ${relativeDirectory || '.'}`);
  const files: string[] = [];
  const directory = await opendir(absolute);
  for await (const entry of directory) {
    const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Install bundle rejects symbolic link: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await walk(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`Install bundle entry is not a regular file: ${relativePath}`);
  }
  return files;
}

async function inspectFile(root: string, relativePath: string, installUid: number, installGid: number): Promise<BundleFile> {
  if (path.posix.normalize(relativePath) !== relativePath || path.posix.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new Error(`Unsafe install bundle path: ${relativePath}`);
  }
  const absolute = path.join(root, ...relativePath.split('/'));
  const selected = await lstat(absolute);
  if (!selected.isFile() || selected.isSymbolicLink()) throw new Error(`Install bundle rejects non-regular file: ${relativePath}`);
  if (selected.nlink !== 1) throw new Error(`Install bundle rejects hard link: ${relativePath}`);
  const handle = await open(absolute, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== selected.ino || opened.dev !== selected.dev || opened.nlink !== 1 || !opened.isFile()) {
      throw new Error(`Install bundle file changed while opening: ${relativePath}`);
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== contents.length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`Install bundle file changed while hashing: ${relativePath}`);
    }
    return {
      path: relativePath,
      mode: opened.mode & 0o777,
      uid: opened.uid,
      gid: opened.gid,
      installUid,
      installGid,
      size: contents.length,
      digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    };
  } finally {
    await handle.close();
  }
}

function validateOwner(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid bundle ${label}`);
}

function validateMetadata(metadata: { version: string; nodeVersion: string }): void {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(metadata.version)) throw new Error('Invalid sealed bundle version');
  if (metadata.nodeVersion !== RUNTIME_NODE_VERSION) throw new Error(`Install bundle requires Node ${RUNTIME_NODE_VERSION}`);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
