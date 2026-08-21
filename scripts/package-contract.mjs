#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'inframux';
const PACKAGE_VERSION = '0.1.4';
const MAX_PACKED_BYTES = 5 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;
const REQUIRED_ARCHIVE_PATHS = Object.freeze([
  'README.md',
  'SECURITY.md',
  'package.json',
  'bin/inframux',
  'docs/onboarding.md',
  'dist/src/bin/inframux.js',
  'dist/src/bin/broker.js',
  'dist/src/bin/worker.js',
  'dist/src/bin/manage.js',
  'runtime/playwright/src/launcher.mjs',
  'runtime/playwright/src/paths.mjs',
]);
const ALLOWED_ARCHIVE_PATH = /^(?:package\.json|README\.md|SECURITY\.md|bin\/inframux|docs\/onboarding\.md|dist\/src\/.+|runtime\/playwright\/src\/.+)$/u;
const FORBIDDEN_COMPONENT = /(?:^|\/)(?:node_modules|projects?|test|tests|examples|scripts|\.git|\.github|browser-state|profiles?|artifacts?|caches?|logs?)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.npmrc$|\.(?:pem|key|secret|token)$/iu;

const repositoryRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

export function validateMetadata(manifest) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'package manifest must be an object');
  assert(manifest.name === PACKAGE_NAME, `package name must be ${PACKAGE_NAME}`);
  assert(manifest.version === PACKAGE_VERSION, `package version must be ${PACKAGE_VERSION}`);
  assert(manifest.private !== true, 'package must not be private');
  assert(manifest.license === 'UNLICENSED', 'package license policy must be explicit');
  assert(manifest.type === 'module', 'package must use ESM');
  assert(JSON.stringify(manifest.bin) === JSON.stringify({ inframux: 'bin/inframux' }), 'package bin contract is invalid');
  assert(JSON.stringify(manifest.engines) === JSON.stringify({ node: '24.18.1' }), 'Node engine must be exact');
  assert(JSON.stringify(manifest.os) === JSON.stringify(['darwin']), 'package must be macOS-only');
  assert(manifest.publishConfig?.access === 'public', 'package access must be public');
  assert(manifest.publishConfig?.registry === 'https://registry.npmjs.org/', 'publish registry must be the public npm registry');
  assert(manifest.scripts?.install === undefined && manifest.scripts?.postinstall === undefined, 'package must not have install/postinstall hooks');
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, 'package files allowlist is required');
  for (const version of Object.values(manifest.dependencies ?? {})) {
    assert(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version), 'production dependency versions must be exact');
  }
  const entry = path.join(repositoryRoot, manifest.bin.inframux);
  const stat = lstatSync(entry);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o755, 'package CLI launcher must be a regular executable');
  assert(readFileSync(entry, 'utf8').startsWith('#!/bin/sh\n'), 'package CLI launcher must have a fixed shell shebang');
}

export function validateArchive(packOutput) {
  assert(Array.isArray(packOutput) && packOutput.length === 1, 'npm pack JSON must contain exactly one package');
  const record = packOutput[0];
  assert(record && typeof record === 'object' && !Array.isArray(record), 'npm pack record must be an object');
  assert(record.name === PACKAGE_NAME && record.version === PACKAGE_VERSION, 'packed package identity is invalid');
  assert(Number.isSafeInteger(record.size) && record.size >= 0 && record.size <= MAX_PACKED_BYTES, 'packed size limit exceeded');
  assert(Number.isSafeInteger(record.unpackedSize) && record.unpackedSize >= 0 && record.unpackedSize <= MAX_UNPACKED_BYTES, 'unpacked size limit exceeded');
  assert(Array.isArray(record.files) && record.files.length > 0, 'packed file listing is required');

  const paths = new Set();
  for (const file of record.files) {
    assert(file && typeof file === 'object' && !Array.isArray(file), 'packed file entry must be an object');
    const filename = normalizeArchivePath(file.path);
    assert(!paths.has(filename), `duplicate archive path: ${filename}`);
    paths.add(filename);
    assert(ALLOWED_ARCHIVE_PATH.test(filename) && !FORBIDDEN_COMPONENT.test(filename), `forbidden archive path: ${filename}`);
    assert(Number.isSafeInteger(file.size) && file.size >= 0, `invalid archive file size: ${filename}`);
  }
  for (const required of REQUIRED_ARCHIVE_PATHS) {
    assert(paths.has(required), `missing required archive path: ${required}`);
  }
  const cli = record.files.find((file) => file.path === 'bin/inframux');
  assert(cli?.mode === 0o755, 'packed CLI launcher must be executable');
  return Object.freeze({ filename: record.filename, files: paths.size, size: record.size, unpackedSize: record.unpackedSize });
}

function normalizeArchivePath(value) {
  assert(typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\\'), 'invalid archive path');
  assert(!value.startsWith('/') && path.posix.normalize(value) === value, 'invalid archive path');
  assert(value.split('/').every((component) => component !== '' && component !== '.' && component !== '..'), 'invalid archive path');
  return value;
}

function readJson(filename) {
  const stat = lstatSync(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `unsafe JSON input: ${filename}`);
  return JSON.parse(readFileSync(filename, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run() {
  const [command, argument, ...extra] = process.argv.slice(2);
  assert(extra.length === 0, 'unexpected package-contract arguments');
  if (command === 'metadata') {
    assert(argument === undefined, 'metadata accepts no argument');
    validateMetadata(readJson(path.join(repositoryRoot, 'package.json')));
    return;
  }
  if (command === 'archive') {
    assert(argument !== undefined && path.isAbsolute(argument), 'archive requires an absolute pack JSON path');
    const result = validateArchive(readJson(argument));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'dry-run') {
    assert(argument === undefined, 'dry-run accepts no argument');
    validateMetadata(readJson(path.join(repositoryRoot, 'package.json')));
    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      maxBuffer: 8 * 1024 * 1024,
    });
    const result = validateArchive(JSON.parse(output));
    process.stdout.write(`package archive contract passed: ${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error('usage: package-contract.mjs metadata | archive <absolute-pack-json> | dry-run');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`package contract failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
