import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateOrderRequestSchema,
  type CreateOrderRequest,
  OrderIdParamSchema,
  type OrderListResponse,
  type OrderResponse,
} from '@hv/contracts';
import { z } from 'zod';
import { checkoutIdentity } from '../cart/checkout-identity';
import {
  type AuthContext,
  CurrentGuest,
  CurrentMarket,
  type MarketContext,
  Meta,
  OptionalAuth,
  type RequestMeta,
} from '../common/request-context';
import { Errors } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { GuestContext } from '../guests/guest-sessions.repository';
import { MarketGuard } from '../markets/market.guard';
import { Public } from '../rbac/access';
import { CheckoutService } from './checkout.service';

const NoQuery = new ZodValidationPipe(z.strictObject({}));
const OrderParam = new ZodValidationPipe(OrderIdParamSchema);
/** B5: every mutating endpoint accepts an Idempotency-Key. Here it is required. */
const IdempotencyKey = z.string().trim().min(8).max(255);

/**
 * Checkout and orders (B7, B18, B20; ADR-0030, ADR-0031).
 *
 * **Phase 5 stops at an order awaiting payment.** There is no payment route
 * here, and there will not be one until Phase 6.
 *
 * `@Public({ identify: true })` because a verified guest buys without an
 * account. It recognises a signed-in customer or a guest session and grants
 * nothing; a guest cookie still satisfies no authenticated route.
 *
 * The controller does no business work: it resolves the identity, validates
 * the shape of the request, and hands both to the service, which owns the
 * transaction.
 */
@Controller('markets/:market/checkout/orders')
@UseGuards(MarketGuard)
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  @HttpCode(201)
  @Public({ identify: true })
  async create(
    @Body(new ZodValidationPipe(CreateOrderRequestSchema)) body: CreateOrderRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
    @Meta() meta: RequestMeta,
  ): Promise<OrderResponse> {
    const key = IdempotencyKey.safeParse(idempotencyKey);
    if (!key.success) {
      throw Errors.badRequest(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header of 8 to 255 characters.',
      );
    }
    const identity = checkoutIdentity(auth, guest);
    const { order } = await this.checkout.createOrder(market, identity, key.data, body, meta);
    return { order };
  }

  @Get()
  @Public({ identify: true })
  async list(
    @Query(NoQuery) _query: object,
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<OrderListResponse> {
    const identity = checkoutIdentity(auth, guest);
    return { orders: await this.checkout.listOrders(market, identity) };
  }

  @Get(':order')
  @Public({ identify: true })
  async get(
    @Param(OrderParam) params: { order: string },
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<OrderResponse> {
    const identity = checkoutIdentity(auth, guest);
    return { order: await this.checkout.getOrder(market, identity, params.order) };
  }
}
