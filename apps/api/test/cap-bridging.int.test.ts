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
import { type Database, createDb, withTransaction } from '@hv/db';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import { CapBridgingRepository } from '../src/tickets/cap-bridging.repository';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUEST_SESSION_COOKIE } from '../src/auth/cookies';
import {
  Client,
  PASSWORD,
  type Harness,
  WEB_ORIGIN,
  randomIp,
  registeredClient,
  startHarness,
  uniqueEmail,
} from './support';

const KEY = 'a1'.repeat(16) + 'b2'.repeat(16);
const box = new SecretBox(KEY, 'k1');

describe('a guest who registers keeps the cap they already used', () => {
  let h: Harness;
  let db: Database;
  let slug: string;
  const CAP = 4;
  const bridging = new CapBridgingRepository();

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk']);
    db = createDb({ connectionString: h.database.url, applicationName: 'hv-test-bridge', max: 3 });
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
    await db?.destroy();
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

  /** This address's holds, as a comparable snapshot. */
  const reservationsFor = async (ref: string) => {
    const { rows } = await h.sql.query<{ id: string; entrant_type: string; status: string }>(
      `SELECT r.id, r.entrant_type, r.status FROM reservations r
         JOIN draws d ON d.id = r.draw_id
        WHERE d.slug = $1 AND r.entrant_ref = $2 ORDER BY r.id`,
      [slug, ref],
    );
    return rows;
  };

  /** How many account-keyed counters exist for this draw at all. */
  const userCounterCount = async () => {
    const { rows } = await h.sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM draw_entrant_counts dec
         JOIN draws d ON d.id = dec.draw_id
        WHERE d.slug = $1 AND dec.entrant_type = 'user'`,
      [slug],
    );
    return rows[0]!.n;
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

  /**
   * The merge arithmetic itself.
   *
   * Registration always bridges onto a BRAND-NEW user id, so its upsert never
   * finds a row to add to — the `ON CONFLICT … DO UPDATE` branch is
   * unreachable through the HTTP flow, and a test driven through it would be
   * testing the INSERT and calling it a merge. These two drive
   * `CapBridgingRepository.bridge` directly, against the same real database,
   * with both keys already holding counts: the only way the summing path is
   * actually exercised.
   */
  describe('merging onto an account that already holds tickets', () => {
    it('adds the address’s count to the account’s, and empties the address', async () => {
      const email = uniqueEmail('bridge-sum');
      const account = await registeredClient(h.app, uniqueEmail('bridge-sum-account'));
      const id = (await userId(account.email))!;

      // The account holds 1 of its own, through the real purchase path.
      await account.post('/markets/uk/cart/items', { slug, quantity: 1 });
      expect(await counters(id)).toEqual([{ entrant_type: 'user', count: 1 }]);

      // And the address holds 2, with a live hold behind them — the state a
      // guest purchase leaves before its owner registers.
      const guest = await verifiedGuest(email);
      await inject('POST', '/markets/uk/cart/items', guest, { slug, quantity: 2 });
      expect(await counters(email)).toEqual([{ entrant_type: 'email', count: 2 }]);

      await withTransaction(db, (trx) => bridging.bridge(trx, email, id));

      // 1 + 2, summed by the upsert rather than overwritten by it.
      expect(await counters(id)).toEqual([{ entrant_type: 'user', count: 3 }]);
      expect(await counters(email)).toEqual([{ entrant_type: 'email', count: 0 }]);

      // Nothing was lost on the way: both holds are still live, and the one
      // that moved is keyed to the account so its expiry still finds it.
      const { rows } = await h.sql.query<{ entrant_type: string; entrant_ref: string }>(
        `SELECT r.entrant_type, r.entrant_ref FROM reservations r
           JOIN draws d ON d.id = r.draw_id
          WHERE d.slug = $1 AND r.status = 'active' AND r.entrant_ref IN ($2, $3)
          ORDER BY r.created_at`,
        [slug, id, email],
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.entrant_type === 'user' && r.entrant_ref === id)).toBe(true);
    });

    it('refuses the next purchase once the merged count reaches the cap', async () => {
      const email = uniqueEmail('bridge-cap');
      const account = await registeredClient(h.app, uniqueEmail('bridge-cap-account'));
      const id = (await userId(account.email))!;

      // CAP is 4. Two under the account, two under the address: the merge
      // takes the entrant exactly to the cap.
      await account.post('/markets/uk/cart/items', { slug, quantity: 2 });
      const guest = await verifiedGuest(email);
      await inject('POST', '/markets/uk/cart/items', guest, { slug, quantity: 2 });

      await withTransaction(db, (trx) => bridging.bridge(trx, email, id));
      expect(await counters(id)).toEqual([{ entrant_type: 'user', count: CAP }]);

      // Asked again through a DIFFERENT basket that resolves to the same
      // entrant — a fresh guest session verifying the account's own address.
      // The account's own basket already holds this draw, and that duplicate
      // would be refused before the cap was ever consulted.
      const asAccount = await verifiedGuest(account.email);
      const again = await inject('POST', '/markets/uk/cart/items', asAccount, {
        slug,
        quantity: 1,
      });
      expect(again.statusCode).toBe(409);
      expect(again.body).toContain('TICKET_CAP_EXCEEDED');
    });

    it('cannot merge an entrant past the cap at all', async () => {
      // `hv_draw_entrant_counts_guard` (0009) refuses any count above
      // max_per_person, on the merge as on anything else. So a bridge that
      // WOULD take someone over the cap is rejected outright rather than
      // quietly creating an over-cap entrant.
      //
      // Registration can never hit this: it bridges onto a brand-new account,
      // so the merged count is just the address's own count, which was itself
      // capped when it was taken. It is reachable only by bridging onto an
      // account that already holds tickets, which is what this does.
      const email = uniqueEmail('bridge-overcap');
      const account = await registeredClient(h.app, uniqueEmail('bridge-overcap-account'));
      const id = (await userId(account.email))!;

      await account.post('/markets/uk/cart/items', { slug, quantity: 2 });
      const guest = await verifiedGuest(email);
      await inject('POST', '/markets/uk/cart/items', guest, { slug, quantity: 3 });

      await expect(withTransaction(db, (trx) => bridging.bridge(trx, email, id))).rejects.toThrow(
        /the cap is/,
      );

      // Refused means refused: both sides are exactly as they were.
      expect(await counters(id)).toEqual([{ entrant_type: 'user', count: 2 }]);
      expect(await counters(email)).toEqual([{ entrant_type: 'email', count: 3 }]);
      const held = await reservationsFor(email);
      expect(held).toHaveLength(1);
      expect(held[0]!.entrant_type).toBe('email');
    });
  });

  // ---- what happens when registration fails -------------------------------

  describe('a registration that fails after bridging', () => {
    /**
     * The failure is injected in the DATABASE, not in the application: a
     * trigger that refuses the session insert, which is the last thing
     * `register` does — after the user, after the bridge, after the audit
     * entry. Nothing in production knows this test exists, and the transaction
     * is the real one.
     */
    const failSessionInsert = async () => {
      await h.sql.query(`
        CREATE FUNCTION hv_test_refuse_session() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'test: registration fails after the bridge';
        END;
        $fn$;
        CREATE TRIGGER hv_test_refuse_session
          BEFORE INSERT ON sessions
          FOR EACH ROW EXECUTE FUNCTION hv_test_refuse_session();
      `);
    };
    const allowSessionInsert = async () => {
      await h.sql.query(`
        DROP TRIGGER IF EXISTS hv_test_refuse_session ON sessions;
        DROP FUNCTION IF EXISTS hv_test_refuse_session();
      `);
    };

    it('leaves the guest’s cap exactly as it was', async () => {
      const email = uniqueEmail('bridge-rollback');
      const cookie = await verifiedGuest(email);
      expect(
        (await inject('POST', '/markets/uk/cart/items', cookie, { slug, quantity: 2 })).statusCode,
      ).toBe(201);

      const before = {
        counters: await counters(email),
        reservations: await reservationsFor(email),
        users: await userCounterCount(),
      };
      expect(before.counters).toEqual([{ entrant_type: 'email', count: 2 }]);
      expect(before.reservations).toHaveLength(1);

      await failSessionInsert();
      try {
        const response = await register(email);
        expect(response.statusCode).toBe(500);
      } finally {
        await allowSessionInsert();
      }

      // No account: the user insert rolled back with everything else.
      expect(await userId(email)).toBeNull();
      // The address still holds its tickets, untouched and un-zeroed.
      expect(await counters(email)).toEqual(before.counters);
      // No user-keyed counter was created for this draw by the failed attempt.
      expect(await userCounterCount()).toBe(before.users);
      // And the hold is still the guest's, still active, still spendable.
      expect(await reservationsFor(email)).toEqual(before.reservations);
    });

    it('can still register and bridge afterwards', async () => {
      // The rollback left nothing behind, so the ordinary path still works.
      const email = uniqueEmail('bridge-rollback-retry');
      const cookie = await verifiedGuest(email);
      await inject('POST', '/markets/uk/cart/items', cookie, { slug, quantity: 1 });

      await failSessionInsert();
      try {
        expect((await register(email)).statusCode).toBe(500);
      } finally {
        await allowSessionInsert();
      }

      expect((await register(email)).statusCode).toBe(201);
      const id = (await userId(email))!;
      expect(await counters(id)).toEqual([{ entrant_type: 'user', count: 1 }]);
      expect(await counters(email)).toEqual([{ entrant_type: 'email', count: 0 }]);
    });
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
