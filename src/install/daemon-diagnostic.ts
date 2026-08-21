import { rm } from 'node:fs/promises';
import path from 'node:path';

import { assertSafeRegularFile, atomicWritePrivateFile } from '../core/safe-files.js';
import { Redactor } from '../security/redactor.js';

const DIAGNOSTIC_FILE = 'last-error.json';
const MAX_MESSAGE_BYTES = 4 * 1024;

export async function writeDaemonDiagnostic(
  diagnosticRoot: string,
  service: 'broker' | 'worker',
  error: unknown,
): Promise<void> {
  assertDiagnosticRoot(diagnosticRoot);
  const redactor = new Redactor({ maxInputBytes: 1024 * 1024 });
  const raw = error instanceof Error ? error.message : `${service} failed`;
  const redacted = redactor.redact(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ');
  const message = truncateUtf8(redacted, MAX_MESSAGE_BYTES);
  const record = {
    schema: 1,
    service,
    timestamp: new Date().toISOString(),
    message,
  };
  await atomicWritePrivateFile(diagnosticRoot, DIAGNOSTIC_FILE, Buffer.from(`${JSON.stringify(record)}\n`));
}

export async function clearDaemonDiagnostic(diagnosticRoot: string): Promise<void> {
  assertDiagnosticRoot(diagnosticRoot);
  const filename = path.join(diagnosticRoot, DIAGNOSTIC_FILE);
  try {
    await assertSafeRegularFile(filename);
    await rm(filename);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

function assertDiagnosticRoot(root: string): void {
  if (!path.isAbsolute(root) || root === path.parse(root).root || /\0|[\r\n]/u.test(root)) {
    throw new Error('Daemon diagnostic root must be a safe absolute path');
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes - 3).toString('utf8')}...`;
}
