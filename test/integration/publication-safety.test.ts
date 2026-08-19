import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');

test('the publishable Git tree contains no private project context', async () => {
  const result = await execute(process.execPath, [
    path.join(root, 'scripts/scan-publication.mjs'), '--json',
  ], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const report = JSON.parse(result.stdout) as {
    ok: boolean;
    trackedFiles: number;
    textFiles: number;
    findings: unknown[];
  };

  assert.equal(report.ok, true);
  assert.equal(report.findings.length, 0);
  assert.ok(report.trackedFiles > 100);
  assert.ok(report.textFiles > 100);
});
