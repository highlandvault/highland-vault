import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';

export interface BridgeResult {
  /** Counter rows moved from the email key to the account. */
  readonly counters: number;
  /** Live holds re-keyed with them. */
  readonly reservations: number;
  /** Tickets those counters represent, for the audit entry. */
  readonly tickets: number;
}

/**
 * Guest → account ticket-cap bridging (ADR-0021).
 *
 * When someone registers with the address they verified as a guest, the cap
 * they already used has to follow them. Otherwise they buy up to the cap as a
 * guest and again as the account, which is the whole reason ADR-0008 keys the
 * cap on a VERIFIED email in the first place.
 *
 * The counters and the live reservations move TOGETHER, in one transaction.
 * They have to: `hv_end_reservation` gives the allowance back using the key
 * stored on the reservation, so a counter that moved without its reservation
 * would never be decremented again — the tickets would come back but the
 * allowance would not.
 */
@Injectable()
export class CapBridgingRepository {
  /**
   * Moves everything held under `normalizedEmail` onto `userId`.
   *
   * The caller must already hold the entrant lock for this address and be
   * inside the transaction that created the account.
   */
  async bridge(trx: DbExecutor, normalizedEmail: string, userId: string): Promise<BridgeResult> {
    // Locked first, so nothing can be added to these counters while they move.
    // A guest allocation racing this is serialised by the entrant lock, not by
    // this row lock — the row it would write may not exist yet.
    const { rows: counters } = await sql<{ draw_id: string; count: number }>`
      SELECT draw_id, count
        FROM draw_entrant_counts
       WHERE entrant_type = 'email' AND entrant_ref = ${normalizedEmail}
         AND count > 0
       FOR UPDATE
    `.execute(trx);

    if (counters.length === 0) {
      // Nothing held under the address: the ordinary case for a registration
      // with no guest history. Re-keying is still attempted below, because a
      // zero counter can coexist with an active hold only if something else
      // is wrong, and doing nothing quietly would hide it.
      const reservations = await this.rekeyReservations(trx, normalizedEmail, userId);
      return { counters: 0, reservations, tickets: 0 };
    }

    // The holds move with their counters, or the allowance is lost.
    const reservations = await this.rekeyReservations(trx, normalizedEmail, userId);

    // Summed onto whatever the account already holds. The total may exceed the
    // draw's cap, which is correct and not an error: it means this entrant may
    // buy no more, which is the invariant doing its job. There is no upper
    // CHECK on `count`, only `count >= 0`.
    await sql`
      INSERT INTO draw_entrant_counts (draw_id, entrant_type, entrant_ref, count)
      SELECT draw_id, 'user', ${userId}, count
        FROM draw_entrant_counts
       WHERE entrant_type = 'email' AND entrant_ref = ${normalizedEmail} AND count > 0
      ON CONFLICT (draw_id, entrant_type, entrant_ref)
      DO UPDATE SET count = draw_entrant_counts.count + EXCLUDED.count
    `.execute(trx);

    // Zeroed rather than deleted: hv_app has no DELETE here, and a zero row is
    // a truthful record that this address once held tickets in this draw.
    await sql`
      UPDATE draw_entrant_counts SET count = 0
       WHERE entrant_type = 'email' AND entrant_ref = ${normalizedEmail} AND count > 0
    `.execute(trx);

    return {
      counters: counters.length,
      reservations,
      tickets: counters.reduce((sum, row) => sum + row.count, 0),
    };
  }

  /**
   * Points this address's live holds at the account.
   *
   * Only active ones: a hold that has already ended gave its tickets back
   * under the old key, and the guard trigger refuses to re-key it.
   */
  private async rekeyReservations(
    trx: DbExecutor,
    normalizedEmail: string,
    userId: string,
  ): Promise<number> {
    const result = await sql<{ id: string }>`
      UPDATE reservations
         SET entrant_type = 'user', entrant_ref = ${userId}, user_id = ${userId}::uuid
       WHERE entrant_type = 'email' AND entrant_ref = ${normalizedEmail}
         AND status = 'active'
      RETURNING id
    `.execute(trx);
    return result.rows.length;
  }
}
