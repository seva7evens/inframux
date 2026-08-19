import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
);

export async function resolveWorkspace(cwd, { stateRoot = DEFAULT_STATE_ROOT } = {}) {
  const requested = await realpath(cwd);
  let root = requested;
  let remote = '';

  try {
    root = await realpath(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: requested,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    root = requested;
  }

  const normalizedRemote = normalizeRemote(remote);
  const identity = normalizedRemote || `path:${root}`;
  const hash = createHash('sha256').update(`${identity}\0${root}`).digest('hex').slice(0, 16);
  const canonicalStateRoot = path.resolve(stateRoot);

  return Object.freeze({
    root,
    identity,
    hash,
    profileDir: path.join(canonicalStateRoot, 'profiles', hash),
    artifactDir: path.join(canonicalStateRoot, 'artifacts', hash),
  });
}

export async function assertContained(parent, candidate) {
  const parentAbsolute = path.resolve(parent);
  const candidateAbsolute = path.resolve(candidate);
  const lexicalRelative = path.relative(parentAbsolute, candidateAbsolute);
  if (isOutside(lexicalRelative)) {
    throw new Error(`Path is outside workspace: ${candidateAbsolute}`);
  }

  const parentReal = await realpath(parentAbsolute);
  const candidateStat = await lstat(candidateAbsolute);
  if (candidateStat.isSymbolicLink()) {
    throw new Error(`Symlink scripts are not allowed: ${candidateAbsolute}`);
  }

  const candidateReal = await realpath(candidateAbsolute);
  const realRelative = path.relative(parentReal, candidateReal);
  if (isOutside(realRelative)) {
    throw new Error(`Path resolves outside workspace: ${candidateAbsolute}`);
  }

  return candidateReal;
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Private state path is not a real directory: ${directory}`);
  }
  await chmod(directory, 0o700);
}

export function normalizeRemote(remote) {
  if (!remote) return '';

  let value = remote.trim();
  const scpMatch = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scpMatch && !value.includes('://')) {
    value = `${scpMatch[1]}/${scpMatch[2]}`;
  } else {
    try {
      const url = new URL(value);
      value = `${url.hostname}${url.pathname}`;
    } catch {
      return '';
    }
  }

  return value.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
}

function isOutside(relativePath) {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}
