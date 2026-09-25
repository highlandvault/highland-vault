import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from './webhook-signature';

const SECRET = 'test-webhook-secret';
const BODY = Buffer.from('{"id":"evt_1","state":"succeeded"}', 'utf8');

describe('webhook signatures', () => {
  it('verifies a signature over the exact bytes', () => {
    expect(verifyWebhookSignature(SECRET, BODY, signWebhook(SECRET, BODY))).toBe(true);
  });

  it('is deterministic for the same key and bytes', () => {
    expect(signWebhook(SECRET, BODY)).toBe(signWebhook(SECRET, BODY));
  });

  it('refuses a body altered by one byte', () => {
    const tampered = Buffer.from('{"id":"evt_2","state":"succeeded"}', 'utf8');
    expect(verifyWebhookSignature(SECRET, tampered, signWebhook(SECRET, BODY))).toBe(false);
  });

  it('refuses a body that is only re-serialised', () => {
    // The same JSON with the keys in another order. Semantically identical,
    // different bytes — which is exactly why a handler must never parse and
    // re-serialise before verifying.
    const reserialised = Buffer.from(JSON.stringify({ state: 'succeeded', id: 'evt_1' }), 'utf8');
    expect(verifyWebhookSignature(SECRET, reserialised, signWebhook(SECRET, BODY))).toBe(false);
  });

  it('refuses a signature made with another key', () => {
    expect(verifyWebhookSignature(SECRET, BODY, signWebhook('another-secret', BODY))).toBe(false);
  });

  it('refuses a missing signature', () => {
    expect(verifyWebhookSignature(SECRET, BODY, undefined)).toBe(false);
  });

  it('refuses a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on mismatched lengths; the guard must catch this
    // first, or a truncated header would be a 500 instead of a rejection.
    expect(verifyWebhookSignature(SECRET, BODY, 'abc')).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, '')).toBe(false);
  });

  it('refuses a signature that differs only in the last character', () => {
    const valid = signWebhook(SECRET, BODY);
    const nearMiss = valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a');
    expect(verifyWebhookSignature(SECRET, BODY, nearMiss)).toBe(false);
  });
});
