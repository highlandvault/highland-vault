/**
 * The payment reconciler (Phase 6, task P6-5; owner decisions OD-5, D12a, K-a).
 *
 * Every 60 seconds it asks the API about payments whose last state change falls
 * within the previous 5 minutes, and the API asks the provider. It exists
 * because **D3 = B allows one live attempt per order**: a payment stuck waiting
 * on a provider blocks the customer's retry until it times out, so this is part
 * of the ordinary path and not only a safety net for lost webhooks.
 *
 * **It owns no payment logic.** It selects candidates and makes one HTTP call
 * each. The provider call, the mapping and the finalisation all live in the
 * API, behind the internal listener, because the worker must never hold a
 * payment-provider secret (K-a) and because there must remain exactly one
 * implementation of finalisation.
 *
 * ## The worklist, and the field it depends on
 *
 * D12a says "payments whose last state change falls within the previous 5
 * minutes". That is `payments.updated_at`, and it is that only because **every
 * statement in the API that updates a payment row is a conditional status
 * transition**: a no-op matches no row, so the `updated_at` trigger never fires
 * without the status moving.
 *
 * That equivalence is a property of those call sites, not of the schema —
 * `hv_payments_guard` would happily permit a write that changed something else.
 * So: **nothing may write a "last checked" timestamp, or anything else, to a
 * payment row merely because it was examined.** Doing so would push
 * `updated_at` forward with no state change, and this worklist would re-arm
 * itself on its own writes for five minutes. A regression test in the API
 * asserts the property holds.
 *
 * Nothing in this file writes to the database at all.
 */
import { type Database, sql } from '@hv/db';

/** D12a: every 60 s, examining the previous 5 minutes of state changes. */
export const RECONCILE_LOOKBACK_SECONDS = 300;
/** Candidates per run. Older cases go to the operator endpoint, by D12a's design. */
export const RECONCILE_BATCH = 200;

export interface ReconcilerConfig {
  /** Where the API's internal listener is, e.g. `http://127.0.0.1:4001`. */
  readonly baseUrl: string;
  readonly token: string;
  readonly lookbackSeconds?: number;
  readonly batch?: number;
  readonly fetch?: typeof fetch;
}

export interface ReconcileRun {
  /** Attempts the API answered about, whatever the answer was. */
  readonly checked: number;
  /** Attempts it could not answer about. Nothing was changed for these. */
  readonly failed: number;
}

export const INTERNAL_TOKEN_HEADER = 'x-hv-internal-token';

/**
 * The attempts worth asking about.
 *
 * Read-only, and taken without a lock: the rows are not being changed here,
 * and a candidate that moves on between this query and the call simply produces
 * an idempotent no-op at the other end.
 */
export async function reconcileCandidates(
  db: Database,
  lookbackSeconds = RECONCILE_LOOKBACK_SECONDS,
  batch = RECONCILE_BATCH,
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM payments
     WHERE status IN ('pending', 'processing')
       AND updated_at > now() - make_interval(secs => ${lookbackSeconds})
     ORDER BY updated_at
     LIMIT ${batch}`.execute(db);
  return rows.map((r) => r.id);
}

/**
 * One reconciliation pass.
 *
 * **A failure for one attempt never abandons the batch.** Each call is
 * independent, and a provider that is down for one payment says nothing about
 * the next; the count of failures is returned so a run that is entirely failing
 * is visible rather than silent.
 *
 * If the API cannot be reached at all, every call fails, the job reports it,
 * and the next scheduled run re-derives its work from the database. Nothing is
 * queued, remembered or retried in Redis — there is no state here to lose.
 */
export async function reconcileOnce(
  db: Database,
  config: ReconcilerConfig,
  log?: { warn(message: string): void },
): Promise<ReconcileRun> {
  const call = config.fetch ?? fetch;
  const candidates = await reconcileCandidates(db, config.lookbackSeconds, config.batch);

  let checked = 0;
  let failed = 0;
  for (const paymentId of candidates) {
    try {
      const response = await call(`${config.baseUrl}/internal/payments/${paymentId}/reconcile`, {
        method: 'POST',
        headers: { [INTERNAL_TOKEN_HEADER]: config.token },
      });
      if (response.ok) {
        checked += 1;
      } else {
        // 503 means the provider could not be read and nothing was changed;
        // 404 means the attempt went away. Neither is this job's to fix.
        failed += 1;
        log?.warn(`reconciling payment ${paymentId} answered ${response.status}`);
      }
    } catch (error) {
      failed += 1;
      log?.warn(`reconciling payment ${paymentId} failed: ${(error as Error).message}`);
    }
  }
  return { checked, failed };
}

/**
 * Asks the API to retry every refund still owed (K-2, I25).
 *
 * One call, no candidate list: what is owed is a question for the database, and
 * the API already reads `refunds_unsettled_idx` to answer it. The worker
 * supplies the schedule and nothing else, for the same reason it does not make
 * the provider call — it holds no provider credential.
 *
 * Never throws. A retry sweep that could fail the job would turn "a provider is
 * down" into "the payments queue is broken".
 */
export async function retryRefundsOnce(
  config: ReconcilerConfig,
  log?: { warn(message: string): void },
): Promise<{ attempted: number }> {
  const call = config.fetch ?? fetch;
  try {
    const response = await call(`${config.baseUrl}/internal/refunds/retry`, {
      method: 'POST',
      headers: { [INTERNAL_TOKEN_HEADER]: config.token },
    });
    if (!response.ok) {
      log?.warn(`retrying refunds answered ${response.status}`);
      return { attempted: 0 };
    }
    const body = (await response.json()) as { attempted?: number };
    return { attempted: body.attempted ?? 0 };
  } catch (error) {
    log?.warn(`retrying refunds failed: ${(error as Error).message}`);
    return { attempted: 0 };
  }
}
