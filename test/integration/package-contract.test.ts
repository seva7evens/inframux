import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const contract = path.join(root, 'scripts/package-contract.mjs');

test('package metadata is a public macOS CLI with one exact production graph', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown> & {
    dependencies: Record<string, string>;
  };

  assert.equal(manifest.name, 'inframux');
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.license, 'UNLICENSED');
  assert.deepEqual(manifest.bin, { inframux: 'bin/inframux' });
  assert.deepEqual(manifest.engines, { node: '24.18.1' });
  assert.deepEqual(manifest.os, ['darwin']);
  assert.deepEqual(manifest.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  });
  assert.equal(manifest.repository, undefined);
  assert.equal(manifest.homepage, undefined);
  assert.equal(manifest.bugs, undefined);
  assert.deepEqual(manifest.files, [
    'bin/inframux',
    'dist/src',
    'runtime/playwright/src',
    'docs/onboarding.md',
    'README.md',
    'SECURITY.md',
  ]);
  assert.deepEqual(manifest.dependencies, {
    '@playwright/cli': '0.1.18',
    '@playwright/mcp': '0.0.79',
    '@playwright/test': '1.62.1',
    playwright: '1.62.1',
    'smol-toml': '1.8.0',
    yaml: '2.9.0',
    zod: '4.4.3',
  });

  const result = await execute(process.execPath, [contract, 'metadata'], { cwd: root });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('package launcher prefers its sibling Node over an ambient PATH runtime', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-package-launcher-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const prefixBin = path.join(temporaryRoot, 'prefix/bin');
  const hostileBin = path.join(temporaryRoot, 'hostile-bin');
  await mkdir(prefixBin, { recursive: true });
  await mkdir(hostileBin, { recursive: true });
  await symlink(path.join(root, 'bin/inframux'), path.join(prefixBin, 'inframux'));
  await writeFile(path.join(prefixBin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  await chmod(path.join(prefixBin, 'node'), 0o755);
  await writeFile(path.join(hostileBin, 'node'), '#!/bin/sh\nexit 97\n');
  await chmod(path.join(hostileBin, 'node'), 0o755);

  const result = await execute(path.join(prefixBin, 'inframux'), ['capabilities', 'cloudflare', '--json'], {
    cwd: os.tmpdir(),
    env: { PATH: `${hostileBin}:/usr/bin:/bin`, HOME: temporaryRoot },
  });
  assert.equal(JSON.parse(result.stdout).id, 'cloudflare');
});

test('archive contract accepts only the bounded prebuilt runtime allowlist', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'inframux-package-contract-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const base = {
    id: 'inframux@0.1.4',
    name: 'inframux',
    version: '0.1.4',
    filename: 'inframux-0.1.4.tgz',
    size: 12_000,
    unpackedSize: 80_000,
    files: [
      { path: 'README.md', size: 100, mode: 0o644 },
      { path: 'SECURITY.md', size: 100, mode: 0o644 },
      { path: 'package.json', size: 100, mode: 0o644 },
      { path: 'bin/inframux', size: 100, mode: 0o755 },
      { path: 'docs/onboarding.md', size: 100, mode: 0o644 },
      { path: 'dist/src/bin/inframux.js', size: 100, mode: 0o755 },
      { path: 'dist/src/bin/broker.js', size: 100, mode: 0o644 },
      { path: 'dist/src/bin/worker.js', size: 100, mode: 0o644 },
      { path: 'dist/src/bin/manage.js', size: 100, mode: 0o644 },
      { path: 'runtime/playwright/src/launcher.mjs', size: 100, mode: 0o644 },
      { path: 'runtime/playwright/src/paths.mjs', size: 100, mode: 0o644 },
    ],
  };

  await assertArchive(temporaryRoot, [base]);

  for (const [label, mutate, expected] of [
    ['source', (value: typeof base) => value.files.push({ path: 'src/cli/main.ts', size: 1, mode: 0o644 }), /forbidden archive path/i],
    ['tests', (value: typeof base) => value.files.push({ path: 'test/token.test.ts', size: 1, mode: 0o644 }), /forbidden archive path/i],
    ['modules', (value: typeof base) => value.files.push({ path: 'node_modules/zod/index.js', size: 1, mode: 0o644 }), /forbidden archive path/i],
    ['secret', (value: typeof base) => value.files.push({ path: 'projects/.env.production', size: 1, mode: 0o600 }), /forbidden archive path/i],
    ['missing', (value: typeof base) => value.files.splice(value.files.findIndex((entry) => entry.path === 'dist/src/bin/manage.js'), 1), /missing required archive path/i],
    ['oversize', (value: typeof base) => { value.unpackedSize = 21 * 1024 * 1024; }, /size limit/i],
    ['traversal', (value: typeof base) => value.files.push({ path: '../escape', size: 1, mode: 0o644 }), /invalid archive path/i],
  ] as const) {
    const candidate = structuredClone(base);
    mutate(candidate);
    await assert.rejects(assertArchive(temporaryRoot, [candidate], label), expected);
  }
});

async function assertArchive(directory: string, value: unknown, suffix = 'valid'): Promise<void> {
  const filename = path.join(directory, `${suffix}.json`);
  await writeFile(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await execute(process.execPath, [contract, 'archive', filename], { cwd: root });
}
