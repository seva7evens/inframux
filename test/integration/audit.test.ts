import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuditLog } from '../../src/security/audit.js';
import { Redactor } from '../../src/security/redactor.js';

test('writes a redacted HMAC chain across rotations and verifies continuity', async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'inframux-audit-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const redactor = new Redactor();
  redactor.registerSecret('audit-canary-secret');
  const audit = new AuditLog({
    stateRoot: state,
    hmacKey: Buffer.alloc(32, 11),
    redactor,
    maxSegmentBytes: 500,
  });

  for (let index = 0; index < 4; index += 1) {
    await audit.append({
      securityMode: 'user',
      callerUid: 501,
      project: 'sample',
      repository: 'github.com/example-org/sample_app',
      provider: 'vercel',
      operation: `projects.list.${index}`,
      resource: `safe-audit-canary-secret-${index}`,
      result: 'success',
      credentialFingerprint: 'hmac-sha256:fingerprint',
      durationMs: index,
    });
  }

  const verified = await audit.verify();
  assert.equal(verified.valid, true);
  assert.equal(verified.events, 4);
  assert.ok(verified.segments >= 2);
  const files = await audit.segmentFiles();
  const contents = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('');
  assert.equal(contents.includes('audit-canary-secret'), false);
  assert.match(contents, /\[REDACTED\]/);
});

test('detects mutation and appended junk without repairing or exposing events', async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'inframux-audit-tamper-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const audit = new AuditLog({
    stateRoot: state,
    hmacKey: Buffer.alloc(32, 13),
    redactor: new Redactor(),
  });
  await audit.append({
    securityMode: 'hardened', callerUid: 501, project: 'sample',
    repository: 'github.com/example-org/sample_app', provider: 'supabase',
    operation: 'projects.list', resource: 'qso-public', result: 'success',
    credentialFingerprint: 'hmac-sha256:fingerprint', durationMs: 1,
  });
  const [file] = await audit.segmentFiles();
  assert.ok(file);
  await appendFile(file, '{"junk":true}\n');
  const result = await audit.verify();
  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /schema|json|sequence|mac/i);
});
