import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';
import type { SealedPayload } from '@hv/domain';

export interface PaymentEventRecord {
  readonly id: string;
  readonly provider: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerReference: string | null;
  readonly paymentId: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly providerStatus: string | null;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly lastError: string | null;
}

const EVENT_COLUMNS = [
  'id',
  'provider',
  'provider_event_id',
  'event_type',
  'provider_reference',
  'payment_id',
  'amount_minor',
  'currency',
  'provider_status',
  'received_at',
  'processed_at',
  'last_error',
] as const;

@Injectable()
export class PaymentEventsRepository {
  /**
   * Records an event, or returns null because it has already been recorded.
   *
   * `ON CONFLICT (provider, provider_event_id) DO NOTHING` is the replay
   * protection for the whole phase (I3). A provider that delivers the same
   * event ten times inserts once and conflicts nine times, and the caller can
   * answer the nine immediately without looking at anything else.
   *
   * It is the database that decides, not a read-then-insert: ten simultaneous
   * deliveries of one event all reach this statement, and exactly one of them
   * gets a row back.
   *
   * The sealed payload is written here and nowhere else. It is never read by a
   * customer-facing path.
   */
  async insertIfNew(
    db: DbExecutor,
    event: {
      provider: string;
      providerEventId: string;
      eventType: string;
      providerReference: string;
      paymentId: string | null;
      amountMinor: number;
      currency: string;
      providerStatus: string;
      payloadSealed: SealedPayload;
    },
  ): Promise<PaymentEventRecord | null> {
    const { rows } = await sql<EventRow>`
      INSERT INTO payment_events (
        provider, provider_event_id, event_type, provider_reference, payment_id,
        amount_minor, currency, provider_status, payload_sealed
      ) VALUES (
        ${event.provider}, ${event.providerEventId}, ${event.eventType},
        ${event.providerReference}, ${event.paymentId}::uuid,
        ${event.amountMinor}, ${event.currency}, ${event.providerStatus},
        ${JSON.stringify(event.payloadSealed)}::jsonb
      )
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING ${sql.raw(EVENT_COLUMNS.join(', '))}
    `.execute(db);
    return rows[0] ? toEvent(rows[0]) : null;
  }

  /**
   * Marks an event as needing nothing further, with an optional reason.
   *
   * Conditional on it not already being settled, so a retry that arrives
   * alongside the first pass changes nothing rather than colliding with the
   * guard's settle-once rule.
   */
  async settle(db: DbExecutor, id: string, reason: string | null): Promise<void> {
    await sql`
      UPDATE payment_events
         SET processed_at = now(), last_error = ${reason}
       WHERE id = ${id}::uuid AND processed_at IS NULL
    `.execute(db);
  }

  /** Records why an event could not be handled, leaving it to be retried. */
  async recordError(db: DbExecutor, id: string, reason: string): Promise<void> {
    await sql`
      UPDATE payment_events SET last_error = ${reason}
       WHERE id = ${id}::uuid AND processed_at IS NULL
    `.execute(db);
  }

  async findById(db: DbExecutor, id: string): Promise<PaymentEventRecord | null> {
    const row = await db
      .selectFrom('payment_events')
      .select(EVENT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toEvent(row) : null;
  }

  /** An attempt's events, oldest first. For support and for tests. */
  async listForPayment(db: DbExecutor, paymentId: string): Promise<PaymentEventRecord[]> {
    const rows = await db
      .selectFrom('payment_events')
      .select(EVENT_COLUMNS)
      .where('payment_id', '=', paymentId)
      .orderBy('received_at')
      .execute();
    return rows.map(toEvent);
  }
}

interface EventRow {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  provider_reference: string | null;
  payment_id: string | null;
  amount_minor: string | number | null;
  currency: string | null;
  provider_status: string | null;
  received_at: Date;
  processed_at: Date | null;
  last_error: string | null;
}

function toEvent(row: EventRow): PaymentEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    providerReference: row.provider_reference,
    paymentId: row.payment_id,
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
    currency: row.currency,
    providerStatus: row.provider_status,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    lastError: row.last_error,
  };
}
