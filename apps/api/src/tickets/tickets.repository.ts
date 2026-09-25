import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';
import { ReservationRefused, type ReservationStatus, reservationTotal } from '@hv/domain';

/**
 * The request came up short only because concurrent buyers had the remaining
 * tickets locked (SKIP LOCKED skipped them). Retrying shortly will succeed or
 * see a definite answer; see TicketAllocator.
 */
export class AllocationContended extends Error {
  override readonly name = 'AllocationContended';
}

export interface EntrantRef {
  type: 'user' | 'email';
  ref: string;
  /** Set for signed-in customers; null for verified-email guests (Phase 5). */
  userId: string | null;
}

export interface AllocatableDraw {
  id: string;
  marketId: string;
  currency: 'GBP' | 'EUR';
  ticketPriceMinor: number;
  maxPerPerson: number;
}

export interface ReservationRecord {
  id: string;
  drawId: string;
  marketId: string;
  userId: string | null;
  status: ReservationStatus;
  quantity: number;
  currency: 'GBP' | 'EUR';
  unitPriceMinor: number;
  totalMinor: number;
  expiresAt: Date;
  createdAt: Date;
  endedAt: Date | null;
}

const RESERVATION_COLUMNS = [
  'r.id',
  'r.draw_id',
  'r.market_id',
  'r.user_id',
  'r.status',
  'r.quantity',
  'r.currency',
  'r.unit_price_minor',
  'r.total_minor',
  'r.expires_at',
  'r.created_at',
  'r.ended_at',
] as const;

/**
 * The ticket engine's data access (Revision 2 B9). `allocate` is THE
 * allocation function: reservations use it now, postal entries (Phase 10)
 * will reuse it. It must run inside the caller's transaction.
 */
@Injectable()
export class TicketsRepository {
  /**
   * Reserves exactly `quantity` tickets for the entrant, or throws
   * ReservationRefused and changes nothing (the caller's transaction rolls back).
   *
   *   1. lock only THIS entrant's counter row (other buyers never wait on it);
   *   2. refuse if the cap would be exceeded;
   *   3. take the lowest available numbers with FOR UPDATE SKIP LOCKED, so
   *      concurrent buyers skip each other's rows instead of waiting (ADR-0027);
   *   4. fewer rows than requested → refuse (never a partial reservation);
   *   5. mark them reserved for the new reservation and add to the counter.
   */
  async allocate(
    trx: DbExecutor,
    draw: AllocatableDraw,
    entrant: EntrantRef,
    quantity: number,
    ttlSeconds: number,
  ): Promise<{ reservationId: string; ticketNumbers: number[] }> {
    await trx
      .insertInto('draw_entrant_counts')
      .values({ draw_id: draw.id, entrant_type: entrant.type, entrant_ref: entrant.ref })
      .onConflict((oc) => oc.doNothing())
      .execute();
    const counter = await trx
      .selectFrom('draw_entrant_counts')
      .select('count')
      .where('draw_id', '=', draw.id)
      .where('entrant_type', '=', entrant.type)
      .where('entrant_ref', '=', entrant.ref)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (counter.count + quantity > draw.maxPerPerson) {
      throw new ReservationRefused(
        'cap_exceeded',
        `At most ${draw.maxPerPerson} entries per person; ${counter.count} already held.`,
        {
          held: counter.count,
          maxPerPerson: draw.maxPerPerson,
          allowance: Math.max(0, draw.maxPerPerson - counter.count),
        },
      );
    }

    const reservation = await trx
      .insertInto('reservations')
      .values({
        draw_id: draw.id,
        market_id: draw.marketId,
        currency: draw.currency,
        entrant_type: entrant.type,
        entrant_ref: entrant.ref,
        user_id: entrant.userId,
        quantity,
        unit_price_minor: draw.ticketPriceMinor,
        total_minor: reservationTotal(draw.ticketPriceMinor, quantity),
        expires_at: sql<Date>`now() + make_interval(secs => ${ttlSeconds})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const candidates = await trx
      .selectFrom('tickets')
      .select(['id', 'ticket_number'])
      .where('draw_id', '=', draw.id)
      .where('status', '=', 'available')
      .orderBy('ticket_number')
      .limit(quantity)
      .forUpdate()
      .skipLocked()
      .execute();
    if (candidates.length < quantity) {
      // Short: really sold out, or other buyers' in-flight transactions hold
      // rows we skipped? Committed availability tells the two apart.
      const available = await this.countAvailable(trx, draw.id);
      if (available >= quantity) throw new AllocationContended();
      throw new ReservationRefused(
        'insufficient_tickets',
        'Not enough tickets are available for that many entries.',
        { requested: quantity, available },
      );
    }

    const taken = await trx
      .updateTable('tickets')
      .set({ status: 'reserved', reservation_id: reservation.id })
      .where(
        'id',
        'in',
        candidates.map((t) => t.id),
      )
      .where('status', '=', 'available')
      .executeTakeFirst();
    if (Number(taken.numUpdatedRows) !== quantity) {
      // Unreachable while the rows are locked; a guard, not a code path.
      throw new Error('ticket allocation lost a locked row');
    }
    await trx
      .updateTable('draw_entrant_counts')
      .set((eb) => ({ count: eb('count', '+', quantity) }))
      .where('draw_id', '=', draw.id)
      .where('entrant_type', '=', entrant.type)
      .where('entrant_ref', '=', entrant.ref)
      .execute();

    return {
      reservationId: reservation.id,
      ticketNumbers: candidates.map((t) => t.ticket_number).sort((a, b) => a - b),
    };
  }

  /** Expires due reservations (of one draw, or all). Own transaction per call. */
  async expireDue(db: DbExecutor, drawId: string | null, limit: number): Promise<number> {
    const { rows } = await sql<{
      expired: number;
    }>`SELECT hv_expire_reservations(${drawId}::uuid, ${limit}) AS expired`.execute(db);
    return rows[0]?.expired ?? 0;
  }

  /** Ends an active reservation; false when it had already ended. */
  async end(
    db: DbExecutor,
    reservationId: string,
    status: 'released' | 'expired',
  ): Promise<boolean> {
    const { rows } = await sql<{
      ended: boolean;
    }>`SELECT hv_end_reservation(${reservationId}::uuid, ${status}) AS ended`.execute(db);
    return rows[0]?.ended ?? false;
  }

  /** A reservation of this market owned by this user, optionally locked. */
  async findOwned(
    db: DbExecutor,
    marketId: string,
    userId: string,
    reservationId: string,
    lock = false,
  ): Promise<ReservationRecord | null> {
    let query = db
      .selectFrom('reservations as r')
      .select(RESERVATION_COLUMNS)
      .where('r.id', '=', reservationId)
      .where('r.market_id', '=', marketId)
      .where('r.user_id', '=', userId);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row ? toReservation(row) : null;
  }

  /**
   * A reservation by id, with no ownership filter.
   *
   * For callers that have already established ownership by another route —
   * the basket reaches a reservation through a cart item, and the cart's owner
   * is checked before that (and again by the cart_items guard trigger). Not a
   * substitute for `findOwned` on a request that is handed a reservation id.
   */
  async findById(
    db: DbExecutor,
    reservationId: string,
    lock = false,
  ): Promise<ReservationRecord | null> {
    let query = db
      .selectFrom('reservations as r')
      .select(RESERVATION_COLUMNS)
      .where('r.id', '=', reservationId);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row ? toReservation(row) : null;
  }

  async listActiveOwned(
    db: DbExecutor,
    marketId: string,
    userId: string,
  ): Promise<ReservationRecord[]> {
    const rows = await db
      .selectFrom('reservations as r')
      .select(RESERVATION_COLUMNS)
      .where('r.market_id', '=', marketId)
      .where('r.user_id', '=', userId)
      .where('r.status', '=', 'active')
      .where('r.expires_at', '>', sql<Date>`now()`)
      .orderBy('r.created_at', 'desc')
      .limit(50)
      .execute();
    return rows.map(toReservation);
  }

  async ticketNumbers(db: DbExecutor, reservationId: string): Promise<number[]> {
    const rows = await db
      .selectFrom('tickets')
      .select('ticket_number')
      .where('reservation_id', '=', reservationId)
      .where('status', '=', 'reserved')
      .orderBy('ticket_number')
      .execute();
    return rows.map((r) => r.ticket_number);
  }

  /**
   * Reservations past their expiry that no sweep has ended yet. Reads treat
   * them as expired already (like effectiveReservationStatus), so a customer
   * never sees their allowance or the draw's availability held by a
   * reservation that has run out.
   */
  private overdue(db: DbExecutor, drawId: string) {
    return db
      .selectFrom('reservations')
      .where('draw_id', '=', drawId)
      .where('status', '=', 'active')
      .where('expires_at', '<=', sql<Date>`now()`);
  }

  /** Tickets free to reserve, counting those held by overdue reservations as free. */
  async countAvailable(db: DbExecutor, drawId: string): Promise<number> {
    const [available, overdue] = await Promise.all([
      db
        .selectFrom('tickets')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('draw_id', '=', drawId)
        .where('status', '=', 'available')
        .executeTakeFirstOrThrow(),
      this.overdue(db, drawId)
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('quantity'), eb.lit(0)).as('n'))
        .executeTakeFirstOrThrow(),
    ]);
    return Number(available.n) + Number(overdue.n);
  }

  /** Tickets the entrant holds in this draw, not counting overdue reservations. */
  async held(
    db: DbExecutor,
    drawId: string,
    entrant: Pick<EntrantRef, 'type' | 'ref'>,
  ): Promise<number> {
    const [counter, overdue] = await Promise.all([
      db
        .selectFrom('draw_entrant_counts')
        .select('count')
        .where('draw_id', '=', drawId)
        .where('entrant_type', '=', entrant.type)
        .where('entrant_ref', '=', entrant.ref)
        .executeTakeFirst(),
      this.overdue(db, drawId)
        .where('entrant_type', '=', entrant.type)
        .where('entrant_ref', '=', entrant.ref)
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('quantity'), eb.lit(0)).as('n'))
        .executeTakeFirstOrThrow(),
    ]);
    return Math.max(0, (counter?.count ?? 0) - Number(overdue.n));
  }

  /** Counts by effective state: overdue reservations count as expired and their tickets as available. */
  async inventory(db: DbExecutor, drawId: string) {
    const [tickets, reservations, overdue] = await Promise.all([
      db
        .selectFrom('tickets')
        .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
        .where('draw_id', '=', drawId)
        .groupBy('status')
        .execute(),
      db
        .selectFrom('reservations')
        .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
        .where('draw_id', '=', drawId)
        .groupBy('status')
        .execute(),
      this.overdue(db, drawId)
        .select([
          (eb) => eb.fn.countAll<number>().as('reservations'),
          (eb) => eb.fn.coalesce(eb.fn.sum<number>('quantity'), eb.lit(0)).as('tickets'),
        ])
        .executeTakeFirstOrThrow(),
    ]);
    const count = (rows: { status: string; n: number }[], status: string) =>
      Number(rows.find((r) => r.status === status)?.n ?? 0);
    const overdueTickets = Number(overdue.tickets);
    const overdueReservations = Number(overdue.reservations);
    return {
      total: tickets.reduce((sum, r) => sum + Number(r.n), 0),
      available: count(tickets, 'available') + overdueTickets,
      reserved: count(tickets, 'reserved') - overdueTickets,
      sold: count(tickets, 'sold'),
      reservations: {
        active: count(reservations, 'active') - overdueReservations,
        released: count(reservations, 'released'),
        expired: count(reservations, 'expired') + overdueReservations,
      },
    };
  }
}

function toReservation(row: {
  id: string;
  draw_id: string;
  market_id: string;
  user_id: string | null;
  status: string;
  quantity: number;
  currency: string;
  unit_price_minor: number;
  total_minor: number;
  expires_at: Date;
  created_at: Date;
  ended_at: Date | null;
}): ReservationRecord {
  if (
    (row.status !== 'active' && row.status !== 'released' && row.status !== 'expired') ||
    (row.currency !== 'GBP' && row.currency !== 'EUR')
  ) {
    throw new Error(`unexpected reservation row ${row.id}`);
  }
  return {
    id: row.id,
    drawId: row.draw_id,
    marketId: row.market_id,
    userId: row.user_id,
    status: row.status,
    quantity: row.quantity,
    currency: row.currency,
    unitPriceMinor: row.unit_price_minor,
    totalMinor: row.total_minor,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}
