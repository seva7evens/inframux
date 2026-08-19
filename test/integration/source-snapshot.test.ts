import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { DEFAULT_SOURCE_POLICY } from '../../src/source/policy.js';
import { buildSourceSnapshot } from '../../src/source/snapshot.js';

const run = promisify(execFile);

test('builds deterministic source bytes with hostile names while enforcing mandatory and project ignores', async (t) => {
  const repository = await createRepository(t);
  await write(repository, 'src/index.ts', 'export const answer = 42;\n');
  await write(repository, 'untracked.txt', 'included untracked\n');
  await write(repository, 'line\nbreak.txt', 'hostile filename stays framed\n');
  await write(repository, '.inframuxignore', 'ignored.txt\n**/*.scratch\n');
  await write(repository, 'ignored.txt', 'ignored by policy\n');
  await write(repository, 'nested/temp.scratch', 'ignored glob\n');
  await write(repository, '.env.production', 'SHOULD_NOT_BE_CAPTURED=1\n');
  await write(repository, 'node_modules/pkg/index.js', 'dependency\n');
  await write(repository, '.next/server/app.js', 'build\n');
  await run('git', ['add', '-f', 'src/index.ts', 'line\nbreak.txt', '.inframuxignore', '.env.production', 'node_modules/pkg/index.js', '.next/server/app.js'], { cwd: repository });

  const first = await buildSourceSnapshot({ repositoryRoot: repository }, DEFAULT_SOURCE_POLICY);
  const second = await buildSourceSnapshot({ repositoryRoot: repository }, DEFAULT_SOURCE_POLICY);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.summary.files.map((file) => file.path), [
    '.inframuxignore', 'line\nbreak.txt', 'src/index.ts', 'untracked.txt',
  ]);
  const firstBytes = await collect(first.stream());
  assert.deepEqual(firstBytes, await collect(second.stream()));
  assert.equal(firstBytes.includes(Buffer.from(repository)), false);
  assert.equal(firstBytes.includes(Buffer.from('SHOULD_NOT_BE_CAPTURED')), false);
  assert.equal(first.summary.digest.startsWith('sha256:'), true);
});

test('rejects links and limits while excluding sockets and secret-bearing candidates', async (t) => {
  const repository = await createRepository(t);
  await write(repository, 'safe.txt', 'safe\n');

  await symlink('/etc/hosts', path.join(repository, 'escape-link'));
  await assert.rejects(() => buildSourceSnapshot({ repositoryRoot: repository }, DEFAULT_SOURCE_POLICY), /symbolic link/i);
  await rm(path.join(repository, 'escape-link'));

  await link(path.join(repository, 'safe.txt'), path.join(repository, 'hard-link'));
  await assert.rejects(() => buildSourceSnapshot({ repositoryRoot: repository }, DEFAULT_SOURCE_POLICY), /hard link/i);
  await rm(path.join(repository, 'hard-link'));

  const socketPath = path.join(repository, 'local.sock');
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
  try {
    const withoutSocket = await buildSourceSnapshot({ repositoryRoot: repository }, DEFAULT_SOURCE_POLICY);
    assert.equal(withoutSocket.summary.files.some((file) => file.path === 'local.sock'), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }

  await write(repository, 'secret.txt', 'prefix SYNTHETIC-SNAPSHOT-CANARY suffix\n');
  await assert.rejects(() => buildSourceSnapshot({ repositoryRoot: repository }, {
    ...DEFAULT_SOURCE_POLICY, secretCanaries: ['SYNTHETIC-SNAPSHOT-CANARY'],
  }), /secret/i);
  await rm(path.join(repository, 'secret.txt'));

  await write(repository, 'large.txt', 'x'.repeat(64));
  await assert.rejects(() => buildSourceSnapshot({ repositoryRoot: repository }, {
    ...DEFAULT_SOURCE_POLICY, maxFileBytes: 32,
  }), /file.*limit/i);
  await assert.rejects(() => buildSourceSnapshot({ repositoryRoot: repository }, {
    ...DEFAULT_SOURCE_POLICY, maxFiles: 1,
  }), /file.*count/i);
  await assert.rejects(() => buildSourceSnapshot({ repositoryRoot: repository }, {
    ...DEFAULT_SOURCE_POLICY, maxTotalBytes: 16,
  }), /total.*limit/i);
});

test('fails closed when a candidate mutates between selection and capture', async (t) => {
  const repository = await createRepository(t);
  await write(repository, 'mutable.txt', 'before');
  await assert.rejects(() => buildSourceSnapshot(
    { repositoryRoot: repository },
    DEFAULT_SOURCE_POLICY,
    { beforeRead: async (relativePath) => {
      if (relativePath === 'mutable.txt') await writeFile(path.join(repository, relativePath), 'after mutation');
    } },
  ), /mutated|changed/i);
});

async function createRepository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run('git', ['init', '-b', 'main', root]);
  return root;
}

async function write(repository: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(repository, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
