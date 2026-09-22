import { Inject, Injectable } from '@nestjs/common';
import type { PublicDrawDetail, PublicDrawSummary } from '@hv/contracts';
import type { Database } from '@hv/db';
import { LISTED_STATUSES, effectiveStatus, isPublished } from '@hv/domain';
import { Errors } from '../common/errors';
import type { MarketContext } from '../common/request-context';
import { DATABASE } from '../database/database.module';
import { type DrawRecord, DrawsRepository } from './draws.repository';

type PublicStatus = PublicDrawSummary['status'];

/**
 * Customer-facing draws. The market has already passed MarketGuard (enabled
 * AND allowed by ENABLED_MARKETS); every query is scoped to that market, and
 * only published draws are ever returned.
 */
@Injectable()
export class DrawsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repository: DrawsRepository,
  ) {}

  /** Open and upcoming draws: open ones first (closing soonest), then upcoming (opening soonest). */
  async list(market: MarketContext): Promise<PublicDrawSummary[]> {
    const now = new Date();
    const draws = (await this.repository.listByMarket(this.db, market.id, LISTED_STATUSES))
      .map((draw) => ({ draw, status: effectiveStatus(draw, now) }))
      .filter(({ status }) => status === 'live' || status === 'scheduled');
    draws.sort((a, b) =>
      a.status !== b.status
        ? a.status === 'live'
          ? -1
          : 1
        : a.status === 'live'
          ? a.draw.closesAt.getTime() - b.draw.closesAt.getTime()
          : a.draw.opensAt.getTime() - b.draw.opensAt.getTime(),
    );
    const prizes = await this.repository.prizes(
      this.db,
      draws.map(({ draw }) => draw.id),
    );
    return draws.map(({ draw, status }) => ({
      ...publicBase(draw, status as PublicStatus),
      headlinePrize: prizes.get(draw.id)?.[0]?.title ?? null,
    }));
  }

  /** A published draw of this market by slug; anything else (unknown, draft, cancelled, other market) is 404. */
  async detail(market: MarketContext, slug: string): Promise<PublicDrawDetail> {
    const draw = await this.repository.findBySlug(this.db, market.id, slug);
    if (!draw || !isPublished(draw.status) || !draw.skillQuestionId) throw Errors.notFound('Draw');
    const [prizes, question] = await Promise.all([
      this.repository.prizes(this.db, [draw.id]),
      this.repository.publicSkillQuestion(this.db, draw.skillQuestionId),
    ]);
    if (!question) throw Errors.notFound('Draw');
    return {
      ...publicBase(draw, effectiveStatus(draw, new Date()) as PublicStatus),
      description: draw.description,
      prizes: prizes.get(draw.id) ?? [],
      skillQuestion: question,
    };
  }
}

function publicBase(draw: DrawRecord, status: PublicStatus) {
  return {
    slug: draw.slug,
    title: draw.title,
    status,
    currency: draw.currency,
    ticketPriceMinor: draw.ticketPriceMinor,
    totalTickets: draw.totalTickets,
    maxPerPerson: draw.maxPerPerson,
    winnerPositions: draw.winnerPositions,
    opensAt: draw.opensAt.toISOString(),
    closesAt: draw.closesAt.toISOString(),
  };
}
