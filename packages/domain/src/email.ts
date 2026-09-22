/**
 * Email identity (ADR-0003: email is globally unique; Revision 2 B9: the
 * normalized form is trimmed and lower-cased only — no provider-specific dot
 * or plus stripping). The database enforces the same form
 * (users_email_normalized).
 */

export const EMAIL_MAX_LENGTH = 254;

// Deliberately permissive: one "@", no whitespace, non-empty local and domain
// parts. Deliverability is proven by verification, not by a regex.
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;

export class EmailError extends Error {
  override readonly name = 'EmailError';
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidNormalizedEmail(email: string): boolean {
  return (
    email.length >= 3 &&
    email.length <= EMAIL_MAX_LENGTH &&
    EMAIL_SHAPE.test(email) &&
    email === normalizeEmail(email)
  );
}

/** Normalizes and validates; throws EmailError for anything that is not a usable address. */
export function parseEmail(input: string): string {
  const email = normalizeEmail(input);
  if (!isValidNormalizedEmail(email)) {
    throw new EmailError('Not a valid email address');
  }
  return email;
}
