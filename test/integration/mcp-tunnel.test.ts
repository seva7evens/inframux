import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { pumpMcpTunnel, type McpTunnelTransport } from '../../src/ipc/byte-tunnel.js';
import { Redactor } from '../../src/security/redactor.js';
import type { ExecutableManifest } from '../../src/worker/executable-manifest.js';
import { McpProcessManager } from '../../src/worker/mcp-process.js';
import type { ExecutionLease } from '../../src/worker/runner.js';

test('tunnels fragmented official MCP bytes without adding tools or exposing the lease', async (t) => {
  const fixture = await setupMcp(t);
  const sessionId = await fixture.manager.open(fixture.lease('sample'));
  const transport = directTransport(fixture.manager, sessionId);
  const input = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const pumping = pumpMcpTunnel({
    input,
    output: collector(stdoutChunks),
    errorOutput: collector(stderrChunks),
    transport,
  });
  const initialize = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n';
  const list = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n';
  input.write(initialize.slice(0, 17));
  input.write(initialize.slice(17));
  input.end(list);
  await pumping;

  assert.equal(Buffer.concat(stdoutChunks).toString('utf8'), initialize + list);
  assert.equal(Buffer.concat(stderrChunks).toString('utf8'), '');
  assert.equal(Buffer.concat(stdoutChunks).includes(Buffer.from('mcp-canary-secret')), false);
});

test('isolates simultaneous MCP sessions by project and kills them on explicit close', async (t) => {
  const fixture = await setupMcp(t);
  const first = await fixture.manager.open(fixture.lease('sample'));
  const second = await fixture.manager.open(fixture.lease('project-beta'));
  assert.notEqual(first, second);
  assert.deepEqual(new Set(fixture.manager.activeSessions()), new Set([first, second]));
  await fixture.manager.close(first);
  assert.deepEqual(fixture.manager.activeSessions(), [second]);
  await fixture.manager.close(second);
  assert.deepEqual(fixture.manager.activeSessions(), []);
});

async function setupMcp(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolRoot = path.join(root, 'tools');
  await mkdir(toolRoot, { mode: 0o700 });
  const executable = path.join(toolRoot, 'synthetic-mcp');
  await copyFile(new URL('../fixtures/fake-mcp.mjs', import.meta.url), executable);
  await writeFile(executable, (await readFile(executable, 'utf8')).replace('#!/usr/bin/env node', `#!${process.execPath}`));
  await chmod(executable, 0o755);
  const manifest: ExecutableManifest = {
    schema: 1, runtimeNodeVersion: '24.18.1', executables: {
      'synthetic-mcp': {
        path: executable, provider: 'synthetic', kind: 'mcp', version: '1.0.0',
        sha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
      },
    },
  };
  const manager = new McpProcessManager({
    workerRoot: path.join(root, 'worker'), toolRoot, manifest,
    allowedOwnerUids: [process.getuid!()], redactor: new Redactor(),
    terminationGraceMs: 10,
  });
  return {
    manager,
    lease: (project: string): ExecutionLease => ({
      schema: 1, leaseId: randomUUID(), project, provider: 'synthetic',
      credentialFingerprint: `hmac-sha256:${project}`,
      credentialEnvironmentVariable: 'INFRAMUX_SYNTHETIC_TOKEN',
      credentialBase64: Buffer.from(`account:${project}:mcp-canary-secret`).toString('base64'),
      executableId: 'synthetic-mcp', args: [], publicEnvironment: { INFRAMUX_PROJECT_ID: project },
      timeoutMs: 5_000, maxOutputBytes: 64 * 1024, configFiles: [],
    }),
  };
}

function directTransport(manager: McpProcessManager, sessionId: string): McpTunnelTransport {
  return {
    write: (chunk) => manager.write(sessionId, chunk),
    end: () => manager.end(sessionId),
    read: () => manager.read(sessionId, 100),
    close: () => manager.close(sessionId),
  };
}

function collector(chunks: Buffer[]): Writable {
  return new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
}
