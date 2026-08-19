import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeGitRemote } from '../../src/git/remote.js';

test('normalizes supported Git remote forms to one credential-free identity', () => {
  const expected = 'github.com/example-org/sample_app';
  assert.equal(normalizeGitRemote('git@github.com:EXAMPLE-ORG/sample_app.git'), expected);
  assert.equal(normalizeGitRemote('ssh://git@github.com/EXAMPLE-ORG/sample_app.git'), expected);
  assert.equal(normalizeGitRemote('https://github.com/EXAMPLE-ORG/sample_app.git'), expected);
  assert.equal(normalizeGitRemote('github.com/EXAMPLE-ORG/sample_app'), expected);
});

test('rejects remotes with credentials, queries, unsupported protocols, or missing owner/repo', () => {
  for (const remote of [
    'https://token@github.com/org/repo.git',
    'https://user:password@github.com/org/repo.git',
    'https://github.com/org/repo.git?token=secret',
    'file:///tmp/repo',
    '/tmp/repo',
    'github.com/only-owner',
    'not a remote',
  ]) {
    assert.throws(() => normalizeGitRemote(remote), /remote/i, remote);
  }
});
