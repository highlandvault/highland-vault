/**
 * Reservation API against real PostgreSQL and Redis: the customer entry flow,
 * every refusal, ownership, market isolation, expiry, release, availability
 * and the admin inventory view.
 */
import {
  AvailabilityResponseSchema,
  ErrorResponseSchema,
  InventoryResponseSchema,
  ReservationListResponseSchema,
  ReservationResponseSchema,
} from '@hv/contracts';
import {
  enableGermanyForTesting,
  enableMarketsForTesting,
  insertFixtureDraw,
  insertFixtureUser,
} from '@hv/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Client,
  type Harness,
  grantRole,
  registeredClient,
  startApp,
  startHarness,
} from './support';

const HOUR = 60 * 60 * 1000;
const errorCode = (response: { json: () => unknown }) =>
  ErrorResponseSchema.parse(response.json()).error.code;
const reservationOf = (response: { json: () => unknown }) =>
  ReservationResponseSchema.parse(response.json()).reservation;

/**
 * Reads availability until it satisfies `done`, or until the deadline passes.
 * Expiry here is a matter of wall-clock time crossing `expires_at` plus the
 * 3-second display cache rolling over, so a fixed sleep is a race on a loaded
 * machine. On timeout it returns the last reading, and the caller's assertion
 * reports it — a genuinely stuck value still fails the test.
 */
const pollAvailability = async (
  client: Client,
  slug: string,
  done: (availability: { available: number; total: number }) => boolean,
  timeoutMs = 15_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let last = AvailabilityResponseSchema.parse(
    (await client.get(`/markets/uk/draws/${slug}/availability`)).json(),
  );
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = AvailabilityResponseSchema.parse(
      (await client.get(`/markets/uk/draws/${slug}/availability`)).json(),
    );
  }
  return last;
};

describe('reservations API', () => {
  let h: Harness;
  let alice: Client & { email: string };
  let bob: Client & { email: string };

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);
    alice = await registeredClient(h.app);
    bob = await registeredClient(h.app);
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: 'open',
      state: 'live',
      totalTickets: 500,
      maxPerPerson: 5,
      ticketPriceMinor: 299,
    });
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: 'tiny',
      state: 'live',
      totalTickets: 5,
      maxPerPerson: 5,
    });
    await insertFixtureDraw(h.sql, {
      market: 'ie',
      slug: 'irish',
      state: 'live',
      totalTickets: 50,
      maxPerPerson: 5,
    });
    await insertFixtureDraw(h.sql, { market: 'uk', slug: 'draft', state: 'draft' });
    await insertFixtureDraw(h.sql, { market: 'uk', slug: 'cancelled', state: 'cancelled' });
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: 'upcoming',
      state: 'scheduled',
      opensAt: new Date(Date.now() + HOUR),
      closesAt: new Date(Date.now() + 2 * HOUR),
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('reserving', () => {
    it('reserves the lowest sequential numbers with the exact total and a 10-minute expiry', async () => {
      const before = Date.now();
      const response = await alice.post('/markets/uk/draws/open/reservations', { quantity: 3 });
      expect(response.statusCode).toBe(201);
      const r = reservationOf(response);
      expect(r).toMatchObject({
        market: 'uk',
        status: 'active',
        quantity: 3,
        ticketNumbers: [1, 2, 3],
        currency: 'GBP',
        unitPriceMinor: 299,
        totalMinor: 897,
        draw: { slug: 'open', totalTickets: 500 },
      });
      const ttl = new Date(r.expiresAt).getTime() - before;
      expect(ttl).toBeGreaterThan(9.5 * 60_000);
      expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 5_000);
      // Only customer-facing identity: no internal ticket ids anywhere.
      expect(response.body).not.toMatch(/"(ticketId|ticket_id|reservation_id|entrant)/);

      const next = reservationOf(
        await bob.post('/markets/uk/draws/open/reservations', { quantity: 2 }),
      );
      expect(next.ticketNumbers).toEqual([4, 5]);
    });

    it('shows the owner their reservation, and lists their active ones', async () => {
      const r = reservationOf(
        await alice.post('/markets/uk/draws/open/reservations', { quantity: 1 }),
      );
      const fetched = reservationOf(await alice.get(`/markets/uk/reservations/${r.id}`));
      expect(fetched).toMatchObject({ id: r.id, status: 'active', ticketNumbers: r.ticketNumbers });
      expect(new Date(fetched.serverTime).getTime()).toBeGreaterThan(0);
      const list = ReservationListResponseSchema.parse(
        (await alice.get('/markets/uk/reservations')).json(),
      );
      expect(list.reservations.map((x) => x.id)).toContain(r.id);
    });

    it('requires a signed-in customer', async () => {
      const response = await h.app.inject({
        method: 'POST',
        url: '/markets/uk/draws/open/reservations',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: { quantity: 1 },
      });
      expect(response.statusCode).toBe(401);
    });

    it.each([0, -1, 1.5, 6, 'three'])('rejects the quantity %j', async (quantity) => {
      const response = await alice.post('/markets/uk/draws/tiny/reservations', { quantity });
      expect(response.statusCode).toBe(400);
      expect(['VALIDATION_FAILED', 'INVALID_QUANTITY']).toContain(errorCode(response));
    });

    it('refuses more than the per-person cap, saying how many are left', async () => {
      const carol = await registeredClient(h.app);
      expect(
        (await carol.post('/markets/uk/draws/open/reservations', { quantity: 4 })).statusCode,
      ).toBe(201);
      const response = await carol.post('/markets/uk/draws/open/reservations', { quantity: 2 });
      expect(response.statusCode).toBe(409);
      const body = ErrorResponseSchema.parse(response.json());
      expect(body.error.code).toBe('TICKET_CAP_EXCEEDED');
      expect(body.error.details).toMatchObject({ held: 4, maxPerPerson: 5, allowance: 1 });
    });

    it('refuses when not enough tickets remain — never partially', async () => {
      const dave = await registeredClient(h.app);
      const erin = await registeredClient(h.app);
      expect(
        (await dave.post('/markets/uk/draws/tiny/reservations', { quantity: 3 })).statusCode,
      ).toBe(201);
      const response = await erin.post('/markets/uk/draws/tiny/reservations', { quantity: 3 });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('INSUFFICIENT_TICKETS');
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tickets t JOIN draws d ON d.id = t.draw_id WHERE d.slug = 'tiny' AND t.status = 'available'`,
      );
      expect(rows[0]!.n).toBe(2);
    });

    it.each([
      ['a draft', 'draft', 404, 'NOT_FOUND'],
      ['a cancelled draw', 'cancelled', 404, 'NOT_FOUND'],
      ['an unknown draw', 'nothing', 404, 'NOT_FOUND'],
      ['a scheduled draw that has not opened', 'upcoming', 409, 'DRAW_NOT_OPEN'],
    ])('refuses %s', async (_label, slug, status, code) => {
      const response = await alice.post(`/markets/uk/draws/${slug}/reservations`, { quantity: 1 });
      expect(response.statusCode).toBe(status);
      expect(errorCode(response)).toBe(code);
    });

    it('refuses a draw that has closed', async () => {
      await insertFixtureDraw(h.sql, {
        market: 'uk',
        slug: 'closing',
        state: 'live',
        closesAt: new Date(Date.now() + 1200),
      });
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const response = await alice.post('/markets/uk/draws/closing/reservations', { quantity: 1 });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('DRAW_NOT_OPEN');
    });
  });

  describe('market isolation', () => {
    it('never reserves another market’s draw', async () => {
      const response = await alice.post('/markets/ie/draws/open/reservations', { quantity: 1 });
      expect(response.statusCode).toBe(404);
      const irish = reservationOf(
        await alice.post('/markets/ie/draws/irish/reservations', { quantity: 1 }),
      );
      expect(irish).toMatchObject({ market: 'ie', currency: 'EUR' });
      // A reservation is only reachable through its own market.
      expect((await alice.get(`/markets/uk/reservations/${irish.id}`)).statusCode).toBe(404);
      expect((await alice.post(`/markets/uk/reservations/${irish.id}/release`)).statusCode).toBe(
        404,
      );
    });

    it('refuses Germany while it is disabled, and markets the environment excludes', async () => {
      const approver = await insertFixtureUser(h.sql, 'de-approver@example.com');
      await insertFixtureDraw(h.sql, { market: 'de', slug: 'german', state: 'draft' });
      await enableGermanyForTesting(h.sql, approver);
      await h.sql.query(
        `UPDATE draws SET status = 'scheduled', published_at = now() WHERE slug = 'german'`,
      );
      // DE is now enabled in the database, but this API instance does not list it.
      const response = await alice.post('/markets/de/draws/german/reservations', { quantity: 1 });
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('MARKET_NOT_AVAILABLE');

      const ukOnly = await startApp(h.database, { ENABLED_MARKETS: 'uk' });
      try {
        const excluded = await ukOnly.inject({
          method: 'POST',
          url: '/markets/ie/draws/irish/reservations',
          headers: { origin: 'http://127.0.0.1:3000', cookie: `hv_session=${alice.cookie}` },
          payload: { quantity: 1 },
        });
        expect(excluded.statusCode).toBe(404);
        expect(errorCode(excluded)).toBe('MARKET_NOT_AVAILABLE');
      } finally {
        await ukOnly.close();
      }
    });
  });

  describe('ownership and release', () => {
    it('hides a reservation from other customers and never lets them release it', async () => {
      const r = reservationOf(
        await alice.post('/markets/uk/draws/open/reservations', { quantity: 1 }),
      );
      expect((await bob.get(`/markets/uk/reservations/${r.id}`)).statusCode).toBe(404);
      expect((await bob.post(`/markets/uk/reservations/${r.id}/release`)).statusCode).toBe(404);
      expect(reservationOf(await alice.get(`/markets/uk/reservations/${r.id}`)).status).toBe(
        'active',
      );
    });

    it('releases tickets back to the pool, idempotently', async () => {
      const frank = await registeredClient(h.app);
      const r = reservationOf(
        await frank.post('/markets/uk/draws/open/reservations', { quantity: 5 }),
      );
      const released = reservationOf(await frank.post(`/markets/uk/reservations/${r.id}/release`));
      expect(released).toMatchObject({ status: 'released', ticketNumbers: [] });
      expect(released.endedAt).not.toBeNull();
      const again = await frank.post(`/markets/uk/reservations/${r.id}/release`);
      expect(again.statusCode).toBe(200);
      expect(reservationOf(again).status).toBe('released');
      // The allowance is back: the full cap can be reserved again.
      expect(
        (await frank.post('/markets/uk/draws/open/reservations', { quantity: 5 })).statusCode,
      ).toBe(201);
      // The released numbers went back to the pool.
      const { rows } = await h.sql.query<{ status: string }>(
        `SELECT t.status FROM tickets t JOIN draws d ON d.id = t.draw_id
          WHERE d.slug = 'open' AND t.ticket_number = ANY($1::int[])`,
        [r.ticketNumbers],
      );
      expect(rows.every((t) => t.status === 'available' || t.status === 'reserved')).toBe(true);
    });

    it('rejects malformed reservation ids', async () => {
      expect((await alice.get('/markets/uk/reservations/not-a-uuid')).statusCode).toBe(400);
    });
  });

  describe('expiry', () => {
    let shortLived: NestFastifyApplication;
    let mediumLived: NestFastifyApplication;

    beforeAll(async () => {
      // Same database; reservations on this instance last 2 seconds.
      shortLived = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        RESERVATION_TTL_SECONDS: '2',
      });
      // For tests that must act on a reservation before it lapses.
      mediumLived = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        RESERVATION_TTL_SECONDS: '6',
      });
    });

    afterAll(async () => {
      await shortLived?.close();
      await mediumLived?.close();
    });

    it('reports an expired reservation as expired, frees it, and the tickets can be taken again', async () => {
      const grace = await registeredClient(shortLived);
      const r = reservationOf(
        await grace.post('/markets/uk/draws/tiny/reservations', { quantity: 2 }),
      );
      expect(r.status).toBe('active');
      await new Promise((resolve) => setTimeout(resolve, 2300));

      // Before any sweep: the API already reports it as expired, without tickets.
      const seen = reservationOf(await grace.get(`/markets/uk/reservations/${r.id}`));
      expect(seen).toMatchObject({ status: 'expired', ticketNumbers: [] });

      // Releasing it now records it as expired (not released) and frees the tickets.
      const ended = reservationOf(await grace.post(`/markets/uk/reservations/${r.id}/release`));
      expect(ended.status).toBe('expired');
      const { rows } = await h.sql.query<{ status: string }>(
        `SELECT status FROM reservations WHERE id = $1`,
        [r.id],
      );
      expect(rows[0]!.status).toBe('expired');
    });

    it('counts a run-out reservation as expired in availability and inventory before any sweep', async () => {
      const judy = await registeredClient(shortLived);
      const staff = await registeredClient(h.app);
      await grantRole(h.sql, staff.email, 'support');
      const drawId = await insertFixtureDraw(h.sql, {
        market: 'uk',
        slug: 'overdue',
        state: 'live',
        totalTickets: 10,
        maxPerPerson: 4,
      });
      reservationOf(await judy.post('/markets/uk/draws/overdue/reservations', { quantity: 3 }));
      const during = AvailabilityResponseSchema.parse(
        (await judy.get('/markets/uk/draws/overdue/availability')).json(),
      );
      expect(during).toEqual({ available: 7, total: 10, allowance: 1 });

      // Wait out the 2-second lifetime and the 3-second display cache. The read
      // above refilled that cache, so poll rather than sleep a fixed margin: on
      // a loaded machine a single sleep can still land inside the cache window
      // and read the stale count. No sweep runs in the meantime.
      const after = await pollAvailability(judy, 'overdue', (a) => a.available === 10);
      expect(after).toEqual({ available: 10, total: 10, allowance: 4 });
      const { inventory } = InventoryResponseSchema.parse(
        (await staff.get(`/admin/markets/uk/draws/${drawId}/inventory`)).json(),
      );
      expect(inventory).toMatchObject({
        available: 10,
        reserved: 0,
        reservations: { active: 0, expired: 1 },
      });
      // Nothing was written: the rows still wait for the sweep.
      const { rows } = await h.sql.query<{ status: string }>(
        `SELECT status FROM reservations WHERE draw_id = $1`,
        [drawId],
      );
      expect(rows.map((r) => r.status)).toEqual(['active']);
    });

    it('frees expired reservations of a draw on the way into a new reservation', async () => {
      // This test has to observe the reservation while it is still active (the
      // refusal) and then after it lapses, so the lifetime has to outlast two
      // requests. Six seconds leaves room on a loaded machine; two did not.
      const heidi = await registeredClient(mediumLived);
      const ivan = await registeredClient(mediumLived);
      await insertFixtureDraw(h.sql, {
        market: 'uk',
        slug: 'sweep-inline',
        state: 'live',
        totalTickets: 3,
        maxPerPerson: 3,
      });
      const first = reservationOf(
        await heidi.post('/markets/uk/draws/sweep-inline/reservations', { quantity: 3 }),
      );
      expect(first.ticketNumbers).toEqual([1, 2, 3]);
      expect(
        errorCode(await ivan.post('/markets/uk/draws/sweep-inline/reservations', { quantity: 1 })),
      ).toBe('INSUFFICIENT_TICKETS');
      const lapsed = new Date(first.expiresAt).getTime() - Date.now() + 300;
      await new Promise((resolve) => setTimeout(resolve, Math.max(lapsed, 0)));
      const second = reservationOf(
        await ivan.post('/markets/uk/draws/sweep-inline/reservations', { quantity: 1 }),
      );
      expect(second.ticketNumbers).toEqual([1]);
      expect(reservationOf(await heidi.get(`/markets/uk/reservations/${first.id}`)).status).toBe(
        'expired',
      );
    });
  });

  describe('availability', () => {
    it('is public, exact, and knows a signed-in caller’s remaining allowance', async () => {
      await insertFixtureDraw(h.sql, {
        market: 'uk',
        slug: 'counted',
        state: 'live',
        totalTickets: 40,
        maxPerPerson: 6,
      });
      const anonymous = AvailabilityResponseSchema.parse(
        (
          await h.app.inject({ method: 'GET', url: '/markets/uk/draws/counted/availability' })
        ).json(),
      );
      expect(anonymous).toEqual({ available: 40, total: 40, allowance: null });

      await alice.post('/markets/uk/draws/counted/reservations', { quantity: 4 });
      const mine = AvailabilityResponseSchema.parse(
        (await alice.get('/markets/uk/draws/counted/availability')).json(),
      );
      expect(mine).toEqual({ available: 36, total: 40, allowance: 2 });
    });

    it('follows the market gate and publication rules', async () => {
      expect(
        (await h.app.inject({ method: 'GET', url: '/markets/uk/draws/draft/availability' }))
          .statusCode,
      ).toBe(404);
      expect(
        (await h.app.inject({ method: 'GET', url: '/markets/de/draws/german/availability' }))
          .statusCode,
      ).toBe(404);
    });
  });

  describe('admin inventory', () => {
    it('shows staff the ticket and reservation counts, read-only', async () => {
      const staff = await registeredClient(h.app);
      await grantRole(h.sql, staff.email, 'support');
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT id FROM draws WHERE slug = 'tiny'`,
      );
      const response = await staff.get(`/admin/markets/uk/draws/${rows[0]!.id}/inventory`);
      expect(response.statusCode).toBe(200);
      const { inventory } = InventoryResponseSchema.parse(response.json());
      expect(inventory.total).toBe(5);
      expect(inventory.available + inventory.reserved + inventory.sold).toBe(5);
      expect(inventory.reservations.active).toBeGreaterThanOrEqual(1);
      // Customers cannot see it, and it cannot be reached through another market.
      expect(errorCode(await alice.get(`/admin/markets/uk/draws/${rows[0]!.id}/inventory`))).toBe(
        'FORBIDDEN',
      );
      expect((await staff.get(`/admin/markets/ie/draws/${rows[0]!.id}/inventory`)).statusCode).toBe(
        404,
      );
    });
  });
});
