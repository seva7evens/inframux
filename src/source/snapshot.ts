import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, type JsonValue } from '../core/json.js';
import {
  isMandatorySourceExclusion,
  validateIgnorePattern,
  validateSnapshotPolicy,
  type SourceSnapshotPolicy,
} from './policy.js';

export interface SnapshotFileSummary {
  readonly path: string;
  readonly size: number;
  readonly digest: string;
}

export interface SnapshotSummary {
  readonly schema: 1;
  readonly digest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly SnapshotFileSummary[];
}

export interface SourceSnapshot {
  readonly summary: SnapshotSummary;
  stream(): AsyncIterable<Buffer>;
}

interface CapturedFile extends SnapshotFileSummary {
  readonly contents: Buffer;
}

export async function buildSourceSnapshot(
  checkout: { readonly repositoryRoot: string },
  policy: SourceSnapshotPolicy,
  hooks: { beforeRead?: (relativePath: string) => Promise<void> } = {},
): Promise<SourceSnapshot> {
  validateSnapshotPolicy(policy);
  const repositoryRoot = await realpath(checkout.repositoryRoot);
  const listed = await listGitFiles(repositoryRoot, policy.includeUntracked);
  const candidates = listed
    .map(decodeGitPath)
    .map(validateRelativePath)
    .filter((relativePath) => !isMandatorySourceExclusion(relativePath))
    .sort(compareUtf8);

  let ignorePatterns = [...policy.ignorePatterns];
  if (candidates.includes('.inframuxignore')) {
    const ignoreFile = await captureFile(repositoryRoot, '.inframuxignore', policy.maxFileBytes, hooks.beforeRead);
    ignorePatterns = [...ignorePatterns, ...parseIgnoreFile(ignoreFile.contents)];
  }
  const selected = candidates.filter((relativePath) =>
    relativePath === '.inframuxignore' || !ignorePatterns.some((pattern) => matchesIgnore(relativePath, pattern)),
  );
  if (selected.length > policy.maxFiles) throw new Error('Source snapshot file count limit exceeded');

  const captured: CapturedFile[] = [];
  let totalBytes = 0;
  for (const relativePath of selected) {
    const file = await captureFile(repositoryRoot, relativePath, policy.maxFileBytes, hooks.beforeRead);
    assertNoSecrets(file.contents, policy.secretCanaries, relativePath);
    totalBytes += file.size;
    if (totalBytes > policy.maxTotalBytes) throw new Error('Source snapshot total byte limit exceeded');
    captured.push(file);
  }

  const files = Object.freeze(captured.map(({ path: filePath, size, digest }) => Object.freeze({ path: filePath, size, digest })));
  const manifest = {
    schema: 1,
    files: files.map((file) => ({ path: file.path, size: file.size, digest: file.digest })),
  } satisfies JsonValue;
  const digest = `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;
  const summary: SnapshotSummary = Object.freeze({ schema: 1, digest, fileCount: files.length, totalBytes, files });
  const archive = encodeSnapshot(summary, captured);
  return Object.freeze({
    summary,
    stream: async function* () { yield Buffer.from(archive); },
  });
}

async function listGitFiles(repositoryRoot: string, includeUntracked: boolean): Promise<Buffer[]> {
  const args = ['-c', 'core.hooksPath=/dev/null', 'ls-files', '-z', '--cached'];
  if (includeUntracked) args.push('--others', '--exclude-standard');
  const stdout = await new Promise<Buffer>((resolve, reject) => {
    execFile('git', args, {
      cwd: repositoryRoot,
      encoding: 'buffer',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    }, (error, output) => error === null ? resolve(output) : reject(error));
  });
  const entries: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < stdout.length; index += 1) {
    if (stdout[index] !== 0) continue;
    if (index > start) entries.push(Buffer.from(stdout.subarray(start, index)));
    start = index + 1;
  }
  if (start !== stdout.length) throw new Error('Git returned an unterminated source path');
  return entries;
}

function decodeGitPath(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

function validateRelativePath(value: string): string {
  if (value.length === 0 || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error(`Unsafe source snapshot path: ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe source snapshot traversal path: ${JSON.stringify(value)}`);
  }
  return value;
}

async function captureFile(
  repositoryRoot: string,
  relativePath: string,
  maxFileBytes: number,
  beforeRead: ((relativePath: string) => Promise<void>) | undefined,
): Promise<CapturedFile> {
  const absolute = path.join(repositoryRoot, ...relativePath.split('/'));
  const parentReal = await realpath(path.dirname(absolute));
  assertContained(repositoryRoot, parentReal);
  const selected = await lstat(absolute, { bigint: true });
  if (selected.isSymbolicLink()) throw new Error(`Source snapshot rejects symbolic link: ${relativePath}`);
  if (!selected.isFile()) throw new Error(`Source snapshot candidate is not a regular file: ${relativePath}`);
  if (selected.nlink !== 1n) throw new Error(`Source snapshot rejects hard link: ${relativePath}`);
  if (selected.size > BigInt(maxFileBytes)) throw new Error(`Source snapshot file byte limit exceeded: ${relativePath}`);
  await beforeRead?.(relativePath);

  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertStable(selected, opened, relativePath);
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertStable(opened, after, relativePath);
    if (contents.length !== Number(after.size)) throw new Error(`Source snapshot file changed while reading: ${relativePath}`);
    return Object.freeze({
      path: relativePath,
      size: contents.length,
      digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
      contents,
    });
  } finally {
    await handle.close();
  }
}

function assertStable(before: BigIntStats, after: BigIntStats, relativePath: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) {
    throw new Error(`Source snapshot file mutated during capture: ${relativePath}`);
  }
}

interface BigIntStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Source snapshot path escapes repository root');
  }
}

function parseIgnoreFile(contents: Buffer): string[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
  const patterns = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  for (const pattern of patterns) validateIgnorePattern(pattern);
  return patterns;
}

function matchesIgnore(relativePath: string, pattern: string): boolean {
  const normalized = pattern.endsWith('/') ? `${pattern}**` : pattern;
  return path.matchesGlob(relativePath, normalized) || (!normalized.includes('/') && path.matchesGlob(relativePath, `**/${normalized}`));
}

function assertNoSecrets(contents: Buffer, canaries: readonly string[], relativePath: string): void {
  for (const canary of canaries) {
    if (contents.includes(Buffer.from(canary))) throw new Error(`Source snapshot secret canary detected in ${relativePath}`);
  }
  if (contents.includes(Buffer.from('-----BEGIN PRIVATE KEY-----'))) {
    throw new Error(`Source snapshot private-key secret detected in ${relativePath}`);
  }
}

function encodeSnapshot(summary: SnapshotSummary, files: readonly CapturedFile[]): Buffer {
  const header = canonicalJson({
    schema: 1,
    digest: summary.digest,
    fileCount: summary.fileCount,
    totalBytes: summary.totalBytes,
  });
  const records = files.map((file) => canonicalJson({
    path: file.path,
    size: file.size,
    digest: file.digest,
    dataBase64: file.contents.toString('base64'),
  }));
  return Buffer.from(`${[header, ...records].join('\n')}\n`);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
