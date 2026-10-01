import { Controller, Get, Headers } from '@nestjs/common';
import {
  ORDER_ACCESS_TOKEN_HEADER,
  OrderAccessTokenSchema,
  type OrderAccessResponse,
} from '@hv/contracts';
import { RATE_LIMITS, RateLimiter } from '../auth/rate-limiter';
import { Errors } from '../common/errors';
import { Meta, type MarketContext, type RequestMeta } from '../common/request-context';
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
 * **A GET, with the token in a header.** A query string would write a bearer
 * credential into the web server's access log, the browser's history and any
 * referrer, so the token has never travelled in the URL. It began as a POST
 * body for that reason, and that was wrong for another: this route's only
 * caller is a page rendered by a plain navigation, a navigation sends no
 * `Origin`, and `app.ts` refuses every state-changing request that has none. So
 * the route answered 403 to the one caller it has, and the page showed its
 * 404. A header hides the token as well as a body does.
 *
 * **Everything this route can do, it does to one order, by reading** (S2).
 * There is no token-scoped write anywhere — not here, not in
 * `CheckoutService`, not in `OrderAccessService`, and no longer in
 * `statusByAccess`, which until this pass could run a trusted status check and
 * therefore a finalisation. A check is `finalization.confirm` under another
 * name — it can capture a payment, sell tickets, raise a refund and send
 * email — and nobody following a link should hold that. Confirmation arrives
 * by verified webhook or by the P6-5 reconciler; a customer who is early sees
 * "waiting for the provider", which is what is true.
 *
 * Starting a payment is deliberately absent too (D18 = B): a guest past their
 * thirty minutes can see that a payment failed and must verify their address
 * again to try once more.
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

  @Get()
  @Public()
  async present(
    @Headers(ORDER_ACCESS_TOKEN_HEADER) header: string | undefined,
    @Meta() meta: RequestMeta,
  ): Promise<OrderAccessResponse> {
    // Before the token is looked at, so a Redis outage refuses the read rather
    // than leaving the one guessable credential unguarded — and before its
    // shape is looked at, so a caller who sends nothing still pays for asking.
    await this.rateLimiter.consume(RATE_LIMITS.orderAccessPerIp, meta.ip ?? 'unknown');

    // Absent or the wrong shape is answered like anything else that does not
    // resolve. A validation error would separate "not a token" from "not a
    // token I know", which is worth nothing to an honest caller.
    const token = OrderAccessTokenSchema.safeParse(header);
    if (!token.success) throw Errors.notFound('Order');

    const db = this.access.database;
    const grant = await this.access.resolve(db, token.data);
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
    // The order's latest attempt, as the database holds it. No provider call,
    // no finalisation, nothing written (S2).
    const payment = await this.payments.statusByAccess(grant.orderId);
    return { order, payment, serverTime: new Date().toISOString() };
  }
}
