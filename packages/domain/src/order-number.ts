/**
 * The customer-facing order number (ADR-0031).
 *
 * `HV-` followed by ten base32 characters, for example `HV-K4R7M2XQ9B`.
 *
 * WHY BASE32, AND WHY TEN. ADR-0031 fixes the prefix, requires an uppercase
 * alphanumeric suffix and leaves the length here. RFC 4648 base32 is a subset
 * of that alphabet with a property that matters for something read down a
 * phone line to support: it has no `0`/`O` and no `1`/`I` to confuse. It is
 * also the alphabet `generateRecoveryCode` already uses for this project's
 * other customer-facing, typed-back identifier.
 *
 * Ten characters is fifty bits, about 1.1e15 possibilities. At any order
 * volume this project will plausibly reach, a collision is something the
 * UNIQUE constraint catches on a retry rather than something anyone sees.
 * Long enough not to be guessed from a neighbouring order, short enough to
 * read aloud.
 *
 * Deliberately NOT sequential: a sequential number tells anyone holding one
 * how many orders exist, how fast they arrive, and what its neighbours are.
 */
import { randomBytes } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const ORDER_NUMBER_PREFIX = 'HV-';
export const ORDER_NUMBER_SUFFIX_LENGTH = 10;
const ORDER_NUMBER = /^HV-[A-Z2-7]{10}$/;

export function generateOrderNumber(): string {
  // One byte per character, taking five bits of each: simpler than repacking,
  // and the bias that would matter for a key does not exist here because 32
  // divides 256 exactly.
  const bytes = randomBytes(ORDER_NUMBER_SUFFIX_LENGTH);
  let suffix = '';
  for (const byte of bytes) suffix += BASE32[byte & 31];
  return ORDER_NUMBER_PREFIX + suffix;
}

export function isWellFormedOrderNumber(value: string): boolean {
  return ORDER_NUMBER.test(value);
}
