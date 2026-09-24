/**
 * The six-digit guest verification code (ADR-0020).
 *
 * Six digits is a million possibilities, which is only safe because the number
 * of guesses is small: the code expires, it can be used once, and the row it
 * lives on counts attempts. Those limits are what make the length acceptable,
 * so they are not optional extras.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';

export const VERIFICATION_CODE_LENGTH = 6;
/** Approved values (ADR-0020, owner decision during Phase 5). */
export const VERIFICATION_CODE_TTL_MINUTES = 10;
export const VERIFICATION_CODE_MAX_ATTEMPTS = 5;
export const VERIFICATION_CODES_PER_EMAIL_PER_HOUR = 3;

const CODE_SHAPE = /^\d{6}$/;

/**
 * A uniformly random six-digit code, leading zeros included.
 *
 * `randomInt` rather than `Math.random`: this is a credential for ten minutes,
 * and a predictable one would make the attempt limit pointless.
 */
export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(VERIFICATION_CODE_LENGTH, '0');
}

/** Whether something is shaped like a code, checked before any lookup. */
export function isWellFormedVerificationCode(code: string): boolean {
  return CODE_SHAPE.test(code);
}

/** Digits only, so a code pasted as "123 456" or "123-456" still works. */
export function normalizeVerificationCode(input: string): string {
  return input.replace(/[\s-]/g, '');
}

/**
 * Compares two code hashes without leaking where they differ.
 *
 * The timing of a comparison is a poor oracle for a hash, but it costs nothing
 * to remove it, and the same habit protects the places where it does matter.
 */
export function verificationHashesMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
