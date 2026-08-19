import { constants } from 'node:fs';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { type JsonValue, canonicalJson } from '../core/json.js';
import { assertSafeRegularFile, ensurePrivateDirectory } from '../core/safe-files.js';
import { KeyedLock } from './locks.js';
import type { Redactor } from './redactor.js';

const auditInputSchema = z.object({
  securityMode: z.enum(['hardened', 'user']),
  callerUid: z.number().int().nonnegative(),
  project: z.string().min(1).max(128),
  repository: z.string().min(1).max(512),
  provider: z.string().min(1).max(128),
  operation: z.string().min(1).max(256),
  resource: z.string().min(1).max(512),
  result: z.enum(['success', 'failure', 'cancelled']),
  credentialFingerprint: z.string().min(1).max(128),
  durationMs: z.number().int().nonnegative(),
}).strict();

const storedAuditSchema = auditInputSchema.extend({
  schema: z.literal(1),
  sequence: z.number().int().positive(),
  eventId: z.uuid(),
  timestamp: z.iso.datetime({ offset: true }),
  previousEventMac: z.string(),
  eventMac: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
}).strict();

export type AuditInput = z.infer<typeof auditInputSchema>;

export interface AuditVerification {
  readonly valid: boolean;
  readonly events: number;
  readonly segments: number;
  readonly terminalMac?: string;
  readonly reason?: string;
}

export class AuditLog {
  readonly #auditRoot: string;
  readonly #hmacKey: Buffer;
  readonly #redactor: Redactor;
  readonly #maxSegmentBytes: number;
  readonly #lock = new KeyedLock();

  constructor(options: {
    stateRoot: string;
    hmacKey: Uint8Array;
    redactor: Redactor;
    maxSegmentBytes?: number;
  }) {
    this.#auditRoot = path.join(path.resolve(options.stateRoot), 'audit');
    this.#hmacKey = Buffer.from(options.hmacKey);
    if (this.#hmacKey.length < 32) throw new Error('Audit HMAC key must be at least 32 bytes');
    this.#redactor = options.redactor;
    this.#maxSegmentBytes = options.maxSegmentBytes ?? 8 * 1024 * 1024;
  }

  async append(input: AuditInput): Promise<void> {
    await this.#lock.run('audit', async () => {
      const current = await this.#scan();
      if (!current.valid) throw new Error(`Audit chain unavailable: ${current.reason}`);
      const parsed = auditInputSchema.parse(input);
      const sanitized = sanitizeObject(parsed, this.#redactor) as AuditInput;
      const unsigned = {
        schema: 1 as const,
        sequence: current.events + 1,
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        ...sanitized,
        previousEventMac: current.terminalMac ?? 'hmac-sha256:genesis',
      };
      const eventMac = this.#mac(unsigned);
      const event = storedAuditSchema.parse({ ...unsigned, eventMac });
      const line = `${JSON.stringify(event)}\n`;
      this.#redactor.assertClean(line);
      const files = await this.segmentFiles();
      let segment = files.length || 1;
      if (files.length > 0) {
        const last = files.at(-1);
        if (last !== undefined && (await lstat(last)).size + Buffer.byteLength(line) > this.#maxSegmentBytes) {
          segment += 1;
        }
      }
      await this.#appendLine(path.join(this.#auditRoot, segmentName(segment)), line);
    });
  }

  async verify(): Promise<AuditVerification> {
    return this.#lock.run('audit', () => this.#scan());
  }

  async segmentFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.#auditRoot);
      return entries
        .filter((name) => /^events-\d{6}\.jsonl$/.test(name))
        .sort()
        .map((name) => path.join(this.#auditRoot, name));
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
  }

  async #scan(): Promise<AuditVerification> {
    const files = await this.segmentFiles();
    let sequence = 0;
    let previous = 'hmac-sha256:genesis';
    try {
      for (const file of files) {
        await assertSafeRegularFile(file);
        const source = await readFile(file, 'utf8');
        for (const line of source.split('\n').filter(Boolean)) {
          const event = storedAuditSchema.parse(JSON.parse(line));
          sequence += 1;
          if (event.sequence !== sequence) throw new Error(`sequence mismatch at ${sequence}`);
          if (event.previousEventMac !== previous) throw new Error(`previous MAC mismatch at ${sequence}`);
          const { eventMac, ...unsigned } = event;
          const expected = this.#mac(unsigned);
          if (!macEqual(eventMac, expected)) throw new Error(`event MAC mismatch at ${sequence}`);
          previous = eventMac;
        }
      }
      const result: AuditVerification = { valid: true, events: sequence, segments: files.length };
      return sequence === 0 ? result : { ...result, terminalMac: previous };
    } catch (error) {
      return {
        valid: false,
        events: sequence,
        segments: files.length,
        reason: error instanceof Error ? error.message : 'audit schema verification failed',
      };
    }
  }

  #mac(value: object): string {
    const json = canonicalJson(JSON.parse(JSON.stringify(value)) as JsonValue);
    return `hmac-sha256:${createHmac('sha256', this.#hmacKey).update(json).digest('hex')}`;
  }

  async #appendLine(filename: string, line: string): Promise<void> {
    await ensurePrivateDirectory(this.#auditRoot);
    try {
      await assertSafeRegularFile(filename);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    const handle = await open(
      filename,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(filename, 0o600);
    await assertSafeRegularFile(filename);
  }
}

function sanitizeObject(value: unknown, redactor: Redactor): unknown {
  if (typeof value === 'string') return redactor.redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeObject(item, redactor));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeObject(item, redactor)]));
  }
  return value;
}

function segmentName(index: number): string {
  return `events-${index.toString().padStart(6, '0')}.jsonl`;
}

function macEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
