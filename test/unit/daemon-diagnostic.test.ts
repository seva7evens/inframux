import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearDaemonDiagnostic, writeDaemonDiagnostic } from '../../src/install/daemon-diagnostic.js';

test('stores one bounded redacted daemon failure and clears it after a healthy start', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-daemon-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hugeSecret = `Authorization: Bearer ${'s'.repeat(20_000)}`;

  await writeDaemonDiagnostic(root, 'broker', new Error(hugeSecret));

  const filename = path.join(root, 'last-error.json');
  const stat = await lstat(filename);
  const contents = await readFile(filename, 'utf8');
  assert.equal(stat.mode & 0o777, 0o600);
  assert.ok(stat.size <= 8 * 1024);
  assert.doesNotMatch(contents, /s{32}/);
  assert.match(contents, /\[REDACTED\]/);
  assert.deepEqual(Object.keys(JSON.parse(contents)).sort(), ['message', 'schema', 'service', 'timestamp']);

  await clearDaemonDiagnostic(root);
  await assert.rejects(lstat(filename), { code: 'ENOENT' });
});

test('rejects a diagnostic root that is not an absolute private directory', async () => {
  await assert.rejects(writeDaemonDiagnostic('relative', 'worker', new Error('failed')), /absolute/i);
});
