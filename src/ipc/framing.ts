export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(payload: Uint8Array, options: { maxFrameBytes?: number } = {}): Buffer {
  const max = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (payload.byteLength === 0) throw new Error('Refusing a zero-length frame');
  if (payload.byteLength > max) throw new Error(`Frame exceeds maximum of ${max} bytes`);
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  Buffer.from(payload).copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer = Buffer.alloc(0);

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  get pendingBytes(): number {
    return this.#buffer.byteLength;
  }

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.byteLength > 0) this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const frames: Buffer[] = [];
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0) throw new Error('Refusing a zero-length frame');
      if (length > this.#maxFrameBytes) {
        throw new Error(`Frame length ${length} exceeds maximum of ${this.#maxFrameBytes} bytes`);
      }
      if (this.#buffer.byteLength < 4 + length) break;
      frames.push(Buffer.from(this.#buffer.subarray(4, 4 + length)));
      this.#buffer = this.#buffer.subarray(4 + length);
    }
    return frames;
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) throw new Error('Stream ended with a partial frame');
  }
}

export function decodeJsonFrame(frame: Uint8Array): unknown {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(frame);
  } catch (error) {
    throw new Error('Frame is not valid UTF-8', { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error('Frame is not valid JSON', { cause: error });
  }
}
