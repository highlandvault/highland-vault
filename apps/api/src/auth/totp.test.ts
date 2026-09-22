import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotp,
  otpauthUri,
  totpStep,
} from './totp';

// RFC 6238 Appendix B test secret for HMAC-SHA1.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP (RFC 6238)', () => {
  // Appendix B lists 8-digit codes; the 6-digit code is the last six digits.
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('matches the RFC test vector at T=%i', (seconds, code) => {
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
  });

  it('matches RFC 4226 Appendix D HOTP values', () => {
    expect([0, 1, 2, 9].map((counter) => hotp(RFC_SECRET, counter))).toEqual([
      '755224',
      '287082',
      '359152',
      '520489',
    ]);
  });

  describe('matchTotp', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const secret = generateTotpSecret();

    it('accepts the current code and returns its step', () => {
      expect(matchTotp(secret, hotp(secret, step), now, null)).toBe(step);
    });

    it('accepts one step of clock drift either way, but not two', () => {
      expect(matchTotp(secret, hotp(secret, step - 1), now, null)).toBe(step - 1);
      expect(matchTotp(secret, hotp(secret, step + 1), now, null)).toBe(step + 1);
      expect(matchTotp(secret, hotp(secret, step - 2), now, null)).toBeNull();
      expect(matchTotp(secret, hotp(secret, step + 2), now, null)).toBeNull();
    });

    it('never accepts a step at or before the last used one (no replay)', () => {
      expect(matchTotp(secret, hotp(secret, step), now, step)).toBeNull();
      expect(matchTotp(secret, hotp(secret, step - 1), now, step - 1)).toBeNull();
      expect(matchTotp(secret, hotp(secret, step + 1), now, step)).toBe(step + 1);
    });

    it('rejects malformed codes', () => {
      expect(matchTotp(secret, '12345', now, null)).toBeNull();
      expect(matchTotp(secret, 'abcdef', now, null)).toBeNull();
      expect(matchTotp(secret, '1234567', now, null)).toBeNull();
    });
  });

  it('round-trips base32 (RFC 4648 test vectors)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    const secret = generateTotpSecret();
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(() => base32Decode('MZXW6YTB0I')).toThrow(); // '0' is not base32
  });

  it('builds an otpauth URI for authenticator apps', () => {
    const uri = new URL(otpauthUri(RFC_SECRET, 'jane@example.com', 'Highland Vault'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Highland Vault:jane@example.com');
    expect(uri.searchParams.get('secret')).toBe(base32Encode(RFC_SECRET));
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});
