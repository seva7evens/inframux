import { InframuxError, type ErrorCode } from '../core/errors.js';

export type JourneyState =
  | 'planned'
  | 'configuration-required'
  | 'authorization-required'
  | 'ready-to-finish'
  | 'checkout-access-required'
  | 'complete'
  | 'healthy'
  | 'degraded'
  | 'failed';

export interface JourneyAction {
  readonly type: string;
  readonly actor: 'user' | 'agent';
  readonly command: string;
  readonly description: string;
  readonly interactive: boolean;
  readonly privileged: boolean;
}

export interface JourneyProjection {
  readonly state: JourneyState;
  readonly complete: boolean;
  readonly nextActions: readonly JourneyAction[];
}

const STATES = new Set<JourneyState>([
  'planned', 'configuration-required', 'authorization-required', 'ready-to-finish',
  'checkout-access-required', 'complete', 'healthy', 'degraded', 'failed',
]);

export function createJourneyAction(input: JourneyAction): JourneyAction {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(input.type)) throw new Error('Journey action type is invalid');
  if (input.actor !== 'user' && input.actor !== 'agent') throw new Error('Journey action actor is invalid');
  if (input.command.length < 1 || input.command.length > 4_096 || /[\u0000-\u001f\u007f;&|`$]/u.test(input.command)) {
    throw new Error('Journey action requires a safe command');
  }
  if (input.description.length < 1 || input.description.length > 512 || /[\u0000-\u001f\u007f]/u.test(input.description)) {
    throw new Error('Journey action description is invalid');
  }
  return Object.freeze({ ...input });
}

export function createJourneyProjection(
  state: JourneyState,
  complete: boolean,
  actions: readonly JourneyAction[],
): JourneyProjection {
  if (!STATES.has(state)) throw new Error('Journey state is invalid');
  if (complete !== (state === 'complete' || state === 'healthy')) {
    throw new Error('Journey completeness does not match its state');
  }
  const nextActions = Object.freeze(actions.map((action) => createJourneyAction(action)));
  if (!complete && nextActions.length === 0) throw new Error('Incomplete journey requires a next action');
  return Object.freeze({ state, complete, nextActions });
}

export function withJourney<T extends Readonly<Record<string, unknown>>>(
  result: T,
  journey: JourneyProjection,
): Readonly<T & JourneyProjection> {
  return Object.freeze({ ...result, ...journey });
}

export function journeyError(
  code: ErrorCode,
  message: string,
  journey: JourneyProjection,
  options: { readonly cause?: unknown } = {},
): InframuxError {
  return new InframuxError(code, message, {
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    ...(journey.nextActions[0] === undefined ? {} : { recovery: journey.nextActions[0].command }),
    details: { journey },
  });
}

export function journeyFromError(error: InframuxError): JourneyProjection | undefined {
  const value = error.details?.journey;
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as Partial<JourneyProjection>;
  if (typeof candidate.state !== 'string' || typeof candidate.complete !== 'boolean' || !Array.isArray(candidate.nextActions)) return undefined;
  return value as JourneyProjection;
}
