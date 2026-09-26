import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';

/** Where an attempt stands. Matches `payments_status_valid` and the provider port. */
export type PaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'expired';

export interface PaymentRecord {
  readonly id: string;
  readonly orderId: string;
  readonly marketId: string;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly amountMinor: number;
  readonly currency: 'GBP' | 'EUR';
  readonly status: PaymentStatus;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
  readonly failureCode: string | null;
  readonly createdAt: Date;
}

const PAYMENT_COLUMNS = [
  'id',
  'order_id',
  'market_id',
  'provider',
  'provider_reference',
  'amount_minor',
  'currency',
  'status',
  'idempotency_key',
  'expires_at',
  'failure_code',
  'created_at',
] as const;

@Injectable()
export class PaymentsRepository {
  /**
   * The order's live attempt, locked, or null.
   *
   * `FOR UPDATE` because the caller is deciding whether to reuse this attempt,
   * finish it, or create another, and all three depend on it not changing
   * underneath them. Two customers hammering "Pay" serialise here rather than
   * racing to insert against the one-live-attempt index.
   *
   * "Live" is `pending` or `processing` — exactly the partial unique index's
   * predicate, so what this returns is what would block an insert.
   */
  async findLiveForUpdate(db: DbExecutor, orderId: string): Promise<PaymentRecord | null> {
    const { rows } = await sql<PaymentRow>`
      SELECT ${sql.raw(PAYMENT_COLUMNS.join(', '))}
        FROM payments
       WHERE order_id = ${orderId} AND status IN ('pending', 'processing')
       FOR UPDATE
    `.execute(db);
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findById(db: DbExecutor, id: string): Promise<PaymentRecord | null> {
    const row = await db
      .selectFrom('payments')
      .select(PAYMENT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toPayment(row) : null;
  }

  async findByIdempotencyKey(db: DbExecutor, key: string): Promise<PaymentRecord | null> {
    const row = await db
      .selectFrom('payments')
      .select(PAYMENT_COLUMNS)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    return row ? toPayment(row) : null;
  }

  /**
   * Creates an attempt, or returns null because this idempotency key is taken.
   *
   * `ON CONFLICT DO NOTHING` on the key, exactly as order creation does it:
   * the database decides which of two simultaneous requests wins and the loser
   * reads the winner's row. There is no read-then-insert.
   *
   * Neither the amount nor the deadline is passed in.
   *
   * The amount is selected from the order inside this statement, so no caller
   * can supply one — and the composite foreign key would refuse it even if a
   * caller tried (I4, I5).
   *
   * The deadline is computed here too, in SQL, so it is measured against the
   * same clock as `created_at`. Computed in the application it would be a few
   * milliseconds adrift of it, and "an attempt lives at most 120 seconds"
   * would be approximately true instead of exactly true. `LEAST` with the
   * order's own deadline is what makes the order's clock always win (D3a).
   */
  async insertIfNew(
    db: DbExecutor,
    attempt: {
      orderId: string;
      marketId: string;
      provider: string;
      idempotencyKey: string;
      ttlSeconds: number;
    },
  ): Promise<PaymentRecord | null> {
    const { rows } = await sql<PaymentRow>`
      INSERT INTO payments (
        order_id, market_id, provider, amount_minor, currency, idempotency_key, expires_at
      )
      SELECT ${attempt.orderId}::uuid, ${attempt.marketId}::uuid, ${attempt.provider},
             o.external_due_minor, o.currency, ${attempt.idempotencyKey},
             LEAST(now() + (${attempt.ttlSeconds} * interval '1 second'), o.expires_at)
        FROM orders o
       WHERE o.id = ${attempt.orderId}::uuid AND o.market_id = ${attempt.marketId}::uuid
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING ${sql.raw(PAYMENT_COLUMNS.join(', '))}
    `.execute(db);
    return rows[0] ? toPayment(rows[0]) : null;
  }

  /**
   * Records the provider's reference once it has answered, and returns the row
   * as it now stands.
   *
   * Returning it matters: the caller describes this attempt to the customer,
   * and describing it from the record it held before this ran would report a
   * status the database has already moved on from.
   *
   * Set once, and only from `pending`, so a concurrent caller that already did
   * this changes nothing and the guard's set-once rule is never reached in
   * anger.
   */
  async attachProviderReference(
    db: DbExecutor,
    id: string,
    providerReference: string,
  ): Promise<PaymentRecord | null> {
    const { rows } = await sql<PaymentRow>`
      UPDATE payments
         SET provider_reference = ${providerReference}, status = 'processing'
       WHERE id = ${id}::uuid AND status = 'pending'
      RETURNING ${sql.raw(PAYMENT_COLUMNS.join(', '))}
    `.execute(db);
    return rows[0] ? toPayment(rows[0]) : null;
  }

  /**
   * Finishes a live attempt.
   *
   * Conditional on it still being live, so two callers deciding the same
   * attempt has lapsed produce one transition between them and the second
   * changes nothing.
   */
  async finish(
    db: DbExecutor,
    id: string,
    status: Extract<PaymentStatus, 'failed' | 'expired'>,
    failure: { code: string; message: string },
  ): Promise<boolean> {
    const { rows } = await sql<{ id: string }>`
      UPDATE payments
         SET status = ${status},
             failure_code = ${failure.code},
             failure_message = ${failure.message}
       WHERE id = ${id}::uuid AND status IN ('pending', 'processing')
      RETURNING id
    `.execute(db);
    return rows.length > 0;
  }

  /** An order's attempts, newest first. For support and for tests; never customer-facing. */
  async listForOrder(db: DbExecutor, orderId: string): Promise<PaymentRecord[]> {
    const rows = await db
      .selectFrom('payments')
      .select(PAYMENT_COLUMNS)
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toPayment);
  }
}

interface PaymentRow {
  id: string;
  order_id: string;
  market_id: string;
  provider: string;
  provider_reference: string | null;
  amount_minor: string | number;
  currency: string;
  status: string;
  idempotency_key: string;
  expires_at: Date;
  failure_code: string | null;
  created_at: Date;
}

function toPayment(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    marketId: row.market_id,
    provider: row.provider,
    providerReference: row.provider_reference,
    amountMinor: Number(row.amount_minor),
    currency: row.currency as 'GBP' | 'EUR',
    status: row.status as PaymentStatus,
    idempotencyKey: row.idempotency_key,
    expiresAt: row.expires_at,
    failureCode: row.failure_code,
    createdAt: row.created_at,
  };
}
