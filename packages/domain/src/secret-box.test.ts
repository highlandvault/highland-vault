/**
 * AES-256-GCM secret sealing, shared by the API (TOTP secrets) and the worker
 * (sensitive outbox payloads). One implementation, one key-management model.
 */
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box';

const KEY = 'a1'.repeat(16) + 'b2'.repeat(16);

describe('SecretBox (AES-256-GCM)', () => {
  const box = new SecretBox(KEY, 'k1');

  it('round-trips and never stores the plaintext', () => {
    const secret = Buffer.from('totp-secret-bytes');
    const sealed = box.seal(secret, 'user-1');
    expect(sealed.includes(secret)).toBe(false);
    expect(box.open(sealed, 'user-1').equals(secret)).toBe(true);
  });

  it('uses a fresh nonce for every seal', () => {
    const secret = Buffer.from('same');
    expect(box.seal(secret, 'u').equals(box.seal(secret, 'u'))).toBe(false);
  });

  it('refuses data bound to another user, tampered data, or another key', () => {
    const sealed = box.seal(Buffer.from('secret'), 'user-1');
    expect(() => box.open(sealed, 'user-2')).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => box.open(tampered, 'user-1')).toThrow();
    expect(() => new SecretBox('c3'.repeat(32), 'k2').open(sealed, 'user-1')).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => new SecretBox('abcd', 'k1')).toThrow(/32 bytes/);
  });
});
