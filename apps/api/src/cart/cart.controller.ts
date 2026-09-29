import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AddCartItemRequestSchema,
  type AddCartItemRequest,
  CartItemIdParamSchema,
  type CartResponse,
} from '@hv/contracts';
import { z } from 'zod';
import {
  type AuthContext,
  CurrentMarket,
  type MarketContext,
  OptionalAuth,
} from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentGuest } from '../common/request-context';
import type { GuestContext } from '../guests/guest-sessions.repository';
import { MarketGuard } from '../markets/market.guard';
import { Public } from '../rbac/access';
import { CartService } from './cart.service';
import { checkoutIdentity } from './checkout-identity';

const NoQuery = new ZodValidationPipe(z.strictObject({}));
const ItemParam = new ZodValidationPipe(CartItemIdParamSchema);

/**
 * The basket (Revision 2 B4, ADR-0026, ADR-0031).
 *
 * Market-scoped like every customer route, so a basket is reached through the
 * market it belongs to and `MarketGuard` has already refused a market that is
 * not available — Germany included, whatever the frontend shows.
 *
 * `@Public({ identify: true })` because a guest has no account, and that is
 * the whole point of guest checkout. It recognises a signed-in customer or a
 * guest session and attaches whichever it found; it grants nothing. The
 * authenticated reservation routes are untouched and still require a full
 * session, and no guest cookie can satisfy them.
 */
@Controller('markets/:market/cart')
@UseGuards(MarketGuard)
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  @Public({ identify: true })
  async view(
    @Query(NoQuery) _query: object,
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<CartResponse> {
    return { cart: await this.cart.view(market, checkoutIdentity(auth, guest)) };
  }

  @Post('items')
  @HttpCode(201)
  @Public({ identify: true })
  async addItem(
    @Body(new ZodValidationPipe(AddCartItemRequestSchema)) body: AddCartItemRequest,
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<CartResponse> {
    const identity = checkoutIdentity(auth, guest);
    return { cart: await this.cart.addItem(market, identity, body.slug, body.quantity) };
  }

  @Delete('items/:item')
  @HttpCode(200)
  @Public({ identify: true })
  async removeItem(
    @Param(ItemParam) params: { item: string },
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<CartResponse> {
    const identity = checkoutIdentity(auth, guest);
    return { cart: await this.cart.removeItem(market, identity, params.item) };
  }
}
