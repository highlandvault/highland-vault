import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';
import { type DrawStatus, isDrawStatus } from '@hv/domain';

/**
 * Data access for draws, prizes and skill questions. EVERY query is scoped by
 * market_id: a draw is only ever found through its own market (ADR-0004), so a
 * request for one market can never read or change another market's draw.
 */

export interface DrawRecord {
  id: string;
  marketId: string;
  currency: 'GBP' | 'EUR';
  slug: string;
  title: string;
  description: string;
  status: DrawStatus;
  ticketPriceMinor: number;
  totalTickets: number;
  maxPerPerson: number;
  winnerPositions: number;
  opensAt: Date;
  closesAt: Date;
  skillQuestionId: string | null;
  publishedAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PrizeRecord {
  position: number;
  title: string;
  description: string;
}

export interface SkillQuestionRecord {
  id: string;
  prompt: string;
  options: { id: string; label: string; isCorrect: boolean }[];
}

/** Public form: the correct answer is not even selected from the database. */
export interface PublicSkillQuestionRecord {
  prompt: string;
  options: { id: string; label: string }[];
}

export interface DrawValues {
  slug: string;
  title: string;
  description: string;
  ticketPriceMinor: number;
  totalTickets: number;
  maxPerPerson: number;
  winnerPositions: number;
  opensAt: Date;
  closesAt: Date;
}

const DRAW_COLUMNS = [
  'd.id',
  'd.market_id',
  'd.currency',
  'd.slug',
  'd.title',
  'd.description',
  'd.status',
  'd.ticket_price_minor',
  'd.total_tickets',
  'd.max_per_person',
  'd.winner_positions',
  'd.opens_at',
  'd.closes_at',
  'd.skill_question_id',
  'd.published_at',
  'd.closed_at',
  'd.cancelled_at',
  'd.created_at',
  'd.updated_at',
] as const;

@Injectable()
export class DrawsRepository {
  private draws(db: DbExecutor) {
    return db.selectFrom('draws as d').select(DRAW_COLUMNS);
  }

  async listByMarket(
    db: DbExecutor,
    marketId: string,
    statuses?: readonly DrawStatus[],
  ): Promise<DrawRecord[]> {
    let query = this.draws(db).where('d.market_id', '=', marketId);
    if (statuses) query = query.where('d.status', 'in', [...statuses]);
    const rows = await query.orderBy('d.closes_at').orderBy('d.id').execute();
    return rows.map(toDraw);
  }

  async findBySlug(db: DbExecutor, marketId: string, slug: string): Promise<DrawRecord | null> {
    const row = await this.draws(db)
      .where('d.market_id', '=', marketId)
      .where('d.slug', '=', slug)
      .executeTakeFirst();
    return row ? toDraw(row) : null;
  }

  async findById(db: DbExecutor, marketId: string, id: string): Promise<DrawRecord | null> {
    const row = await this.draws(db)
      .where('d.market_id', '=', marketId)
      .where('d.id', '=', id)
      .executeTakeFirst();
    return row ? toDraw(row) : null;
  }

  /** Locks the draw for a change; concurrent admin changes to the same draw serialise. */
  async findByIdForUpdate(
    db: DbExecutor,
    marketId: string,
    id: string,
  ): Promise<DrawRecord | null> {
    const row = await this.draws(db)
      .where('d.market_id', '=', marketId)
      .where('d.id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row ? toDraw(row) : null;
  }

  async prizes(db: DbExecutor, drawIds: readonly string[]): Promise<Map<string, PrizeRecord[]>> {
    const result = new Map<string, PrizeRecord[]>();
    if (drawIds.length === 0) return result;
    const rows = await db
      .selectFrom('draw_prizes')
      .select(['draw_id', 'position', 'title', 'description'])
      .where('draw_id', 'in', [...drawIds])
      .orderBy('position')
      .execute();
    for (const row of rows) {
      const list = result.get(row.draw_id) ?? [];
      list.push({ position: row.position, title: row.title, description: row.description });
      result.set(row.draw_id, list);
    }
    return result;
  }

  async skillQuestion(db: DbExecutor, questionId: string): Promise<SkillQuestionRecord | null> {
    const question = await db
      .selectFrom('skill_questions')
      .select(['id', 'prompt'])
      .where('id', '=', questionId)
      .executeTakeFirst();
    if (!question) return null;
    const options = await db
      .selectFrom('skill_question_options')
      .select(['id', 'label', 'is_correct'])
      .where('skill_question_id', '=', questionId)
      .orderBy('position')
      .execute();
    return {
      id: question.id,
      prompt: question.prompt,
      options: options.map((o) => ({ id: o.id, label: o.label, isCorrect: o.is_correct })),
    };
  }

  async publicSkillQuestion(
    db: DbExecutor,
    questionId: string,
  ): Promise<PublicSkillQuestionRecord | null> {
    const question = await db
      .selectFrom('skill_questions')
      .select(['prompt'])
      .where('id', '=', questionId)
      .executeTakeFirst();
    if (!question) return null;
    const options = await db
      .selectFrom('skill_question_options')
      .select(['id', 'label']) // never is_correct
      .where('skill_question_id', '=', questionId)
      .orderBy('position')
      .execute();
    return { prompt: question.prompt, options };
  }

  async publishBlockers(db: DbExecutor, drawId: string): Promise<string[]> {
    const { rows } = await sql<{
      blockers: string[];
    }>`SELECT hv_draw_publish_blockers(${drawId}::uuid) AS blockers`.execute(db);
    return rows[0]?.blockers ?? [];
  }

  async insert(
    db: DbExecutor,
    market: { id: string; currency: 'GBP' | 'EUR' },
    values: DrawValues,
    createdBy: string,
  ): Promise<string> {
    const row = await db
      .insertInto('draws')
      .values({
        market_id: market.id,
        currency: market.currency,
        ...toColumns(values),
        created_by: createdBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async update(db: DbExecutor, id: string, values: DrawValues): Promise<void> {
    await db.updateTable('draws').set(toColumns(values)).where('id', '=', id).execute();
  }

  async replacePrizes(db: DbExecutor, drawId: string, prizes: readonly PrizeRecord[]) {
    await db.deleteFrom('draw_prizes').where('draw_id', '=', drawId).execute();
    if (prizes.length > 0) {
      await db
        .insertInto('draw_prizes')
        .values(prizes.map((p) => ({ draw_id: drawId, ...p })))
        .execute();
    }
  }

  /** Creates a question owned by the draw's market and attaches it; returns the previous question id. */
  async replaceSkillQuestion(
    db: DbExecutor,
    draw: DrawRecord,
    prompt: string,
    options: readonly { label: string; isCorrect: boolean }[],
  ): Promise<void> {
    const question = await db
      .insertInto('skill_questions')
      .values({ market_id: draw.marketId, prompt })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('skill_question_options')
      .values(
        options.map((o, index) => ({
          skill_question_id: question.id,
          position: index + 1,
          label: o.label,
          is_correct: o.isCorrect,
        })),
      )
      .execute();
    await db
      .updateTable('draws')
      .set({ skill_question_id: question.id })
      .where('id', '=', draw.id)
      .execute();
    if (draw.skillQuestionId) await this.deleteQuestionIfUnused(db, draw.skillQuestionId);
  }

  private async deleteQuestionIfUnused(db: DbExecutor, questionId: string): Promise<void> {
    const used = await db
      .selectFrom('draws')
      .select('id')
      .where('skill_question_id', '=', questionId)
      .limit(1)
      .executeTakeFirst();
    if (used) return;
    await db
      .deleteFrom('skill_question_options')
      .where('skill_question_id', '=', questionId)
      .execute();
    await db.deleteFrom('skill_questions').where('id', '=', questionId).execute();
  }

  async publish(db: DbExecutor, id: string): Promise<void> {
    await db
      .updateTable('draws')
      .set({ status: 'scheduled', published_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .execute();
  }

  async cancel(db: DbExecutor, id: string, from: DrawStatus): Promise<void> {
    await db
      .updateTable('draws')
      .set({ status: 'cancelled', cancelled_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('status', '=', from)
      .execute();
  }
}

function toColumns(values: DrawValues) {
  return {
    slug: values.slug,
    title: values.title,
    description: values.description,
    ticket_price_minor: values.ticketPriceMinor,
    total_tickets: values.totalTickets,
    max_per_person: values.maxPerPerson,
    winner_positions: values.winnerPositions,
    opens_at: values.opensAt,
    closes_at: values.closesAt,
  };
}

function toDraw(row: {
  id: string;
  market_id: string;
  currency: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  ticket_price_minor: number;
  total_tickets: number;
  max_per_person: number;
  winner_positions: number;
  opens_at: Date;
  closes_at: Date;
  skill_question_id: string | null;
  published_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): DrawRecord {
  if (!isDrawStatus(row.status) || (row.currency !== 'GBP' && row.currency !== 'EUR')) {
    throw new Error(`unexpected draw row ${row.id}: ${row.status}/${row.currency}`);
  }
  return {
    id: row.id,
    marketId: row.market_id,
    currency: row.currency,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    ticketPriceMinor: row.ticket_price_minor,
    totalTickets: row.total_tickets,
    maxPerPerson: row.max_per_person,
    winnerPositions: row.winner_positions,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    skillQuestionId: row.skill_question_id,
    publishedAt: row.published_at,
    closedAt: row.closed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
