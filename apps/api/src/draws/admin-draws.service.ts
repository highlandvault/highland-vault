import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminDraw,
  CancelDrawRequest,
  DrawConfigRequest,
  PublishDrawRequest,
  ReplacePrizesRequest,
  SkillQuestionRequest,
} from '@hv/contracts';
import { type Database, type DbExecutor, type Json, withTransaction } from '@hv/db';
import {
  canCancel,
  effectiveStatus,
  isEditable,
  publishBlockers,
  validateDrawConfig,
} from '@hv/domain';
import { AuditService } from '../audit/audit.service';
import { AppError, Errors } from '../common/errors';
import { isConstraintViolation, isUniqueViolation, violationDetailList } from '../common/pg-errors';
import type { AuthContext, RequestMeta } from '../common/request-context';
import { DATABASE } from '../database/database.module';
import { type MarketRecord, MarketsRepository } from '../markets/markets.repository';
import { type DrawRecord, type DrawValues, DrawsRepository } from './draws.repository';

/**
 * Draw management for staff (Revision 2 B5 `draws` module). Every change:
 *   locks the draw → checks the domain rules → writes → audits,
 * in ONE transaction. The draws_* constraints and hv_draws_guard() in the
 * database remain the final authority.
 *
 * Draws can be prepared in any market, enabled or not; customers only see
 * them through MarketGuard. Draw operations are not on the ADR-0010 sensitive
 * list, so they need `draws.write` but no step-up (whether publishing counts
 * as a "major configuration change" is OPEN O9).
 */
@Injectable()
export class AdminDrawsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly draws: DrawsRepository,
    private readonly markets: MarketsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(marketCode: string): Promise<AdminDraw[]> {
    const market = await this.market(this.db, marketCode);
    const draws = await this.draws.listByMarket(this.db, market.id);
    return Promise.all(draws.map((draw) => this.toAdmin(this.db, market, draw)));
  }

  async get(marketCode: string, id: string): Promise<AdminDraw> {
    const market = await this.market(this.db, marketCode);
    const draw = await this.draws.findById(this.db, market.id, id);
    if (!draw) throw Errors.notFound('Draw');
    return this.toAdmin(this.db, market, draw);
  }

  async create(
    marketCode: string,
    input: DrawConfigRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminDraw> {
    const values = toValues(input);
    assertValid(values);
    return this.run(async (trx) => {
      const market = await this.market(trx, marketCode);
      const id = await this.draws.insert(trx, market, values, auth.userId);
      const draw = (await this.draws.findById(trx, market.id, id))!;
      await this.record(trx, auth, meta, 'draw.created', market, draw, null, snapshot(draw));
      return this.toAdmin(trx, market, draw);
    });
  }

  update(
    marketCode: string,
    id: string,
    input: DrawConfigRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminDraw> {
    const values = toValues(input);
    assertValid(values);
    return this.change(marketCode, id, auth, meta, 'draw.updated', async (trx, draw) => {
      requireDraft(draw);
      await this.draws.update(trx, draw.id, values);
    });
  }

  replacePrizes(
    marketCode: string,
    id: string,
    input: ReplacePrizesRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminDraw> {
    return this.change(marketCode, id, auth, meta, 'draw.prizes.replaced', async (trx, draw) => {
      requireDraft(draw);
      const positions = input.prizes.map((p) => p.position);
      const invalid =
        new Set(positions).size !== positions.length ||
        positions.some((p) => p > draw.winnerPositions);
      if (invalid) {
        throw Errors.validation({
          issues: [
            {
              path: 'prizes',
              message: `one prize per position, positions 1 to ${draw.winnerPositions}`,
            },
          ],
        });
      }
      await this.draws.replacePrizes(
        trx,
        draw.id,
        [...input.prizes].sort((a, b) => a.position - b.position),
      );
    });
  }

  setSkillQuestion(
    marketCode: string,
    id: string,
    input: SkillQuestionRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminDraw> {
    return this.change(marketCode, id, auth, meta, 'draw.skill_question.set', async (trx, draw) => {
      requireDraft(draw);
      await this.draws.replaceSkillQuestion(trx, draw, input.prompt, input.options);
    });
  }

  publish(
    marketCode: string,
    id: string,
    input: PublishDrawRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminDraw> {
    return this.change(
      marketCode,
      id,
      auth,
      meta,
      'draw.published',
      async (trx, draw) => {
        if (draw.status !== 'draft') {
          throw Errors.conflict(
            'DRAW_TRANSITION_NOT_ALLOWED',
            `A ${draw.status} draw cannot be published.`,
          );
        }
        const [prizes, question] = await Promise.all([
          this.draws.prizes(trx, [draw.id]),
          draw.skillQuestionId ? this.draws.skillQuestion(trx, draw.skillQuestionId) : null,
        ]);
        const blockers = publishBlockers(
          {
            winnerPositions: draw.winnerPositions,
            closesAt: draw.closesAt,
            prizePositions: (prizes.get(draw.id) ?? []).map((p) => p.position),
            skillQuestion: question,
          },
          new Date(),
        );
        if (blockers.length > 0) throw notPublishable(blockers);
        await this.draws.publish(trx, draw.id);
      },
      input.reason ?? null,
    );
  }

  cancel(
    marketCode: string,
    id: string,
    input: CancelDrawRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminDraw> {
    return this.change(
      marketCode,
      id,
      auth,
      meta,
      'draw.cancelled',
      async (trx, draw) => {
        if (!canCancel(draw.status)) {
          throw Errors.conflict(
            'DRAW_TRANSITION_NOT_ALLOWED',
            draw.status === 'live'
              ? 'A live draw cannot be cancelled: the policy for cancelling live draws is not decided yet (O6).'
              : `A ${draw.status} draw cannot be cancelled.`,
          );
        }
        await this.draws.cancel(trx, draw.id, draw.status);
      },
      input.reason,
    );
  }

  /** Lock → rule check + write → re-read → audit (before/after), in one transaction. */
  private change(
    marketCode: string,
    id: string,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    apply: (trx: DbExecutor, draw: DrawRecord) => Promise<void>,
    reason: string | null = null,
  ): Promise<AdminDraw> {
    return this.run(async (trx) => {
      const market = await this.market(trx, marketCode);
      const before = await this.draws.findByIdForUpdate(trx, market.id, id);
      if (!before) throw Errors.notFound('Draw');
      await apply(trx, before);
      const after = (await this.draws.findById(trx, market.id, id))!;
      await this.record(
        trx,
        auth,
        meta,
        action,
        market,
        after,
        snapshot(before),
        snapshot(after),
        reason,
      );
      return this.toAdmin(trx, market, after);
    });
  }

  private async run<T>(fn: (trx: DbExecutor) => Promise<T>): Promise<T> {
    try {
      return await withTransaction(this.db, fn);
    } catch (error) {
      throw mapDrawViolation(error);
    }
  }

  private async market(db: DbExecutor, code: string): Promise<MarketRecord> {
    const market = /^[a-z]{2}$/.test(code) ? await this.markets.findByCode(db, code) : null;
    if (!market) throw Errors.notFound('Market');
    return market;
  }

  private record(
    trx: DbExecutor,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    market: MarketRecord,
    draw: DrawRecord,
    before: Json | null,
    after: Json | null,
    reason: string | null = null,
  ) {
    return this.audit.record(trx, {
      actor: { type: 'user', userId: auth.userId },
      action,
      entityType: 'draw',
      entityId: draw.id,
      marketId: market.id,
      reason,
      before,
      after,
      meta,
    });
  }

  private async toAdmin(
    db: DbExecutor,
    market: MarketRecord,
    draw: DrawRecord,
  ): Promise<AdminDraw> {
    const [prizes, question, blockers] = await Promise.all([
      this.draws.prizes(db, [draw.id]),
      draw.skillQuestionId ? this.draws.skillQuestion(db, draw.skillQuestionId) : null,
      draw.status === 'draft' ? this.draws.publishBlockers(db, draw.id) : Promise.resolve([]),
    ]);
    return {
      id: draw.id,
      market: market.code,
      slug: draw.slug,
      title: draw.title,
      description: draw.description,
      status: draw.status,
      effectiveStatus: effectiveStatus(draw, new Date()),
      currency: draw.currency,
      ticketPriceMinor: draw.ticketPriceMinor,
      totalTickets: draw.totalTickets,
      maxPerPerson: draw.maxPerPerson,
      winnerPositions: draw.winnerPositions,
      opensAt: draw.opensAt.toISOString(),
      closesAt: draw.closesAt.toISOString(),
      publishedAt: draw.publishedAt?.toISOString() ?? null,
      closedAt: draw.closedAt?.toISOString() ?? null,
      cancelledAt: draw.cancelledAt?.toISOString() ?? null,
      prizes: prizes.get(draw.id) ?? [],
      skillQuestion: question ? { prompt: question.prompt, options: question.options } : null,
      publishBlockers: blockers,
      createdAt: draw.createdAt.toISOString(),
      updatedAt: draw.updatedAt.toISOString(),
    };
  }
}

function toValues(input: DrawConfigRequest): DrawValues {
  return {
    slug: input.slug,
    title: input.title,
    description: input.description,
    ticketPriceMinor: input.ticketPriceMinor,
    totalTickets: input.totalTickets,
    maxPerPerson: input.maxPerPerson,
    winnerPositions: input.winnerPositions,
    opensAt: new Date(input.opensAt),
    closesAt: new Date(input.closesAt),
  };
}

function assertValid(values: DrawValues): void {
  const problems = validateDrawConfig(values);
  if (problems.length > 0) {
    throw Errors.validation({
      issues: problems.map((p) => ({ path: p.field, message: p.message })),
    });
  }
}

function requireDraft(draw: DrawRecord): void {
  if (!isEditable(draw.status)) {
    throw Errors.conflict(
      'DRAW_NOT_EDITABLE',
      `A ${draw.status} draw can no longer be edited (changes after publishing are not decided yet, O9).`,
    );
  }
}

function notPublishable(blockers: readonly string[]): AppError {
  return Errors.conflict(
    'DRAW_NOT_PUBLISHABLE',
    `The draw cannot be published yet: ${blockers.join(', ')}.`,
    { blockers },
  );
}

function snapshot(draw: DrawRecord): Json {
  return {
    status: draw.status,
    slug: draw.slug,
    title: draw.title,
    ticketPriceMinor: draw.ticketPriceMinor,
    totalTickets: draw.totalTickets,
    maxPerPerson: draw.maxPerPerson,
    winnerPositions: draw.winnerPositions,
    opensAt: draw.opensAt.toISOString(),
    closesAt: draw.closesAt.toISOString(),
    skillQuestionId: draw.skillQuestionId,
  };
}

/** A concurrent change can still trip a database rule; report it as the same domain error. */
function mapDrawViolation(error: unknown): unknown {
  if (isUniqueViolation(error, 'draws_market_slug_key')) {
    return Errors.conflict(
      'DRAW_SLUG_TAKEN',
      'Another draw in this market already uses this slug.',
    );
  }
  if (isConstraintViolation(error, 'draws_publish_requirements')) {
    return notPublishable(violationDetailList(error));
  }
  if (isConstraintViolation(error, 'draws_configuration_locked')) {
    return Errors.conflict('DRAW_NOT_EDITABLE', 'The draw can no longer be edited.');
  }
  if (isConstraintViolation(error, 'draws_status_transition')) {
    return Errors.conflict('DRAW_TRANSITION_NOT_ALLOWED', 'That status change is not allowed.');
  }
  return error;
}
