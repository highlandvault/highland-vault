import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import {
  AcceptTermsRequestSchema,
  type AcceptTermsRequest,
  type MarketTermsResponse,
  type TermsAcceptanceResponse,
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
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { GuestContext } from '../guests/guest-sessions.repository';
import { MarketGuard } from '../markets/market.guard';
import { Public } from '../rbac/access';
import { TermsService } from './terms.service';

const NoQuery = new ZodValidationPipe(z.strictObject({}));

/**
 * A market's terms, and accepting them (B12, ADR-0031).
 *
 * Market-scoped behind `MarketGuard`, so terms are always reached through the
 * market they belong to and a market that is not available — Germany included
 * — is refused before any of this runs.
 *
 * Reading is public: the terms a market is on are not a secret, and a customer
 * has to be able to read them before they have any identity at all. Accepting
 * needs a checkout identity, which is a signed-in customer or a guest session;
 * it grants nothing, and no guest cookie satisfies an authenticated route.
 */
@Controller('markets/:market/terms')
@UseGuards(MarketGuard)
export class TermsController {
  constructor(private readonly terms: TermsService) {}

  @Get()
  @Public({ identify: true })
  view(
    @Query(NoQuery) _query: object,
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<MarketTermsResponse> {
    // Anonymous is a valid way to read terms, so an absent identity is null
    // here rather than a refusal.
    const identity = auth || guest ? checkoutIdentity(auth, guest) : null;
    return this.terms.marketTerms(market, identity);
  }

  @Post('acceptance')
  @HttpCode(201)
  @Public({ identify: true })
  async accept(
    @Body(new ZodValidationPipe(AcceptTermsRequestSchema)) body: AcceptTermsRequest,
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<TermsAcceptanceResponse> {
    const identity = checkoutIdentity(auth, guest);
    return { acceptance: await this.terms.accept(market, identity, body.version) };
  }
}
