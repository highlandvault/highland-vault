import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  OrderAccessRequestSchema,
  type OrderAccessRequest,
  type OrderAccessResponse,
} from '@hv/contracts';
import { RATE_LIMITS, RateLimiter } from '../auth/rate-limiter';
import { Errors } from '../common/errors';
import { Meta, type MarketContext, type RequestMeta } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MarketsRepository } from '../markets/markets.repository';
import { CheckoutService } from '../orders/checkout.service';
import { OrderAccessService } from '../orders/order-access.service';
import { Public } from '../rbac/access';
import { PaymentsService } from './payments.service';

/**
 * Presenting a return link (OD-2; **D18 = B**, **D19 = A**, **D19a**).
 *
 * **`@Public()` without `identify`.** Not an oversight — the point of this
 * route is that it works when the caller has no identity at all: no session,
 * no guest cookie, no live email proof, possibly a different device. Resolving
 * a guest here would be pointless, and would risk the token appearing to
 * extend something it must never touch (ADR-0029).
 *
 * **A POST, although it reads.** The token is a bearer credential, and a query
 * string would write it into the web server's access log, the browser's
 * history and any referrer. It travels in the body, and the response carries
 * the order so the caller can drop the token immediately.
 *
 * **Everything this route can do, it does to one order, by reading.** There is
 * no token-scoped write anywhere — not here, not in `CheckoutService`, not in
 * `OrderAccessService`. Starting a payment is deliberately absent (D18 = B): a
 * guest past their thirty minutes can see that a payment failed and must
 * verify their address again to try once more.
 *
 * It lives in `PaymentsModule` rather than `OrdersModule` because it needs
 * both, and `PaymentsModule` already imports orders — the other direction
 * would be a cycle.
 *
 * Rate limited per IP and fail-closed: a bearer token arriving in a link is
 * the one credential here that can be guessed at.
 */
@Controller('checkout/order-access')
export class OrderAccessController {
  constructor(
    private readonly access: OrderAccessService,
    private readonly checkout: CheckoutService,
    private readonly payments: PaymentsService,
    private readonly markets: MarketsRepository,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Post()
  @HttpCode(200)
  @Public()
  async present(
    @Body(new ZodValidationPipe(OrderAccessRequestSchema)) body: OrderAccessRequest,
    @Meta() meta: RequestMeta,
  ): Promise<OrderAccessResponse> {
    // Before the token is looked at, so a Redis outage refuses the read rather
    // than leaving the one guessable credential unguarded.
    await this.rateLimiter.consume(RATE_LIMITS.orderAccessPerIp, meta.ip ?? 'unknown');

    const db = this.access.database;
    const grant = await this.access.resolve(db, body.token);
    // One answer for malformed, unknown, revoked and expired alike. Anything
    // else would tell somebody which tokens exist.
    if (!grant) throw Errors.notFound('Order');

    const market = await this.markets.findById(db, grant.marketId);
    if (!market) throw Errors.notFound('Order');
    const context: MarketContext = {
      id: market.id,
      code: market.code,
      name: market.name,
      currency: market.currency,
      locale: market.locale,
    };

    const order = await this.checkout.getOrderByAccess(context, grant.orderId);
    // The order's latest attempt, read-only. It may trigger a trusted status
    // check — the one thing B10 lets a return page cause — and still asserts
    // nothing: the answer is re-read from the database afterwards.
    const payment = await this.payments.statusByAccess(grant.orderId);
    return { order, payment, serverTime: new Date().toISOString() };
  }
}
