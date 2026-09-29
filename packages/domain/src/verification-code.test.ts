/**
 * The verification code itself (ADR-0020). Six digits is a small space, so
 * what matters is that it is drawn uniformly, compared without leaking, and
 * that the limits protecting it are the approved ones.
 */
import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_CODES_PER_EMAIL_PER_HOUR,
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_MAX_ATTEMPTS,
  VERIFICATION_CODE_TTL_MINUTES,
  generateVerificationCode,
  isWellFormedVerificationCode,
  normalizeVerificationCode,
  verificationHashesMatch,
} from './verification-code';

describe('the approved values', () => {
  it('are the ones the owner approved for Phase 5', () => {
    expect(VERIFICATION_CODE_LENGTH).toBe(6);
    expect(VERIFICATION_CODE_TTL_MINUTES).toBe(10);
    expect(VERIFICATION_CODE_MAX_ATTEMPTS).toBe(5);
    expect(VERIFICATION_CODES_PER_EMAIL_PER_HOUR).toBe(3);
  });
});

describe('generating a code', () => {
  it('is always six digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateVerificationCode()).toMatch(/^\d{6}$/);
    }
  });

  it('keeps leading zeros rather than shortening the code', () => {
    // A code formatted as a number would sometimes be five digits, which both
    // breaks the shape check and shrinks the space.
    const codes = Array.from({ length: 2000 }, generateVerificationCode);
    expect(codes.every((c) => c.length === 6)).toBe(true);
  });

  it('does not repeat itself in any obvious way', () => {
    const codes = new Set(Array.from({ length: 500 }, generateVerificationCode));
    // Collisions are possible in a million-wide space but should be rare.
    expect(codes.size).toBeGreaterThan(480);
  });

  it('uses the whole space, not a corner of it', () => {
    const codes = Array.from({ length: 2000 }, generateVerificationCode).map(Number);
    expect(Math.min(...codes)).toBeLessThan(200_000);
    expect(Math.max(...codes)).toBeGreaterThan(800_000);
  });
});

describe('reading a code the customer typed', () => {
  it('accepts six digits', () => {
    expect(isWellFormedVerificationCode('000000')).toBe(true);
    expect(isWellFormedVerificationCode('493028')).toBe(true);
  });

  it('rejects anything else, before any lookup happens', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '١٢٣٤٥٦', '12345a']) {
      expect(isWellFormedVerificationCode(bad)).toBe(false);
    }
  });

  it('strips the spaces and dashes people paste', () => {
    expect(normalizeVerificationCode('123 456')).toBe('123456');
    expect(normalizeVerificationCode('123-456')).toBe('123456');
    expect(normalizeVerificationCode(' 12 34-56 ')).toBe('123456');
  });

  it('does not invent digits out of other characters', () => {
    expect(isWellFormedVerificationCode(normalizeVerificationCode('12a456'))).toBe(false);
  });
});

describe('comparing hashes', () => {
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 1);
  const c = Buffer.alloc(32, 2);

  it('matches equal digests', () => {
    expect(verificationHashesMatch(a, b)).toBe(true);
  });

  it('rejects different digests', () => {
    expect(verificationHashesMatch(a, c)).toBe(false);
  });

  it('rejects a different length instead of throwing', () => {
    // timingSafeEqual throws on unequal lengths; a malformed row must be a
    // failed comparison, not a 500.
    expect(verificationHashesMatch(a, Buffer.alloc(16, 1))).toBe(false);
  });
});
