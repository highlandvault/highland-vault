/**
 * The guest verification email, as producer and deliverer both see it
 * (ADR-0020, ADR-0028).
 *
 * The API creates the event and the worker sends it, so the topic and the
 * shape of what travels between them belong here rather than in either app.
 * The payload is sealed with `sealPayload` before it reaches the outbox: the
 * code is stored hashed, so the plaintext has to travel in the event, and an
 * outbox payload can never be redacted afterwards.
 */

export const VERIFICATION_EMAIL_TOPIC = 'email.verification_code';

/**
 * What the sealed payload contains once opened.
 *
 * A type alias, not an interface: an interface has no implicit index
 * signature, so it would not satisfy the Record<string, unknown> that an
 * outbox payload is.
 */
export type VerificationEmailPayload = {
  readonly to: string;
  readonly code: string;
  readonly expiresInMinutes: number;
};
