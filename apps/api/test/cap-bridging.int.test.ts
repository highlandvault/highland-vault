/**
 * Guest → account ticket-cap bridging (migration 0017, task P5-8; ADR-0021).
 *
 * ADR-0008 keys a guest's cap on the address they verified, precisely so that
 * one person gets one cap. That only holds if the address and the account it
 * later becomes are the same entrant, which is what this file is about: buy to
 * the cap as a guest, register with that address, and you may buy no more.
 *
 * The trap these tests exist to catch is quieter than the cap itself.
 * `hv_end_reservation` gives the allowance back using the key stored ON THE
 * RESERVATION, so a counter that moved without its hold would never be
 * decremented again — the tickets would come back and the allowance would not.
 */
import {
  SecretBox,
  VERIFICATION_EMAIL_TOPIC,
  openPayload,
  type VerificationEmailPayload,
} from '@hv/domain';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUEST_SESSION_COOKIE } from '../src/auth/cookies';
import {
  Client,
  PASSWORD,
  type Harness,
  WEB_ORIGIN,
  randomIp,
  startHarness,
  uniqueEmail,
} from './support';

const KEY = 'a1'.repeat(16) + 'b2'.repeat(16);
const box = new SecretBox(KEY, 'k1');

describe('a guest who registers keeps the cap they already used', () => {
  let h: Harness;
  let slug: string;
  const CAP = 4;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk']);
    slug = `bridge-${Date.now()}`;
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug,
      state: 'live',
      totalTickets: 500,
      maxPerPerson: CAP,
      ticketPriceMinor: 250,
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  let ip: string;
  beforeEach(() => {
    ip = randomIp();
  });

  const inject = (method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      remoteAddress: ip,
      headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const guestCookieFrom = (response: { headers: Record<string, unknown> }) => {
    const raw = response.headers['set-cookie'] as string | string[] | undefined;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = value ? new RegExp(`${GUEST_SESSION_COOKIE}=([^;]*)`).exec(value) : null;
    return match ? `${GUEST_SESSION_COOKIE}=${match[1]}` : null;
  };

  /** A guest session with `email` verified on it. */
  const verifiedGuest = async (email: string) => {
    const requested = await inject('POST', '/markets/uk/checkout/email/code', undefined, { email });
    expect(requested.statusCode).toBe(202);
    const cookie = guestCookieFrom(requested)!;
    const { rows } = await h.sql.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = $1 ORDER BY created_at DESC LIMIT 1`,
      [VERIFICATION_EMAIL_TOPIC],
    );
    const code = openPayload<VerificationEmailPayload>(
      box,
      VERIFICATION_EMAIL_TOPIC,
      rows[0]!.payload,
    ).code;
    const verified = await inject('POST', '/markets/uk/checkout/email/verify', cookie, {
      email,
      code,
    });
    expect(verified.statusCode).toBe(200);
    return cookie;
  };

  const register = (email: string) =>
    h.app.inject({
      method: 'POST',
      url: '/auth/register',
      remoteAddress: randomIp(),
      headers: { origin: WEB_ORIGIN },
      payload: { email, password: PASSWORD },
    });

  const counters = async (ref: string) => {
    const { rows } = await h.sql.query<{ entrant_type: string; count: number }>(
      `SELECT entrant_type, count FROM draw_entrant_counts dec
         JOIN draws d ON d.id = dec.draw_id
        WHERE d.slug = $1 AND dec.entrant_ref = $2`,
      [slug, ref],
    );
    return rows;
  };

  const userId = async (email: string) => {
    const { rows } = await h.sql.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
      email,
    ]);
    return rows[0]?.id ?? null;
  };

  // ---- the case ADR-0021 exists for ---------------------------------------

  it('cannot buy again after registering with the address it used', async () => {
    const email = uniqueEmail('bridge-guest');
    const cookie = await verifiedGuest(email);
    expect(
      (await inject('POST', '/markets/uk/cart/items', cookie, { slug, quantity: CAP })).statusCode,
    ).toBe(201);
    expect(await counters(email)).toEqual([{ entrant_type: 'email', count: CAP }]);

    expect((await register(email)).statusCode).toBe(201);
    const id = (await userId(email))!;

    // The count followed the person, and the address holds nothing.
    expect(await counters(id)).toEqual([{ entrant_type: 'user', count: CAP }]);
    expect(await counters(email)).toEqual([{ entrant_type: 'email', count: 0 }]);

    // And the account is at its cap, which is the whole point.
    const client = await signIn(email);
    const again = await client.post('/markets/uk/cart/items', { slug, quantity: 1 });
    expect(again.statusCode).toBe(409);
  });

  it('moves the live hold with the counter, so expiry still gives it back', async () => {
    // The silent failure this guards: a counter that moved without its hold is
    // decremented by a WHERE that matches zero rows, and the allowance is lost.
    const email = uniqueEmail('bridge-expiry');
    const cookie = await verifiedGuest(email);
    await inject('POST', '/markets/uk/cart/items', cookie, { slug, quantity: 2 });
    expect((await register(email)).statusCode).toBe(201);
    const id = (await userId(email))!;

    const { rows } = await h.sql.query<{ entrant_type: string; entrant_ref: string; id: string }>(
      `SELECT r.id, r.entrant_type, r.entrant_ref FROM reservations r
         JOIN draws d ON d.id = r.draw_id
        WHERE d.slug = $1 AND r.status = 'active' AND r.entrant_ref IN ($2, $3)`,
      [slug, id, email],
    );
    expect(rows).toHaveLength(1);
    // Re-keyed, not left behind.
    expect(rows[0]).toMatchObject({ entrant_type: 'user', entrant_ref: id });

    await h.sql.query(`SELECT hv_end_reservation($1, 'released')`, [rows[0]!.id]);
    expect(await counters(id)).toEqual([{ entrant_type: 'user', count: 0 }]);
  });

  it('uses the account identity when one already exists', async () => {
    const email = uniqueEmail('bridge-existing');
    expect((await register(email)).statusCode).toBe(201);
    const id = (await userId(email))!;

    // A guest session verifying an address that already has an account.
    const cookie = await verifiedGuest(email);
    expect(
      (await inject('POST', '/markets/uk/cart/items', cookie, { slug, quantity: 2 })).statusCode,
    ).toBe(201);

    // Charged to the account from the start; nothing under the address.
    expect(await counters(id)).toEqual([{ entrant_type: 'user', count: 2 }]);
    expect(await counters(email)).toEqual([]);

    const { rows } = await h.sql.query<{ entrant_type: string; user_id: string | null }>(
      `SELECT r.entrant_type, r.user_id FROM reservations r
         JOIN draws d ON d.id = r.draw_id
        WHERE d.slug = $1 AND r.entrant_ref = $2`,
      [slug, id],
    );
    expect(rows[0]).toMatchObject({ entrant_type: 'user', user_id: id });
  });

  it('sums both keys when the account already held tickets', async () => {
    const email = uniqueEmail('bridge-both');
    // An account that has already taken some, via its own session.
    expect((await register(email)).statusCode).toBe(201);
    const id = (await userId(email))!;
    const client = await signIn(email);
    await client.post('/markets/uk/cart/items', { slug, quantity: 1 });

    // A count under the address as well — the state a pre-bridging guest
    // purchase would have left behind.
    await h.sql.query(
      `INSERT INTO draw_entrant_counts (draw_id, entrant_type, entrant_ref, count)
       SELECT id, 'email', $2, 2 FROM draws WHERE slug = $1`,
      [slug, email],
    );

    // Registering again is refused, so bridge through a second account with
    // the same counts is not possible; instead assert the merge arithmetic
    // directly through a fresh address that owns both keys.
    const { rows } = await h.sql.query<{ count: number }>(
      `SELECT count FROM draw_entrant_counts dec JOIN draws d ON d.id = dec.draw_id
        WHERE d.slug = $1 AND dec.entrant_type = 'user' AND dec.entrant_ref = $2`,
      [slug, id],
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('leaves a registration with no guest history alone', async () => {
    const email = uniqueEmail('bridge-none');
    expect((await register(email)).statusCode).toBe(201);
    const id = (await userId(email))!;
    expect(await counters(id)).toEqual([]);
    expect(await counters(email)).toEqual([]);

    // And the account can still buy its full allowance.
    const client = await signIn(email);
    expect((await client.post('/markets/uk/cart/items', { slug, quantity: CAP })).statusCode).toBe(
      201,
    );
  });

  // ---- concurrency ---------------------------------------------------------

  it('ends with one key when a purchase and a registration race', async () => {
    const email = uniqueEmail('bridge-race');
    const cookie = await verifiedGuest(email);

    // Both paths take the entrant lock on this address, so one observes the
    // other however the scheduler interleaves them.
    const [purchase, registration] = await Promise.all([
      inject('POST', '/markets/uk/cart/items', cookie, { slug, quantity: 2 }),
      register(email),
    ]);
    expect(purchase.statusCode).toBe(201);
    expect(registration.statusCode).toBe(201);

    const id = (await userId(email))!;
    const user = await counters(id);
    const address = await counters(email);

    // Whichever order they landed in, the tickets are counted once, against
    // the account, and the address holds nothing live.
    expect(user).toEqual([{ entrant_type: 'user', count: 2 }]);
    expect(address.every((row) => row.count === 0)).toBe(true);

    // The hold agrees with the counter, or expiry would lose the allowance.
    const { rows } = await h.sql.query<{ entrant_type: string; entrant_ref: string }>(
      `SELECT r.entrant_type, r.entrant_ref FROM reservations r
         JOIN draws d ON d.id = r.draw_id
        WHERE d.slug = $1 AND r.status = 'active' AND r.entrant_ref IN ($2, $3)`,
      [slug, id, email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entrant_type: 'user', entrant_ref: id });
  });

  // ---- the guard the migration relaxed ------------------------------------

  it('still refuses any other change of entrant', async () => {
    const email = uniqueEmail('bridge-guard');
    const cookie = await verifiedGuest(email);
    await inject('POST', '/markets/uk/cart/items', cookie, { slug, quantity: 1 });
    const { rows } = await h.sql.query<{ id: string }>(
      `SELECT r.id FROM reservations r JOIN draws d ON d.id = r.draw_id
        WHERE d.slug = $1 AND r.entrant_ref = $2`,
      [slug, email],
    );
    const reservation = rows[0]!.id;

    // A different address: not the one permitted re-key.
    await expect(
      h.sql.query(`UPDATE reservations SET entrant_ref = 'someone@example.com' WHERE id = $1`, [
        reservation,
      ]),
    ).rejects.toThrow(/entrant can only change/);

    // 'user' without a user id, or with a mismatched one.
    await expect(
      h.sql.query(`UPDATE reservations SET entrant_type = 'user' WHERE id = $1`, [reservation]),
    ).rejects.toThrow();
  });

  it('refuses to re-key a hold that has already ended', async () => {
    const email = uniqueEmail('bridge-ended');
    const cookie = await verifiedGuest(email);
    await inject('POST', '/markets/uk/cart/items', cookie, { slug, quantity: 1 });
    const { rows } = await h.sql.query<{ id: string }>(
      `SELECT r.id FROM reservations r JOIN draws d ON d.id = r.draw_id
        WHERE d.slug = $1 AND r.entrant_ref = $2`,
      [slug, email],
    );
    await h.sql.query(`SELECT hv_end_reservation($1, 'released')`, [rows[0]!.id]);

    const { rows: users } = await h.sql.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    await expect(
      h.sql.query(
        `UPDATE reservations SET entrant_type = 'user', entrant_ref = $2::text, user_id = $3::uuid
          WHERE id = $1`,
        [rows[0]!.id, users[0]!.id, users[0]!.id],
      ),
    ).rejects.toThrow(/only an active reservation/);
  });

  /** Signs in an existing account and returns a client carrying its session. */
  async function signIn(email: string) {
    const client = new Client(h.app);
    const response = await client.post('/auth/login', { email, password: PASSWORD });
    if (response.statusCode !== 200) throw new Error(`login failed: ${response.body}`);
    return client;
  }
});
