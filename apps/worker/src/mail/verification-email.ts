/**
 * The guest verification email: its event contract and how the message is
 * rendered (ADR-0020 for the code itself, ADR-0028 for the sealed payload).
 *
 * P5-2 builds the delivery path only. The producer arrives with the guest
 * verification flow in P5-4; nothing here creates a code or decides when one
 * is sent.
 *
 * The payload is SEALED, because the code is stored hashed and so has to reach
 * this handler as plaintext — and an outbox payload can never be redacted
 * afterwards. The plaintext exists only here, in memory, while the message is
 * built. It is never logged and never returned in an error.
 */
import { openPayload, type SecretBox } from '@hv/domain';
import { z } from 'zod';
import type { MailMessage } from './mail.port';

export const VERIFICATION_EMAIL_TOPIC = 'email.verification_code';

/** The sealed contents. ADR-0020 fixes the 6 digits; P5-4 fixes the lifetime. */
export const VerificationEmailPayloadSchema = z.strictObject({
  to: z.email(),
  code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
  expiresInMinutes: z.number().int().min(1).max(60),
});
export type VerificationEmailPayload = z.infer<typeof VerificationEmailPayloadSchema>;

/** Opens a sealed payload for a topic. Injected so the key stays in configuration. */
export type VerificationEmailOpener = (
  topic: string,
  payload: Record<string, unknown>,
) => VerificationEmailPayload;

export function createVerificationEmailOpener(box: SecretBox): VerificationEmailOpener {
  return (topic, payload) => {
    if (topic !== VERIFICATION_EMAIL_TOPIC) {
      throw new Error(`unexpected topic for a verification email: "${topic}"`);
    }
    // The topic is the associated data, so a payload sealed for another topic
    // will not open here.
    const opened = openPayload(box, topic, payload);
    const parsed = VerificationEmailPayloadSchema.safeParse(opened);
    if (!parsed.success) {
      // Issue paths only — the values are the code and the address.
      throw new Error(
        `verification payload is malformed: ${parsed.error.issues
          .map((issue) => issue.path.join('.') || '(root)')
          .join(', ')}`,
      );
    }
    return parsed.data;
  };
}

/**
 * Builds the message. Deliberately plain: per-market and per-locale templates
 * are Phase 12, and inventing wording here would pre-empt the compliance
 * values that are still open (O12).
 */
export function renderVerificationEmail(payload: VerificationEmailPayload): MailMessage {
  return {
    to: payload.to,
    subject: `Your Highland Vault verification code`,
    text: [
      `Your verification code is ${payload.code}.`,
      ``,
      `It expires in ${payload.expiresInMinutes} minutes and can be used once.`,
      `If you did not ask to verify this address, you can ignore this email.`,
    ].join('\n'),
  };
}
