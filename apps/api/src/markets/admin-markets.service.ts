import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminMarket,
  MarketGateChangeRequest,
  RecordLegalApprovalRequest,
  UpdateMarketSettingsRequest,
} from '@hv/contracts';
import { type Database, type DbExecutor, withTransaction } from '@hv/db';
import { enablementBlockers, isMarketAvailable } from '@hv/domain';
import { AuditService } from '../audit/audit.service';
import { AppError, Errors } from '../common/errors';
import { isConstraintViolation, violationDetailList } from '../common/pg-errors';
import type { AuthContext, RequestMeta } from '../common/request-context';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { type MarketRecord, MarketsRepository } from './markets.repository';

/**
 * Market gate management for staff. Every change is a sensitive operation
 * (ADR-0010: Germany activation; the other gate changes are treated the same
 * way pending O9): permission + fresh step-up MFA (AccessGuard) + a reason +
 * an audit record in the same transaction (here).
 *
 * The domain rules are checked first for a clear answer; the database
 * constraints and triggers from migration 0004 remain the final authority.
 */
@Injectable()
export class AdminMarketsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly repository: MarketsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<AdminMarket[]> {
    return (await this.repository.list(this.db)).map((m) => this.toAdmin(m));
  }

  updateSettings(
    code: string,
    input: UpdateMarketSettingsRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminMarket> {
    return this.change(
      code,
      auth,
      meta,
      'market.settings.updated',
      input.reason,
      async (trx, m) => {
        await this.repository.updateSettings(trx, m.id, {
          minAge: input.minAge,
          selfExclusionRequired: input.selfExclusionRequired,
        });
      },
    );
  }

  recordLegalApproval(
    code: string,
    input: RecordLegalApprovalRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminMarket> {
    return this.change(
      code,
      auth,
      meta,
      'market.legal_approval.recorded',
      input.reason,
      async (trx, m) => {
        if (!m.requiresLegalApproval) {
          throw Errors.conflict(
            'LEGAL_APPROVAL_NOT_APPLICABLE',
            `Market ${m.code} does not require legal approval.`,
          );
        }
        if (m.legalApprovedAt) {
          throw Errors.conflict(
            'LEGAL_APPROVAL_ALREADY_RECORDED',
            `Legal approval for market ${m.code} is already recorded.`,
          );
        }
        await this.repository.recordLegalApproval(trx, m.id, auth.userId, input.reference);
      },
    );
  }

  enable(
    code: string,
    input: MarketGateChangeRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminMarket> {
    return this.change(code, auth, meta, 'market.enabled', input.reason, async (trx, m) => {
      for (const blocker of enablementBlockers(m)) {
        if (blocker.kind === 'legal_approval_missing') {
          throw Errors.conflict(
            'LEGAL_APPROVAL_REQUIRED',
            `Market ${m.code} cannot be enabled without a recorded legal approval.`,
          );
        }
        throw complianceMissing(m.code, blocker.settings);
      }
      await this.repository.setEnabled(trx, m.id, true);
    });
  }

  disable(
    code: string,
    input: MarketGateChangeRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminMarket> {
    return this.change(code, auth, meta, 'market.disabled', input.reason, async (trx, m) => {
      await this.repository.setEnabled(trx, m.id, false);
    });
  }

  /** Lock → apply → re-read → audit (before/after), all in one transaction. */
  private async change(
    code: string,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    reason: string,
    apply: (trx: DbExecutor, market: MarketRecord) => Promise<void>,
  ): Promise<AdminMarket> {
    try {
      return await withTransaction(this.db, async (trx) => {
        const before = await this.repository.findByCodeForUpdate(trx, code);
        if (!before) throw Errors.notFound('Market');
        await apply(trx, before);
        const after = (await this.repository.findByCode(trx, code))!;
        await this.audit.record(trx, {
          actor: { type: 'user', userId: auth.userId },
          action,
          entityType: 'market',
          entityId: before.id,
          marketId: before.id,
          reason,
          before: snapshot(before),
          after: snapshot(after),
          meta,
        });
        return this.toAdmin(after);
      });
    } catch (error) {
      throw mapGateViolation(error, code);
    }
  }

  private toAdmin(m: MarketRecord): AdminMarket {
    const environmentAllowed = this.env.ENABLED_MARKETS.has(m.code);
    return {
      code: m.code,
      name: m.name,
      currency: m.currency,
      locale: m.locale,
      isEnabled: m.isEnabled,
      environmentAllowed,
      available: isMarketAvailable(m, this.env.ENABLED_MARKETS),
      requiresLegalApproval: m.requiresLegalApproval,
      legalApproval:
        m.legalApprovedAt && m.legalApprovedBy && m.legalApprovalRef
          ? {
              approvedAt: m.legalApprovedAt.toISOString(),
              approvedBy: m.legalApprovedBy,
              reference: m.legalApprovalRef,
            }
          : null,
      settings: { minAge: m.minAge, selfExclusionRequired: m.selfExclusionRequired },
      missingSettings: m.missingSettings,
    };
  }
}

function snapshot(m: MarketRecord) {
  return {
    isEnabled: m.isEnabled,
    legalApprovedAt: m.legalApprovedAt?.toISOString() ?? null,
    legalApprovalRef: m.legalApprovalRef,
    minAge: m.minAge,
    selfExclusionRequired: m.selfExclusionRequired,
  };
}

function complianceMissing(code: string, settings: readonly string[]): AppError {
  return Errors.conflict(
    'COMPLIANCE_SETTINGS_MISSING',
    `Market ${code}: required compliance settings are not set: ${settings.join(', ')}.`,
    { missingSettings: settings },
  );
}

/** A concurrent change can still trip a database gate; report it as the same domain error. */
function mapGateViolation(error: unknown, code: string): unknown {
  if (isConstraintViolation(error, 'markets_compliance_settings_required')) {
    return complianceMissing(code, violationDetailList(error));
  }
  if (isConstraintViolation(error, 'markets_legal_approval_required')) {
    return Errors.conflict(
      'LEGAL_APPROVAL_REQUIRED',
      `Market ${code} cannot be enabled without a recorded legal approval.`,
    );
  }
  return error;
}
