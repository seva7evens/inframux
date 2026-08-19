import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  assertContained,
  ensurePrivateDirectory,
  resolveWorkspace,
} from '../src/paths.mjs';

test('resolveWorkspace derives stable and isolated repository state paths', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'agent-playwright-paths-'));
  const stateRoot = path.join(sandbox, 'state');
  const first = path.join(sandbox, 'first');
  const second = path.join(sandbox, 'second');

  for (const [directory, remote] of [
    [first, 'git@github.com:example/first.git'],
    [second, 'https://github.com/example/second.git'],
  ]) {
    await mkdir(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: directory });
  }

  const firstContext = await resolveWorkspace(first, { stateRoot });
  const repeatedContext = await resolveWorkspace(path.join(first, '.'), { stateRoot });
  const secondContext = await resolveWorkspace(second, { stateRoot });

  assert.equal(firstContext.root, await realpath(first));
  assert.equal(firstContext.hash, repeatedContext.hash);
  assert.notEqual(firstContext.hash, secondContext.hash);
  assert.match(firstContext.identity, /^github\.com\/example\/first$/);
  assert.equal(firstContext.profileDir, path.join(stateRoot, 'profiles', firstContext.hash));
  assert.equal(firstContext.artifactDir, path.join(stateRoot, 'artifacts', firstContext.hash));
});

test('resolveWorkspace uses a canonical path identity outside Git', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'agent-playwright-nongit-'));
  const context = await resolveWorkspace(sandbox, { stateRoot: path.join(sandbox, 'state') });

  assert.equal(context.root, await realpath(sandbox));
  assert.equal(context.identity, `path:${await realpath(sandbox)}`);
  assert.match(context.hash, /^[a-f0-9]{16}$/);
});

test('assertContained accepts an existing child and rejects traversal', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'agent-playwright-contained-'));
  const workspace = path.join(sandbox, 'workspace');
  const child = path.join(workspace, 'scripts', 'check.mjs');
  await mkdir(path.dirname(child), { recursive: true });
  await BunWriteCompat(child, 'export default async () => {}');

  assert.equal(await assertContained(workspace, child), await realpath(child));
  await assert.rejects(assertContained(workspace, path.join(sandbox, 'outside.mjs')), /outside workspace/i);
});

test('assertContained rejects a symlink escaping the workspace', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'agent-playwright-symlink-'));
  const workspace = path.join(sandbox, 'workspace');
  const outside = path.join(sandbox, 'outside.mjs');
  const link = path.join(workspace, 'link.mjs');
  await mkdir(workspace);
  await BunWriteCompat(outside, 'export default async () => {}');
  await symlink(outside, link);

  await assert.rejects(assertContained(workspace, link), /outside workspace|symlink/i);
});

test('ensurePrivateDirectory enforces mode 0700', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'agent-playwright-mode-'));
  const target = path.join(sandbox, 'private');
  await mkdir(target, { mode: 0o755 });
  await chmod(target, 0o755);

  await ensurePrivateDirectory(target);

  const stat = await lstat(target);
  assert.equal(stat.mode & 0o777, 0o700);
});

async function BunWriteCompat(file, content) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, content, 'utf8');
}
