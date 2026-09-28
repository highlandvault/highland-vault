import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';

/** Why a refund exists. Short codes: counted and queried, not read as prose. */
export type RefundReason =
  /** Paid, and the tickets could not be delivered (D21, D23). */
  | 'unfulfillable'
  /** The provider captured money twice for one order (D22.3). */
  | 'duplicate_capture';

export type RefundStatus = 'raised' | 'succeeded' | 'failed';

export interface RefundRecord {
  readonly id: string;
  readonly orderId: string;
  readonly marketId: string;
  readonly paymentId: string | null;
  readonly provider: string;
  readonly providerRefundReference: string | null;
  readonly amountMinor: number;
  readonly currency: 'GBP' | 'EUR';
  readonly destination: string;
  readonly status: RefundStatus;
  readonly reason: string;
  readonly actorId: string | null;
  readonly idempotencyKey: string;
}

const REFUND_COLUMNS = [
  'id',
  'order_id',
  'market_id',
  'payment_id',
  'provider',
  'provider_refund_reference',
  'amount_minor',
  'currency',
  'destination',
  'status',
  'reason',
  'actor_id',
  'idempotency_key',
] as const;

/**
 * Refund records (B18; D15a, D15b, D21, D22.3, D23).
 *
 * A row here is a decision that money must go back, taken inside the
 * transaction that caused it. Whether the money HAS gone back is `status`, and
 * only a provider can move that.
 */
@Injectable()
export class RefundsRepository {
  /**
   * Raises a refund, or returns the one this key already raised.
   *
   * `ON CONFLICT (idempotency_key) DO NOTHING` is what makes a refund happen
   * once. The key is derived from the authoritative identity of the thing being
   * refunded, so a webhook delivered ten times and a reconciliation action
   * invoked twice all claim the same key — and the database, not a
   * read-then-insert, decides which of them wrote the row.
   *
   * Returns null when the key was already taken, which the caller reads as
   * "already raised, nothing more to do".
   *
   * The amount and currency are selected from the ORDER inside this statement.
   * No caller supplies them, so a refund cannot be raised for a number nobody
   * owed.
   */
  async raiseIfNew(
    db: DbExecutor,
    refund: {
      orderId: string;
      marketId: string;
      paymentId: string;
      provider: string;
      reason: RefundReason;
      idempotencyKey: string;
    },
  ): Promise<RefundRecord | null> {
    const { rows } = await sql<RefundRow>`
      INSERT INTO refunds (
        order_id, market_id, payment_id, provider,
        amount_minor, currency, destination, status, reason, actor_id, idempotency_key
      )
      SELECT o.id, o.market_id, ${refund.paymentId}::uuid, ${refund.provider},
             o.external_due_minor, o.currency, 'provider', 'raised',
             ${refund.reason},
             -- D15b: no human raised this.
             NULL,
             ${refund.idempotencyKey}
        FROM orders o
       WHERE o.id = ${refund.orderId}::uuid AND o.market_id = ${refund.marketId}::uuid
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING ${sql.raw(REFUND_COLUMNS.join(', '))}
    `.execute(db);
    return rows[0] ? toRefund(rows[0]) : null;
  }

  async findById(db: DbExecutor, id: string): Promise<RefundRecord | null> {
    const row = await db
      .selectFrom('refunds')
      .select(REFUND_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toRefund(row) : null;
  }

  async findByIdempotencyKey(db: DbExecutor, key: string): Promise<RefundRecord | null> {
    const row = await db
      .selectFrom('refunds')
      .select(REFUND_COLUMNS)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    return row ? toRefund(row) : null;
  }

  async listForOrder(db: DbExecutor, orderId: string): Promise<RefundRecord[]> {
    const rows = await db
      .selectFrom('refunds')
      .select(REFUND_COLUMNS)
      .where('order_id', '=', orderId)
      .orderBy('created_at')
      .execute();
    return rows.map(toRefund);
  }

  /**
   * Records what the provider said about a raised refund.
   *
   * Conditional on it still being `raised`, so a provider answering twice
   * settles it once and the guard's one-move rule is never reached in anger.
   */
  async settle(
    db: DbExecutor,
    id: string,
    outcome: { status: Exclude<RefundStatus, 'raised'>; providerRefundReference?: string },
  ): Promise<void> {
    await sql`
      UPDATE refunds
         SET status = ${outcome.status},
             provider_refund_reference =
               COALESCE(provider_refund_reference, ${outcome.providerRefundReference ?? null})
       WHERE id = ${id}::uuid AND status = 'raised'
    `.execute(db);
  }
}

interface RefundRow {
  id: string;
  order_id: string;
  market_id: string;
  payment_id: string | null;
  provider: string;
  provider_refund_reference: string | null;
  amount_minor: string | number;
  currency: string;
  destination: string;
  status: string;
  reason: string;
  actor_id: string | null;
  idempotency_key: string;
}

function toRefund(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    marketId: row.market_id,
    paymentId: row.payment_id,
    provider: row.provider,
    providerRefundReference: row.provider_refund_reference,
    amountMinor: Number(row.amount_minor),
    currency: row.currency as 'GBP' | 'EUR',
    destination: row.destination,
    status: row.status as RefundStatus,
    reason: row.reason,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
  };
}

/**
 * The idempotency key for a refund, derived from what is being refunded.
 *
 * Deterministic on purpose, and derived from the authoritative identity rather
 * than from anything a provider sent: an unfulfillable outcome belongs to the
 * ORDER, so it can only ever happen once; a duplicate capture belongs to the
 * provider EVENT that reported it, so two separate duplicate captures get two
 * refunds and ten deliveries of one get one.
 */
export const refundKeys = {
  unfulfillable: (orderId: string) => `refund:order:${orderId}:unfulfillable`,
  duplicateCapture: (paymentEventId: string) => `refund:event:${paymentEventId}:duplicate_capture`,
} as const;
