import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';
import { type MarketCode, isMarketCode } from '@hv/domain';

export interface MarketRecord {
  id: string;
  code: MarketCode;
  name: string;
  currency: 'GBP' | 'EUR';
  locale: string;
  isEnabled: boolean;
  requiresLegalApproval: boolean;
  legalApprovedAt: Date | null;
  legalApprovedBy: string | null;
  legalApprovalRef: string | null;
  minAge: number | null;
  selfExclusionRequired: boolean | null;
  /** From hv_market_missing_settings(): the database's own definition of "required". */
  missingSettings: string[];
}

export interface MarketSettingsChange {
  minAge: number | null;
  selfExclusionRequired: boolean | null;
}

@Injectable()
export class MarketsRepository {
  private base(db: DbExecutor) {
    return db
      .selectFrom('markets as m')
      .innerJoin('market_settings as s', 's.market_id', 'm.id')
      .select([
        'm.id',
        'm.code',
        'm.name',
        'm.currency',
        'm.locale',
        'm.is_enabled',
        'm.requires_legal_approval',
        'm.legal_approved_at',
        'm.legal_approved_by',
        'm.legal_approval_ref',
        's.min_age',
        's.self_exclusion_required',
        sql<string[]>`hv_market_missing_settings(m.id)`.as('missing_settings'),
      ]);
  }

  async list(db: DbExecutor): Promise<MarketRecord[]> {
    const rows = await this.base(db).orderBy('m.code').execute();
    return rows.map(toRecord);
  }

  async findByCode(db: DbExecutor, code: string): Promise<MarketRecord | null> {
    const row = await this.base(db).where('m.code', '=', code).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  /** Locks the market row for a gate change; concurrent changes to the same market serialise. */
  async findByCodeForUpdate(db: DbExecutor, code: string): Promise<MarketRecord | null> {
    const row = await this.base(db).where('m.code', '=', code).forUpdate('m').executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async updateSettings(db: DbExecutor, marketId: string, change: MarketSettingsChange) {
    await db
      .updateTable('market_settings')
      .set({ min_age: change.minAge, self_exclusion_required: change.selfExclusionRequired })
      .where('market_id', '=', marketId)
      .execute();
  }

  async recordLegalApproval(
    db: DbExecutor,
    marketId: string,
    approvedBy: string,
    reference: string,
  ) {
    await db
      .updateTable('markets')
      .set({
        legal_approved_at: sql<Date>`now()`,
        legal_approved_by: approvedBy,
        legal_approval_ref: reference,
      })
      .where('id', '=', marketId)
      .execute();
  }

  async setEnabled(db: DbExecutor, marketId: string, enabled: boolean) {
    await db
      .updateTable('markets')
      .set({ is_enabled: enabled })
      .where('id', '=', marketId)
      .execute();
  }
}

function toRecord(row: {
  id: string;
  code: string;
  name: string;
  currency: string;
  locale: string;
  is_enabled: boolean;
  requires_legal_approval: boolean;
  legal_approved_at: Date | null;
  legal_approved_by: string | null;
  legal_approval_ref: string | null;
  min_age: number | null;
  self_exclusion_required: boolean | null;
  missing_settings: string[];
}): MarketRecord {
  // Both are pinned by markets_known_definition; a mismatch means the schema changed.
  if (!isMarketCode(row.code) || (row.currency !== 'GBP' && row.currency !== 'EUR')) {
    throw new Error(`unexpected market row: ${row.code}/${row.currency}`);
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    currency: row.currency,
    locale: row.locale,
    isEnabled: row.is_enabled,
    requiresLegalApproval: row.requires_legal_approval,
    legalApprovedAt: row.legal_approved_at,
    legalApprovedBy: row.legal_approved_by,
    legalApprovalRef: row.legal_approval_ref,
    minAge: row.min_age,
    selfExclusionRequired: row.self_exclusion_required,
    missingSettings: row.missing_settings,
  };
}
