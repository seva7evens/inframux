import { sanitizeTerminalText } from './terminal.js';

const CLEAR_LINE = '\r\u001b[2K';
const UNICODE_FRAMES = Object.freeze(['⠋', '⠙', '⠹', '⠸']);
const ASCII_FRAMES = Object.freeze(['-', '\\', '|', '/']);

export class ProgressController {
  readonly #write: (value: string) => void;
  readonly #enabled: boolean;
  readonly #unicode: boolean;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #label = '';
  #frame = 0;

  constructor(options: {
    readonly write: (value: string) => void;
    readonly enabled: boolean;
    readonly unicode: boolean;
    readonly intervalMs?: number;
  }) {
    this.#write = options.write;
    this.#enabled = options.enabled;
    this.#unicode = options.unicode;
    this.#intervalMs = options.intervalMs ?? 100;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 5 || this.#intervalMs > 1_000) {
      throw new Error('Progress interval must be 5 to 1000 milliseconds');
    }
  }

  start(label: string): void {
    this.stop();
    this.#label = sanitizeTerminalText(label, 256);
    if (!this.#enabled) {
      this.#write(`${this.#label}\n`);
      return;
    }
    this.#render();
    this.#timer = setInterval(() => this.#render(), this.#intervalMs);
    this.#timer.unref();
  }

  succeed(label: string): void {
    const animated = this.#timer !== undefined;
    this.#clear();
    this.#write(`${animated ? CLEAR_LINE : ''}${this.#unicode ? '✓' : '[ok]'} ${sanitizeTerminalText(label, 256)}\n`);
  }

  fail(label: string): void {
    const animated = this.#timer !== undefined;
    this.#clear();
    this.#write(`${animated ? CLEAR_LINE : ''}${this.#unicode ? '✗' : '[failed]'} ${sanitizeTerminalText(label, 256)}\n`);
  }

  stop(): void { this.#clear(); }

  #render(): void {
    const frames = this.#unicode ? UNICODE_FRAMES : ASCII_FRAMES;
    this.#write(`${CLEAR_LINE}${frames[this.#frame % frames.length]} ${this.#label}`);
    this.#frame += 1;
  }

  #clear(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
