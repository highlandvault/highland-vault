/**
 * The session cookie (Revision 2 B6): opaque token, HttpOnly, SameSite=Lax,
 * Secure outside local development (enforced for production in env.ts).
 */
export const SESSION_COOKIE = 'hv_session';

export interface CookieOptions {
  readonly secure: boolean;
}

export function sessionCookie(token: string, expiresAt: Date, options: CookieOptions): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(options: CookieOptions): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

/** Reads one cookie from a Cookie header without a parsing dependency. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}
