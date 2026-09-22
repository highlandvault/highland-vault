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
