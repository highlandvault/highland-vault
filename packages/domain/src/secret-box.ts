/**
 * Authenticated encryption for secrets at rest (TOTP secrets), AES-256-GCM.
 * The key lives outside the database (MFA_ENCRYPTION_KEY). The associated data
 * binds a ciphertext to its owner, so a secret copied onto another user's row
 * does not decrypt.
 *
 * Layout: nonce (12 bytes) || auth tag (16 bytes) || ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBox {
  private readonly key: Buffer;

  constructor(
    hexKey: string,
    readonly keyId: string,
  ) {
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) throw new Error('encryption key must be 32 bytes');
  }

  seal(plaintext: Buffer, associatedData: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(associatedData));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  /** Throws if the data was tampered with, or sealed with another key or associated data. */
  open(sealed: Buffer, associatedData: string): Buffer {
    if (sealed.length <= NONCE_BYTES + TAG_BYTES) throw new Error('sealed data too short');
    const nonce = sealed.subarray(0, NONCE_BYTES);
    const tag = sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  }
}
