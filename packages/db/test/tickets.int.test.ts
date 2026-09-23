/**
 * Phase 4 ticket-engine invariants enforced by PostgreSQL (migration 0009):
 * the sequential pool, ticket states, reservations, caps and the shared
 * expiry functions. The allocation function itself (and Gates 1 and 2) is
 * tested with the API's TicketsRepository in apps/api/test.
 */
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pgTypes } from '../src/int8';
import {
  closeConnections,
  createBarrier,
  createTestDatabase,
  enableMarketsForTesting,
  insertFixtureDraw,
  insertFixtureUser,
  openConnections,
  type TestDatabase,
} from '../src/testing';

async function pgError(promise: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error('expected the statement to fail');
}

const HOUR = 60 * 60 * 1000;

describe('ticket engine (database layer)', () => {
  let database: TestDatabase;
  let client: pg.Client;

  beforeEach(async () => {
    database = await createTestDatabase();
    // Same safe int8 parsing as the application (bigint minor units as numbers).
    client = new pg.Client({ connectionString: database.url, types: pgTypes });
    await client.connect();
    await enableMarketsForTesting(client, ['uk', 'ie']);
  });

  afterEach(async () => {
    await client?.end();
    await database?.drop();
  });

  const tickets = async (drawId: string) =>
    (
      await client.query<{ ticket_number: number; status: string; reservation_id: string | null }>(
        `SELECT ticket_number, status, reservation_id FROM tickets WHERE draw_id = $1 ORDER BY ticket_number`,
        [drawId],
      )
    ).rows;

  /** Inserts an active reservation directly (bypassing the allocation function, for invariant tests). */
  const reservation = async (
    drawId: string,
    userId: string,
    quantity: number,
    ttl = '10 minutes',
  ) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO reservations (draw_id, market_id, currency, entrant_type, entrant_ref, user_id,
                                   quantity, unit_price_minor, total_minor, expires_at)
         SELECT d.id, d.market_id, d.currency, 'user', $2::text, $5::uuid, $3::int, d.ticket_price_minor,
                d.ticket_price_minor * $3::int, now() + $4::interval
           FROM draws d WHERE d.id = $1
         RETURNING id`,
        [drawId, userId, quantity, ttl, userId],
      )
    ).rows[0]!.id;

  const hold = (reservationId: string, drawId: string, numbers: number[]) =>
    client.query(
      `UPDATE tickets SET status = 'reserved', reservation_id = $1
        WHERE draw_id = $2 AND ticket_number = ANY($3::int[])`,
      [reservationId, drawId, numbers],
    );

  describe('sequential pool (ADR-0027)', () => {
    it('creates tickets 1..N, all available, when a draw is published', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'pool',
        state: 'draft',
        totalTickets: 25,
      });
      expect(await tickets(id)).toHaveLength(0); // drafts have no pool
      await client.query(
        `UPDATE draws SET status = 'scheduled', published_at = now() WHERE id = $1`,
        [id],
      );
      const pool = await tickets(id);
      expect(pool.map((t) => t.ticket_number)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(pool.every((t) => t.status === 'available' && t.reservation_id === null)).toBe(true);
    });

    it('numbers each draw from 1: numbers are unique per draw, not globally', async () => {
      const a = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'a',
        state: 'live',
        totalTickets: 3,
      });
      const b = await insertFixtureDraw(client, {
        market: 'ie',
        slug: 'b',
        state: 'live',
        totalTickets: 3,
      });
      expect((await tickets(a)).map((t) => t.ticket_number)).toEqual([1, 2, 3]);
      expect((await tickets(b)).map((t) => t.ticket_number)).toEqual([1, 2, 3]);
      const duplicate = await pgError(
        client.query(`INSERT INTO tickets (draw_id, ticket_number) VALUES ($1, 2)`, [a]),
      );
      expect(duplicate.constraint).toBe('tickets_draw_number_key');
    });

    it('never generates a second pool, and cancelled drafts get none', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'once',
        state: 'live',
        totalTickets: 4,
      });
      const { rows } = await client.query<{ n: number }>(
        `SELECT hv_generate_ticket_pool($1) AS n`,
        [id],
      );
      expect(rows[0]!.n).toBe(0);
      expect(await tickets(id)).toHaveLength(4);
      const cancelled = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'gone',
        state: 'cancelled',
      });
      expect(await tickets(cancelled)).toHaveLength(0);
    });

    it('refuses draws above the 1,000,000-ticket pool limit', async () => {
      const error = await pgError(
        client.query(
          `INSERT INTO draws (market_id, currency, slug, title, ticket_price_minor, total_tickets,
                              max_per_person, winner_positions, opens_at, closes_at)
           SELECT id, currency, 'huge', 'Huge', 100, 1000001, 10, 1, now(), now() + interval '1 day'
             FROM markets WHERE code = 'uk'`,
        ),
      );
      expect(error.constraint).toBe('draws_total_tickets_max');
    });

    it('only creates available tickets', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'x',
        state: 'draft',
        totalTickets: 5,
      });
      const error = await pgError(
        client.query(
          `INSERT INTO tickets (draw_id, ticket_number, status) VALUES ($1, 1, 'sold')`,
          [id],
        ),
      );
      expect(['tickets_created_available', 'tickets_holder_consistent']).toContain(
        error.constraint,
      );
    });
  });

  describe('ticket states', () => {
    it('moves available → reserved → sold, and reserved → available', async () => {
      const userId = await insertFixtureUser(client, 'states@example.com');
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 's',
        state: 'live',
        totalTickets: 5,
      });
      const r = await reservation(id, userId, 2);
      await hold(r, id, [1, 2]);
      await client.query(
        `UPDATE tickets SET status = 'available', reservation_id = NULL WHERE draw_id = $1 AND ticket_number = 1`,
        [id],
      );
      await client.query(
        `UPDATE tickets SET status = 'sold' WHERE draw_id = $1 AND ticket_number = 2`,
        [id],
      );
      expect((await tickets(id)).slice(0, 2).map((t) => t.status)).toEqual(['available', 'sold']);
    });

    it('never lets a sold ticket change (no sold → available here)', async () => {
      const userId = await insertFixtureUser(client, 'sold@example.com');
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 's',
        state: 'live',
        totalTickets: 5,
      });
      const r = await reservation(id, userId, 1);
      await hold(r, id, [1]);
      await client.query(
        `UPDATE tickets SET status = 'sold' WHERE draw_id = $1 AND ticket_number = 1`,
        [id],
      );
      for (const assignment of [
        "status = 'available', reservation_id = NULL",
        "status = 'reserved'",
      ]) {
        const error = await pgError(
          client.query(
            `UPDATE tickets SET ${assignment} WHERE draw_id = $1 AND ticket_number = 1`,
            [id],
          ),
        );
        expect(error.constraint, assignment).toBe('tickets_status_transition');
      }
    });

    it('refuses available → sold, and holding a ticket without a reservation', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 's',
        state: 'live',
        totalTickets: 5,
      });
      expect(
        (
          await pgError(
            client.query(
              `UPDATE tickets SET status = 'sold' WHERE draw_id = $1 AND ticket_number = 1`,
              [id],
            ),
          )
        ).constraint,
      ).toMatch(/tickets_(status_transition|holder_consistent)/);
      expect(
        (
          await pgError(
            client.query(
              `UPDATE tickets SET status = 'reserved' WHERE draw_id = $1 AND ticket_number = 1`,
              [id],
            ),
          )
        ).constraint,
      ).toMatch(/tickets_(holder_consistent|reservation_active)/);
    });

    it('only lets an active, unexpired reservation of the same draw hold a ticket', async () => {
      const userId = await insertFixtureUser(client, 'holder@example.com');
      const a = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'a',
        state: 'live',
        totalTickets: 5,
      });
      const b = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'b',
        state: 'live',
        totalTickets: 5,
      });
      const forB = await reservation(b, userId, 1);
      // Another draw's reservation: refused by the composite FK.
      expect((await pgError(hold(forB, a, [1]))).code).toBe('23503');
      // An ended reservation cannot take tickets.
      const ended = await reservation(a, userId, 1);
      await client.query(`SELECT hv_end_reservation($1, 'released')`, [ended]);
      expect((await pgError(hold(ended, a, [1]))).constraint).toBe('tickets_reservation_active');
      // A reserved ticket cannot be moved to another reservation directly.
      const first = await reservation(a, userId, 1);
      const second = await reservation(a, userId, 1);
      await hold(first, a, [2]);
      expect((await pgError(hold(second, a, [2]))).constraint).toBe('tickets_status_transition');
    });

    it('keeps a ticket’s draw and number immutable', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 's',
        state: 'live',
        totalTickets: 5,
      });
      expect(
        (
          await pgError(
            client.query(
              `UPDATE tickets SET ticket_number = 99 WHERE draw_id = $1 AND ticket_number = 1`,
              [id],
            ),
          )
        ).constraint,
      ).toBe('tickets_identity_immutable');
    });
  });

  describe('reservations', () => {
    it('stores the exact total in minor units and a lifetime of at most 10 minutes', async () => {
      const userId = await insertFixtureUser(client, 'r@example.com');
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 's',
        state: 'live',
        ticketPriceMinor: 299,
      });
      const r = await reservation(id, userId, 3);
      const { rows } = await client.query<{ total_minor: number; currency: string }>(
        `SELECT total_minor, currency FROM reservations WHERE id = $1`,
        [r],
      );
      expect(rows[0]).toEqual({ total_minor: 897, currency: 'GBP' });
      expect((await pgError(reservation(id, userId, 1, '11 minutes'))).constraint).toBe(
        'reservations_ttl_valid',
      );
      expect(
        (await pgError(client.query(`UPDATE reservations SET total_minor = 1 WHERE id = $1`, [r])))
          .code,
      ).toBe('23514');
    });

    it('only opens for an open draw in an enabled market', async () => {
      const userId = await insertFixtureUser(client, 'open@example.com');
      const upcoming = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'upcoming',
        state: 'scheduled',
        opensAt: new Date(Date.now() + HOUR),
        closesAt: new Date(Date.now() + 2 * HOUR),
      });
      const draft = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'draft',
        state: 'draft',
      });
      const cancelled = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'cancelled',
        state: 'cancelled',
      });
      for (const drawId of [upcoming, draft, cancelled]) {
        expect((await pgError(reservation(drawId, userId, 1))).constraint).toBe(
          'reservations_draw_open',
        );
      }
      const live = await insertFixtureDraw(client, { market: 'uk', slug: 'live', state: 'live' });
      await client.query(`UPDATE markets SET is_enabled = false WHERE code = 'uk'`);
      expect((await pgError(reservation(live, userId, 1))).constraint).toBe(
        'reservations_market_enabled',
      );
    });

    it('pins a reservation to its draw’s market and price', async () => {
      const userId = await insertFixtureUser(client, 'pin@example.com');
      const ukDraw = await insertFixtureDraw(client, { market: 'uk', slug: 'uk', state: 'live' });
      const crossMarket = await pgError(
        client.query(
          `INSERT INTO reservations (draw_id, market_id, currency, entrant_type, entrant_ref, user_id,
                                     quantity, unit_price_minor, total_minor, expires_at)
           SELECT $1, m.id, m.currency, 'user', $2::text, $3::uuid, 1, 250, 250, now() + interval '5 minutes'
             FROM markets m WHERE m.code = 'ie'`,
          [ukDraw, userId, userId],
        ),
      );
      expect(crossMarket.constraint).toBe('reservations_draw_market_fkey');
      const underpriced = await pgError(
        client.query(
          `INSERT INTO reservations (draw_id, market_id, currency, entrant_type, entrant_ref, user_id,
                                     quantity, unit_price_minor, total_minor, expires_at)
           SELECT d.id, d.market_id, d.currency, 'user', $2::text, $3::uuid, 1, 1, 1, now() + interval '5 minutes'
             FROM draws d WHERE d.id = $1`,
          [ukDraw, userId, userId],
        ),
      );
      expect(underpriced.constraint).toBe('reservations_price_snapshot');
    });

    it('ends exactly once and never restarts', async () => {
      const userId = await insertFixtureUser(client, 'end@example.com');
      const id = await insertFixtureDraw(client, { market: 'uk', slug: 's', state: 'live' });
      const r = await reservation(id, userId, 1);
      await client.query(`SELECT hv_end_reservation($1, 'released')`, [r]);
      const again = await pgError(
        client.query(`UPDATE reservations SET status = 'expired' WHERE id = $1`, [r]),
      );
      expect(again.constraint).toBe('reservations_status_transition');
      const reopen = await pgError(
        client.query(`UPDATE reservations SET status = 'active', ended_at = NULL WHERE id = $1`, [
          r,
        ]),
      );
      expect(reopen.constraint).toBe('reservations_status_transition');
    });

    it('keys guests by normalized email only', async () => {
      const id = await insertFixtureDraw(client, { market: 'uk', slug: 's', state: 'live' });
      const error = await pgError(
        client.query(
          `INSERT INTO reservations (draw_id, market_id, currency, entrant_type, entrant_ref,
                                     quantity, unit_price_minor, total_minor, expires_at)
           SELECT d.id, d.market_id, d.currency, 'email', 'Guest@Example.com', 1, 250, 250, now() + interval '5 minutes'
             FROM draws d WHERE d.id = $1`,
          [id],
        ),
      );
      expect(error.constraint).toBe('reservations_email_entrant_normalized');
    });
  });

  describe('per-entrant cap (database net)', () => {
    it('refuses a count above the draw’s cap, or below zero', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 's',
        state: 'live',
        maxPerPerson: 5,
      });
      const upsert = (count: number) =>
        client.query(
          `INSERT INTO draw_entrant_counts (draw_id, entrant_type, entrant_ref, count) VALUES ($1, 'email', 'a@b.c', $2)
           ON CONFLICT (draw_id, entrant_type, entrant_ref) DO UPDATE SET count = EXCLUDED.count`,
          [id, count],
        );
      await upsert(5);
      expect((await pgError(upsert(6))).constraint).toBe('draw_entrant_counts_cap');
      expect((await pgError(upsert(-1))).constraint).toBe('draw_entrant_counts_non_negative');
    });
  });

  describe('ending and expiring reservations', () => {
    async function heldReservation(
      drawId: string,
      userId: string,
      numbers: number[],
      ttl = '10 minutes',
    ) {
      const r = await reservation(drawId, userId, numbers.length, ttl);
      await hold(r, drawId, numbers);
      await client.query(
        `INSERT INTO draw_entrant_counts (draw_id, entrant_type, entrant_ref, count) VALUES ($1, 'user', $2, $3)
         ON CONFLICT (draw_id, entrant_type, entrant_ref) DO UPDATE SET count = draw_entrant_counts.count + EXCLUDED.count`,
        [drawId, userId, numbers.length],
      );
      return r;
    }
    const count = async (drawId: string, userId: string) =>
      (
        await client.query<{ count: number }>(
          `SELECT count FROM draw_entrant_counts WHERE draw_id = $1 AND entrant_ref = $2`,
          [drawId, userId],
        )
      ).rows[0]!.count;

    it('releases the tickets and the cap allowance exactly once', async () => {
      const userId = await insertFixtureUser(client, 'release@example.com');
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 's',
        state: 'live',
        totalTickets: 10,
      });
      const r = await heldReservation(id, userId, [1, 2, 3]);
      const first = await client.query<{ ended: boolean }>(
        `SELECT hv_end_reservation($1, 'released') AS ended`,
        [r],
      );
      const second = await client.query<{ ended: boolean }>(
        `SELECT hv_end_reservation($1, 'expired') AS ended`,
        [r],
      );
      expect([first.rows[0]!.ended, second.rows[0]!.ended]).toEqual([true, false]);
      expect((await tickets(id)).filter((t) => t.status !== 'available')).toEqual([]);
      expect(await count(id, userId)).toBe(0);
    });

    /**
     * NB-1 (migration 0010). The allowance given back is the number of ticket
     * rows the call actually moved back to 'available', not the reservation's
     * quantity. The two only differ once a ticket leaves 'reserved', which
     * nothing does before Phase 6 — so these tests set 'sold' by hand to prove
     * the invariant holds structurally rather than by luck.
     */
    describe('cap allowance follows the tickets actually freed (NB-1)', () => {
      it('returns allowance for freed tickets only, keeping sold ones counted', async () => {
        const userId = await insertFixtureUser(client, 'nb1-partial@example.com');
        const id = await insertFixtureDraw(client, {
          market: 'uk',
          slug: 's',
          state: 'live',
          totalTickets: 10,
          maxPerPerson: 5,
        });
        const r = await heldReservation(id, userId, [1, 2, 3]);
        // One of the three is sold; the reservation's quantity is still 3.
        await client.query(
          `UPDATE tickets SET status = 'sold' WHERE draw_id = $1 AND ticket_number = 1`,
          [id],
        );
        expect(await count(id, userId)).toBe(3);

        expect(
          (
            await client.query<{ ended: boolean }>(
              `SELECT hv_end_reservation($1, 'expired') AS ended`,
              [r],
            )
          ).rows[0]!.ended,
        ).toBe(true);

        // Two rows were freed, so two entries of allowance come back — not the
        // reservation's quantity of three. The sold ticket still counts.
        expect(await count(id, userId)).toBe(1);
        expect((await tickets(id)).slice(0, 3).map((t) => t.status)).toEqual([
          'sold',
          'available',
          'available',
        ]);
        // The sold ticket keeps its holder; only freed tickets lose it.
        expect((await tickets(id))[0]!.reservation_id).toBe(r);
      });

      it('returns no allowance at all when every ticket is already sold', async () => {
        const userId = await insertFixtureUser(client, 'nb1-allsold@example.com');
        const id = await insertFixtureDraw(client, {
          market: 'uk',
          slug: 's',
          state: 'live',
          totalTickets: 10,
          maxPerPerson: 5,
        });
        const r = await heldReservation(id, userId, [1, 2]);
        await client.query(
          `UPDATE tickets SET status = 'sold' WHERE draw_id = $1 AND ticket_number = ANY('{1,2}'::int[])`,
          [id],
        );

        expect(
          (
            await client.query<{ ended: boolean }>(
              `SELECT hv_end_reservation($1, 'released') AS ended`,
              [r],
            )
          ).rows[0]!.ended,
        ).toBe(true);

        // Before 0010 this decremented by the quantity (2) and handed the
        // entrant their whole cap back while they kept both sold tickets.
        expect(await count(id, userId)).toBe(2);
        expect((await tickets(id)).slice(0, 2).every((t) => t.status === 'sold')).toBe(true);
      });

      it('never drives the counter below zero when tickets were freed elsewhere', async () => {
        const userId = await insertFixtureUser(client, 'nb1-freed@example.com');
        const id = await insertFixtureDraw(client, {
          market: 'uk',
          slug: 's',
          state: 'live',
          totalTickets: 10,
        });
        const r = await heldReservation(id, userId, [1, 2]);
        // Both tickets released by hand: the reservation now holds nothing.
        await client.query(
          `UPDATE tickets SET status = 'available', reservation_id = NULL WHERE reservation_id = $1`,
          [r],
        );

        expect(
          (
            await client.query<{ ended: boolean }>(
              `SELECT hv_end_reservation($1, 'expired') AS ended`,
              [r],
            )
          ).rows[0]!.ended,
        ).toBe(true);
        // Nothing was freed by this call, so nothing is given back. Decrementing
        // by the quantity here would have hit draw_entrant_counts_non_negative.
        expect(await count(id, userId)).toBe(2);
      });

      it('is still idempotent: a second call frees nothing and returns no allowance', async () => {
        const userId = await insertFixtureUser(client, 'nb1-idempotent@example.com');
        const id = await insertFixtureDraw(client, {
          market: 'uk',
          slug: 's',
          state: 'live',
          totalTickets: 10,
        });
        const r = await heldReservation(id, userId, [1, 2, 3]);
        const first = await client.query<{ ended: boolean }>(
          `SELECT hv_end_reservation($1, 'released') AS ended`,
          [r],
        );
        const second = await client.query<{ ended: boolean }>(
          `SELECT hv_end_reservation($1, 'expired') AS ended`,
          [r],
        );
        expect([first.rows[0]!.ended, second.rows[0]!.ended]).toEqual([true, false]);
        expect(await count(id, userId)).toBe(0);
        expect((await tickets(id)).filter((t) => t.status !== 'available')).toEqual([]);
      });
    });

    it('expires only reservations past their expiry, and never touches sold tickets', async () => {
      const userId = await insertFixtureUser(client, 'expire@example.com');
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 's',
        state: 'live',
        totalTickets: 10,
      });
      const due = await heldReservation(id, userId, [1, 2], '1 second');
      const fresh = await heldReservation(id, userId, [3]);
      await client.query(
        `UPDATE tickets SET status = 'sold' WHERE draw_id = $1 AND ticket_number = 3`,
        [id],
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const { rows } = await client.query<{ n: number }>(
        `SELECT hv_expire_reservations(NULL, 100) AS n`,
      );
      expect(rows[0]!.n).toBe(1);
      const statuses = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM reservations WHERE draw_id = $1`,
        [id],
      );
      expect(Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]))).toEqual({
        [due]: 'expired',
        [fresh]: 'active',
      });
      expect((await tickets(id)).slice(0, 3).map((t) => t.status)).toEqual([
        'available',
        'available',
        'sold',
      ]);
      expect(await count(id, userId)).toBe(1);
      // Running again changes nothing.
      expect(
        (await client.query<{ n: number }>(`SELECT hv_expire_reservations(NULL, 100) AS n`))
          .rows[0]!.n,
      ).toBe(0);
    });

    it('expires each reservation once when many sweepers run at the same time', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 's',
        state: 'live',
        totalTickets: 200,
      });
      const users = await Promise.all(
        Array.from({ length: 20 }, (_, i) => insertFixtureUser(client, `sweep-${i}@example.com`)),
      );
      for (const [i, userId] of users.entries()) {
        await heldReservation(id, userId, [i * 3 + 1, i * 3 + 2, i * 3 + 3], '1 second');
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const connections = await openConnections(database.url, 6);
      try {
        const barrier = createBarrier(connections.length);
        const results = await Promise.all(
          connections.map(async (conn) => {
            await barrier();
            const { rows } = await conn.query<{ n: number }>(
              `SELECT hv_expire_reservations(NULL, 7) AS n`,
            );
            return rows[0]!.n;
          }),
        );
        // Whatever each sweeper got, the reservations were expired exactly once in total.
        const total = results.reduce((a, b) => a + b, 0);
        const rest = (
          await client.query<{ n: number }>(`SELECT hv_expire_reservations(NULL, 100) AS n`)
        ).rows[0]!.n;
        expect(total + rest).toBe(20);
      } finally {
        await closeConnections(connections);
      }
      expect((await tickets(id)).every((t) => t.status === 'available')).toBe(true);
      const counts = await client.query<{ total: number }>(
        `SELECT sum(count)::int AS total FROM draw_entrant_counts WHERE draw_id = $1`,
        [id],
      );
      expect(counts.rows[0]!.total).toBe(0);
    });
  });
});
