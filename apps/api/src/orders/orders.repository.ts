import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';

/** Who placed the order (B18): an account, or the address a guest verified. */
export type OrderBuyer = { kind: 'user'; userId: string } | { kind: 'guest'; email: string };

export interface OrderRecord {
  readonly id: string;
  readonly orderNumber: string;
  readonly marketId: string;
  readonly currency: 'GBP' | 'EUR';
  readonly buyer: OrderBuyer;
  readonly termsVersionId: string;
  readonly status: string;
  readonly totalMinor: number;
  readonly walletAppliedMinor: number;
  readonly externalDueMinor: number;
  readonly idempotencyKey: string;
  readonly idempotencyDigest: Buffer;
  readonly createdAt: Date;
  /** The payment deadline (D1 = B). Fixed at creation; never extended. */
  readonly expiresAt: Date;
}

export interface OrderItemRecord {
  readonly id: string;
  readonly drawId: string;
  readonly reservationId: string;
  readonly quantity: number;
  readonly currency: 'GBP' | 'EUR';
  readonly unitPriceMinor: number;
  readonly totalMinor: number;
  readonly skillAnswerOptionId: string | null;
}

const ORDER_COLUMNS = [
  'id',
  'order_number',
  'market_id',
  'currency',
  'user_id',
  'guest_email',
  'terms_version_id',
  'status',
  'total_minor',
  'wallet_applied_minor',
  'external_due_minor',
  'idempotency_key',
  'idempotency_digest',
  'created_at',
  'expires_at',
] as const;

@Injectable()
export class OrdersRepository {
  /**
   * Claims the idempotency key and writes the order, or does nothing because
   * the key is already taken.
   *
   * `ON CONFLICT DO NOTHING` on the UNIQUE key is what makes this safe under
   * concurrency: the database decides which of two simultaneous requests wins,
   * and the loser reads the winner's order instead of creating a second. A
   * read-then-insert would let both pass the check and both insert.
   *
   * Returns null when the key was already claimed.
   */
  async insertIfNew(
    db: DbExecutor,
    order: {
      orderNumber: string;
      marketId: string;
      currency: 'GBP' | 'EUR';
      buyer: OrderBuyer;
      termsVersionId: string;
      totalMinor: number;
      idempotencyKey: string;
      idempotencyDigest: Buffer;
      expiresAt: Date;
    },
  ): Promise<OrderRecord | null> {
    const { rows } = await sql<OrderRow>`
      INSERT INTO orders (
        order_number, market_id, currency, user_id, guest_email, terms_version_id,
        total_minor, wallet_applied_minor, external_due_minor,
        idempotency_key, idempotency_digest, expires_at
      ) VALUES (
        ${order.orderNumber}, ${order.marketId}, ${order.currency},
        ${order.buyer.kind === 'user' ? order.buyer.userId : null}::uuid,
        ${order.buyer.kind === 'guest' ? order.buyer.email : null}::citext,
        ${order.termsVersionId},
        ${order.totalMinor}, 0, ${order.totalMinor},
        ${order.idempotencyKey}, ${order.idempotencyDigest}, ${order.expiresAt}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING ${sql.raw(ORDER_COLUMNS.join(', '))}
    `.execute(db);
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async findByIdempotencyKey(db: DbExecutor, key: string): Promise<OrderRecord | null> {
    const row = await db
      .selectFrom('orders')
      .select(ORDER_COLUMNS)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    return row ? toOrder(row) : null;
  }

  /** An order of this market, by id. Ownership is the caller's to check. */
  async findById(db: DbExecutor, marketId: string, id: string): Promise<OrderRecord | null> {
    const row = await db
      .selectFrom('orders')
      .select(ORDER_COLUMNS)
      .where('market_id', '=', marketId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toOrder(row) : null;
  }

  async addItem(
    db: DbExecutor,
    item: {
      orderId: string;
      marketId: string;
      drawId: string;
      reservationId: string;
      quantity: number;
      currency: 'GBP' | 'EUR';
      unitPriceMinor: number;
      totalMinor: number;
      skillAnswerOptionId: string | null;
    },
  ): Promise<void> {
    await db
      .insertInto('order_items')
      .values({
        order_id: item.orderId,
        // From the order, never from the request: a line cannot be filed under
        // a market its order does not belong to.
        market_id: item.marketId,
        draw_id: item.drawId,
        reservation_id: item.reservationId,
        quantity: item.quantity,
        currency: item.currency,
        unit_price_minor: item.unitPriceMinor,
        total_minor: item.totalMinor,
        skill_answer_option_id: item.skillAnswerOptionId,
      })
      .execute();
  }

  async items(db: DbExecutor, orderId: string): Promise<OrderItemRecord[]> {
    const rows = await db
      .selectFrom('order_items')
      .select([
        'id',
        'draw_id',
        'reservation_id',
        'quantity',
        'currency',
        'unit_price_minor',
        'total_minor',
        'skill_answer_option_id',
      ])
      .where('order_id', '=', orderId)
      .orderBy('created_at')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      drawId: r.draw_id,
      reservationId: r.reservation_id,
      quantity: r.quantity,
      currency: r.currency as 'GBP' | 'EUR',
      unitPriceMinor: Number(r.unit_price_minor),
      totalMinor: Number(r.total_minor),
      skillAnswerOptionId: r.skill_answer_option_id,
    }));
  }

  /** The caller's own orders in this market, newest first. */
  async listForBuyer(db: DbExecutor, marketId: string, buyer: OrderBuyer): Promise<OrderRecord[]> {
    const query = db
      .selectFrom('orders')
      .select(ORDER_COLUMNS)
      .where('market_id', '=', marketId)
      .orderBy('created_at', 'desc')
      .limit(50);
    const rows = await (
      buyer.kind === 'user'
        ? query.where('user_id', '=', buyer.userId)
        : query.where('guest_email', '=', buyer.email)
    ).execute();
    return rows.map(toOrder);
  }

  /**
   * Whether an option is the correct answer to a question.
   *
   * The answer is compared in the database and only a boolean comes back, so
   * the correct option's identity never enters the API process at all, let
   * alone a response (B20).
   */
  async isCorrectAnswer(db: DbExecutor, questionId: string, optionId: string): Promise<boolean> {
    const { rows } = await sql<{ correct: boolean }>`
      SELECT is_correct AS correct
        FROM skill_question_options
       WHERE id = ${optionId} AND skill_question_id = ${questionId}
    `.execute(db);
    return rows[0]?.correct === true;
  }
}

interface OrderRow {
  id: string;
  order_number: string;
  market_id: string;
  currency: string;
  user_id: string | null;
  guest_email: string | null;
  terms_version_id: string;
  status: string;
  total_minor: string | number;
  wallet_applied_minor: string | number;
  external_due_minor: string | number;
  idempotency_key: string;
  idempotency_digest: Buffer;
  created_at: Date;
  expires_at: Date;
}

function toOrder(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    orderNumber: row.order_number,
    marketId: row.market_id,
    currency: row.currency as 'GBP' | 'EUR',
    buyer: row.user_id
      ? { kind: 'user', userId: row.user_id }
      : { kind: 'guest', email: row.guest_email! },
    termsVersionId: row.terms_version_id,
    status: row.status,
    totalMinor: Number(row.total_minor),
    walletAppliedMinor: Number(row.wallet_applied_minor),
    externalDueMinor: Number(row.external_due_minor),
    idempotencyKey: row.idempotency_key,
    idempotencyDigest: row.idempotency_digest,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
