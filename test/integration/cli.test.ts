import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { runCli } from '../../src/cli/main.js';
import { listenUnixSocket } from '../../src/ipc/server.js';
import { encodeOAuthCredential } from '../../src/providers/oauth.js';

const execute = promisify(execFile);

test('runs local capability discovery without a broker or repository selector', async () => {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(['capabilities', 'vercel', '--json'], {
    cwd: process.cwd(),
    stdin: process.stdin,
    writeStdout: (value) => { stdout += value; },
    writeStderr: (value) => { stderr += value; },
    environment: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  const parsed = JSON.parse(stdout) as { id: string; capabilities: unknown[] };
  assert.equal(parsed.id, 'vercel');
  assert.ok(parsed.capabilities.length > 0);
  assert.equal(stdout.includes('token'), false);
});

test('prints the universal onboarding prompt without a broker', async () => {
  let stdout = '';
  const exitCode = await runCli(['prompt', 'onboarding'], {
    cwd: process.cwd(), stdin: process.stdin, writeStdout: (value) => { stdout += value; },
    writeStderr: () => undefined, environment: {},
  });
  assert.equal(exitCode, 0);
  assert.match(stdout, /Services: <ENTER COMMA-SEPARATED SERVICES>/);
});

test('starts universal onboarding from a blank Git repository and writes only a non-secret manifest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-cli-onboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'My_Project');
  await mkdir(repository);
  await execute('git', ['init', '-b', 'main'], { cwd: repository });
  await execute('git', ['remote', 'add', 'origin', 'git@github.com:Acme/My_Project.git'], { cwd: repository });
  const socketPath = path.join(root, 'broker.sock');
  let received: unknown;
  const server = await listenUnixSocket({ socketPath, handlers: {
    'onboarding.start': async (payload) => {
      received = payload;
      return { schema: 1, id: '018f47d2-8737-7a19-8000-123456789abc', project: 'my-project', providers: ['cloudflare', 'vercel'] };
    },
  } });
  t.after(() => server.close());
  let stdout = '';
  const exitCode = await runCli(['onboard', 'start', '--services', 'vercel,cloudflare', '--json'], {
    cwd: repository, stdin: process.stdin, writeStdout: (value) => { stdout += value; },
    writeStderr: () => undefined, environment: { INFRAMUX_CLIENT_SOCKET: socketPath },
  });
  assert.equal(exitCode, 0, stdout);
  assert.equal(await readFile(path.join(repository, '.inframux.toml'), 'utf8'), 'schema = 1\nproject = "my-project"\nregistry = "my-project"\n');
  const payload = received as { project: string; providers: string[]; evidence: { normalizedRemotes: string[] } };
  assert.equal(payload.project, 'my-project');
  assert.deepEqual(payload.providers, ['cloudflare', 'vercel']);
  assert.deepEqual(payload.evidence.normalizedRemotes, ['github.com/acme/my_project']);
  assert.doesNotMatch(JSON.stringify(received), /api.?key|token|password|secret/i);
});

test('routes universal configure, resume, and finish commands through the broker', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-cli-onboard-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = path.join(root, 'broker.sock');
  const seen: string[] = [];
  const server = await listenUnixSocket({ socketPath, handlers: {
    'onboarding.configure': async () => { seen.push('configure'); return { schema: 1, configured: true }; },
    'onboarding.resume': async () => { seen.push('status'); return { schema: 1, project: 'example' }; },
    'onboarding.finish': async () => { seen.push('finish'); return { schema: 1, complete: true }; },
  } });
  t.after(() => server.close());
  const id = '018f47d2-8737-7a19-8000-123456789abc';
  for (const args of [
    ['onboard', 'configure', id, '--service', 'cloudflare', '--input-json', '{"accountId":"one"}', '--json'],
    ['onboard', 'resume', id, '--json'], ['onboard', 'finish', id, '--json'],
  ]) {
    const code = await runCli(args, { cwd: root, stdin: process.stdin, writeStdout: () => undefined,
      writeStderr: () => undefined, environment: { INFRAMUX_CLIENT_SOCKET: socketPath } });
    assert.equal(code, 0);
  }
  assert.deepEqual(seen, ['configure', 'status', 'finish']);
});

test('runs Google Desktop authorization from catalog data and sends the envelope only to the broker', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-cli-google-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clientFile = path.join(root, 'google.json');
  await writeFile(clientFile, '{}');
  const socketPath = path.join(root, 'broker.sock');
  let enrolledPayload: unknown;
  const server = await listenUnixSocket({
    socketPath,
    handlers: {
      'credential.enrollment-info': async () => ({
        schema: 1, project: 'sample', provider: 'google-cloud',
        expectedIdentity: { account: 'maintainer@example.test' }, scopes: ['email', 'openid'],
      }),
      'credential.enroll': async (payload) => {
        enrolledPayload = payload;
        return { schema: 1, project: 'sample', provider: 'google-cloud', identity: { account: 'maintainer@example.test' } };
      },
    },
  });
  t.after(() => server.close());
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli([
    'enroll', 'sample', '--service', 'google-cloud', '--oauth-client-json', clientFile, '--json',
  ], {
    cwd: root, stdin: process.stdin,
    writeStdout: (value) => { stdout += value; },
    writeStderr: (value) => { stderr += value; },
    environment: { INFRAMUX_CLIENT_SOCKET: socketPath },
    authorizeGoogle: async (input) => {
      assert.deepEqual(input.scopes, ['email', 'openid']);
      assert.equal(input.loginHint, 'maintainer@example.test');
      return encodeOAuthCredential({
        schema: 1, kind: 'oauth2', accessToken: 'google-access-canary', refreshToken: 'google-refresh-canary',
        tokenType: 'Bearer', expiresAt: '2026-08-18T12:00:00.000Z', scopes: ['email', 'openid'],
        clientId: 'desktop-client', tokenEndpoint: 'https://oauth2.googleapis.com/token',
        revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
      });
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.doesNotMatch(stdout, /google-(?:access|refresh)-canary/);
  const enrolled = enrolledPayload as { credentialType: string; secretBase64: string; expectedIdentity: { account: string } };
  assert.equal(enrolled.credentialType, 'oauth2-desktop-pkce');
  assert.equal(enrolled.expectedIdentity.account, 'maintainer@example.test');
  const secret = Buffer.from(enrolled.secretBase64, 'base64').toString('utf8');
  assert.match(secret, /google-refresh-canary/);
});

test('links an exact repository only after explicit manifest creation and emits no secrets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-cli-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  await mkdir(repository);
  await execute('git', ['init', '-b', 'main'], { cwd: repository });
  await execute('git', ['remote', 'add', 'origin', 'https://github.com/example-org/sample_app.git'], { cwd: repository });
  const socketPath = path.join(root, 'broker.sock');
  let received: unknown;
  const server = await listenUnixSocket({
    socketPath,
    handlers: {
      'trust.request': async (payload) => {
        received = payload;
        return {
          schema: 1, id: '018f47d2-8737-7a19-8000-123456789abc', project: 'sample',
          agentInstructions: '# safe instructions',
        };
      },
    },
  });
  t.after(() => server.close());
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(args, {
      cwd: repository, stdin: process.stdin,
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
      environment: { INFRAMUX_CLIENT_SOCKET: socketPath },
    });
    return { stdout, stderr, exitCode };
  };
  const preview = await run(['link', '--project', 'sample', repository, '--json']);
  assert.equal(preview.exitCode, 0);
  assert.equal(received, undefined);
  assert.match(preview.stdout, /--write-manifest/);

  const linked = await run(['link', '--project', 'sample', repository, '--write-manifest', '--json']);
  assert.equal(linked.exitCode, 0);
  assert.equal(linked.stderr, '');
  assert.match(linked.stdout, /safe instructions/);
  assert.equal(await readFile(path.join(repository, '.inframux.toml'), 'utf8'), 'schema = 1\nproject = "sample"\nregistry = "sample"\n');
  assert.ok(received);
  const request = received as unknown as { evidence: { repositoryRoot: string; normalizedRemotes: string[] }; workspaceRoot: string };
  assert.equal(request.evidence.repositoryRoot, await realpath(repository));
  assert.deepEqual(request.evidence.normalizedRemotes, ['github.com/example-org/sample_app']);
  assert.equal(request.workspaceRoot, await realpath(repository));
  assert.doesNotMatch(JSON.stringify(received), /secret|token|password/i);
});
