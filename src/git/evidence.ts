import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { InframuxError } from '../core/errors.js';
import { normalizeGitRemote } from './remote.js';

const execute = promisify(execFile);

export interface CheckoutEvidence {
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly normalizedRemotes: readonly string[];
}

export interface GitRepositoryIdentity {
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly normalizedRemotes: readonly string[];
}

export async function inspectGitRepository(cwd: string): Promise<GitRepositoryIdentity> {
  const requested = await realpath(cwd);
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath((await git(requested, ['rev-parse', '--show-toplevel'])).trim());
  } catch (error) {
    throw new InframuxError('PROJECT_NOT_BOUND', 'Current directory is not a Git checkout', { cause: error });
  }
  const commonOutput = (await git(repositoryRoot, ['rev-parse', '--git-common-dir'])).trim();
  const gitCommonDir = await realpath(path.resolve(repositoryRoot, commonOutput));
  const remoteNames = splitLines(await git(repositoryRoot, ['remote']));
  const normalized = new Set<string>();
  for (const name of remoteNames) {
    for (const args of [['remote', 'get-url', '--all', name], ['remote', 'get-url', '--push', '--all', name]]) {
      try { for (const value of splitLines(await git(repositoryRoot, args))) normalized.add(normalizeGitRemote(value)); }
      catch { /* a remote may have no separate push URL */ }
    }
  }
  return Object.freeze({ repositoryRoot, gitCommonDir, normalizedRemotes: Object.freeze([...normalized].sort()) });
}

export async function collectCheckoutEvidence(cwd: string): Promise<CheckoutEvidence> {
  const { repositoryRoot, gitCommonDir, normalizedRemotes } = await inspectGitRepository(cwd);

  const manifestPath = path.join(repositoryRoot, '.inframux.toml');
  let manifest: Buffer;
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('manifest is not a unique regular file');
    }
    manifest = await readFile(manifestPath);
  } catch (error) {
    throw new InframuxError('PROJECT_NOT_BOUND', 'Repository has no safe .inframux.toml manifest', {
      cause: error,
      recovery: `inframux link --project <project> ${repositoryRoot}`,
    });
  }

  return Object.freeze({
    repositoryRoot,
    gitCommonDir,
    manifestPath,
    manifestDigest: `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
    normalizedRemotes,
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}
