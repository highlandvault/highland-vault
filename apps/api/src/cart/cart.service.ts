import { Inject, Injectable } from '@nestjs/common';
import type { Cart, CartItem, Reservation } from '@hv/contracts';
import { type Database, withTransaction } from '@hv/db';
import {
  ReservationRefused,
  effectiveReservationStatus,
  entrantKey,
  isOpenForEntries,
  isPublished,
  isValidQuantity,
} from '@hv/domain';
import { RATE_LIMITS, RateLimiter } from '../auth/rate-limiter';
import { AppError, Errors } from '../common/errors';
import { isUniqueViolation } from '../common/pg-errors';
import type { MarketContext } from '../common/request-context';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { DrawsRepository, type DrawRecord } from '../draws/draws.repository';
import { GuestSessionsService } from '../guests/guest-sessions.service';
import { ReservationsService } from '../tickets/reservations.service';
import { TicketAllocator } from '../tickets/ticket-allocator';
import { TicketsRepository, type ReservationRecord } from '../tickets/tickets.repository';
import { type CartOwner, CartRepository } from './cart.repository';
import type { CheckoutIdentity } from './checkout-identity';

/** Reservations expired on the way into an allocation, as the reservation path does. */
const INLINE_SWEEP_LIMIT = 200;

/**
 * The server-side basket (Revision 2 B4, ADR-0026, ADR-0031).
 *
 * One basket per market per owner, and the owner is a signed-in customer or a
 * guest session — never both. Adding a draw takes a real reservation through
 * the existing allocator, so a basket holds tickets rather than intentions;
 * removing an item gives them back.
 *
 * Nothing the client sends decides price, currency, market, availability or
 * eligibility. A request says which draw and how many; everything else is read
 * from PostgreSQL under the same locks and caps the reservation path already
 * uses.
 */
@Injectable()
export class CartService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly carts: CartRepository,
    private readonly draws: DrawsRepository,
    private readonly tickets: TicketsRepository,
    private readonly allocator: TicketAllocator,
    private readonly reservations: ReservationsService,
    private readonly guests: GuestSessionsService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /** The caller's basket. An owner with no basket yet gets an empty one, uncreated. */
  async view(market: MarketContext, identity: CheckoutIdentity): Promise<Cart> {
    const owner = this.ownerOf(identity);
    const cart = await this.carts.find(this.db, market.id, owner);
    if (!cart) return this.emptyCart(market, owner);
    return this.toDto(market, cart.id, owner, await this.carts.liveItems(this.db, cart.id));
  }

  /**
   * Adds a draw to the basket, reserving its tickets.
   *
   * The cap is charged against the caller's entrant identity (ADR-0008): a
   * user's id, or a guest's **freshly** verified email. The freshness is
   * re-checked here rather than trusted from earlier in the session, because
   * this is the point at which the cap identity is actually used.
   */
  async addItem(
    market: MarketContext,
    identity: CheckoutIdentity,
    slug: string,
    quantity: number,
  ): Promise<Cart> {
    const owner = this.ownerOf(identity);
    await this.rateLimiter.consume(RATE_LIMITS.cartItemsPerOwner, ownerKey(owner));

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

    const entrant = this.entrantOf(identity);
    const cart = await withTransaction(this.db, (trx) =>
      this.carts.findOrCreate(trx, market.id, owner),
    );

    // One basket entry per draw (B18). Changing how many you want means
    // removing the item and adding it again, so there is never a moment when
    // the basket holds two reservations for one draw.
    if (await this.carts.liveItemForDraw(this.db, cart.id, draw.id)) {
      throw Errors.conflict(
        'CONFLICT',
        'That draw is already in your basket. Remove it first to change the quantity.',
      );
    }

    // Free this draw's lapsed reservations first, in their own transaction —
    // never inside the allocation, which would take other entrants' locks.
    await this.tickets.expireDue(this.db, draw.id, INLINE_SWEEP_LIMIT);

    let reservationId: string;
    try {
      ({ reservationId } = await this.allocator.reserve(
        draw,
        entrant,
        quantity,
        this.env.RESERVATION_TTL_SECONDS,
      ));
    } catch (error) {
      throw this.reservations.mapRefusal(error);
    }

    // The reservation exists now, so if filing it in the basket fails the
    // tickets are given straight back rather than left held by nobody.
    try {
      await withTransaction(this.db, (trx) =>
        this.carts.addItem(trx, {
          cartId: cart.id,
          marketId: market.id,
          drawId: draw.id,
          reservationId,
        }),
      );
    } catch (error) {
      // Whatever went wrong, the tickets go back: a reservation with no basket
      // entry would hold them against the cap with nothing on screen to show
      // for it.
      await this.releaseQuietly(reservationId);
      // The pre-check above cannot be the last word. Two requests for the same
      // draw can both find the basket empty and both allocate, and the partial
      // unique index is what actually settles it — so the loser gets the same
      // answer as a caller who was simply too late, not a 500.
      if (isUniqueViolation(error, 'cart_items_cart_draw_idx')) {
        throw Errors.conflict(
          'CONFLICT',
          'That draw is already in your basket. Remove it first to change the quantity.',
        );
      }
      throw error;
    }
    await this.reservations.forgetAvailability(draw.id);
    return this.view(market, identity);
  }

  /**
   * Takes an item out of the basket and releases its tickets.
   *
   * Both happen in one transaction: an item that is gone from the basket but
   * whose tickets are still held would keep counting against the cap with
   * nothing on screen to explain it.
   */
  async removeItem(
    market: MarketContext,
    identity: CheckoutIdentity,
    itemId: string,
  ): Promise<Cart> {
    const owner = this.ownerOf(identity);
    const cart = await this.carts.find(this.db, market.id, owner);
    if (!cart) throw Errors.notFound('Basket item');

    const drawId = await withTransaction(this.db, async (trx) => {
      const item = await this.carts.findLiveItem(trx, cart.id, itemId, true);
      if (!item) throw Errors.notFound('Basket item');
      const reservation = await this.tickets.findById(trx, item.reservationId, true);
      if (reservation?.status === 'active') {
        await this.tickets.end(
          trx,
          reservation.id,
          reservation.expiresAt <= new Date() ? 'expired' : 'released',
        );
      }
      await this.carts.removeItem(trx, cart.id, item.id);
      return item.drawId;
    });

    await this.reservations.forgetAvailability(drawId);
    return this.view(market, identity);
  }

  /**
   * Who the basket belongs to.
   *
   * A signed-in caller is a user, full stop — `AccessGuard` never resolves a
   * guest alongside an authenticated session (ADR-0029), and this must not be
   * the place that reintroduces the ambiguity.
   */
  private ownerOf(identity: CheckoutIdentity): CartOwner {
    if (identity.kind === 'user') return { kind: 'user', userId: identity.auth.userId };
    return { kind: 'guest', guestSessionId: identity.guest.guestSessionId };
  }

  /**
   * The cap identity (ADR-0008) the tickets are charged to.
   *
   * For a guest this is their verified email, and it must still be fresh
   * (ADR-0020). A lapsed verification cannot buy: the address is what the cap
   * is counted against, and an address nobody has proved recently is not an
   * identity.
   */
  private entrantOf(identity: CheckoutIdentity) {
    if (identity.kind === 'user') {
      return {
        ...entrantKey({ type: 'user', userId: identity.auth.userId }),
        userId: identity.auth.userId,
      };
    }
    const guest = identity.guest;
    if (!this.guests.hasFreshVerifiedEmail(guest) || !guest.verifiedEmail) {
      throw Errors.badRequest(
        'VERIFICATION_REQUIRED',
        'Verify your email address before adding entries to your basket.',
      );
    }
    // userId stays null: a guest has no account, and the cap is counted
    // against the address instead (ADR-0008).
    return { ...entrantKey({ type: 'email', verifiedEmail: guest.verifiedEmail }), userId: null };
  }

  private async publishedDraw(market: MarketContext, slug: string): Promise<DrawRecord> {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) throw Errors.notFound('Draw');
    const draw = await this.draws.findBySlug(this.db, market.id, slug);
    if (!draw || !isPublished(draw.status)) throw Errors.notFound('Draw');
    return draw;
  }

  /** A reservation left with no basket entry is released; failing to is not fatal. */
  private async releaseQuietly(reservationId: string): Promise<void> {
    try {
      await this.tickets.end(this.db, reservationId, 'released');
    } catch {
      // The expiry sweep will take it within the reservation window.
    }
  }

  private emptyCart(market: MarketContext, owner: CartOwner | null): Cart {
    return {
      id: null,
      market: market.code,
      owner: owner?.kind ?? null,
      items: [],
      activeItemCount: 0,
      totalMinor: null,
      currency: null,
      serverTime: new Date().toISOString(),
    };
  }

  private async toDto(
    market: MarketContext,
    cartId: string,
    owner: CartOwner,
    items: { id: string; reservationId: string; createdAt: Date }[],
  ): Promise<Cart> {
    const now = new Date();
    const dtos: CartItem[] = [];
    for (const item of items) {
      const record = await this.tickets.findById(this.db, item.reservationId);
      if (!record) continue;
      dtos.push({
        id: item.id,
        addedAt: item.createdAt.toISOString(),
        reservation: await this.reservationDto(market, record, now),
      });
    }

    // Only live holds are money the customer actually owes. An expired item
    // stays visible — it explains where the tickets went — but it is not part
    // of the total, and P5-7 will not turn it into an order line.
    const active = dtos.filter((i) => i.reservation.status === 'active');
    const totalMinor = active.reduce((sum, i) => sum + i.reservation.totalMinor, 0);
    return {
      id: cartId,
      market: market.code,
      owner: owner.kind,
      items: dtos,
      activeItemCount: active.length,
      // One market, one currency (ADR-0026), so summing is safe here and only
      // here. There is no total without a currency to express it in.
      totalMinor: active.length > 0 ? totalMinor : null,
      currency: active[0]?.reservation.currency ?? null,
      serverTime: now.toISOString(),
    };
  }

  private async reservationDto(
    market: MarketContext,
    record: ReservationRecord,
    now: Date,
  ): Promise<Reservation> {
    const status = effectiveReservationStatus(record.status, record.expiresAt, now);
    const [draw, ticketNumbers] = await Promise.all([
      this.draws.findById(this.db, market.id, record.drawId),
      status === 'active' ? this.tickets.ticketNumbers(this.db, record.id) : Promise.resolve([]),
    ]);
    if (!draw) throw Errors.notFound('Basket item');
    return {
      id: record.id,
      market: market.code,
      draw: { slug: draw.slug, title: draw.title, totalTickets: draw.totalTickets },
      status,
      quantity: record.quantity,
      ticketNumbers,
      currency: record.currency,
      unitPriceMinor: record.unitPriceMinor,
      totalMinor: record.totalMinor,
      expiresAt: record.expiresAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      endedAt: record.endedAt?.toISOString() ?? null,
      serverTime: now.toISOString(),
    };
  }
}

function ownerKey(owner: CartOwner): string {
  return owner.kind === 'user' ? `user:${owner.userId}` : `guest:${owner.guestSessionId}`;
}

/** Re-exported so the module's users do not need the domain refusal type. */
export { ReservationRefused };
