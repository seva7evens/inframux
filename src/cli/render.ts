import { InframuxError, asInframuxError, type ErrorCode } from '../core/errors.js';
import { journeyFromError } from './journey.js';
import { renderOnboardingHuman } from './onboarding-ui.js';
import { renderOperationalHuman } from './operations-ui.js';

export function renderResult(command: string, result: unknown, options: { json: boolean; verbose: boolean; unicode?: boolean }): string {
  if (options.json) return `${JSON.stringify(machineResult(result), null, 2)}\n`;
  if (command.startsWith('onboard.')) return renderOnboardingHuman(command, result, { unicode: options.unicode ?? true });
  if (command === 'agent-instructions') return `${(result as { agentInstructions: string }).agentInstructions}\n`;
  return renderOperationalHuman(command, result, { unicode: options.unicode ?? true, verbose: options.verbose });
}

export function renderError(error: unknown, json: boolean): { text: string; exitCode: number } {
  const normalized = error instanceof InframuxError ? error : asInframuxError(error instanceof Error ? error : new Error('Unknown error'));
  const journey = journeyFromError(normalized);
  const recovery = normalized.recovery ?? (normalized.code === 'BROKER_UNAVAILABLE' ? 'inframux bootstrap --apply' : undefined);
  const fallbackAction = normalized.code === 'BROKER_UNAVAILABLE'
    ? {
        type: 'recover', actor: 'user' as const, command: recovery!,
        description: 'Repair the hardened services from the installed release; an unhealthy release is rolled back automatically.',
        interactive: true, privileged: true,
      }
    : {
        type: 'recover', actor: 'agent' as const,
        command: recovery ?? 'inframux --help',
        description: `Recover from ${normalized.code}.`, interactive: false, privileged: false,
      };
  const body = {
    schema: 1,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(recovery === undefined ? {} : { recovery }),
    },
    ...(journey ?? { state: 'failed', complete: false, nextActions: [fallbackAction] }),
  };
  const text = json
    ? JSON.stringify(body, null, 2)
    : `${normalized.code}: ${normalized.message}${recovery === undefined ? '' : `\nRecovery: ${recovery}`}`;
  return { text, exitCode: exitCodeFor(normalized.code) };
}

function machineResult(result: unknown): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (typeof record.state === 'string' && typeof record.complete === 'boolean' && Array.isArray(record.nextActions)) return result;
  return { ...record, state: 'complete', complete: true, nextActions: [] };
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
