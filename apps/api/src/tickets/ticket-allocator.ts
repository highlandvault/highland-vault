import { Inject, Injectable } from '@nestjs/common';
import { type Database, type DbExecutor, lockEntrantEmail, withTransaction } from '@hv/db';
import { ReservationRefused } from '@hv/domain';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATABASE } from '../database/database.module';
import {
  type AllocatableDraw,
  AllocationContended,
  type EntrantRef,
  TicketsRepository,
} from './tickets.repository';
import { UsersRepository } from '../users/users.repository';

/**
 * Who is asking to reserve, before the cap identity is resolved.
 *
 * A guest supplies the address they verified rather than a resolved key: the
 * key depends on whether an account owns that address, and that question can
 * only be answered safely inside the allocating transaction (ADR-0021).
 */
export type EntrantIntent =
  { kind: 'user'; userId: string } | { kind: 'verifiedEmail'; email: string };

/** Attempts per request when the remaining tickets are locked by concurrent buyers. */
const MAX_ATTEMPTS = 5;

/**
 * Owns the allocation transaction (Revision 2 B9). One attempt = one
 * transaction running TicketsRepository.allocate.
 *
 * SKIP LOCKED keeps buyers from waiting on each other, but near exhaustion two
 * buyers can each lock part of the last tickets and both come up short. When
 * committed availability shows enough tickets, the attempt is retried after a
 * short random pause, so one of them gets the tickets instead of neither. If
 * the tickets are really gone, the refusal is final at once.
 */
@Injectable()
export class TicketAllocator {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tickets: TicketsRepository,
    private readonly users: UsersRepository,
  ) {}

  async reserve(
    draw: AllocatableDraw,
    intent: EntrantIntent,
    quantity: number,
    ttlSeconds: number,
  ): Promise<{ reservationId: string; ticketNumbers: number[] }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await withTransaction(this.db, async (trx) => {
          // Resolved INSIDE the transaction (ADR-0021). Asking outside it
          // means the answer can be stale before it is used: a registration
          // committing in between would leave this hold on the email key while
          // the account holds the counter.
          const entrant = await this.resolveEntrant(trx, intent);
          return this.tickets.allocate(trx, draw, entrant, quantity, ttlSeconds);
        });
      } catch (error) {
        if (!(error instanceof AllocationContended)) throw error;
        if (attempt >= MAX_ATTEMPTS) {
          throw new ReservationRefused(
            'insufficient_tickets',
            'The last tickets are being taken right now. Please try again.',
            { requested: quantity },
          );
        }
        await sleep(5 + Math.floor(Math.random() * 20 * attempt));
      }
    }
  }

  /**
   * Who the cap is charged to (ADR-0008, ADR-0021).
   *
   * A signed-in customer is their own account. A guest is charged to the
   * account that owns the address they verified, if there is one — otherwise
   * to the address itself. That is what stops someone buying to the cap as a
   * guest and again as the account with the same email.
   *
   * The entrant lock is taken first for the guest case, so a registration for
   * the same address either commits before this lookup and is seen, or waits
   * until this hold exists and bridges it.
   */
  private async resolveEntrant(trx: DbExecutor, intent: EntrantIntent): Promise<EntrantRef> {
    if (intent.kind === 'user') {
      return { type: 'user', ref: intent.userId, userId: intent.userId };
    }
    await lockEntrantEmail(trx, intent.email);
    const account = await this.users.findByEmail(trx, intent.email);
    return account
      ? { type: 'user', ref: account.id, userId: account.id }
      : { type: 'email', ref: intent.email, userId: null };
  }
}
