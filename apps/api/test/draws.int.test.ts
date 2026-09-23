/**
 * Draw API against real PostgreSQL and Redis: customer listing/detail (market
 * gate, publication, isolation, no answer leak) and staff management (RBAC,
 * validation, lifecycle, audit).
 */
import {
  AdminDrawResponseSchema,
  DrawListResponseSchema,
  DrawResponseSchema,
  ErrorResponseSchema,
} from '@hv/contracts';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
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
const get = (app: NestFastifyApplication, url: string) => app.inject({ method: 'GET', url });

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'weekend-getaway',
    title: 'Weekend getaway',
    description: 'Two nights away (test data).',
    ticketPriceMinor: 199,
    totalTickets: 500,
    maxPerPerson: 20,
    winnerPositions: 2,
    opensAt: new Date(Date.now() - HOUR).toISOString(),
    closesAt: new Date(Date.now() + 48 * HOUR).toISOString(),
    ...overrides,
  };
}

const QUESTION = {
  prompt: 'Which city is the capital of Scotland?',
  options: [
    { label: 'Glasgow', isCorrect: false },
    { label: 'Edinburgh', isCorrect: true },
    { label: 'Aberdeen', isCorrect: false },
  ],
};
const PRIZES = {
  prizes: [
    { position: 1, title: 'Two-night stay', description: 'For two.' },
    { position: 2, title: 'Dinner voucher', description: '' },
  ],
};

describe('draws API', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let support: Client & { email: string };
  let customer: Client & { email: string };

  beforeAll(async () => {
    // DE is listed on purpose: the database gate alone must keep it closed.
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie,de' });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);
    admin = await registeredClient(h.app);
    await grantRole(h.sql, admin.email, 'admin');
    support = await registeredClient(h.app);
    await grantRole(h.sql, support.email, 'support');
    customer = await registeredClient(h.app);

    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: 'uk-live',
      state: 'live',
      prizes: ['Car', 'Bike'],
    });
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: 'uk-upcoming',
      state: 'scheduled',
      opensAt: new Date(Date.now() + 24 * HOUR),
      closesAt: new Date(Date.now() + 72 * HOUR),
    });
    // Published, opening time already passed, sweeper not yet run: customers see it as live.
    await insertFixtureDraw(h.sql, { market: 'uk', slug: 'uk-opened', state: 'scheduled' });
    await insertFixtureDraw(h.sql, { market: 'uk', slug: 'uk-draft', state: 'draft' });
    await insertFixtureDraw(h.sql, { market: 'uk', slug: 'uk-cancelled', state: 'cancelled' });
    await insertFixtureDraw(h.sql, { market: 'ie', slug: 'ie-live', state: 'live' });
    await insertFixtureDraw(h.sql, { market: 'de', slug: 'de-live', state: 'live' });
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('customer listing', () => {
    it('lists only published open/upcoming draws of the market, open ones first', async () => {
      const response = await get(h.app, '/markets/uk/draws');
      expect(response.statusCode).toBe(200);
      const draws = DrawListResponseSchema.parse(response.json()).draws;
      expect(draws.map((d) => [d.slug, d.status])).toEqual([
        ['uk-live', 'live'],
        ['uk-opened', 'live'],
        ['uk-upcoming', 'scheduled'],
      ]);
      expect(draws[0]).toMatchObject({
        currency: 'GBP',
        ticketPriceMinor: 250,
        headlinePrize: 'Car',
      });
    });

    it('never mixes markets', async () => {
      const ie = DrawListResponseSchema.parse((await get(h.app, '/markets/ie/draws')).json()).draws;
      expect(ie.map((d) => d.slug)).toEqual(['ie-live']);
      expect(ie[0]!.currency).toBe('EUR');
    });

    it('refuses Germany while it is disabled, although a DE draw is published', async () => {
      const response = await get(h.app, '/markets/de/draws');
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('MARKET_NOT_AVAILABLE');
      expect(errorCode(await get(h.app, '/markets/de/draws/de-live'))).toBe('MARKET_NOT_AVAILABLE');
    });

    it('refuses a market excluded by ENABLED_MARKETS even when enabled in the database', async () => {
      const app = await startApp(h.database, { ENABLED_MARKETS: 'uk' });
      try {
        expect(errorCode(await get(app, '/markets/ie/draws'))).toBe('MARKET_NOT_AVAILABLE');
      } finally {
        await app.close();
      }
    });

    it('rejects query parameters (market context comes from the route only)', async () => {
      expect((await get(h.app, '/markets/uk/draws?market=ie')).statusCode).toBe(400);
    });
  });

  describe('customer detail', () => {
    it('shows a published draw with prizes and the skill question — but never the answer', async () => {
      const response = await get(h.app, '/markets/uk/draws/uk-live');
      expect(response.statusCode).toBe(200);
      const draw = DrawResponseSchema.parse(response.json()).draw;
      expect(draw.prizes.map((p) => [p.position, p.title])).toEqual([
        [1, 'Car'],
        [2, 'Bike'],
      ]);
      expect(draw.skillQuestion.options.map((o) => o.label)).toEqual(['4', '5', '6']);
      expect(response.body).not.toMatch(/correct/i);
    });

    it.each([
      ['a draft', '/markets/uk/draws/uk-draft'],
      ['a cancelled draw', '/markets/uk/draws/uk-cancelled'],
      ['another market’s draw', '/markets/uk/draws/ie-live'],
      ['an unknown slug', '/markets/uk/draws/nothing-here'],
      ['a malformed slug', '/markets/uk/draws/Bad_Slug'],
    ])('answers 404 for %s', async (_label, url) => {
      const response = await get(h.app, url);
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
      expect(response.headers['x-request-id']).toBeTruthy();
    });
  });

  describe('staff access', () => {
    it('requires a session and a staff permission', async () => {
      expect((await get(h.app, '/admin/markets/uk/draws')).statusCode).toBe(401);
      expect(errorCode(await customer.get('/admin/markets/uk/draws'))).toBe('FORBIDDEN');
      expect(errorCode(await customer.post('/admin/markets/uk/draws', draftBody()))).toBe(
        'FORBIDDEN',
      );
    });

    it('lets support read drafts but not create or change draws', async () => {
      const list = await support.get('/admin/markets/uk/draws');
      expect(list.statusCode).toBe(200);
      expect(list.json<{ draws: { slug: string }[] }>().draws.map((d) => d.slug)).toContain(
        'uk-draft',
      );
      expect(
        errorCode(await support.post('/admin/markets/uk/draws', draftBody({ slug: 'nope' }))),
      ).toBe('FORBIDDEN');
    });

    it('lets a market-scoped admin manage only that market', async () => {
      const ukAdmin = await registeredClient(h.app);
      await grantRole(h.sql, ukAdmin.email, 'admin', 'uk');
      expect(
        (await ukAdmin.post('/admin/markets/uk/draws', draftBody({ slug: 'scoped-uk' })))
          .statusCode,
      ).toBe(201);
      expect(
        errorCode(await ukAdmin.post('/admin/markets/ie/draws', draftBody({ slug: 'scoped-ie' }))),
      ).toBe('FORBIDDEN');
      expect(errorCode(await ukAdmin.get('/admin/markets/ie/draws'))).toBe('FORBIDDEN');
    });

    it('never reaches another market’s draw through a market path', async () => {
      const ieDraw = (
        await h.sql.query<{ id: string }>(`SELECT id FROM draws WHERE slug = 'ie-live'`)
      ).rows[0]!.id;
      expect((await admin.get(`/admin/markets/ie/draws/${ieDraw}`)).statusCode).toBe(200);
      const crossed = await admin.get(`/admin/markets/uk/draws/${ieDraw}`);
      expect(crossed.statusCode).toBe(404);
      expect(
        (await admin.put(`/admin/markets/uk/draws/${ieDraw}`, draftBody({ slug: 'hijack' })))
          .statusCode,
      ).toBe(404);
    });

    it('rejects malformed draw ids (400) and unknown markets (404)', async () => {
      expect((await admin.get('/admin/markets/uk/draws/not-a-uuid')).statusCode).toBe(400);
      expect((await admin.get('/admin/markets/xx/draws')).statusCode).toBe(404);
    });
  });

  describe('managing a draw through its lifecycle', () => {
    let id: string;
    const path = () => `/admin/markets/uk/draws/${id}`;

    it('creates a draft with the market’s currency, audited', async () => {
      const response = await admin.post('/admin/markets/uk/draws', draftBody());
      expect(response.statusCode).toBe(201);
      const draw = AdminDrawResponseSchema.parse(response.json()).draw;
      id = draw.id;
      expect(draw).toMatchObject({
        market: 'uk',
        currency: 'GBP',
        status: 'draft',
        publishBlockers: ['skill_question_missing', 'prizes_incomplete'],
      });
      const audit = await h.sql.query<{ actor_user_id: string | null; action: string }>(
        `SELECT actor_user_id, action FROM audit_log WHERE entity_id = $1`,
        [id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['draw.created']);
      expect(audit.rows[0]!.actor_user_id).toBeTruthy();
    });

    it.each([
      ['a zero price', { ticketPriceMinor: 0 }],
      ['a fractional price', { ticketPriceMinor: 1.5 }],
      ['a cap above capacity', { totalTickets: 10, maxPerPerson: 11 }],
      ['more winners than tickets', { totalTickets: 1, maxPerPerson: 1, winnerPositions: 2 }],
      ['closing before opening', { closesAt: new Date(Date.now() - 2 * HOUR).toISOString() }],
      ['a malformed slug', { slug: 'Weekend Getaway' }],
      ['an unknown field', { currency: 'EUR' }],
    ])('rejects %s with VALIDATION_FAILED', async (_label, overrides) => {
      const response = await admin.post(
        '/admin/markets/uk/draws',
        draftBody({ slug: 'invalid-draw', ...overrides }),
      );
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_FAILED');
    });

    it('rejects a duplicate slug in the same market but allows it in another', async () => {
      const duplicate = await admin.post('/admin/markets/uk/draws', draftBody());
      expect(duplicate.statusCode).toBe(409);
      expect(errorCode(duplicate)).toBe('DRAW_SLUG_TAKEN');
      expect((await admin.post('/admin/markets/ie/draws', draftBody())).statusCode).toBe(201);
    });

    it('refuses to publish an incomplete draft and says why', async () => {
      const response = await admin.post(`${path()}/publish`, {});
      expect(response.statusCode).toBe(409);
      const body = ErrorResponseSchema.parse(response.json());
      expect(body.error.code).toBe('DRAW_NOT_PUBLISHABLE');
      expect(body.error.details).toEqual({
        blockers: ['skill_question_missing', 'prizes_incomplete'],
      });
    });

    it('validates prizes against the winner positions', async () => {
      for (const prizes of [
        [{ position: 3, title: 'Out of range' }],
        [
          { position: 1, title: 'A' },
          { position: 1, title: 'B' },
        ],
      ]) {
        const response = await admin.put(`${path()}/prizes`, { prizes });
        expect(response.statusCode, JSON.stringify(prizes)).toBe(400);
      }
      const ok = await admin.put(`${path()}/prizes`, PRIZES);
      expect(AdminDrawResponseSchema.parse(ok.json()).draw.prizes).toHaveLength(2);
    });

    it('requires exactly one correct skill-question option', async () => {
      const twoCorrect = await admin.put(`${path()}/skill-question`, {
        prompt: 'Q?',
        options: [
          { label: 'A', isCorrect: true },
          { label: 'B', isCorrect: true },
        ],
      });
      expect(errorCode(twoCorrect)).toBe('VALIDATION_FAILED');

      // Setting a question twice replaces it and removes the unused one.
      await admin.put(`${path()}/skill-question`, { ...QUESTION, prompt: 'First version?' });
      const response = await admin.put(`${path()}/skill-question`, QUESTION);
      const draw = AdminDrawResponseSchema.parse(response.json()).draw;
      expect(draw.skillQuestion?.options.filter((o) => o.isCorrect).map((o) => o.label)).toEqual([
        'Edinburgh',
      ]);
      expect(draw.publishBlockers).toEqual([]);
      const orphans = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM skill_questions WHERE prompt = 'First version?'`,
      );
      expect(orphans.rows[0]!.n).toBe(0);
    });

    it('publishes the draft; customers then see it', async () => {
      const response = await admin.post(`${path()}/publish`, { reason: 'Ready for launch (test)' });
      expect(response.statusCode).toBe(200);
      const draw = AdminDrawResponseSchema.parse(response.json()).draw;
      expect(draw.status).toBe('scheduled');
      expect(draw.effectiveStatus).toBe('live'); // opening time already passed
      expect(draw.publishedAt).not.toBeNull();

      const publicDraw = DrawResponseSchema.parse(
        (await get(h.app, '/markets/uk/draws/weekend-getaway')).json(),
      ).draw;
      expect(publicDraw).toMatchObject({ status: 'live', ticketPriceMinor: 199, currency: 'GBP' });
      expect(publicDraw.skillQuestion.prompt).toBe(QUESTION.prompt);
    });

    it('freezes the published draw: no edits, no prize or question changes, no second publish', async () => {
      const edit = await admin.put(path(), draftBody({ ticketPriceMinor: 99 }));
      expect(edit.statusCode).toBe(409);
      expect(errorCode(edit)).toBe('DRAW_NOT_EDITABLE');
      expect(errorCode(await admin.put(`${path()}/prizes`, PRIZES))).toBe('DRAW_NOT_EDITABLE');
      expect(errorCode(await admin.put(`${path()}/skill-question`, QUESTION))).toBe(
        'DRAW_NOT_EDITABLE',
      );
      expect(errorCode(await admin.post(`${path()}/publish`, {}))).toBe(
        'DRAW_TRANSITION_NOT_ALLOWED',
      );
    });

    it('cancels a scheduled draw with a reason; customers stop seeing it', async () => {
      expect(errorCode(await admin.post(`${path()}/cancel`, {}))).toBe('VALIDATION_FAILED');
      const response = await admin.post(`${path()}/cancel`, {
        reason: 'Supplier withdrew the prize (test)',
      });
      expect(response.statusCode).toBe(200);
      expect(AdminDrawResponseSchema.parse(response.json()).draw.status).toBe('cancelled');
      expect((await get(h.app, '/markets/uk/draws/weekend-getaway')).statusCode).toBe(404);

      const audit = await h.sql.query<{ action: string; reason: string | null }>(
        `SELECT action, reason FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at, id`,
        [id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'draw.created',
        'draw.prizes.replaced',
        'draw.skill_question.set',
        'draw.skill_question.set',
        'draw.published',
        'draw.cancelled',
      ]);
      expect(audit.rows.at(-1)!.reason).toBe('Supplier withdrew the prize (test)');
    });

    it('refuses to cancel a live draw (policy OPEN O6)', async () => {
      const liveId = (
        await h.sql.query<{ id: string }>(`SELECT id FROM draws WHERE slug = 'uk-live'`)
      ).rows[0]!.id;
      const response = await admin.post(`/admin/markets/uk/draws/${liveId}/cancel`, {
        reason: 'Test attempt',
      });
      expect(response.statusCode).toBe(409);
      const body = ErrorResponseSchema.parse(response.json());
      expect(body.error.code).toBe('DRAW_TRANSITION_NOT_ALLOWED');
      expect(body.error.message).toMatch(/O6/);
    });
  });
});
