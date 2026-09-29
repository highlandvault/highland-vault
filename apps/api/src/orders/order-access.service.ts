import { Inject, Injectable } from '@nestjs/common';
import { type Database, type DbExecutor, sql } from '@hv/db';
import { API_ENV, type ApiEnv } from '../config/env';
import { generateSessionToken, isWellFormedSessionToken, sha256 } from '../auth/tokens';
import { DATABASE } from '../database/database.module';

/** An order a token opened. Nothing about who holds it, because nobody does. */
export interface OrderAccessGrant {
  readonly orderId: string;
  readonly marketId: string;
}

/**
 * The return link (OD-2; owner decisions **D18 = B**, **D19 = A**, **D19a**).
 *
 * ## What it is for
 *
 * A guest proves their email address and that proof lasts thirty minutes. They
 * then leave for a payment provider, and by the time they come back the proof
 * may have lapsed, the browser may have closed, or they may be on a different
 * device. They still have to be able to see what happened to the order they
 * just paid for.
 *
 * Extending the email binding was rejected: a window stretched to cover a
 * payment is no longer a proof of address. So the return link carries its own
 * credential.
 *
 * ## What it is not
 *
 * **It authenticates nobody.** It is not a session, confers no cap identity,
 * reads and writes `guest_sessions.verified_email` in neither direction, and
 * **cannot start a payment** (D18 = B). A guest whose proof has lapsed can see
 * that their payment failed; to try again they must verify their address
 * again. That is the deliberate trade in choosing B over C, and it is why this
 * service has no method that mutates anything except revocation.
 *
 * Because a token is bound to one order and grants only reading, "must not
 * expose arbitrary orders" is a property of the schema — `UNIQUE (order_id)`
 * and a foreign key — rather than a check somebody has to remember to write.
 *
 * ## The plaintext
 *
 * Minted once, returned once, and never stored: the table holds SHA-256 and
 * nothing else, exactly as `guest_sessions` does. It is **never logged**. The
 * only place it legitimately exists after `issue` returns is the provider
 * return URL.
 */
@Injectable()
export class OrderAccessService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * The order's return link, minting one if it has none.
   *
   * One token per order (`UNIQUE (order_id)`), because D3 = B allows one live
   * payment attempt and a per-attempt token would only multiply the
   * credentials in circulation. A second call therefore returns **null** for
   * the plaintext — the existing token is still valid and its secret is gone,
   * which is the point of storing a hash.
   *
   * The expiry is computed **in SQL from the order's own deadline** plus the
   * configured tail, so it cannot drift with the API's clock, and it uses this
   * service's own configured value rather than the guest email window (D19a).
   */
  async issue(
    db: DbExecutor,
    orderId: string,
  ): Promise<{ token: string | null; existed: boolean }> {
    const token = generateSessionToken();
    const { rows } = await sql<{ id: string }>`
      INSERT INTO order_access_tokens (order_id, token_hash, expires_at)
      SELECT o.id, ${sha256(token)},
             o.expires_at + make_interval(mins => ${this.env.ORDER_ACCESS_TOKEN_TAIL_MINUTES})
        FROM orders o WHERE o.id = ${orderId}::uuid
      ON CONFLICT (order_id) DO NOTHING
      RETURNING id
    `.execute(db);
    // Nothing inserted means this order already has a link. The plaintext of
    // that one is not recoverable, and that is correct rather than awkward.
    return rows.length > 0 ? { token, existed: false } : { token: null, existed: true };
  }

  /**
   * The order a token opens, or null.
   *
   * Null covers every reason — malformed, unknown, revoked, expired — because
   * a caller acts identically on all of them and distinguishing them would
   * tell a prober which tokens exist. Expiry is decided by the database's
   * clock in the same statement that finds the row.
   */
  async resolve(db: DbExecutor, token: string): Promise<OrderAccessGrant | null> {
    // Checked before touching the database, so a malformed value costs nothing
    // and cannot reach a query.
    if (!isWellFormedSessionToken(token)) return null;
    const { rows } = await sql<{ order_id: string; market_id: string }>`
      SELECT t.order_id, o.market_id
        FROM order_access_tokens t
        JOIN orders o ON o.id = t.order_id
       WHERE t.token_hash = ${sha256(token)}
         AND t.revoked_at IS NULL
         AND t.expires_at > now()
    `.execute(db);
    const row = rows[0];
    return row ? { orderId: row.order_id, marketId: row.market_id } : null;
  }

  /** Withdraws a link. Once, and without erasing the record that it existed. */
  async revoke(db: DbExecutor, orderId: string): Promise<void> {
    await sql`
      UPDATE order_access_tokens SET revoked_at = now()
       WHERE order_id = ${orderId}::uuid AND revoked_at IS NULL
    `.execute(db);
  }

  /** The default executor, for callers with no transaction of their own. */
  get database(): Database {
    return this.db;
  }
}
