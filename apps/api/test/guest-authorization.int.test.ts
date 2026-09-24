/**
 * The boundary a guest session must not cross (ADR-0029).
 *
 * A guest identifies a checkout. It is not authentication, and the danger in
 * adding a second identity to the request is that somewhere it gets mistaken
 * for the first. These tests come at that from the outside: a real guest
 * cookie, on real routes, against the real guard.
 */
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUEST_SESSION_COOKIE } from '../src/auth/cookies';
import { generateSessionToken, sha256 } from '../src/auth/tokens';
import { WEB_ORIGIN, type Harness, grantRole, registeredClient, startHarness } from './support';

describe('a guest session is not authentication', () => {
  let h: Harness;
  let guestCookie: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
    await enableMarketsForTesting(h.sql, ['uk']);
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: 'open',
      state: 'live',
      totalTickets: 50,
      maxPerPerson: 5,
    });
    // Inserted through the harness pool rather than a second one: the suite
    // runs close to PostgreSQL’s connection limit.
    const token = generateSessionToken();
    await h.sql.query(
      `INSERT INTO guest_sessions (token_hash, expires_at) VALUES ($1, now() + interval '1 day')`,
      [sha256(token)],
    );
    guestCookie = `${GUEST_SESSION_COOKIE}=${token}`;
  });

  afterAll(async () => {
    await h?.close();
  });

  const asGuest = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      // The allowed Origin, so a POST is refused for the reason under test
      // (no session) rather than by the origin check.
      headers: { cookie: guestCookie, origin: WEB_ORIGIN },
      ...(payload ? { payload } : {}),
    });

  describe('routes that require a signed-in customer refuse it', () => {
    it('refuses to list reservations', async () => {
      const response = await asGuest('GET', '/markets/uk/reservations');
      expect(response.statusCode).toBe(401);
    });

    it('refuses to reserve tickets', async () => {
      const response = await asGuest('POST', '/markets/uk/draws/open/reservations', {
        quantity: 1,
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses to read the account', async () => {
      const response = await asGuest('GET', '/auth/me');
      expect(response.statusCode).toBe(401);
    });
  });

  describe('admin routes refuse it', () => {
    it('refuses admin draws without a session', async () => {
      const response = await asGuest('GET', '/admin/markets/uk/draws');
      expect(response.statusCode).toBe(401);
    });

    it('refuses admin inventory', async () => {
      const { rows } = await h.sql.query<{ id: string }>(`SELECT id FROM draws LIMIT 1`);
      const response = await asGuest('GET', `/admin/markets/uk/draws/${rows[0]!.id}/inventory`);
      expect(response.statusCode).toBe(401);
    });
  });

  describe('it cannot be used as a session token', () => {
    it('is not accepted under the authenticated cookie name', async () => {
      // The same token, moved to hv_session: a guest token must be worthless
      // as a session token even if someone copies it across.
      const token = guestCookie.split('=')[1]!;
      const response = await h.app.inject({
        method: 'GET',
        url: '/markets/uk/reservations',
        headers: { cookie: `hv_session=${token}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('does not turn a customer route into a guest one when both cookies are sent', async () => {
      const response = await h.app.inject({
        method: 'GET',
        url: '/markets/uk/reservations',
        headers: { cookie: `${guestCookie}; hv_session=not-a-real-token` },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('a signed-in customer is unaffected', () => {
    it('still reaches its own routes while sending a guest cookie too', async () => {
      const customer = await registeredClient(h.app);
      // Both cookies together: the client would otherwise have its own
      // overwritten by the header, and this must test coexistence.
      const response = await customer.get('/markets/uk/reservations', {
        cookie: `hv_session=${customer.cookie}; ${guestCookie}`,
      });
      expect(response.statusCode).toBe(200);
    });

    it('still reaches admin routes with a permission', async () => {
      const staff = await registeredClient(h.app);
      await grantRole(h.sql, staff.email, 'support');
      const { rows } = await h.sql.query<{ id: string }>(`SELECT id FROM draws LIMIT 1`);
      const response = await staff.get(`/admin/markets/uk/draws/${rows[0]!.id}/inventory`, {
        cookie: `hv_session=${staff.cookie}; ${guestCookie}`,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('public routes still work, with or without a guest', () => {
    it('serves availability to a guest', async () => {
      const response = await asGuest('GET', '/markets/uk/draws/open/availability');
      expect(response.statusCode).toBe(200);
    });

    it('serves availability with a forged guest cookie, simply without a guest', async () => {
      const response = await h.app.inject({
        method: 'GET',
        url: '/markets/uk/draws/open/availability',
        headers: { cookie: `${GUEST_SESSION_COOKIE}=${generateSessionToken()}` },
      });
      expect(response.statusCode).toBe(200);
    });

    it('serves availability with a malformed guest cookie', async () => {
      const response = await h.app.inject({
        method: 'GET',
        url: '/markets/uk/draws/open/availability',
        headers: { cookie: `${GUEST_SESSION_COOKIE}=not-a-token'; DROP TABLE guest_sessions;--` },
      });
      expect(response.statusCode).toBe(200);
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guest_sessions`,
      );
      expect(rows[0]!.n).toBeGreaterThan(0);
    });
  });
});
