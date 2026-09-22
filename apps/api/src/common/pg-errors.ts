/**
 * Recognizing PostgreSQL constraint violations. The database is the final
 * authority for invariants; services check first to give a clear answer, and
 * map a violation to a domain error when a concurrent change wins the race.
 */
interface PgError {
  code: string;
  constraint?: string;
  detail?: string;
}

function isPgError(error: unknown): error is PgError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code)
  );
}

export function isConstraintViolation(error: unknown, constraint: string): boolean {
  return isPgError(error) && error.constraint === constraint;
}

export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return isPgError(error) && error.code === UNIQUE_VIOLATION && error.constraint === constraint;
}

/** The DETAIL of a violation raised by the market triggers: a comma-separated setting list. */
export function violationDetailList(error: unknown): string[] {
  return isPgError(error) && error.detail ? error.detail.split(',').filter(Boolean) : [];
}
