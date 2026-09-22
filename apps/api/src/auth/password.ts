/**
 * Argon2id password hashing (Revision 2 B6) with Node's built-in
 * crypto.argon2 (Node >= 24.7), so no native dependency is needed.
 *
 * Hashes are stored in the standard PHC string format:
 *   $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt b64>$<hash b64>
 */
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Argon2Params {
  /** Memory in KiB. */
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
}

/** OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1. */
export const CURRENT_PARAMS: Argon2Params = Object.freeze({
  memory: 19_456,
  passes: 2,
  parallelism: 1,
});

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(
  password: string,
  salt: Buffer,
  params: Argon2Params,
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: password,
        nonce: salt,
        memory: params.memory,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength,
      },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

export async function hashPassword(
  password: string,
  params: Argon2Params = CURRENT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, params, TAG_BYTES);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

interface ParsedHash {
  params: Argon2Params;
  salt: Buffer;
  hash: Buffer;
}

function parse(encoded: string): ParsedHash | null {
  const match = PHC.exec(encoded);
  if (!match) return null;
  const [, m, t, p, salt, hash] = match;
  return {
    params: { memory: Number(m), passes: Number(t), parallelism: Number(p) },
    salt: Buffer.from(salt!, 'base64'),
    hash: Buffer.from(hash!, 'base64'),
  };
}

/** Constant-time comparison. A malformed stored hash never verifies. */
export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed || parsed.hash.length < 16) return false;
  const candidate = await derive(password, parsed.salt, parsed.params, parsed.hash.length);
  return timingSafeEqual(candidate, parsed.hash);
}

/** True when the stored hash uses weaker or different parameters than CURRENT_PARAMS. */
export function needsRehash(encoded: string, params: Argon2Params = CURRENT_PARAMS): boolean {
  const parsed = parse(encoded);
  return (
    !parsed ||
    parsed.params.memory !== params.memory ||
    parsed.params.passes !== params.passes ||
    parsed.params.parallelism !== params.parallelism ||
    parsed.hash.length !== TAG_BYTES
  );
}
