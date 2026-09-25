import { z } from 'zod';

/** Every error code the API can return. Clients branch on `code`, never on `message`. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'NOT_FOUND',
  'MARKET_NOT_AVAILABLE',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'MFA_REQUIRED',
  'INVALID_MFA_CODE',
  'STEP_UP_REQUIRED',
  'FORBIDDEN',
  'ACCOUNT_DISABLED',
  'ORIGIN_NOT_ALLOWED',
  'EMAIL_TAKEN',
  'MFA_ALREADY_ENABLED',
  'MFA_NOT_ENROLLED',
  'LEGAL_APPROVAL_REQUIRED',
  'LEGAL_APPROVAL_NOT_APPLICABLE',
  'LEGAL_APPROVAL_ALREADY_RECORDED',
  'COMPLIANCE_SETTINGS_MISSING',
  'DRAW_SLUG_TAKEN',
  'DRAW_NOT_EDITABLE',
  'DRAW_NOT_PUBLISHABLE',
  'DRAW_TRANSITION_NOT_ALLOWED',
  'DRAW_NOT_OPEN',
  'INVALID_QUANTITY',
  // Guest email verification (ADR-0020). Deliberately coarse: a caller never
  // learns whether a code was wrong, expired, already used or never issued.
  'VERIFICATION_REQUIRED',
  'INVALID_VERIFICATION_CODE',
  'TICKET_CAP_EXCEEDED',
  'INSUFFICIENT_TICKETS',
  'CONFLICT',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Uniform error body for every non-2xx API response. */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  requestId: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const ValidationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
