/**
 * Sealed outbox payloads (ADR-0028). The point of the envelope is that a
 * one-time code written to the outbox — which can never be redacted — is not
 * readable at rest.
 */
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box';
import { isSealedPayload, openPayload, sealPayload } from './sealed-payload';

const box = new SecretBox('a1'.repeat(16) + 'b2'.repeat(16), 'k1');
const TOPIC = 'email.verification_code';

describe('sealed outbox payload', () => {
  it('round-trips the contents', () => {
    const contents = { to: 'guest@example.com', code: '123456', expiresInMinutes: 10 };
    expect(openPayload(box, TOPIC, sealPayload(box, TOPIC, contents))).toEqual(contents);
  });

  it('leaves no readable trace of the code or the address', () => {
    const sealed = sealPayload(box, TOPIC, { to: 'guest@example.com', code: '123456' });
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('guest@example.com');
    expect(Object.keys(sealed).sort()).toEqual(['kid', 'sealed', 'v']);
  });

  it('produces a different envelope every time, for identical contents', () => {
    const contents = { code: '123456' };
    expect(sealPayload(box, TOPIC, contents).sealed).not.toBe(
      sealPayload(box, TOPIC, contents).sealed,
    );
  });

  it('will not open a payload sealed for another topic', () => {
    const sealed = sealPayload(box, 'email.something_else', { code: '123456' });
    expect(() => openPayload(box, TOPIC, sealed)).toThrow();
  });

  it('will not open a payload sealed with another key', () => {
    const sealed = sealPayload(new SecretBox('c3'.repeat(32), 'k1'), TOPIC, { code: '123456' });
    expect(() => openPayload(box, TOPIC, sealed)).toThrow();
  });

  it('names the key it was sealed with, so a rotated key is diagnosable', () => {
    const sealed = sealPayload(new SecretBox('c3'.repeat(32), 'k2'), TOPIC, { code: '1' });
    expect(() => openPayload(box, TOPIC, sealed)).toThrow(/sealed with key "k2"/);
  });

  it('rejects anything that is not an envelope', () => {
    for (const value of [null, 'text', 42, {}, { v: 1 }, { v: 2, kid: 'k1', sealed: 'x' }]) {
      expect(isSealedPayload(value)).toBe(false);
      expect(() => openPayload(box, TOPIC, value)).toThrow(/not a sealed envelope/);
    }
  });

  it('detects tampering', () => {
    const sealed = sealPayload(box, TOPIC, { code: '123456' });
    const bytes = Buffer.from(sealed.sealed, 'base64');
    bytes[bytes.length - 1]! ^= 1;
    expect(() =>
      openPayload(box, TOPIC, { ...sealed, sealed: bytes.toString('base64') }),
    ).toThrow();
  });
});
