import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';

import type { JsonValue } from '../core/json.js';
import { InframuxError, isErrorCode } from '../core/errors.js';
import { decodeJsonFrame, encodeFrame, FrameDecoder } from './framing.js';
import {
  PROTOCOL_VERSION,
  parseWireMessage,
  type RequestMessage,
  type ResponseMessage,
  type WireMessage,
} from './messages.js';

export interface RequestContext {
  readonly id: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}

export type RpcHandler = (payload: JsonValue, context: RequestContext) => Promise<JsonValue>;

interface PendingCall {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly removeAbort?: () => void;
}

export class RpcPeer {
  readonly #stream: Duplex;
  readonly #decoder: FrameDecoder;
  readonly #handlers: Readonly<Record<string, RpcHandler>>;
  readonly #pending = new Map<string, PendingCall>();
  readonly #active = new Map<string, AbortController>();
  readonly #closeListeners = new Set<() => void>();
  #closed = false;

  constructor(
    stream: Duplex,
    options: { handlers?: Readonly<Record<string, RpcHandler>>; maxFrameBytes?: number } = {},
  ) {
    this.#stream = stream;
    this.#decoder = new FrameDecoder(
      options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes },
    );
    this.#handlers = options.handlers ?? {};
    stream.on('data', (chunk: Buffer) => this.#receive(chunk));
    stream.once('error', (error) => this.#shutdown(error));
    stream.once('close', () => this.#shutdown(new Error('RPC connection closed')));
    stream.once('end', () => {
      try {
        this.#decoder.finish();
      } catch (error) {
        this.#shutdown(error instanceof Error ? error : new Error('Partial frame at disconnect'));
      }
    });
  }

  async call(
    operation: string,
    payload: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<JsonValue> {
    if (this.#closed) throw new Error('RPC connection is closed');
    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadlineMs = Date.now() + timeoutMs;
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === undefined) throw new Error('RPC payload is not JSON serializable');
    const jsonPayload = JSON.parse(serializedPayload) as JsonValue;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#send({ kind: 'cancel', protocol: PROTOCOL_VERSION, id });
        reject(new Error(`RPC deadline exceeded after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        this.#send({ kind: 'cancel', protocol: PROTOCOL_VERSION, id });
        reject(new Error('RPC request cancelled'));
      };
      const removeAbort = options.signal === undefined
        ? undefined
        : () => options.signal?.removeEventListener('abort', onAbort);
      this.#pending.set(id, { resolve, reject, timer, ...(removeAbort === undefined ? {} : { removeAbort }) });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.#send({
        kind: 'request',
        protocol: PROTOCOL_VERSION,
        id,
        deadlineMs,
        operation,
        payload: jsonPayload,
      });
    });
  }

  close(): void {
    this.#shutdown(new Error('RPC connection closed by client'));
    this.#stream.destroy();
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  #receive(chunk: Buffer): void {
    try {
      for (const frame of this.#decoder.push(chunk)) {
        void this.#handle(parseWireMessage(decodeJsonFrame(frame)));
      }
    } catch (error) {
      this.#shutdown(error instanceof Error ? error : new Error('Invalid RPC frame'));
      this.#stream.destroy();
    }
  }

  async #handle(message: WireMessage): Promise<void> {
    if (message.kind === 'response') {
      this.#handleResponse(message);
      return;
    }
    if (message.kind === 'cancel') {
      this.#active.get(message.id)?.abort(new Error('RPC request cancelled'));
      return;
    }
    await this.#handleRequest(message);
  }

  #handleResponse(message: ResponseMessage): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    if (message.ok) pending.resolve(message.result);
    else pending.reject(isErrorCode(message.error.code)
      ? new InframuxError(message.error.code, message.error.message)
      : new Error(`${message.error.code}: ${message.error.message}`));
  }

  async #handleRequest(message: RequestMessage): Promise<void> {
    if (this.#active.has(message.id)) {
      this.#sendFailure(message.id, 'INVALID_REQUEST', 'Duplicate active request ID');
      return;
    }
    const handler = this.#handlers[message.operation];
    if (handler === undefined) {
      this.#sendFailure(message.id, 'INVALID_REQUEST', `Unknown operation: ${message.operation}`);
      return;
    }
    const controller = new AbortController();
    this.#active.set(message.id, controller);
    const remaining = message.deadlineMs - Date.now();
    const timer = setTimeout(
      () => controller.abort(new Error('RPC deadline exceeded')),
      Math.max(0, remaining),
    );
    try {
      const result = await handler(message.payload, {
        id: message.id,
        deadlineMs: message.deadlineMs,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        this.#send({ kind: 'response', protocol: PROTOCOL_VERSION, id: message.id, ok: true, result });
      }
    } catch (error) {
      const code = controller.signal.aborted
        ? 'CANCELLED'
        : error instanceof InframuxError ? error.code : 'INVALID_REQUEST';
      this.#sendFailure(
        message.id,
        code,
        controller.signal.aborted
          ? 'Request cancelled or deadline exceeded'
          : error instanceof Error ? error.message : 'Request failed',
      );
    } finally {
      clearTimeout(timer);
      this.#active.delete(message.id);
    }
  }

  #sendFailure(id: string, code: string, message: string): void {
    this.#send({
      kind: 'response',
      protocol: PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message },
    });
  }

  #send(message: WireMessage): void {
    if (this.#closed) return;
    this.#stream.write(encodeFrame(Buffer.from(JSON.stringify(message))));
  }

  #shutdown(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const controller of this.#active.values()) controller.abort(error);
    this.#active.clear();
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }
}
