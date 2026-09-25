import { Inject, Injectable } from '@nestjs/common';
import type { CreateOrderRequest, Order, OrderItem, SkillAnswer } from '@hv/contracts';
import { type Database, type DbExecutor, withTransaction } from '@hv/db';
import { effectiveReservationStatus, generateOrderNumber, normalizeEmail } from '@hv/domain';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { CartRepository } from '../cart/cart.repository';
import type { CheckoutIdentity } from '../cart/checkout-identity';
import { Errors } from '../common/errors';
import { isUniqueViolation } from '../common/pg-errors';
import type { MarketContext, RequestMeta } from '../common/request-context';
import { DATABASE } from '../database/database.module';
import { DrawsRepository } from '../draws/draws.repository';
import { GuestSessionsService } from '../guests/guest-sessions.service';
import { TermsService } from '../terms/terms.service';
import { TicketsRepository } from '../tickets/tickets.repository';
import { type OrderBuyer, OrdersRepository } from './orders.repository';

/** How many times a generated order number may collide before giving up. */
const ORDER_NUMBER_ATTEMPTS = 5;

/**
 * Turning a basket into an order (Revision 2 B7, B18, B20; ADR-0026, ADR-0030,
 * ADR-0031).
 *
 * **Phase 5 stops at an order awaiting payment.** Nothing here takes a
 * payment, records one, contacts a provider, or moves a ticket to `sold`. The
 * reservation stays active and its tickets stay `reserved`; Phase 6 picks it
 * up from there (ADR-0006, Option A).
 *
 * Everything that decides the outcome happens in ONE transaction: the
 * idempotency claim, the terms check, the skill answers, the reservations and
 * the order itself. A wrong answer therefore leaves nothing behind at all
 * (ADR-0030) — not a draft order, not a spent idempotency key.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly orders: OrdersRepository,
    private readonly carts: CartRepository,
    private readonly draws: DrawsRepository,
    private readonly tickets: TicketsRepository,
    private readonly terms: TermsService,
    private readonly guests: GuestSessionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates the order, or returns the one this idempotency key already made.
   *
   * The key is claimed by the INSERT itself, against a UNIQUE constraint, so
   * two simultaneous identical requests cannot both produce an order: one
   * wins, the other reads what the winner wrote. There is deliberately no
   * read-then-insert anywhere in this path, and no Redis in it either — the
   * database is the only authority.
   */
  async createOrder(
    market: MarketContext,
    identity: CheckoutIdentity,
    idempotencyKey: string,
    request: CreateOrderRequest,
    meta: RequestMeta,
  ): Promise<{ order: Order; replayed: boolean }> {
    const buyer = this.buyerOf(identity);
    const digest = fingerprint(market.code, buyer, request);

    // A key that has already been used is answered before any work is done,
    // and before the basket is touched.
    const existing = await this.orders.findByIdempotencyKey(this.db, idempotencyKey);
    if (existing) {
      // A retry gets its order back; a different request, or a different
      // customer, gets refused rather than somebody else's order.
      this.assertSameRequest(existing, market, identity, request);
      return { order: await this.toDto(market, existing), replayed: true };
    }

    const orderId = await withTransaction(this.db, async (trx) => {
      const cart = await this.carts.find(trx, market.id, this.cartOwnerOf(identity));
      if (!cart) throw await this.emptyOrReplay(trx, idempotencyKey);

      // Locked for the rest of the transaction: the lines about to become an
      // order must not change, and their tickets must not be released, while
      // the order is being written.
      //
      // A duplicate request blocks HERE, on the winner's lock, and finds the
      // basket emptied when it is released — which is why an empty basket is
      // not conclusive on its own. Under READ COMMITTED the next statement
      // sees the winner's committed order, so the key is what decides whether
      // this is a replay or a genuinely empty basket.
      const items = await this.carts.liveItems(trx, cart.id, true);
      if (items.length === 0) throw await this.emptyOrReplay(trx, idempotencyKey);

      const termsVersion = await this.requireAcceptedTerms(trx, market, identity, request);
      const lines = await this.priceAndValidate(trx, market, items, request.answers);

      const total = lines.reduce((sum, line) => sum + line.totalMinor, 0);
      const order = await this.claimAndInsert(trx, {
        market,
        buyer,
        termsVersionId: termsVersion.id,
        currency: lines[0]!.currency,
        totalMinor: total,
        idempotencyKey,
        idempotencyDigest: digest,
      });
      if (!order) {
        // Another request claimed the key while this transaction was running.
        // Roll back and let the caller re-read it outside the transaction.
        throw new IdempotencyRace();
      }

      for (const line of lines) {
        await this.orders.addItem(trx, {
          orderId: order.id,
          marketId: market.id,
          drawId: line.drawId,
          reservationId: line.reservationId,
          quantity: line.quantity,
          currency: line.currency,
          unitPriceMinor: line.unitPriceMinor,
          totalMinor: line.totalMinor,
          skillAnswerOptionId: line.skillAnswerOptionId,
        });
        // The basket is working state; the order is the record. Taking the
        // line out leaves the RESERVATION alone: it keeps holding the tickets
        // until payment, which is exactly what `awaiting_payment` means.
        await this.carts.removeItem(trx, cart.id, line.cartItemId);
      }

      await this.audit.record(trx, {
        actor: buyer.kind === 'user' ? { type: 'user', userId: buyer.userId } : { type: 'system' },
        action: 'order.created',
        entityType: 'order',
        entityId: order.id,
        marketId: market.id,
        // No address, no ticket numbers, no answer — the order row holds those
        // and this is a log.
        after: { orderNumber: order.orderNumber, items: lines.length, totalMinor: total },
        meta: { ip: meta.ip, requestId: meta.requestId },
      });
      return order.id;
    }).catch((error: unknown) => {
      // A lost race is not a failure: the winner already wrote the order.
      if (error instanceof IdempotencyRace) return null;
      throw error;
    });

    if (orderId === null) {
      const winner = await this.orders.findByIdempotencyKey(this.db, idempotencyKey);
      if (!winner) throw Errors.conflict('CONFLICT', 'That checkout could not be completed.');
      this.assertSameRequest(winner, market, identity, request);
      return { order: await this.toDto(market, winner), replayed: true };
    }

    const created = await this.orders.findById(this.db, market.id, orderId);
    return { order: await this.toDto(market, created!), replayed: false };
  }

  /**
   * What an empty basket means, which depends on whether this key already
   * bought something.
   *
   * A duplicate request finds the basket empty because the request it is a
   * duplicate of emptied it. Telling those two apart is the difference between
   * a correct replay and a confusing refusal.
   */
  private async emptyOrReplay(trx: DbExecutor, idempotencyKey: string): Promise<Error> {
    const winner = await this.orders.findByIdempotencyKey(trx, idempotencyKey);
    if (winner) return new IdempotencyRace();
    return Errors.badRequest('BASKET_EMPTY', 'There is nothing in your basket.');
  }

  /** One of the caller's own orders. */
  async getOrder(market: MarketContext, identity: CheckoutIdentity, id: string): Promise<Order> {
    const order = await this.orders.findById(this.db, market.id, id);
    if (!order || !this.ownedBy(order.buyer, this.buyerOf(identity))) {
      // Someone else's order is indistinguishable from one that is not there.
      throw Errors.notFound('Order');
    }
    return this.toDto(market, order);
  }

  async listOrders(market: MarketContext, identity: CheckoutIdentity): Promise<Order[]> {
    const orders = await this.orders.listForBuyer(this.db, market.id, this.buyerOf(identity));
    return Promise.all(orders.map((o) => this.toDto(market, o)));
  }

  /**
   * The terms the order will be placed under.
   *
   * Three things have to hold, and all of them are P5-6's rules rather than
   * new ones: the market has an active version, the customer accepted THAT
   * version, and the version they were shown is still the active one.
   */
  private async requireAcceptedTerms(
    trx: DbExecutor,
    market: MarketContext,
    identity: CheckoutIdentity,
    request: CreateOrderRequest,
  ) {
    const accepted = await this.terms.acceptedActiveVersionIn(trx, market, identity);
    if (accepted.reason === 'no_active_version') {
      throw Errors.conflict(
        'TERMS_UNAVAILABLE',
        'This market has no terms yet, so an order cannot be placed.',
      );
    }
    if (accepted.reason === 'not_accepted') {
      throw Errors.conflict('TERMS_NOT_ACCEPTED', 'Accept the terms before placing your order.');
    }
    if (accepted.version.version !== request.termsVersion) {
      // They accepted the active version, but sent back a different label:
      // the page they were on is stale.
      throw Errors.conflict(
        'TERMS_VERSION_STALE',
        'The terms have changed since they were shown. Read them again and accept.',
        { version: accepted.version.version },
      );
    }
    return accepted.version;
  }

  /**
   * Prices each basket line from the database and checks its skill answer.
   *
   * The request contributes exactly one thing to a line: which option was
   * chosen. Quantity, price, currency and draw all come from the reservation
   * and the draw, so a tampered request cannot buy at a price it invented.
   */
  private async priceAndValidate(
    trx: DbExecutor,
    market: MarketContext,
    items: { id: string; reservationId: string; drawId: string }[],
    answers: readonly SkillAnswer[],
  ): Promise<Line[]> {
    const lines: Line[] = [];
    const used = new Set<string>();

    for (const item of items) {
      // Locked, so the expiry sweep cannot end it between this check and the
      // order being written.
      const reservation = await this.tickets.findById(trx, item.reservationId, true);
      if (!reservation) throw this.checkoutConflict();
      // An expired hold must never become an order, whatever the row says.
      if (
        effectiveReservationStatus(reservation.status, reservation.expiresAt, new Date()) !==
        'active'
      ) {
        throw Errors.conflict(
          'CONFLICT',
          'One of your holds has run out. Check your basket and try again.',
        );
      }

      const draw = await this.draws.findById(trx, market.id, item.drawId);
      if (!draw) throw this.checkoutConflict();

      let skillAnswerOptionId: string | null = null;
      if (draw.skillQuestionId) {
        const answer = answers.find((a) => a.slug === draw.slug);
        // A missing answer and a wrong one are the same refusal: saying which
        // it was tells a guesser where to look (ADR-0030).
        if (!answer) throw this.invalidAnswer();
        if (!(await this.orders.isCorrectAnswer(trx, draw.skillQuestionId, answer.optionId))) {
          throw this.invalidAnswer();
        }
        skillAnswerOptionId = answer.optionId;
        used.add(answer.slug);
      }

      lines.push({
        cartItemId: item.id,
        drawId: draw.id,
        reservationId: reservation.id,
        quantity: reservation.quantity,
        currency: reservation.currency,
        unitPriceMinor: reservation.unitPriceMinor,
        totalMinor: reservation.totalMinor,
        skillAnswerOptionId,
      });
    }

    // An answer for a draw that is not in the basket is a malformed request,
    // and refusing it keeps the mapping between answers and lines exact.
    if (answers.some((a) => !used.has(a.slug))) throw this.invalidAnswer();
    return lines;
  }

  /** Writes the order, retrying only a collision of the random order number. */
  private async claimAndInsert(
    trx: DbExecutor,
    input: {
      market: MarketContext;
      buyer: OrderBuyer;
      termsVersionId: string;
      currency: 'GBP' | 'EUR';
      totalMinor: number;
      idempotencyKey: string;
      idempotencyDigest: Buffer;
    },
  ) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.orders.insertIfNew(trx, {
          orderNumber: generateOrderNumber(),
          marketId: input.market.id,
          currency: input.currency,
          buyer: input.buyer,
          termsVersionId: input.termsVersionId,
          totalMinor: input.totalMinor,
          idempotencyKey: input.idempotencyKey,
          idempotencyDigest: input.idempotencyDigest,
        });
      } catch (error) {
        // Fifty bits of randomness: this is the constraint doing its job on a
        // once-in-a-very-long-time coincidence, not a routine path.
        if (
          isUniqueViolation(error, 'orders_order_number_key') &&
          attempt < ORDER_NUMBER_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Checks a replay against what the key was first used for.
   *
   * Returning the first order to a DIFFERENT request would be a wrong answer,
   * and returning it to a different customer would be a disclosure. Both are
   * the same refusal here, and it says nothing about the original order.
   */
  private assertSameRequest(
    order: { idempotencyDigest: Buffer; buyer: OrderBuyer },
    market: MarketContext,
    identity: CheckoutIdentity,
    request: CreateOrderRequest,
  ): void {
    const buyer = this.buyerOf(identity);
    const expected = fingerprint(market.code, buyer, request);
    if (!this.ownedBy(order.buyer, buyer) || !order.idempotencyDigest.equals(expected)) {
      throw Errors.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'That idempotency key has already been used for a different request.',
      );
    }
  }

  /** The buyer recorded on the order (B18): a user id, or a verified address. */
  private buyerOf(identity: CheckoutIdentity): OrderBuyer {
    if (identity.kind === 'user') return { kind: 'user', userId: identity.auth.userId };
    const guest = identity.guest;
    // The cap identity has to be proved now, not earlier in the session
    // (ADR-0008, ADR-0020): this is the moment it decides something.
    if (!this.guests.hasFreshVerifiedEmail(guest) || !guest.verifiedEmail) {
      throw Errors.badRequest(
        'VERIFICATION_REQUIRED',
        'Verify your email address before placing your order.',
      );
    }
    return { kind: 'guest', email: normalizeEmail(guest.verifiedEmail) };
  }

  private cartOwnerOf(identity: CheckoutIdentity) {
    return identity.kind === 'user'
      ? ({ kind: 'user', userId: identity.auth.userId } as const)
      : ({ kind: 'guest', guestSessionId: identity.guest.guestSessionId } as const);
  }

  private ownedBy(a: OrderBuyer, b: OrderBuyer): boolean {
    if (a.kind === 'user' && b.kind === 'user') return a.userId === b.userId;
    if (a.kind === 'guest' && b.kind === 'guest') return a.email === b.email;
    return false;
  }

  /** One answer for every way a skill answer can be wrong (ADR-0030). */
  private invalidAnswer() {
    return Errors.badRequest(
      'INVALID_SKILL_ANSWER',
      'That answer is not correct. Check your entry and try again.',
    );
  }

  private checkoutConflict() {
    return Errors.conflict('CONFLICT', 'Your basket has changed. Review it and try again.');
  }

  private async toDto(market: MarketContext, order: OrderRecordLike): Promise<Order> {
    const now = new Date();
    const [items, termsVersion] = await Promise.all([
      this.orders.items(this.db, order.id),
      this.terms.versionLabel(this.db, order.termsVersionId),
    ]);
    const dtoItems: OrderItem[] = [];
    for (const item of items) {
      const draw = await this.draws.findById(this.db, market.id, item.drawId);
      dtoItems.push({
        draw: { slug: draw?.slug ?? '', title: draw?.title ?? '' },
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        totalMinor: item.totalMinor,
        // Still held, not sold: the numbers come from the live reservation.
        ticketNumbers: await this.tickets.ticketNumbers(this.db, item.reservationId),
      });
    }
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      market: market.code,
      currency: order.currency,
      status: order.status as Order['status'],
      placedBy: order.buyer.kind,
      totalMinor: order.totalMinor,
      walletAppliedMinor: order.walletAppliedMinor,
      externalDueMinor: order.externalDueMinor,
      termsVersion,
      items: dtoItems,
      createdAt: order.createdAt.toISOString(),
      serverTime: now.toISOString(),
    };
  }
}

interface Line {
  cartItemId: string;
  drawId: string;
  reservationId: string;
  quantity: number;
  currency: 'GBP' | 'EUR';
  unitPriceMinor: number;
  totalMinor: number;
  skillAnswerOptionId: string | null;
}

type OrderRecordLike = Awaited<ReturnType<OrdersRepository['findByIdempotencyKey']>> & object;

/** Thrown when another request claimed the key first; never leaves the service. */
class IdempotencyRace extends Error {
  override readonly name = 'IdempotencyRace';
}

/**
 * What the idempotency key was used for, canonicalised.
 *
 * Answers are sorted so that the same basket described in a different order is
 * the same request, and the buyer is included so one customer's key can never
 * match another's request.
 */
function fingerprint(marketCode: string, buyer: OrderBuyer, request: CreateOrderRequest): Buffer {
  const answers = [...request.answers]
    .map((a) => `${a.slug}:${a.optionId}`)
    .sort()
    .join(',');
  const who = buyer.kind === 'user' ? `user:${buyer.userId}` : `guest:${buyer.email}`;
  return createHash('sha256')
    .update([marketCode, who, request.termsVersion, answers].join('|'))
    .digest();
}
