/**
 * Order and payment-attempt expiry (Phase 6, task P6-5; owner decisions D1,
 * D3a, D11a = B, K-c).
 *
 * Two sweeps, deliberately separate, because they end different things.
 *
 * **Orders** stop being payable at `orders.expires_at` (D1 = B). A lapsed order
 * goes to `expired` and its customer is told. That is the end of the order.
 *
 * **Attempts** stop being usable at `payments.expires_at`, 120 seconds after
 * they start (D3a). A lapsed attempt goes to `expired` and **the order is not
 * touched**: at most one attempt may be live per order, so an attempt that is
 * never closed blocks the customer's next try, and closing it is what lets
 * them have one. It is not a statement that they failed to pay.
 *
 * **No provider is called before either sweep, and that is D11a = B.** The
 * reservation-expiry sweep next door works the same way, for the same reason,
 * and `reservation-expiry.ts` records the dependency that makes it safe.
 *
 * **Nothing here emits `order.payment_failed`.** The topic exists and has a
 * handler; what would make an ORDER failed is K-c and is still an open owner
 * decision. An attempt expiring is not it — under D3 = B the customer may
 * start another attempt while their deadline holds, and a sweep that failed
 * the order would take that away from them.
 */
import { type Database, sql, withTransaction } from '@hv/db';
import { ORDER_EXPIRED_TOPIC } from '@hv/domain';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

export const PAYMENTS_QUEUE = 'payments';
export const EXPIRE_ORDERS_JOB = 'expire-orders';
export const EXPIRE_ATTEMPTS_JOB = 'expire-attempts';
export const EXPIRE_ORDERS_SCHEDULER_ID = 'payments-expire-orders';
export const EXPIRE_ATTEMPTS_SCHEDULER_ID = 'payments-expire-attempts';
/** D12a's cadence, shared by every job on this queue. */
export const PAYMENTS_INTERVAL_MS = 60_000;
/** Rows per transaction; a run repeats batches until a short one. */
export const EXPIRE_BATCH = 500;
const MAX_BATCHES = 20;

export interface ExpiredOrders {
  readonly expired: number;
}

export interface ExpiredAttempts {
  readonly expired: number;
}

/**
 * Moves lapsed orders to `expired`, announcing each one.
 *
 * The transition is conditional on `awaiting_payment`, so a concurrent
 * finalisation that just marked the order `paid` wins and this finds nothing —
 * which is the correct outcome, because the customer did pay. The audit row
 * and the outbox row are written in the same statement as the change, so an
 * order cannot be expired without both, and the announcement cannot exist
 * without the expiry (ADR-0028, I14).
 *
 * `orders_awaiting_expiry_idx` is the index this reads: partial on
 * `expires_at` where the status is `awaiting_payment`, created by 0019 for
 * exactly this.
 */
export async function expireOrders(db: Database, batch = EXPIRE_BATCH): Promise<ExpiredOrders> {
  let expired = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await withTransaction(db, async (trx) => {
      const { rows } = await sql<{ id: string }>`
        WITH due AS (
          SELECT id FROM orders
           WHERE status = 'awaiting_payment' AND expires_at <= now()
           ORDER BY expires_at
           LIMIT ${batch}
             FOR UPDATE SKIP LOCKED
        ), changed AS (
          UPDATE orders o SET status = 'expired'
            FROM due
           WHERE o.id = due.id AND o.status = 'awaiting_payment'
          RETURNING o.id, o.order_number, o.market_id
        ), audited AS (
          INSERT INTO audit_log (actor_type, action, entity_type, entity_id, market_id, before, after)
          SELECT 'system', 'order.expired', 'order', id::text, market_id,
                 '{"status":"awaiting_payment"}'::jsonb, '{"status":"expired"}'::jsonb
            FROM changed
        ), announced AS (
          INSERT INTO outbox (topic, payload)
          SELECT ${ORDER_EXPIRED_TOPIC},
                 jsonb_build_object('orderId', id, 'orderNumber', order_number)
            FROM changed
        )
        SELECT id FROM changed`.execute(trx);
      return rows.length;
    });
    expired += n;
    if (n < batch) break;
  }
  return { expired };
}

/**
 * Closes payment attempts that ran out of time (D3a).
 *
 * `hv_payments_guard` allows `pending`/`processing` → `expired` and nothing
 * out of a terminal status, so this can neither resurrect a finished attempt
 * nor overwrite a successful one. The condition says the same thing in the
 * statement, so a race with the customer's own retry — which closes a lapsed
 * attempt itself, in `PaymentsService.initiate` — produces one transition
 * between them rather than a conflict.
 *
 * The ORDER is deliberately not read and not written here.
 */
export async function expireAttempts(db: Database, batch = EXPIRE_BATCH): Promise<ExpiredAttempts> {
  let expired = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await withTransaction(db, async (trx) => {
      const { rows } = await sql<{ id: string }>`
        WITH due AS (
          SELECT id FROM payments
           WHERE status IN ('pending', 'processing') AND expires_at <= now()
           ORDER BY expires_at
           LIMIT ${batch}
             FOR UPDATE SKIP LOCKED
        )
        UPDATE payments p
           SET status = 'expired',
               failure_code = COALESCE(p.failure_code, 'ATTEMPT_TIMED_OUT'),
               failure_message = COALESCE(p.failure_message, 'The payment was not completed in time.')
          FROM due
         WHERE p.id = due.id AND p.status IN ('pending', 'processing')
        RETURNING p.id`.execute(trx);
      return rows.length;
    });
    expired += n;
    if (n < batch) break;
  }
  return { expired };
}

export function createPaymentsQueue(connection: ConnectionOptions, name = PAYMENTS_QUEUE): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 },
  });
}

/** What one job on the payments queue came to. Reported for logs and tests. */
export type PaymentsJobResult =
  | { readonly job: 'expire-orders'; readonly expired: number }
  | { readonly job: 'expire-attempts'; readonly expired: number }
  | { readonly job: 'reconcile'; readonly checked: number; readonly failed: number }
  | { readonly job: 'retry-refunds'; readonly attempted: number };

export interface PaymentsWorkerOptions {
  readonly connection: ConnectionOptions;
  readonly db: Database;
  /** The reconciler, when one is configured. Absent leaves that job unhandled. */
  readonly reconcile?: (() => Promise<{ checked: number; failed: number }>) | undefined;
  /** Retries refunds still owed. Absent for the same reason as above. */
  readonly retryRefunds?: (() => Promise<{ attempted: number }>) | undefined;
  readonly queueName?: string;
}

export function createPaymentsWorker(
  options: PaymentsWorkerOptions,
): Worker<unknown, PaymentsJobResult> {
  return new Worker<unknown, PaymentsJobResult>(
    options.queueName ?? PAYMENTS_QUEUE,
    async (job) => {
      switch (job.name) {
        case EXPIRE_ORDERS_JOB:
          return { job: 'expire-orders', ...(await expireOrders(options.db)) };
        case EXPIRE_ATTEMPTS_JOB:
          return { job: 'expire-attempts', ...(await expireAttempts(options.db)) };
        case RECONCILE_JOB: {
          if (!options.reconcile) throw new Error('no reconciler is configured');
          return { job: 'reconcile', ...(await options.reconcile()) };
        }
        case RETRY_REFUNDS_JOB: {
          if (!options.retryRefunds) throw new Error('no refund retry is configured');
          return { job: 'retry-refunds', ...(await options.retryRefunds()) };
        }
        default:
          throw new Error(`Unknown payments job: ${job.name}`);
      }
    },
    // One at a time, like every other sweeper here. The work is idempotent, so
    // this is about not competing with the API for connections, not safety.
    { connection: options.connection, concurrency: 1 },
  );
}

export const RECONCILE_JOB = 'reconcile';
export const RECONCILE_SCHEDULER_ID = 'payments-reconcile';
export const RETRY_REFUNDS_JOB = 'retry-refunds';
export const RETRY_REFUNDS_SCHEDULER_ID = 'payments-retry-refunds';
