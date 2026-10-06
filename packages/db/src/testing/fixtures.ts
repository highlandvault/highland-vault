/**
 * Test-only fixtures for throwaway databases (integration and e2e tests).
 *
 * The compliance values are OPEN (O12). The ones below are TEST FIXTURES that
 * let tests exercise an enabled market. They are NOT compliance decisions and
 * must never be copied into a migration or a real environment.
 */
import { argon2, randomBytes } from 'node:crypto';
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
  await configurePaymentsForTesting(db, codes);
}

/**
 * Points the given markets at the fake provider (P6-7).
 *
 * Since P6-7 a market pays through the provider its `market_payment_configs`
 * row names, and a market with none cannot take a payment at all — the correct
 * state in production until O13 is answered. A test that enables a market and
 * expects to pay therefore has to configure one too, exactly as it has to
 * supply the compliance values above.
 *
 * `config_ref` is a reference, never a secret (I15). The fake provider takes
 * its signing key from the environment like every other credential, so this
 * value is only a label — and a labelled one, so that a row found in a real
 * database is obviously a test fixture.
 */
export async function configurePaymentsForTesting(
  db: Queryable,
  codes: readonly ('uk' | 'ie' | 'de')[],
  providerCode = 'fake',
): Promise<void> {
  await db.query(
    `UPDATE market_payment_configs c
        SET provider_code = $2, config_ref = $3
       FROM markets m
      WHERE m.id = c.market_id AND m.code = ANY($1)`,
    [codes, providerCode, `test-fixture-${providerCode}`],
  );
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

/**
 * A fixture user that CAN sign in, for browser tests that need a staff account.
 *
 * `insertFixtureUser` above is for rows that never authenticate: its hash
 * corresponds to no password at all. This one hashes a real (test) password
 * with the same Argon2id parameters the API uses, so `verifyPassword` accepts
 * it and `needsRehash` leaves it alone.
 *
 * **Why this exists rather than another HTTP registration.** `registerPerIp`
 * allows twenty registrations an hour per address, `TRUST_PROXY` is empty so
 * every e2e caller shares one bucket, and a full suite run already uses all
 * twenty. A staff fixture created here costs none of them and needs no change
 * to a security limit.
 *
 * Node's `crypto.argon2` is built in (Node >= 24.7), so this adds no
 * dependency. The format is the PHC string `apps/api/src/auth/password.ts`
 * writes and parses; if the two ever diverge, sign-in fails loudly in the e2e
 * suite rather than quietly.
 */
export async function insertSignInFixtureUser(
  db: Queryable,
  email: string,
  password: string,
): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    argon2(
      'argon2id',
      { message: password, nonce: salt, memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 },
      (error, out) => (error ? reject(error) : resolve(out)),
    );
  });
  const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
  const hash = `$argon2id$v=19$m=19456,t=2,p=1$${b64(salt)}$${b64(derived)}`;
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, hash],
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
      options.maxPerPerson ?? Math.min(25, options.totalTickets ?? 1000),
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

/**
 * Publishes and activates a terms version for the given markets (P6-8).
 *
 * Checkout refuses to create an order without an active version (ADR-0031), so
 * a test database that expects to reach checkout needs one. Labelled a test
 * fixture, like the compliance values above: it is not legal copy and must
 * never be mistaken for any.
 */
export async function activateTermsForTesting(
  db: Queryable,
  codes: readonly ('uk' | 'ie' | 'de')[],
  version = 'test-fixture-terms-v1',
): Promise<void> {
  await db.query(
    `INSERT INTO terms_versions (market_id, version, published_at)
       SELECT id, $2, now() FROM markets WHERE code = ANY($1)
       ON CONFLICT (market_id, version) DO NOTHING`,
    [codes, version],
  );
  await db.query(
    `UPDATE market_settings s
        SET active_terms_version_id = t.id
       FROM terms_versions t, markets m
      WHERE m.id = s.market_id AND t.market_id = m.id
        AND t.version = $2 AND m.code = ANY($1)`,
    [codes, version],
  );
}
