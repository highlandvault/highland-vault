import { describe, expect, it } from 'vitest';
import { clearedSessionCookie, readCookie, sessionCookie } from './cookies';
import {
  generateRecoveryCode,
  generateSessionToken,
  isWellFormedSessionToken,
  normalizeRecoveryCode,
} from './tokens';

describe('tokens', () => {
  it('generates 256-bit base64url session tokens', () => {
    const token = generateSessionToken();
    expect(isWellFormedSessionToken(token)).toBe(true);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateSessionToken()).not.toBe(token);
  });

  it('rejects malformed session tokens before any lookup', () => {
    expect(isWellFormedSessionToken('')).toBe(false);
    expect(isWellFormedSessionToken('x'.repeat(42))).toBe(false);
    expect(isWellFormedSessionToken(`${'x'.repeat(42)}'`)).toBe(false);
  });

  it('formats recovery codes as 4×4 base32 groups and normalizes typed input', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(normalizeRecoveryCode(` ${code.toLowerCase()} `)).toBe(code.replace(/-/g, ''));
  });
});

describe('session cookie', () => {
  const expires = new Date(Date.now() + 3_600_000);

  it('is HttpOnly and SameSite=Lax, and Secure when configured', () => {
    const secure = sessionCookie('tok', expires, { secure: true });
    expect(secure).toMatch(
      /^hv_session=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Expires=/,
    );
    expect(secure).toMatch(/; Secure$/);
    expect(sessionCookie('tok', expires, { secure: false })).not.toMatch(/Secure/);
  });

  it('clears with Max-Age=0', () => {
    expect(clearedSessionCookie({ secure: true })).toMatch(/^hv_session=; .*Max-Age=0/);
  });

  it('reads one cookie from a header', () => {
    expect(readCookie('a=1; hv_session=abc; b=2', 'hv_session')).toBe('abc');
    expect(readCookie('hv_sessionx=abc', 'hv_session')).toBeNull();
    expect(readCookie(undefined, 'hv_session')).toBeNull();
  });
});
