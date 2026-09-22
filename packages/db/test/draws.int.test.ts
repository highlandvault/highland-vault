/**
 * Phase 3 draw invariants enforced by PostgreSQL itself (migration 0008),
 * against a real database cloned from the migrated template.
 */
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeConnections,
  createBarrier,
  createTestDatabase,
  insertFixtureDraw,
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

describe('draws (database layer)', () => {
  let database: TestDatabase;
  let client: pg.Client;

  beforeEach(async () => {
    database = await createTestDatabase();
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
  });

  afterEach(async () => {
    await client?.end();
    await database?.drop();
  });

  interface DraftInput {
    market?: string;
    currency?: string | null; // null = take the market's own currency
    slug?: string;
    price?: number;
    total?: number;
    cap?: number;
    positions?: number;
    opensAt?: Date;
    closesAt?: Date;
    status?: string;
  }

  const insertDraft = (input: DraftInput = {}) =>
    client.query<{
      id: string;
      currency: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO draws (market_id, currency, slug, title, status, ticket_price_minor, total_tickets,
                          max_per_person, winner_positions, opens_at, closes_at)
       SELECT m.id, COALESCE($2, m.currency), $3, 'Draw', $4, $5, $6, $7, $8, $9, $10
         FROM markets m WHERE m.code = $1
       RETURNING id, currency, status, created_at, updated_at`,
      [
        input.market ?? 'uk',
        input.currency ?? null,
        input.slug ?? 'draw',
        input.status ?? 'draft',
        input.price ?? 250,
        input.total ?? 100,
        input.cap ?? 10,
        input.positions ?? 1,
        input.opensAt ?? new Date(Date.now() - HOUR),
        input.closesAt ?? new Date(Date.now() + 24 * HOUR),
      ],
    );

  const status = async (id: string) =>
    (await client.query<{ status: string }>(`SELECT status FROM draws WHERE id = $1`, [id]))
      .rows[0]!.status;

  describe('market and currency', () => {
    it('creates a draft in exactly one market with that market’s currency and timestamps', async () => {
      const uk = (await insertDraft({ market: 'uk' })).rows[0]!;
      const ie = (await insertDraft({ market: 'ie' })).rows[0]!;
      expect([uk.currency, ie.currency]).toEqual(['GBP', 'EUR']);
      expect(uk.status).toBe('draft');
      expect(uk.created_at).toBeInstanceOf(Date);
      expect(uk.updated_at.getTime()).toBe(uk.created_at.getTime());
    });

    it('refuses a currency that does not match the market (no currency drift)', async () => {
      for (const [market, currency] of [
        ['uk', 'EUR'],
        ['ie', 'GBP'],
        ['de', 'GBP'],
      ] as const) {
        const error = await pgError(insertDraft({ market, currency }));
        expect(error.constraint).toBe('draws_market_currency_fkey');
      }
      // Changing the currency later is refused the same way.
      const { id } = (await insertDraft()).rows[0]!;
      expect(
        (await pgError(client.query(`UPDATE draws SET currency = 'EUR' WHERE id = $1`, [id])))
          .constraint,
      ).toBe('draws_market_currency_fkey');
    });

    it('refuses a market that does not exist', async () => {
      const error = await pgError(
        client.query(
          `INSERT INTO draws (market_id, currency, slug, title, ticket_price_minor, total_tickets,
                              max_per_person, winner_positions, opens_at, closes_at)
           VALUES (gen_random_uuid(), 'GBP', 'x', 'X', 1, 1, 1, 1, now(), now() + interval '1 day')`,
        ),
      );
      expect(error.code).toBe('23503');
    });

    it('keeps the slug unique per market, not globally', async () => {
      await insertDraft({ market: 'uk', slug: 'supercar' });
      expect((await pgError(insertDraft({ market: 'uk', slug: 'supercar' }))).constraint).toBe(
        'draws_market_slug_key',
      );
      await insertDraft({ market: 'ie', slug: 'supercar' });
    });

    it('offers (id, market_id) as the key an order line can reference, so no order mixes markets', async () => {
      // Stand-in for order_items (Phase 5).
      await client.query(`
        CREATE TABLE scratch_order_items (
          id serial PRIMARY KEY,
          draw_id uuid NOT NULL,
          market_id uuid NOT NULL,
          FOREIGN KEY (draw_id, market_id) REFERENCES draws (id, market_id)
        )`);
      const { id } = (await insertDraft({ market: 'uk' })).rows[0]!;
      await client.query(
        `INSERT INTO scratch_order_items (draw_id, market_id) SELECT $1, id FROM markets WHERE code = 'uk'`,
        [id],
      );
      const error = await pgError(
        client.query(
          `INSERT INTO scratch_order_items (draw_id, market_id) SELECT $1, id FROM markets WHERE code = 'ie'`,
          [id],
        ),
      );
      expect(error.code).toBe('23503');
    });

    it('refuses a skill question that belongs to another market', async () => {
      const { id } = (await insertDraft({ market: 'uk' })).rows[0]!;
      const ieQuestion = await client.query<{ id: string }>(
        `INSERT INTO skill_questions (market_id, prompt) SELECT id, 'IE question' FROM markets WHERE code = 'ie' RETURNING id`,
      );
      const error = await pgError(
        client.query(`UPDATE draws SET skill_question_id = $2 WHERE id = $1`, [
          id,
          ieQuestion.rows[0]!.id,
        ]),
      );
      expect(error.constraint).toBe('draws_skill_question_same_market_fkey');
    });
  });

  describe('values', () => {
    it.each([
      ['a zero price', { price: 0 }, 'draws_ticket_price_positive'],
      ['a negative price', { price: -1 }, 'draws_ticket_price_positive'],
      ['a cap of zero', { cap: 0 }, 'draws_max_per_person_valid'],
      ['a cap above capacity', { total: 10, cap: 11 }, 'draws_max_per_person_valid'],
      ['no winner positions', { positions: 0 }, 'draws_winner_positions_valid'],
      [
        'more positions than tickets',
        { total: 2, cap: 2, positions: 3 },
        'draws_winner_positions_valid',
      ],
      ['an uppercase slug', { slug: 'Supercar' }, 'draws_slug_format'],
      ['a slug with spaces', { slug: 'super car' }, 'draws_slug_format'],
    ] as const)('refuses %s', async (_label, input, constraint) => {
      expect((await pgError(insertDraft(input))).constraint).toBe(constraint);
    });

    it('refuses zero tickets', async () => {
      // Zero capacity also breaks cap ≤ capacity; either constraint refuses it.
      expect(['draws_total_tickets_positive', 'draws_max_per_person_valid']).toContain(
        (await pgError(insertDraft({ total: 0, cap: 1, positions: 1 }))).constraint,
      );
    });

    it('requires the closing time after the opening time', async () => {
      const at = new Date(Date.now() + HOUR);
      expect((await pgError(insertDraft({ opensAt: at, closesAt: at }))).constraint).toBe(
        'draws_opens_before_closes',
      );
    });

    it('stores the ticket price as integer minor units', async () => {
      const { rows } = await client.query<{ type: string }>(
        `SELECT data_type AS type FROM information_schema.columns
          WHERE table_name = 'draws' AND column_name = 'ticket_price_minor'`,
      );
      expect(rows[0]!.type).toBe('bigint');
      // A fractional amount is not even a valid bigint (invalid_text_representation).
      expect((await pgError(insertDraft({ price: 2.5 }))).code).toBe('22P02');
    });
  });

  describe('lifecycle', () => {
    it('only creates drafts', async () => {
      expect((await pgError(insertDraft({ status: 'live' }))).constraint).toBe(
        'draws_created_as_draft',
      );
    });

    it('refuses to publish until the skill question, prizes and closing time allow it', async () => {
      const { id } = (await insertDraft({ positions: 2, total: 100 })).rows[0]!;
      const publish = () =>
        pgError(
          client.query(
            `UPDATE draws SET status = 'scheduled', published_at = now() WHERE id = $1`,
            [id],
          ),
        );
      let error = await publish();
      expect(error.constraint).toBe('draws_publish_requirements');
      expect(error.detail).toBe('skill_question_missing,prizes_incomplete');

      const question = await client.query<{ id: string }>(
        `INSERT INTO skill_questions (market_id, prompt) SELECT market_id, 'Q?' FROM draws WHERE id = $1 RETURNING id`,
        [id],
      );
      const qid = question.rows[0]!.id;
      await client.query(
        `INSERT INTO skill_question_options (skill_question_id, position, label, is_correct) VALUES ($1, 1, 'A', false)`,
        [qid],
      );
      await client.query(`UPDATE draws SET skill_question_id = $2 WHERE id = $1`, [id, qid]);
      await client.query(
        `INSERT INTO draw_prizes (draw_id, position, title) VALUES ($1, 1, 'First')`,
        [id],
      );
      error = await publish();
      expect(error.detail).toBe('skill_question_incomplete,prizes_incomplete');

      await client.query(
        `INSERT INTO skill_question_options (skill_question_id, position, label, is_correct) VALUES ($1, 2, 'B', true)`,
        [qid],
      );
      await client.query(
        `INSERT INTO draw_prizes (draw_id, position, title) VALUES ($1, 2, 'Second')`,
        [id],
      );
      await client.query(
        `UPDATE draws SET status = 'scheduled', published_at = now() WHERE id = $1`,
        [id],
      );
      expect(await status(id)).toBe('scheduled');
    });

    it('allows at most one correct option per skill question', async () => {
      const q = await client.query<{ id: string }>(
        `INSERT INTO skill_questions (market_id, prompt) SELECT id, 'Q?' FROM markets WHERE code = 'uk' RETURNING id`,
      );
      await client.query(
        `INSERT INTO skill_question_options (skill_question_id, position, label, is_correct) VALUES ($1, 1, 'A', true)`,
        [q.rows[0]!.id],
      );
      const error = await pgError(
        client.query(
          `INSERT INTO skill_question_options (skill_question_id, position, label, is_correct) VALUES ($1, 2, 'B', true)`,
          [q.rows[0]!.id],
        ),
      );
      expect(error.constraint).toBe('skill_question_options_one_correct');
    });

    it('refuses to publish a draw whose closing time has passed', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'late',
        state: 'draft',
        opensAt: new Date(Date.now() - 2 * HOUR),
        closesAt: new Date(Date.now() - HOUR),
      });
      const error = await pgError(
        client.query(`UPDATE draws SET status = 'scheduled', published_at = now() WHERE id = $1`, [
          id,
        ]),
      );
      expect(error.detail).toBe('closes_at_in_past');
    });

    it('follows only the allowed transitions', async () => {
      const live = await insertFixtureDraw(client, { market: 'uk', slug: 'live', state: 'live' });
      for (const to of ['draft', 'scheduled', 'cancelled', 'settled', 'completed']) {
        const extra = to === 'cancelled' ? ', cancelled_at = now()' : '';
        const error = await pgError(
          client.query(`UPDATE draws SET status = '${to}'${extra} WHERE id = $1`, [live]),
        );
        expect(error.constraint, `live → ${to}`).toBe('draws_status_transition');
      }
      const draft = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'draft',
        state: 'draft',
      });
      for (const to of ['live', 'closed', 'settled']) {
        const error = await pgError(
          client.query(`UPDATE draws SET status = '${to}' WHERE id = $1`, [draft]),
        );
        expect(error.constraint, `draft → ${to}`).toBe('draws_status_transition');
      }
    });

    it('cannot go live before opening, nor close before the closing time', async () => {
      const early = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'upcoming',
        state: 'scheduled',
        opensAt: new Date(Date.now() + HOUR),
        closesAt: new Date(Date.now() + 2 * HOUR),
      });
      expect(
        (await pgError(client.query(`UPDATE draws SET status = 'live' WHERE id = $1`, [early])))
          .constraint,
      ).toBe('draws_opens_at_not_reached');

      const live = await insertFixtureDraw(client, { market: 'uk', slug: 'open', state: 'live' });
      expect(
        (
          await pgError(
            client.query(`UPDATE draws SET status = 'closed', closed_at = now() WHERE id = $1`, [
              live,
            ]),
          )
        ).constraint,
      ).toBe('draws_closes_at_not_reached');
    });

    it('cancels drafts and scheduled draws, but never live ones (OPEN O6)', async () => {
      const cancel = (id: string) =>
        client.query(`UPDATE draws SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [
          id,
        ]);
      await cancel(await insertFixtureDraw(client, { market: 'uk', slug: 'a', state: 'draft' }));
      await cancel(
        await insertFixtureDraw(client, {
          market: 'uk',
          slug: 'b',
          state: 'scheduled',
          opensAt: new Date(Date.now() + HOUR),
          closesAt: new Date(Date.now() + 2 * HOUR),
        }),
      );
      const live = await insertFixtureDraw(client, { market: 'uk', slug: 'c', state: 'live' });
      expect((await pgError(cancel(live))).constraint).toBe('draws_status_transition');
      // cancelled_at must accompany the cancelled status.
      const d = await insertFixtureDraw(client, { market: 'uk', slug: 'd', state: 'draft' });
      expect(
        (await pgError(client.query(`UPDATE draws SET status = 'cancelled' WHERE id = $1`, [d])))
          .constraint,
      ).toBe('draws_cancelled_at_consistent');
    });
  });

  describe('configuration lock after publishing', () => {
    it('freezes the draw configuration, its prizes and its skill question', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'frozen',
        state: 'scheduled',
        opensAt: new Date(Date.now() + HOUR),
        closesAt: new Date(Date.now() + 2 * HOUR),
      });
      for (const assignment of [
        'ticket_price_minor = 1',
        'total_tickets = 5000',
        'max_per_person = 1',
        "closes_at = closes_at + interval '1 day'",
        "slug = 'renamed'",
      ]) {
        const error = await pgError(
          client.query(`UPDATE draws SET ${assignment} WHERE id = $1`, [id]),
        );
        expect(error.constraint, assignment).toBe('draws_configuration_locked');
      }
      expect(
        (
          await pgError(
            client.query(`UPDATE draw_prizes SET title = 'Other' WHERE draw_id = $1`, [id]),
          )
        ).constraint,
      ).toBe('draws_configuration_locked');
      expect(
        (await pgError(client.query(`DELETE FROM draw_prizes WHERE draw_id = $1`, [id])))
          .constraint,
      ).toBe('draws_configuration_locked');
      expect(
        (
          await pgError(
            client.query(
              `UPDATE skill_question_options SET is_correct = NOT is_correct
                WHERE skill_question_id = (SELECT skill_question_id FROM draws WHERE id = $1)`,
              [id],
            ),
          )
        ).constraint,
      ).toBe('draws_configuration_locked');
    });

    it('keeps drafts fully editable', async () => {
      const id = await insertFixtureDraw(client, {
        market: 'uk',
        slug: 'editable',
        state: 'draft',
      });
      await client.query(
        `UPDATE draws SET ticket_price_minor = 500, slug = 'renamed' WHERE id = $1`,
        [id],
      );
      await client.query(`UPDATE draw_prizes SET title = 'Changed' WHERE draw_id = $1`, [id]);
    });

    it('never publishes a draw whose prizes were removed concurrently (no write skew)', async () => {
      const [a, b] = await openConnections(database.url, 2);
      try {
        for (let round = 0; round < 15; round++) {
          const id = await insertFixtureDraw(client, {
            market: 'uk',
            slug: `race-${round}`,
            state: 'draft',
          });
          const barrier = createBarrier(2);
          const race = async (conn: pg.Client, statement: string) => {
            await conn.query('BEGIN');
            await barrier();
            try {
              await conn.query(statement, [id]);
              await conn.query('COMMIT');
              return 'committed';
            } catch {
              await conn.query('ROLLBACK');
              return 'rejected';
            }
          };
          const results = await Promise.all([
            race(a!, `UPDATE draws SET status = 'scheduled', published_at = now() WHERE id = $1`),
            race(b!, `DELETE FROM draw_prizes WHERE draw_id = $1`),
          ]);
          const { rows } = await client.query<{ status: string; prizes: number }>(
            `SELECT status, (SELECT count(*)::int FROM draw_prizes WHERE draw_id = d.id) AS prizes
               FROM draws d WHERE id = $1`,
            [id],
          );
          expect(
            rows[0]!.status === 'scheduled' && rows[0]!.prizes === 0,
            `round ${round}: ${results.join('/')}`,
          ).toBe(false);
          expect(results.filter((r) => r === 'committed')).toHaveLength(1);
        }
      } finally {
        await closeConnections([a!, b!]);
      }
    });
  });
});
