import type { ErrorCode } from '@hv/contracts';

/**
 * Application errors. Services throw these; the global exception filter turns
 * them into the uniform ErrorResponse body. Messages are safe to show to
 * clients: they never contain secrets or internal details.
 */
export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (details: unknown) =>
    new AppError(400, 'VALIDATION_FAILED', 'The request is invalid.', details),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Sign-in required.'),
  invalidCredentials: () =>
    new AppError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.'),
  mfaRequired: () =>
    new AppError(401, 'MFA_REQUIRED', 'Enter the code from your authenticator app to continue.'),
  invalidMfaCode: () => new AppError(401, 'INVALID_MFA_CODE', 'The code is invalid or was used.'),
  stepUpRequired: () =>
    new AppError(
      403,
      'STEP_UP_REQUIRED',
      'This operation needs a recent second-factor check (POST /auth/mfa/verify).',
    ),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have permission for this action.'),
  accountDisabled: () => new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled.'),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`),
  marketNotAvailable: () =>
    new AppError(404, 'MARKET_NOT_AVAILABLE', 'This market is not available.'),
  conflict: (code: ErrorCode, message: string, details?: unknown) =>
    new AppError(409, code, message, details),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(
      429,
      'RATE_LIMITED',
      'Too many attempts. Try again later.',
      { retryAfterSeconds },
      { 'retry-after': String(retryAfterSeconds) },
    ),
  serviceUnavailable: () =>
    new AppError(503, 'SERVICE_UNAVAILABLE', 'A required service is unavailable. Try again.'),
} as const;
