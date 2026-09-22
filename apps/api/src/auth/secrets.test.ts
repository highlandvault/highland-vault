import { describe, expect, it } from 'vitest';
import { clearedSessionCookie, readCookie, sessionCookie } from './cookies';
import { SecretBox } from './secret-box';
import {
  generateRecoveryCode,
  generateSessionToken,
  isWellFormedSessionToken,
  normalizeRecoveryCode,
} from './tokens';

const KEY = 'a1'.repeat(16) + 'b2'.repeat(16);

describe('SecretBox (AES-256-GCM)', () => {
  const box = new SecretBox(KEY, 'k1');

  it('round-trips and never stores the plaintext', () => {
    const secret = Buffer.from('totp-secret-bytes');
    const sealed = box.seal(secret, 'user-1');
    expect(sealed.includes(secret)).toBe(false);
    expect(box.open(sealed, 'user-1').equals(secret)).toBe(true);
  });

  it('uses a fresh nonce for every seal', () => {
    const secret = Buffer.from('same');
    expect(box.seal(secret, 'u').equals(box.seal(secret, 'u'))).toBe(false);
  });

  it('refuses data bound to another user, tampered data, or another key', () => {
    const sealed = box.seal(Buffer.from('secret'), 'user-1');
    expect(() => box.open(sealed, 'user-2')).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => box.open(tampered, 'user-1')).toThrow();
    expect(() => new SecretBox('c3'.repeat(32), 'k2').open(sealed, 'user-1')).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => new SecretBox('abcd', 'k1')).toThrow(/32 bytes/);
  });
});

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
