/**
 * Opaque session tokens and single-use recovery codes. Only SHA-256 hashes are
 * stored: both are high-entropy random values, so a fast hash is sufficient
 * (there is nothing to brute-force from a leaked hash).
 */
import { createHash, randomBytes } from 'node:crypto';
import { base32Encode } from './totp';

const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** 256 random bits, base64url: 43 characters. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isWellFormedSessionToken(token: string): boolean {
  return SESSION_TOKEN.test(token);
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export const RECOVERY_CODE_COUNT = 10;

/** 80 random bits as 16 base32 characters, grouped for readability: ABCD-EFGH-IJKL-MNOP. */
export function generateRecoveryCode(): string {
  return base32Encode(randomBytes(10)).match(/.{4}/g)!.join('-');
}

/** Case and separators are not significant when a code is typed back. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/-/g, '');
}
