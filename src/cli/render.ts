import { InframuxError, asInframuxError, type ErrorCode } from '../core/errors.js';
import { journeyFromError } from './journey.js';

export function renderResult(command: string, result: unknown, options: { json: boolean; verbose: boolean }): string {
  if (options.json || command !== 'status') return `${JSON.stringify(result, null, options.json || options.verbose ? 2 : 0)}\n`;
  const status = result as {
    project: string; securityMode: string; checkoutApproved: boolean; repository: string;
    providers: Array<{ id: string; health: string; identity?: Record<string, string> }>;
  };
  const lines = [
    `${status.project} · ${status.securityMode} · checkout ${status.checkoutApproved ? 'approved' : 'not approved'}`,
    ...status.providers.map((provider) => {
      const identity = provider.identity === undefined ? '' : ` · ${Object.values(provider.identity).join(' / ')}`;
      return `${provider.id} · ${provider.health}${identity}`;
    }),
  ];
  if (options.verbose) lines.splice(1, 0, `repository · ${status.repository}`);
  return `${lines.join('\n')}\n`;
}

export function renderError(error: unknown, json: boolean): { text: string; exitCode: number } {
  const normalized = error instanceof InframuxError ? error : asInframuxError(error instanceof Error ? error : new Error('Unknown error'));
  const journey = journeyFromError(normalized);
  const body = {
    schema: 1,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.recovery === undefined ? {} : { recovery: normalized.recovery }),
    },
    ...(journey === undefined ? {} : journey),
  };
  const text = json
    ? JSON.stringify(body, null, 2)
    : `${normalized.code}: ${normalized.message}${normalized.recovery === undefined ? '' : `\nRecovery: ${normalized.recovery}`}`;
  return { text, exitCode: exitCodeFor(normalized.code) };
}

function exitCodeFor(code: ErrorCode): number {
  const codes: Partial<Record<ErrorCode, number>> = {
    PROJECT_NOT_BOUND: 11, CHECKOUT_NOT_APPROVED: 12, REMOTE_NOT_ALLOWED: 13,
    BROKER_UNAVAILABLE: 20, CREDENTIAL_MISSING: 30, WRONG_PROVIDER_IDENTITY: 31,
    TOKEN_EXPIRED: 32, SCOPE_MISSING: 33, EXECUTABLE_NOT_APPROVED: 40,
    SESSION_AUTHORIZATION_REQUIRED: 34, PROVIDER_ALREADY_VERIFIED: 35,
    BROKER_CHECKOUT_INACCESSIBLE: 21,
    SOURCE_BOUND_OPERATION: 41, OUTPUT_LIMIT_EXCEEDED: 42, AUDIT_UNAVAILABLE: 50,
    UNSUPPORTED_PROVIDER_OPERATION: 60, INVALID_REQUEST: 64,
  };
  return codes[code] ?? 1;
}
