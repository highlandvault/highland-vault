/**
 * HMAC-SHA256 webhook signing, as used by the fake provider (ADR-0006: "signs
 * webhooks with an HMAC test key").
 *
 * This is the **fake provider's** scheme, not a contract every provider must
 * follow. A real adapter verifies whatever its provider actually sends and
 * keeps that algorithm behind its own file, exactly as this one does. What is
 * shared, and what this file exists to get right once, is the shape: sign the
 * raw bytes, compare in constant time, and never say why a comparison failed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The header the fake provider signs with. Provider-specific by nature. */
export const FAKE_SIGNATURE_HEADER = 'x-hv-fake-signature';

/**
 * Signs the raw body.
 *
 * The bytes are signed as given. Nothing is parsed, re-serialised or
 * normalised first: a JSON round trip reorders keys and rewrites numbers, and
 * the signature would then cover something the sender never sent.
 */
export function signWebhook(secret: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Whether `candidate` is the correct signature for these bytes.
 *
 * Constant-time over the digest, so a caller cannot learn the expected value
 * one character at a time by measuring how long a rejection takes. A candidate
 * of the wrong length is rejected before the comparison, because
 * `timingSafeEqual` throws on mismatched lengths — and its own length check is
 * not a leak: the length of a hex SHA-256 digest is public.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  candidate: string | undefined,
): boolean {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(signWebhook(secret, rawBody), 'utf8');
  const given = Buffer.from(candidate, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
