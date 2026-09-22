/**
 * Public market API and the three independent layers of the market gate
 * (ADR-0005): database state, the ENABLED_MARKETS kill switch, and the API
 * guard. Requests go straight to the API — the web UI is bypassed entirely.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ErrorResponseSchema, MarketListResponseSchema, MarketResponseSchema } from '@hv/contracts';
import {
  enableGermanyForTesting,
  enableMarketsForTesting,
  insertFixtureUser,
} from '@hv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp, startHarness } from './support';

const get = (app: NestFastifyApplication, url: string) => app.inject({ method: 'GET', url });

function expectMarketNotAvailable(response: Awaited<ReturnType<typeof get>>) {
  expect(response.statusCode).toBe(404);
  const body = ErrorResponseSchema.parse(response.json());
  expect(body.error.code).toBe('MARKET_NOT_AVAILABLE');
  expect(body.requestId).toBe(response.headers['x-request-id']);
}

describe('market API', () => {
  describe('fresh database: compliance values are OPEN (O12), so no market is enabled', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ ENABLED_MARKETS: 'uk,ie,de' });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('lists no available markets', async () => {
      const response = await get(h.app, '/markets');
      expect(response.statusCode).toBe(200);
      expect(MarketListResponseSchema.parse(response.json())).toEqual({ markets: [] });
    });

    it.each(['uk', 'ie', 'de'])(
      'refuses /markets/%s even though the environment allows it',
      async (code) => {
        expectMarketNotAvailable(await get(h.app, `/markets/${code}`));
      },
    );
  });

  describe('with UK and IE enabled in the database (test fixture values)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ ENABLED_MARKETS: 'uk,ie,de' });
      await enableMarketsForTesting(h.sql, ['uk', 'ie']);
    });
    afterAll(async () => {
      await h?.close();
    });

    it('lists UK and IE with their own currency and locale', async () => {
      const response = await get(h.app, '/markets');
      expect(MarketListResponseSchema.parse(response.json()).markets).toEqual([
        { code: 'ie', name: 'Ireland', currency: 'EUR', locale: 'en-IE' },
        { code: 'uk', name: 'United Kingdom', currency: 'GBP', locale: 'en-GB' },
      ]);
    });

    it.each([
      ['uk', 'GBP', 'en-GB'],
      ['ie', 'EUR', 'en-IE'],
    ])('serves /markets/%s', async (code, currency, locale) => {
      const response = await get(h.app, `/markets/${code}`);
      expect(response.statusCode).toBe(200);
      expect(MarketResponseSchema.parse(response.json()).market).toMatchObject({
        code,
        currency,
        locale,
      });
    });

    it('refuses Germany: disabled in the database, even though ENABLED_MARKETS lists it', async () => {
      expectMarketNotAvailable(await get(h.app, '/markets/de'));
    });

    it.each(['xx', 'fr', 'UK', 'u', 'ukk', 'u%20k', '..'])(
      'refuses the invalid market %j with the same 404',
      async (code) => {
        const response = await get(h.app, `/markets/${code}`);
        expect(response.statusCode).toBe(404);
        expect(ErrorResponseSchema.parse(response.json()).error.code).toMatch(
          /NOT_AVAILABLE|NOT_FOUND/,
        );
      },
    );

    it('takes market context from the route only: a query parameter cannot switch markets', async () => {
      const response = await get(h.app, '/markets/uk?market=ie');
      expect(response.statusCode).toBe(400);
      const body = ErrorResponseSchema.parse(response.json());
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(await get(h.app, '/markets?market=ie').then((r) => r.statusCode)).toBe(400);
    });

    it('reflects a gate change in the database immediately (no stale cache)', async () => {
      await h.sql.query(`UPDATE markets SET is_enabled = false WHERE code = 'ie'`);
      expectMarketNotAvailable(await get(h.app, '/markets/ie'));
      await h.sql.query(`UPDATE markets SET is_enabled = true WHERE code = 'ie'`);
      expect((await get(h.app, '/markets/ie')).statusCode).toBe(200);
    });
  });

  describe('ENABLED_MARKETS kill switch (layer 2)', () => {
    let h: Harness;
    beforeAll(async () => {
      // IE is enabled in the database but not listed by this API instance.
      h = await startHarness({ ENABLED_MARKETS: 'uk' });
      await enableMarketsForTesting(h.sql, ['uk', 'ie']);
    });
    afterAll(async () => {
      await h?.close();
    });

    it('refuses a market the environment does not list, whatever the database says', async () => {
      expectMarketNotAvailable(await get(h.app, '/markets/ie'));
      const markets = MarketListResponseSchema.parse((await get(h.app, '/markets')).json()).markets;
      expect(markets.map((m) => m.code)).toEqual(['uk']);
    });

    it('turns every market off with an empty list', async () => {
      const app = await startApp(h.database, { ENABLED_MARKETS: '' });
      try {
        expectMarketNotAvailable(await get(app, '/markets/uk'));
        expect(MarketListResponseSchema.parse((await get(app, '/markets')).json()).markets).toEqual(
          [],
        );
      } finally {
        await app.close();
      }
    });
  });

  describe('Germany with every layer open (proves the layers, not a real approval)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
      const approver = await insertFixtureUser(h.sql, 'fixture-approver@example.com');
      await enableGermanyForTesting(h.sql, approver);
    });
    afterAll(async () => {
      await h?.close();
    });

    it('still refuses DE while the environment does not list it', async () => {
      expectMarketNotAvailable(await get(h.app, '/markets/de'));
    });

    it('serves DE only when the database AND the environment allow it', async () => {
      const app = await startApp(h.database, { ENABLED_MARKETS: 'uk,ie,de' });
      try {
        const response = await get(app, '/markets/de');
        expect(response.statusCode).toBe(200);
        expect(MarketResponseSchema.parse(response.json()).market).toEqual({
          code: 'de',
          name: 'Germany',
          currency: 'EUR',
          locale: 'de-DE',
        });
      } finally {
        await app.close();
      }
    });
  });
});
