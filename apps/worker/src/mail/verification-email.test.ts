/**
 * The seam between the two halves of P5-4: the API produces these events and
 * this worker consumes them, in different processes and different deployments.
 * Nothing but `@hv/domain` holds them together, so what is checked here is
 * that a payload built from the producer's own constants is one this consumer
 * accepts — and that a rejection never quotes the code it rejected.
 */
import {
  SecretBox,
  VERIFICATION_CODE_TTL_MINUTES,
  generateVerificationCode,
  sealPayload,
} from '@hv/domain';
import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_EMAIL_TOPIC,
  createVerificationEmailOpener,
  renderVerificationEmail,
} from './verification-email';

// Low entropy on purpose: the repository's placeholder convention, which the
// production key guard rejects and the secret scanner ignores.
const box = new SecretBox('0'.repeat(64), 'test');
const open = createVerificationEmailOpener(box);

describe('what the API produces is what the worker accepts', () => {
  it('accepts a payload built from the producer’s own constants', () => {
    const code = generateVerificationCode();
    const sealed = sealPayload(box, VERIFICATION_EMAIL_TOPIC, {
      to: 'guest@example.com',
      code,
      expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES,
    });

    const opened = open(VERIFICATION_EMAIL_TOPIC, sealed);
    expect(opened.code).toBe(code);
    expect(opened.expiresInMinutes).toBe(VERIFICATION_CODE_TTL_MINUTES);
  });

  it('renders a message carrying the code and its lifetime', () => {
    const message = renderVerificationEmail({
      to: 'guest@example.com',
      code: '004219',
      expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES,
    });

    expect(message.to).toBe('guest@example.com');
    // Leading zeros survive: a code formatted as a number would not arrive.
    expect(message.text).toContain('004219');
    expect(message.text).toContain(`${VERIFICATION_CODE_TTL_MINUTES} minutes`);
  });
});

describe('a payload it will not take', () => {
  /** A payload that is right in every way except the one being tested. */
  const payloadWith = (change: Record<string, unknown>) => ({
    to: 'guest@example.com',
    code: '004219',
    expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES,
    ...change,
  });

  const malformed = [
    { name: 'a five-digit code', change: { code: '12345' } },
    { name: 'a lifetime beyond an hour', change: { expiresInMinutes: 90 } },
    { name: 'an address that is not one', change: { to: 'not-an-address' } },
    { name: 'a field nobody agreed on', change: { surprise: 'x' } },
  ];

  for (const { name, change } of malformed) {
    it(`refuses ${name}`, () => {
      const sealed = sealPayload(box, VERIFICATION_EMAIL_TOPIC, payloadWith(change));
      expect(() => open(VERIFICATION_EMAIL_TOPIC, sealed)).toThrow(/malformed/);
    });
  }

  it('names the field but never quotes the value', () => {
    const sealed = sealPayload(box, VERIFICATION_EMAIL_TOPIC, {
      to: 'guest@example.com',
      code: '12345',
      expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES,
    });

    // The failing value here IS the one-time code and the address; an error
    // that repeated them would put both into the worker's logs.
    expect(() => open(VERIFICATION_EMAIL_TOPIC, sealed)).toThrow(/code/);
    try {
      open(VERIFICATION_EMAIL_TOPIC, sealed);
      expect.unreachable('malformed payload was accepted');
    } catch (error) {
      expect((error as Error).message).not.toContain('12345');
      expect((error as Error).message).not.toContain('guest@example.com');
    }
  });

  it('refuses a topic that is not its own, before opening anything', () => {
    const sealed = sealPayload(box, 'email.something_else', {
      to: 'guest@example.com',
      code: '004219',
      expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES,
    });
    expect(() => open('email.something_else', sealed)).toThrow(/unexpected topic/);
  });
});
