import { Body, Controller, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  CreatePaymentRequestSchema,
  OrderIdParamSchema,
  PaymentIdParamSchema,
  type CreatePaymentRequest,
  type PaymentResponse,
  type PaymentStatusResponse,
} from '@hv/contracts';
import { z } from 'zod';
import { checkoutIdentity } from '../cart/checkout-identity';
import {
  type AuthContext,
  CurrentGuest,
  CurrentMarket,
  type MarketContext,
  OptionalAuth,
} from '../common/request-context';
import { Errors } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { GuestContext } from '../guests/guest-sessions.repository';
import { MarketGuard } from '../markets/market.guard';
import { Public } from '../rbac/access';
import { PaymentsService } from './payments.service';

const OrderParam = new ZodValidationPipe(OrderIdParamSchema);
const PaymentParam = new ZodValidationPipe(PaymentIdParamSchema);
/** B5: every mutating endpoint accepts an Idempotency-Key. Here it is required. */
const IdempotencyKey = z.string().trim().min(8).max(255);

/**
 * Starting a payment (Revision 2 B10, ADR-0006).
 *
 * `@Public({ identify: true })` for the same reason checkout is: a verified
 * guest pays without an account. It recognises a signed-in customer or a guest
 * session and grants nothing on its own — the service decides ownership, and
 * someone else's order is a 404 rather than a 403.
 *
 * There is no route here that confirms a payment, and there will not be one.
 * Confirmation arrives through a verified webhook (P6-3) or a trusted provider
 * status check (P6-5). A customer's browser coming back from a provider is
 * neither, and B10 is explicit that a redirect never marks an order paid.
 */
@Controller('markets/:market/checkout/orders/:order/payments')
@UseGuards(MarketGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @HttpCode(201)
  @Public({ identify: true })
  async create(
    // Strict and empty: a client never says how much to charge (I5).
    @Body(new ZodValidationPipe(CreatePaymentRequestSchema)) _body: CreatePaymentRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param(OrderParam) params: { order: string },
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<PaymentResponse> {
    const key = IdempotencyKey.safeParse(idempotencyKey);
    if (!key.success) {
      throw Errors.badRequest(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header of 8 to 255 characters.',
      );
    }
    const identity = checkoutIdentity(auth, guest);
    const payment = await this.payments.initiate(market, identity, params.order, key.data);
    return { payment };
  }

  /**
   * Where an attempt stands (§18).
   *
   * A read, so it is a GET and carries no idempotency key. It may cause a
   * trusted status check and therefore a finalisation, which is why it is here
   * rather than being served from a cache — but it never reports an outcome
   * the database has not already committed.
   *
   * OD-2's order access token, which will also open this route, arrives with
   * `order_access_tokens` in P6-8. Until it exists the ownership rules are
   * exactly the ones checkout already applies.
   */
  @Get(':payment')
  @Public({ identify: true })
  async status(
    @Param(PaymentParam) params: { order: string; payment: string },
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<PaymentStatusResponse> {
    const identity = checkoutIdentity(auth, guest);
    const payment = await this.payments.status(market, identity, params.order, params.payment);
    return { payment };
  }
}
