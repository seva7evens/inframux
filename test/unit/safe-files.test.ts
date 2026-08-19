import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSafeRegularFile,
  atomicWritePrivateFile,
  ensurePrivateDirectory,
} from '../../src/core/safe-files.js';

test('creates private directories and atomically replaces private regular files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-safe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');

  await ensurePrivateDirectory(state);
  await atomicWritePrivateFile(state, 'credentials/token.secret', Buffer.from('first'));
  await atomicWritePrivateFile(state, 'credentials/token.secret', Buffer.from('second'));

  assert.equal(await readFile(path.join(state, 'credentials/token.secret'), 'utf8'), 'second');
  assert.equal((await lstat(state)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(state, 'credentials'))).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(state, 'credentials/token.secret'))).mode & 0o777, 0o600);
});

test('rejects traversal, symlink parents, symlink leaves, hard links, and permissive files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-attacks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await ensurePrivateDirectory(path.join(root, 'state'));
  await mkdir(path.join(root, 'outside'));

  await assert.rejects(
    () => atomicWritePrivateFile(path.join(root, 'state'), '../outside/token', Buffer.from('x')),
    /outside|traversal/i,
  );

  await symlink(path.join(root, 'outside'), path.join(root, 'state/link'));
  await assert.rejects(
    () => atomicWritePrivateFile(path.join(root, 'state'), 'link/token', Buffer.from('x')),
    /symbolic link/i,
  );

  const original = path.join(root, 'state/original');
  await writeFile(original, 'x', { mode: 0o600 });
  await link(original, path.join(root, 'state/linked'));
  await assert.rejects(() => assertSafeRegularFile(original), /hard link/i);

  const loose = path.join(root, 'state/loose');
  await writeFile(loose, 'x', { mode: 0o600 });
  await chmod(loose, 0o644);
  await assert.rejects(() => assertSafeRegularFile(loose), /mode/i);

  const leafLink = path.join(root, 'state/leaf-link');
  await symlink(loose, leafLink);
  await assert.rejects(() => assertSafeRegularFile(leafLink), /symbolic link/i);
});
