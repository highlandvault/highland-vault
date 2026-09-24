/**
 * Session cookies (Revision 2 B6): opaque token, HttpOnly, SameSite=Lax,
 * Secure outside local development (enforced for production in env.ts).
 *
 * Two names, one set of attributes. The guest cookie is deliberately separate
 * from the authenticated one so neither can ever be mistaken for the other,
 * but they are built here together so their security attributes cannot drift
 * apart (ADR-0029).
 */
export const SESSION_COOKIE = 'hv_session';
export const GUEST_SESSION_COOKIE = 'hv_guest';

export interface CookieOptions {
  readonly secure: boolean;
}

export function sessionCookie(token: string, expiresAt: Date, options: CookieOptions): string {
  return namedCookie(SESSION_COOKIE, token, expiresAt, options);
}

/** The guest cookie, with exactly the attributes of the authenticated one. */
export function guestSessionCookie(token: string, expiresAt: Date, options: CookieOptions): string {
  return namedCookie(GUEST_SESSION_COOKIE, token, expiresAt, options);
}

function namedCookie(name: string, token: string, expiresAt: Date, options: CookieOptions): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(options: CookieOptions): string {
  return clearedNamedCookie(SESSION_COOKIE, options);
}

export function clearedGuestSessionCookie(options: CookieOptions): string {
  return clearedNamedCookie(GUEST_SESSION_COOKIE, options);
}

function clearedNamedCookie(name: string, options: CookieOptions): string {
  return [
    `${name}=`,
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
