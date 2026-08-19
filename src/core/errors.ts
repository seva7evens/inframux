export type ErrorCode =
  | 'PROJECT_NOT_BOUND'
  | 'CHECKOUT_NOT_APPROVED'
  | 'REMOTE_NOT_ALLOWED'
  | 'BROKER_UNAVAILABLE'
  | 'SECURITY_MODE_MISMATCH'
  | 'CREDENTIAL_MISSING'
  | 'WRONG_PROVIDER_IDENTITY'
  | 'TOKEN_EXPIRED'
  | 'OAUTH_REFRESH_FAILED'
  | 'SCOPE_MISSING'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'BROKER_CHECKOUT_INACCESSIBLE'
  | 'SESSION_AUTHORIZATION_REQUIRED'
  | 'PROVIDER_ALREADY_VERIFIED'
  | 'EXECUTABLE_NOT_APPROVED'
  | 'SOURCE_BOUND_OPERATION'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'AUDIT_UNAVAILABLE'
  | 'UNSUPPORTED_PROVIDER_OPERATION'
  | 'INVALID_REQUEST';

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'PROJECT_NOT_BOUND', 'CHECKOUT_NOT_APPROVED', 'REMOTE_NOT_ALLOWED', 'BROKER_UNAVAILABLE',
  'SECURITY_MODE_MISMATCH', 'CREDENTIAL_MISSING', 'WRONG_PROVIDER_IDENTITY', 'TOKEN_EXPIRED',
  'OAUTH_REFRESH_FAILED', 'SCOPE_MISSING', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED',
  'BROKER_CHECKOUT_INACCESSIBLE', 'SESSION_AUTHORIZATION_REQUIRED', 'PROVIDER_ALREADY_VERIFIED',
  'EXECUTABLE_NOT_APPROVED', 'SOURCE_BOUND_OPERATION', 'OUTPUT_LIMIT_EXCEEDED',
  'AUDIT_UNAVAILABLE', 'UNSUPPORTED_PROVIDER_OPERATION', 'INVALID_REQUEST',
]);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODES.has(value);
}

export class InframuxError extends Error {
  readonly code: ErrorCode;
  readonly recovery?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      cause?: unknown;
      recovery?: string;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'InframuxError';
    this.code = code;
    if (options.recovery !== undefined) this.recovery = options.recovery;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function asInframuxError(error: unknown): InframuxError {
  if (error instanceof InframuxError) return error;
  return new InframuxError('INVALID_REQUEST', 'The request could not be processed', {
    cause: error,
  });
}
