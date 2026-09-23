import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  type AvailabilityResponse,
  type CreateReservationRequest,
  CreateReservationRequestSchema,
  ReservationIdParamSchema,
  type ReservationListResponse,
  type ReservationResponse,
} from '@hv/contracts';
import { z } from 'zod';
import {
  type AuthContext,
  CurrentAuth,
  CurrentMarket,
  type MarketContext,
  OptionalAuth,
} from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MarketGuard } from '../markets/market.guard';
import { Authenticated, Public } from '../rbac/access';
import { ReservationsService } from './reservations.service';

const NoQuery = new ZodValidationPipe(z.strictObject({}));
const ReservationParam = new ZodValidationPipe(ReservationIdParamSchema);

/**
 * Ticket reservations. Every route is market-scoped (MarketGuard: the market
 * must be enabled and allowed by ENABLED_MARKETS). Reserving and managing
 * reservations needs a signed-in customer; availability is public.
 */
@Controller('markets/:market')
@UseGuards(MarketGuard)
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get('draws/:slug/availability')
  @Public({ identify: true })
  availability(
    @Query(NoQuery) _query: object,
    @Param('slug') slug: string,
    @CurrentMarket() market: MarketContext,
    @OptionalAuth() auth: AuthContext | null,
  ): Promise<AvailabilityResponse> {
    return this.reservations.availability(market, slug, auth);
  }

  @Post('draws/:slug/reservations')
  @HttpCode(201)
  @Authenticated()
  async reserve(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(CreateReservationRequestSchema)) body: CreateReservationRequest,
    @CurrentMarket() market: MarketContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ReservationResponse> {
    return { reservation: await this.reservations.reserve(market, slug, body.quantity, auth) };
  }

  @Get('reservations')
  @Authenticated()
  async list(
    @Query(NoQuery) _query: object,
    @CurrentMarket() market: MarketContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ReservationListResponse> {
    return { reservations: await this.reservations.listActive(market, auth) };
  }

  @Get('reservations/:reservation')
  @Authenticated()
  async get(
    @Param(ReservationParam) params: { reservation: string },
    @CurrentMarket() market: MarketContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ReservationResponse> {
    return { reservation: await this.reservations.get(market, params.reservation, auth) };
  }

  @Post('reservations/:reservation/release')
  @HttpCode(200)
  @Authenticated()
  async release(
    @Param(ReservationParam) params: { reservation: string },
    @CurrentMarket() market: MarketContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ReservationResponse> {
    return { reservation: await this.reservations.release(market, params.reservation, auth) };
  }
}
