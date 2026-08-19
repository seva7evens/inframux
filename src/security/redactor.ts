import { InframuxError } from '../core/errors.js';

const replacement = '[REDACTED]';

export class Redactor {
  readonly #maxInputBytes: number;
  readonly #activeSecrets = new Map<number, string>();
  #nextId = 1;

  constructor(options: { maxInputBytes?: number } = {}) {
    this.#maxInputBytes = options.maxInputBytes ?? 1024 * 1024;
  }

  registerSecret(secret: string | Uint8Array): () => void {
    const value = typeof secret === 'string' ? secret : Buffer.from(secret).toString('utf8');
    if (value.length < 4) throw new Error('Refusing to register a secret shorter than four characters');
    const id = this.#nextId;
    this.#nextId += 1;
    this.#activeSecrets.set(id, value);
    return () => {
      this.#activeSecrets.delete(id);
    };
  }

  redact(input: string | Uint8Array): string {
    const source = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
    if (Buffer.byteLength(source) > this.#maxInputBytes) {
      throw new InframuxError('OUTPUT_LIMIT_EXCEEDED', 'Output limit exceeded before redaction');
    }
    let output = source;
    for (const secret of [...this.#activeSecrets.values()].sort((a, b) => b.length - a.length)) {
      output = replaceLiteral(output, secret);
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) output = replaceLiteral(output, encoded);
    }

    output = output
      .replace(/(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, `$1${replacement}`)
      .replace(/((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${replacement}`)
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, replacement)
      .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${replacement}@`)
      .replace(
        /("(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|private[_-]?key|cookie|authorization)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
        `$1"${replacement}"`,
      );
    return output;
  }

  assertClean(input: string | Uint8Array): void {
    const source = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
    if (this.redact(source) !== source) {
      throw new Error('Refusing secret-bearing serialized output');
    }
  }
}

function replaceLiteral(source: string, value: string): string {
  if (!value) return source;
  return source.split(value).join(replacement);
}
