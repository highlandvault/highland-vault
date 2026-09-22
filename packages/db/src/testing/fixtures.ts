/**
 * Test-only fixtures for throwaway databases (integration and e2e tests).
 *
 * The compliance values are OPEN (O12). The ones below are TEST FIXTURES that
 * let tests exercise an enabled market. They are NOT compliance decisions and
 * must never be copied into a migration or a real environment.
 */
import type pg from 'pg';

export const TEST_FIXTURE_COMPLIANCE = Object.freeze({
  min_age: 18,
  self_exclusion_required: true,
});

type Queryable = Pick<pg.ClientBase, 'query'> | Pick<pg.Pool, 'query'>;

/** Sets the fixture compliance values and enables the given markets (not 'de': see below). */
export async function enableMarketsForTesting(
  db: Queryable,
  codes: readonly ('uk' | 'ie')[],
): Promise<void> {
  await db.query(
    `UPDATE market_settings s
        SET min_age = $2, self_exclusion_required = $3
       FROM markets m
      WHERE m.id = s.market_id AND m.code = ANY($1)`,
    [codes, TEST_FIXTURE_COMPLIANCE.min_age, TEST_FIXTURE_COMPLIANCE.self_exclusion_required],
  );
  await db.query(`UPDATE markets SET is_enabled = true WHERE code = ANY($1)`, [codes]);
}

/**
 * Germany additionally needs a recorded legal approval (by an existing user).
 * Only for tests that prove what happens once all three gate layers allow DE.
 */
export async function enableGermanyForTesting(
  db: Queryable,
  approvedByUserId: string,
): Promise<void> {
  await db.query(
    `UPDATE market_settings s
        SET min_age = $1, self_exclusion_required = $2
       FROM markets m
      WHERE m.id = s.market_id AND m.code = 'de'`,
    [TEST_FIXTURE_COMPLIANCE.min_age, TEST_FIXTURE_COMPLIANCE.self_exclusion_required],
  );
  await db.query(
    `UPDATE markets
        SET legal_approved_at = now(), legal_approved_by = $1,
            legal_approval_ref = 'TEST-FIXTURE-NOT-A-REAL-APPROVAL', is_enabled = true
      WHERE code = 'de'`,
    [approvedByUserId],
  );
}

/** A syntactically valid Argon2id PHC string for rows that never sign in. Not a real password. */
export const FIXTURE_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function insertFixtureUser(db: Queryable, email: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FIXTURE_PASSWORD_HASH],
  );
  return result.rows[0]!.id;
}

export interface FixtureDrawOptions {
  market: 'uk' | 'ie' | 'de';
  slug: string;
  title?: string;
  /** How far through the real lifecycle to take the draw. */
  state: 'draft' | 'scheduled' | 'live' | 'cancelled';
  opensAt?: Date;
  closesAt?: Date;
  ticketPriceMinor?: number;
  totalTickets?: number;
  maxPerPerson?: number;
  prizes?: readonly string[];
}

/**
 * Creates a draw the way the application does — draft, then skill question and
 * prizes, then the requested transitions — so every database rule applies.
 * Content is labelled as test data.
 */
export async function insertFixtureDraw(
  db: Queryable,
  options: FixtureDrawOptions,
): Promise<string> {
  const prizes = options.prizes ?? ['Test fixture first prize'];
  const opensAt = options.opensAt ?? new Date(Date.now() - 60 * 60 * 1000);
  const closesAt = options.closesAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const draw = await db.query<{ id: string; market_id: string }>(
    `INSERT INTO draws (market_id, currency, slug, title, description, ticket_price_minor,
                        total_tickets, max_per_person, winner_positions, opens_at, closes_at)
     SELECT m.id, m.currency, $2, $3, 'Test fixture draw. Not a real competition.', $4, $5, $6, $7, $8, $9
       FROM markets m WHERE m.code = $1
     RETURNING id, market_id`,
    [
      options.market,
      options.slug,
      options.title ?? `Test fixture: ${options.slug}`,
      options.ticketPriceMinor ?? 250,
      options.totalTickets ?? 1000,
      options.maxPerPerson ?? 25,
      prizes.length,
      opensAt,
      closesAt,
    ],
  );
  const { id, market_id: marketId } = draw.rows[0]!;

  const question = await db.query<{ id: string }>(
    `INSERT INTO skill_questions (market_id, prompt) VALUES ($1, 'Test fixture: what is 2 + 3?') RETURNING id`,
    [marketId],
  );
  const questionId = question.rows[0]!.id;
  await db.query(
    `INSERT INTO skill_question_options (skill_question_id, position, label, is_correct)
     VALUES ($1, 1, '4', false), ($1, 2, '5', true), ($1, 3, '6', false)`,
    [questionId],
  );
  await db.query(`UPDATE draws SET skill_question_id = $2 WHERE id = $1`, [id, questionId]);
  for (const [index, title] of prizes.entries()) {
    await db.query(
      `INSERT INTO draw_prizes (draw_id, position, title, description) VALUES ($1, $2, $3, 'Test fixture prize.')`,
      [id, index + 1, title],
    );
  }

  if (options.state === 'cancelled') {
    await db.query(`UPDATE draws SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [
      id,
    ]);
  }
  if (options.state === 'scheduled' || options.state === 'live') {
    await db.query(`UPDATE draws SET status = 'scheduled', published_at = now() WHERE id = $1`, [
      id,
    ]);
  }
  if (options.state === 'live') {
    await db.query(`UPDATE draws SET status = 'live' WHERE id = $1`, [id]);
  }
  return id;
}
