import { Inject, Injectable } from '@nestjs/common';
import { type Database, withTransaction } from '@hv/db';
import { ReservationRefused } from '@hv/domain';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATABASE } from '../database/database.module';
import {
  type AllocatableDraw,
  AllocationContended,
  type EntrantRef,
  TicketsRepository,
} from './tickets.repository';

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
  ) {}

  async reserve(
    draw: AllocatableDraw,
    entrant: EntrantRef,
    quantity: number,
    ttlSeconds: number,
  ): Promise<{ reservationId: string; ticketNumbers: number[] }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await withTransaction(this.db, (trx) =>
          this.tickets.allocate(trx, draw, entrant, quantity, ttlSeconds),
        );
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
}
