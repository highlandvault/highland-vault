/**
 * Encrypted outbox payloads (ADR-0028).
 *
 * An outbox payload is immutable by trigger and `hv_app` cannot delete outbox
 * rows, so anything written there can never be redacted. A guest verification
 * code is stored hashed (ADR-0020) and therefore has to travel to the mail
 * handler as plaintext — which would leave a readable one-time code, and a
 * recipient address, permanently at rest.
 *
 * So payloads carrying a code or an address are sealed with the same
 * AES-256-GCM construction used for TOTP secrets. The envelope is a JSON
 * object, so `outbox.payload` needs no schema change, and the job that carries
 * it through Redis carries the sealed form unchanged: the plaintext exists only
 * in memory, inside the handler, for as long as it takes to send the message.
 *
 * The topic is the associated data, so a sealed payload moved to another topic
 * will not open.
 */
import { SecretBox } from './secret-box';

/** Envelope version, so the shape can change without guessing at old rows. */
const ENVELOPE_VERSION = 1;

// A type alias, not an interface: an interface has no implicit index
// signature, so it would not satisfy the Record<string, unknown> that an
// outbox payload is.
export type SealedPayload = {
  readonly v: number;
  readonly kid: string;
  readonly sealed: string;
};

export function isSealedPayload(value: unknown): value is SealedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === ENVELOPE_VERSION &&
    typeof candidate.kid === 'string' &&
    typeof candidate.sealed === 'string'
  );
}

/** Seals `contents` for `topic`. The result is a plain object, ready for jsonb. */
export function sealPayload(
  box: SecretBox,
  topic: string,
  contents: Record<string, unknown>,
): SealedPayload {
  return {
    v: ENVELOPE_VERSION,
    kid: box.keyId,
    sealed: box.seal(Buffer.from(JSON.stringify(contents), 'utf8'), topic).toString('base64'),
  };
}

/**
 * Opens a sealed payload. Throws if it was sealed for another topic, with
 * another key, or tampered with — and never includes the plaintext, or any
 * part of it, in the error.
 */
export function openPayload<T = Record<string, unknown>>(
  box: SecretBox,
  topic: string,
  payload: unknown,
): T {
  if (!isSealedPayload(payload)) throw new Error('outbox payload is not a sealed envelope');
  if (payload.kid !== box.keyId) {
    throw new Error(`outbox payload was sealed with key "${payload.kid}"`);
  }
  const opened = box.open(Buffer.from(payload.sealed, 'base64'), topic);
  return JSON.parse(opened.toString('utf8')) as T;
}
