import { describe, expect, it } from 'vitest';
import { CURRENT_PARAMS, hashPassword, needsRehash, verifyPassword } from './password';

describe('Argon2id password hashing', () => {
  it('produces a PHC-format Argon2id hash with the current parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password!'),
      hashPassword('same password!'),
    ]);
    expect(a).not.toBe(b);
  });

  it('never verifies a malformed or foreign stored hash', async () => {
    expect(await verifyPassword('', 'x')).toBe(false);
    expect(await verifyPassword('$2y$10$abcdefghijklmnopqrstuv', 'x')).toBe(false);
    expect(await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$AAAA$AAAA', 'x')).toBe(false);
  });

  it('flags hashes made with other parameters for rehashing', async () => {
    const weaker = await hashPassword('rehash me please', { ...CURRENT_PARAMS, passes: 1 });
    expect(await verifyPassword(weaker, 'rehash me please')).toBe(true);
    expect(needsRehash(weaker)).toBe(true);
    expect(needsRehash(await hashPassword('rehash me please'))).toBe(false);
  });
});
