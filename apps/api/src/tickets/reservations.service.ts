import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AvailabilityResponse, Reservation } from '@hv/contracts';
import { type Database, withTransaction } from '@hv/db';
import {
  ReservationRefused,
  effectiveReservationStatus,
  entrantKey,
  isOpenForEntries,
  isPublished,
  isValidQuantity,
  remainingAllowance,
} from '@hv/domain';
import type { Redis } from 'ioredis';
import { RATE_LIMITS, RateLimiter } from '../auth/rate-limiter';
import { AppError, Errors } from '../common/errors';
import { isConstraintViolation } from '../common/pg-errors';
import type { AuthContext, MarketContext } from '../common/request-context';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { type DrawRecord, DrawsRepository } from '../draws/draws.repository';
import { REDIS } from '../redis/redis.module';
import { TicketAllocator } from './ticket-allocator';
import { type ReservationRecord, TicketsRepository } from './tickets.repository';

/** Revision 2 B9: availability is display-only and served from Redis for a few seconds. */
const AVAILABILITY_CACHE_SECONDS = 3;
/** Reservations expired on the way into an allocation (B9: "the allocation path also sweeps"). */
const INLINE_SWEEP_LIMIT = 200;

/**
 * Customer reservations (Revision 2 B9, ADR-0011). The market has passed
 * MarketGuard; the draw is always looked up inside that market. A reservation
 * is only ever visible to, and releasable by, the account that made it.
 *
 * Entrants in this phase are signed-in customers (cap key: user id). Guests
 * need a verified email first (ADR-0020, Phase 5); the allocation already
 * supports the email key.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly draws: DrawsRepository,
    private readonly tickets: TicketsRepository,
    private readonly allocator: TicketAllocator,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async reserve(
    market: MarketContext,
    slug: string,
    quantity: number,
    auth: AuthContext,
  ): Promise<Reservation> {
    await this.rateLimiter.consume(RATE_LIMITS.reservePerUser, auth.userId);
    const draw = await this.publishedDraw(market, slug);
    if (!isOpenForEntries(draw, new Date())) {
      throw Errors.conflict('DRAW_NOT_OPEN', 'This draw is not open for entries.');
    }
    if (!isValidQuantity(quantity, draw.maxPerPerson)) {
      throw new AppError(
        400,
        'INVALID_QUANTITY',
        `Choose between 1 and ${draw.maxPerPerson} entries.`,
        { maxPerPerson: draw.maxPerPerson },
      );
    }

    // Free this draw's expired reservations first, in their own transaction
    // (never inside the allocation, which would take other entrants' locks).
    await this.tickets.expireDue(this.db, draw.id, INLINE_SWEEP_LIMIT);

    const entrant = { ...entrantKey({ type: 'user', userId: auth.userId }), userId: auth.userId };
    let reservationId: string;
    try {
      ({ reservationId } = await this.allocator.reserve(
        draw,
        entrant,
        quantity,
        this.env.RESERVATION_TTL_SECONDS,
      ));
    } catch (error) {
      throw mapRefusal(error);
    }
    await this.forgetAvailability(draw.id);
    return this.get(market, reservationId, auth);
  }

  async get(market: MarketContext, reservationId: string, auth: AuthContext): Promise<Reservation> {
    const reservation = await this.tickets.findOwned(
      this.db,
      market.id,
      auth.userId,
      reservationId,
    );
    if (!reservation) throw Errors.notFound('Reservation');
    return this.toDto(market, reservation);
  }

  async listActive(market: MarketContext, auth: AuthContext): Promise<Reservation[]> {
    const reservations = await this.tickets.listActiveOwned(this.db, market.id, auth.userId);
    return Promise.all(reservations.map((r) => this.toDto(market, r)));
  }

  /**
   * Gives the tickets back. Idempotent: releasing an ended reservation changes
   * nothing and returns it as it is; one already past its expiry ends as expired.
   */
  async release(
    market: MarketContext,
    reservationId: string,
    auth: AuthContext,
  ): Promise<Reservation> {
    const drawId = await withTransaction(this.db, async (trx) => {
      const reservation = await this.tickets.findOwned(
        trx,
        market.id,
        auth.userId,
        reservationId,
        true,
      );
      if (!reservation) throw Errors.notFound('Reservation');
      if (reservation.status === 'active') {
        const ending = reservation.expiresAt <= new Date() ? 'expired' : 'released';
        await this.tickets.end(trx, reservation.id, ending);
      }
      return reservation.drawId;
    });
    await this.forgetAvailability(drawId);
    return this.get(market, reservationId, auth);
  }

  async availability(
    market: MarketContext,
    slug: string,
    auth: AuthContext | null,
  ): Promise<AvailabilityResponse> {
    const draw = await this.publishedDraw(market, slug);
    const available = await this.cachedAvailable(draw.id);
    let allowance: number | null = null;
    if (auth) {
      const held = await this.tickets.held(
        this.db,
        draw.id,
        entrantKey({ type: 'user', userId: auth.userId }),
      );
      allowance = remainingAllowance(held, draw.maxPerPerson);
    }
    return { available, total: draw.totalTickets, allowance };
  }

  private async publishedDraw(market: MarketContext, slug: string): Promise<DrawRecord> {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) throw Errors.notFound('Draw');
    const draw = await this.draws.findBySlug(this.db, market.id, slug);
    if (!draw || !isPublished(draw.status)) throw Errors.notFound('Draw');
    return draw;
  }

  /** Display-only count; falls back to the database if Redis is unavailable. */
  private async cachedAvailable(drawId: string): Promise<number> {
    const key = `hv:availability:${drawId}`;
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) return Number(cached);
    } catch (error) {
      this.logger.warn(`availability cache unavailable: ${(error as Error).message}`);
    }
    const available = await this.tickets.countAvailable(this.db, drawId);
    try {
      await this.redis.set(key, String(available), 'EX', AVAILABILITY_CACHE_SECONDS);
    } catch {
      // The count is still correct without the cache.
    }
    return available;
  }

  private async forgetAvailability(drawId: string): Promise<void> {
    try {
      await this.redis.del(`hv:availability:${drawId}`);
    } catch {
      // Expires on its own within a few seconds.
    }
  }

  private async toDto(market: MarketContext, reservation: ReservationRecord): Promise<Reservation> {
    const now = new Date();
    const status = effectiveReservationStatus(reservation.status, reservation.expiresAt, now);
    const [draw, ticketNumbers] = await Promise.all([
      this.draws.findById(this.db, market.id, reservation.drawId),
      status === 'active'
        ? this.tickets.ticketNumbers(this.db, reservation.id)
        : Promise.resolve([]),
    ]);
    if (!draw) throw Errors.notFound('Reservation');
    return {
      id: reservation.id,
      market: market.code,
      draw: { slug: draw.slug, title: draw.title, totalTickets: draw.totalTickets },
      status,
      quantity: reservation.quantity,
      ticketNumbers,
      currency: reservation.currency,
      unitPriceMinor: reservation.unitPriceMinor,
      totalMinor: reservation.totalMinor,
      expiresAt: reservation.expiresAt.toISOString(),
      createdAt: reservation.createdAt.toISOString(),
      endedAt: reservation.endedAt?.toISOString() ?? null,
      serverTime: now.toISOString(),
    };
  }
}

/** Domain refusals and database backstops become the same API errors. */
function mapRefusal(error: unknown): unknown {
  if (error instanceof ReservationRefused) {
    if (error.reason === 'cap_exceeded') {
      return Errors.conflict('TICKET_CAP_EXCEEDED', error.message, error.details);
    }
    if (error.reason === 'insufficient_tickets') {
      return Errors.conflict('INSUFFICIENT_TICKETS', error.message, error.details);
    }
    if (error.reason === 'draw_not_open') {
      return Errors.conflict('DRAW_NOT_OPEN', error.message);
    }
    return new AppError(400, 'INVALID_QUANTITY', error.message, error.details);
  }
  if (isConstraintViolation(error, 'reservations_draw_open')) {
    return Errors.conflict('DRAW_NOT_OPEN', 'This draw is not open for entries.');
  }
  if (isConstraintViolation(error, 'reservations_market_enabled')) {
    return Errors.marketNotAvailable();
  }
  if (isConstraintViolation(error, 'draw_entrant_counts_cap')) {
    return Errors.conflict('TICKET_CAP_EXCEEDED', 'That would exceed the per-person entry limit.');
  }
  return error;
}
