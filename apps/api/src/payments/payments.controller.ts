import { Body, Controller, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  CreatePaymentRequestSchema,
  OrderIdParamSchema,
  type CreatePaymentRequest,
  type PaymentResponse,
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
}
