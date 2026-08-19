import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { loadRepositoryManifest } from '../../src/config/load.js';
import type { ProjectCatalog } from '../../src/config/schemas.js';
import { collectCheckoutEvidence } from '../../src/git/evidence.js';
import { TrustLedger } from '../../src/trust/ledger.js';
import { resolveProjectContext } from '../../src/trust/resolve.js';

const run = promisify(execFile);
const remote = 'github.com/example-org/sample_app';

const catalog: ProjectCatalog = {
  schema: 1,
  id: 'sample',
  displayName: 'Sample Project',
  repositories: [{ remote }],
  services: {
    vercel: { credential: 'sample-vercel-admin', teamId: 'team_public' },
  },
};

test('resolves only the exact approved checkout and rejects copied or moved equivalents', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'inframux-trust-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const repository = await createRepository(path.join(sandbox, 'approved'));
  const state = path.join(sandbox, 'state');
  const evidence = await collectCheckoutEvidence(repository);
  const manifest = await loadRepositoryManifest(path.join(repository, '.inframux.toml'));
  const ledger = new TrustLedger(state);
  await ledger.approve({
    schema: 1,
    project: 'sample',
    repositoryRoot: evidence.repositoryRoot,
    gitCommonDir: evidence.gitCommonDir,
    canonicalRemote: remote,
    workspaceRoot: sandbox,
    manifestDigest: evidence.manifestDigest,
    approvedAt: '2026-08-18T00:00:00.000Z',
  });
  assert.equal((await ledger.list())[0]?.workspaceRoot, await realpath(sandbox));

  const resolved = await resolveProjectContext({ evidence, manifest, catalog, ledger });
  assert.equal(resolved.project, 'sample');
  assert.equal(resolved.repositoryRoot, evidence.repositoryRoot);
  assert.equal(Object.isFrozen(resolved), true);

  const copied = path.join(sandbox, 'copied');
  await run('cp', ['-R', repository, copied]);
  await assert.rejects(
    async () => resolveProjectContext({
      evidence: await collectCheckoutEvidence(copied),
      manifest,
      catalog,
      ledger,
    }),
    /checkout.*approved/i,
  );

  const moved = path.join(sandbox, 'moved');
  await rename(repository, moved);
  await assert.rejects(async () => resolveProjectContext({
    evidence: await collectCheckoutEvidence(moved),
    manifest,
    catalog,
    ledger,
  }), /checkout.*approved/i);
});

test('uses the nearest Git root and rejects conflicting remotes and unapproved worktrees', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'inframux-worktree-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const repository = await createRepository(path.join(sandbox, 'approved'));
  const state = path.join(sandbox, 'state');
  const ledger = new TrustLedger(state);
  const evidence = await collectCheckoutEvidence(repository);
  const manifest = await loadRepositoryManifest(path.join(repository, '.inframux.toml'));
  await ledger.approve({
    schema: 1,
    project: 'sample',
    repositoryRoot: evidence.repositoryRoot,
    gitCommonDir: evidence.gitCommonDir,
    canonicalRemote: remote,
    workspaceRoot: sandbox,
    manifestDigest: evidence.manifestDigest,
    approvedAt: '2026-08-18T00:00:00.000Z',
  });

  const worktree = path.join(sandbox, 'feature-worktree');
  await run('git', ['worktree', 'add', '-b', 'feature', worktree], { cwd: repository });
  await assert.rejects(async () => resolveProjectContext({
    evidence: await collectCheckoutEvidence(worktree),
    manifest,
    catalog,
    ledger,
  }), /checkout.*approved/i);

  const nested = path.join(repository, 'nested');
  await mkdir(nested);
  await run('git', ['init', '-b', 'main'], { cwd: nested });
  await writeFile(path.join(nested, '.inframux.toml'), 'schema = 1\nproject = "sample"\nregistry = "sample"\n');
  await run('git', ['remote', 'add', 'origin', 'git@github.com:EXAMPLE-ORG/sample_app.git'], { cwd: nested });
  const nestedEvidence = await collectCheckoutEvidence(nested);
  assert.equal(nestedEvidence.repositoryRoot, await realpath(nested));
  await assert.rejects(() => resolveProjectContext({ evidence: nestedEvidence, manifest, catalog, ledger }), /checkout.*approved/i);

  await run('git', ['remote', 'add', 'upstream', 'https://github.com/another/repository.git'], { cwd: repository });
  const conflicting = await collectCheckoutEvidence(repository);
  await assert.rejects(() => resolveProjectContext({ evidence: conflicting, manifest, catalog, ledger }), /conflicting.*remote/i);
});

async function createRepository(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await run('git', ['init', '-b', 'main'], { cwd: directory });
  await run('git', ['config', 'user.email', 'inframux@example.invalid'], { cwd: directory });
  await run('git', ['config', 'user.name', 'inframux test'], { cwd: directory });
  await writeFile(path.join(directory, '.inframux.toml'), 'schema = 1\nproject = "sample"\nregistry = "sample"\n');
  await run('git', ['add', '.inframux.toml'], { cwd: directory });
  await run('git', ['commit', '-m', 'fixture'], { cwd: directory });
  await run('git', ['remote', 'add', 'origin', 'git@github.com:EXAMPLE-ORG/sample_app.git'], { cwd: directory });
  return directory;
}
