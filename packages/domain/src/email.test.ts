import { describe, expect, it } from 'vitest';
import { EmailError, isValidNormalizedEmail, normalizeEmail, parseEmail } from './email';

describe('email identity', () => {
  it('normalizes by trimming and lower-casing only', () => {
    expect(normalizeEmail('  Jane.Doe+Draws@Example.COM \n')).toBe('jane.doe+draws@example.com');
  });

  it('does not strip dots or plus tags (no provider-specific rules)', () => {
    expect(parseEmail('j.a.n.e+x@gmail.com')).toBe('j.a.n.e+x@gmail.com');
    expect(parseEmail('jane@gmail.com')).not.toBe(parseEmail('j.ane@gmail.com'));
  });

  it('maps differently-cased input to the same identity', () => {
    expect(parseEmail('JANE@example.com')).toBe(parseEmail('jane@EXAMPLE.com'));
  });

  it.each(['', 'no-at-sign', 'two@@example.com', 'a b@example.com', '@example.com', 'jane@'])(
    'rejects %j',
    (input) => {
      expect(() => parseEmail(input)).toThrow(EmailError);
    },
  );

  it('rejects addresses longer than 254 characters', () => {
    expect(() => parseEmail(`${'a'.repeat(250)}@x.io`)).toThrow(EmailError);
  });

  it('treats only the normalized form as valid storage form', () => {
    expect(isValidNormalizedEmail('jane@example.com')).toBe(true);
    expect(isValidNormalizedEmail('Jane@example.com')).toBe(false);
    expect(isValidNormalizedEmail(' jane@example.com')).toBe(false);
  });
});
