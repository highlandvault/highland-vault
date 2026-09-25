import { Inject, Injectable } from '@nestjs/common';
import type { AdminTermsVersion } from '@hv/contracts';
import { type Database, type DbExecutor, withTransaction } from '@hv/db';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { isUniqueViolation } from '../common/pg-errors';
import type { AuthContext, RequestMeta } from '../common/request-context';
import { DATABASE } from '../database/database.module';
import { MarketsRepository } from '../markets/markets.repository';
import { TermsRepository, type TermsVersionRecord } from './terms.repository';

/**
 * Publishing a market's terms (B12).
 *
 * Every change is audited in the same transaction as the change itself, as
 * every other market-settings change is (ADR-0010). Which market a version
 * belongs to is resolved from the route, never from the body.
 *
 * No wording is written or stored here. A version is a label and a moment;
 * the content is legal's and arrives in Phase 12.
 */
@Injectable()
export class AdminTermsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly terms: TermsRepository,
    private readonly markets: MarketsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(code: string): Promise<AdminTermsVersion[]> {
    const market = await this.market(code);
    const [versions, active] = await Promise.all([
      this.terms.list(this.db, market.id),
      this.terms.activeVersion(this.db, market.id),
    ]);
    return versions.map((v) => this.toDto(code, v, active?.id ?? null));
  }

  async create(
    code: string,
    input: { version: string; publish?: boolean | undefined; reason: string },
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminTermsVersion> {
    const market = await this.market(code);
    const version = input.version.trim();
    const created = await withTransaction(this.db, async (trx) => {
      let record: TermsVersionRecord;
      try {
        record = await this.terms.create(trx, {
          marketId: market.id,
          version,
          publish: input.publish === true,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'terms_versions_market_version_key')) {
          throw Errors.conflict(
            'CONFLICT',
            `Market ${code} already has a terms version called "${version}".`,
          );
        }
        throw error;
      }
      await this.record(trx, 'market.terms.created', market.id, record, input.reason, auth, meta);
      return record;
    });
    return this.toDto(code, created, null);
  }

  /** Makes a draft real. A published version can never be withdrawn (the guard refuses). */
  async publish(
    code: string,
    termsId: string,
    reason: string,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminTermsVersion> {
    const market = await this.market(code);
    const published = await withTransaction(this.db, async (trx) => {
      const record = await this.terms.findById(trx, market.id, termsId, true);
      if (!record) throw Errors.notFound('Terms version');
      if (record.publishedAt) {
        throw Errors.conflict('CONFLICT', 'That terms version is already published.');
      }
      await this.terms.publish(trx, record.id);
      const after = await this.terms.findById(trx, market.id, record.id);
      await this.record(trx, 'market.terms.published', market.id, after!, reason, auth, meta);
      return after!;
    });
    const active = await this.terms.activeVersion(this.db, market.id);
    return this.toDto(code, published, active?.id ?? null);
  }

  /**
   * Points the market at a version, which is what lets checkout create orders
   * there (ADR-0031).
   *
   * Only a published version may be activated: activating a draft would let a
   * customer agree to something that was never issued.
   */
  async activate(
    code: string,
    termsId: string,
    reason: string,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminTermsVersion> {
    const market = await this.market(code);
    const activated = await withTransaction(this.db, async (trx) => {
      const record = await this.terms.findById(trx, market.id, termsId, true);
      if (!record) throw Errors.notFound('Terms version');
      if (!record.publishedAt) {
        throw Errors.conflict(
          'CONFLICT',
          'Publish the terms version before making it the market’s active one.',
        );
      }
      const before = await this.terms.activeVersion(trx, market.id);
      await this.terms.setActive(trx, market.id, record.id);
      await this.audit.record(trx, {
        actor: { type: 'user', userId: auth.userId },
        action: 'market.terms.activated',
        entityType: 'terms_version',
        entityId: record.id,
        marketId: market.id,
        reason,
        before: before ? { version: before.version } : null,
        after: { version: record.version },
        meta: { ip: meta.ip, requestId: meta.requestId },
      });
      return record;
    });
    return this.toDto(code, activated, activated.id);
  }

  private async market(code: string) {
    const market = await this.markets.findByCode(this.db, code);
    if (!market) throw Errors.notFound('Market');
    return market;
  }

  private record(
    trx: DbExecutor,
    action: string,
    marketId: string,
    record: TermsVersionRecord,
    reason: string,
    auth: AuthContext,
    meta: RequestMeta,
  ) {
    return this.audit.record(trx, {
      actor: { type: 'user', userId: auth.userId },
      action,
      entityType: 'terms_version',
      entityId: record.id,
      marketId,
      reason,
      after: { version: record.version, published: record.publishedAt !== null },
      meta: { ip: meta.ip, requestId: meta.requestId },
    });
  }

  private toDto(
    code: string,
    record: TermsVersionRecord,
    activeId: string | null,
  ): AdminTermsVersion {
    return {
      id: record.id,
      market: code as AdminTermsVersion['market'],
      version: record.version,
      publishedAt: record.publishedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      active: record.id === activeId,
    };
  }
}
