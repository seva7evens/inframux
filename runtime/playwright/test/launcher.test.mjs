import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  buildDispatch,
  buildManagedMcpArgs,
  centralEnvironment,
  doctor,
  parseCommand,
  runtimeUpdateInstructions,
} from '../src/launcher.mjs';

const dependencyRoot = '/opt/inframux/release';
const stateRoot = '/opt/inframux/state/playwright';
const context = Object.freeze({
  root: '/workspace/project',
  identity: 'github.com/example/project',
  hash: 'abc123abc123abcd',
  profileDir: '/opt/inframux/playwright/profiles/abc123abc123abcd',
  artifactDir: '/opt/inframux/playwright/artifacts/abc123abc123abcd',
});

test('managed MCP arguments pin profile and artifacts against user overrides', () => {
  assert.deepEqual(
    buildManagedMcpArgs('/private/profile', '/private/artifacts', ['--headless']),
    ['--user-data-dir', '/private/profile', '--output-dir', '/private/artifacts', '--headless'],
  );
  assert.throws(
    () => buildManagedMcpArgs('/private/profile', '/private/artifacts', ['--user-data-dir=/other']),
    /managed.*override/i,
  );
});

test('parseCommand defaults to help and preserves argument boundaries', () => {
  assert.deepEqual(parseCommand([]), { command: 'help', args: [] });
  assert.deepEqual(parseCommand(['test', '--grep', 'a; rm -rf /']), {
    command: 'test',
    args: ['--grep', 'a; rm -rf /'],
  });
});

test('buildDispatch configures MCP with Chrome and repository isolation', () => {
  const dispatch = buildDispatch('mcp', ['--headless'], context, { dependencyRoot, stateRoot });

  assert.equal(dispatch.executable, path.join(dependencyRoot, 'node_modules/.bin/playwright-mcp'));
  assert.deepEqual(dispatch.args, [
    '--browser', 'chrome',
    '--user-data-dir', context.profileDir,
    '--output-dir', context.artifactDir,
    '--output-max-size', '104857600',
    '--codegen', 'typescript',
    '--headless',
  ]);
  assert.equal(dispatch.cwd, context.root);
  assert.equal(dispatch.env.PLAYWRIGHT_BROWSERS_PATH, path.join(stateRoot, 'browsers'));
  assert.equal(dispatch.shell, false);
});

test('buildDispatch does not duplicate an explicit CLI browser or session', () => {
  const dispatch = buildDispatch('cli', ['--session', 'manual', 'open', '--browser=firefox'], context, { dependencyRoot, stateRoot });

  assert.equal(dispatch.executable, path.join(dependencyRoot, 'node_modules/.bin/playwright-cli'));
  assert.deepEqual(dispatch.args, ['--session', 'manual', 'open', '--browser=firefox']);
  assert.equal(dispatch.env.PLAYWRIGHT_CLI_SESSION, undefined);
});

test('buildDispatch gives CLI a repository session and system Chrome by default', () => {
  const dispatch = buildDispatch('cli', ['open', 'https://example.com'], context, { dependencyRoot, stateRoot });

  assert.deepEqual(dispatch.args, ['open', 'https://example.com', '--browser=chrome']);
  assert.equal(dispatch.env.PLAYWRIGHT_CLI_SESSION, `repo-${context.hash}`);
});

test('buildDispatch does not add an open-only browser option to follow-up CLI commands', () => {
  const dispatch = buildDispatch('cli', ['snapshot'], context, { dependencyRoot, stateRoot });

  assert.deepEqual(dispatch.args, ['snapshot']);
  assert.equal(dispatch.env.PLAYWRIGHT_CLI_SESSION, `repo-${context.hash}`);
});

test('buildDispatch rejects unsupported commands', () => {
  assert.throws(
    () => buildDispatch('destroy-everything', [], context, { dependencyRoot, stateRoot }),
    /unknown command/i,
  );
});

test('doctor recognizes the executable macOS Google Chrome binary', () => {
  const result = doctor(context);

  assert.equal(result.chrome.path, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(result.chrome.ok, true);
});

test('centralEnvironment points API execution at the central browser directory', () => {
  const env = centralEnvironment({ SAFE_MARKER: 'kept', FORCE_COLOR: '1', NO_COLOR: '1' }, { stateRoot });

  assert.equal(env.SAFE_MARKER, 'kept');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, path.join(stateRoot, 'browsers'));
  assert.equal(env.PWTEST_DAEMON_SESSION_DIR, path.join(stateRoot, 'cli-daemon'));
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.NO_COLOR, undefined);
});

test('update is package-managed and never asks the sealed runtime to install code or browsers', () => {
  const message = runtimeUpdateInstructions();

  assert.match(message, /npm install --global inframux@<reviewed-version>/);
  assert.match(message, /inframux bootstrap --apply/);
  assert.doesNotMatch(message, /npm ci|playwright install|npx/);
});
