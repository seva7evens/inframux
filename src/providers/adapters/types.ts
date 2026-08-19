import type { JsonValue } from '../../core/json.js';

export interface ProviderAdapterContext {
  readonly project: string;
  readonly secret: Buffer;
  readonly service: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface ProviderCallContext extends ProviderAdapterContext {
  readonly operation: string;
  readonly input: unknown;
}

export interface VerifiedProvider {
  readonly identity: Readonly<Record<string, string>>;
  readonly resources: JsonValue;
}

export interface ProviderAdapter {
  readonly id: string;
  verify(context: ProviderAdapterContext): Promise<VerifiedProvider>;
  call(context: ProviderCallContext): Promise<JsonValue>;
}
