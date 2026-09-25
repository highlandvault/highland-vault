import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';

export interface TermsVersionRecord {
  readonly id: string;
  readonly marketId: string;
  readonly version: string;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
}

export interface TermsAcceptanceRecord {
  readonly termsVersionId: string;
  readonly acceptedAt: Date;
  readonly acceptedBy: 'user' | 'guest';
}

/** Whose acceptance this is (ADR-0031): one identity, never both. */
export type AcceptingIdentity =
  { kind: 'user'; userId: string } | { kind: 'guest'; guestSessionId: string };

const COLUMNS = ['id', 'market_id', 'version', 'published_at', 'created_at'] as const;

@Injectable()
export class TermsRepository {
  /** The version a checkout in this market would be placed under, if there is one. */
  async activeVersion(db: DbExecutor, marketId: string): Promise<TermsVersionRecord | null> {
    const row = await db
      .selectFrom('market_settings as s')
      .innerJoin('terms_versions as t', 't.id', 's.active_terms_version_id')
      .select(['t.id', 't.market_id', 't.version', 't.published_at', 't.created_at'])
      .where('s.market_id', '=', marketId)
      .executeTakeFirst();
    return row ? toVersion(row) : null;
  }

  async findById(
    db: DbExecutor,
    marketId: string,
    id: string,
    lock = false,
  ): Promise<TermsVersionRecord | null> {
    let query = db
      .selectFrom('terms_versions')
      .select(COLUMNS)
      // Always scoped to the market, so one market's terms can never be
      // reached through another's route.
      .where('market_id', '=', marketId)
      .where('id', '=', id);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row ? toVersion(row) : null;
  }

  async list(db: DbExecutor, marketId: string): Promise<TermsVersionRecord[]> {
    const rows = await db
      .selectFrom('terms_versions')
      .select(COLUMNS)
      .where('market_id', '=', marketId)
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();
    return rows.map(toVersion);
  }

  async create(
    db: DbExecutor,
    input: { marketId: string; version: string; publish: boolean },
  ): Promise<TermsVersionRecord> {
    const row = await db
      .insertInto('terms_versions')
      .values({
        market_id: input.marketId,
        version: input.version,
        published_at: input.publish ? sql<Date>`now()` : null,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return toVersion(row);
  }

  /** Publishes a draft. Conditional, so publishing twice is not a second publication. */
  async publish(db: DbExecutor, id: string): Promise<boolean> {
    const result = await db
      .updateTable('terms_versions')
      .set({ published_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('published_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  /**
   * Points the market at a version.
   *
   * The composite foreign key on `market_settings` refuses a version belonging
   * to another market, so this cannot cross markets even if the service is
   * wrong about which one it is holding.
   */
  async setActive(db: DbExecutor, marketId: string, termsVersionId: string): Promise<void> {
    await db
      .updateTable('market_settings')
      .set({ active_terms_version_id: termsVersionId })
      .where('market_id', '=', marketId)
      .execute();
  }

  /** Records agreement. Idempotent: accepting the same version twice is one acceptance. */
  async accept(
    db: DbExecutor,
    input: { marketId: string; termsVersionId: string; identity: AcceptingIdentity },
  ): Promise<void> {
    const { identity } = input;
    await sql`
      INSERT INTO terms_acceptances (market_id, terms_version_id, user_id, guest_session_id)
      VALUES (
        ${input.marketId},
        ${input.termsVersionId},
        ${identity.kind === 'user' ? identity.userId : null}::uuid,
        ${identity.kind === 'guest' ? identity.guestSessionId : null}::uuid
      )
      ON CONFLICT DO NOTHING
    `.execute(db);
  }

  /** The caller's acceptance of a given version, if they have one. */
  async findAcceptance(
    db: DbExecutor,
    termsVersionId: string,
    identity: AcceptingIdentity,
  ): Promise<TermsAcceptanceRecord | null> {
    const query = db
      .selectFrom('terms_acceptances')
      .select(['terms_version_id', 'accepted_at'])
      .where('terms_version_id', '=', termsVersionId);
    const row = await (
      identity.kind === 'user'
        ? query.where('user_id', '=', identity.userId)
        : query.where('guest_session_id', '=', identity.guestSessionId)
    ).executeTakeFirst();
    if (!row) return null;
    return {
      termsVersionId: row.terms_version_id,
      acceptedAt: row.accepted_at,
      acceptedBy: identity.kind,
    };
  }
}

function toVersion(row: {
  id: string;
  market_id: string;
  version: string;
  published_at: Date | null;
  created_at: Date;
}): TermsVersionRecord {
  return {
    id: row.id,
    marketId: row.market_id,
    version: row.version,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}
